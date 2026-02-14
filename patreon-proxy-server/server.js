/**
 * Patreon OAuth + OpenRouter Proxy Server
 *
 * This server handles:
 * 1. Patreon OAuth flow (keeps client_secret secure)
 * 2. Subscription tier validation
 * 3. Proxied AI requests via OpenRouter (keeps API key secure)
 *
 * Deploy to: Railway, Render, Vercel, or any Node.js host
 */

const express = require('express');
const cors = require('cors');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(cors());
app.use(express.json());

// =============================================================================
// RATE LIMITING CONFIGURATION (using Upstash Redis)
// =============================================================================

const RATE_LIMIT = {
    DAILY_REQUESTS: 2000,  // Max requests per user per day
    KEY_PREFIX: 'ratelimit:'
};

// Initialize Redis client (checks various env var names from Vercel/Upstash integrations)
let redis = null;
try {
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

    if (redisUrl && redisToken) {
        redis = new Redis({
            url: redisUrl,
            token: redisToken,
        });
        console.log('Upstash Redis initialized');
    } else if (process.env.REDIS_URL) {
        // Try to parse REDIS_URL format (might be from Upstash integration)
        // Upstash REST URL format: https://xxx.upstash.io with token as password
        const url = new URL(process.env.REDIS_URL);
        if (url.hostname.includes('upstash.io')) {
            redis = new Redis({
                url: `https://${url.hostname}`,
                token: url.password,
            });
            console.log('Upstash Redis initialized from REDIS_URL');
        } else {
            console.warn('REDIS_URL found but not Upstash format - rate limiting disabled');
        }
    } else {
        console.warn('Redis not configured - rate limiting disabled. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
    }
} catch (error) {
    console.error('Failed to initialize Redis:', error.message);
}

/**
 * Get today's date key (UTC) for rate limiting
 */
function getTodayKey() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Get current month key (UTC) for bandwidth tracking
 */
function getMonthKey() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Check bandwidth limit for a user
 * Returns { allowed: boolean, usedBytes: number, limitBytes: number, remainingBytes: number }
 */
async function checkBandwidthLimit(userId, isPatreon, packSizeBytes) {
    const limitBytes = isPatreon ? BANDWIDTH_LIMIT.PATREON_USER_BYTES : BANDWIDTH_LIMIT.FREE_USER_BYTES;

    if (!redis) {
        // No Redis = no tracking, allow download
        return { allowed: true, usedBytes: 0, limitBytes, remainingBytes: limitBytes };
    }

    const monthKey = getMonthKey();
    const key = `${BANDWIDTH_LIMIT.KEY_PREFIX}${userId}:${monthKey}`;

    try {
        const usedBytes = parseInt(await redis.get(key) || '0', 10);
        const remainingBytes = Math.max(0, limitBytes - usedBytes);

        // Check if this download would exceed the limit
        if (usedBytes + packSizeBytes > limitBytes) {
            return {
                allowed: false,
                usedBytes,
                limitBytes,
                remainingBytes,
                resetTime: getNextMonthReset()
            };
        }

        return { allowed: true, usedBytes, limitBytes, remainingBytes };
    } catch (error) {
        console.error('Bandwidth check error:', error);
        return { allowed: true, usedBytes: 0, limitBytes, remainingBytes: limitBytes };
    }
}

/**
 * Record bandwidth usage after a download
 */
async function recordBandwidthUsage(userId, bytes) {
    if (!redis) return;

    const monthKey = getMonthKey();
    const key = `${BANDWIDTH_LIMIT.KEY_PREFIX}${userId}:${monthKey}`;

    try {
        await redis.incrby(key, bytes);
        // Expire after 35 days (to cover the full month plus buffer)
        await redis.expire(key, 35 * 24 * 60 * 60);
    } catch (error) {
        console.error('Bandwidth recording error:', error);
    }
}

/**
 * Create a pending download entry (bandwidth reserved but not charged yet)
 * Returns the download ID for later confirmation
 */
async function createPendingDownload(userId, packId, bytes) {
    if (!redis) return null;

    const downloadId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const key = `${PENDING_DOWNLOAD.KEY_PREFIX}${downloadId}`;

    try {
        const pendingData = {
            userId,
            packId,
            bytes,
            createdAt: new Date().toISOString(),
            status: 'pending'
        };
        await redis.set(key, JSON.stringify(pendingData));
        // Auto-expire after grace period (will auto-finalize on next check)
        await redis.expire(key, PENDING_DOWNLOAD.GRACE_PERIOD_MINUTES * 60);

        console.log(`Created pending download: ${downloadId} for user=${userId}, pack=${packId}, bytes=${formatBytes(bytes)}`);
        return downloadId;
    } catch (error) {
        console.error('Pending download creation error:', error);
        return null;
    }
}

/**
 * Finalize a pending download (charge bandwidth)
 * Called when download completes successfully
 */
async function finalizePendingDownload(downloadId) {
    if (!redis) return { success: false, error: 'Redis not available' };

    const key = `${PENDING_DOWNLOAD.KEY_PREFIX}${downloadId}`;

    try {
        const pendingData = await redis.get(key);
        if (!pendingData) {
            return { success: false, error: 'Download not found or already processed' };
        }

        const pending = typeof pendingData === 'string' ? JSON.parse(pendingData) : pendingData;
        if (pending.status !== 'pending') {
            return { success: false, error: `Download already ${pending.status}` };
        }

        // Charge bandwidth
        await recordBandwidthUsage(pending.userId, pending.bytes);

        // Mark as finalized and delete
        await redis.del(key);

        console.log(`Finalized download: ${downloadId} for user=${pending.userId}, charged ${formatBytes(pending.bytes)}`);
        return { success: true, userId: pending.userId, bytes: pending.bytes };
    } catch (error) {
        console.error('Finalize download error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Cancel/refund a pending download (don't charge bandwidth)
 * Called when download fails or is cancelled
 */
async function cancelPendingDownload(downloadId) {
    if (!redis) return { success: false, error: 'Redis not available' };

    const key = `${PENDING_DOWNLOAD.KEY_PREFIX}${downloadId}`;

    try {
        const pendingData = await redis.get(key);
        if (!pendingData) {
            return { success: false, error: 'Download not found or already processed' };
        }

        const pending = typeof pendingData === 'string' ? JSON.parse(pendingData) : pendingData;
        if (pending.status !== 'pending') {
            return { success: false, error: `Download already ${pending.status}` };
        }

        // Don't charge bandwidth - just delete the pending entry
        await redis.del(key);

        console.log(`Cancelled download: ${downloadId} for user=${pending.userId}, refunded ${formatBytes(pending.bytes)}`);
        return { success: true, userId: pending.userId, bytes: pending.bytes, refunded: true };
    } catch (error) {
        console.error('Cancel download error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Get the reset time (first of next month UTC)
 */
function getNextMonthReset() {
    const now = new Date();
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
    return nextMonth.toISOString();
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Check and increment rate limit for a user
 * Returns { allowed: boolean, remaining: number, used: number }
 */
async function checkRateLimit(userId) {
    // If Redis not configured, allow all requests
    if (!redis) {
        return {
            allowed: true,
            remaining: RATE_LIMIT.DAILY_REQUESTS,
            used: 0,
            error: true
        };
    }

    const todayKey = getTodayKey();
    const key = `${RATE_LIMIT.KEY_PREFIX}${userId}:${todayKey}`;

    try {
        // Get current count
        let count = await redis.get(key) || 0;
        count = parseInt(count) || 0;

        if (count >= RATE_LIMIT.DAILY_REQUESTS) {
            return {
                allowed: false,
                remaining: 0,
                used: count
            };
        }

        // Increment count
        count = await redis.incr(key);

        // Set expiry to 48 hours (ensures cleanup even across timezone edge cases)
        if (count === 1) {
            await redis.expire(key, 48 * 60 * 60);
        }

        return {
            allowed: true,
            remaining: Math.max(0, RATE_LIMIT.DAILY_REQUESTS - count),
            used: count
        };
    } catch (error) {
        console.error('Rate limit check failed:', error.message);
        // If Redis fails, allow the request but log it
        return {
            allowed: true,
            remaining: RATE_LIMIT.DAILY_REQUESTS,
            used: 0,
            error: true
        };
    }
}

/**
 * Get current rate limit status without incrementing
 */
async function getRateLimitStatus(userId) {
    // If Redis not configured, return defaults
    if (!redis) {
        return {
            remaining: RATE_LIMIT.DAILY_REQUESTS,
            used: 0,
            limit: RATE_LIMIT.DAILY_REQUESTS
        };
    }

    const todayKey = getTodayKey();
    const key = `${RATE_LIMIT.KEY_PREFIX}${userId}:${todayKey}`;

    try {
        let count = await redis.get(key) || 0;
        count = parseInt(count) || 0;
        return {
            remaining: Math.max(0, RATE_LIMIT.DAILY_REQUESTS - count),
            used: count,
            limit: RATE_LIMIT.DAILY_REQUESTS
        };
    } catch (error) {
        console.error('Rate limit status check failed:', error.message);
        return {
            remaining: RATE_LIMIT.DAILY_REQUESTS,
            used: 0,
            limit: RATE_LIMIT.DAILY_REQUESTS
        };
    }
}

// =============================================================================
// CONFIGURATION - Set these as environment variables on your hosting platform
// =============================================================================

const CONFIG = {
    // Patreon OAuth credentials (get from https://www.patreon.com/portal/registration/register-clients)
    PATREON_CLIENT_ID: process.env.PATREON_CLIENT_ID || '',
    PATREON_CLIENT_SECRET: process.env.PATREON_CLIENT_SECRET || '',

    // Discord OAuth credentials (get from https://discord.com/developers/applications)
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID || '',
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET || '',

    // OpenRouter API key (get from https://openrouter.ai/keys)
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',

    // AI Model - MythoMax L2 13B is gold standard for roleplay
    AI_MODEL: process.env.AI_MODEL || 'gryphe/mythomax-l2-13b',

    // Your Patreon campaign ID (found in your Patreon creator dashboard URL)
    PATREON_CAMPAIGN_ID: process.env.PATREON_CAMPAIGN_ID || '',

    // Tier IDs from your Patreon (get from Patreon API or dashboard)
    // These are the minimum pledge amounts in cents for each tier
    // Any active patron gets at least Tier 1 (see tier logic below)
    TIER_1_MIN_CENTS: parseInt(process.env.TIER_1_MIN_CENTS || '5'),     // 5 cents minimum
    TIER_2_MIN_CENTS: parseInt(process.env.TIER_2_MIN_CENTS || '1000'),  // $10.00

    // Server port
    PORT: process.env.PORT || 3000
};

// =============================================================================
// WHITELIST - Users who get Tier 1 access regardless of subscription
// =============================================================================

const WHITELISTED_EMAILS = new Set([
    'softembrace9602@gmail.com',
    'fvmg4jvbnk@privaterelay.appleid.com',
    'scardamagliorosa@gmail.com',
    'koalegy@proton.me',
    'whimmywhimwhamwhozzle@gmail.com',
    'medcalfw@gmail.com',
    'twinkletheyoungllamacorn@gmail.com',
    'connorwest07@gmail.com', // Ceejay
    'thewama2014@gmail.com', // wefnetjegne
    'dillonford2000@gmail.com', // Bambi Dina / ding_dong568
    'temuelonmuskupgrade@gmail.com', // CodeBambi
    'failedserpent1999@gmail.com', // Bimdyskies / Wind of the Skies
].map(e => e.toLowerCase()));

const WHITELISTED_NAMES = new Set([
    'Gino Pippo',
    'AnyGirl57',
    'hose',
    'Koalegy',
    'leuda',
    'pyet',
    'Twinkle The Young Llamacorn',
    'rdyPreContact',
    'Ceejay',
    'Connor West',
    'wefnetjegne',
    'Maya',
    'Steveo',
    'austin webb',
    'Ashie',
    'DitzyTitz',
    'Katzenhaft',
    'Bambi Dina',
    'Bimbo Dina',
    'ding_dong568',
    'Dillon Ford',
    'Ari',
    'desiree',
    'Karbon',
    'HarleyVader',
    'Robyn',
    'TemuElonMuskUpgrade',
    'CodeBambi',
    'DrowsyKing',
    'Fifu',
    'Rawrbmb1',
    'Turnoes',
    'AnyaSissy',
    'Natalie',
    'Tired Slutty Magpie',
    'Floe',
    'Floe_xPink',
    'den545a2',
    'den545a',
    'den545a1',
    'den545a3',
    'Bimdyskies',
    'Wind of the Skies',
    'Bambi_Mandi',
    'bendi',
    'layla',
    'layla 🤍',
    'layla ❤',
].map(n => n.toLowerCase()));

function isWhitelisted(email, name, displayName = null) {
    const emailMatch = email && WHITELISTED_EMAILS.has(email.toLowerCase());
    const nameMatch = name && WHITELISTED_NAMES.has(name.toLowerCase());
    const displayNameMatch = displayName && WHITELISTED_NAMES.has(displayName.toLowerCase());
    console.log(`[WHITELIST CHECK] email="${email}" (match=${emailMatch}), name="${name}" (match=${nameMatch}), displayName="${displayName}" (match=${displayNameMatch})`);
    if (emailMatch) return true;
    if (nameMatch) return true;
    if (displayNameMatch) return true;
    return false;
}

// Debug endpoint to test whitelist
app.get('/debug/whitelist', (req, res) => {
    const { email, name } = req.query;
    const emailLower = (email || '').toLowerCase();
    const nameLower = (name || '').toLowerCase();
    const emailInSet = WHITELISTED_EMAILS.has(emailLower);
    const nameInSet = WHITELISTED_NAMES.has(nameLower);
    const result = isWhitelisted(email, name, null);
    res.json({
        email,
        name,
        email_lowercase: emailLower,
        name_lowercase: nameLower,
        email_in_whitelist: emailInSet,
        name_in_whitelist: nameInSet,
        is_whitelisted: result,
        whitelisted_emails_sample: Array.from(WHITELISTED_EMAILS).slice(0, 5),
        whitelisted_names_sample: Array.from(WHITELISTED_NAMES).slice(0, 5)
    });
});

// =============================================================================
// PATREON API HELPERS
// =============================================================================

const PATREON_API_BASE = 'https://www.patreon.com';
const PATREON_API_V2 = 'https://www.patreon.com/api/oauth2/v2';

/**
 * Exchange authorization code for access token
 */
async function exchangeCodeForTokens(code, redirectUri) {
    const params = new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: CONFIG.PATREON_CLIENT_ID,
        client_secret: CONFIG.PATREON_CLIENT_SECRET,
        redirect_uri: redirectUri
    });

    const response = await fetch(`${PATREON_API_BASE}/api/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
    }

    return response.json();
}

/**
 * Refresh an expired access token
 */
async function refreshAccessToken(refreshToken) {
    const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CONFIG.PATREON_CLIENT_ID,
        client_secret: CONFIG.PATREON_CLIENT_SECRET
    });

    const response = await fetch(`${PATREON_API_BASE}/api/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token refresh failed: ${error}`);
    }

    return response.json();
}

/**
 * Get user's identity and membership info from Patreon
 */
async function getPatreonIdentity(accessToken) {
    const fields = [
        'fields[user]=full_name,email',
        'fields[member]=patron_status,currently_entitled_amount_cents,pledge_relationship_start',
        'include=memberships.campaign'
    ].join('&');

    const response = await fetch(`${PATREON_API_V2}/identity?${fields}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!response.ok) {
        if (response.status === 401) {
            throw new Error('UNAUTHORIZED');
        }
        const error = await response.text();
        throw new Error(`Failed to get identity: ${error}`);
    }

    return response.json();
}

/**
 * Determine subscription tier from Patreon membership data
 */
function determineTier(identityData) {
    const user = identityData.data;
    const memberships = identityData.included?.filter(i => i.type === 'member') || [];

    // Find active membership for our campaign ONLY
    let activePledgeCents = 0;
    let isActive = false;
    let patronName = user?.attributes?.full_name || null;
    let patronEmail = user?.attributes?.email || null;

    for (const membership of memberships) {
        const attrs = membership.attributes;

        // CRITICAL: Only count memberships to OUR campaign, not other Patreon creators
        // Convert both to strings and trim for comparison (API may return number, env var is string)
        const membershipCampaignId = String(membership.relationships?.campaign?.data?.id || '').trim();
        const ourCampaignId = String(CONFIG.PATREON_CAMPAIGN_ID || '').trim();

        console.log(`Checking membership: campaign=${membershipCampaignId}, our=${ourCampaignId}, status=${attrs.patron_status}, cents=${attrs.currently_entitled_amount_cents}`);

        if (ourCampaignId && membershipCampaignId !== ourCampaignId) {
            console.log(`Skipping membership to campaign ${membershipCampaignId} (not our campaign ${ourCampaignId})`);
            continue;
        }

        console.log(`MATCH! Campaign ${membershipCampaignId} matches. Status: ${attrs.patron_status}, Cents: ${attrs.currently_entitled_amount_cents}`);

        if (attrs.patron_status === 'active_patron') {
            isActive = true;
            activePledgeCents = Math.max(activePledgeCents, attrs.currently_entitled_amount_cents || 0);
            console.log(`Active patron found! Setting isActive=true, pledge=${activePledgeCents}`);
        }
    }

    // Determine tier based on pledge amount
    // Any active patron gets at least Tier 1 (Patreon marks them active_patron)
    let tier = 0; // None
    if (isActive) {
        if (activePledgeCents >= CONFIG.TIER_2_MIN_CENTS) {
            tier = 2; // Level 2
        } else {
            tier = 1; // Level 1 - any active patron
        }
    }

    console.log(`FINAL RESULT for ${patronName}: active=${isActive}, pledge=${activePledgeCents}c, tier=${tier}`);

    return {
        is_active: isActive,
        tier,
        patron_name: patronName,
        patron_email: patronEmail,
        pledge_cents: activePledgeCents,
        patreon_user_id: user?.id
    };
}

/**
 * Extract tier info from the 'included' array of a Patreon identity response
 * Used by v2 auth endpoints
 */
function getTierFromMemberships(included) {
    const memberships = included?.filter(i => i.type === 'member') || [];

    let activePledgeCents = 0;
    let isActive = false;

    for (const membership of memberships) {
        const attrs = membership.attributes;

        // CRITICAL: Only count memberships to OUR campaign
        const membershipCampaignId = String(membership.relationships?.campaign?.data?.id || '').trim();
        const ourCampaignId = String(CONFIG.PATREON_CAMPAIGN_ID || '').trim();

        if (ourCampaignId && membershipCampaignId !== ourCampaignId) {
            continue;
        }

        if (attrs.patron_status === 'active_patron') {
            isActive = true;
            activePledgeCents = Math.max(activePledgeCents, attrs.currently_entitled_amount_cents || 0);
        }
    }

    // Determine tier based on pledge amount
    let tier = 0;
    if (isActive) {
        if (activePledgeCents >= CONFIG.TIER_2_MIN_CENTS) {
            tier = 2;
        } else {
            tier = 1;
        }
    }

    return {
        is_active: isActive,
        tier,
        pledge_cents: activePledgeCents
    };
}

// =============================================================================
// DISCORD API HELPERS
// =============================================================================

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/**
 * Exchange Discord authorization code for access token
 */
async function exchangeDiscordCode(code, redirectUri) {
    const params = new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: CONFIG.DISCORD_CLIENT_ID,
        client_secret: CONFIG.DISCORD_CLIENT_SECRET,
        redirect_uri: redirectUri
    });

    const response = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Discord token exchange failed: ${error}`);
    }

    return response.json();
}

/**
 * Refresh Discord access token
 */
async function refreshDiscordToken(refreshToken) {
    const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CONFIG.DISCORD_CLIENT_ID,
        client_secret: CONFIG.DISCORD_CLIENT_SECRET
    });

    const response = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Discord token refresh failed: ${error}`);
    }

    return response.json();
}

/**
 * Get Discord user information
 */
async function getDiscordUser(accessToken) {
    const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    });

    if (!response.ok) {
        if (response.status === 401) {
            throw new Error('UNAUTHORIZED');
        }
        const error = await response.text();
        throw new Error(`Failed to get Discord user: ${error}`);
    }

    return response.json();
}

// =============================================================================
// API ENDPOINTS
// =============================================================================

/**
 * GET /patreon/authorize
 * Redirects to Patreon OAuth authorization page
 */
app.get('/patreon/authorize', (req, res) => {
    const { redirect_uri, state } = req.query;

    if (!redirect_uri) {
        return res.status(400).json({ error: 'redirect_uri is required' });
    }

    const scopes = 'identity identity.memberships';
    const authUrl = new URL(`${PATREON_API_BASE}/oauth2/authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', CONFIG.PATREON_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirect_uri);
    authUrl.searchParams.set('scope', scopes);
    if (state) {
        authUrl.searchParams.set('state', state);
    }

    res.redirect(authUrl.toString());
});

/**
 * POST /patreon/token
 * Exchanges authorization code for tokens
 */
app.post('/patreon/token', async (req, res) => {
    try {
        const { code, redirect_uri } = req.body;

        if (!code || !redirect_uri) {
            return res.status(400).json({ error: 'code and redirect_uri are required' });
        }

        const tokens = await exchangeCodeForTokens(code, redirect_uri);

        res.json({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_in: tokens.expires_in,
            token_type: tokens.token_type
        });
    } catch (error) {
        console.error('Token exchange error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /patreon/refresh
 * Refreshes an expired access token
 */
app.post('/patreon/refresh', async (req, res) => {
    try {
        const { refresh_token } = req.body;

        if (!refresh_token) {
            return res.status(400).json({ error: 'refresh_token is required' });
        }

        const tokens = await refreshAccessToken(refresh_token);

        res.json({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_in: tokens.expires_in,
            token_type: tokens.token_type
        });
    } catch (error) {
        console.error('Token refresh error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /patreon/validate
 * Validates subscription and returns tier
 * Requires: Authorization: Bearer <patreon_access_token>
 */
app.get('/patreon/validate', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);
        const identity = await getPatreonIdentity(accessToken);
        const tierInfo = determineTier(identity);

        // Include rate limit status
        const userId = tierInfo.patreon_user_id || 'unknown';
        const rateLimitStatus = await getRateLimitStatus(userId);
        tierInfo.rate_limit = rateLimitStatus;

        // Look up unified user (with on-the-fly migration from legacy)
        let unifiedLookup = { exists: false, needs_registration: true };
        let displayName = null;

        if (userId !== 'unknown') {
            unifiedLookup = await lookupUserByPatreon(userId);

            if (unifiedLookup.exists) {
                displayName = unifiedLookup.display_name;
                tierInfo.display_name = displayName;
                tierInfo.unified_id = unifiedLookup.unified_id;
                tierInfo.needs_registration = !unifiedLookup.has_display_name;
                tierInfo.has_linked_discord = unifiedLookup.has_discord || false;
            } else {
                // Check for email-based auto-link opportunity
                if (tierInfo.patron_email) {
                    const emailLookup = await lookupUserByEmail(tierInfo.patron_email);
                    if (emailLookup) {
                        tierInfo.can_auto_link = true;
                        tierInfo.auto_link_unified_id = emailLookup.unified_id;
                        tierInfo.auto_link_display_name = emailLookup.user.display_name;
                    }
                }
                tierInfo.needs_registration = true;
            }
        }

        // Check whitelist - if whitelisted, grant Tier 2 access
        // Checks: email, Patreon name, AND leaderboard display name
        const whitelisted = isWhitelisted(tierInfo.patron_email, tierInfo.patron_name, displayName);
        tierInfo.is_whitelisted = whitelisted;
        if (whitelisted) {
            if (tierInfo.tier < 2) {
                tierInfo.tier = 2;
            }
            console.log(`Whitelisted user validated: ${tierInfo.patron_name} / ${displayName} (${tierInfo.patron_email})`);
        }

        // Update unified user's Patreon status if they exist
        if (unifiedLookup.exists && unifiedLookup.unified_id) {
            await updateUnifiedUserPatreonStatus(unifiedLookup.unified_id, {
                tier: tierInfo.tier,
                is_active: tierInfo.is_active,
                is_whitelisted: whitelisted,
                patron_name: tierInfo.patron_name
            });
        }

        // Also update legacy profile for backward compatibility
        // BUT only if profile already exists AND has a display_name!
        // Creating empty profiles causes "already linked" conflicts when users try to link accounts.
        if (userId !== 'unknown' && redis) {
            try {
                const profileKey = `${PROFILE_KEY_PREFIX}${userId}`;
                const profileData = await redis.get(profileKey);

                // Only update if profile exists AND has display_name
                // Don't create new profiles here - let the account linking flow handle that
                if (profileData) {
                    const profile = typeof profileData === 'string' ? JSON.parse(profileData) : profileData;

                    // Skip if no display_name - this profile shouldn't exist, don't perpetuate it
                    if (!profile.display_name || profile.display_name.trim() === '') {
                        console.log(`Skipping profile update for ${userId} - no display_name (prevents linking conflicts)`);
                    } else {
                        // Update Patreon status fields
                        profile.patreon_tier = tierInfo.tier;
                        profile.patreon_is_active = tierInfo.is_active;
                        profile.patreon_is_whitelisted = whitelisted;
                        profile.patreon_status_updated_at = new Date().toISOString();

                        // Store email for cross-account linking (Discord users with same email get linked)
                        if (tierInfo.patron_email) {
                            profile.email = tierInfo.patron_email.toLowerCase();
                            // Create email index — point to unified_id if available, else patreon_id
                            const emailIndexKey = `email_index:${tierInfo.patron_email.toLowerCase()}`;
                            const emailTarget = (unifiedLookup.exists && unifiedLookup.unified_id) ? unifiedLookup.unified_id : userId;
                            await redis.set(emailIndexKey, emailTarget);
                        }

                        await redis.set(profileKey, JSON.stringify(profile));
                    }
                }
                // If no profile exists, don't create one - let account linking handle it
            } catch (profileError) {
                console.error('Failed to update profile with Patreon status:', profileError.message);
            }
        }

        res.json(tierInfo);
    } catch (error) {
        console.error('Validation error:', error.message);
        if (error.message === 'UNAUTHORIZED') {
            return res.status(401).json({ error: 'Token expired or invalid' });
        }
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /patreon/debug-campaigns
 * Shows all campaign IDs from user's memberships (for finding your campaign ID)
 * Requires: Authorization: Bearer <patreon_access_token>
 */
app.get('/patreon/debug-campaigns', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);
        const identity = await getPatreonIdentity(accessToken);

        const memberships = identity.included?.filter(i => i.type === 'member') || [];
        const campaigns = identity.included?.filter(i => i.type === 'campaign') || [];

        const campaignInfo = memberships.map(m => ({
            campaign_id: m.relationships?.campaign?.data?.id,
            patron_status: m.attributes?.patron_status,
            pledge_cents: m.attributes?.currently_entitled_amount_cents
        }));

        res.json({
            user_name: identity.data?.attributes?.full_name,
            user_email: identity.data?.attributes?.email,
            memberships: campaignInfo,
            campaigns: campaigns.map(c => ({
                id: c.id,
                name: c.attributes?.name || c.attributes?.creation_name
            })),
            configured_campaign_id: CONFIG.PATREON_CAMPAIGN_ID || '(NOT SET)',
            hint: 'Set PATREON_CAMPAIGN_ID to the campaign_id you want to validate against'
        });
    } catch (error) {
        console.error('Debug campaigns error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// DISCORD OAUTH ENDPOINTS
// =============================================================================

/**
 * GET /discord/authorize
 * Redirects to Discord OAuth authorization page
 */
app.get('/discord/authorize', (req, res) => {
    const { redirect_uri, state } = req.query;

    if (!redirect_uri) {
        return res.status(400).json({ error: 'redirect_uri is required' });
    }

    if (!CONFIG.DISCORD_CLIENT_ID) {
        return res.status(500).json({ error: 'Discord OAuth not configured' });
    }

    // Request identify and email scopes
    const scopes = 'identify email';
    const authUrl = new URL('https://discord.com/api/oauth2/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', CONFIG.DISCORD_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirect_uri);
    authUrl.searchParams.set('scope', scopes);
    if (state) {
        authUrl.searchParams.set('state', state);
    }

    res.redirect(authUrl.toString());
});

/**
 * POST /discord/token
 * Exchanges authorization code for tokens
 */
app.post('/discord/token', async (req, res) => {
    try {
        const { code, redirect_uri } = req.body;

        if (!code || !redirect_uri) {
            return res.status(400).json({ error: 'code and redirect_uri are required' });
        }

        if (!CONFIG.DISCORD_CLIENT_ID || !CONFIG.DISCORD_CLIENT_SECRET) {
            return res.status(500).json({ error: 'Discord OAuth not configured' });
        }

        const tokens = await exchangeDiscordCode(code, redirect_uri);

        res.json({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_in: tokens.expires_in,
            token_type: tokens.token_type,
            scope: tokens.scope
        });
    } catch (error) {
        console.error('Discord token exchange error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /discord/refresh
 * Refreshes an expired Discord access token
 */
app.post('/discord/refresh', async (req, res) => {
    try {
        const { refresh_token } = req.body;

        if (!refresh_token) {
            return res.status(400).json({ error: 'refresh_token is required' });
        }

        if (!CONFIG.DISCORD_CLIENT_ID || !CONFIG.DISCORD_CLIENT_SECRET) {
            return res.status(500).json({ error: 'Discord OAuth not configured' });
        }

        const tokens = await refreshDiscordToken(refresh_token);

        res.json({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_in: tokens.expires_in,
            token_type: tokens.token_type,
            scope: tokens.scope
        });
    } catch (error) {
        console.error('Discord token refresh error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /discord/validate
 * Validates Discord token and returns user info
 * Requires: Authorization: Bearer <discord_access_token>
 */
app.get('/discord/validate', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);
        const user = await getDiscordUser(accessToken);

        // Look up unified user (with on-the-fly migration from legacy)
        const unifiedLookup = await lookupUserByDiscord(user.id);

        const response = {
            id: user.id,
            username: user.username,
            discriminator: user.discriminator,
            global_name: user.global_name,
            avatar: user.avatar,
            email: user.email,
            verified: user.verified
        };

        if (unifiedLookup.exists) {
            response.unified_id = unifiedLookup.unified_id;
            response.display_name = unifiedLookup.display_name;
            response.needs_registration = !unifiedLookup.has_display_name;
            response.has_linked_patreon = unifiedLookup.has_patreon || false;

            // Check whitelist by display name
            if (unifiedLookup.user) {
                const whitelisted = isWhitelisted(
                    unifiedLookup.user.email,
                    unifiedLookup.user.patron_name,
                    unifiedLookup.display_name
                );
                response.is_whitelisted = whitelisted;
                response.patreon_tier = whitelisted ? Math.max(unifiedLookup.user.patreon_tier || 0, 2) : (unifiedLookup.user.patreon_tier || 0);
                response.patreon_is_active = unifiedLookup.user.patreon_is_active || false;
            }
        } else {
            response.needs_registration = true;

            // Check for email-based auto-link opportunity
            if (user.email) {
                const emailLookup = await lookupUserByEmail(user.email);
                if (emailLookup) {
                    response.can_auto_link = true;
                    response.auto_link_unified_id = emailLookup.unified_id;
                    response.auto_link_display_name = emailLookup.user.display_name;
                }
            }
        }

        res.json(response);
    } catch (error) {
        console.error('Discord validation error:', error.message);
        if (error.message === 'UNAUTHORIZED') {
            return res.status(401).json({ error: 'Token expired or invalid' });
        }
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// DISCORD COMMUNITY WEBHOOK
// =============================================================================

const COMMUNITY_WEBHOOK_URL = process.env.DISCORD_COMMUNITY_WEBHOOK_URL || '';
const ACHIEVEMENTS_BASE_URL = 'https://codebambi.github.io/Conditioning-Control-Panel---CSharp-WPF/achievements/';

/**
 * POST /discord/community-webhook
 * Posts achievements and level ups to the community Discord webhook
 * Body: { type: 'achievement' | 'level_up', display_name: string, ... }
 */
app.post('/discord/community-webhook', async (req, res) => {
    try {
        if (!COMMUNITY_WEBHOOK_URL) {
            console.log('Community webhook not configured, skipping');
            return res.json({ success: false, message: 'Webhook not configured' });
        }

        const { type, display_name } = req.body;

        if (!type || !display_name) {
            return res.status(400).json({ error: 'type and display_name are required' });
        }

        let webhookPayload;

        if (type === 'achievement') {
            const { achievement_name, achievement_requirement, image_name } = req.body;
            if (!achievement_name) {
                return res.status(400).json({ error: 'achievement_name is required for achievement type' });
            }

            // Bambi themed achievement messages
            const achievementMessages = [
                `${display_name} is becoming such a good bambi~`,
                `${display_name}'s conditioning is working perfectly 💗`,
                `${display_name} dropped deeper and unlocked something special~`,
                `Good girl ${display_name}! The programming is taking hold 🌀`,
                `${display_name} is learning to obey so well~`,
                `${display_name}'s mind is becoming so empty and obedient 💕`,
            ];
            const randomMessage = achievementMessages[Math.floor(Math.random() * achievementMessages.length)];

            webhookPayload = {
                embeds: [{
                    title: '🌀 Achievement Unlocked 💗',
                    description: `**${randomMessage}**\n\n✨ *${achievement_name}*`,
                    color: 0xFF69B4, // Pink
                    fields: achievement_requirement ? [{
                        name: '📋 Requirement',
                        value: achievement_requirement,
                        inline: false
                    }] : [],
                    thumbnail: image_name ? { url: ACHIEVEMENTS_BASE_URL + encodeURIComponent(image_name) } : undefined,
                    footer: {
                        text: '🎀 Bambi Sleep Conditioning 🎀'
                    },
                    timestamp: new Date().toISOString()
                }]
            };
        } else if (type === 'level_up') {
            const { level, image_name } = req.body;
            if (typeof level !== 'number') {
                return res.status(400).json({ error: 'level is required for level_up type' });
            }

            // Bambi themed level up messages based on milestone
            let title, description, color;

            if (level % 100 === 0) {
                title = '🌟💗 PERFECT BAMBI 💗🌟';
                description = `**${display_name}** has reached **Level ${level}**!\n\n*Such deep conditioning... such a perfect empty doll~ 🎀*`;
                color = 0xFFD700; // Gold
            } else if (level % 50 === 0) {
                title = '✨🌀 Deep Drop ✨';
                description = `**${display_name}** sank to **Level ${level}**!\n\n*Going so deep... thoughts melting away~ 💕*`;
                color = 0x9B59B6; // Purple
            } else if (level % 25 === 0) {
                title = '💗 Good Girl Level Up 💗';
                description = `**${display_name}** reached **Level ${level}**!\n\n*The conditioning grows stronger~ 🌀*`;
                color = 0xFF69B4; // Pink
            } else if (level % 10 === 0) {
                title = '🎀 Dropping Deeper~';
                description = `**${display_name}** floated to **Level ${level}**!\n\n*Such a good bambi~*`;
                color = 0xFFB6C1; // Light pink
            } else {
                title = '💕 Level Up~';
                description = `**${display_name}** reached **Level ${level}**!`;
                color = 0xFF69B4; // Pink
            }

            webhookPayload = {
                embeds: [{
                    title: title,
                    description: description,
                    color: color,
                    thumbnail: image_name ? { url: ACHIEVEMENTS_BASE_URL + encodeURIComponent(image_name) } : undefined,
                    footer: {
                        text: '🎀 Bambi Sleep Conditioning 🎀'
                    },
                    timestamp: new Date().toISOString()
                }]
            };
        } else {
            return res.status(400).json({ error: 'Invalid type. Must be "achievement" or "level_up"' });
        }

        // Send to Discord webhook
        const response = await fetch(COMMUNITY_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(webhookPayload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Discord webhook error:', response.status, errorText);
            return res.status(502).json({ error: 'Failed to post to Discord webhook' });
        }

        console.log(`Community webhook sent: ${type} for ${display_name}`);
        res.json({ success: true });

    } catch (error) {
        console.error('Community webhook error:', error.message);
        res.status(500).json({ error: 'Failed to send webhook' });
    }
});

// =============================================================================
// AI CHAT ENDPOINTS
// =============================================================================

/**
 * POST /ai/chat
 * Proxies chat requests to OpenRouter after validating Patreon subscription
 * Requires: Authorization: Bearer <patreon_access_token>
 */
app.post('/ai/chat', async (req, res) => {
    try {
        // Validate Patreon token first
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);

        // Verify subscription tier
        let tierInfo;
        try {
            const identity = await getPatreonIdentity(accessToken);
            tierInfo = determineTier(identity);
        } catch (error) {
            if (error.message === 'UNAUTHORIZED') {
                return res.status(401).json({ error: 'Patreon token expired' });
            }
            throw error;
        }

        // Fetch display_name for whitelist check
        const userId = tierInfo.patreon_user_id || 'unknown';
        let displayName = null;
        if (userId !== 'unknown') {
            try {
                const profileKey = `${PROFILE_KEY_PREFIX}${userId}`;
                const profileData = await redis.get(profileKey);
                if (profileData) {
                    const profile = typeof profileData === 'string' ? JSON.parse(profileData) : profileData;
                    displayName = profile.display_name || null;
                }
            } catch (e) { /* ignore */ }
        }

        // Check tier OR whitelist OR active patron status
        // (Active patrons with tier 0 may have payment processing delays - trust Patreon's active status)
        const whitelisted = isWhitelisted(tierInfo.patron_email, tierInfo.patron_name, displayName);
        const effectiveTier = tierInfo.is_active && tierInfo.tier < 1 ? 1 : tierInfo.tier;

        if (effectiveTier < 1 && !whitelisted) {
            console.log(`Access denied for ${tierInfo.patron_name}: active=${tierInfo.is_active}, tier=${tierInfo.tier}, pledge=${tierInfo.pledge_cents}c`);
            return res.status(403).json({
                error: 'Patreon Level 1 subscription required',
                tier: tierInfo.tier
            });
        }

        // Log for debugging active patrons with tier issues
        if (tierInfo.is_active && tierInfo.tier < 1) {
            console.log(`Active patron ${tierInfo.patron_name} has tier=${tierInfo.tier}, pledge=${tierInfo.pledge_cents}c - granting Level 1 access`);
        }

        // Check rate limit using Patreon user ID (userId already defined above)
        const rateLimit = await checkRateLimit(userId);

        if (!rateLimit.allowed) {
            console.log(`Rate limit exceeded for user ${userId} (${tierInfo.patron_name}): ${rateLimit.used}/${RATE_LIMIT.DAILY_REQUESTS}`);
            return res.status(429).json({
                error: 'Daily request limit exceeded',
                requests_remaining: 0,
                requests_used: rateLimit.used,
                limit: RATE_LIMIT.DAILY_REQUESTS
            });
        }

        if (whitelisted) {
            console.log(`Whitelisted user: ${tierInfo.patron_name} (${tierInfo.patron_email}) - ${rateLimit.used}/${RATE_LIMIT.DAILY_REQUESTS} requests`);
        }

        // Validate OpenRouter is configured
        if (!CONFIG.OPENROUTER_API_KEY) {
            return res.status(503).json({ error: 'AI service not configured' });
        }

        // Parse request
        const { messages, max_tokens = 100, temperature = 0.95 } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'messages array is required' });
        }

        // Call OpenRouter
        const openRouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/ConditioningControlPanel',
                'X-Title': 'Conditioning Control Panel'
            },
            body: JSON.stringify({
                model: CONFIG.AI_MODEL,
                messages,
                max_tokens,
                temperature
            })
        });

        if (!openRouterResponse.ok) {
            const errorText = await openRouterResponse.text();
            console.error('OpenRouter error:', errorText);
            return res.status(502).json({ error: 'AI service error' });
        }

        const completion = await openRouterResponse.json();
        const content = completion.choices?.[0]?.message?.content || '';

        res.json({
            content,
            requests_remaining: rateLimit.remaining,
            requests_used: rateLimit.used,
            limit: RATE_LIMIT.DAILY_REQUESTS
        });
    } catch (error) {
        console.error('AI chat error:', error.message);
        res.status(500).json({ error: 'AI request failed' });
    }
});

// =============================================================================
// USER PROFILE / PROGRESSION SYNC
// =============================================================================

const PROFILE_KEY_PREFIX = 'profile:';

// =============================================================================
// UNIFIED USER SYSTEM - Links Patreon and Discord accounts under one identity
// =============================================================================

const UNIFIED_USER_PREFIX = 'user:';           // user:<unified_id> -> full profile
const PATREON_USER_INDEX = 'patreon_user:';    // patreon_user:<patreon_id> -> unified_id
const DISCORD_USER_INDEX = 'discord_user:';    // discord_user:<discord_id> -> unified_id

/**
 * Generate a unique unified ID
 */
function generateUnifiedId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `u_${timestamp}${random}`;
}

/**
 * Look up unified user by Patreon ID
 * Returns: { exists, unified_id, user, needs_registration }
 */
async function lookupUserByPatreon(patreonId) {
    if (!redis) return { exists: false, needs_registration: true };

    try {
        // Check index first
        const unifiedId = await redis.get(`${PATREON_USER_INDEX}${patreonId}`);
        if (unifiedId) {
            const user = await redis.get(`${UNIFIED_USER_PREFIX}${unifiedId}`);
            if (user) {
                const userData = typeof user === 'string' ? JSON.parse(user) : user;

                // IMPORTANT: If unified user has no display_name, return exists: false
                // This allows the Patreon to be properly linked to an existing Discord account
                if (!userData.display_name || userData.display_name.trim() === '') {
                    console.log(`lookupUserByPatreon: User ${unifiedId} has no display_name - returning exists: false (allows linking)`);
                    return { exists: false, needs_registration: true, has_unified_user: true };
                }

                return {
                    exists: true,
                    unified_id: unifiedId,
                    user: userData,
                    has_display_name: !!userData.display_name,
                    display_name: userData.display_name,
                    has_discord: !!userData.discord_id,
                    needs_registration: false
                };
            }
        }

        // Fall back to legacy profile lookup for migration
        const legacyKey = `${PROFILE_KEY_PREFIX}${patreonId}`;
        const legacyProfile = await redis.get(legacyKey);
        if (legacyProfile) {
            const profileData = typeof legacyProfile === 'string' ? JSON.parse(legacyProfile) : legacyProfile;

            // IMPORTANT: If legacy profile has no display_name, don't auto-migrate!
            // This allows the Patreon account to be properly linked to an existing Discord account
            // instead of creating a conflicting new unified user.
            if (!profileData.display_name || profileData.display_name.trim() === '') {
                console.log(`lookupUserByPatreon: Skipping migration for ${patreonId} - no display_name (allows linking to existing account)`);
                return { exists: false, needs_registration: true, has_legacy_profile: true };
            }

            // Migrate on-the-fly (only if has display_name)
            const migratedUser = await migratePatreonToUnified(patreonId, profileData);
            return {
                exists: true,
                unified_id: migratedUser.unified_id,
                user: migratedUser,
                has_display_name: !!migratedUser.display_name,
                display_name: migratedUser.display_name,
                has_discord: !!migratedUser.discord_id,
                needs_registration: !migratedUser.display_name,
                migrated: true
            };
        }

        return { exists: false, needs_registration: true };
    } catch (error) {
        console.error('lookupUserByPatreon error:', error);
        return { exists: false, needs_registration: true };
    }
}

/**
 * Look up unified user by Discord ID
 * Returns: { exists, unified_id, user, needs_registration }
 */
async function lookupUserByDiscord(discordId) {
    if (!redis) return { exists: false, needs_registration: true };

    try {
        // Check index first
        const unifiedId = await redis.get(`${DISCORD_USER_INDEX}${discordId}`);
        if (unifiedId) {
            const user = await redis.get(`${UNIFIED_USER_PREFIX}${unifiedId}`);
            if (user) {
                const userData = typeof user === 'string' ? JSON.parse(user) : user;

                // IMPORTANT: If unified user has no display_name, return exists: false
                // This allows proper account setup flow
                if (!userData.display_name || userData.display_name.trim() === '') {
                    console.log(`lookupUserByDiscord: User ${unifiedId} has no display_name - returning exists: false`);
                    return { exists: false, needs_registration: true, has_unified_user: true };
                }

                return {
                    exists: true,
                    unified_id: unifiedId,
                    user: userData,
                    has_display_name: !!userData.display_name,
                    display_name: userData.display_name,
                    has_patreon: !!userData.patreon_id,
                    needs_registration: false
                };
            }
        }

        // Fall back to legacy Discord profile lookup for migration
        const legacyKey = `discord_profile:${discordId}`;
        const legacyProfile = await redis.get(legacyKey);
        if (legacyProfile) {
            const profileData = typeof legacyProfile === 'string' ? JSON.parse(legacyProfile) : legacyProfile;
            // Migrate on-the-fly
            const migratedUser = await migrateDiscordToUnified(discordId, profileData);
            return {
                exists: true,
                unified_id: migratedUser.unified_id,
                user: migratedUser,
                has_display_name: !!migratedUser.display_name,
                display_name: migratedUser.display_name,
                has_patreon: !!migratedUser.patreon_id,
                needs_registration: !migratedUser.display_name,
                migrated: true
            };
        }

        return { exists: false, needs_registration: true };
    } catch (error) {
        console.error('lookupUserByDiscord error:', error);
        return { exists: false, needs_registration: true };
    }
}

/**
 * Look up unified user by email (for auto-linking)
 */
async function lookupUserByEmail(email) {
    if (!redis || !email) return null;

    try {
        const normalizedEmail = email.toLowerCase();
        const unifiedId = await redis.get(`email_index:${normalizedEmail}`);
        if (unifiedId) {
            const user = await redis.get(`${UNIFIED_USER_PREFIX}${unifiedId}`);
            if (user) {
                return {
                    unified_id: unifiedId,
                    user: typeof user === 'string' ? JSON.parse(user) : user
                };
            }
        }
        return null;
    } catch (error) {
        console.error('lookupUserByEmail error:', error);
        return null;
    }
}

/**
 * Migrate a legacy Patreon profile to unified user system
 */
async function migratePatreonToUnified(patreonId, legacyProfile) {
    const unifiedId = generateUnifiedId();

    // Archive old progression into all_time_stats (V1 data is from season 0)
    const oldStats = legacyProfile.stats || {};
    const oldAllTime = legacyProfile.all_time_stats || {};
    const allTimeStats = {
        total_flashes: (oldAllTime.total_flashes || 0) + (oldStats.total_flashes || 0),
        total_bubbles_popped: (oldAllTime.total_bubbles_popped || 0) + (oldStats.total_bubbles_popped || 0),
        total_video_minutes: (oldAllTime.total_video_minutes || 0) + (oldStats.total_video_minutes || 0),
        total_lock_cards_completed: (oldAllTime.total_lock_cards_completed || 0) + (oldStats.total_lock_cards_completed || 0),
    };

    const highestLevel = Math.max(legacyProfile.level || 1, legacyProfile.highest_level_ever || 0);

    const unifiedUser = {
        unified_id: unifiedId,
        display_name: legacyProfile.display_name || null,
        display_name_set_at: legacyProfile.display_name_set_at || null,

        // Linked providers
        patreon_id: patreonId,
        discord_id: legacyProfile.discord_id || null,
        email: legacyProfile.email || legacyProfile.patron_email || null,

        // Progression — reset for current season
        xp: 0,
        level: 1,
        achievements: legacyProfile.achievements || [],
        stats: {},
        last_session: legacyProfile.last_session || null,

        // Patreon-specific
        patron_name: legacyProfile.patron_name || null,
        patreon_tier: legacyProfile.patreon_tier || 0,
        patreon_is_active: legacyProfile.patreon_is_active || false,
        patreon_is_whitelisted: legacyProfile.patreon_is_whitelisted || false,

        // Discord-specific
        discord_username: legacyProfile.discord_username || null,
        allow_discord_dm: legacyProfile.allow_discord_dm || false,

        // Season
        current_season: getCurrentSeason(),
        highest_level_ever: highestLevel,
        unlocks: calculateUnlocks(highestLevel),
        all_time_stats: allTimeStats,
        is_season0_og: (legacyProfile.achievements?.length > 0) || (highestLevel > 1),
        level_reset_at: new Date().toISOString(),

        // Metadata
        created_at: legacyProfile.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        migrated_from: 'patreon',
        migrated_at: new Date().toISOString()
    };

    // Save unified user
    await redis.set(`${UNIFIED_USER_PREFIX}${unifiedId}`, JSON.stringify(unifiedUser));

    // Create indexes
    await redis.set(`${PATREON_USER_INDEX}${patreonId}`, unifiedId);
    if (unifiedUser.discord_id) {
        await redis.set(`${DISCORD_USER_INDEX}${unifiedUser.discord_id}`, unifiedId);
    }
    if (unifiedUser.email) {
        await redis.set(`email_index:${unifiedUser.email.toLowerCase()}`, unifiedId);
    }
    if (unifiedUser.display_name) {
        await redis.set(`display_name_index:${unifiedUser.display_name.toLowerCase()}`, unifiedId);
    }

    console.log(`Migrated Patreon user ${patreonId} to unified user ${unifiedId}`);
    return unifiedUser;
}

/**
 * Migrate a legacy Discord profile to unified user system
 */
async function migrateDiscordToUnified(discordId, legacyProfile) {
    // Check if there's a linked Patreon account we should merge with
    if (legacyProfile.linked_patreon_id) {
        const patreonLookup = await lookupUserByPatreon(legacyProfile.linked_patreon_id);
        if (patreonLookup.exists) {
            // Add Discord to existing unified user
            const user = patreonLookup.user;
            user.discord_id = discordId;
            user.discord_username = legacyProfile.discord_username || null;
            user.allow_discord_dm = legacyProfile.allow_discord_dm || false;
            user.updated_at = new Date().toISOString();

            // Track highest level from legacy data for unlocks (but don't inflate current season XP/level)
            const legacyHighest = Math.max(legacyProfile.level || 1, legacyProfile.highest_level_ever || 0);
            user.highest_level_ever = Math.max(user.highest_level_ever || 0, legacyHighest);
            user.unlocks = calculateUnlocks(user.highest_level_ever);

            await redis.set(`${UNIFIED_USER_PREFIX}${patreonLookup.unified_id}`, JSON.stringify(user));
            await redis.set(`${DISCORD_USER_INDEX}${discordId}`, patreonLookup.unified_id);

            console.log(`Merged Discord ${discordId} into unified user ${patreonLookup.unified_id}`);
            return user;
        }
    }

    // Create new unified user from Discord
    const unifiedId = generateUnifiedId();

    // Archive old progression into all_time_stats (V1 data is from season 0)
    const oldStats = legacyProfile.stats || {};
    const oldAllTime = legacyProfile.all_time_stats || {};
    const allTimeStats = {
        total_flashes: (oldAllTime.total_flashes || 0) + (oldStats.total_flashes || 0),
        total_bubbles_popped: (oldAllTime.total_bubbles_popped || 0) + (oldStats.total_bubbles_popped || 0),
        total_video_minutes: (oldAllTime.total_video_minutes || 0) + (oldStats.total_video_minutes || 0),
        total_lock_cards_completed: (oldAllTime.total_lock_cards_completed || 0) + (oldStats.total_lock_cards_completed || 0),
    };

    const highestLevel = Math.max(legacyProfile.level || 1, legacyProfile.highest_level_ever || 0);

    const unifiedUser = {
        unified_id: unifiedId,
        display_name: legacyProfile.display_name || null,
        display_name_set_at: legacyProfile.display_name_set_at || null,

        // Linked providers
        patreon_id: null,
        discord_id: discordId,
        email: legacyProfile.email || null,

        // Progression — reset for current season
        xp: 0,
        level: 1,
        achievements: legacyProfile.achievements || [],
        stats: {},
        last_session: legacyProfile.last_session || null,

        // Patreon-specific (will be filled when linked)
        patron_name: null,
        patreon_tier: 0,
        patreon_is_active: false,
        patreon_is_whitelisted: false,

        // Discord-specific
        discord_username: legacyProfile.discord_username || null,
        allow_discord_dm: legacyProfile.allow_discord_dm || false,

        // Season
        current_season: getCurrentSeason(),
        highest_level_ever: highestLevel,
        unlocks: calculateUnlocks(highestLevel),
        all_time_stats: allTimeStats,
        is_season0_og: (legacyProfile.achievements?.length > 0) || (highestLevel > 1),
        level_reset_at: new Date().toISOString(),

        // Metadata
        created_at: legacyProfile.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        migrated_from: 'discord',
        migrated_at: new Date().toISOString()
    };

    // Save unified user
    await redis.set(`${UNIFIED_USER_PREFIX}${unifiedId}`, JSON.stringify(unifiedUser));

    // Create indexes (both V1 and V2 key formats)
    await redis.set(`${DISCORD_USER_INDEX}${discordId}`, unifiedId);
    await redis.set(`discord_index:${discordId}`, unifiedId);
    if (unifiedUser.email) {
        await redis.set(`email_index:${unifiedUser.email.toLowerCase()}`, unifiedId);
    }
    if (unifiedUser.display_name) {
        await redis.set(`display_name_index:${unifiedUser.display_name.toLowerCase()}`, unifiedId);
    }

    console.log(`Migrated Discord user ${discordId} to unified user ${unifiedId}`);
    return unifiedUser;
}

/**
 * Register a new unified user (first-time login)
 */
async function registerUnifiedUser(displayName, provider, providerId, providerData) {
    if (!redis) throw new Error('Storage not available');

    const normalizedName = displayName.trim();
    const indexKey = `display_name_index:${normalizedName.toLowerCase()}`;

    // Check if name is taken
    const existingId = await redis.get(indexKey);
    if (existingId) {
        // Check if it's a claimable account (same email)
        const existingUser = await redis.get(`${UNIFIED_USER_PREFIX}${existingId}`);
        if (existingUser) {
            const userData = typeof existingUser === 'string' ? JSON.parse(existingUser) : existingUser;
            const canClaim = providerData.email && userData.email &&
                            providerData.email.toLowerCase() === userData.email.toLowerCase();
            return { success: false, error: 'Display name already taken', can_claim: !!canClaim, existing_unified_id: existingId };
        }
    }

    const unifiedId = generateUnifiedId();

    const unifiedUser = {
        unified_id: unifiedId,
        display_name: normalizedName,
        display_name_set_at: new Date().toISOString(),

        // Linked providers
        patreon_id: provider === 'patreon' ? providerId : null,
        discord_id: provider === 'discord' ? providerId : null,
        email: providerData.email?.toLowerCase() || null,

        // Progression (starting fresh)
        xp: 0,
        level: 1,
        achievements: [],
        stats: {},
        last_session: new Date().toISOString(),

        // Patreon-specific
        patron_name: providerData.patron_name || null,
        patreon_tier: providerData.tier || 0,
        patreon_is_active: providerData.is_active || false,
        patreon_is_whitelisted: providerData.is_whitelisted || false,

        // Discord-specific
        discord_username: providerData.discord_username || null,
        allow_discord_dm: false,

        // Metadata
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    // Check whitelist by display name
    if (isWhitelisted(unifiedUser.email, unifiedUser.patron_name, normalizedName)) {
        unifiedUser.patreon_is_whitelisted = true;
        unifiedUser.patreon_tier = Math.max(unifiedUser.patreon_tier, 1);
    }

    // Save unified user
    await redis.set(`${UNIFIED_USER_PREFIX}${unifiedId}`, JSON.stringify(unifiedUser));

    // Create indexes
    await redis.set(indexKey, unifiedId);
    if (provider === 'patreon') {
        await redis.set(`${PATREON_USER_INDEX}${providerId}`, unifiedId);
    } else {
        await redis.set(`${DISCORD_USER_INDEX}${providerId}`, unifiedId);
    }
    if (unifiedUser.email) {
        await redis.set(`email_index:${unifiedUser.email}`, unifiedId);
    }

    console.log(`Registered new unified user ${unifiedId} with display name "${normalizedName}" via ${provider}`);
    return { success: true, unified_id: unifiedId, user: unifiedUser };
}

/**
 * Link a second provider to an existing unified user
 */
async function linkProviderToUser(unifiedId, provider, providerId, providerData) {
    if (!redis) throw new Error('Storage not available');

    const userKey = `${UNIFIED_USER_PREFIX}${unifiedId}`;
    const existing = await redis.get(userKey);
    if (!existing) {
        return { success: false, error: 'User not found' };
    }

    const user = typeof existing === 'string' ? JSON.parse(existing) : existing;

    // Check if provider is already linked to a different user
    const existingLink = provider === 'patreon'
        ? await redis.get(`${PATREON_USER_INDEX}${providerId}`)
        : await redis.get(`${DISCORD_USER_INDEX}${providerId}`);

    if (existingLink && existingLink !== unifiedId) {
        return { success: false, error: 'This account is already linked to a different user' };
    }

    // Update user with new provider
    if (provider === 'patreon') {
        user.patreon_id = providerId;
        user.patron_name = providerData.patron_name || user.patron_name;
        user.patreon_tier = providerData.tier || user.patreon_tier;
        user.patreon_is_active = providerData.is_active ?? user.patreon_is_active;
        user.patreon_is_whitelisted = providerData.is_whitelisted ?? user.patreon_is_whitelisted;
        await redis.set(`${PATREON_USER_INDEX}${providerId}`, unifiedId);
    } else {
        user.discord_id = providerId;
        user.discord_username = providerData.discord_username || user.discord_username;
        await redis.set(`${DISCORD_USER_INDEX}${providerId}`, unifiedId);
    }

    // Update email if not set
    if (!user.email && providerData.email) {
        user.email = providerData.email.toLowerCase();
        await redis.set(`email_index:${user.email}`, unifiedId);
    }

    user.updated_at = new Date().toISOString();

    // Re-check whitelist with new data
    if (isWhitelisted(user.email, user.patron_name, user.display_name)) {
        user.patreon_is_whitelisted = true;
        user.patreon_tier = Math.max(user.patreon_tier, 1);
    }

    await redis.set(userKey, JSON.stringify(user));

    console.log(`Linked ${provider} ${providerId} to unified user ${unifiedId}`);
    return { success: true, unified_id: unifiedId, user };
}

/**
 * Update unified user's Patreon status
 */
async function updateUnifiedUserPatreonStatus(unifiedId, patreonData) {
    if (!redis) return;

    const userKey = `${UNIFIED_USER_PREFIX}${unifiedId}`;
    const existing = await redis.get(userKey);
    if (!existing) return;

    const user = typeof existing === 'string' ? JSON.parse(existing) : existing;

    user.patreon_tier = patreonData.tier ?? user.patreon_tier;
    user.patreon_is_active = patreonData.is_active ?? user.patreon_is_active;
    user.patreon_is_whitelisted = patreonData.is_whitelisted ?? user.patreon_is_whitelisted;
    user.patron_name = patreonData.patron_name || user.patron_name;
    user.updated_at = new Date().toISOString();

    await redis.set(userKey, JSON.stringify(user));
}

// =============================================================================
// UNIFIED AUTH ENDPOINTS
// =============================================================================

/**
 * POST /auth/lookup
 * Check if a provider account is already linked to a unified user
 * Body: { provider: "patreon"|"discord" }
 * Requires: Authorization header with provider's access token
 */
app.post('/auth/lookup', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);
        const { provider } = req.body;

        if (!provider || !['patreon', 'discord'].includes(provider)) {
            return res.status(400).json({ error: 'Valid provider required (patreon or discord)' });
        }

        let providerId, email, result;

        if (provider === 'patreon') {
            const identity = await getPatreonIdentity(accessToken);
            const tierInfo = determineTier(identity);
            providerId = tierInfo.patreon_user_id;
            email = tierInfo.patron_email;

            result = await lookupUserByPatreon(providerId);
            result.provider_data = {
                patron_name: tierInfo.patron_name,
                email: email,
                tier: tierInfo.tier,
                is_active: tierInfo.is_active,
                is_whitelisted: isWhitelisted(email, tierInfo.patron_name, result.display_name)
            };
        } else {
            const discordUser = await getDiscordUser(accessToken);
            providerId = discordUser.id;
            email = discordUser.email;

            result = await lookupUserByDiscord(providerId);
            result.provider_data = {
                discord_username: discordUser.username,
                email: email
            };
        }

        // If no unified user found, check for email-based auto-link opportunity
        if (!result.exists && email) {
            const emailLookup = await lookupUserByEmail(email);
            if (emailLookup) {
                result.can_auto_link = true;
                result.auto_link_unified_id = emailLookup.unified_id;
                result.auto_link_display_name = emailLookup.user.display_name;
            }
        }

        res.json(result);
    } catch (error) {
        console.error('Auth lookup error:', error.message);
        res.status(500).json({ error: 'Lookup failed' });
    }
});

/**
 * POST /auth/register
 * Register a new unified user (first-time login)
 * Body: { display_name: string, provider: "patreon"|"discord" }
 * Requires: Authorization header with provider's access token
 */
app.post('/auth/register', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);
        const { display_name, provider } = req.body;

        if (!display_name || typeof display_name !== 'string') {
            return res.status(400).json({ error: 'Display name required' });
        }

        if (!provider || !['patreon', 'discord'].includes(provider)) {
            return res.status(400).json({ error: 'Valid provider required (patreon or discord)' });
        }

        const trimmedName = display_name.trim();
        if (trimmedName.length < 2 || trimmedName.length > 20) {
            return res.status(400).json({ error: 'Display name must be 2-20 characters' });
        }

        let providerId, providerData;

        if (provider === 'patreon') {
            const identity = await getPatreonIdentity(accessToken);
            const tierInfo = determineTier(identity);
            providerId = tierInfo.patreon_user_id;
            providerData = {
                patron_name: tierInfo.patron_name,
                email: tierInfo.patron_email,
                tier: tierInfo.tier,
                is_active: tierInfo.is_active,
                is_whitelisted: isWhitelisted(tierInfo.patron_email, tierInfo.patron_name, trimmedName)
            };
        } else {
            const discordUser = await getDiscordUser(accessToken);
            providerId = discordUser.id;
            providerData = {
                discord_username: discordUser.username,
                email: discordUser.email
            };
        }

        // Check if provider is already registered (shouldn't happen, but safety check)
        const existingLookup = provider === 'patreon'
            ? await lookupUserByPatreon(providerId)
            : await lookupUserByDiscord(providerId);

        if (existingLookup.exists && existingLookup.has_display_name) {
            return res.status(409).json({
                error: 'Account already registered',
                unified_id: existingLookup.unified_id,
                display_name: existingLookup.display_name
            });
        }

        const result = await registerUnifiedUser(trimmedName, provider, providerId, providerData);

        if (!result.success) {
            return res.status(409).json(result);
        }

        res.json({
            success: true,
            unified_id: result.unified_id,
            display_name: result.user.display_name,
            user: result.user
        });
    } catch (error) {
        console.error('Auth register error:', error.message);
        res.status(500).json({ error: 'Registration failed' });
    }
});

/**
 * POST /auth/link-provider
 * Link a second provider to an existing unified user
 * Body: { unified_id: string }
 * Requires: Authorization header with NEW provider's access token
 */
app.post('/auth/link-provider', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);
        let { unified_id, provider } = req.body;

        // Try to determine provider from token
        let providerId, providerData;
        let detectedProvider = provider;

        // Try Patreon first
        try {
            const identity = await getPatreonIdentity(accessToken);
            const tierInfo = determineTier(identity);
            providerId = tierInfo.patreon_user_id;
            detectedProvider = 'patreon';
            providerData = {
                patron_name: tierInfo.patron_name,
                email: tierInfo.patron_email,
                tier: tierInfo.tier,
                is_active: tierInfo.is_active,
                is_whitelisted: isWhitelisted(tierInfo.patron_email, tierInfo.patron_name, null)
            };
        } catch (patreonError) {
            // Try Discord
            try {
                const discordUser = await getDiscordUser(accessToken);
                providerId = discordUser.id;
                detectedProvider = 'discord';
                providerData = {
                    discord_username: discordUser.username,
                    email: discordUser.email
                };
            } catch (discordError) {
                return res.status(401).json({ error: 'Invalid access token' });
            }
        }

        // If no unified_id provided, try to find via email auto-link
        if (!unified_id && providerData.email) {
            const emailLookup = await lookupUserByEmail(providerData.email);
            if (emailLookup) {
                unified_id = emailLookup.unified_id;
                console.log(`Auto-linking ${detectedProvider} via email to ${unified_id}`);
            }
        }

        if (!unified_id) {
            return res.status(400).json({ error: 'unified_id required or no email match found' });
        }

        const result = await linkProviderToUser(unified_id, detectedProvider, providerId, providerData);

        if (!result.success) {
            return res.status(409).json(result);
        }

        res.json({
            success: true,
            unified_id: result.unified_id,
            linked_providers: [
                result.user.patreon_id ? 'patreon' : null,
                result.user.discord_id ? 'discord' : null
            ].filter(Boolean),
            user: result.user
        });
    } catch (error) {
        console.error('Auth link-provider error:', error.message);
        res.status(500).json({ error: 'Linking failed' });
    }
});

/**
 * POST /auth/claim
 * Claim an existing display name (link accounts with same owner)
 * Body: { display_name: string, provider: "patreon"|"discord" }
 */
app.post('/auth/claim', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);
        const { display_name, provider } = req.body;

        if (!display_name || !provider) {
            return res.status(400).json({ error: 'display_name and provider required' });
        }

        // Look up the existing user with this display name
        const indexKey = `display_name_index:${display_name.trim().toLowerCase()}`;
        const existingUnifiedId = await redis.get(indexKey);

        if (!existingUnifiedId) {
            return res.status(404).json({ error: 'Display name not found' });
        }

        let providerId, providerData;

        if (provider === 'patreon') {
            const identity = await getPatreonIdentity(accessToken);
            const tierInfo = determineTier(identity);
            providerId = tierInfo.patreon_user_id;
            providerData = {
                patron_name: tierInfo.patron_name,
                email: tierInfo.patron_email,
                tier: tierInfo.tier,
                is_active: tierInfo.is_active,
                is_whitelisted: isWhitelisted(tierInfo.patron_email, tierInfo.patron_name, display_name)
            };
        } else {
            const discordUser = await getDiscordUser(accessToken);
            providerId = discordUser.id;
            providerData = {
                discord_username: discordUser.username,
                email: discordUser.email
            };
        }

        // Verify claim is legitimate (same email)
        const existingUser = await redis.get(`${UNIFIED_USER_PREFIX}${existingUnifiedId}`);
        if (!existingUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userData = typeof existingUser === 'string' ? JSON.parse(existingUser) : existingUser;

        // Check if emails match
        if (!providerData.email || !userData.email ||
            providerData.email.toLowerCase() !== userData.email.toLowerCase()) {
            return res.status(403).json({
                error: 'Cannot claim this account - email does not match',
                hint: 'Make sure you are using the same email address on both platforms'
            });
        }

        // Link the provider
        const result = await linkProviderToUser(existingUnifiedId, provider, providerId, providerData);

        if (!result.success) {
            return res.status(409).json(result);
        }

        res.json({
            success: true,
            unified_id: result.unified_id,
            display_name: result.user.display_name,
            linked_providers: [
                result.user.patreon_id ? 'patreon' : null,
                result.user.discord_id ? 'discord' : null
            ].filter(Boolean),
            user: result.user
        });
    } catch (error) {
        console.error('Auth claim error:', error.message);
        res.status(500).json({ error: 'Claim failed' });
    }
});

// =============================================================================
// LEGACY PROFILE ENDPOINTS (with unified user integration)
// =============================================================================

/**
 * GET /user/profile
 * Load user's progression data (XP, level, achievements, stats)
 * Requires: Authorization: Bearer <patreon_access_token>
 */
app.get('/user/profile', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);
        const identity = await getPatreonIdentity(accessToken);
        const tierInfo = determineTier(identity);

        const userId = tierInfo.patreon_user_id;
        if (!userId) {
            return res.status(401).json({ error: 'Could not identify user' });
        }

        // Check if Redis is available
        if (!redis) {
            return res.status(503).json({ error: 'Profile storage not available' });
        }

        // FIRST: Check for unified user via patreon_user index
        const unifiedUserId = await redis.get(`patreon_user:${userId}`);
        if (unifiedUserId) {
            const unifiedUserKey = `user:${unifiedUserId}`;
            const unifiedUserData = await redis.get(unifiedUserKey);
            if (unifiedUserData) {
                const unifiedUser = typeof unifiedUserData === 'string' ? JSON.parse(unifiedUserData) : unifiedUserData;
                console.log(`Found unified user for Patreon ${userId}: ${unifiedUserId} (Level ${unifiedUser.level})`);
                return res.json({
                    exists: true,
                    user_id: userId,
                    patron_name: tierInfo.patron_name,
                    unified_user_id: unifiedUserId,
                    profile: {
                        display_name: unifiedUser.display_name,
                        xp: unifiedUser.xp || 0,
                        level: unifiedUser.level || 1,
                        achievements: unifiedUser.achievements || [],
                        stats: unifiedUser.stats || {},
                        updated_at: unifiedUser.updated_at,
                        reset_weekly_quest: unifiedUser.reset_weekly_quest || false,
                        reset_daily_quest: unifiedUser.reset_daily_quest || false,
                        skill_points: unifiedUser.skill_points || 0,
                        unlocked_skills: unifiedUser.unlocked_skills || []
                    }
                });
            }
        }

        const key = `${PROFILE_KEY_PREFIX}${userId}`;
        const profile = await redis.get(key);

        if (!profile) {
            // No profile found - return empty/default
            console.log(`No profile found for user ${userId} (${tierInfo.patron_name})`);
            return res.json({
                exists: false,
                user_id: userId,
                patron_name: tierInfo.patron_name
            });
        }

        console.log(`Loaded profile for user ${userId} (${tierInfo.patron_name})`);

        // Profile is stored as JSON string
        const profileData = typeof profile === 'string' ? JSON.parse(profile) : profile;

        res.json({
            exists: true,
            user_id: userId,
            patron_name: tierInfo.patron_name,
            profile: profileData
        });
    } catch (error) {
        console.error('Profile load error:', error.message);
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

/**
 * POST /user/sync
 * Save user's progression data (XP, level, achievements, stats)
 * Requires: Authorization: Bearer <patreon_access_token>
 * Body: { xp, level, achievements[], stats{} }
 */
app.post('/user/sync', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);
        const identity = await getPatreonIdentity(accessToken);
        const tierInfo = determineTier(identity);

        const userId = tierInfo.patreon_user_id;
        if (!userId) {
            return res.status(401).json({ error: 'Could not identify user' });
        }

        // Check if Redis is available
        if (!redis) {
            return res.status(503).json({ error: 'Profile storage not available' });
        }

        const { xp, level, achievements, stats, last_session, allow_discord_dm, share_profile_picture, show_online_status, discord_id, display_name: requestDisplayName, avatar_url, reset_weekly_quest, reset_daily_quest, force_streak_override: clientForceStreakOverride } = req.body;

        // Validate required fields
        if (typeof xp !== 'number' || typeof level !== 'number') {
            return res.status(400).json({ error: 'xp and level are required numbers' });
        }

        // Load existing profile to merge/compare
        const key = `${PROFILE_KEY_PREFIX}${userId}`;
        const existingProfile = await redis.get(key);
        let existing = null;

        if (existingProfile) {
            existing = typeof existingProfile === 'string' ? JSON.parse(existingProfile) : existingProfile;
        }

        // Check Patreon status live during sync (pledge >= 5 cents OR whitelisted)
        // Now checks display_name from existing profile OR request body
        const displayNameToCheck = existing?.display_name || requestDisplayName || null;
        const isWhitelistedUser = isWhitelisted(tierInfo.patron_email, tierInfo.patron_name, displayNameToCheck);
        const hasActivePledge = tierInfo.is_active && tierInfo.pledge_cents >= 5;
        const effectiveTier = (isWhitelistedUser || hasActivePledge) ? Math.max(tierInfo.tier, isWhitelistedUser ? 2 : 1) : tierInfo.tier;

        // Merge achievements (union of local and server)
        let mergedAchievements = achievements || [];
        if (existing?.achievements) {
            const achievementSet = new Set([...existing.achievements, ...mergedAchievements]);
            mergedAchievements = Array.from(achievementSet);
        }

        // Take the higher XP/level (in case of conflicts)
        const finalXp = existing ? Math.max(xp, existing.xp || 0) : xp;
        const finalLevel = existing ? Math.max(level, existing.level || 0) : level;

        console.log(`Sync for ${tierInfo.patron_name}: incoming level=${level}, existing level=${existing?.level || 0}, final level=${finalLevel}`);

        // Stats keys controlled by force_streak_override
        const STREAK_STAT_KEYS_LEGACY = new Set([
            'daily_quest_streak', 'last_daily_quest_date', 'quest_completion_dates',
            'total_daily_quests_completed', 'total_weekly_quests_completed', 'total_xp_from_quests'
        ]);
        const hasForceStreakOverrideLegacy = existing?.force_streak_override === true;

        // Merge stats (take max of each stat, skip streak stats if force_streak_override is active)
        let mergedStats = stats || {};
        if (existing?.stats) {
            mergedStats = { ...existing.stats };
            for (const [statKey, statValue] of Object.entries(stats || {})) {
                // Skip streak stats when admin has force-set them
                if (hasForceStreakOverrideLegacy && STREAK_STAT_KEYS_LEGACY.has(statKey)) {
                    continue;
                }
                if (typeof statValue === 'number') {
                    mergedStats[statKey] = Math.max(mergedStats[statKey] || 0, statValue);
                } else {
                    mergedStats[statKey] = statValue;
                }
            }
        }

        const profile = {
            xp: finalXp,
            level: finalLevel,
            achievements: mergedAchievements,
            stats: mergedStats,
            last_session: last_session || new Date().toISOString(),
            updated_at: new Date().toISOString(),
            patron_name: tierInfo.patron_name,
            // Preserve display_name if already set — never auto-populate from patron_name (privacy)
            display_name: existing?.display_name || null,
            display_name_set_at: existing?.display_name_set_at || null,
            // Discord DM opt-in (preserve if not provided in request)
            allow_discord_dm: typeof allow_discord_dm === 'boolean' ? allow_discord_dm : (existing?.allow_discord_dm || false),
            // Profile picture sharing opt-in
            share_profile_picture: typeof share_profile_picture === 'boolean' ? share_profile_picture : (existing?.share_profile_picture || false),
            // Online status visibility opt-in (default true - visible)
            show_online_status: typeof show_online_status === 'boolean' ? show_online_status : (existing?.show_online_status !== false),
            // Store Discord ID for DM feature (update if provided, otherwise preserve existing)
            discord_id: discord_id || existing?.discord_id || null,
            // Store Discord avatar URL (update if provided, otherwise preserve existing)
            avatar_url: avatar_url || existing?.avatar_url || null,
            // Update Patreon status fields live (checked during sync)
            patreon_tier: effectiveTier,
            patreon_is_active: hasActivePledge,
            patreon_is_whitelisted: isWhitelistedUser,
            patreon_status_updated_at: new Date().toISOString(),
            email: tierInfo.patron_email?.toLowerCase() || existing?.email,
            // Capture pending reset flags before clearing
            reset_weekly_quest: (reset_weekly_quest === false) ? false : (existing?.reset_weekly_quest || false),
            reset_daily_quest: (reset_daily_quest === false) ? false : (existing?.reset_daily_quest || false),
            // Handle force_streak_override: clear when client sends false, otherwise preserve
            force_streak_override: (clientForceStreakOverride === false) ? undefined : (existing?.force_streak_override || false)
        };

        // Store profile (no expiry - permanent storage)
        await redis.set(key, JSON.stringify(profile));

        console.log(`Synced profile for user ${userId} (${tierInfo.patron_name}): Level ${finalLevel}, ${finalXp} XP, ${mergedAchievements.length} achievements`);

        res.json({
            success: true,
            user_id: userId,
            profile: profile,
            merged: !!existing
        });
    } catch (error) {
        console.error('Profile sync error:', error.message);
        res.status(500).json({ error: 'Failed to sync profile' });
    }
});

/**
 * POST /user/heartbeat
 * Lightweight endpoint to keep user showing as online.
 * Only updates the updated_at timestamp, doesn't sync profile data.
 * Requires: Authorization: Bearer <patreon_access_token>
 */
app.post('/user/heartbeat', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);
        const identity = await getPatreonIdentity(accessToken);
        const tierInfo = determineTier(identity);

        const userId = tierInfo.patreon_user_id;
        if (!userId) {
            return res.status(401).json({ error: 'Could not identify user' });
        }

        if (!redis) {
            return res.status(503).json({ error: 'Profile storage not available' });
        }

        const key = `${PROFILE_KEY_PREFIX}${userId}`;
        const existingProfile = await redis.get(key);

        if (existingProfile) {
            const profile = typeof existingProfile === 'string' ? JSON.parse(existingProfile) : existingProfile;
            // Only update the timestamp
            profile.updated_at = new Date().toISOString();
            await redis.set(key, JSON.stringify(profile));
        } else {
            // Create a basic profile if none exists
            // Note: display_name is NOT auto-set - user must choose their own name to appear on leaderboard
            const newProfile = {
                patreon_user_id: userId,
                patron_name: tierInfo.patron_name,
                xp: 0,
                level: 1,
                achievements: [],
                stats: {},
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            await redis.set(key, JSON.stringify(newProfile));
            console.log(`Heartbeat created new profile for ${tierInfo.patron_name} (${userId})`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Heartbeat error:', error.message);
        res.status(500).json({ error: 'Heartbeat failed' });
    }
});

/**
 * POST /user/set-display-name
 * Set custom display name (ONE TIME ONLY - cannot be changed after set)
 * Requires: Authorization: Bearer <patreon_access_token>
 * Body: { display_name: string }
 */
app.post('/user/set-display-name', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);
        const identity = await getPatreonIdentity(accessToken);
        const tierInfo = determineTier(identity);

        const userId = tierInfo.patreon_user_id;
        if (!userId) {
            return res.status(401).json({ error: 'Could not identify user' });
        }

        if (!redis) {
            return res.status(503).json({ error: 'Profile storage not available' });
        }

        const { display_name } = req.body;

        // Validate display name
        if (!display_name || typeof display_name !== 'string') {
            return res.status(400).json({ error: 'display_name is required' });
        }

        const trimmedName = display_name.trim();
        if (trimmedName.length < 2 || trimmedName.length > 20) {
            return res.status(400).json({ error: 'Display name must be 2-20 characters' });
        }

        // Check for inappropriate content (basic filter)
        const inappropriate = /[<>{}\\\/\[\]]/g;
        if (inappropriate.test(trimmedName)) {
            return res.status(400).json({ error: 'Display name contains invalid characters' });
        }

        // Load existing profile
        const key = `${PROFILE_KEY_PREFIX}${userId}`;
        const existingProfile = await redis.get(key);
        let profile = existingProfile
            ? (typeof existingProfile === 'string' ? JSON.parse(existingProfile) : existingProfile)
            : { xp: 0, level: 1, achievements: [], stats: {} };

        // Check if display name already set (ONE TIME ONLY)
        if (profile.display_name) {
            return res.status(400).json({
                error: 'Display name already set and cannot be changed',
                current_name: profile.display_name
            });
        }

        // Check if this display name is already taken by someone else (auto-cleans orphans)
        const existingOwner = await isDisplayNameTaken(trimmedName);
        if (existingOwner && existingOwner !== userId) {
            return res.status(400).json({
                error: 'This display name is already taken. Please choose another.'
            });
        }

        // Set the display name
        const indexKey = `display_name_index:${trimmedName.toLowerCase()}`;
        profile.display_name = trimmedName;
        profile.display_name_set_at = new Date().toISOString();
        profile.updated_at = new Date().toISOString();

        // Check if new display_name matches whitelist
        const whitelistedByDisplayName = isWhitelisted(null, null, trimmedName);
        if (whitelistedByDisplayName) {
            profile.patreon_is_whitelisted = true;
            profile.patreon_tier = Math.max(profile.patreon_tier || 0, 1);
            console.log(`User ${userId} whitelisted by display_name: "${trimmedName}"`);
        }

        // Save profile and create index entry atomically
        await redis.set(key, JSON.stringify(profile));
        await redis.set(indexKey, userId);

        console.log(`Display name set for user ${userId}: "${trimmedName}"`);

        res.json({
            success: true,
            display_name: trimmedName,
            is_whitelisted: whitelistedByDisplayName || profile.patreon_is_whitelisted || false,
            profile: profile
        });
    } catch (error) {
        console.error('Set display name error:', error.message);
        res.status(500).json({ error: 'Failed to set display name' });
    }
});

/**
 * Check if a display name is available (not already taken)
 * GET /user/check-display-name?name=SomeName
 * Requires: Authorization: Bearer <patreon_access_token>
 */
app.get('/user/check-display-name', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        // Validate token (ensures user is authenticated)
        const accessToken = authHeader.substring(7);
        await getPatreonIdentity(accessToken);

        if (!redis) {
            // Can't check without Redis, allow optimistically
            return res.json({ available: true });
        }

        const { name } = req.query;
        if (!name || typeof name !== 'string') {
            return res.status(400).json({ available: false, error: 'Name parameter is required' });
        }

        const trimmedName = name.trim().toLowerCase();
        if (trimmedName.length < 2 || trimmedName.length > 20) {
            return res.status(400).json({ available: false, error: 'Display name must be 2-20 characters' });
        }

        // Check the display name index (auto-cleans orphans)
        const owner = await isDisplayNameTaken(trimmedName);

        if (owner) {
            return res.json({ available: false, error: 'This name is already taken' });
        }

        res.json({ available: true });
    } catch (error) {
        console.error('Check display name error:', error.message);
        // On error, allow optimistically
        res.json({ available: true });
    }
});

// =============================================================================
// DISCORD USER DISPLAY NAME ENDPOINTS
// =============================================================================

const DISCORD_PROFILE_KEY_PREFIX = 'discord_profile:';

/**
 * POST /user/set-display-name-discord
 * Set custom display name for Discord users (ONE TIME ONLY - cannot be changed after set)
 * Requires: Authorization: Bearer <discord_access_token>
 * Body: { display_name: string }
 */
app.post('/user/set-display-name-discord', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);
        const user = await getDiscordUser(accessToken);
        const userId = `discord_${user.id}`;

        if (!redis) {
            return res.status(503).json({ error: 'Profile storage not available' });
        }

        const { display_name, claim_existing } = req.body;

        // Validate display name
        if (!display_name || typeof display_name !== 'string') {
            return res.status(400).json({ error: 'display_name is required' });
        }

        const trimmedName = display_name.trim();
        if (trimmedName.length < 2 || trimmedName.length > 20) {
            return res.status(400).json({ error: 'Display name must be 2-20 characters' });
        }

        // Check for inappropriate content (basic filter)
        const inappropriate = /[<>{}\\\/\[\]]/g;
        if (inappropriate.test(trimmedName)) {
            return res.status(400).json({ error: 'Display name contains invalid characters' });
        }

        // Load existing profile
        const key = `${DISCORD_PROFILE_KEY_PREFIX}${user.id}`;
        const existingProfile = await redis.get(key);
        let profile = existingProfile
            ? (typeof existingProfile === 'string' ? JSON.parse(existingProfile) : existingProfile)
            : { discord_id: user.id, discord_username: user.username };

        // Check if display name already set (ONE TIME ONLY)
        if (profile.display_name) {
            return res.status(400).json({
                error: 'Display name already set and cannot be changed',
                current_name: profile.display_name
            });
        }

        // Check if this display name is already taken by someone else (shared namespace with Patreon)
        const indexKey = `display_name_index:${trimmedName.toLowerCase()}`;
        const existingUserId = await isDisplayNameTaken(trimmedName);

        if (existingUserId && existingUserId !== userId) {
            // Name is taken - check if it's a Patreon user (not discord_) and if claim_existing is set
            const isPatreonUser = !existingUserId.startsWith('discord_');

            if (isPatreonUser && claim_existing === true) {
                // User is claiming their Patreon name via Discord - link the accounts
                const patreonProfileKey = `${PROFILE_KEY_PREFIX}${existingUserId}`;
                const patreonProfileData = await redis.get(patreonProfileKey);

                if (patreonProfileData) {
                    const patreonProfile = typeof patreonProfileData === 'string'
                        ? JSON.parse(patreonProfileData)
                        : patreonProfileData;

                    // Link the accounts
                    profile.display_name = trimmedName;
                    profile.linked_patreon_id = existingUserId;
                    profile.claimed_at = new Date().toISOString();
                    profile.display_name_set_at = new Date().toISOString();
                    profile.updated_at = new Date().toISOString();

                    // Copy over progression from Patreon if Discord doesn't have any
                    if (!profile.xp && patreonProfile.xp) profile.xp = patreonProfile.xp;
                    if (!profile.level && patreonProfile.level) profile.level = patreonProfile.level;
                    if (!profile.achievements && patreonProfile.achievements) profile.achievements = patreonProfile.achievements;
                    if (!profile.stats && patreonProfile.stats) profile.stats = patreonProfile.stats;

                    // Check if display_name matches whitelist
                    const whitelistedByDisplayName = isWhitelisted(null, null, trimmedName);
                    if (whitelistedByDisplayName) {
                        profile.patreon_is_whitelisted = true;
                        profile.patreon_tier = Math.max(profile.patreon_tier || 0, 1);
                    }

                    await redis.set(key, JSON.stringify(profile));

                    console.log(`Discord user ${user.username} claimed Patreon display name "${trimmedName}" (linked to ${existingUserId})`);

                    return res.json({
                        success: true,
                        display_name: trimmedName,
                        claimed_from_patreon: true,
                        linked_patreon_id: existingUserId,
                        is_whitelisted: whitelistedByDisplayName || profile.patreon_is_whitelisted || false
                    });
                }
            }

            // Return error with info about whether it can be claimed
            return res.status(400).json({
                error: 'This display name is already taken.',
                can_claim: isPatreonUser,
                message: isPatreonUser
                    ? 'This name belongs to a Patreon account. If this is your account, you can claim it.'
                    : 'Please choose another name.'
            });
        }

        // Set the display name
        profile.display_name = trimmedName;
        profile.display_name_set_at = new Date().toISOString();
        profile.updated_at = new Date().toISOString();

        // Check if new display_name matches whitelist
        const whitelistedByDisplayName = isWhitelisted(null, null, trimmedName);
        if (whitelistedByDisplayName) {
            profile.patreon_is_whitelisted = true;
            profile.patreon_tier = Math.max(profile.patreon_tier || 0, 1);
            console.log(`Discord user ${user.id} whitelisted by display_name: "${trimmedName}"`);
        }

        // Save profile and create index entry atomically
        await redis.set(key, JSON.stringify(profile));
        await redis.set(indexKey, userId);

        console.log(`Display name set for Discord user ${user.id}: "${trimmedName}"`);

        res.json({
            success: true,
            display_name: trimmedName,
            is_whitelisted: whitelistedByDisplayName || profile.patreon_is_whitelisted || false
        });
    } catch (error) {
        console.error('Set Discord display name error:', error.message);
        res.status(500).json({ error: 'Failed to set display name' });
    }
});

/**
 * Check if a display name is available (not already taken)
 * GET /user/check-display-name-discord?name=SomeName
 * Requires: Authorization: Bearer <discord_access_token>
 */
app.get('/user/check-display-name-discord', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        // Validate token (ensures user is authenticated)
        const accessToken = authHeader.substring(7);
        await getDiscordUser(accessToken);

        if (!redis) {
            // Can't check without Redis, allow optimistically
            return res.json({ available: true });
        }

        const { name } = req.query;
        if (!name || typeof name !== 'string') {
            return res.status(400).json({ available: false, error: 'Name parameter is required' });
        }

        const trimmedName = name.trim().toLowerCase();
        if (trimmedName.length < 2 || trimmedName.length > 20) {
            return res.status(400).json({ available: false, error: 'Display name must be 2-20 characters' });
        }

        // Check the display name index (shared with Patreon users, auto-cleans orphans)
        const owner = await isDisplayNameTaken(trimmedName);

        if (owner) {
            return res.json({ available: false, error: 'This name is already taken' });
        }

        res.json({ available: true });
    } catch (error) {
        console.error('Check Discord display name error:', error.message);
        // On error, allow optimistically
        res.json({ available: true });
    }
});

/**
 * GET /user/profile-discord
 * Get Discord user's full profile (progression, achievements, stats)
 * Auto-links with Patreon account if same email is found
 * Requires: Authorization: Bearer <discord_access_token>
 */
app.get('/user/profile-discord', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);
        const user = await getDiscordUser(accessToken);

        if (!redis) {
            return res.json({ exists: false, user_id: user.id });
        }

        // FIRST: Check for unified user via discord_user index
        const unifiedUserId = await redis.get(`discord_user:${user.id}`);
        if (unifiedUserId) {
            const unifiedUserKey = `user:${unifiedUserId}`;
            const unifiedUserData = await redis.get(unifiedUserKey);
            if (unifiedUserData) {
                const unifiedUser = typeof unifiedUserData === 'string' ? JSON.parse(unifiedUserData) : unifiedUserData;
                console.log(`Found unified user for Discord ${user.id}: ${unifiedUserId} (Level ${unifiedUser.level})`);
                return res.json({
                    exists: true,
                    user_id: user.id,
                    discord_username: user.username,
                    unified_user_id: unifiedUserId,
                    profile: {
                        display_name: unifiedUser.display_name,
                        xp: unifiedUser.xp || 0,
                        level: unifiedUser.level || 1,
                        achievements: unifiedUser.achievements || [],
                        stats: unifiedUser.stats || {},
                        updated_at: unifiedUser.updated_at,
                        skill_points: unifiedUser.skill_points || 0,
                        unlocked_skills: unifiedUser.unlocked_skills || []
                    }
                });
            }
        }

        const discordProfileKey = `${DISCORD_PROFILE_KEY_PREFIX}${user.id}`;
        const existingProfile = await redis.get(discordProfileKey);

        // If Discord profile exists and has display name, return it
        if (existingProfile) {
            const profile = typeof existingProfile === 'string' ? JSON.parse(existingProfile) : existingProfile;
            if (profile.display_name) {
                return res.json({
                    exists: true,
                    user_id: user.id,
                    discord_username: user.username,
                    profile: {
                        display_name: profile.display_name,
                        xp: profile.xp || 0,
                        level: profile.level || 1,
                        achievements: profile.achievements || [],
                        stats: profile.stats || {},
                        updated_at: profile.updated_at
                    }
                });
            }
        }

        // No display name yet - try to auto-link via email
        if (user.email && user.verified) {
            const emailIndexKey = `email_index:${user.email.toLowerCase()}`;
            const patreonUserId = await redis.get(emailIndexKey);

            if (patreonUserId) {
                // Found a Patreon account with same email - get their display name
                const patreonProfileKey = `${PROFILE_KEY_PREFIX}${patreonUserId}`;
                const patreonProfileData = await redis.get(patreonProfileKey);

                if (patreonProfileData) {
                    const patreonProfile = typeof patreonProfileData === 'string'
                        ? JSON.parse(patreonProfileData)
                        : patreonProfileData;

                    if (patreonProfile.display_name) {
                        // Auto-link: Create/update Discord profile with Patreon's display name
                        const discordProfile = existingProfile
                            ? (typeof existingProfile === 'string' ? JSON.parse(existingProfile) : existingProfile)
                            : { discord_id: user.id, discord_username: user.username };

                        discordProfile.display_name = patreonProfile.display_name;
                        discordProfile.linked_patreon_id = patreonUserId;
                        discordProfile.auto_linked_at = new Date().toISOString();
                        discordProfile.updated_at = new Date().toISOString();

                        await redis.set(discordProfileKey, JSON.stringify(discordProfile));

                        // Also update the display_name_index to include Discord user
                        const indexKey = `display_name_index:${patreonProfile.display_name.toLowerCase()}`;
                        // Keep pointing to original Patreon user for consistency

                        console.log(`Auto-linked Discord user ${user.username} (${user.email}) to Patreon ${patreonUserId} with display name "${patreonProfile.display_name}"`);

                        return res.json({
                            exists: true,
                            user_id: user.id,
                            discord_username: user.username,
                            auto_linked: true,
                            linked_patreon_id: patreonUserId,
                            profile: {
                                display_name: patreonProfile.display_name,
                                xp: discordProfile.xp || patreonProfile.xp || 0,
                                level: discordProfile.level || patreonProfile.level || 1,
                                achievements: discordProfile.achievements || patreonProfile.achievements || [],
                                stats: discordProfile.stats || patreonProfile.stats || {},
                                updated_at: discordProfile.updated_at
                            }
                        });
                    }
                }
            }
        }

        // No auto-link possible - return profile without display name (client will prompt)
        if (existingProfile) {
            const profile = typeof existingProfile === 'string' ? JSON.parse(existingProfile) : existingProfile;
            return res.json({
                exists: true,
                user_id: user.id,
                discord_username: user.username,
                profile: {
                    display_name: null,
                    xp: profile.xp || 0,
                    level: profile.level || 1,
                    achievements: profile.achievements || [],
                    stats: profile.stats || {},
                    updated_at: profile.updated_at
                }
            });
        }

        return res.json({
            exists: false,
            user_id: user.id,
            discord_username: user.username
        });
    } catch (error) {
        console.error('Get Discord profile error:', error.message);
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

/**
 * POST /user/sync-discord
 * Sync Discord user's progression to cloud
 * Requires: Authorization: Bearer <discord_access_token>
 * Body: { xp, level, achievements[], stats{} }
 */
app.post('/user/sync-discord', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);
        const user = await getDiscordUser(accessToken);

        if (!redis) {
            return res.status(503).json({ error: 'Profile storage not available' });
        }

        const { xp, level, achievements, stats, allow_discord_dm, share_profile_picture, show_online_status, avatar_url } = req.body;

        // Validate input
        if (typeof level !== 'number' || level < 1) {
            return res.status(400).json({ error: 'Invalid level' });
        }

        const key = `${DISCORD_PROFILE_KEY_PREFIX}${user.id}`;
        const existingProfile = await redis.get(key);
        let profile = existingProfile
            ? (typeof existingProfile === 'string' ? JSON.parse(existingProfile) : existingProfile)
            : { discord_id: user.id, discord_username: user.username };

        // Ensure display_name is never null/empty - use discord_username as fallback
        // This prevents "" accounts from being created
        if (!profile.display_name || profile.display_name.trim() === '') {
            profile.display_name = user.username || user.global_name || `User_${user.id.slice(-6)}`;
            console.log(`Auto-assigned display_name "${profile.display_name}" for Discord user ${user.id}`);
        }

        // Update Discord DM opt-in if provided
        if (typeof allow_discord_dm === 'boolean') {
            profile.allow_discord_dm = allow_discord_dm;
        }

        // Update profile picture sharing opt-in if provided
        if (typeof share_profile_picture === 'boolean') {
            profile.share_profile_picture = share_profile_picture;
        }

        // Update online status visibility opt-in if provided
        if (typeof show_online_status === 'boolean') {
            profile.show_online_status = show_online_status;
        }

        // Update avatar URL if provided (from client's Discord auth)
        if (avatar_url) {
            profile.avatar_url = avatar_url;
        }

        // Update profile with new values (only accept higher values to prevent cheating)
        const newXp = typeof xp === 'number' ? xp : 0;
        const newLevel = level;

        // Only update if new values are higher (prevents syncing downward cheats)
        if (newLevel > (profile.level || 1) || (newLevel === (profile.level || 1) && newXp > (profile.xp || 0))) {
            profile.xp = newXp;
            profile.level = newLevel;
        }

        // Merge achievements (union - never remove)
        if (Array.isArray(achievements)) {
            const existingAchievements = new Set(profile.achievements || []);
            achievements.forEach(a => existingAchievements.add(a));
            profile.achievements = Array.from(existingAchievements);
        }

        // Merge stats (take higher values)
        if (stats && typeof stats === 'object') {
            profile.stats = profile.stats || {};
            for (const [key, value] of Object.entries(stats)) {
                if (typeof value === 'number') {
                    profile.stats[key] = Math.max(profile.stats[key] || 0, value);
                }
            }
        }

        profile.updated_at = new Date().toISOString();
        profile.last_sync = new Date().toISOString();

        await redis.set(key, JSON.stringify(profile));

        console.log(`Discord profile synced: user=${user.id}, level=${profile.level}, xp=${profile.xp}`);

        res.json({
            success: true,
            user_id: user.id,
            profile: {
                xp: profile.xp,
                level: profile.level,
                achievements: profile.achievements,
                stats: profile.stats
            }
        });
    } catch (error) {
        console.error('Discord profile sync error:', error.message);
        res.status(500).json({ error: 'Failed to sync profile' });
    }
});

/**
 * POST /user/heartbeat-discord
 * Keep Discord user's session alive
 * Requires: Authorization: Bearer <discord_access_token>
 */
app.post('/user/heartbeat-discord', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }

        const accessToken = authHeader.substring(7);
        const user = await getDiscordUser(accessToken);

        if (redis) {
            const now = new Date().toISOString();
            const key = `${DISCORD_PROFILE_KEY_PREFIX}${user.id}`;
            const existingProfile = await redis.get(key);
            if (existingProfile) {
                const profile = typeof existingProfile === 'string' ? JSON.parse(existingProfile) : existingProfile;
                profile.last_seen = now;
                profile.updated_at = now;
                // Update avatar if changed
                if (user.avatar && profile.avatar !== user.avatar) {
                    profile.avatar = user.avatar;
                }
                await redis.set(key, JSON.stringify(profile));
            } else {
                // Create a basic profile if none exists
                const newProfile = {
                    discord_user_id: user.id,
                    discord_username: user.username,
                    avatar: user.avatar || null,
                    xp: 0,
                    level: 1,
                    achievements: [],
                    stats: {},
                    created_at: now,
                    updated_at: now,
                    last_seen: now
                };
                await redis.set(key, JSON.stringify(newProfile));
                console.log(`Discord heartbeat created new profile for ${user.username} (${user.id})`);
            }

            // Also update unified user's last_seen if this Discord user is linked to one
            const unifiedId = await redis.get(`${DISCORD_USER_INDEX}${user.id}`);
            if (unifiedId) {
                const unifiedUserKey = `${UNIFIED_USER_PREFIX}${unifiedId}`;
                const unifiedUserData = await redis.get(unifiedUserKey);
                if (unifiedUserData) {
                    const unifiedUser = typeof unifiedUserData === 'string' ? JSON.parse(unifiedUserData) : unifiedUserData;
                    unifiedUser.last_seen = now;
                    unifiedUser.updated_at = now;
                    await redis.set(unifiedUserKey, JSON.stringify(unifiedUser));
                }
            }
        }

        res.json({ success: true, user_id: user.id });
    } catch (error) {
        console.error('Discord heartbeat error:', error.message);
        res.status(500).json({ error: 'Heartbeat failed' });
    }
});

// =============================================================================
// LEADERBOARD
// =============================================================================

// Leaderboard cache - stores deduplicated profiles to avoid expensive Redis scans
// Cache is refreshed every 2 minutes, reducing reads by ~99%
let leaderboardProfilesCache = null;
let leaderboardCacheTime = 0;
const LEADERBOARD_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

/**
 * Helper function to fetch and deduplicate all profiles from Redis
 * This is the expensive operation we want to cache
 */
async function fetchAllProfiles() {
    const profiles = [];

    // Helper to process profile keys
    const processProfiles = async (pattern) => {
        let cursor = "0";
        do {
            const result = await redis.scan(cursor, { match: pattern, count: 100 });
            cursor = String(result[0]);
            const keys = result[1] || [];

            for (const key of keys) {
                try {
                    const data = await redis.get(key);
                    if (data) {
                        const profile = typeof data === 'string' ? JSON.parse(data) : data;
                        // Privacy: if display_name matches patron_name, treat as unset
                        let profileDisplayName = profile.display_name || null;
                        if (profileDisplayName && profile.patron_name &&
                            profileDisplayName.toLowerCase().trim() === profile.patron_name.toLowerCase().trim()) {
                            profileDisplayName = null;
                        }
                        // Only include users with display_name set
                        if (profileDisplayName) {
                            // Check if user is online (updated within last minute)
                            const lastSeen = profile.last_seen || profile.updated_at;
                            const lastSeenDate = lastSeen ? new Date(lastSeen) : null;
                            const actuallyOnline = lastSeenDate && (Date.now() - lastSeenDate.getTime()) < 60 * 1000;
                            // Respect show_online_status setting (default true if not set)
                            const isOnline = actuallyOnline && profile.show_online_status !== false;

                            // Check if user is an active Patreon supporter:
                            // - Has active subscription flag (set during validation)
                            // - OR is whitelisted
                            // - OR has a paid tier > 0
                            const isPatreon = profile.patreon_is_active ||
                                              profile.patreon_is_whitelisted ||
                                              (profile.patreon_tier && profile.patreon_tier > 0);

                            // Get Discord ID if user has opted in for DMs
                            // For Discord profiles, the ID is in the key (discord_profile:ID) or profile.discord_id
                            let discordId = null;
                            if (profile.allow_discord_dm) {
                                if (profile.discord_id) {
                                    discordId = profile.discord_id;
                                } else if (key.startsWith('discord_profile:')) {
                                    // Extract ID from key for Discord profiles
                                    discordId = key.replace('discord_profile:', '');
                                }
                            }

                            profiles.push({
                                display_name: profileDisplayName,
                                level: profile.level || 1,
                                xp: profile.xp || 0,
                                total_bubbles_popped: profile.stats?.total_bubbles_popped || 0,
                                total_flashes: profile.stats?.total_flashes || 0,
                                total_video_minutes: Math.round((profile.stats?.total_video_minutes || 0) * 10) / 10,
                                total_lock_cards_completed: profile.stats?.total_lock_cards_completed || 0,
                                achievements_count: profile.achievements?.length || 0,
                                is_online: isOnline,
                                is_patreon: !!isPatreon,
                                patreon_tier: profile.patreon_tier || 0,
                                discord_id: discordId,
                                is_season0_og: profile.is_season0_og || false,
                                last_seen: profile.last_seen || profile.updated_at, // Store for online recalc
                                show_online_status: profile.show_online_status !== false // Store for online recalc
                            });
                        }
                    }
                } catch (parseError) {
                    console.error(`Error parsing profile ${key}:`, parseError.message);
                }
            }
        } while (cursor !== "0");
    };

    // Scan all profile types: Patreon, Discord, and unified users
    await processProfiles('profile:*');
    await processProfiles('discord_profile:*');
    await processProfiles('user:*');

    // Deduplicate by display_name - keep the entry with highest level (then XP as tiebreaker)
    // Also merge is_online and discord_id from duplicates
    const deduped = [];
    const seenNames = new Map(); // display_name (lowercase) -> index in deduped array
    for (const profile of profiles) {
        const nameKey = profile.display_name.toLowerCase();
        if (seenNames.has(nameKey)) {
            // Compare with existing entry - keep the one with higher level/XP
            const existingIdx = seenNames.get(nameKey);
            const existing = deduped[existingIdx];
            if (profile.level > existing.level ||
                (profile.level === existing.level && profile.xp > existing.xp)) {
                // Replace with better entry, but merge fields from existing
                if (!profile.discord_id && existing.discord_id) {
                    profile.discord_id = existing.discord_id;
                }
                // If existing was online, preserve that (Discord heartbeat may have updated different profile)
                if (existing.is_online && !profile.is_online) {
                    profile.is_online = true;
                }
                // Merge OG status from either entry
                if (existing.is_season0_og && !profile.is_season0_og) {
                    profile.is_season0_og = true;
                }
                deduped[existingIdx] = profile;
            } else {
                // Keep existing but merge fields from duplicate
                if (!existing.discord_id && profile.discord_id) {
                    existing.discord_id = profile.discord_id;
                }
                // If duplicate is online, the user IS online (Discord heartbeat updated that profile)
                if (profile.is_online && !existing.is_online) {
                    existing.is_online = true;
                }
                // Merge OG status from either entry
                if (profile.is_season0_og && !existing.is_season0_og) {
                    existing.is_season0_og = true;
                }
            }
        } else {
            seenNames.set(nameKey, deduped.length);
            deduped.push(profile);
        }
    }

    return deduped;
}

/**
 * GET /leaderboard
 * Returns top users sorted by specified field (public, no auth required)
 * Query: ?sort_by=xp|level|total_bubbles_popped|total_flashes|total_video_minutes|total_lock_cards_completed|is_patreon
 * Query: ?limit=N (default 200, max 1000)
 */
app.get('/leaderboard', async (req, res) => {
    try {
        // Temporarily disabled during new leaderboard transition (2026-02-06)
        return res.status(503).json({ error: 'Leaderboard is temporarily unavailable while we upgrade to the new system. Check back soon!' });

        if (!redis) {
            return res.status(503).json({ error: 'Leaderboard not available' });
        }

        const sortBy = req.query.sort_by || 'xp';
        const validSortFields = ['xp', 'level', 'total_bubbles_popped', 'total_flashes',
                                  'total_video_minutes', 'total_lock_cards_completed', 'is_patreon'];

        if (!validSortFields.includes(sortBy)) {
            return res.status(400).json({ error: 'Invalid sort_by field' });
        }

        // Parse limit parameter (default 200, max 1000)
        let limit = parseInt(req.query.limit) || 200;
        limit = Math.min(Math.max(limit, 1), 1000);

        // Check if we have a fresh cache
        const now = Date.now();
        if (!leaderboardProfilesCache || (now - leaderboardCacheTime) > LEADERBOARD_CACHE_TTL) {
            // Cache is stale or doesn't exist - fetch fresh data
            console.log('Leaderboard cache miss - fetching from Redis');
            leaderboardProfilesCache = await fetchAllProfiles();
            leaderboardCacheTime = now;
        } else {
            console.log('Leaderboard cache hit - using cached data');
        }

        // Work with a copy for sorting (don't modify the cache)
        // Use cached online status as-is - it's accurate within the 2-minute cache window
        const deduped = [...leaderboardProfilesCache];

        // Sort by requested field (descending)
        deduped.sort((a, b) => {
            if (sortBy === 'is_patreon') {
                // Sort by Patreon status first, then by level as secondary
                const aPat = a.is_patreon ? 1 : 0;
                const bPat = b.is_patreon ? 1 : 0;
                if (bPat !== aPat) return bPat - aPat;
                return b.level - a.level; // Secondary sort by level
            }
            const aVal = sortBy === 'xp' ? a.xp :
                         sortBy === 'level' ? a.level :
                         a[sortBy] || 0;
            const bVal = sortBy === 'xp' ? b.xp :
                         sortBy === 'level' ? b.level :
                         b[sortBy] || 0;
            return bVal - aVal;
        });

        // Count online users
        const onlineCount = deduped.filter(p => p.is_online).length;

        // Add ranks and apply limit
        const ranked = deduped.slice(0, limit).map((p, i) => ({
            rank: i + 1,
            ...p
        }));

        res.json({
            entries: ranked,
            total_users: deduped.length,
            online_users: onlineCount,
            sort_by: sortBy,
            fetched_at: new Date().toISOString()
        });
    } catch (error) {
        console.error('Leaderboard error:', error.message);
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
});

/**
 * GET /user/lookup
 * Look up a specific user's profile by display_name (for profile viewer)
 * Returns fresh is_online status and avatar info
 * Query: ?display_name=XXX
 */
app.get('/user/lookup', async (req, res) => {
    try {
        if (!redis) {
            return res.status(503).json({ error: 'Service not available' });
        }

        const displayName = req.query.display_name;
        if (!displayName) {
            return res.status(400).json({ error: 'display_name query parameter required' });
        }

        // Find user by display_name index
        const indexKey = `display_name_index:${displayName.toLowerCase()}`;
        const userId = await redis.get(indexKey);

        if (!userId) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Try to get profile data from multiple possible sources
        let profile = null;
        let patreonProfile = null;
        let discordAvatar = null;
        let discordId = null;

        // Check unified user first
        if (userId.startsWith('u_')) {
            const userData = await redis.get(`user:${userId}`);
            if (userData) {
                profile = typeof userData === 'string' ? JSON.parse(userData) : userData;
                discordId = profile.discord_id;

                // Also load Patreon profile for additional settings (share_profile_picture, etc)
                // since /user/sync stores to profile:XXX, not user:u_XXX
                if (profile.patreon_id) {
                    const patreonData = await redis.get(`profile:${profile.patreon_id}`);
                    if (patreonData) {
                        patreonProfile = typeof patreonData === 'string' ? JSON.parse(patreonData) : patreonData;
                    }
                }
            }
        }

        // Check Patreon profile (for non-unified users)
        if (!profile) {
            const patreonData = await redis.get(`profile:${userId}`);
            if (patreonData) {
                profile = typeof patreonData === 'string' ? JSON.parse(patreonData) : patreonData;
                patreonProfile = profile; // Same profile in this case
            }
        }

        // Check Discord profile
        if (!profile && userId.startsWith('discord_')) {
            const discordUserId = userId.replace('discord_', '');
            const discordData = await redis.get(`discord_profile:${discordUserId}`);
            if (discordData) {
                profile = typeof discordData === 'string' ? JSON.parse(discordData) : discordData;
                discordId = discordUserId;
            }
        }

        if (!profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        // Get Discord profile data (for avatar and fresh last_seen)
        // Check discord_id from all profile sources
        if (!discordId) {
            discordId = profile.discord_id || patreonProfile?.discord_id;
        }

        let discordProfile = null;
        if (discordId) {
            const discordProfileKey = `discord_profile:${discordId}`;
            const discordProfileData = await redis.get(discordProfileKey);
            if (discordProfileData) {
                discordProfile = typeof discordProfileData === 'string' ? JSON.parse(discordProfileData) : discordProfileData;
                if (discordProfile.avatar) {
                    // Discord avatar URL format
                    const ext = discordProfile.avatar.startsWith('a_') ? 'gif' : 'png';
                    discordAvatar = `https://cdn.discordapp.com/avatars/${discordId}/${discordProfile.avatar}.${ext}?size=256`;
                }
            }
        }

        // ALSO check if there's a discord_profile with matching display_name but no discord_id link
        // This matches how leaderboard merges is_online from all sources
        if (!discordProfile) {
            // Scan discord profiles to find one with matching display_name
            let cursor = "0";
            do {
                const result = await redis.scan(cursor, { match: 'discord_profile:*', count: 100 });
                cursor = String(result[0]);
                const keys = result[1] || [];

                for (const key of keys) {
                    try {
                        const data = await redis.get(key);
                        if (data) {
                            const dp = typeof data === 'string' ? JSON.parse(data) : data;
                            if (dp.display_name && dp.display_name.toLowerCase() === displayName.toLowerCase()) {
                                discordProfile = dp;
                                discordId = key.replace('discord_profile:', '');
                                if (dp.avatar) {
                                    const ext = dp.avatar.startsWith('a_') ? 'gif' : 'png';
                                    discordAvatar = `https://cdn.discordapp.com/avatars/${discordId}/${dp.avatar}.${ext}?size=256`;
                                }
                                break;
                            }
                        }
                    } catch (e) {
                        // Ignore parse errors
                    }
                }
                if (discordProfile) break;
            } while (cursor !== "0");
        }

        // Calculate fresh online status - check ALL sources and OR them together
        // (matching leaderboard's merge logic: if ANY source shows online, user is online)
        const now = Date.now();
        const ONLINE_THRESHOLD = 60 * 1000; // 60 seconds

        // Check main profile
        const mainLastSeen = profile.last_seen || profile.updated_at;
        const mainLastSeenDate = mainLastSeen ? new Date(mainLastSeen) : null;
        const mainIsOnline = mainLastSeenDate && (now - mainLastSeenDate.getTime()) < ONLINE_THRESHOLD;

        // Check discord profile
        const discordLastSeen = discordProfile?.last_seen;
        const discordLastSeenDate = discordLastSeen ? new Date(discordLastSeen) : null;
        const discordIsOnline = discordLastSeenDate && (now - discordLastSeenDate.getTime()) < ONLINE_THRESHOLD;

        // Check patreon profile (if separate from main)
        const patreonLastSeen = patreonProfile?.last_seen || patreonProfile?.updated_at;
        const patreonLastSeenDate = patreonLastSeen ? new Date(patreonLastSeen) : null;
        const patreonIsOnline = patreonLastSeenDate && (now - patreonLastSeenDate.getTime()) < ONLINE_THRESHOLD;

        // User is online if ANY source shows them as online
        const actuallyOnline = mainIsOnline || discordIsOnline || patreonIsOnline;
        // Respect show_online_status setting from any profile source (default true if not set)
        const showOnlineStatus = profile.show_online_status !== false &&
                                  patreonProfile?.show_online_status !== false &&
                                  discordProfile?.show_online_status !== false;
        const isOnline = actuallyOnline && showOnlineStatus;

        // For last_seen display, use the most recent timestamp
        let lastSeen = mainLastSeen;
        if (discordLastSeenDate && (!mainLastSeenDate || discordLastSeenDate > mainLastSeenDate)) {
            lastSeen = discordLastSeen;
        }
        if (patreonLastSeenDate && (!lastSeen || patreonLastSeenDate > new Date(lastSeen))) {
            lastSeen = patreonLastSeen;
        }

        // Check Patreon status (from either main profile or patreon profile)
        const isPatreon = profile.patreon_is_active || patreonProfile?.patreon_is_active ||
                          profile.patreon_is_whitelisted || patreonProfile?.patreon_is_whitelisted ||
                          (profile.patreon_tier && profile.patreon_tier > 0) ||
                          (patreonProfile?.patreon_tier && patreonProfile.patreon_tier > 0);

        // Check share_profile_picture - V2 user settings take priority
        // If V2 user explicitly set it to false, respect that (don't fall back to old profiles)
        // Only fall back to old profiles if V2 user hasn't set it (undefined)
        let shareProfilePicture;
        if (typeof profile.share_profile_picture === 'boolean') {
            // V2 user has explicitly set this setting
            shareProfilePicture = profile.share_profile_picture;
        } else {
            // Fall back to old profile settings
            shareProfilePicture = patreonProfile?.share_profile_picture || discordProfile?.share_profile_picture;
        }

        // Check allow_discord_dm from all profile sources
        const allowDiscordDm = profile.allow_discord_dm || patreonProfile?.allow_discord_dm || discordProfile?.allow_discord_dm;

        res.json({
            display_name: profile.display_name,
            level: profile.level || 1,
            xp: profile.xp || 0,
            total_bubbles_popped: profile.stats?.total_bubbles_popped || 0,
            total_flashes: profile.stats?.total_flashes || 0,
            total_video_minutes: Math.round((profile.stats?.total_video_minutes || 0) * 10) / 10,
            total_lock_cards_completed: profile.stats?.total_lock_cards_completed || 0,
            achievements_count: profile.achievements?.length || 0,
            achievements: profile.achievements || [],
            is_online: isOnline,
            is_patreon: !!isPatreon,
            patreon_tier: profile.patreon_tier || patreonProfile?.patreon_tier || 0,
            discord_id: (allowDiscordDm && discordId) ? discordId : null,
            // Use discordAvatar (from discord profile hash) or stored avatar_url (from sync) as fallback
            avatar_url: shareProfilePicture ? (discordAvatar || profile.avatar_url || patreonProfile?.avatar_url || discordProfile?.avatar_url || null) : null,
            last_seen: lastSeen
        });
    } catch (error) {
        console.error('User lookup error:', error.message);
        res.status(500).json({ error: 'Failed to look up user' });
    }
});

// =============================================================================
// ADMIN ENDPOINTS (for testing/moderation)
// =============================================================================

/**
 * Calculate XP required for a single level (matching client-side formula)
 */
function getXPForLevel(level) {
    if (level <= 80) {
        return Math.round(800 + (level - 1) * (1700 / 79));
    } else if (level <= 100) {
        return Math.round(2500 + (level - 80) * (1500 / 20));
    } else if (level <= 125) {
        return Math.round(4000 + (level - 100) * (2000 / 25));
    } else if (level <= 150) {
        return Math.round(6000 + (level - 125) * (4000 / 25));
    } else {
        return Math.round(10000 * Math.pow(1.03, level - 150));
    }
}

/**
 * Calculate cumulative XP to reach a given level
 */
function getCumulativeXPForLevel(level) {
    let total = 0;
    for (let i = 1; i <= level; i++) {
        total += getXPForLevel(i);
    }
    return total;
}

/**
 * POST /admin/set-level
 * Set a user's level (admin only - for testing)
 * Body: { display_name: string, level: number, admin_token: string, fix_xp?: boolean }
 */
app.post('/admin/set-level', async (req, res) => {
    try {
        const { display_name, level, admin_token, fix_xp } = req.body;

        // Admin token check
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!display_name || typeof display_name !== 'string') {
            return res.status(400).json({ error: 'display_name is required' });
        }

        if (typeof level !== 'number' || level < 1 || level > 999) {
            return res.status(400).json({ error: 'level must be a number between 1 and 999' });
        }

        if (!redis) {
            return res.status(503).json({ error: 'Redis not available' });
        }

        // Scan for profile by display_name (works for both Patreon and Discord profiles)
        const targetName = display_name.toLowerCase();
        let foundKey = null;
        let foundProfile = null;

        const scanForProfile = async (pattern) => {
            let cursor = "0";
            do {
                const result = await redis.scan(cursor, { match: pattern, count: 100 });
                cursor = String(result[0]);
                const keys = result[1] || [];

                for (const key of keys) {
                    try {
                        const data = await redis.get(key);
                        if (data) {
                            const profile = typeof data === 'string' ? JSON.parse(data) : data;
                            if (profile.display_name && profile.display_name.toLowerCase() === targetName) {
                                foundKey = key;
                                foundProfile = profile;
                                return true;
                            }
                        }
                    } catch (e) { /* ignore parse errors */ }
                }
            } while (cursor !== "0");
            return false;
        };

        // Check V2 user:* keys FIRST (these are the authoritative records)
        await scanForProfile('user:*');
        if (!foundKey) await scanForProfile('profile:*');
        if (!foundKey) await scanForProfile('discord_profile:*');

        // If no profile found, check if user exists by display_name index and create profile
        if (!foundKey) {
            const indexKey = `display_name_index:${targetName}`;
            const unifiedId = await redis.get(indexKey);

            if (unifiedId) {
                // User index exists but profile is missing - recreate it
                const userKey = `user:${unifiedId}`;
                const userData = await redis.get(userKey);

                if (userData) {
                    const user = typeof userData === 'string' ? JSON.parse(userData) : userData;

                    // Determine profile key based on account type
                    if (user.discord_id) {
                        foundKey = `discord_profile:${user.discord_id}`;
                    } else if (user.patreon_id) {
                        foundKey = `profile:${user.patreon_id}`;
                    } else {
                        foundKey = `profile:${unifiedId}`;
                    }

                    // Create a new profile
                    foundProfile = {
                        unified_id: unifiedId,
                        display_name: display_name,
                        level: 1,
                        xp: 0,
                        achievements: [],
                        stats: {},
                        patreon_id: user.patreon_id || null,
                        discord_id: user.discord_id || null,
                        created_at: new Date().toISOString(),
                        recreated_from_backup: true
                    };

                    console.log(`[ADMIN] Creating missing profile for "${display_name}" at ${foundKey}`);
                }
            }
        }

        if (!foundKey) {
            return res.status(404).json({ error: `No profile found with display_name "${display_name}"` });
        }

        const oldLevel = foundProfile.level || 1;
        const oldXp = foundProfile.xp || 0;
        foundProfile.level = level;
        foundProfile.updated_at = new Date().toISOString();

        // Optionally fix XP to match the level
        let newXp = oldXp;
        if (fix_xp) {
            newXp = getCumulativeXPForLevel(level - 1); // XP to reach this level (not including current level progress)
            foundProfile.xp = newXp;
        }

        // For V2 user:* records, also update leaderboard and set level_reset flag
        if (foundKey.startsWith('user:')) {
            foundProfile.highest_level_ever = Math.max(foundProfile.highest_level_ever || 0, level);
            foundProfile.level_reset_at = new Date().toISOString(); // Prevent client from pushing old cached level back
            delete foundProfile.level_reset; // Clean up old boolean flag
            foundProfile.unlocks = calculateUnlocks(level);

            // Update leaderboard
            const season = getCurrentSeason();
            const leaderboardXp = fix_xp ? newXp : (foundProfile.xp || 0);
            await redis.zadd(`leaderboard:${season}`, { score: leaderboardXp, member: foundKey.replace('user:', '') });
        }

        await redis.set(foundKey, JSON.stringify(foundProfile));

        console.log(`[ADMIN] Set level for "${display_name}" (${foundKey}): ${oldLevel} -> ${level}${fix_xp ? `, XP: ${oldXp} -> ${newXp}` : ''}`);

        res.json({
            success: true,
            display_name: display_name,
            profile_key: foundKey,
            old_level: oldLevel,
            new_level: level,
            old_xp: oldXp,
            new_xp: fix_xp ? newXp : oldXp,
            xp_fixed: !!fix_xp
        });
    } catch (error) {
        console.error('Admin set-level error:', error.message);
        res.status(500).json({ error: 'Failed to set level' });
    }
});

/**
 * POST /admin/reset-progress
 * Reset a user's progress to level 1, 0 XP, clear achievements and stats (admin only)
 * Body: { display_name: string, admin_token: string }
 */
app.post('/admin/reset-progress', async (req, res) => {
    try {
        const { display_name, admin_token } = req.body;

        // Admin token check
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!display_name || typeof display_name !== 'string') {
            return res.status(400).json({ error: 'display_name is required' });
        }

        if (!redis) {
            return res.status(503).json({ error: 'Redis not available' });
        }

        // Scan for profile by display_name (works for both Patreon and Discord profiles)
        const targetName = display_name.toLowerCase();
        let profileKey = null;
        let oldProfile = null;

        const scanForProfile = async (pattern) => {
            let cursor = "0";
            do {
                const result = await redis.scan(cursor, { match: pattern, count: 100 });
                cursor = String(result[0]);
                const keys = result[1] || [];

                for (const key of keys) {
                    try {
                        const data = await redis.get(key);
                        if (data) {
                            const profile = typeof data === 'string' ? JSON.parse(data) : data;
                            if (profile.display_name && profile.display_name.toLowerCase() === targetName) {
                                profileKey = key;
                                oldProfile = profile;
                                return true;
                            }
                        }
                    } catch (e) { /* ignore parse errors */ }
                }
            } while (cursor !== "0");
            return false;
        };

        await scanForProfile('profile:*');
        if (!profileKey) await scanForProfile('discord_profile:*');

        if (!profileKey) {
            return res.status(404).json({ error: `No profile found with display_name "${display_name}"` });
        }

        // Reset profile but keep identity info
        const resetProfile = {
            xp: 0,
            level: 1,
            achievements: [],
            stats: {
                completed_sessions: 0,
                longest_session_minutes: 0,
                total_flashes: 0,
                consecutive_days: 0,
                total_bubbles_popped: 0,
                total_video_minutes: 0,
                total_lock_cards_completed: 0
            },
            last_session: null,
            updated_at: new Date().toISOString(),
            patron_name: oldProfile.patron_name,
            display_name: oldProfile.display_name,
            display_name_set_at: oldProfile.display_name_set_at
        };

        await redis.set(profileKey, JSON.stringify(resetProfile));

        console.log(`[ADMIN] Reset progress for "${display_name}" (${profileKey}): Level ${oldProfile.level} -> 1, XP ${oldProfile.xp} -> 0`);

        res.json({
            success: true,
            display_name: display_name,
            profile_key: profileKey,
            old_level: oldProfile.level,
            old_xp: oldProfile.xp,
            message: 'Progress reset to level 1, 0 XP, cleared achievements and stats'
        });
    } catch (error) {
        console.error('Admin reset-progress error:', error.message);
        res.status(500).json({ error: 'Failed to reset progress' });
    }
});

/**
 * GET /admin/user-info
 * Get user info by display_name (admin only)
 * Query: ?display_name=xxx&admin_token=xxx
 */
app.get('/admin/user-info', async (req, res) => {
    try {
        const { display_name, admin_token } = req.query;

        // Admin token check
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!display_name) {
            return res.status(400).json({ error: 'display_name query param required' });
        }

        if (!redis) {
            return res.status(503).json({ error: 'Redis not available' });
        }

        // Find user by display_name index
        const indexKey = `display_name_index:${display_name.toLowerCase()}`;
        const userId = await redis.get(indexKey);

        if (!userId) {
            return res.status(404).json({ error: `User with display_name "${display_name}" not found` });
        }

        // Load profile - try unified user key first, then Patreon, then Discord
        let profileKey = `user:${userId}`;
        let profile = await redis.get(profileKey);

        // Try legacy Patreon profile key
        if (!profile) {
            profileKey = `${PROFILE_KEY_PREFIX}${userId}`;
            profile = await redis.get(profileKey);
        }

        // If not found and userId starts with discord_, try Discord profile key
        if (!profile && userId.startsWith('discord_')) {
            const discordId = userId.replace('discord_', '');
            profileKey = `${DISCORD_PROFILE_KEY_PREFIX}${discordId}`;
            profile = await redis.get(profileKey);
        }

        if (!profile) {
            return res.status(404).json({ error: `Profile for user ${userId} not found` });
        }

        const profileData = typeof profile === 'string' ? JSON.parse(profile) : profile;

        res.json({
            user_id: userId,
            profile_key: profileKey,
            profile: profileData
        });
    } catch (error) {
        console.error('Admin user-info error:', error.message);
        res.status(500).json({ error: 'Failed to get user info' });
    }
});

/**
 * POST /admin/reset-bandwidth
 * Reset bandwidth usage for a user (admin only)
 * Body: { display_name: string, admin_token: string, bytes_to_subtract?: number }
 * If bytes_to_subtract not provided, resets to 0
 */
app.post('/admin/reset-bandwidth', async (req, res) => {
    try {
        const { display_name, admin_token, bytes_to_subtract } = req.body;

        // Admin token check
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!display_name || typeof display_name !== 'string') {
            return res.status(400).json({ error: 'display_name is required' });
        }

        if (!redis) {
            return res.status(503).json({ error: 'Redis not available' });
        }

        // Find user by display_name index
        const indexKey = `display_name_index:${display_name.toLowerCase()}`;
        const userId = await redis.get(indexKey);

        if (!userId) {
            return res.status(404).json({ error: `User with display_name "${display_name}" not found` });
        }

        const monthKey = getMonthKey();
        const bandwidthKey = `${BANDWIDTH_LIMIT.KEY_PREFIX}${userId}:${monthKey}`;

        // Get current bandwidth
        const currentBytes = parseInt(await redis.get(bandwidthKey) || '0', 10);

        let newBytes;
        if (bytes_to_subtract && typeof bytes_to_subtract === 'number') {
            // Subtract specific amount
            newBytes = Math.max(0, currentBytes - bytes_to_subtract);
            await redis.set(bandwidthKey, newBytes);
        } else {
            // Reset to 0
            newBytes = 0;
            await redis.del(bandwidthKey);
        }

        console.log(`[ADMIN] Reset bandwidth for "${display_name}" (${userId}): ${formatBytes(currentBytes)} -> ${formatBytes(newBytes)}`);

        res.json({
            success: true,
            display_name: display_name,
            user_id: userId,
            old_bytes: currentBytes,
            new_bytes: newBytes,
            old_display: formatBytes(currentBytes),
            new_display: formatBytes(newBytes),
            message: `Bandwidth reset from ${formatBytes(currentBytes)} to ${formatBytes(newBytes)}`
        });
    } catch (error) {
        console.error('Admin reset-bandwidth error:', error.message);
        res.status(500).json({ error: 'Failed to reset bandwidth' });
    }
});

/**
 * POST /admin/cleanup-index
 * Removes orphaned display_name_index entries (where the profile no longer exists)
 * Body: { display_name: string, admin_token: string }
 */
app.post('/admin/cleanup-index', async (req, res) => {
    try {
        const { display_name, admin_token } = req.body;

        // Admin token check
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!display_name || typeof display_name !== 'string') {
            return res.status(400).json({ error: 'display_name is required' });
        }

        if (!redis) {
            return res.status(503).json({ error: 'Redis not available' });
        }

        const indexKey = `display_name_index:${display_name.toLowerCase()}`;
        const userId = await redis.get(indexKey);

        if (!userId) {
            return res.status(404).json({ error: `No index found for display_name "${display_name}"` });
        }

        // Check if the profile actually exists
        const profileKey = `profile:${userId}`;
        const discordProfileKey = `discord_profile:${userId}`;
        const profile = await redis.get(profileKey) || await redis.get(discordProfileKey);

        if (profile) {
            return res.status(400).json({
                error: `Profile for "${display_name}" still exists - not an orphan`,
                user_id: userId
            });
        }

        // Profile doesn't exist - delete the orphaned index
        await redis.del(indexKey);

        console.log(`[ADMIN] Cleaned up orphaned index for "${display_name}" (was pointing to ${userId})`);

        res.json({
            success: true,
            display_name: display_name,
            deleted_index: indexKey,
            was_pointing_to: userId,
            message: `Orphaned index for "${display_name}" has been removed`
        });
    } catch (error) {
        console.error('Admin cleanup-index error:', error.message);
        res.status(500).json({ error: 'Failed to cleanup index' });
    }
});

/**
 * GET /admin/scan-orphaned-indexes
 * Scans all display_name_index:* keys and checks if the referenced user/profile still exists.
 * Returns a list of orphaned entries (name -> stale ID) without deleting anything.
 * Query: ?admin_token=xxx
 */
app.get('/admin/scan-orphaned-indexes', async (req, res) => {
    try {
        const { admin_token } = req.query;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const orphaned = [];
        const valid = [];
        let cursor = "0";

        do {
            const result = await redis.scan(cursor, { match: 'display_name_index:*', count: 100 });
            cursor = String(result[0]);
            for (const key of (result[1] || [])) {
                const displayName = key.replace('display_name_index:', '');
                const targetId = await redis.get(key);
                if (!targetId) {
                    orphaned.push({ display_name: displayName, points_to: null, reason: 'index value is null' });
                    continue;
                }

                // Check if target exists as user:*, profile:*, or discord_profile:*
                const userExists = await redis.get(`user:${targetId}`);
                const profileExists = !userExists ? await redis.get(`profile:${targetId}`) : null;
                const discordProfileExists = (!userExists && !profileExists) ? await redis.get(`discord_profile:${targetId}`) : null;

                if (userExists || profileExists || discordProfileExists) {
                    valid.push({ display_name: displayName, points_to: targetId });
                } else {
                    orphaned.push({ display_name: displayName, points_to: targetId, reason: 'target record does not exist' });
                }
            }
        } while (cursor !== "0");

        res.json({
            success: true,
            total_indexes: orphaned.length + valid.length,
            valid_count: valid.length,
            orphaned_count: orphaned.length,
            orphaned
        });
    } catch (error) {
        console.error('Scan orphaned indexes error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /admin/fix-display-name
 * Set or fix display_name for a user by their Discord ID or Patreon ID
 * Also recreates the index and applies whitelist if applicable
 * Body: { discord_id?: string, patreon_id?: string, new_display_name: string, admin_token: string }
 */
app.post('/admin/fix-display-name', async (req, res) => {
    try {
        const { discord_id, patreon_id, new_display_name, admin_token } = req.body;

        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!new_display_name || typeof new_display_name !== 'string') {
            return res.status(400).json({ error: 'new_display_name is required' });
        }

        if (!discord_id && !patreon_id) {
            return res.status(400).json({ error: 'Either discord_id or patreon_id is required' });
        }

        if (!redis) {
            return res.status(503).json({ error: 'Redis not available' });
        }

        const trimmedName = new_display_name.trim();
        if (trimmedName.length < 2 || trimmedName.length > 20) {
            return res.status(400).json({ error: 'Display name must be 2-20 characters' });
        }

        // Check if new display_name is already taken by someone else
        const newIndexKey = `display_name_index:${trimmedName.toLowerCase()}`;
        const existingOwner = await redis.get(newIndexKey);

        // Determine user ID and profile key
        let userId, profileKey, profile;

        if (discord_id) {
            userId = `discord_${discord_id}`;
            profileKey = `discord_profile:${discord_id}`;
        } else {
            userId = patreon_id;
            profileKey = `profile:${patreon_id}`;
        }

        // Check if name is taken by a different user
        if (existingOwner && existingOwner !== userId) {
            return res.status(400).json({
                error: 'Display name already taken by another user',
                taken_by: existingOwner
            });
        }

        // Load existing profile
        const profileData = await redis.get(profileKey);
        if (!profileData) {
            return res.status(404).json({
                error: 'Profile not found',
                profile_key: profileKey
            });
        }

        profile = typeof profileData === 'string' ? JSON.parse(profileData) : profileData;
        const oldDisplayName = profile.display_name;

        // If they had an old display_name, remove the old index
        if (oldDisplayName && oldDisplayName.toLowerCase() !== trimmedName.toLowerCase()) {
            const oldIndexKey = `display_name_index:${oldDisplayName.toLowerCase()}`;
            await redis.del(oldIndexKey);
            console.log(`[ADMIN] Removed old index: ${oldIndexKey}`);
        }

        // Update profile with new display_name
        profile.display_name = trimmedName;
        profile.display_name_set_at = profile.display_name_set_at || new Date().toISOString();
        profile.display_name_fixed_at = new Date().toISOString();
        profile.updated_at = new Date().toISOString();

        // Check whitelist and update status
        const whitelistedByDisplayName = isWhitelisted(profile.email, profile.patron_name, trimmedName);
        if (whitelistedByDisplayName) {
            profile.patreon_is_whitelisted = true;
            profile.patreon_tier = Math.max(profile.patreon_tier || 0, 1);
            console.log(`[ADMIN] User ${userId} whitelisted by display_name: "${trimmedName}"`);
        }

        // Save profile and create new index
        await redis.set(profileKey, JSON.stringify(profile));
        await redis.set(newIndexKey, userId);

        console.log(`[ADMIN] Fixed display_name for ${userId}: "${oldDisplayName || '(none)'}" -> "${trimmedName}"`);

        res.json({
            success: true,
            user_id: userId,
            profile_key: profileKey,
            old_display_name: oldDisplayName || null,
            new_display_name: trimmedName,
            is_whitelisted: whitelistedByDisplayName || profile.patreon_is_whitelisted || false,
            profile: profile
        });
    } catch (error) {
        console.error('Admin fix-display-name error:', error.message);
        res.status(500).json({ error: 'Failed to fix display name' });
    }
});

/**
 * POST /admin/fix-patreon-tier
 * Fixes patreon_tier for whitelisted users who have tier 0
 * Body: { display_name: string, admin_token: string, tier?: number }
 */
app.post('/admin/fix-patreon-tier', async (req, res) => {
    try {
        const { display_name, admin_token, tier } = req.body;

        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!display_name || typeof display_name !== 'string') {
            return res.status(400).json({ error: 'display_name is required' });
        }

        if (!redis) {
            return res.status(503).json({ error: 'Redis not available' });
        }

        // Find user by display_name_index
        const normalizedName = display_name.toLowerCase().trim();
        const unifiedId = await redis.get(`display_name_index:${normalizedName}`);

        if (!unifiedId) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userData = await redis.get(`user:${unifiedId}`);
        if (!userData) {
            return res.status(404).json({ error: 'User data not found' });
        }

        const user = typeof userData === 'string' ? JSON.parse(userData) : userData;
        const oldTier = user.patreon_tier || 0;

        // Check if user is whitelisted
        const isWhitelistedUser = isWhitelisted(user.email, user.patron_name, user.display_name);

        // Set tier: use provided tier, or 2 if whitelisted, or keep existing
        const newTier = tier !== undefined ? tier : (isWhitelistedUser ? Math.max(oldTier, 2) : oldTier);

        user.patreon_tier = newTier;
        user.patreon_is_whitelisted = isWhitelistedUser || user.patreon_is_whitelisted;
        user.updated_at = new Date().toISOString();

        await redis.set(`user:${unifiedId}`, JSON.stringify(user));

        console.log(`[ADMIN] Fixed patreon_tier for "${display_name}": ${oldTier} -> ${newTier}, whitelisted=${isWhitelistedUser}`);

        res.json({
            success: true,
            display_name: user.display_name,
            unified_id: unifiedId,
            old_tier: oldTier,
            new_tier: newTier,
            is_whitelisted: isWhitelistedUser || user.patreon_is_whitelisted
        });
    } catch (error) {
        console.error('Admin fix-patreon-tier error:', error.message);
        res.status(500).json({ error: 'Failed to fix patreon tier' });
    }
});

/**
 * POST /admin/set-og
 * Set is_season0_og flag for a user by display_name
 * Body: { display_name: string, admin_token: string, og?: boolean }
 */
app.post('/admin/set-og', async (req, res) => {
    try {
        const { display_name, admin_token, og } = req.body;

        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!display_name || typeof display_name !== 'string') {
            return res.status(400).json({ error: 'display_name is required' });
        }

        if (!redis) {
            return res.status(503).json({ error: 'Redis not available' });
        }

        const normalizedName = display_name.toLowerCase().trim();
        const unifiedId = await redis.get(`display_name_index:${normalizedName}`);

        if (!unifiedId) {
            return res.status(404).json({ error: `User "${display_name}" not found` });
        }

        const userData = await redis.get(`user:${unifiedId}`);
        if (!userData) {
            return res.status(404).json({ error: 'User data not found' });
        }

        const user = typeof userData === 'string' ? JSON.parse(userData) : userData;
        const oldOg = user.is_season0_og || false;
        const newOg = og !== undefined ? og : true;

        user.is_season0_og = newOg;
        user.updated_at = new Date().toISOString();

        await redis.set(`user:${unifiedId}`, JSON.stringify(user));

        console.log(`[ADMIN] Set OG for "${display_name}" (${unifiedId}): ${oldOg} -> ${newOg}`);

        res.json({
            success: true,
            display_name: user.display_name,
            unified_id: unifiedId,
            old_og: oldOg,
            new_og: newOg
        });
    } catch (error) {
        console.error('Admin set-og error:', error.message);
        res.status(500).json({ error: 'Failed to set OG status' });
    }
});

/**
 * POST /admin/delete-profile
 * Deletes a user profile by scanning all profile keys for matching display_name
 * Works for both Patreon and Discord profiles
 * Body: { display_name: string, admin_token: string }
 */
app.post('/admin/delete-profile', async (req, res) => {
    try {
        const { display_name, admin_token } = req.body;

        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!display_name || typeof display_name !== 'string') {
            return res.status(400).json({ error: 'display_name is required' });
        }

        if (!redis) {
            return res.status(503).json({ error: 'Redis not available' });
        }

        const targetName = display_name.toLowerCase();
        let foundKey = null;
        let foundProfile = null;

        // Scan both profile patterns
        const scanForProfile = async (pattern) => {
            let cursor = "0";
            do {
                const result = await redis.scan(cursor, { match: pattern, count: 100 });
                cursor = String(result[0]);
                const keys = result[1] || [];

                for (const key of keys) {
                    try {
                        const data = await redis.get(key);
                        if (data) {
                            const profile = typeof data === 'string' ? JSON.parse(data) : data;
                            if (profile.display_name && profile.display_name.toLowerCase() === targetName) {
                                foundKey = key;
                                foundProfile = profile;
                                return true;
                            }
                        }
                    } catch (e) { /* ignore parse errors */ }
                }
            } while (cursor !== "0");
            return false;
        };

        await scanForProfile('profile:*');
        if (!foundKey) await scanForProfile('discord_profile:*');

        if (!foundKey) {
            return res.status(404).json({ error: `No profile found with display_name "${display_name}"` });
        }

        // Delete the profile
        await redis.del(foundKey);

        // Also clean up the display_name index if it exists
        const indexKey = `display_name_index:${targetName}`;
        await redis.del(indexKey);

        console.log(`[ADMIN] Deleted profile for "${display_name}" (key: ${foundKey})`);

        res.json({
            success: true,
            display_name: display_name,
            deleted_key: foundKey,
            deleted_index: indexKey,
            old_level: foundProfile.level,
            old_xp: foundProfile.xp,
            message: `Profile for "${display_name}" has been deleted`
        });
    } catch (error) {
        console.error('Admin delete-profile error:', error.message);
        res.status(500).json({ error: 'Failed to delete profile' });
    }
});

/**
 * POST /admin/batch-restore
 * Batch restore user profiles from backup data - recreates ALL necessary records
 * Body: { profiles: [{unified_id, level, xp, achievements, stats, display_name, patron_name, patreon_id, discord_id}], admin_token: string }
 */
app.post('/admin/batch-restore', async (req, res) => {
    try {
        const { profiles, admin_token } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!profiles || !Array.isArray(profiles)) {
            return res.status(400).json({ error: 'profiles array is required' });
        }
        if (!redis) {
            return res.status(503).json({ error: 'Redis not available' });
        }

        const results = [];
        for (const profile of profiles) {
            try {
                const { unified_id, level, xp, achievements, stats, display_name, patron_name, patreon_id, discord_id } = profile;
                if (!unified_id) {
                    results.push({ unified_id: 'unknown', success: false, error: 'missing unified_id' });
                    continue;
                }

                // First, recreate the user record if it doesn't exist
                const userKey = `user:${unified_id}`;
                let userData = await redis.get(userKey);
                let user;

                if (!userData) {
                    // User record is gone - recreate it from backup data
                    user = {
                        unified_id,
                        display_name: display_name || null,
                        patreon_id: patreon_id || null,
                        discord_id: discord_id || null,
                        created_at: new Date().toISOString(),
                        recreated_from_backup: true
                    };
                    await redis.set(userKey, JSON.stringify(user));
                    console.log(`[ADMIN] Recreated user record: ${userKey}`);
                } else {
                    user = typeof userData === 'string' ? JSON.parse(userData) : userData;
                }

                // Determine profile key based on account type
                let profileKey;
                if (discord_id || user.discord_id) {
                    profileKey = `discord_profile:${discord_id || user.discord_id}`;
                } else if (patreon_id || user.patreon_id) {
                    profileKey = `profile:${patreon_id || user.patreon_id}`;
                } else {
                    profileKey = `profile:${unified_id}`;
                }

                // Build the restored profile with full data
                const restoredProfile = {
                    unified_id,
                    display_name: display_name || user.display_name || null,
                    level: level || 1,
                    xp: xp || 0,
                    achievements: achievements || [],
                    stats: stats || {},
                    patron_name: patron_name || null,
                    patreon_id: patreon_id || user.patreon_id || null,
                    discord_id: discord_id || user.discord_id || null,
                    created_at: new Date().toISOString(),
                    restored_at: new Date().toISOString(),
                    restored_from_backup: true
                };

                await redis.set(profileKey, JSON.stringify(restoredProfile));

                // Also update/create display_name index if applicable
                if (restoredProfile.display_name) {
                    await redis.set(`display_name_index:${restoredProfile.display_name.toLowerCase()}`, unified_id);
                }

                // Create patreon/discord user indexes if applicable
                if (restoredProfile.patreon_id) {
                    await redis.set(`patreon_user:${restoredProfile.patreon_id}`, unified_id);
                }
                if (restoredProfile.discord_id) {
                    await redis.set(`discord_user:${restoredProfile.discord_id}`, unified_id);
                }

                results.push({
                    unified_id,
                    success: true,
                    profile_key: profileKey,
                    level,
                    display_name: restoredProfile.display_name
                });

                console.log(`[ADMIN] Restored profile: ${restoredProfile.display_name || unified_id} to Level ${level}`);
            } catch (err) {
                results.push({ unified_id: profile.unified_id || 'unknown', success: false, error: err.message });
            }
        }

        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;

        res.json({
            success: true,
            total: profiles.length,
            restored: successCount,
            failed: failCount,
            results
        });
    } catch (error) {
        console.error('Admin batch-restore error:', error.message);
        res.status(500).json({ error: 'Failed to batch restore profiles' });
    }
});

/**
 * POST /admin/link-accounts
 * Links a Patreon account to a Discord account
 * Body: { patreon_id: string, discord_id: string, admin_token: string }
 */
app.post('/admin/link-accounts', async (req, res) => {
    try {
        const { patreon_id, discord_id, admin_token } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!patreon_id || !discord_id) {
            return res.status(400).json({ error: 'Both patreon_id and discord_id are required' });
        }
        if (!redis) {
            return res.status(503).json({ error: 'Redis not available' });
        }

        const patreonProfileKey = `${PROFILE_KEY_PREFIX}${patreon_id}`;
        const discordProfileKey = `discord_profile:${discord_id}`;
        let patreonProfile = await redis.get(patreonProfileKey);
        let discordProfile = await redis.get(discordProfileKey);
        if (patreonProfile && typeof patreonProfile === 'string') patreonProfile = JSON.parse(patreonProfile);
        if (discordProfile && typeof discordProfile === 'string') discordProfile = JSON.parse(discordProfile);

        const unifiedId = generateUnifiedId();
        const mergedProfile = {
            display_name: discordProfile?.display_name || patreonProfile?.display_name || 'Unknown',
            level: Math.max(patreonProfile?.level || 1, discordProfile?.level || 1),
            xp: Math.max(patreonProfile?.xp || 0, discordProfile?.xp || 0),
            total_flashes: (patreonProfile?.total_flashes || 0) + (discordProfile?.total_flashes || 0),
            total_video_minutes: (patreonProfile?.total_video_minutes || 0) + (discordProfile?.total_video_minutes || 0),
            total_lock_cards_completed: (patreonProfile?.total_lock_cards_completed || 0) + (discordProfile?.total_lock_cards_completed || 0),
            total_bubbles_popped: (patreonProfile?.total_bubbles_popped || 0) + (discordProfile?.total_bubbles_popped || 0),
            achievements: [...new Set([...(patreonProfile?.achievements || []), ...(discordProfile?.achievements || [])])],
            patreon_id, discord_id,
            created_at: patreonProfile?.created_at || discordProfile?.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        await redis.set(`${UNIFIED_USER_PREFIX}${unifiedId}`, JSON.stringify(mergedProfile));
        await redis.set(`${PATREON_USER_INDEX}${patreon_id}`, unifiedId);
        await redis.set(`${DISCORD_USER_INDEX}${discord_id}`, unifiedId);
        if (mergedProfile.display_name) {
            await redis.set(`display_name_index:${mergedProfile.display_name.toLowerCase()}`, unifiedId);
        }
        if (discordProfile) {
            discordProfile.unified_id = unifiedId;
            discordProfile.patreon_id = patreon_id;
            await redis.set(discordProfileKey, JSON.stringify(discordProfile));
        }

        console.log(`[ADMIN] Linked: Patreon ${patreon_id} <-> Discord ${discord_id} (${unifiedId})`);
        res.json({ success: true, unified_id: unifiedId, merged_profile: mergedProfile });
    } catch (error) {
        console.error('Admin link-accounts error:', error.message);
        res.status(500).json({ error: 'Failed to link accounts' });
    }
});

/**
 * GET /admin/search-profiles
 * Search profiles by pattern
 * Query: ?pattern=xxx&admin_token=xxx
 */
app.get('/admin/search-profiles', async (req, res) => {
    try {
        const { pattern, admin_token } = req.query;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!pattern) return res.status(400).json({ error: 'pattern required' });
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const searchPattern = pattern.toLowerCase();
        const results = [];
        const scanProfiles = async (keyPattern, type) => {
            let cursor = "0";
            do {
                const result = await redis.scan(cursor, { match: keyPattern, count: 100 });
                cursor = String(result[0]);
                for (const key of (result[1] || [])) {
                    try {
                        const data = await redis.get(key);
                        if (data) {
                            const p = typeof data === 'string' ? JSON.parse(data) : data;
                            if ((p.display_name && p.display_name.toLowerCase().includes(searchPattern)) ||
                                (p.email && p.email.toLowerCase().includes(searchPattern))) {
                                results.push({ key, type, display_name: p.display_name, email: p.email, level: p.level,
                                    patreon_id: p.patreon_id || (type === 'patreon' ? key.replace('profile:', '') : null),
                                    discord_id: p.discord_id || (type === 'discord' ? key.replace('discord_profile:', '') : null) });
                            }
                        }
                    } catch (e) {}
                }
            } while (cursor !== "0");
        };
        await scanProfiles('profile:*', 'patreon');
        await scanProfiles('discord_profile:*', 'discord');
        res.json({ pattern, results_count: results.length, results });
    } catch (error) {
        console.error('Admin search-profiles error:', error.message);
        res.status(500).json({ error: 'Failed to search profiles' });
    }
});

/**
 * GET /admin/scan-unified-users
 * Scan unified users and find those with missing/empty display_name
 * Query: ?admin_token=xxx
 */
app.get('/admin/scan-unified-users', async (req, res) => {
    try {
        const { admin_token } = req.query;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const brokenUsers = [];
        const allUsers = [];
        let cursor = "0";
        do {
            const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
            cursor = String(result[0]);
            for (const key of (result[1] || [])) {
                try {
                    const data = await redis.get(key);
                    if (data) {
                        const user = typeof data === 'string' ? JSON.parse(data) : data;
                        allUsers.push({ key, unified_id: user.unified_id, display_name: user.display_name, patreon_id: user.patreon_id, discord_id: user.discord_id });
                        if (!user.display_name || user.display_name.trim() === '') {
                            brokenUsers.push({ key, user });
                        }
                    }
                } catch (e) {}
            }
        } while (cursor !== "0");

        res.json({
            total_unified_users: allUsers.length,
            broken_users_count: brokenUsers.length,
            broken_users: brokenUsers,
            all_users: allUsers
        });
    } catch (error) {
        console.error('Admin scan-unified-users error:', error.message);
        res.status(500).json({ error: 'Failed to scan unified users' });
    }
});


/**
 * POST /admin/fix-migrated-users
 * Scan all users and fix missing current_season, discord_index keys, leaderboard entries
 * Body: { admin_token: string, dry_run?: boolean }
 */
app.post('/admin/fix-migrated-users', async (req, res) => {
    try {
        const { admin_token, dry_run = true } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const currentSeason = getCurrentSeason();
        const fixes = { missing_season: [], missing_discord_index: [], missing_leaderboard: [] };

        let cursor = "0";
        do {
            const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
            cursor = String(result[0]);
            for (const key of (result[1] || [])) {
                try {
                    const data = await redis.get(key);
                    if (!data) continue;
                    const user = typeof data === 'string' ? JSON.parse(data) : data;
                    if (!user.unified_id) continue;
                    let changed = false;

                    // Fix missing current_season
                    if (!user.current_season) {
                        fixes.missing_season.push({ unified_id: user.unified_id, display_name: user.display_name });
                        if (!dry_run) {
                            user.current_season = currentSeason;
                            changed = true;
                        }
                    }

                    // Fix missing discord_index for discord users
                    if (user.discord_id) {
                        const discordIndexKey = `discord_index:${user.discord_id}`;
                        const existing = await redis.get(discordIndexKey);
                        if (!existing) {
                            fixes.missing_discord_index.push({ unified_id: user.unified_id, display_name: user.display_name, discord_id: user.discord_id });
                            if (!dry_run) {
                                await redis.set(discordIndexKey, user.unified_id);
                            }
                        }
                    }

                    // Fix missing leaderboard entry
                    const season = user.current_season || currentSeason;
                    const score = await redis.zscore(`leaderboard:${season}`, user.unified_id);
                    if (score === null || score === undefined) {
                        fixes.missing_leaderboard.push({ unified_id: user.unified_id, display_name: user.display_name, season });
                        if (!dry_run) {
                            await redis.zadd(`leaderboard:${season}`, { score: user.xp || 0, member: user.unified_id });
                        }
                    }

                    if (changed) {
                        await redis.set(key, JSON.stringify(user));
                    }
                } catch (e) {}
            }
        } while (cursor !== "0");

        res.json({
            success: true,
            dry_run,
            fixes: {
                missing_season: fixes.missing_season.length,
                missing_discord_index: fixes.missing_discord_index.length,
                missing_leaderboard: fixes.missing_leaderboard.length,
                details: fixes
            }
        });
    } catch (error) {
        console.error('Admin fix-migrated-users error:', error.message);
        res.status(500).json({ error: 'Failed to fix migrated users' });
    }
});

/**
 * POST /admin/purge-user-data
 * Scans ALL keys and deletes any containing the specified display_name
 * Body: { display_name: string, admin_token: string, dry_run?: boolean }
 */
app.post('/admin/purge-user-data', async (req, res) => {
    try {
        const { display_name, admin_token, dry_run = false } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!display_name) return res.status(400).json({ error: 'display_name required' });
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const searchName = display_name.toLowerCase();
        const foundKeys = [];
        const deletedKeys = [];

        // Scan all keys
        let cursor = "0";
        do {
            const result = await redis.scan(cursor, { match: '*', count: 100 });
            cursor = String(result[0]);
            for (const key of (result[1] || [])) {
                try {
                    // Check key name itself
                    if (key.toLowerCase().includes(searchName)) {
                        foundKeys.push({ key, reason: 'key_name_match' });
                        if (!dry_run) {
                            await redis.del(key);
                            deletedKeys.push(key);
                        }
                        continue;
                    }
                    // Check value content
                    const data = await redis.get(key);
                    if (data) {
                        const strData = typeof data === 'string' ? data : JSON.stringify(data);
                        if (strData.toLowerCase().includes(searchName)) {
                            foundKeys.push({ key, reason: 'value_contains_name' });
                            if (!dry_run) {
                                await redis.del(key);
                                deletedKeys.push(key);
                            }
                        }
                    }
                } catch (e) {}
            }
        } while (cursor !== "0");

        console.log(`[ADMIN] Purge user data for "${display_name}": found ${foundKeys.length}, deleted ${deletedKeys.length} (dry_run: ${dry_run})`);
        res.json({
            display_name,
            dry_run,
            found_count: foundKeys.length,
            deleted_count: deletedKeys.length,
            found_keys: foundKeys,
            deleted_keys: deletedKeys
        });
    } catch (error) {
        console.error('Admin purge-user-data error:', error.message);
        res.status(500).json({ error: 'Failed to purge user data' });
    }
});


/**
 * GET /admin/get-key
 * Get raw value of a Redis key
 * Query: ?key=xxx&admin_token=xxx
 */
app.get('/admin/get-key', async (req, res) => {
    try {
        const { key, admin_token } = req.query;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!key) return res.status(400).json({ error: 'key required' });
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const data = await redis.get(key);
        if (data === null) return res.status(404).json({ error: 'Key not found', key });

        let parsed = data;
        try {
            if (typeof data === 'string') parsed = JSON.parse(data);
        } catch (e) {}

        res.json({ key, value: parsed });
    } catch (error) {
        console.error('Admin get-key error:', error.message);
        res.status(500).json({ error: 'Failed to get key' });
    }
});

/**
 * POST /admin/delete-key
 * Delete a specific Redis key
 * Body: { key: string, admin_token: string }
 */
app.post('/admin/delete-key', async (req, res) => {
    try {
        const { key, admin_token } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!key) return res.status(400).json({ error: 'key required' });
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const deleted = await redis.del(key);
        console.log(`[ADMIN] Deleted key: ${key} (result: ${deleted})`);
        res.json({ success: true, key, deleted: deleted > 0 });
    } catch (error) {
        console.error('Admin delete-key error:', error.message);
        res.status(500).json({ error: 'Failed to delete key' });
    }
});

/**
 * POST /admin/update-key
 * Update a specific field in a JSON Redis key
 * Body: { key: string, field: string, value: any, admin_token: string }
 */
app.post('/admin/update-key', async (req, res) => {
    try {
        const { key, field, value, admin_token } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!key || !field) return res.status(400).json({ error: 'key and field required' });
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        let data = await redis.get(key);
        if (data === null) return res.status(404).json({ error: 'Key not found', key });

        let parsed = typeof data === 'string' ? JSON.parse(data) : data;
        const oldValue = parsed[field];
        if (value === null) {
            delete parsed[field];
        } else {
            parsed[field] = value;
        }
        await redis.set(key, JSON.stringify(parsed));

        console.log(`[ADMIN] Updated key ${key}.${field}: ${JSON.stringify(oldValue)} -> ${JSON.stringify(value)}`);
        res.json({ success: true, key, field, old_value: oldValue, new_value: value });
    } catch (error) {
        console.error('Admin update-key error:', error.message);
        res.status(500).json({ error: 'Failed to update key' });
    }
});

/**
 * POST /admin/set-key
 * Directly set a Redis key with JSON data (for restoring backups)
 * Body: { key: string, data: object, admin_token: string }
 */
app.post('/admin/set-key', async (req, res) => {
    try {
        const { key, data, admin_token } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!key || !data) return res.status(400).json({ error: 'key and data required' });
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const existing = await redis.get(key);
        await redis.set(key, JSON.stringify(data));

        console.log(`[ADMIN] Set key ${key}: ${existing ? 'REPLACED' : 'CREATED'}`);
        res.json({ success: true, key, replaced: !!existing });
    } catch (error) {
        console.error('Admin set-key error:', error.message);
        res.status(500).json({ error: 'Failed to set key' });
    }
});

/**
 * POST /admin/mass-restore-display-names
 * DISABLED — This endpoint previously copied patron_name into display_name,
 * which leaked real names onto the leaderboard. Do not re-enable.
 */
app.post('/admin/mass-restore-display-names', async (req, res) => {
    return res.status(410).json({ error: 'This endpoint has been disabled to protect user privacy. patron_name must never be used as display_name.' });

    try {
        const { admin_token, dry_run = false } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const restored = [];
        const skipped = [];
        const errors = [];

        // Scan all user: keys
        let cursor = "0";
        do {
            const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
            cursor = String(result[0]);
            for (const key of (result[1] || [])) {
                try {
                    const data = await redis.get(key);
                    if (!data) continue;
                    const user = typeof data === 'string' ? JSON.parse(data) : data;

                    // Skip if already has display_name
                    if (user.display_name && user.display_name.trim() !== '') {
                        continue;
                    }

                    // Try to get a name from patron_name or discord_username
                    const newName = user.patron_name || user.discord_username || null;
                    if (!newName || newName.trim() === '') {
                        skipped.push({ key, reason: 'no_name_source' });
                        continue;
                    }

                    if (!dry_run) {
                        // Update the user record
                        user.display_name = newName;
                        user.display_name_restored_at = new Date().toISOString();
                        await redis.set(key, JSON.stringify(user));

                        // Create display_name_index
                        await redis.set(`display_name_index:${newName.toLowerCase()}`, user.unified_id);

                        // Also update the profile: or discord_profile: key if it exists
                        if (user.patreon_id) {
                            const profileKey = `profile:${user.patreon_id}`;
                            const profileData = await redis.get(profileKey);
                            if (profileData) {
                                const profile = typeof profileData === 'string' ? JSON.parse(profileData) : profileData;
                                profile.display_name = newName;
                                await redis.set(profileKey, JSON.stringify(profile));
                            }
                        }
                        if (user.discord_id) {
                            const discordKey = `discord_profile:${user.discord_id}`;
                            const discordData = await redis.get(discordKey);
                            if (discordData) {
                                const profile = typeof discordData === 'string' ? JSON.parse(discordData) : discordData;
                                profile.display_name = newName;
                                await redis.set(discordKey, JSON.stringify(profile));
                            }
                        }
                    }

                    restored.push({ key, unified_id: user.unified_id, new_display_name: newName });
                } catch (e) {
                    errors.push({ key, error: e.message });
                }
            }
        } while (cursor !== "0");

        console.log(`[ADMIN] Mass restore display names: ${restored.length} restored, ${skipped.length} skipped, ${errors.length} errors (dry_run=${dry_run})`);
        res.json({
            success: true,
            dry_run,
            restored_count: restored.length,
            skipped_count: skipped.length,
            error_count: errors.length,
            restored: restored.slice(0, 100), // Limit response size
            skipped: skipped.slice(0, 50),
            errors: errors
        });
    } catch (error) {
        console.error('Admin mass-restore-display-names error:', error.message);
        res.status(500).json({ error: 'Failed to mass restore display names' });
    }
});

/**
 * POST /admin/cleanup-empty-profiles
 * Find and delete profile:* entries that have no display_name
 * These cause "already linked to different profile" errors when users try to link accounts
 * Body: { admin_token: string, dry_run?: boolean }
 */
app.post('/admin/cleanup-empty-profiles', async (req, res) => {
    try {
        const { admin_token, dry_run = true } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const emptyProfiles = [];
        const deleted = [];
        const errors = [];
        let totalScanned = 0;

        // Scan all profile:* keys
        let cursor = "0";
        do {
            const result = await redis.scan(cursor, { match: 'profile:*', count: 100 });
            cursor = String(result[0]);
            for (const key of (result[1] || [])) {
                totalScanned++;
                try {
                    const data = await redis.get(key);
                    if (!data) continue;
                    const profile = typeof data === 'string' ? JSON.parse(data) : data;

                    // Check if display_name is missing or empty
                    const displayName = profile.display_name;
                    if (!displayName || displayName.trim() === '') {
                        const patreonId = key.replace('profile:', '');
                        emptyProfiles.push({
                            key,
                            patreon_id: patreonId,
                            email: profile.email,
                            tier: profile.patreon_tier,
                            is_active: profile.patreon_is_active,
                            is_whitelisted: profile.patreon_is_whitelisted
                        });

                        if (!dry_run) {
                            // Delete the profile and any associated index
                            await redis.del(key);
                            await redis.del(`patreon_user_index:${patreonId}`);
                            deleted.push(key);
                        }
                    }
                } catch (e) {
                    errors.push({ key, error: e.message });
                }
            }
        } while (cursor !== "0");

        res.json({
            dry_run,
            total_scanned: totalScanned,
            empty_profiles_found: emptyProfiles.length,
            deleted_count: deleted.length,
            empty_profiles: emptyProfiles,
            deleted: deleted,
            errors
        });
    } catch (error) {
        console.error('Admin cleanup-empty-profiles error:', error.message);
        res.status(500).json({ error: 'Failed to cleanup empty profiles' });
    }
});

// =============================================================================
// V2 API - MONTHLY SEASONS SYSTEM
// =============================================================================

/**
 * Level unlock thresholds
 */
const LEVEL_UNLOCKS = {
    avatars: 50,
    autonomy_mode: 75,
    takeover_mode: 100,
    ai_companion: 150
};

/**
 * Calculate unlocks based on highest level ever achieved
 */
function calculateUnlocks(highestLevel) {
    return {
        avatars: highestLevel >= LEVEL_UNLOCKS.avatars,
        autonomy_mode: highestLevel >= LEVEL_UNLOCKS.autonomy_mode,
        takeover_mode: highestLevel >= LEVEL_UNLOCKS.takeover_mode,
        ai_companion: highestLevel >= LEVEL_UNLOCKS.ai_companion
    };
}

/**
 * Get current season string (YYYY-MM)
 */
function getCurrentSeason() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * POST /admin/capture-legacy-users
 * Captures all existing users from profile:*, discord_profile:*, user:* keys
 * and stores them in season0:<provider_id> format for v5.5 migration.
 * Body: { admin_token: string, dry_run?: boolean }
 */
app.post('/admin/capture-legacy-users', async (req, res) => {
    try {
        const { admin_token, dry_run = true } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const legacyUsers = [];
        const season0Keys = [];
        const errors = [];

        // Helper to extract user data from any profile type
        const processProfile = (key, profile) => {
            const displayName = profile.display_name;
            if (!displayName || displayName.trim() === '') return null;

            // Extract provider IDs
            let patreonId = profile.patreon_id || profile.patreon_user_id;
            let discordId = profile.discord_id;

            // For profile:XXX keys, the XXX is often the patreon_id
            if (key.startsWith('profile:') && !patreonId) {
                const keyId = key.replace('profile:', '');
                // Only use if it looks like a Patreon ID (numeric)
                if (/^\d+$/.test(keyId)) {
                    patreonId = keyId;
                }
            }

            // For discord_profile:XXX keys, the XXX is the discord_id
            if (key.startsWith('discord_profile:') && !discordId) {
                discordId = key.replace('discord_profile:', '');
            }

            // For user:u_XXX keys, the unified_id is in the key
            let unifiedId = null;
            if (key.startsWith('user:')) {
                unifiedId = key.replace('user:', '');
            }

            return {
                key,
                display_name: displayName,
                patreon_id: patreonId || null,
                discord_id: discordId || null,
                unified_id: unifiedId,
                level: profile.level || 1,
                xp: profile.xp || 0,
                highest_level_ever: profile.level || 1,
                achievements: profile.achievements || [],
                stats: {
                    total_flashes: profile.stats?.total_flashes || 0,
                    total_bubbles_popped: profile.stats?.total_bubbles_popped || 0,
                    total_video_minutes: profile.stats?.total_video_minutes || 0,
                    total_lock_cards_completed: profile.stats?.total_lock_cards_completed || 0
                },
                patreon_tier: profile.patreon_tier || 0,
                patreon_is_active: profile.patreon_is_active || false,
                patreon_is_whitelisted: profile.patreon_is_whitelisted || false,
                email: profile.email || null,
                allow_discord_dm: profile.allow_discord_dm || false,
                show_online_status: profile.show_online_status !== false,
                captured_at: new Date().toISOString()
            };
        };

        // Scan all profile types
        const patterns = ['profile:*', 'discord_profile:*', 'user:*'];
        for (const pattern of patterns) {
            let cursor = "0";
            do {
                const result = await redis.scan(cursor, { match: pattern, count: 100 });
                cursor = String(result[0]);
                for (const key of (result[1] || [])) {
                    try {
                        const data = await redis.get(key);
                        if (!data) continue;
                        const profile = typeof data === 'string' ? JSON.parse(data) : data;
                        const userData = processProfile(key, profile);
                        if (userData) {
                            legacyUsers.push(userData);
                        }
                    } catch (e) {
                        errors.push({ key, error: e.message });
                    }
                }
            } while (cursor !== "0");
        }

        // Deduplicate by display_name (keep highest level)
        const deduped = new Map();
        for (const user of legacyUsers) {
            const nameKey = user.display_name.toLowerCase();
            if (deduped.has(nameKey)) {
                const existing = deduped.get(nameKey);
                // Keep the one with higher level, merge provider IDs
                if (user.level > existing.level) {
                    // Merge provider IDs from existing
                    if (!user.patreon_id && existing.patreon_id) user.patreon_id = existing.patreon_id;
                    if (!user.discord_id && existing.discord_id) user.discord_id = existing.discord_id;
                    // Merge achievements
                    const allAchievements = new Set([...user.achievements, ...existing.achievements]);
                    user.achievements = [...allAchievements];
                    // Keep higher stats
                    user.stats.total_flashes = Math.max(user.stats.total_flashes, existing.stats.total_flashes);
                    user.stats.total_bubbles_popped = Math.max(user.stats.total_bubbles_popped, existing.stats.total_bubbles_popped);
                    user.stats.total_video_minutes = Math.max(user.stats.total_video_minutes, existing.stats.total_video_minutes);
                    user.stats.total_lock_cards_completed = Math.max(user.stats.total_lock_cards_completed, existing.stats.total_lock_cards_completed);
                    deduped.set(nameKey, user);
                } else {
                    // Keep existing but merge provider IDs from this one
                    if (!existing.patreon_id && user.patreon_id) existing.patreon_id = user.patreon_id;
                    if (!existing.discord_id && user.discord_id) existing.discord_id = user.discord_id;
                    // Merge achievements
                    const allAchievements = new Set([...existing.achievements, ...user.achievements]);
                    existing.achievements = [...allAchievements];
                    // Keep higher stats
                    existing.stats.total_flashes = Math.max(existing.stats.total_flashes, user.stats.total_flashes);
                    existing.stats.total_bubbles_popped = Math.max(existing.stats.total_bubbles_popped, user.stats.total_bubbles_popped);
                    existing.stats.total_video_minutes = Math.max(existing.stats.total_video_minutes, user.stats.total_video_minutes);
                    existing.stats.total_lock_cards_completed = Math.max(existing.stats.total_lock_cards_completed, user.stats.total_lock_cards_completed);
                }
            } else {
                deduped.set(nameKey, user);
            }
        }

        const finalUsers = [...deduped.values()];

        // Store in season0: keys if not dry run
        if (!dry_run) {
            for (const user of finalUsers) {
                const season0Data = {
                    display_name: user.display_name,
                    patreon_id: user.patreon_id,
                    discord_id: user.discord_id,
                    highest_level_ever: user.level,
                    achievements: user.achievements,
                    stats: user.stats,
                    unlocks: calculateUnlocks(user.level),
                    patreon_tier: user.patreon_tier,
                    patreon_is_active: user.patreon_is_active,
                    patreon_is_whitelisted: user.patreon_is_whitelisted,
                    email: user.email,
                    allow_discord_dm: user.allow_discord_dm,
                    show_online_status: user.show_online_status,
                    captured_at: user.captured_at
                };

                // Store by patreon_id if available
                if (user.patreon_id) {
                    await redis.set(`season0:patreon:${user.patreon_id}`, JSON.stringify(season0Data));
                    season0Keys.push(`season0:patreon:${user.patreon_id}`);
                }
                // Store by discord_id if available
                if (user.discord_id) {
                    await redis.set(`season0:discord:${user.discord_id}`, JSON.stringify(season0Data));
                    season0Keys.push(`season0:discord:${user.discord_id}`);
                }
            }
        }

        console.log(`[ADMIN] Captured ${finalUsers.length} legacy users (dry_run: ${dry_run})`);

        res.json({
            dry_run,
            total_raw_profiles: legacyUsers.length,
            deduplicated_users: finalUsers.length,
            season0_keys_created: season0Keys.length,
            errors_count: errors.length,
            users: finalUsers,
            season0_keys: season0Keys,
            errors
        });
    } catch (error) {
        console.error('Admin capture-legacy-users error:', error.message);
        res.status(500).json({ error: 'Failed to capture legacy users' });
    }
});

/**
 * GET /admin/season0-lookup
 * Look up a Season 0 legacy user by provider ID
 * Query: ?admin_token=XXX&provider=patreon|discord&provider_id=XXX
 */
app.get('/admin/season0-lookup', async (req, res) => {
    try {
        const { admin_token, provider, provider_id } = req.query;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        if (!provider || !provider_id) {
            return res.status(400).json({ error: 'provider and provider_id required' });
        }

        if (!['patreon', 'discord'].includes(provider)) {
            return res.status(400).json({ error: 'provider must be patreon or discord' });
        }

        const key = `season0:${provider}:${provider_id}`;
        const data = await redis.get(key);

        if (!data) {
            return res.json({ found: false, provider, provider_id });
        }

        const legacyUser = typeof data === 'string' ? JSON.parse(data) : data;
        res.json({
            found: true,
            provider,
            provider_id,
            legacy_user: legacyUser
        });
    } catch (error) {
        console.error('Admin season0-lookup error:', error.message);
        res.status(500).json({ error: 'Failed to lookup legacy user' });
    }
});

/**
 * Generate a new unified user ID
 */
function generateUnifiedId() {
    return 'u_' + Math.random().toString(36).substr(2, 16);
}

/**
 * Look up Season 0 legacy data for a provider
 * @returns {Promise<object|null>} Legacy user data or null
 */
async function lookupSeason0(provider, providerId) {
    if (!redis) return null;
    const key = `season0:${provider}:${providerId}`;
    const data = await redis.get(key);
    if (!data) return null;
    return typeof data === 'string' ? JSON.parse(data) : data;
}

/**
 * Check if a discord ID was present in the V1 leaderboard backup.
 * Uses the season0_discord_ids Redis set as a fallback when season0: keys are missing.
 * @returns {Promise<boolean>}
 */
async function isV1DiscordUser(discordId) {
    if (!redis || !discordId) return false;
    return await redis.sismember('season0_discord_ids', discordId);
}

/**
 * Check if a display name is truly taken, auto-cleaning orphaned indexes.
 * Returns the unified_id of the owner if taken, or null if available (orphan was cleaned).
 */
async function isDisplayNameTaken(name) {
    if (!redis || !name) return null;
    const indexKey = `display_name_index:${name.toLowerCase()}`;
    const existingId = await redis.get(indexKey);
    if (!existingId) return null;

    // Verify the target record actually exists
    const userExists = await redis.get(`user:${existingId}`);
    if (userExists) return existingId; // genuinely taken

    const profileExists = await redis.get(`profile:${existingId}`);
    if (profileExists) return existingId;

    const discordProfileExists = await redis.get(`discord_profile:${existingId}`);
    if (discordProfileExists) return existingId;

    // Orphaned index — auto-clean
    console.log(`[Auto-cleanup] Orphaned display_name_index for "${name}" (was pointing to ${existingId}) — deleted`);
    await redis.del(indexKey);
    return null;
}

/**
 * POST /v2/auth/discord
 * Discord authentication for v5.5+ (monthly seasons system)
 * Body: { access_token: string, display_name?: string }
 * - If display_name provided: creates new user or updates existing
 * - If not provided: just checks if user exists
 */
app.post('/v2/auth/discord', async (req, res) => {
    try {
        const { access_token, display_name } = req.body;

        if (!access_token) {
            return res.status(400).json({ error: 'access_token required' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        // Get Discord user info
        const discordUser = await getDiscordUser(access_token);
        const discordId = discordUser.id;

        // Check if user already exists via index (check both V2 and V1 key formats)
        const indexKey = `discord_index:${discordId}`;
        let existingUnifiedId = await redis.get(indexKey);
        if (!existingUnifiedId) {
            // Fallback: check V1 key format (discord_user:<id>) for migrated users
            const v1Key = `discord_user:${discordId}`;
            const v1Id = await redis.get(v1Key);
            if (v1Id) {
                existingUnifiedId = v1Id;
                // Migrate to V2 key format so future lookups are fast
                await redis.set(indexKey, v1Id);
                console.log(`[V2] Migrated discord index key for ${discordId}: discord_user -> discord_index`);
            }
        }

        // Fallback: if index is missing, scan user:* keys to find orphaned account
        // This prevents data loss when discord_index key is accidentally deleted
        if (!existingUnifiedId) {
            console.log(`[V2] discord_index missing for ${discordId}, scanning for orphaned account...`);
            let cursor = 0;
            let found = false;
            do {
                const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
                cursor = result[0];
                for (const key of result[1]) {
                    try {
                        const userData = await redis.get(key);
                        if (!userData) continue;
                        const user = typeof userData === 'string' ? JSON.parse(userData) : userData;
                        if (user.discord_id === discordId) {
                            existingUnifiedId = user.unified_id || key.replace('user:', '');
                            // Repair the missing index so future lookups are fast
                            await redis.set(indexKey, existingUnifiedId);
                            console.log(`[V2] RECOVERED orphaned account for discord ${discordId}: ${existingUnifiedId} (${user.display_name}). Repaired discord_index.`);
                            found = true;
                            break;
                        }
                    } catch (e) {
                        // Skip malformed records
                    }
                }
                if (found) break;
            } while (cursor !== 0);
        }

        // Email-based auto-link: if user not found by discord_id, check if their Discord email
        // matches an existing account (e.g. a Patreon user logging in with Discord for the first time)
        if (!existingUnifiedId && discordUser.email) {
            const emailLookup = await lookupUserByEmail(discordUser.email);
            if (emailLookup && emailLookup.user) {
                existingUnifiedId = emailLookup.unified_id;
                // Link the Discord ID to the existing account
                const user = emailLookup.user;
                user.discord_id = discordId;
                user.updated_at = new Date().toISOString();
                await redis.set(`user:${existingUnifiedId}`, JSON.stringify(user));
                await redis.set(indexKey, existingUnifiedId);
                console.log(`[V2] AUTO-LINKED Discord ${discordId} (${discordUser.username}) to existing account ${existingUnifiedId} (${user.display_name}) via email match (${discordUser.email})`);
            }
        }

        if (existingUnifiedId) {
            // Existing user - return their data
            const userData = await redis.get(`user:${existingUnifiedId}`);
            if (userData) {
                const user = typeof userData === 'string' ? JSON.parse(userData) : userData;

                // Update last_seen + auto-fix missing fields from V1 migration
                user.last_seen = new Date().toISOString();
                const currentSeason = getCurrentSeason();
                if (!user.current_season) {
                    user.current_season = currentSeason;
                    console.log(`[V2] Auto-fixed missing current_season for ${existingUnifiedId}`);
                }
                if (!user.highest_level_ever) {
                    user.highest_level_ever = user.level || 1;
                }
                if (!user.unlocks) {
                    user.unlocks = calculateUnlocks(user.highest_level_ever || 0);
                }
                if (!user.is_season0_og && user.achievements?.length > 0) {
                    user.is_season0_og = true;
                    console.log(`[V2] Auto-flagged OG for ${existingUnifiedId} (has ${user.achievements.length} achievements)`);
                }
                await redis.set(`user:${existingUnifiedId}`, JSON.stringify(user));

                return res.json({
                    success: true,
                    is_new_user: false,
                    needs_registration: false,
                    unified_id: existingUnifiedId,
                    user: {
                        unified_id: user.unified_id,
                        display_name: user.display_name,
                        discord_id: user.discord_id,
                        patreon_id: user.patreon_id,
                        level: user.level,
                        xp: user.xp,
                        current_season: user.current_season,
                        highest_level_ever: user.highest_level_ever,
                        unlocks: user.unlocks,
                        achievements: user.achievements,
                        is_season0_og: user.is_season0_og,
                        patreon_tier: user.patreon_tier,
                        patreon_is_active: user.patreon_is_active
                    },
                    discord: {
                        id: discordUser.id,
                        username: discordUser.username,
                        global_name: discordUser.global_name,
                        avatar: discordUser.avatar
                    }
                });
            }
        }

        // User doesn't exist yet
        // Check Season 0 legacy data
        const legacyData = await lookupSeason0('discord', discordId);

        // Fallback: check V1 leaderboard discord IDs set if no season0 key found
        const isV1Og = legacyData ? true : await isV1DiscordUser(discordId);

        // If no display_name provided, just return registration status
        if (!display_name) {
            return res.json({
                success: true,
                is_new_user: true,
                needs_registration: true,
                is_legacy_user: isV1Og,
                legacy_data: legacyData ? {
                    display_name: legacyData.display_name,
                    highest_level_ever: legacyData.highest_level_ever,
                    achievements_count: legacyData.achievements?.length || 0,
                    unlocks: legacyData.unlocks
                } : null,
                discord: {
                    id: discordUser.id,
                    username: discordUser.username,
                    global_name: discordUser.global_name,
                    avatar: discordUser.avatar
                }
            });
        }

        // Create new user with display_name
        const trimmedName = display_name.trim();
        if (!trimmedName) {
            return res.status(400).json({ error: 'display_name cannot be empty' });
        }

        // CLEANUP: Delete any old user data for this discord_id before creating new account
        // This ONLY runs for whitelisted/OG users reclaiming their account - not for regular users
        // This protects existing users from accidental data loss
        const staleUnifiedId = await redis.get(indexKey);
        const isOgUserReclaiming = legacyData && (legacyData.is_whitelisted_og || legacyData.highest_level_ever > 0);
        if (staleUnifiedId && isOgUserReclaiming) {
            console.log(`[V2] OG user reclaiming account - cleaning up old data for discord_id ${discordId} (unified_id: ${staleUnifiedId})`);

            // Get old user data to find their display_name
            const oldUserData = await redis.get(`user:${staleUnifiedId}`);
            if (oldUserData) {
                const oldUser = typeof oldUserData === 'string' ? JSON.parse(oldUserData) : oldUserData;

                // Delete old user record
                await redis.del(`user:${staleUnifiedId}`);

                // Delete old display_name_index
                if (oldUser.display_name) {
                    await redis.del(`display_name_index:${oldUser.display_name.toLowerCase()}`);
                }

                // Delete old patreon_index if they had one
                if (oldUser.patreon_id) {
                    await redis.del(`patreon_index:${oldUser.patreon_id}`);
                }

                // Remove from leaderboard
                if (oldUser.current_season) {
                    await redis.zrem(`leaderboard:${oldUser.current_season}`, staleUnifiedId);
                }

                // Delete season0 keys for this account
                await redis.del(`season0:discord:${discordId}`);
                if (oldUser.patreon_id) {
                    await redis.del(`season0:patreon:${oldUser.patreon_id}`);
                }

                console.log(`[V2] Deleted old user: ${staleUnifiedId} (${oldUser.display_name})`);
            }

            // Delete the discord_index (will be recreated)
            await redis.del(indexKey);
        }

        // Check if display_name is already taken by a DIFFERENT user
        const nameIndexKey = `display_name_index:${trimmedName.toLowerCase()}`;
        const existingNameUser = await redis.get(nameIndexKey);
        if (existingNameUser) {
            // Check if this is a leftover index (user record doesn't exist)
            const existingUserData = await redis.get(`user:${existingNameUser}`);
            if (existingUserData) {
                // Name exists - but check if this is an OG user reclaiming their exact legacy name
                const isReclaimingLegacyName = isOgUserReclaiming &&
                    legacyData?.display_name &&
                    legacyData.display_name.toLowerCase() === trimmedName.toLowerCase();

                if (isReclaimingLegacyName) {
                    // OG user is reclaiming their exact legacy name - delete the existing user
                    console.log(`[V2] OG user reclaiming legacy name "${trimmedName}" - deleting existing user ${existingNameUser}`);
                    const oldUser = typeof existingUserData === 'string' ? JSON.parse(existingUserData) : existingUserData;

                    // Delete existing user completely
                    await redis.del(`user:${existingNameUser}`);
                    await redis.del(nameIndexKey);
                    if (oldUser.patreon_id) await redis.del(`patreon_index:${oldUser.patreon_id}`);
                    if (oldUser.discord_id) await redis.del(`discord_index:${oldUser.discord_id}`);
                    if (oldUser.current_season) await redis.zrem(`leaderboard:${oldUser.current_season}`, existingNameUser);

                    console.log(`[V2] Deleted existing user ${existingNameUser} (${oldUser.display_name}) to allow OG reclaim`);
                } else {
                    // Name is genuinely taken by another user and this isn't a legacy reclaim
                    return res.status(409).json({ error: 'display_name already taken' });
                }
            } else {
                // Orphaned index - clean it up
                console.log(`[V2] Cleaning up orphaned display_name_index for "${trimmedName}"`);
                await redis.del(nameIndexKey);
            }
        }

        const unifiedId = generateUnifiedId();
        const currentSeason = getCurrentSeason();

        // Build new user object
        const newUser = {
            unified_id: unifiedId,
            display_name: trimmedName,
            patreon_id: null,
            discord_id: discordId,
            email: discordUser.email || null,

            // Seasonal data (starts fresh)
            current_season: currentSeason,
            xp: 0,
            level: 1,

            // Permanent data (migrating users start fresh, only keep achievements + OG status)
            highest_level_ever: 0,
            unlocks: calculateUnlocks(0),
            achievements: legacyData?.achievements || [],
            all_time_stats: {
                total_flashes: 0,
                total_bubbles_popped: 0,
                total_video_minutes: 0,
                total_lock_cards_completed: 0,
                seasons_completed: 0
            },

            // Legacy status — check both season0 key AND V1 discord IDs set
            is_season0_og: isV1Og,

            // Patreon status (starts empty)
            patreon_tier: legacyData?.patreon_tier || 0,
            patreon_is_active: legacyData?.patreon_is_active || false,
            patreon_is_whitelisted: legacyData?.patreon_is_whitelisted || false,

            // Skill tree (level 1 = 1 sparkle point)
            skill_points: 1,
            unlocked_skills: [],

            // Settings
            allow_discord_dm: legacyData?.allow_discord_dm || false,
            show_online_status: legacyData?.show_online_status !== false,

            // Metadata
            display_name_set_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_seen: new Date().toISOString()
        };

        // Save user and indexes
        await redis.set(`user:${unifiedId}`, JSON.stringify(newUser));
        await redis.set(indexKey, unifiedId);
        await redis.set(nameIndexKey, unifiedId);
        if (newUser.email) {
            await redis.set(`email_index:${newUser.email.toLowerCase()}`, unifiedId);
        }

        // Add to leaderboard sorted set
        await redis.zadd(`leaderboard:${currentSeason}`, { score: 0, member: unifiedId });

        console.log(`[V2] Created new user: ${unifiedId} (${trimmedName}) via Discord, OG=${isV1Og}`);

        res.json({
            success: true,
            is_new_user: true,
            needs_registration: false,
            is_legacy_user: !!legacyData,
            unified_id: unifiedId,
            user: {
                unified_id: newUser.unified_id,
                display_name: newUser.display_name,
                discord_id: newUser.discord_id,
                patreon_id: newUser.patreon_id,
                level: newUser.level,
                xp: newUser.xp,
                current_season: newUser.current_season,
                highest_level_ever: newUser.highest_level_ever,
                unlocks: newUser.unlocks,
                achievements: newUser.achievements,
                is_season0_og: newUser.is_season0_og,
                patreon_tier: newUser.patreon_tier,
                patreon_is_active: newUser.patreon_is_active
            },
            discord: {
                id: discordUser.id,
                username: discordUser.username,
                global_name: discordUser.global_name,
                avatar: discordUser.avatar
            }
        });
    } catch (error) {
        console.error('V2 Discord auth error:', error.message);
        if (error.message === 'UNAUTHORIZED') {
            return res.status(401).json({ error: 'Discord token expired or invalid' });
        }
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v2/auth/patreon
 * Patreon authentication for v5.5+ (monthly seasons system)
 * Body: { access_token: string, display_name?: string }
 */
app.post('/v2/auth/patreon', async (req, res) => {
    try {
        const { access_token, display_name } = req.body;

        if (!access_token) {
            return res.status(400).json({ error: 'access_token required' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        // Get Patreon user info
        const identity = await getPatreonIdentity(access_token);
        const patreonId = identity.data.id;
        const patronName = identity.data.attributes?.full_name || 'Unknown';
        const patronEmail = identity.data.attributes?.email;

        // Check subscription tier
        const tierInfo = getTierFromMemberships(identity.included || []);

        // Check if user already exists via index
        // Check both V2 key (patreon_index:) and V1 key (patreon_user:) for backward compatibility
        const indexKey = `patreon_index:${patreonId}`;
        let existingUnifiedId = await redis.get(indexKey);

        if (!existingUnifiedId) {
            // Fallback: check V1 index key used by older registration flow
            const v1IndexKey = `${PATREON_USER_INDEX}${patreonId}`;
            existingUnifiedId = await redis.get(v1IndexKey);
            if (existingUnifiedId) {
                // Migrate: create the V2 index key so future lookups are fast
                await redis.set(indexKey, existingUnifiedId);
                console.log(`[V2] Migrated patreon index for ${patreonId}: ${v1IndexKey} -> ${indexKey}`);
            }
        }

        // Fallback: if index is missing, scan user:* keys to find orphaned account
        // This prevents data loss when patreon_index key is accidentally deleted
        // Wrapped in a 3s timeout to prevent Vercel function timeouts on large datasets
        if (!existingUnifiedId) {
            console.log(`[V2] patreon_index missing for ${patreonId}, scanning for orphaned account...`);
            try {
                const scanResult = await Promise.race([
                    (async () => {
                        let cursor = 0;
                        do {
                            const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
                            cursor = result[0];
                            for (const key of result[1]) {
                                try {
                                    const userData = await redis.get(key);
                                    if (!userData) continue;
                                    const user = typeof userData === 'string' ? JSON.parse(userData) : userData;
                                    if (user.patreon_id === patreonId) {
                                        existingUnifiedId = user.unified_id || key.replace('user:', '');
                                        // Repair the missing index so future lookups are fast
                                        await redis.set(indexKey, existingUnifiedId);
                                        console.log(`[V2] RECOVERED orphaned account for patreon ${patreonId}: ${existingUnifiedId} (${user.display_name}). Repaired patreon_index.`);
                                        return 'found';
                                    }
                                } catch (e) {
                                    // Skip malformed records
                                }
                            }
                        } while (cursor !== 0);
                        return 'not_found';
                    })(),
                    new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000))
                ]);
                if (scanResult === 'timeout') {
                    console.warn(`[V2] Orphan scan timed out for patreon ${patreonId} — continuing as new user`);
                }
            } catch (e) {
                console.error(`[V2] Orphan scan error for patreon ${patreonId}:`, e);
            }
        }

        // Email-based auto-link: if user not found by patreon_id, check if their Patreon email
        // matches an existing account (e.g. a Discord user logging in with Patreon for the first time)
        if (!existingUnifiedId && patronEmail) {
            const emailLookup = await lookupUserByEmail(patronEmail);
            if (emailLookup && emailLookup.user) {
                existingUnifiedId = emailLookup.unified_id;
                // Link the Patreon ID to the existing account
                const user = emailLookup.user;
                user.patreon_id = patreonId;
                user.patreon_tier = tierInfo.tier;
                user.patreon_is_active = tierInfo.is_active;
                user.patreon_is_whitelisted = isWhitelisted(patronEmail, patronName, user.display_name);
                user.updated_at = new Date().toISOString();
                await redis.set(`user:${existingUnifiedId}`, JSON.stringify(user));
                await redis.set(indexKey, existingUnifiedId);
                console.log(`[V2] AUTO-LINKED Patreon ${patreonId} (${patronName}) to existing account ${existingUnifiedId} (${user.display_name}) via email match (${patronEmail})`);
            }
        }

        if (existingUnifiedId) {
            // Existing user - update their Patreon status and return data
            const userData = await redis.get(`user:${existingUnifiedId}`);
            if (userData) {
                const user = typeof userData === 'string' ? JSON.parse(userData) : userData;

                // Update Patreon status + auto-fix missing fields from V1 migration
                user.patreon_tier = tierInfo.tier;
                user.patreon_is_active = tierInfo.is_active;
                user.patreon_is_whitelisted = isWhitelisted(patronEmail, patronName, user.display_name);
                user.last_seen = new Date().toISOString();
                user.updated_at = new Date().toISOString();
                const currentSeason = getCurrentSeason();
                if (!user.current_season) {
                    user.current_season = currentSeason;
                    console.log(`[V2] Auto-fixed missing current_season for ${existingUnifiedId}`);
                }
                if (!user.highest_level_ever) {
                    user.highest_level_ever = user.level || 1;
                }
                if (!user.unlocks) {
                    user.unlocks = calculateUnlocks(user.highest_level_ever || 0);
                }
                if (!user.is_season0_og && user.achievements?.length > 0) {
                    user.is_season0_og = true;
                    console.log(`[V2] Auto-flagged OG for ${existingUnifiedId} (has ${user.achievements.length} achievements)`);
                }

                await redis.set(`user:${existingUnifiedId}`, JSON.stringify(user));

                return res.json({
                    success: true,
                    is_new_user: false,
                    needs_registration: false,
                    unified_id: existingUnifiedId,
                    user: {
                        unified_id: user.unified_id,
                        display_name: user.display_name,
                        discord_id: user.discord_id,
                        patreon_id: user.patreon_id,
                        level: user.level,
                        xp: user.xp,
                        current_season: user.current_season,
                        highest_level_ever: user.highest_level_ever,
                        unlocks: user.unlocks,
                        achievements: user.achievements,
                        is_season0_og: user.is_season0_og,
                        patreon_tier: user.patreon_tier,
                        patreon_is_active: user.patreon_is_active
                    },
                    patreon: {
                        id: patreonId,
                        name: patronName,
                        email: patronEmail,
                        tier: tierInfo.tier,
                        is_active: tierInfo.is_active
                    }
                });
            }
        }

        // User doesn't exist yet
        // Check Season 0 legacy data
        let legacyData = await lookupSeason0('patreon', patreonId);

        // Fallback: If not in Season 0 capture but IS whitelisted, treat as OG supporter
        // (They were Patreon members before v5.5 but may not have logged into the app)
        console.log(`[V2 DEBUG] Checking whitelist for: email="${patronEmail}", name="${patronName}"`);
        console.log(`[V2 DEBUG] Email in whitelist: ${WHITELISTED_EMAILS.has((patronEmail || '').toLowerCase())}`);
        console.log(`[V2 DEBUG] Name in whitelist: ${WHITELISTED_NAMES.has((patronName || '').toLowerCase())}`);
        const whitelistedForLegacy = isWhitelisted(patronEmail, patronName, null);
        console.log(`[V2 DEBUG] isWhitelisted result: ${whitelistedForLegacy}`);
        if (!legacyData && whitelistedForLegacy) {
            console.log(`[V2] User ${patronName} not in Season 0 but IS whitelisted - treating as OG`);

            // Try to find their old profile from existing data to restore their display_name
            let oldDisplayName = null;
            let oldHighestLevel = 0;
            let oldAchievements = [];

            // Search profile:* keys for matching email or patron_name
            try {
                let cursor = "0";
                outer: do {
                    const result = await redis.scan(cursor, { match: 'profile:*', count: 100 });
                    cursor = String(result[0]);
                    for (const key of (result[1] || [])) {
                        const profileData = await redis.get(key);
                        if (profileData) {
                            const profile = typeof profileData === 'string' ? JSON.parse(profileData) : profileData;
                            // Match by email (case insensitive) or patron_name (case insensitive)
                            const profileEmail = (profile.email || '').toLowerCase();
                            const profilePatronName = (profile.patron_name || '').toLowerCase();
                            const searchEmail = (patronEmail || '').toLowerCase();
                            const searchName = (patronName || '').toLowerCase();

                            if ((searchEmail && profileEmail === searchEmail) ||
                                (searchName && profilePatronName === searchName)) {
                                oldDisplayName = profile.display_name || null;
                                oldHighestLevel = profile.level || 0;
                                oldAchievements = profile.achievements || [];
                                console.log(`[V2] Found old profile for ${patronName}: display_name="${oldDisplayName}", level=${oldHighestLevel}`);
                                break outer;
                            }
                        }
                    }
                } while (cursor !== "0");
            } catch (scanErr) {
                console.error('[V2] Error scanning for old profile:', scanErr.message);
            }

            legacyData = {
                display_name: oldDisplayName,  // Restored from old profile if found
                highest_level_ever: oldHighestLevel,
                achievements: oldAchievements,
                unlocks: calculateUnlocks(oldHighestLevel),
                is_whitelisted_og: true  // Flag that this is from whitelist, not capture
            };
        }

        // If no display_name provided, just return registration status
        if (!display_name) {
            return res.json({
                success: true,
                is_new_user: true,
                needs_registration: true,
                is_legacy_user: !!legacyData,
                legacy_data: legacyData ? {
                    display_name: legacyData.display_name,
                    highest_level_ever: legacyData.highest_level_ever,
                    achievements_count: legacyData.achievements?.length || 0,
                    unlocks: legacyData.unlocks
                } : null,
                patreon: {
                    id: patreonId,
                    name: patronName,
                    email: patronEmail,
                    tier: tierInfo.tier,
                    is_active: tierInfo.is_active
                }
            });
        }

        // Create new user with display_name
        const trimmedName = display_name.trim();
        if (!trimmedName) {
            return res.status(400).json({ error: 'display_name cannot be empty' });
        }

        // CLEANUP: Delete any old user data for this patreon_id before creating new account
        // This ONLY runs for whitelisted/OG users reclaiming their account - not for regular users
        // This protects existing users from accidental data loss
        const staleUnifiedId = await redis.get(indexKey);
        const isOgUserReclaiming = legacyData && (legacyData.is_whitelisted_og || legacyData.highest_level_ever > 0);
        if (staleUnifiedId && isOgUserReclaiming) {
            console.log(`[V2] OG user reclaiming account - cleaning up old data for patreon_id ${patreonId} (unified_id: ${staleUnifiedId})`);

            // Get old user data to find their display_name
            const oldUserData = await redis.get(`user:${staleUnifiedId}`);
            if (oldUserData) {
                const oldUser = typeof oldUserData === 'string' ? JSON.parse(oldUserData) : oldUserData;

                // Delete old user record
                await redis.del(`user:${staleUnifiedId}`);

                // Delete old display_name_index
                if (oldUser.display_name) {
                    await redis.del(`display_name_index:${oldUser.display_name.toLowerCase()}`);
                }

                // Delete old discord_index if they had one
                if (oldUser.discord_id) {
                    await redis.del(`discord_index:${oldUser.discord_id}`);
                }

                // Remove from leaderboard
                if (oldUser.current_season) {
                    await redis.zrem(`leaderboard:${oldUser.current_season}`, staleUnifiedId);
                }

                // Delete season0 keys for this account
                await redis.del(`season0:patreon:${patreonId}`);
                if (oldUser.discord_id) {
                    await redis.del(`season0:discord:${oldUser.discord_id}`);
                }

                console.log(`[V2] Deleted old user: ${staleUnifiedId} (${oldUser.display_name})`);
            }

            // Delete the patreon_index (will be recreated)
            await redis.del(indexKey);
        }

        // Check if display_name is already taken by a DIFFERENT user
        const nameIndexKey = `display_name_index:${trimmedName.toLowerCase()}`;
        const existingNameUser = await redis.get(nameIndexKey);
        if (existingNameUser) {
            // Check if this is a leftover index (user record doesn't exist)
            const existingUserData = await redis.get(`user:${existingNameUser}`);
            if (existingUserData) {
                // Name exists - check if this is a whitelisted OG user who can reclaim
                // Whitelisted users can claim ANY taken name (whitelist = proof of OG status)
                // This handles the case where profile:* keys were deleted so legacyData.display_name is null
                const canReclaimAsOg = isOgUserReclaiming || whitelistedForLegacy;

                if (canReclaimAsOg) {
                    // OG/whitelisted user can claim this name - delete the existing user
                    console.log(`[V2] Whitelisted OG user claiming "${trimmedName}" - deleting existing user ${existingNameUser}`);
                    const oldUser = typeof existingUserData === 'string' ? JSON.parse(existingUserData) : existingUserData;

                    // Delete existing user completely
                    await redis.del(`user:${existingNameUser}`);
                    await redis.del(nameIndexKey);
                    if (oldUser.patreon_id) await redis.del(`patreon_index:${oldUser.patreon_id}`);
                    if (oldUser.discord_id) await redis.del(`discord_index:${oldUser.discord_id}`);
                    if (oldUser.current_season) await redis.zrem(`leaderboard:${oldUser.current_season}`, existingNameUser);

                    console.log(`[V2] Deleted existing user ${existingNameUser} (${oldUser.display_name}) to allow OG claim`);
                } else {
                    // Name is genuinely taken by another user and this isn't an OG
                    return res.status(409).json({ error: 'display_name already taken' });
                }
            } else {
                // Orphaned index - clean it up
                console.log(`[V2] Cleaning up orphaned display_name_index for "${trimmedName}"`);
                await redis.del(nameIndexKey);
            }
        }

        const unifiedId = generateUnifiedId();
        const currentSeason = getCurrentSeason();

        // Check whitelist
        const whitelisted = isWhitelisted(patronEmail, patronName, trimmedName);

        // Build new user object
        const newUser = {
            unified_id: unifiedId,
            display_name: trimmedName,
            patreon_id: patreonId,
            discord_id: null,
            email: patronEmail || null,

            // Seasonal data (starts fresh)
            current_season: currentSeason,
            xp: 0,
            level: 1,

            // Permanent data (migrating users start fresh, only keep achievements + OG status)
            highest_level_ever: 0,
            unlocks: calculateUnlocks(0),
            achievements: legacyData?.achievements || [],
            all_time_stats: {
                total_flashes: 0,
                total_bubbles_popped: 0,
                total_video_minutes: 0,
                total_lock_cards_completed: 0,
                seasons_completed: 0
            },

            // Legacy status
            is_season0_og: !!legacyData,

            // Patreon status
            patreon_tier: whitelisted ? Math.max(tierInfo.tier, 2) : tierInfo.tier,
            patreon_is_active: tierInfo.is_active,
            patreon_is_whitelisted: whitelisted,

            // Skill tree (level 1 = 1 sparkle point)
            skill_points: 1,
            unlocked_skills: [],

            // Settings
            allow_discord_dm: legacyData?.allow_discord_dm || false,
            show_online_status: legacyData?.show_online_status !== false,

            // Metadata
            display_name_set_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_seen: new Date().toISOString()
        };

        // Save user and indexes
        await redis.set(`user:${unifiedId}`, JSON.stringify(newUser));
        await redis.set(indexKey, unifiedId);
        await redis.set(nameIndexKey, unifiedId);
        if (newUser.email) {
            await redis.set(`email_index:${newUser.email.toLowerCase()}`, unifiedId);
        }

        // Add to leaderboard sorted set
        await redis.zadd(`leaderboard:${currentSeason}`, { score: 0, member: unifiedId });

        console.log(`[V2] Created new user: ${unifiedId} (${trimmedName}) via Patreon, OG=${!!legacyData}`);

        res.json({
            success: true,
            is_new_user: true,
            needs_registration: false,
            is_legacy_user: !!legacyData,
            unified_id: unifiedId,
            user: {
                unified_id: newUser.unified_id,
                display_name: newUser.display_name,
                discord_id: newUser.discord_id,
                patreon_id: newUser.patreon_id,
                level: newUser.level,
                xp: newUser.xp,
                current_season: newUser.current_season,
                highest_level_ever: newUser.highest_level_ever,
                unlocks: newUser.unlocks,
                achievements: newUser.achievements,
                is_season0_og: newUser.is_season0_og,
                patreon_tier: newUser.patreon_tier,
                patreon_is_active: newUser.patreon_is_active
            },
            patreon: {
                id: patreonId,
                name: patronName,
                email: patronEmail,
                tier: tierInfo.tier,
                is_active: tierInfo.is_active
            }
        });
    } catch (error) {
        console.error('V2 Patreon auth error:', error.message);
        if (error.message === 'UNAUTHORIZED') {
            return res.status(401).json({ error: 'Patreon token expired or invalid' });
        }
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v2/auth/link
 * Link a second provider (Discord or Patreon) to an existing account
 * Body: { unified_id: string, provider: 'discord'|'patreon', access_token: string }
 */
app.post('/v2/auth/link', async (req, res) => {
    try {
        const { unified_id, provider, access_token } = req.body;

        if (!unified_id || !provider || !access_token) {
            return res.status(400).json({ error: 'unified_id, provider, and access_token required' });
        }
        if (!['discord', 'patreon'].includes(provider)) {
            return res.status(400).json({ error: 'provider must be discord or patreon' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        // Get existing user
        const userData = await redis.get(`user:${unified_id}`);
        if (!userData) {
            return res.status(404).json({ error: 'User not found' });
        }
        const user = typeof userData === 'string' ? JSON.parse(userData) : userData;

        if (provider === 'discord') {
            // Check if already has Discord linked
            if (user.discord_id) {
                return res.status(409).json({ error: 'Discord already linked to this account' });
            }

            // Get Discord user info
            const discordUser = await getDiscordUser(access_token);
            const discordId = discordUser.id;

            // Check if this Discord ID is already linked to another account
            const existingLink = await redis.get(`discord_index:${discordId}`);
            if (existingLink && existingLink !== unified_id) {
                return res.status(409).json({ error: 'Discord account already linked to a different user' });
            }

            // Link Discord to user
            user.discord_id = discordId;
            user.updated_at = new Date().toISOString();

            // Save user and create index
            await redis.set(`user:${unified_id}`, JSON.stringify(user));
            await redis.set(`discord_index:${discordId}`, unified_id);

            console.log(`[V2] Linked Discord ${discordId} to user ${unified_id} (${user.display_name})`);

            return res.json({
                success: true,
                unified_id,
                linked_provider: 'discord',
                discord: {
                    id: discordUser.id,
                    username: discordUser.username,
                    global_name: discordUser.global_name,
                    avatar: discordUser.avatar
                }
            });
        } else {
            // Patreon linking
            // Check if already has Patreon linked
            if (user.patreon_id) {
                return res.status(409).json({ error: 'Patreon already linked to this account' });
            }

            // Get Patreon user info
            const identity = await getPatreonIdentity(access_token);
            const patreonId = identity.data.id;
            const patronName = identity.data.attributes?.full_name || 'Unknown';
            const patronEmail = identity.data.attributes?.email;

            // Check if this Patreon ID is already linked to another account
            const existingLink = await redis.get(`patreon_index:${patreonId}`);
            if (existingLink && existingLink !== unified_id) {
                return res.status(409).json({ error: 'Patreon account already linked to a different user' });
            }

            // Get tier info
            const tierInfo = getTierFromMemberships(identity.included || []);

            // Check whitelist
            const whitelisted = isWhitelisted(patronEmail, patronName, user.display_name);

            // Link Patreon to user
            user.patreon_id = patreonId;
            user.email = patronEmail || user.email;
            user.patreon_tier = whitelisted ? Math.max(tierInfo.tier, 2) : tierInfo.tier;
            user.patreon_is_active = tierInfo.is_active;
            user.patreon_is_whitelisted = whitelisted;
            user.updated_at = new Date().toISOString();

            // Save user and create index
            await redis.set(`user:${unified_id}`, JSON.stringify(user));
            await redis.set(`patreon_index:${patreonId}`, unified_id);

            console.log(`[V2] Linked Patreon ${patreonId} to user ${unified_id} (${user.display_name})`);

            return res.json({
                success: true,
                unified_id,
                linked_provider: 'patreon',
                patreon: {
                    id: patreonId,
                    name: patronName,
                    email: patronEmail,
                    tier: tierInfo.tier,
                    is_active: tierInfo.is_active
                }
            });
        }
    } catch (error) {
        console.error('V2 auth link error:', error.message);
        if (error.message === 'UNAUTHORIZED') {
            return res.status(401).json({ error: 'Token expired or invalid' });
        }
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /v2/user/profile
 * Get current user's profile (requires unified_id)
 * Query: ?unified_id=XXX
 */
app.get('/v2/user/profile', async (req, res) => {
    try {
        const { unified_id } = req.query;

        if (!unified_id) {
            return res.status(400).json({ error: 'unified_id required' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const userData = await redis.get(`user:${unified_id}`);
        if (!userData) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = typeof userData === 'string' ? JSON.parse(userData) : userData;

        res.json({
            success: true,
            user: {
                unified_id: user.unified_id,
                display_name: user.display_name,
                discord_id: user.discord_id,
                patreon_id: user.patreon_id,
                level: user.level,
                xp: user.xp,
                current_season: user.current_season,
                highest_level_ever: user.highest_level_ever,
                unlocks: user.unlocks,
                achievements: user.achievements,
                all_time_stats: user.all_time_stats,
                is_season0_og: user.is_season0_og,
                patreon_tier: user.patreon_tier,
                patreon_is_active: user.patreon_is_active,
                patreon_is_whitelisted: user.patreon_is_whitelisted,
                allow_discord_dm: user.allow_discord_dm,
                show_online_status: user.show_online_status,
                created_at: user.created_at,
                last_seen: user.last_seen
            }
        });
    } catch (error) {
        console.error('V2 user profile error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v2/user/delete-account
 * Delete user account and all associated data (GDPR)
 * Body: { unified_id: string, confirmation: 'DELETE' }
 */
app.post('/v2/user/delete-account', async (req, res) => {
    try {
        const { unified_id, confirmation } = req.body;

        if (!unified_id) {
            return res.status(400).json({ error: 'unified_id required' });
        }
        if (confirmation !== 'DELETE') {
            return res.status(400).json({ error: 'Must confirm deletion by setting confirmation to "DELETE"' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const userData = await redis.get(`user:${unified_id}`);
        if (!userData) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = typeof userData === 'string' ? JSON.parse(userData) : userData;
        const deleted = [];

        // Delete user record
        await redis.del(`user:${unified_id}`);
        deleted.push(`user:${unified_id}`);

        // Delete V2 indexes
        if (user.discord_id) {
            await redis.del(`discord_index:${user.discord_id}`);
            deleted.push(`discord_index:${user.discord_id}`);
        }
        if (user.patreon_id) {
            await redis.del(`patreon_index:${user.patreon_id}`);
            deleted.push(`patreon_index:${user.patreon_id}`);
        }
        if (user.display_name) {
            await redis.del(`display_name_index:${user.display_name.toLowerCase()}`);
            deleted.push(`display_name_index:${user.display_name.toLowerCase()}`);
        }
        if (user.email) {
            // Fix: always lowercase email for index lookup (indexes are created with toLowerCase)
            const normalizedEmail = user.email.toLowerCase();
            await redis.del(`email_index:${normalizedEmail}`);
            deleted.push(`email_index:${normalizedEmail}`);
        }

        // Remove from ALL leaderboard seasons (not just current)
        // The user might have entries in previous seasons too
        try {
            let cursor = "0";
            do {
                const result = await redis.scan(cursor, { match: 'leaderboard:*', count: 100 });
                cursor = String(result[0]);
                for (const lbKey of (result[1] || [])) {
                    const removed = await redis.zrem(lbKey, unified_id);
                    if (removed) {
                        deleted.push(`${lbKey} (member removed)`);
                    }
                }
            } while (cursor !== "0");
        } catch (lbErr) {
            console.error('[V2 Delete] Error scanning leaderboards:', lbErr.message);
            // Fallback: at least remove from current season
            if (user.current_season) {
                await redis.zrem(`leaderboard:${user.current_season}`, unified_id);
                deleted.push(`leaderboard:${user.current_season} (member removed, fallback)`);
            }
        }

        // Delete Season 0 backups
        if (user.discord_id) {
            await redis.del(`season0:discord:${user.discord_id}`);
            deleted.push(`season0:discord:${user.discord_id}`);
        }
        if (user.patreon_id) {
            await redis.del(`season0:patreon:${user.patreon_id}`);
            deleted.push(`season0:patreon:${user.patreon_id}`);
        }

        // Delete legacy V1 keys (indexes + profiles)
        if (user.discord_id) {
            await redis.del(`discord_user:${user.discord_id}`);
            deleted.push(`discord_user:${user.discord_id}`);
            await redis.del(`discord_profile:${user.discord_id}`);
            deleted.push(`discord_profile:${user.discord_id}`);
        }
        if (user.patreon_id) {
            await redis.del(`patreon_user:${user.patreon_id}`);
            deleted.push(`patreon_user:${user.patreon_id}`);
            await redis.del(`profile:${user.patreon_id}`);
            deleted.push(`profile:${user.patreon_id}`);
        }

        // Remove from season0_discord_ids set (used for V1 Discord user lookup)
        if (user.discord_id) {
            await redis.srem('season0_discord_ids', user.discord_id);
            deleted.push(`season0_discord_ids (member ${user.discord_id} removed)`);
        }

        console.log(`[V2] Deleted user account: ${unified_id} (${user.display_name}), cleaned ${deleted.length} keys`);

        res.json({
            success: true,
            deleted_unified_id: unified_id,
            deleted_display_name: user.display_name,
            deleted_keys: deleted
        });
    } catch (error) {
        console.error('V2 delete account error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /admin/delete-user-by-name
 * Admin endpoint to delete a user by display_name (for testing)
 * Body: { admin_token: string, display_name: string }
 */
app.post('/admin/delete-user-by-name', async (req, res) => {
    try {
        const { admin_token, display_name } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });
        if (!display_name) {
            return res.status(400).json({ error: 'display_name required' });
        }

        // Look up unified_id by display_name
        const nameIndexKey = `display_name_index:${display_name.toLowerCase()}`;
        const unifiedId = await redis.get(nameIndexKey);
        if (!unifiedId) {
            return res.status(404).json({ error: `No user found with display_name: ${display_name}` });
        }

        // Get user data
        const userData = await redis.get(`user:${unifiedId}`);
        if (!userData) {
            return res.status(404).json({ error: 'User record not found' });
        }

        const user = typeof userData === 'string' ? JSON.parse(userData) : userData;
        const deleted = [];

        // Delete user record
        await redis.del(`user:${unifiedId}`);
        deleted.push(`user:${unifiedId}`);

        // Delete indexes
        if (user.discord_id) {
            await redis.del(`discord_index:${user.discord_id}`);
            deleted.push(`discord_index:${user.discord_id}`);
        }
        if (user.patreon_id) {
            await redis.del(`patreon_index:${user.patreon_id}`);
            deleted.push(`patreon_index:${user.patreon_id}`);
        }
        await redis.del(nameIndexKey);
        deleted.push(nameIndexKey);

        // Remove from leaderboard
        if (user.current_season) {
            await redis.zrem(`leaderboard:${user.current_season}`, unifiedId);
            deleted.push(`leaderboard:${user.current_season} (member removed)`);
        }

        console.log(`[ADMIN] Deleted user by name: ${display_name} (${unifiedId})`);

        res.json({
            success: true,
            deleted_unified_id: unifiedId,
            deleted_display_name: display_name,
            user_data: user,
            deleted_keys: deleted
        });
    } catch (error) {
        console.error('Admin delete user error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /admin/set-achievements
 * Admin endpoint to set achievements for a user by display_name
 * Body: { admin_token: string, display_name: string, achievements: string[] }
 */
app.post('/admin/set-achievements', async (req, res) => {
    try {
        const { admin_token, display_name, achievements } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });
        if (!display_name || !achievements) {
            return res.status(400).json({ error: 'display_name and achievements array required' });
        }

        // Find user in all profile types (check unified users first — canonical source)
        const patterns = ['user:*', 'profile:*', 'discord_profile:*'];
        let foundKey = null;
        let foundData = null;

        for (const pattern of patterns) {
            let cursor = "0";
            do {
                const result = await redis.scan(cursor, { match: pattern, count: 100 });
                cursor = String(result[0]);
                const keys = result[1] || [];

                for (const key of keys) {
                    const data = await redis.get(key);
                    if (data) {
                        const profile = typeof data === 'string' ? JSON.parse(data) : data;
                        if (profile.display_name && profile.display_name.toLowerCase() === display_name.toLowerCase()) {
                            foundKey = key;
                            foundData = profile;
                            break;
                        }
                    }
                }
                if (foundKey) break;
            } while (cursor !== "0");
            if (foundKey) break;
        }

        if (!foundKey || !foundData) {
            return res.status(404).json({ error: `User not found: ${display_name}` });
        }

        // Update achievements
        const oldAchievements = foundData.achievements || [];
        foundData.achievements = achievements;
        foundData.updated_at = new Date().toISOString();

        await redis.set(foundKey, JSON.stringify(foundData));

        console.log(`[ADMIN] Set achievements for ${display_name}: ${oldAchievements.length} -> ${achievements.length}`);

        res.json({
            success: true,
            display_name,
            key: foundKey,
            old_count: oldAchievements.length,
            new_count: achievements.length,
            achievements
        });
    } catch (error) {
        console.error('Admin set-achievements error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /admin/delete-legacy-profile
 * Admin endpoint to delete legacy profile:* or discord_profile:* keys by display_name
 * Body: { admin_token: string, display_name: string }
 */
app.post('/admin/delete-legacy-profile', async (req, res) => {
    try {
        const { admin_token, display_name } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });
        if (!display_name) {
            return res.status(400).json({ error: 'display_name required' });
        }

        const deleted = [];
        const patterns = ['profile:*', 'discord_profile:*'];

        for (const pattern of patterns) {
            let cursor = "0";
            do {
                const result = await redis.scan(cursor, { match: pattern, count: 100 });
                cursor = String(result[0]);
                const keys = result[1] || [];

                for (const key of keys) {
                    const data = await redis.get(key);
                    if (data) {
                        const profile = typeof data === 'string' ? JSON.parse(data) : data;
                        const name = profile.display_name || profile.username || profile.patron_name;
                        if (name && name.toLowerCase() === display_name.toLowerCase()) {
                            await redis.del(key);
                            deleted.push({ key, name });
                            console.log(`[ADMIN] Deleted legacy key: ${key} (${name})`);
                        }
                    }
                }
            } while (cursor !== "0");
        }

        if (deleted.length === 0) {
            return res.json({ success: false, message: `No legacy profiles found for: ${display_name}` });
        }

        res.json({
            success: true,
            deleted_count: deleted.length,
            deleted_keys: deleted
        });
    } catch (error) {
        console.error('Admin delete legacy profile error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /admin/purge-user-completely
 * Admin endpoint to completely purge ALL data for a discord_id or patreon_id
 * This includes: user:*, indexes, season0:*, legacy profile:*, leaderboard entries
 * Body: { admin_token: string, discord_id?: string, patreon_id?: string }
 */
app.post('/admin/purge-user-completely', async (req, res) => {
    try {
        const { admin_token, discord_id, patreon_id } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });
        if (!discord_id && !patreon_id) {
            return res.status(400).json({ error: 'discord_id or patreon_id required' });
        }

        const deleted = [];

        // 1. Delete season0 keys
        if (discord_id) {
            const key = `season0:discord:${discord_id}`;
            const existed = await redis.del(key);
            if (existed) deleted.push(key);
        }
        if (patreon_id) {
            const key = `season0:patreon:${patreon_id}`;
            const existed = await redis.del(key);
            if (existed) deleted.push(key);
        }

        // 2. Delete indexes and find unified_id
        let unifiedId = null;
        if (discord_id) {
            const indexKey = `discord_index:${discord_id}`;
            unifiedId = await redis.get(indexKey);
            const existed = await redis.del(indexKey);
            if (existed) deleted.push(indexKey);
        }
        if (patreon_id) {
            const indexKey = `patreon_index:${patreon_id}`;
            const uid = await redis.get(indexKey);
            if (uid) unifiedId = uid;
            const existed = await redis.del(indexKey);
            if (existed) deleted.push(indexKey);
        }

        // 3. Delete user record and display_name index
        if (unifiedId) {
            const userData = await redis.get(`user:${unifiedId}`);
            if (userData) {
                const user = typeof userData === 'string' ? JSON.parse(userData) : userData;

                // Delete display name index
                if (user.display_name) {
                    const nameKey = `display_name_index:${user.display_name.toLowerCase()}`;
                    await redis.del(nameKey);
                    deleted.push(nameKey);
                }

                // Delete from leaderboard
                if (user.current_season) {
                    await redis.zrem(`leaderboard:${user.current_season}`, unifiedId);
                    deleted.push(`leaderboard:${user.current_season} (member removed)`);
                }

                // Delete user record
                await redis.del(`user:${unifiedId}`);
                deleted.push(`user:${unifiedId}`);
            }
        }

        // 4. Delete legacy profile:* keys
        if (patreon_id) {
            const key = `profile:${patreon_id}`;
            const existed = await redis.del(key);
            if (existed) deleted.push(key);
        }

        // 5. Delete legacy discord_profile:* keys
        if (discord_id) {
            const key = `discord_profile:${discord_id}`;
            const existed = await redis.del(key);
            if (existed) deleted.push(key);
        }

        console.log(`[ADMIN] Purged user completely: discord=${discord_id}, patreon=${patreon_id}, deleted=${deleted.length} keys`);

        res.json({
            success: true,
            deleted_count: deleted.length,
            deleted_keys: deleted,
            unified_id_found: unifiedId
        });
    } catch (error) {
        console.error('Admin purge user error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v2/user/update
 * Update user profile data (XP, level, stats, achievements, settings)
 * Body: { unified_id: string, ...updates }
 */
app.post('/v2/user/update', async (req, res) => {
    try {
        const { unified_id, xp, level, stats, achievements, settings } = req.body;

        if (!unified_id) {
            return res.status(400).json({ error: 'unified_id required' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const userData = await redis.get(`user:${unified_id}`);
        if (!userData) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = typeof userData === 'string' ? JSON.parse(userData) : userData;
        const currentSeason = getCurrentSeason();

        // Check if user needs season reset (if their current_season doesn't match)
        if (user.current_season && user.current_season !== currentSeason) {
            const oldSeason = user.current_season;
            // Auto-reset for new season
            console.log(`[V2] Auto-resetting user ${unified_id} from ${oldSeason} to ${currentSeason}`);

            // Archive stats to all_time
            if (!user.all_time_stats) user.all_time_stats = {};
            user.all_time_stats.total_flashes = (user.all_time_stats.total_flashes || 0) + (user.stats?.total_flashes || 0);
            user.all_time_stats.total_bubbles_popped = (user.all_time_stats.total_bubbles_popped || 0) + (user.stats?.total_bubbles_popped || 0);
            user.all_time_stats.total_video_minutes = (user.all_time_stats.total_video_minutes || 0) + (user.stats?.total_video_minutes || 0);
            user.all_time_stats.total_lock_cards_completed = (user.all_time_stats.total_lock_cards_completed || 0) + (user.stats?.total_lock_cards_completed || 0);
            user.all_time_stats.seasons_completed = (user.all_time_stats.seasons_completed || 0) + 1;

            // Update highest level if needed
            user.highest_level_ever = Math.max(user.highest_level_ever || 0, user.level || 1);

            // Recalculate unlocks
            user.unlocks = calculateUnlocks(user.highest_level_ever);

            // Reset seasonal data
            user.xp = 0;
            user.level = 1;
            user.stats = {
                total_flashes: 0,
                total_bubbles_popped: 0,
                total_video_minutes: 0,
                total_lock_cards_completed: 0
            };
            user.current_season = currentSeason;
            user.level_reset_at = new Date().toISOString();
            delete user.oopsie_used_season;

            // Move user to new season leaderboard (remove from OLD season, not new)
            await redis.zrem(`leaderboard:${oldSeason}`, unified_id);
            await redis.zadd(`leaderboard:${currentSeason}`, { score: 0, member: unified_id });
        }

        // Apply updates
        if (typeof xp === 'number') {
            user.xp = xp;
            // Update leaderboard sorted set
            await redis.zadd(`leaderboard:${currentSeason}`, { score: xp, member: unified_id });
        }
        if (typeof level === 'number') {
            user.level = level;
            // Track highest level ever
            if (level > (user.highest_level_ever || 0)) {
                user.highest_level_ever = level;
                user.unlocks = calculateUnlocks(level);
            }
        }
        if (stats) {
            user.stats = { ...(user.stats || {}), ...stats };
        }
        if (achievements && Array.isArray(achievements)) {
            // Merge achievements (keep unique)
            const existingAchievements = new Set(user.achievements || []);
            for (const ach of achievements) {
                existingAchievements.add(ach);
            }
            user.achievements = [...existingAchievements];
        }
        if (settings) {
            if (typeof settings.allow_discord_dm === 'boolean') {
                user.allow_discord_dm = settings.allow_discord_dm;
            }
            if (typeof settings.show_online_status === 'boolean') {
                user.show_online_status = settings.show_online_status;
            }
        }

        user.updated_at = new Date().toISOString();
        user.last_seen = new Date().toISOString();

        await redis.set(`user:${unified_id}`, JSON.stringify(user));

        res.json({
            success: true,
            user: {
                unified_id: user.unified_id,
                display_name: user.display_name,
                level: user.level,
                xp: user.xp,
                current_season: user.current_season,
                highest_level_ever: user.highest_level_ever,
                unlocks: user.unlocks,
                achievements: user.achievements,
                stats: user.stats
            }
        });
    } catch (error) {
        console.error('V2 user update error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v2/user/change-display-name
 * Allow a user to change their display name. Name must be unique (case-insensitive).
 * Allows case-only changes (e.g. "alice" → "Alice") without uniqueness conflict.
 * Admin can force-rename by passing admin_token (bypasses uniqueness check, cleans up stale indexes).
 * Body: { unified_id: string, new_display_name: string, admin_token?: string }
 */
app.post('/v2/user/change-display-name', async (req, res) => {
    try {
        const { unified_id, new_display_name, admin_token } = req.body;
        const isAdmin = admin_token && admin_token === process.env.ADMIN_TOKEN;

        if (!unified_id) {
            return res.status(400).json({ error: 'unified_id required' });
        }
        if (!new_display_name || typeof new_display_name !== 'string') {
            return res.status(400).json({ error: 'new_display_name required' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const trimmed = new_display_name.trim();
        if (trimmed.length < 2 || trimmed.length > 20) {
            return res.status(400).json({ error: 'Display name must be 2-20 characters' });
        }

        const userData = await redis.get(`user:${unified_id}`);
        if (!userData) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = typeof userData === 'string' ? JSON.parse(userData) : userData;
        const oldName = user.display_name;

        // Allow case-only changes without uniqueness conflict
        // Admin can force-rename (bypasses uniqueness, cleans up stale indexes)
        const isCaseOnlyChange = oldName && oldName.toLowerCase() === trimmed.toLowerCase();
        if (!isCaseOnlyChange && !isAdmin) {
            const takenBy = await isDisplayNameTaken(trimmed);
            if (takenBy && takenBy !== unified_id) {
                return res.status(409).json({ error: 'This name is already taken' });
            }
        }
        // Admin force: clean up any stale index for the target name
        if (isAdmin) {
            await redis.del(`display_name_index:${trimmed.toLowerCase()}`);
        }

        // Remove old display_name_index
        if (oldName) {
            await redis.del(`display_name_index:${oldName.toLowerCase()}`);
        }

        // Create new display_name_index
        await redis.set(`display_name_index:${trimmed.toLowerCase()}`, unified_id);

        // Update user record
        user.display_name = trimmed;
        user.display_name_changed_at = new Date().toISOString();
        user.updated_at = new Date().toISOString();

        // Check whitelist with new name
        const whitelisted = isWhitelisted(user.email || null, user.patron_name || null, trimmed);
        user.is_whitelisted = whitelisted;

        await redis.set(`user:${unified_id}`, JSON.stringify(user));

        console.log(`[DisplayName] User ${unified_id} changed name from "${oldName}" to "${trimmed}" (whitelisted: ${whitelisted})`);

        res.json({
            success: true,
            new_display_name: trimmed
        });
    } catch (error) {
        console.error('Change display name error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v2/user/use-oopsie
 * Server-side oopsie insurance: deduct 500 XP and mark as used for this season.
 * Prevents cheating by validating on server.
 * Body: { unified_id: string, fix_date: string (YYYY-MM-DD) }
 */
app.post('/v2/user/use-oopsie', async (req, res) => {
    try {
        const { unified_id, fix_date } = req.body;

        if (!unified_id) {
            return res.status(400).json({ error: 'unified_id required' });
        }
        if (!fix_date) {
            return res.status(400).json({ error: 'fix_date required' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const userData = await redis.get(`user:${unified_id}`);
        if (!userData) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = typeof userData === 'string' ? JSON.parse(userData) : userData;
        const currentSeason = getCurrentSeason();

        // Check if already used this season
        if (user.oopsie_used_season === currentSeason) {
            return res.status(400).json({ error: 'Already used this season' });
        }

        // Check XP requirement (500 XP)
        if ((user.xp || 0) < 500) {
            return res.status(400).json({ error: 'Not enough XP' });
        }

        // Deduct 500 XP
        user.xp = (user.xp || 0) - 500;
        user.oopsie_used_season = currentSeason;

        // Add fix_date to quest_completion_dates in stats
        if (!user.stats) user.stats = {};
        if (!user.stats.quest_completion_dates) user.stats.quest_completion_dates = [];
        if (Array.isArray(user.stats.quest_completion_dates) && !user.stats.quest_completion_dates.includes(fix_date)) {
            user.stats.quest_completion_dates.push(fix_date);
        }

        user.updated_at = new Date().toISOString();

        // Save user
        await redis.set(`user:${unified_id}`, JSON.stringify(user));

        // Update leaderboard sorted set with new XP
        const season = user.current_season || currentSeason;
        await redis.zadd(`leaderboard:${season}`, { score: user.xp, member: unified_id });

        console.log(`[Oopsie] User ${unified_id} (${user.display_name}) used oopsie insurance: -500 XP, fixed ${fix_date}, new XP: ${user.xp}`);

        res.json({
            success: true,
            new_xp: user.xp,
            oopsie_used_season: currentSeason
        });
    } catch (error) {
        console.error('Oopsie insurance error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /v3/leaderboard
 * New leaderboard endpoint using Redis sorted sets.
 * Query: ?season=YYYY-MM (optional, defaults to current)
 *        &limit=N (default 200, max 1000)
 *        &offset=N (for pagination)
 */
app.get('/v3/leaderboard', async (req, res) => {
    try {
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const season = req.query.season || getCurrentSeason();
        let limit = parseInt(req.query.limit) || 10000;
        limit = Math.max(limit, 1);
        const offset = parseInt(req.query.offset) || 0;

        const leaderboardKey = `leaderboard:${season}`;

        // Get ranked users from sorted set (highest XP first)
        const rankedMembers = await redis.zrange(leaderboardKey, offset, offset + limit - 1, { rev: true, withScores: true });

        const entries = [];
        let rank = offset + 1;

        // Build list of {unifiedId, xp} from ranked members.
        // Upstash SDK may return objects [{member/value, score}, ...] or a flat array [member, score, ...].
        const ranked = [];
        if (rankedMembers && rankedMembers.length > 0) {
            if (typeof rankedMembers[0] === 'object') {
                // Object format
                for (const item of rankedMembers) {
                    ranked.push({ unifiedId: item.member || item.value, xp: Number(item.score) || 0 });
                }
            } else {
                // Flat array format: [member, score, member, score, ...]
                for (let i = 0; i < rankedMembers.length; i += 2) {
                    ranked.push({ unifiedId: rankedMembers[i], xp: Number(rankedMembers[i + 1]) || 0 });
                }
            }
        }

        for (const { unifiedId, xp } of ranked) {
            if (!unifiedId) continue;

            // Fetch user data
            const userData = await redis.get(`user:${unifiedId}`);
            if (userData) {
                const user = typeof userData === 'string' ? JSON.parse(userData) : userData;

                // Check if online (within last minute)
                const lastSeen = user.last_seen ? new Date(user.last_seen) : null;
                const isOnline = lastSeen && (Date.now() - lastSeen.getTime()) < 60000 && user.show_online_status !== false;

                const hasTrophyCase = Array.isArray(user.unlocked_skills) && user.unlocked_skills.includes('trophy_case');

                // Privacy: never expose patron_name on the leaderboard.
                // If display_name matches patron_name (case-insensitive), it was auto-populated — treat as unset.
                // BUT if display_name_set_at exists, the user explicitly chose this name — respect it.
                let safeName = user.display_name || null;
                if (safeName && user.patron_name && !user.display_name_set_at &&
                    safeName.toLowerCase().trim() === user.patron_name.toLowerCase().trim()) {
                    safeName = null;
                }

                entries.push({
                    rank: rank++,
                    unified_id: unifiedId,
                    display_name: safeName,
                    level: user.level || 1,
                    xp: xp,
                    is_online: isOnline,
                    is_patreon: user.patreon_is_active || user.patreon_is_whitelisted || (user.patreon_tier > 0),
                    patreon_tier: user.patreon_tier || 0,
                    is_season0_og: user.is_season0_og || false,
                    discord_id: user.allow_discord_dm ? user.discord_id : null,
                    achievements_count: user.achievements?.length || 0,
                    total_bubbles_popped: user.stats?.total_bubbles_popped || 0,
                    total_flashes: user.stats?.total_flashes || 0,
                    total_video_minutes: user.stats?.total_video_minutes || 0,
                    total_lock_cards_completed: user.stats?.total_lock_cards_completed || 0,
                    // Trophy case stats - only shown if user has the skill
                    has_trophy_case: hasTrophyCase,
                    longest_session_minutes: hasTrophyCase ? (user.stats?.longest_session_minutes || 0) : 0,
                    highest_streak: hasTrophyCase ? (user.stats?.consecutive_days || 0) : 0
                });
            }
        }

        // Get total count
        const totalUsers = await redis.zcard(leaderboardKey);
        const onlineCount = entries.filter(e => e.is_online).length;

        res.json({
            season,
            entries,
            total_users: totalUsers,
            online_users: onlineCount,
            offset,
            limit,
            fetched_at: new Date().toISOString()
        });
    } catch (error) {
        console.error('V3 leaderboard error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /v2/leaderboard
 * DEPRECATED - kept returning 503 during transition.
 * Use /v3/leaderboard instead.
 */
app.get('/v2/leaderboard', async (req, res) => {
    try {
        // Temporarily disabled during new leaderboard transition (2026-02-06)
        return res.status(503).json({ error: 'Leaderboard is temporarily unavailable while we upgrade to the new system. Check back soon!' });

        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const season = req.query.season || getCurrentSeason();
        let limit = parseInt(req.query.limit) || 200;
        limit = Math.min(Math.max(limit, 1), 1000);
        const offset = parseInt(req.query.offset) || 0;

        const leaderboardKey = `leaderboard:${season}`;

        // Get ranked users from sorted set (highest XP first)
        // Upstash uses zrange with rev:true instead of zrevrange
        const rankedMembers = await redis.zrange(leaderboardKey, offset, offset + limit - 1, { rev: true, withScores: true });

        // rankedMembers is an array like [member1, score1, member2, score2, ...]
        // or with upstash it might be array of objects
        const entries = [];
        let rank = offset + 1;

        // Handle both formats (array of objects or flat array)
        if (rankedMembers.length > 0 && typeof rankedMembers[0] === 'object' && 'member' in rankedMembers[0]) {
            // Upstash format: [{member, score}, ...]
            for (const item of rankedMembers) {
                const unifiedId = item.member;
                const xp = item.score;

                // Fetch user data
                const userData = await redis.get(`user:${unifiedId}`);
                if (userData) {
                    const user = typeof userData === 'string' ? JSON.parse(userData) : userData;

                    // Check if online (within last minute)
                    const lastSeen = user.last_seen ? new Date(user.last_seen) : null;
                    const isOnline = lastSeen && (Date.now() - lastSeen.getTime()) < 60000 && user.show_online_status !== false;

                    // Privacy: never expose patron_name on the leaderboard
                    // But if display_name_set_at exists, the user explicitly chose this name — respect it.
                    let safeName = user.display_name || null;
                    if (safeName && user.patron_name && !user.display_name_set_at &&
                        safeName.toLowerCase().trim() === user.patron_name.toLowerCase().trim()) {
                        safeName = null;
                    }

                    entries.push({
                        rank: rank++,
                        unified_id: unifiedId,
                        display_name: safeName,
                        level: user.level || 1,
                        xp: xp,
                        is_online: isOnline,
                        is_patreon: user.patreon_is_active || user.patreon_is_whitelisted || (user.patreon_tier > 0),
                        patreon_tier: user.patreon_tier || 0,
                        is_season0_og: user.is_season0_og || false,
                        discord_id: user.allow_discord_dm ? user.discord_id : null,
                        achievements_count: user.achievements?.length || 0,
                        // Stats (all-time, don't reset)
                        total_bubbles_popped: user.stats?.total_bubbles_popped || 0,
                        total_flashes: user.stats?.total_flashes || 0,
                        total_video_minutes: user.stats?.total_video_minutes || 0,
                        total_lock_cards_completed: user.stats?.total_lock_cards_completed || 0
                    });
                }
            }
        } else {
            // Flat array format: [member1, score1, member2, score2, ...]
            for (let i = 0; i < rankedMembers.length; i += 2) {
                const unifiedId = rankedMembers[i];
                const xp = parseInt(rankedMembers[i + 1]) || 0;

                const userData = await redis.get(`user:${unifiedId}`);
                if (userData) {
                    const user = typeof userData === 'string' ? JSON.parse(userData) : userData;

                    const lastSeen = user.last_seen ? new Date(user.last_seen) : null;
                    const isOnline = lastSeen && (Date.now() - lastSeen.getTime()) < 60000 && user.show_online_status !== false;

                    // Privacy: never expose patron_name on the leaderboard
                    // But if display_name_set_at exists, the user explicitly chose this name — respect it.
                    let safeName2 = user.display_name || null;
                    if (safeName2 && user.patron_name && !user.display_name_set_at &&
                        safeName2.toLowerCase().trim() === user.patron_name.toLowerCase().trim()) {
                        safeName2 = null;
                    }

                    entries.push({
                        rank: rank++,
                        unified_id: unifiedId,
                        display_name: safeName2,
                        level: user.level || 1,
                        xp: xp,
                        is_online: isOnline,
                        is_patreon: user.patreon_is_active || user.patreon_is_whitelisted || (user.patreon_tier > 0),
                        patreon_tier: user.patreon_tier || 0,
                        is_season0_og: user.is_season0_og || false,
                        discord_id: user.allow_discord_dm ? user.discord_id : null,
                        achievements_count: user.achievements?.length || 0,
                        // Stats (all-time, don't reset)
                        total_bubbles_popped: user.stats?.total_bubbles_popped || 0,
                        total_flashes: user.stats?.total_flashes || 0,
                        total_video_minutes: user.stats?.total_video_minutes || 0,
                        total_lock_cards_completed: user.stats?.total_lock_cards_completed || 0
                    });
                }
            }
        }

        // Get total count
        const totalUsers = await redis.zcard(leaderboardKey);
        const onlineCount = entries.filter(e => e.is_online).length;

        res.json({
            season,
            entries,
            total_users: totalUsers,
            online_users: onlineCount,
            offset,
            limit,
            fetched_at: new Date().toISOString()
        });
    } catch (error) {
        console.error('V2 leaderboard error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /admin/leaderboard-remove
 * Batch remove specific users from leaderboard sorted set
 * Body: { admin_token: string, season: string, unified_ids: string[] }
 */
app.post('/admin/leaderboard-remove', async (req, res) => {
    try {
        const { admin_token, season, unified_ids } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });
        if (!season || !unified_ids || !Array.isArray(unified_ids)) {
            return res.status(400).json({ error: 'season and unified_ids[] required' });
        }

        const leaderboardKey = `leaderboard:${season}`;
        let removed = 0;
        for (const uid of unified_ids) {
            await redis.zrem(leaderboardKey, uid);
            removed++;
        }

        res.json({ success: true, season, removed });
    } catch (error) {
        console.error('Admin leaderboard-remove error:', error.message);
        res.status(500).json({ error: 'Failed to remove from leaderboard' });
    }
});

/**
 * POST /admin/cleanup-leaderboard
 * Remove orphaned entries from leaderboard (users that no longer exist)
 * Body: { admin_token: string, season?: string, dry_run?: boolean }
 */
app.post('/admin/cleanup-leaderboard', async (req, res) => {
    try {
        const { admin_token, season, dry_run = true } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const targetSeason = season || getCurrentSeason();
        const leaderboardKey = `leaderboard:${targetSeason}`;

        // Get all members from the sorted set
        const allMembers = await redis.zrange(leaderboardKey, 0, -1, { withScores: true });

        const orphaned = [];
        const valid = [];

        // Check each member
        for (const item of allMembers) {
            const unifiedId = item.member || item;
            const userData = await redis.get(`user:${unifiedId}`);

            if (!userData) {
                orphaned.push(unifiedId);
                if (!dry_run) {
                    await redis.zrem(leaderboardKey, unifiedId);
                }
            } else {
                valid.push(unifiedId);
            }
        }

        res.json({
            season: targetSeason,
            dry_run,
            total_checked: allMembers.length,
            valid_count: valid.length,
            orphaned_count: orphaned.length,
            orphaned_ids: orphaned,
            removed: dry_run ? 0 : orphaned.length
        });
    } catch (error) {
        console.error('Cleanup leaderboard error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /admin/trigger-season-reset
 * Manually trigger a season reset for all users
 * Body: { admin_token: string, new_season?: string, dry_run?: boolean }
 */
app.post('/admin/trigger-season-reset', async (req, res) => {
    try {
        const { admin_token, new_season, dry_run = true } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const targetSeason = new_season || getCurrentSeason();
        const resetResults = [];
        const errors = [];

        // Scan all user:* keys
        let cursor = "0";
        do {
            const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
            cursor = String(result[0]);

            for (const key of (result[1] || [])) {
                try {
                    const userData = await redis.get(key);
                    if (!userData) continue;

                    const user = typeof userData === 'string' ? JSON.parse(userData) : userData;
                    const unifiedId = key.replace('user:', '');

                    // Skip if already in target season
                    if (user.current_season === targetSeason) {
                        continue;
                    }

                    const oldSeason = user.current_season;
                    const oldLevel = user.level;
                    const oldXp = user.xp;

                    if (!dry_run) {
                        // Archive stats to all_time
                        if (!user.all_time_stats) user.all_time_stats = {};
                        user.all_time_stats.total_flashes = (user.all_time_stats.total_flashes || 0) + (user.stats?.total_flashes || 0);
                        user.all_time_stats.total_bubbles_popped = (user.all_time_stats.total_bubbles_popped || 0) + (user.stats?.total_bubbles_popped || 0);
                        user.all_time_stats.total_video_minutes = (user.all_time_stats.total_video_minutes || 0) + (user.stats?.total_video_minutes || 0);
                        user.all_time_stats.total_lock_cards_completed = (user.all_time_stats.total_lock_cards_completed || 0) + (user.stats?.total_lock_cards_completed || 0);
                        user.all_time_stats.seasons_completed = (user.all_time_stats.seasons_completed || 0) + 1;

                        // Update highest level if needed
                        user.highest_level_ever = Math.max(user.highest_level_ever || 0, user.level || 1);

                        // Recalculate unlocks
                        user.unlocks = calculateUnlocks(user.highest_level_ever);

                        // Reset seasonal data
                        user.xp = 0;
                        user.level = 1;
                        user.stats = {
                            total_flashes: 0,
                            total_bubbles_popped: 0,
                            total_video_minutes: 0,
                            total_lock_cards_completed: 0
                        };
                        user.current_season = targetSeason;
                        user.level_reset_at = new Date().toISOString();
                        delete user.oopsie_used_season;
                        user.updated_at = new Date().toISOString();

                        // Save user
                        await redis.set(key, JSON.stringify(user));

                        // Update leaderboard
                        if (oldSeason) {
                            await redis.zrem(`leaderboard:${oldSeason}`, unifiedId);
                        }
                        await redis.zadd(`leaderboard:${targetSeason}`, { score: 0, member: unifiedId });
                    }

                    resetResults.push({
                        unified_id: unifiedId,
                        display_name: user.display_name,
                        old_season: oldSeason,
                        old_level: oldLevel,
                        old_xp: oldXp,
                        new_season: targetSeason
                    });
                } catch (e) {
                    errors.push({ key, error: e.message });
                }
            }
        } while (cursor !== "0");

        console.log(`[ADMIN] Season reset to ${targetSeason}: ${resetResults.length} users (dry_run: ${dry_run})`);

        res.json({
            dry_run,
            target_season: targetSeason,
            users_reset: resetResults.length,
            results: resetResults,
            errors_count: errors.length,
            errors
        });
    } catch (error) {
        console.error('Admin trigger-season-reset error:', error.message);
        res.status(500).json({ error: 'Failed to trigger season reset' });
    }
});

/**
 * POST /admin/clear-leaderboard
 * Remove all entries from a season's leaderboard
 * Body: { admin_token: string, season?: string }
 */
app.post('/admin/clear-leaderboard', async (req, res) => {
    try {
        const { admin_token, season } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const targetSeason = season || getCurrentSeason();
        const key = `leaderboard:${targetSeason}`;
        const count = await redis.zcard(key);
        await redis.del(key);

        console.log(`[ADMIN] Cleared leaderboard ${key} (${count} entries)`);
        res.json({ success: true, season: targetSeason, entries_removed: count });
    } catch (error) {
        console.error('Admin clear-leaderboard error:', error.message);
        res.status(500).json({ error: 'Failed to clear leaderboard' });
    }
});

/**
 * POST /admin/reset-all-levels
 * Reset ALL users to level 1, xp 0, highest_level_ever 0
 * Keeps achievements, OG status, and stats
 * Body: { admin_token: string, dry_run?: boolean }
 */
app.post('/admin/reset-all-levels', async (req, res) => {
    try {
        const { admin_token, dry_run = true } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const currentSeason = getCurrentSeason();
        const results = [];
        const errors = [];

        let cursor = "0";
        do {
            const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
            cursor = String(result[0]);

            for (const key of (result[1] || [])) {
                try {
                    const userData = await redis.get(key);
                    if (!userData) continue;

                    const user = typeof userData === 'string' ? JSON.parse(userData) : userData;
                    const unifiedId = key.replace('user:', '');
                    const oldLevel = user.level;
                    const oldXp = user.xp;
                    const oldHighest = user.highest_level_ever;

                    if (!dry_run) {
                        // Preserve highest_level_ever so feature unlocks are permanent across seasons
                        user.highest_level_ever = Math.max(user.highest_level_ever || 0, user.level || 1);
                        user.level = 1;
                        user.xp = 0;
                        user.unlocks = calculateUnlocks(user.highest_level_ever);
                        user.skill_points = 1; // level 1 = 1 sparkle point
                        user.unlocked_skills = [];
                        user.force_skills_reset = true; // Tell client to clear local skills
                        user.level_reset_at = new Date().toISOString(); // Prevent client from pushing cached old values
                        delete user.level_reset; // Clean up old boolean flag
                        user.current_season = currentSeason;
                        user.updated_at = new Date().toISOString();

                        await redis.set(key, JSON.stringify(user));
                    }

                    results.push({
                        unified_id: unifiedId,
                        display_name: user.display_name,
                        old_level: oldLevel,
                        old_xp: oldXp,
                        old_highest: oldHighest
                    });
                } catch (e) {
                    errors.push({ key, error: e.message });
                }
            }
        } while (cursor !== "0");

        console.log(`[ADMIN] Reset all levels: ${results.length} users (dry_run: ${dry_run})`);

        res.json({
            dry_run,
            users_reset: results.length,
            results,
            errors_count: errors.length,
            errors
        });
    } catch (error) {
        console.error('Admin reset-all-levels error:', error.message);
        res.status(500).json({ error: 'Failed to reset levels' });
    }
});

/**
 * POST /v2/user/sync
 * Sync user progression (XP, level, achievements, stats) to the V2 system
 * Body: { unified_id: string, xp: number, level: number, achievements: string[], stats: object }
 */
app.post('/v2/user/sync', async (req, res) => {
    try {
        const { unified_id, xp, level, achievements, stats, unlocked_skills, skill_points, allow_discord_dm, show_online_status, share_profile_picture, reset_weekly_quest, reset_daily_quest, force_streak_override: clientForceStreakOverride, force_skills_reset: clientForceSkillsReset } = req.body;

        if (!unified_id) {
            return res.status(400).json({ error: 'unified_id required' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        // --- Anti-cheat: HMAC signature verification (Phase 3A — soft mode) ---
        const ccpTimestamp = req.headers['x-ccp-timestamp'];
        const ccpSignature = req.headers['x-ccp-signature'];
        let hmacValid = false;

        if (ccpTimestamp && ccpSignature) {
            const hmacSecret = process.env.CCP_HMAC_SECRET || 'ccp-anticheat-2026';
            const keyMaterial = `${unified_id}:${hmacSecret}`;
            const rawBody = JSON.stringify(req.body);
            const payload = `${ccpTimestamp}:${rawBody}`;

            const crypto = require('crypto');
            const expectedSig = crypto.createHmac('sha256', keyMaterial).update(payload).digest('hex');

            // Check timestamp within 5-minute window
            const tsAge = Math.abs(Date.now() / 1000 - parseInt(ccpTimestamp));

            if (expectedSig === ccpSignature && tsAge < 300) {
                hmacValid = true;
            } else {
                console.log(`[Anti-cheat] HMAC failed for ${unified_id}: sig_match=${expectedSig === ccpSignature}, ts_age=${Math.round(tsAge)}s`);
            }
        }
        // Phase 3a (soft): Log unsigned requests but don't reject them yet
        // Phase 3b (hard): Uncomment to reject:
        // if (!hmacValid) return res.status(403).json({ error: 'Invalid signature' });

        const userData = await redis.get(`user:${unified_id}`);
        if (!userData) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = typeof userData === 'string' ? JSON.parse(userData) : userData;

        // Check if user needs season reset (current_season doesn't match)
        const currentSeason = getCurrentSeason();
        let seasonResetPerformed = false;
        if (user.current_season && user.current_season !== currentSeason) {
            const oldSeason = user.current_season;
            console.log(`[V2 Sync] Auto-resetting user ${unified_id} from ${oldSeason} to ${currentSeason}`);

            // Archive stats to all_time
            if (!user.all_time_stats) user.all_time_stats = {};
            user.all_time_stats.total_flashes = (user.all_time_stats.total_flashes || 0) + (user.stats?.total_flashes || 0);
            user.all_time_stats.total_bubbles_popped = (user.all_time_stats.total_bubbles_popped || 0) + (user.stats?.total_bubbles_popped || 0);
            user.all_time_stats.total_video_minutes = (user.all_time_stats.total_video_minutes || 0) + (user.stats?.total_video_minutes || 0);
            user.all_time_stats.total_lock_cards_completed = (user.all_time_stats.total_lock_cards_completed || 0) + (user.stats?.total_lock_cards_completed || 0);
            user.all_time_stats.seasons_completed = (user.all_time_stats.seasons_completed || 0) + 1;

            // Update highest level before reset
            user.highest_level_ever = Math.max(user.highest_level_ever || 0, user.level || 1);
            user.unlocks = calculateUnlocks(user.highest_level_ever);

            // Reset seasonal data
            user.xp = 0;
            user.level = 1;
            user.stats = {
                total_flashes: 0,
                total_bubbles_popped: 0,
                total_video_minutes: 0,
                total_lock_cards_completed: 0
            };
            user.current_season = currentSeason;
            user.level_reset_at = new Date().toISOString();
            delete user.oopsie_used_season;

            // Add to new season leaderboard (don't touch old season — may be snapshotted)
            await redis.zadd(`leaderboard:${currentSeason}`, { score: 0, member: unified_id });

            seasonResetPerformed = true;
        }

        // Update progression
        const oldXp = user.xp || 0;
        const oldLevel = user.level || 1;
        const clientXp = xp || 0;
        const clientLevel = level || 1;

        let newXp, newLevel;
        const hadLevelReset = seasonResetPerformed || !!user.level_reset_at || user.level_reset === true;
        if (hadLevelReset) {
            // Client is "in agreement" if it's sending values close to server (accepted the reset)
            const clientAccepted = clientLevel <= oldLevel + 2 && clientXp <= oldXp + 10000;

            if (clientAccepted) {
                // Client has accepted the reset — clear flag, resume normal merge
                delete user.level_reset_at;
                delete user.level_reset;
                newXp = Math.max(oldXp, clientXp);
                newLevel = Math.max(oldLevel, clientLevel);
            } else {
                // Client still has old cached values — server stays authoritative
                newXp = oldXp;
                newLevel = oldLevel;
                // Migrate boolean flag to timestamp if needed
                if (!user.level_reset_at) {
                    user.level_reset_at = new Date().toISOString();
                }
                // Safety: after 7 days, give up and clear (shouldn't normally happen)
                const resetAge = Date.now() - new Date(user.level_reset_at).getTime();
                if (resetAge > 7 * 24 * 60 * 60 * 1000) {
                    delete user.level_reset_at;
                    delete user.level_reset;
                }
            }
        } else {
            newXp = Math.max(oldXp, clientXp);
            newLevel = Math.max(oldLevel, clientLevel);
        }

        // --- Anti-cheat: XP delta rate limiting (Phase 1A) ---
        const now = Date.now();
        const lastSyncAt = user.last_sync_at ? new Date(user.last_sync_at).getTime() : (now - 24 * 60 * 60 * 1000);
        const hoursSinceLastSync = Math.max(0.01, (now - lastSyncAt) / (1000 * 60 * 60));
        const MAX_XP_PER_HOUR = 50000;
        const MAX_XP_PER_SYNC = 25000;

        const xpDelta = newXp - oldXp;
        if (xpDelta > 0) {
            const maxAllowedDelta = Math.max(MAX_XP_PER_SYNC, MAX_XP_PER_HOUR * Math.min(hoursSinceLastSync, 24));
            if (xpDelta > maxAllowedDelta) {
                const clampedXp = oldXp + maxAllowedDelta;
                console.log(`[Anti-cheat] XP clamped for ${unified_id}: tried +${xpDelta}, allowed +${Math.round(maxAllowedDelta)}, clamped to ${Math.round(clampedXp)} (was ${oldXp})`);
                if (!user.anti_cheat_flags) user.anti_cheat_flags = [];
                user.anti_cheat_flags.push({
                    type: 'xp_delta_exceeded',
                    at: new Date().toISOString(),
                    attempted_xp: newXp,
                    clamped_xp: Math.round(clampedXp),
                    delta: xpDelta,
                    max_allowed: Math.round(maxAllowedDelta),
                    hours_since_sync: Math.round(hoursSinceLastSync * 100) / 100
                });
                // Keep only last 50 flags
                if (user.anti_cheat_flags.length > 50) {
                    user.anti_cheat_flags = user.anti_cheat_flags.slice(-50);
                }
                newXp = Math.round(clampedXp);
            }
        }

        user.last_sync_at = new Date().toISOString();

        // --- Anti-cheat: XP rate tracking (Phase 3B) ---
        if (xpDelta > 0) {
            if (!user.xp_rate) user.xp_rate = { hourly_samples: [] };
            user.xp_rate.hourly_samples.push({
                rate: Math.round(xpDelta / Math.max(hoursSinceLastSync, 0.01)),
                delta: xpDelta,
                hours: Math.round(hoursSinceLastSync * 100) / 100,
                at: new Date().toISOString(),
                hmac: hmacValid || false
            });
            // Keep only last 48 samples
            if (user.xp_rate.hourly_samples.length > 48) {
                user.xp_rate.hourly_samples = user.xp_rate.hourly_samples.slice(-48);
            }
        }

        // --- Anti-cheat: Level/XP consistency check (Phase 1B) ---
        if (newLevel > 1) {
            const cumulativeForPrevLevel = getCumulativeXPForLevel(newLevel - 1);
            const cumulativeForLevel = getCumulativeXPForLevel(newLevel);
            if (newXp < cumulativeForPrevLevel || newXp > cumulativeForLevel) {
                // Recalculate level from XP (trust XP over level)
                let recalcLevel = 1;
                let cumulativeCheck = 0;
                while (recalcLevel < 999) {
                    cumulativeCheck += getXPForLevel(recalcLevel);
                    if (newXp < cumulativeCheck) break;
                    recalcLevel++;
                }
                if (recalcLevel !== newLevel) {
                    console.log(`[Anti-cheat] Level/XP mismatch for ${unified_id}: level=${newLevel} xp=${newXp}, recalculated level=${recalcLevel}`);
                    if (!user.anti_cheat_flags) user.anti_cheat_flags = [];
                    user.anti_cheat_flags.push({
                        type: 'level_xp_mismatch',
                        at: new Date().toISOString(),
                        claimed_level: newLevel,
                        xp: newXp,
                        recalculated_level: recalcLevel
                    });
                    if (user.anti_cheat_flags.length > 50) {
                        user.anti_cheat_flags = user.anti_cheat_flags.slice(-50);
                    }
                    newLevel = recalcLevel;
                }
            }
        }

        user.xp = newXp;
        user.level = newLevel;
        user.last_seen = new Date().toISOString();
        user.updated_at = new Date().toISOString();

        // Update highest_level_ever for unlock tracking
        user.highest_level_ever = Math.max(user.highest_level_ever || 0, newLevel);

        // Recalculate unlocks based on highest_level_ever
        user.unlocks = calculateUnlocks(user.highest_level_ever);

        // Merge achievements (union of local and cloud)
        if (achievements && Array.isArray(achievements)) {
            const existingAchievements = new Set(user.achievements || []);
            for (const ach of achievements) {
                existingAchievements.add(ach);
            }
            user.achievements = Array.from(existingAchievements);
        }

        // Stats keys that are controlled by force_streak_override
        const STREAK_STAT_KEYS = new Set([
            'daily_quest_streak', 'last_daily_quest_date', 'quest_completion_dates',
            'total_daily_quests_completed', 'total_weekly_quests_completed', 'total_xp_from_quests'
        ]);
        const hasForceStreakOverride = user.force_streak_override === true;

        // --- Anti-cheat: Stats delta caps (Phase 1C) ---
        const STATS_MAX_PER_HOUR = {
            total_flashes: 700,
            total_bubbles_popped: 600,
            total_video_minutes: 70,
            total_lock_cards_completed: 30,
            completed_sessions: 5,
            longest_session_minutes: 480
        };

        // Merge stats (take HIGHER values, but skip streak stats if force_streak_override is active)
        if (stats && typeof stats === 'object') {
            user.stats = user.stats || {};
            for (const [key, value] of Object.entries(stats)) {
                // Skip streak stats when admin has force-set them - preserve admin values
                if (hasForceStreakOverride && STREAK_STAT_KEYS.has(key)) {
                    continue;
                }
                const numValue = Number(value) || 0;
                const existingValue = Number(user.stats[key]) || 0;

                if (STATS_MAX_PER_HOUR.hasOwnProperty(key)) {
                    // Known stat: cap the delta
                    const statDelta = numValue - existingValue;
                    if (statDelta > 0) {
                        const maxStatDelta = STATS_MAX_PER_HOUR[key] * Math.min(hoursSinceLastSync, 24);
                        if (statDelta > maxStatDelta) {
                            user.stats[key] = Math.round(existingValue + maxStatDelta);
                            console.log(`[Anti-cheat] Stat ${key} clamped for ${unified_id}: tried +${statDelta}, allowed +${Math.round(maxStatDelta)}`);
                            if (!user.anti_cheat_flags) user.anti_cheat_flags = [];
                            user.anti_cheat_flags.push({
                                type: 'stat_delta_exceeded',
                                at: new Date().toISOString(),
                                stat: key,
                                attempted_delta: statDelta,
                                max_allowed: Math.round(maxStatDelta)
                            });
                            if (user.anti_cheat_flags.length > 50) {
                                user.anti_cheat_flags = user.anti_cheat_flags.slice(-50);
                            }
                        } else {
                            user.stats[key] = numValue;
                        }
                    }
                    // If statDelta <= 0, keep existing (don't decrease)
                } else {
                    // Unknown/forward-compatible keys: use Math.max() (original behavior)
                    user.stats[key] = Math.max(existingValue, numValue);
                }
            }
        }

        // Update settings
        if (typeof allow_discord_dm === 'boolean') {
            user.allow_discord_dm = allow_discord_dm;
        }
        if (typeof show_online_status === 'boolean') {
            user.show_online_status = show_online_status;
        }
        if (typeof share_profile_picture === 'boolean') {
            user.share_profile_picture = share_profile_picture;
        }

        // Merge unlocked skills and skill points — but NOT during a level reset or skills reset
        // (client may be pushing old cached values from before the reset)
        const pendingSkillsReset = user.force_skills_reset === true;
        if (!hadLevelReset && !pendingSkillsReset) {
            // Capture server skill count BEFORE union merge so we can detect
            // when the client has purchased new skills (client count > pre-merge server count)
            const serverSkillCountBeforeMerge = (user.unlocked_skills || []).length;
            if (unlocked_skills && Array.isArray(unlocked_skills)) {
                const existingSkills = new Set(user.unlocked_skills || []);
                for (const skill of unlocked_skills) {
                    existingSkills.add(skill);
                }
                user.unlocked_skills = Array.from(existingSkills);
            }
            // Sync skill points: accept client value if they have more unlocked skills
            // (meaning they spent points on new skills), OR if they have more points (earned new ones)
            if (typeof skill_points === 'number') {
                const clientSkillCount = (unlocked_skills && Array.isArray(unlocked_skills)) ? unlocked_skills.length : 0;
                const serverSkillCount = serverSkillCountBeforeMerge;
                if (clientSkillCount > serverSkillCount) {
                    // Client has MORE skills — they spent points, trust their (lower) total
                    user.skill_points = skill_points;
                } else if (clientSkillCount === serverSkillCount) {
                    // Same skill count — take the higher value to preserve admin corrections
                    // while still allowing level-up point gains from client
                    user.skill_points = Math.max(skill_points, user.skill_points || 0);
                } else if (skill_points > (user.skill_points || 0)) {
                    // Client has fewer skills (stale data) but more points — take higher
                    user.skill_points = skill_points;
                }
            }
            // Floor: skill_points should never be below level when no skills are unlocked
            // This prevents stale clients from wiping out corrected values
            // Only apply when user has no unlocked skills (otherwise points were legitimately spent)
            if ((user.unlocked_skills || []).length === 0) {
                const currentLevel = user.level || 1;
                if ((user.skill_points || 0) < currentLevel) {
                    user.skill_points = currentLevel;
                }
            }
        }

        // Handle quest reset flags - capture before clearing
        const pendingResetWeekly = user.reset_weekly_quest === true;
        const pendingResetDaily = user.reset_daily_quest === true;

        // Clear reset flags when client acknowledges (sends false)
        if (reset_weekly_quest === false) {
            delete user.reset_weekly_quest;
        }
        if (reset_daily_quest === false) {
            delete user.reset_daily_quest;
        }

        // Handle force_streak_override flag - capture before clearing
        const pendingForceStreakOverride = hasForceStreakOverride;

        // Clear force_streak_override when client acknowledges (sends false)
        if (clientForceStreakOverride === false) {
            delete user.force_streak_override;
        }

        // Handle force_skills_reset flag - capture before clearing
        const pendingForceSkillsReset = user.force_skills_reset === true;

        // Clear force_skills_reset when client acknowledges (sends false)
        if (clientForceSkillsReset === false) {
            delete user.force_skills_reset;
        }

        // Auto-flag OG if user has achievements but isn't flagged yet
        if (!user.is_season0_og && user.achievements?.length > 0) {
            user.is_season0_og = true;
            console.log(`[V2 Sync] Auto-flagged OG for ${unified_id} (has ${user.achievements.length} achievements)`);
        }

        // Save updated user
        await redis.set(`user:${unified_id}`, JSON.stringify(user));

        // Update leaderboard sorted set with new XP
        const season = user.current_season || getCurrentSeason();
        await redis.zadd(`leaderboard:${season}`, { score: newXp, member: unified_id });

        console.log(`[V2 Sync] User ${unified_id} (${user.display_name}): Level ${oldLevel}->${newLevel}, XP ${oldXp}->${newXp}`);

        res.json({
            success: true,
            user: {
                unified_id: user.unified_id,
                display_name: user.display_name,
                level: user.level,
                xp: user.xp,
                achievements: user.achievements,
                highest_level_ever: user.highest_level_ever,
                unlocks: user.unlocks
            },
            merged: oldXp !== newXp || oldLevel !== newLevel,
            // Include pending reset flags so client can process them
            reset_weekly_quest: pendingResetWeekly,
            reset_daily_quest: pendingResetDaily,
            // Include force_streak_override flag and streak stats so client can adopt them
            force_streak_override: pendingForceStreakOverride,
            ...(pendingForceStreakOverride ? {
                streak_stats: {
                    daily_quest_streak: user.stats?.daily_quest_streak || 0,
                    last_daily_quest_date: user.stats?.last_daily_quest_date || '',
                    quest_completion_dates: user.stats?.quest_completion_dates || [],
                    total_daily_quests_completed: user.stats?.total_daily_quests_completed || 0,
                    total_weekly_quests_completed: user.stats?.total_weekly_quests_completed || 0,
                    total_xp_from_quests: user.stats?.total_xp_from_quests || 0
                }
            } : {}),
            // Include OG status so client stays in sync (e.g. if set retroactively by admin)
            is_season0_og: user.is_season0_og || false,
            // Include oopsie insurance season usage
            oopsie_used_season: user.oopsie_used_season || null,
            // Always include skill_points and unlocked_skills so client stays in sync
            skill_points: user.skill_points || 0,
            unlocked_skills: user.unlocked_skills || [],
            // Include force_skills_reset flag
            force_skills_reset: pendingForceSkillsReset,
            // Level reset flag — tells client to accept server level/xp
            level_reset: hadLevelReset,
            // Include server's authoritative level/xp when reset is active
            ...(hadLevelReset ? { server_level: user.level, server_xp: user.xp } : {}),
            // Include whitelist status so Discord-only users get Patreon features without OAuth
            patreon_is_whitelisted: user.patreon_is_whitelisted || false
        });
    } catch (error) {
        console.error('V2 sync error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v2/user/heartbeat
 * Update user's last_seen timestamp (for online status)
 * Body: { unified_id: string }
 */
app.post('/v2/user/heartbeat', async (req, res) => {
    try {
        const { unified_id, is_active, in_session, app_version } = req.body;

        if (!unified_id) {
            return res.status(400).json({ error: 'unified_id required' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const userData = await redis.get(`user:${unified_id}`);
        if (!userData) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = typeof userData === 'string' ? JSON.parse(userData) : userData;
        user.last_seen = new Date().toISOString();

        // Store enriched heartbeat data for anti-cheat cross-referencing
        user.last_heartbeat = {
            at: user.last_seen,
            is_active: is_active ?? null,
            in_session: in_session ?? null,
            app_version: app_version ?? null
        };

        await redis.set(`user:${unified_id}`, JSON.stringify(user));

        res.json({ success: true, last_seen: user.last_seen });
    } catch (error) {
        console.error('V2 heartbeat error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /admin/import-patreon-members
 * Import Patreon members from CSV export as Season 0 OG users
 * Body: { admin_token: string, members: Array<{name, email, patreon_id}>, dry_run?: boolean }
 */
app.post('/admin/import-patreon-members', async (req, res) => {
    try {
        const { admin_token, members, dry_run = true } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });
        if (!members || !Array.isArray(members)) {
            return res.status(400).json({ error: 'members array required' });
        }

        const imported = [];
        const skipped = [];
        const errors = [];

        for (const member of members) {
            try {
                const { name, email, patreon_id } = member;

                if (!patreon_id) {
                    skipped.push({ name, reason: 'no patreon_id' });
                    continue;
                }

                // Check if season0 entry already exists
                const existingKey = `season0:patreon:${patreon_id}`;
                const existing = await redis.get(existingKey);

                if (existing) {
                    skipped.push({ name, patreon_id, reason: 'already exists' });
                    continue;
                }

                // Create minimal season0 entry for this Patreon member
                // They get OG status even if they never logged into the app
                const season0Data = {
                    display_name: name || null,
                    patreon_id: patreon_id,
                    discord_id: null,
                    email: email || null,
                    highest_level_ever: 0,  // Never played, but still OG
                    achievements: [],
                    stats: {
                        total_flashes: 0,
                        total_bubbles_popped: 0,
                        total_video_minutes: 0,
                        total_lock_cards_completed: 0
                    },
                    unlocks: calculateUnlocks(0),
                    patreon_tier: 0,
                    patreon_is_active: false,
                    patreon_is_whitelisted: false,
                    is_patreon_member: true,  // Flag that this came from Patreon export
                    captured_at: new Date().toISOString()
                };

                if (!dry_run) {
                    await redis.set(existingKey, JSON.stringify(season0Data));
                }

                imported.push({
                    name,
                    patreon_id,
                    email: email ? '***' : null  // Don't expose full email in response
                });
            } catch (e) {
                errors.push({ member, error: e.message });
            }
        }

        console.log(`[ADMIN] Import Patreon members: ${imported.length} imported, ${skipped.length} skipped (dry_run: ${dry_run})`);

        res.json({
            dry_run,
            total_input: members.length,
            imported_count: imported.length,
            skipped_count: skipped.length,
            errors_count: errors.length,
            imported,
            skipped,
            errors
        });
    } catch (error) {
        console.error('Admin import-patreon-members error:', error.message);
        res.status(500).json({ error: 'Failed to import Patreon members' });
    }
});

// =============================================================================
// MARQUEE BANNER CONFIG
// =============================================================================

const MARQUEE_KEY = 'config:marquee_message';
const DEFAULT_MARQUEE = 'GOOD GIRLS CONDITION DAILY     ❤️🔒';

/**
 * GET /config/marquee
 * Returns the current marquee banner message (public, no auth required)
 */
app.get('/config/marquee', async (req, res) => {
    try {
        const message = await redis.get(MARQUEE_KEY);
        res.json({ message: message || DEFAULT_MARQUEE });
    } catch (error) {
        console.error('Get marquee error:', error.message);
        res.json({ message: DEFAULT_MARQUEE });
    }
});

/**
 * POST /config/marquee
 * Set the marquee banner message (admin only - requires specific admin token)
 * Body: { message: string, admin_token: string }
 */
app.post('/config/marquee', async (req, res) => {
    try {
        const { message, admin_token } = req.body;

        // Simple admin token check (set ADMIN_TOKEN in environment)
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!message || typeof message !== 'string') {
            return res.status(400).json({ error: 'Message is required' });
        }

        const trimmedMessage = message.trim();
        if (trimmedMessage.length > 200) {
            return res.status(400).json({ error: 'Message too long (max 200 characters)' });
        }

        await redis.set(MARQUEE_KEY, trimmedMessage);
        console.log(`Marquee message updated to: ${trimmedMessage}`);

        res.json({ success: true, message: trimmedMessage });
    } catch (error) {
        console.error('Set marquee error:', error.message);
        res.status(500).json({ error: 'Failed to update marquee' });
    }
});

// =============================================================================
// UPDATE BANNER CONFIG (Server-controlled update notification fallback)
// =============================================================================

const UPDATE_BANNER_KEY = 'config:update_banner';

/**
 * GET /config/update-banner
 * Returns update banner configuration (public, no auth required)
 * Response: { enabled: boolean, version: string, message: string }
 */
app.get('/config/update-banner', async (req, res) => {
    try {
        const data = await redis.get(UPDATE_BANNER_KEY);
        if (data) {
            const config = typeof data === 'string' ? JSON.parse(data) : data;
            res.json(config);
        } else {
            // Default: no urgent update
            res.json({ enabled: false, version: '', message: '' });
        }
    } catch (error) {
        console.error('Get update-banner error:', error.message);
        res.json({ enabled: false, version: '', message: '' });
    }
});

/**
 * POST /config/update-banner
 * Set the update banner configuration (admin only)
 * Body: { enabled: boolean, version: string, message: string, url: string, admin_token: string }
 *
 * Examples:
 * - Enable: { "enabled": true, "version": "5.3", "message": "v5.3 is out!", "url": "https://example.com", "admin_token": "xxx" }
 * - Disable: { "enabled": false, "admin_token": "xxx" }
 */
app.post('/config/update-banner', async (req, res) => {
    try {
        const { enabled, version, message, url, admin_token } = req.body;

        // Simple admin token check
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const config = {
            enabled: !!enabled,
            version: version || '',
            message: message || 'UPDATE AVAILABLE!',
            url: url || ''
        };

        await redis.set(UPDATE_BANNER_KEY, JSON.stringify(config));
        console.log(`Update banner config updated:`, config);

        res.json({ success: true, config });
    } catch (error) {
        console.error('Set update-banner error:', error.message);
        res.status(500).json({ error: 'Failed to update banner config' });
    }
});

// =============================================================================
// SERVER-TRIGGERED ANNOUNCEMENT POPUP
// =============================================================================

const ANNOUNCEMENT_KEY = 'config:announcement';

/**
 * GET /config/announcement
 * Public endpoint to fetch the current announcement.
 * Optional query param: unified_id — if provided, checks for a per-user announcement first.
 * Returns: { enabled, id, title, message, image_url }
 */
app.get('/config/announcement', async (req, res) => {
    try {
        const { unified_id } = req.query;

        // Check for per-user announcement first
        if (unified_id && redis) {
            const userKey = `user:${unified_id}`;
            const userData = await redis.get(userKey);
            if (userData) {
                const user = typeof userData === 'string' ? JSON.parse(userData) : userData;
                if (user.announcement && user.announcement.enabled) {
                    return res.json({
                        enabled: true,
                        id: user.announcement.id,
                        title: user.announcement.title || '',
                        message: user.announcement.message || '',
                        image_url: user.announcement.image_url || null
                    });
                }
            }
        }

        // Fall back to global announcement
        if (!redis) {
            return res.json({ enabled: false });
        }

        const data = await redis.get(ANNOUNCEMENT_KEY);
        if (!data) {
            return res.json({ enabled: false });
        }

        const config = typeof data === 'string' ? JSON.parse(data) : data;
        res.json({
            enabled: !!config.enabled,
            id: config.id || '',
            title: config.title || '',
            message: config.message || '',
            image_url: config.image_url || null
        });
    } catch (error) {
        console.error('Get announcement error:', error.message);
        res.json({ enabled: false });
    }
});

/**
 * POST /config/announcement
 * Admin-only: set the global announcement shown to all users.
 * Body: { enabled, id?, title, message, image_url?, admin_token }
 * If id is omitted, auto-generates from timestamp.
 */
app.post('/config/announcement', async (req, res) => {
    try {
        const { enabled, id, title, message, image_url, admin_token } = req.body;

        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const config = {
            enabled: !!enabled,
            id: id || `ann_${Date.now()}`,
            title: title || '',
            message: message || '',
            image_url: image_url || null
        };

        await redis.set(ANNOUNCEMENT_KEY, JSON.stringify(config));
        console.log(`Announcement config updated:`, config);

        res.json({ success: true, config });
    } catch (error) {
        console.error('Set announcement error:', error.message);
        res.status(500).json({ error: 'Failed to update announcement config' });
    }
});

/**
 * POST /admin/user-announcement
 * Admin-only: set a per-user announcement targeting a specific user by display_name.
 * Body: { display_name, enabled, id?, title, message, image_url?, admin_token }
 * Stores announcement object inside the user's profile in Redis.
 */
app.post('/admin/user-announcement', async (req, res) => {
    try {
        const { display_name, enabled, id, title, message, image_url, admin_token } = req.body;

        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!display_name) {
            return res.status(400).json({ error: 'display_name is required' });
        }

        if (!redis) {
            return res.status(503).json({ error: 'Redis not available' });
        }

        // Find user by display_name index
        const indexKey = `display_name_index:${display_name.trim().toLowerCase()}`;
        const unifiedId = await redis.get(indexKey);

        if (!unifiedId) {
            return res.status(404).json({ error: `User "${display_name}" not found` });
        }

        const userKey = `user:${unifiedId}`;
        const userData = await redis.get(userKey);

        if (!userData) {
            return res.status(404).json({ error: `User data for "${display_name}" not found` });
        }

        const user = typeof userData === 'string' ? JSON.parse(userData) : userData;

        user.announcement = {
            enabled: !!enabled,
            id: id || `ann_user_${Date.now()}`,
            title: title || '',
            message: message || '',
            image_url: image_url || null
        };

        await redis.set(userKey, JSON.stringify(user));
        console.log(`[ADMIN] User announcement set for "${display_name}" (${unifiedId}):`, user.announcement);

        res.json({ success: true, unified_id: unifiedId, announcement: user.announcement });
    } catch (error) {
        console.error('Admin user-announcement error:', error.message);
        res.status(500).json({ error: 'Failed to set user announcement' });
    }
});

// =============================================================================
// CONTENT PACK DOWNLOAD SYSTEM
// =============================================================================

const crypto = require('crypto');

// Bunny.net CDN configuration
const BUNNY_CONFIG = {
    CDN_HOSTNAME: 'ccp-packs.b-cdn.net',
    SECURITY_KEY: process.env.BUNNY_SECURITY_KEY || '21695efe-4970-4678-9ce9-f01964ff4163',
    URL_EXPIRY_SECONDS: 3600 // 1 hour
};

// Pack download rate limiting
const PACK_RATE_LIMIT = {
    DOWNLOADS_PER_DAY: 4,  // Max downloads per pack per day
    KEY_PREFIX: 'packdownload:'
};

// Monthly bandwidth limits (in bytes)
const BANDWIDTH_LIMIT = {
    FREE_USER_BYTES: 10 * 1024 * 1024 * 1024,      // 10 GB per month for free users
    PATREON_USER_BYTES: 100 * 1024 * 1024 * 1024,  // 100 GB per month for Patreon users
    KEY_PREFIX: 'bandwidth:'
};

// Pending download tracking - bandwidth is only finalized after download completes
const PENDING_DOWNLOAD = {
    KEY_PREFIX: 'pending_download:',
    GRACE_PERIOD_MINUTES: 30  // Auto-finalize pending downloads after this time
};

// Available packs
// =============================================================================
// CONTENT PACKS CONFIGURATION
// Server-controlled pack list - can be updated without app release
// Set enabled: false to hide a pack from users
// =============================================================================
const AVAILABLE_PACKS = {
    'basic-bimbo-starter': {
        enabled: true,
        name: 'Basic Bimbo Starter Pack',
        description: 'A starter pack with essential bimbo content. Perfect for new users getting started with their conditioning journey.',
        author: 'CodeBambi',
        version: '1.0.0',
        imageCount: 50,
        videoCount: 10,
        path: '/Basic%20Bimbo%20Starter%20Pack.zip',
        sizeBytes: 2397264867,
        previewImageUrl: 'https://ccp-packs.b-cdn.net/previews/basic-bimbo-starter.png',
        patreonUrl: 'https://patreon.com/CodeBambi'
    },
    'enhanced-bimbodoll-video': {
        enabled: true,
        name: 'Enhanced Bimbodoll Video Pack',
        description: 'High quality video content for advanced conditioning. Includes mesmerizing visuals and deep programming.',
        author: 'CodeBambi',
        version: '1.0.0',
        imageCount: 0,
        videoCount: 25,
        path: '/Enhanced%20Bimbodoll%20video%20pack.zip',
        sizeBytes: 4392954093,
        previewImageUrl: 'https://ccp-packs.b-cdn.net/previews/enhanced-bimbodoll-video.png',
        patreonUrl: 'https://patreon.com/CodeBambi'
    },
    'bambi-core': {
        enabled: true,
        name: 'Bambi Core Collection',
        description: 'The essential Bambi transformation pack. 217 carefully curated images to help awaken your inner Bambi. Perfect for deep conditioning sessions. Special thanks to Issa for providing the pack ❤️',
        author: 'CodeBambi',
        version: '1.0.0',
        imageCount: 217,
        videoCount: 0,
        path: '/bambi-core.zip',
        sizeBytes: 1289338675,
        previewImageUrl: 'https://ccp-packs.b-cdn.net/previews/bambi-core.png',
        previewUrls: [
            'https://ccp-packs.b-cdn.net/previews/bambi-core-1.gif',
            'https://ccp-packs.b-cdn.net/previews/bambi-core-2.gif',
            'https://ccp-packs.b-cdn.net/previews/bambi-core-3.gif',
            'https://ccp-packs.b-cdn.net/previews/bambi-core-4.gif',
            'https://ccp-packs.b-cdn.net/previews/bambi-core-5.gif',
            'https://ccp-packs.b-cdn.net/previews/bambi-core-6.gif'
        ],
        patreonUrl: 'https://patreon.com/CodeBambi'
    },
    'bimbo-aesthetic': {
        enabled: true,
        name: 'Bimbo Aesthetic Pack',
        description: 'Embrace the bimbo lifestyle with 106 gorgeous images. Pink, pretty, and perfectly vapid. Let these images remind you what you\'re becoming. Special thanks to Issa for providing the pack ❤️',
        author: 'CodeBambi',
        version: '1.0.0',
        imageCount: 106,
        videoCount: 0,
        path: '/bimbo-aesthetic.zip',
        sizeBytes: 540674867,
        previewImageUrl: 'https://ccp-packs.b-cdn.net/previews/bimbo-aesthetic.png',
        previewUrls: [
            'https://ccp-packs.b-cdn.net/previews/bimbo-aesthetic-1.gif',
            'https://ccp-packs.b-cdn.net/previews/bimbo-aesthetic-2.jpg',
            'https://ccp-packs.b-cdn.net/previews/bimbo-aesthetic-3.gif',
            'https://ccp-packs.b-cdn.net/previews/bimbo-aesthetic-4.webp',
            'https://ccp-packs.b-cdn.net/previews/bimbo-aesthetic-5.gif',
            'https://ccp-packs.b-cdn.net/previews/bimbo-aesthetic-6.gif'
        ],
        patreonUrl: 'https://patreon.com/CodeBambi'
    },
    'cock-drop': {
        enabled: true,
        name: 'Cock Drop Conditioning',
        description: '89 hypnotic images for devoted cock-loving bambis. Every flash drops you deeper into cock-obsessed bliss. Warning: Highly addictive. Special thanks to Issa for providing the pack ❤️',
        author: 'CodeBambi',
        version: '1.0.0',
        imageCount: 89,
        videoCount: 0,
        path: '/cock-drop.zip',
        sizeBytes: 421955994,
        previewImageUrl: 'https://ccp-packs.b-cdn.net/previews/cock-drop.png',
        previewUrls: [
            'https://ccp-packs.b-cdn.net/previews/cock-drop-1.gif',
            'https://ccp-packs.b-cdn.net/previews/cock-drop-2.webp',
            'https://ccp-packs.b-cdn.net/previews/cock-drop-3.webp',
            'https://ccp-packs.b-cdn.net/previews/cock-drop-4.gif',
            'https://ccp-packs.b-cdn.net/previews/cock-drop-5.gif',
            'https://ccp-packs.b-cdn.net/previews/cock-drop-6.gif'
        ],
        patreonUrl: 'https://patreon.com/CodeBambi'
    },
    'empty-head': {
        enabled: true,
        name: 'Empty Head Happy Head',
        description: '276 mind-melting images to help empty that pretty little head. No thoughts, just Bambi. The largest pack for maximum brain drain. Special thanks to Issa for providing the pack ❤️',
        author: 'CodeBambi',
        version: '1.0.0',
        imageCount: 276,
        videoCount: 0,
        path: '/empty-head.zip',
        sizeBytes: 1465909698,
        previewImageUrl: 'https://ccp-packs.b-cdn.net/previews/empty-head.png',
        previewUrls: [
            'https://ccp-packs.b-cdn.net/previews/empty-head-1.gif',
            'https://ccp-packs.b-cdn.net/previews/empty-head-2.gif',
            'https://ccp-packs.b-cdn.net/previews/empty-head-3.gif',
            'https://ccp-packs.b-cdn.net/previews/empty-head-4.gif',
            'https://ccp-packs.b-cdn.net/previews/empty-head-5.gif',
            'https://ccp-packs.b-cdn.net/previews/empty-head-6.gif'
        ],
        patreonUrl: 'https://patreon.com/CodeBambi'
    },
    'good-girl': {
        enabled: true,
        name: 'Good Girl Rewards',
        description: '77 images of praise and positive reinforcement. Because every good girl deserves to feel validated. Let Bambi know she\'s doing so well. Special thanks to Issa for providing the pack ❤️',
        author: 'CodeBambi',
        version: '1.0.0',
        imageCount: 77,
        videoCount: 0,
        path: '/good-girl.zip',
        sizeBytes: 382876098,
        previewImageUrl: 'https://ccp-packs.b-cdn.net/previews/good-girl.png',
        previewUrls: [
            'https://ccp-packs.b-cdn.net/previews/good-girl-1.gif',
            'https://ccp-packs.b-cdn.net/previews/good-girl-2.gif',
            'https://ccp-packs.b-cdn.net/previews/good-girl-3.gif',
            'https://ccp-packs.b-cdn.net/previews/good-girl-4.gif',
            'https://ccp-packs.b-cdn.net/previews/good-girl-5.gif',
            'https://ccp-packs.b-cdn.net/previews/good-girl-6.gif'
        ],
        patreonUrl: 'https://patreon.com/CodeBambi'
    },
    'pretty-girl': {
        enabled: true,
        name: 'Pretty Girl Dreams',
        description: '68 beautiful feminine images to inspire your transformation. Soft, pretty, and undeniably girly. Be the girl you were always meant to be. Special thanks to Issa for providing the pack ❤️',
        author: 'CodeBambi',
        version: '1.0.0',
        imageCount: 68,
        videoCount: 0,
        path: '/pretty-girl.zip',
        sizeBytes: 489951068,
        previewImageUrl: 'https://ccp-packs.b-cdn.net/previews/pretty-girl.png',
        previewUrls: [
            'https://ccp-packs.b-cdn.net/previews/pretty-girl-1.gif',
            'https://ccp-packs.b-cdn.net/previews/pretty-girl-2.gif',
            'https://ccp-packs.b-cdn.net/previews/pretty-girl-3.gif',
            'https://ccp-packs.b-cdn.net/previews/pretty-girl-4.gif',
            'https://ccp-packs.b-cdn.net/previews/pretty-girl-5.gif',
            'https://ccp-packs.b-cdn.net/previews/pretty-girl-6.gif'
        ],
        patreonUrl: 'https://patreon.com/CodeBambi'
    },
    'bimbo-moo': {
        enabled: true,
        name: 'Bimbo Cow Collection',
        description: '140 hucow-themed images for bambis who love to moo. Big, dumb, and happy. Perfect for those special udderly mindless sessions. Special thanks to Issa for providing the pack ❤️',
        author: 'CodeBambi',
        version: '1.0.0',
        imageCount: 140,
        videoCount: 0,
        path: '/bimbo-moo.zip',
        sizeBytes: 670223564,
        previewImageUrl: 'https://ccp-packs.b-cdn.net/previews/bimbo-moo.png',
        previewUrls: [
            'https://ccp-packs.b-cdn.net/previews/bimbo-moo-1.webp',
            'https://ccp-packs.b-cdn.net/previews/bimbo-moo-2.gif',
            'https://ccp-packs.b-cdn.net/previews/bimbo-moo-3.gif',
            'https://ccp-packs.b-cdn.net/previews/bimbo-moo-4.gif',
            'https://ccp-packs.b-cdn.net/previews/bimbo-moo-5.png',
            'https://ccp-packs.b-cdn.net/previews/bimbo-moo-6.jpeg'
        ],
        patreonUrl: 'https://patreon.com/CodeBambi'
    },
    'toon-bimbos': {
        enabled: true,
        name: 'Toon Bimbo Fantasy',
        description: '61 cartoon and animated bimbo images. Exaggerated curves, bright colors, and impossible proportions. Perfect fantasy fuel for your conditioning. Special thanks to Issa for providing the pack ❤️',
        author: 'CodeBambi',
        version: '1.0.0',
        imageCount: 61,
        videoCount: 0,
        path: '/toon-bimbos.zip',
        sizeBytes: 365567795,
        previewImageUrl: 'https://ccp-packs.b-cdn.net/previews/toon-bimbos.png',
        previewUrls: [
            'https://ccp-packs.b-cdn.net/previews/toon-bimbos-1.gif',
            'https://ccp-packs.b-cdn.net/previews/toon-bimbos-2.gif',
            'https://ccp-packs.b-cdn.net/previews/toon-bimbos-3.jpg',
            'https://ccp-packs.b-cdn.net/previews/toon-bimbos-4.gif',
            'https://ccp-packs.b-cdn.net/previews/toon-bimbos-5.gif',
            'https://ccp-packs.b-cdn.net/previews/toon-bimbos-6.gif'
        ],
        patreonUrl: 'https://patreon.com/CodeBambi'
    }
};

/**
 * Generate Bunny.net download URL
 * Token auth disabled for now - using rate limiting via Patreon auth instead
 */
function generateDownloadUrl(filePath) {
    // Direct URL without token (token auth disabled on Bunny pull zone)
    // Security is handled by requiring Patreon auth + rate limiting
    return `https://${BUNNY_CONFIG.CDN_HOSTNAME}${filePath}`;
}

/**
 * GET /packs/manifest
 * Returns the list of available content packs (server-controlled)
 * Only returns enabled packs - allows adding/removing/disabling without app update
 * No auth required - just returns the pack catalog
 */
app.get('/packs/manifest', (req, res) => {
    try {
        // Build pack list from AVAILABLE_PACKS, only including enabled packs
        const packs = [];

        for (const [packId, pack] of Object.entries(AVAILABLE_PACKS)) {
            // Skip disabled packs
            if (pack.enabled === false) {
                continue;
            }

            packs.push({
                id: packId,
                name: pack.name,
                description: pack.description || '',
                author: pack.author || 'CodeBambi',
                version: pack.version || '1.0.0',
                imageCount: pack.imageCount || 0,
                videoCount: pack.videoCount || 0,
                sizeBytes: pack.sizeBytes || 0,
                downloadUrl: `https://${BUNNY_CONFIG.CDN_HOSTNAME}${pack.path}`,
                previewImageUrl: pack.previewImageUrl || '',
                previewUrls: pack.previewUrls || [],
                patreonUrl: pack.patreonUrl || null,
                upgradeUrl: pack.upgradeUrl || null
            });
        }

        console.log(`Packs manifest requested: returning ${packs.length} enabled packs`);

        res.json({
            version: '1.0',
            packs: packs
        });

    } catch (error) {
        console.error('Packs manifest error:', error.message);
        res.status(500).json({
            version: '1.0',
            packs: [],
            error: 'Failed to load packs manifest'
        });
    }
});

/**
 * Check pack download rate limit
 * Returns { allowed: boolean, remaining: number, resetTime: Date }
 */
async function checkPackDownloadLimit(userId, packId) {
    if (!redis) {
        // No Redis = no rate limiting, allow download
        return { allowed: true, remaining: PACK_RATE_LIMIT.DOWNLOADS_PER_DAY, used: 0 };
    }

    const todayKey = getTodayKey();
    const key = `${PACK_RATE_LIMIT.KEY_PREFIX}${userId}:${packId}:${todayKey}`;

    try {
        let count = await redis.get(key) || 0;
        count = parseInt(count) || 0;

        // Calculate reset time (midnight UTC)
        const now = new Date();
        const resetTime = new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
            0, 0, 0
        ));

        if (count >= PACK_RATE_LIMIT.DOWNLOADS_PER_DAY) {
            return {
                allowed: false,
                remaining: 0,
                used: count,
                resetTime: resetTime.toISOString()
            };
        }

        return {
            allowed: true,
            remaining: PACK_RATE_LIMIT.DOWNLOADS_PER_DAY - count,
            used: count,
            resetTime: resetTime.toISOString()
        };
    } catch (error) {
        console.error('Pack rate limit check error:', error.message);
        // On error, allow download but log it
        return { allowed: true, remaining: 1, used: 0, error: true };
    }
}

/**
 * Increment pack download count
 */
async function incrementPackDownload(userId, packId) {
    if (!redis) return;

    const todayKey = getTodayKey();
    const key = `${PACK_RATE_LIMIT.KEY_PREFIX}${userId}:${packId}:${todayKey}`;

    try {
        const newCount = await redis.incr(key);
        // Set expiry for 48 hours (cleanup old keys)
        if (newCount === 1) {
            await redis.expire(key, 172800);
        }
        console.log(`Pack download recorded: user=${userId}, pack=${packId}, count=${newCount}`);
    } catch (error) {
        console.error('Failed to increment pack download:', error.message);
    }
}

/**
 * POST /pack/download-url
 * Get a signed download URL for a content pack
 * Requires: Authorization: Bearer <patreon_access_token>
 * Body: { packId: string }
 */
app.post('/pack/download-url', async (req, res) => {
    try {
        // Validate authorization
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({
                error: 'Authorization required',
                message: 'Please log in with Patreon to download content packs.'
            });
        }

        const accessToken = authHeader.substring(7);

        // Validate Patreon token and get user info
        let identity;
        try {
            identity = await getPatreonIdentity(accessToken);
        } catch (error) {
            return res.status(401).json({
                error: 'Invalid token',
                message: 'Your Patreon session has expired. Please log in again.'
            });
        }

        const userId = identity.data?.id;
        if (!userId) {
            return res.status(401).json({
                error: 'Invalid user',
                message: 'Could not identify Patreon user.'
            });
        }

        // Validate pack ID
        const { packId } = req.body;
        if (!packId || !AVAILABLE_PACKS[packId]) {
            return res.status(400).json({
                error: 'Invalid pack',
                message: 'The requested content pack does not exist.'
            });
        }

        const pack = AVAILABLE_PACKS[packId];

        // Fetch display_name for whitelist check
        let displayName = null;
        try {
            const profileKey = `${PROFILE_KEY_PREFIX}${userId}`;
            const profileData = await redis.get(profileKey);
            if (profileData) {
                const profile = typeof profileData === 'string' ? JSON.parse(profileData) : profileData;
                displayName = profile.display_name || null;
            }
        } catch (e) { /* ignore */ }

        // Check if user is an active Patreon supporter or whitelisted
        const tierInfo = determineTier(identity);
        const whitelisted = isWhitelisted(tierInfo.patron_email, tierInfo.patron_name, displayName);
        // Any active patron gets the higher bandwidth limit (not just tier > 0)
        const isPatreon = tierInfo.is_active || whitelisted;

        // Check bandwidth limit
        const bandwidthCheck = await checkBandwidthLimit(userId, isPatreon, pack.sizeBytes);
        if (!bandwidthCheck.allowed) {
            const limitDisplay = formatBytes(bandwidthCheck.limitBytes);
            const usedDisplay = formatBytes(bandwidthCheck.usedBytes);
            return res.status(429).json({
                error: 'Bandwidth limit exceeded',
                message: `You've used ${usedDisplay} of your ${limitDisplay} monthly bandwidth limit.${!isPatreon ? ' Upgrade to Patreon for 100 GB/month!' : ''}`,
                resetTime: bandwidthCheck.resetTime,
                usedBytes: bandwidthCheck.usedBytes,
                limitBytes: bandwidthCheck.limitBytes,
                isPatreon: isPatreon
            });
        }

        // Check rate limit
        const rateLimit = await checkPackDownloadLimit(userId, packId);
        if (!rateLimit.allowed) {
            return res.status(429).json({
                error: 'Rate limit exceeded',
                message: `You've reached the download limit for this pack today (${PACK_RATE_LIMIT.DOWNLOADS_PER_DAY} per day). Try again after midnight UTC.`,
                resetTime: rateLimit.resetTime,
                remaining: 0
            });
        }

        // Generate signed URL
        const downloadUrl = generateDownloadUrl(pack.path);

        // Record the download rate limit (still immediate - prevents abuse)
        await incrementPackDownload(userId, packId);

        // Create pending download - bandwidth is NOT charged until download completes
        // This prevents users from losing bandwidth on failed/cancelled downloads
        const downloadId = await createPendingDownload(userId, packId, pack.sizeBytes);

        // Get updated rate limit status
        const newRateLimit = await checkPackDownloadLimit(userId, packId);

        // Get current bandwidth status (doesn't include pending)
        const currentBandwidth = await checkBandwidthLimit(userId, isPatreon, 0);

        console.log(`Pack download URL generated: user=${userId}, pack=${packId}, downloadId=${downloadId}, patreon=${isPatreon}, remaining=${newRateLimit.remaining}, bandwidth=${formatBytes(currentBandwidth.usedBytes)}/${formatBytes(currentBandwidth.limitBytes)} (pending: ${formatBytes(pack.sizeBytes)})`);

        res.json({
            success: true,
            downloadUrl: downloadUrl,
            downloadId: downloadId,  // Client should use this to confirm/cancel
            packId: packId,
            packName: pack.name,
            sizeBytes: pack.sizeBytes,
            expiresIn: BUNNY_CONFIG.URL_EXPIRY_SECONDS,
            rateLimit: {
                remaining: newRateLimit.remaining,
                limit: PACK_RATE_LIMIT.DOWNLOADS_PER_DAY,
                resetTime: newRateLimit.resetTime
            },
            bandwidth: {
                usedBytes: currentBandwidth.usedBytes,
                limitBytes: currentBandwidth.limitBytes,
                remainingBytes: currentBandwidth.remainingBytes,
                pendingBytes: pack.sizeBytes,  // Show what will be charged on completion
                isPatreon: isPatreon
            }
        });

    } catch (error) {
        console.error('Pack download URL error:', error.message);
        res.status(500).json({
            error: 'Server error',
            message: 'Failed to generate download URL. Please try again.'
        });
    }
});

/**
 * POST /pack/download-complete
 * Report download completion status (success or failure)
 * This finalizes or refunds the pending bandwidth
 * Body: { downloadId: string, success: boolean }
 * Requires: Authorization: Bearer <patreon_access_token>
 */
app.post('/pack/download-complete', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization required' });
        }

        const { downloadId, success } = req.body;

        if (!downloadId) {
            return res.status(400).json({ error: 'downloadId is required' });
        }

        if (typeof success !== 'boolean') {
            return res.status(400).json({ error: 'success (boolean) is required' });
        }

        let result;
        if (success) {
            // Download succeeded - charge bandwidth
            result = await finalizePendingDownload(downloadId);
            if (result.success) {
                console.log(`Download ${downloadId} completed successfully, charged ${formatBytes(result.bytes)}`);
                res.json({
                    success: true,
                    message: 'Download confirmed, bandwidth charged',
                    bytesCharged: result.bytes
                });
            } else {
                // Already processed or not found - not an error, just log it
                console.log(`Download ${downloadId} confirmation: ${result.error}`);
                res.json({
                    success: true,
                    message: result.error || 'Download already processed'
                });
            }
        } else {
            // Download failed - refund bandwidth
            result = await cancelPendingDownload(downloadId);
            if (result.success) {
                console.log(`Download ${downloadId} cancelled/failed, refunded ${formatBytes(result.bytes)}`);
                res.json({
                    success: true,
                    message: 'Download cancelled, bandwidth refunded',
                    bytesRefunded: result.bytes
                });
            } else {
                // Already processed or not found - not an error
                console.log(`Download ${downloadId} cancellation: ${result.error}`);
                res.json({
                    success: true,
                    message: result.error || 'Download already processed'
                });
            }
        }
    } catch (error) {
        console.error('Download complete error:', error.message);
        res.status(500).json({
            error: 'Server error',
            message: 'Failed to process download status'
        });
    }
});

/**
 * GET /pack/status
 * Get download status for all packs (rate limits)
 * Requires: Authorization: Bearer <patreon_access_token>
 */
app.get('/pack/status', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization required' });
        }

        const accessToken = authHeader.substring(7);

        let identity;
        try {
            identity = await getPatreonIdentity(accessToken);
        } catch (error) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const userId = identity.data?.id;
        if (!userId) {
            return res.status(401).json({ error: 'Invalid user' });
        }

        // Fetch display_name for whitelist check
        let displayName = null;
        try {
            const profileKey = `${PROFILE_KEY_PREFIX}${userId}`;
            const profileData = await redis.get(profileKey);
            if (profileData) {
                const profile = typeof profileData === 'string' ? JSON.parse(profileData) : profileData;
                displayName = profile.display_name || null;
            }
        } catch (e) { /* ignore */ }

        // Check if user is Patreon or whitelisted
        const tierInfo = determineTier(identity);
        const whitelisted = isWhitelisted(tierInfo.patron_email, tierInfo.patron_name, displayName);
        // Any active patron gets the higher bandwidth limit (not just tier > 0)
        const isPatreon = tierInfo.is_active || whitelisted;

        // Get bandwidth status
        const bandwidthStatus = await checkBandwidthLimit(userId, isPatreon, 0);

        // Get rate limit status for all packs
        const packStatus = {};
        for (const [packId, pack] of Object.entries(AVAILABLE_PACKS)) {
            const rateLimit = await checkPackDownloadLimit(userId, packId);
            packStatus[packId] = {
                name: pack.name,
                sizeBytes: pack.sizeBytes,
                canDownload: rateLimit.allowed,
                downloadsRemaining: rateLimit.remaining,
                downloadsUsed: rateLimit.used,
                resetTime: rateLimit.resetTime
            };
        }

        res.json({
            userId: userId,
            packs: packStatus,
            dailyLimit: PACK_RATE_LIMIT.DOWNLOADS_PER_DAY,
            bandwidth: {
                usedBytes: bandwidthStatus.usedBytes,
                limitBytes: bandwidthStatus.limitBytes,
                remainingBytes: bandwidthStatus.remainingBytes,
                usedGB: (bandwidthStatus.usedBytes / (1024 * 1024 * 1024)).toFixed(2),
                limitGB: bandwidthStatus.limitBytes / (1024 * 1024 * 1024),
                isPatreon: isPatreon
            }
        });

    } catch (error) {
        console.error('Pack status error:', error.message);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /discord/pack/status
 * Get download status for all packs using Discord auth
 * If the Discord user's display name is linked to a Patreon account, they inherit Patreon benefits
 * Requires: Authorization: Bearer <discord_access_token>
 */
app.get('/discord/pack/status', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization required' });
        }

        const accessToken = authHeader.substring(7);

        // Validate Discord token and get user
        let discordUser;
        try {
            discordUser = await getDiscordUser(accessToken);
        } catch (error) {
            return res.status(401).json({ error: 'Invalid Discord token' });
        }

        if (!discordUser?.id) {
            return res.status(401).json({ error: 'Invalid Discord user' });
        }

        const discordUserId = `discord_${discordUser.id}`;

        // Get the Discord user's profile to find their display name
        let displayName = null;
        let linkedUserId = discordUserId; // Default to Discord user ID for bandwidth tracking
        let isPatreon = false;

        if (redis) {
            try {
                // First, get the Discord user's profile
                const discordProfileKey = `${PROFILE_KEY_PREFIX}${discordUserId}`;
                const discordProfileData = await redis.get(discordProfileKey);

                if (discordProfileData) {
                    const discordProfile = typeof discordProfileData === 'string'
                        ? JSON.parse(discordProfileData)
                        : discordProfileData;
                    displayName = discordProfile.display_name || null;
                }

                // If user has a display name, check if it's linked to a Patreon account
                if (displayName) {
                    const indexKey = `display_name_index:${displayName.toLowerCase()}`;
                    const originalUserId = await redis.get(indexKey);

                    // If the display name belongs to a different (non-Discord) user, check their Patreon status
                    if (originalUserId && !originalUserId.startsWith('discord_')) {
                        const patreonProfileKey = `${PROFILE_KEY_PREFIX}${originalUserId}`;
                        const patreonProfileData = await redis.get(patreonProfileKey);

                        if (patreonProfileData) {
                            const patreonProfile = typeof patreonProfileData === 'string'
                                ? JSON.parse(patreonProfileData)
                                : patreonProfileData;

                            // Check if this Patreon user has active status
                            if (patreonProfile.patreon_is_active || patreonProfile.patreon_is_whitelisted || patreonProfile.patreon_tier > 0) {
                                isPatreon = true;
                                linkedUserId = originalUserId; // Use Patreon user's ID for bandwidth tracking
                                console.log(`Discord user ${discordUser.username} (${displayName}) linked to Patreon user ${originalUserId} - granting Patreon benefits`);
                            }
                        }
                    }

                    // Also check whitelist by display name
                    if (!isPatreon && isWhitelisted(null, null, displayName)) {
                        isPatreon = true;
                        console.log(`Discord user ${discordUser.username} (${displayName}) is whitelisted - granting Patreon benefits`);
                    }
                }
            } catch (e) {
                console.error('Discord pack status profile lookup error:', e.message);
            }
        }

        // Get bandwidth status using the appropriate user ID
        const bandwidthStatus = await checkBandwidthLimit(linkedUserId, isPatreon, 0);

        // Get rate limit status for all packs
        const packStatus = {};
        for (const [packId, pack] of Object.entries(AVAILABLE_PACKS)) {
            const rateLimit = await checkPackDownloadLimit(linkedUserId, packId);
            packStatus[packId] = {
                name: pack.name,
                sizeBytes: pack.sizeBytes,
                canDownload: rateLimit.allowed,
                downloadsRemaining: rateLimit.remaining,
                downloadsUsed: rateLimit.used,
                resetTime: rateLimit.resetTime
            };
        }

        res.json({
            userId: linkedUserId,
            discordUserId: discordUserId,
            displayName: displayName,
            packs: packStatus,
            dailyLimit: PACK_RATE_LIMIT.DOWNLOADS_PER_DAY,
            bandwidth: {
                usedBytes: bandwidthStatus.usedBytes,
                limitBytes: bandwidthStatus.limitBytes,
                remainingBytes: bandwidthStatus.remainingBytes,
                usedGB: (bandwidthStatus.usedBytes / (1024 * 1024 * 1024)).toFixed(2),
                limitGB: bandwidthStatus.limitBytes / (1024 * 1024 * 1024),
                isPatreon: isPatreon
            }
        });

    } catch (error) {
        console.error('Discord pack status error:', error.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// =============================================================================
// QUEST DEFINITIONS SYSTEM
// =============================================================================

/**
 * Default quest definitions (fallback if Redis not configured or empty)
 * These match the hardcoded quests in the client
 */
const DEFAULT_QUEST_DEFINITIONS = {
    daily: [
        { id: "flash_flood_d", name: "Flash Flood", description: "View 50 flash images", type: "daily", category: "flash", targetValue: 50, xpReward: 150, icon: "⚡", imageUrl: "https://bambi-cdn.b-cdn.net/quests/flash.png" },
        { id: "spiral_submersion_d", name: "Spiral Submersion", description: "Spend 10 minutes with spiral overlay", type: "daily", category: "spiral", targetValue: 10, xpReward: 200, icon: "🌀", imageUrl: "https://bambi-cdn.b-cdn.net/quests/spiral_overlay.png" },
        { id: "bubble_brain_d", name: "Bubble Brain", description: "Pop 30 bubbles", type: "daily", category: "bubbles", targetValue: 30, xpReward: 150, icon: "🫧", imageUrl: "https://bambi-cdn.b-cdn.net/quests/bubble_pop.png" },
        { id: "pink_vision_d", name: "Pink Vision", description: "Use pink filter for 15 minutes", type: "daily", category: "pinkfilter", targetValue: 15, xpReward: 175, icon: "💗", imageUrl: "https://bambi-cdn.b-cdn.net/quests/pink_filter.png" },
        { id: "deep_trance_d", name: "Deep Trance Training", description: "Watch 10 minutes of video", type: "daily", category: "video", targetValue: 10, xpReward: 200, icon: "🎬", imageUrl: "https://bambi-cdn.b-cdn.net/quests/mandatory_videos.png" },
        { id: "devotion_display_d", name: "Devotion Display", description: "Complete 1 session", type: "daily", category: "session", targetValue: 1, xpReward: 250, icon: "🙏", imageUrl: "https://bambi-cdn.b-cdn.net/quests/session.png" },
        { id: "obedience_drill_d", name: "Obedience Drill", description: "Complete 2 lock cards", type: "daily", category: "lockcard", targetValue: 2, xpReward: 200, icon: "🔒", imageUrl: "https://bambi-cdn.b-cdn.net/quests/phrase_lock.png" },
        { id: "bimbo_basics_d", name: "Bimbo Basics", description: "View 25 flash images", type: "daily", category: "flash", targetValue: 25, xpReward: 100, icon: "✨", imageUrl: "https://bambi-cdn.b-cdn.net/quests/flash.png" },
        { id: "mindless_minutes_d", name: "Mindless Minutes", description: "Spend 20 minutes with any overlay active", type: "daily", category: "combined", targetValue: 20, xpReward: 175, icon: "🧠", imageUrl: "https://bambi-cdn.b-cdn.net/quests/brain_drain.png" },
        { id: "thought_pop_d", name: "Thought Pop", description: "Pop 50 bubbles", type: "daily", category: "bubbles", targetValue: 50, xpReward: 175, icon: "💭", imageUrl: "https://bambi-cdn.b-cdn.net/quests/bubble_pop.png" }
    ],
    weekly: [
        { id: "flash_monsoon_w", name: "Flash Monsoon", description: "View 500 flash images", type: "weekly", category: "flash", targetValue: 500, xpReward: 600, icon: "⚡", imageUrl: "https://bambi-cdn.b-cdn.net/quests/flash.png" },
        { id: "spiral_abyss_w", name: "Spiral Abyss", description: "Spend 120 minutes with spiral overlay", type: "weekly", category: "spiral", targetValue: 120, xpReward: 750, icon: "🌀", imageUrl: "https://bambi-cdn.b-cdn.net/quests/spiral_overlay.png" },
        { id: "bubble_tsunami_w", name: "Bubble Tsunami", description: "Pop 400 bubbles", type: "weekly", category: "bubbles", targetValue: 400, xpReward: 600, icon: "🌊", imageUrl: "https://bambi-cdn.b-cdn.net/quests/bubble_pop.png" },
        { id: "pink_immersion_w", name: "Pink Immersion", description: "Use pink filter for 180 minutes", type: "weekly", category: "pinkfilter", targetValue: 180, xpReward: 700, icon: "💗", imageUrl: "https://bambi-cdn.b-cdn.net/quests/pink_filter.png" },
        { id: "marathon_trance_w", name: "Marathon Trance", description: "Watch 90 minutes of video", type: "weekly", category: "video", targetValue: 90, xpReward: 800, icon: "🎬", imageUrl: "https://bambi-cdn.b-cdn.net/quests/mandatory_videos.png" },
        { id: "weekly_devotion_w", name: "Weekly Devotion", description: "Complete 7 sessions", type: "weekly", category: "session", targetValue: 7, xpReward: 1000, icon: "🙏", imageUrl: "https://bambi-cdn.b-cdn.net/quests/session.png" },
        { id: "phrase_mastery_w", name: "Phrase Mastery", description: "Complete 15 lock cards", type: "weekly", category: "lockcard", targetValue: 15, xpReward: 750, icon: "🔒", imageUrl: "https://bambi-cdn.b-cdn.net/quests/phrase_lock.png" },
        { id: "conditioning_champion_w", name: "Conditioning Champion", description: "Earn 2000 XP from activities", type: "weekly", category: "combined", targetValue: 2000, xpReward: 500, icon: "🏆", imageUrl: "https://bambi-cdn.b-cdn.net/quests/logo.png" },
        { id: "streak_keeper_w", name: "Streak Keeper", description: "Maintain a 7-day streak", type: "weekly", category: "streak", targetValue: 7, xpReward: 600, icon: "🔥", imageUrl: "https://bambi-cdn.b-cdn.net/quests/daily_maintenance.png" },
        { id: "total_submission_w", name: "Total Submission", description: "Complete 15 bubble count games", type: "weekly", category: "bubblecount", targetValue: 15, xpReward: 700, icon: "🎯", imageUrl: "https://bambi-cdn.b-cdn.net/quests/bubble_count.png" }
    ],
    seasonal: []
};

const QUEST_REDIS_KEY = 'quest_definitions';

/**
 * Get quest definitions from Redis or return defaults
 */
async function getQuestDefinitions() {
    if (!redis) {
        return DEFAULT_QUEST_DEFINITIONS;
    }

    try {
        const stored = await redis.get(QUEST_REDIS_KEY);
        if (stored) {
            return typeof stored === 'string' ? JSON.parse(stored) : stored;
        }
        return DEFAULT_QUEST_DEFINITIONS;
    } catch (error) {
        console.error('Error fetching quest definitions:', error.message);
        return DEFAULT_QUEST_DEFINITIONS;
    }
}

/**
 * Filter seasonal quests by current date
 */
function filterActiveQuests(quests) {
    const now = new Date();
    const today = now.toISOString().split('T')[0]; // YYYY-MM-DD

    return {
        daily: quests.daily || [],
        weekly: quests.weekly || [],
        seasonal: (quests.seasonal || []).filter(quest => {
            // If no date restrictions, always include
            if (!quest.activeFrom && !quest.activeUntil) return true;

            // Check date range
            const from = quest.activeFrom || '1970-01-01';
            const until = quest.activeUntil || '2099-12-31';
            return today >= from && today <= until;
        })
    };
}

/**
 * GET /quests/definitions
 * Returns all active quest definitions (daily, weekly, seasonal)
 * Seasonal quests are filtered by current date
 */
app.get('/quests/definitions', async (req, res) => {
    try {
        const allQuests = await getQuestDefinitions();
        const activeQuests = filterActiveQuests(allQuests);

        // Load season config for title
        let seasonTitle = null;
        if (redis) {
            try {
                const seasonConfig = await redis.get('season_config');
                if (seasonConfig) {
                    const config = typeof seasonConfig === 'string' ? JSON.parse(seasonConfig) : seasonConfig;
                    seasonTitle = config.title || null;
                }
            } catch (e) {
                console.error('Error loading season_config:', e.message);
            }
        }

        res.json({
            success: true,
            version: allQuests.version || 1,
            updatedAt: allQuests.updatedAt || new Date().toISOString(),
            seasonTitle: seasonTitle,
            quests: activeQuests
        });
    } catch (error) {
        console.error('Error getting quest definitions:', error.message);
        res.status(500).json({ error: 'Failed to fetch quest definitions' });
    }
});

/**
 * POST /admin/quests/update
 * Update quest definitions (requires admin token)
 * Body: { admin_token, daily: [...], weekly: [...], seasonal: [...] }
 */
app.post('/admin/quests/update', async (req, res) => {
    const { admin_token, daily, weekly, seasonal } = req.body;

    // Verify admin token
    if (admin_token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Invalid admin token' });
    }

    if (!redis) {
        return res.status(500).json({ error: 'Redis not configured' });
    }

    try {
        // Get current definitions to merge
        const current = await getQuestDefinitions();

        const updated = {
            daily: daily || current.daily || DEFAULT_QUEST_DEFINITIONS.daily,
            weekly: weekly || current.weekly || DEFAULT_QUEST_DEFINITIONS.weekly,
            seasonal: seasonal || current.seasonal || [],
            version: (current.version || 0) + 1,
            updatedAt: new Date().toISOString()
        };

        await redis.set(QUEST_REDIS_KEY, JSON.stringify(updated));

        res.json({
            success: true,
            message: 'Quest definitions updated',
            version: updated.version,
            counts: {
                daily: updated.daily.length,
                weekly: updated.weekly.length,
                seasonal: updated.seasonal.length
            }
        });
    } catch (error) {
        console.error('Error updating quest definitions:', error.message);
        res.status(500).json({ error: 'Failed to update quest definitions' });
    }
});

/**
 * GET /admin/quests/get
 * Get all quest definitions including inactive seasonal (requires admin token)
 */
app.get('/admin/quests/get', async (req, res) => {
    const admin_token = req.query.admin_token;

    if (admin_token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Invalid admin token' });
    }

    try {
        const quests = await getQuestDefinitions();
        res.json({
            success: true,
            quests
        });
    } catch (error) {
        console.error('Error getting quest definitions:', error.message);
        res.status(500).json({ error: 'Failed to fetch quest definitions' });
    }
});

/**
 * POST /admin/quests/add-seasonal
 * Add a single seasonal quest (requires admin token)
 * Body: { admin_token, quest: { id, name, description, ... } }
 */
app.post('/admin/quests/add-seasonal', async (req, res) => {
    const { admin_token, quest } = req.body;

    if (admin_token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Invalid admin token' });
    }

    if (!quest || !quest.id || !quest.name) {
        return res.status(400).json({ error: 'Quest must have id and name' });
    }

    if (!redis) {
        return res.status(500).json({ error: 'Redis not configured' });
    }

    try {
        const current = await getQuestDefinitions();

        // Ensure seasonal array exists
        if (!current.seasonal) current.seasonal = [];

        // Check for duplicate ID
        if (current.seasonal.find(q => q.id === quest.id)) {
            return res.status(400).json({ error: `Quest with id "${quest.id}" already exists` });
        }

        // Add the quest
        current.seasonal.push({
            ...quest,
            type: quest.type || 'daily' // default to daily if not specified
        });

        current.version = (current.version || 0) + 1;
        current.updatedAt = new Date().toISOString();

        await redis.set(QUEST_REDIS_KEY, JSON.stringify(current));

        res.json({
            success: true,
            message: `Seasonal quest "${quest.name}" added`,
            version: current.version,
            seasonalCount: current.seasonal.length
        });
    } catch (error) {
        console.error('Error adding seasonal quest:', error.message);
        res.status(500).json({ error: 'Failed to add seasonal quest' });
    }
});

/**
 * POST /admin/quests/remove-seasonal
 * Remove a seasonal quest by ID (requires admin token)
 * Body: { admin_token, questId }
 */
app.post('/admin/quests/remove-seasonal', async (req, res) => {
    const { admin_token, questId } = req.body;

    if (admin_token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Invalid admin token' });
    }

    if (!questId) {
        return res.status(400).json({ error: 'questId required' });
    }

    if (!redis) {
        return res.status(500).json({ error: 'Redis not configured' });
    }

    try {
        const current = await getQuestDefinitions();

        if (!current.seasonal) {
            return res.status(404).json({ error: 'No seasonal quests found' });
        }

        const index = current.seasonal.findIndex(q => q.id === questId);
        if (index === -1) {
            return res.status(404).json({ error: `Quest with id "${questId}" not found` });
        }

        const removed = current.seasonal.splice(index, 1)[0];
        current.version = (current.version || 0) + 1;
        current.updatedAt = new Date().toISOString();

        await redis.set(QUEST_REDIS_KEY, JSON.stringify(current));

        res.json({
            success: true,
            message: `Seasonal quest "${removed.name}" removed`,
            version: current.version,
            seasonalCount: current.seasonal.length
        });
    } catch (error) {
        console.error('Error removing seasonal quest:', error.message);
        res.status(500).json({ error: 'Failed to remove seasonal quest' });
    }
});

/**
 * POST /admin/reset-quest
 * Set reset_weekly_quest or reset_daily_quest flag on a user's profile.
 * The client will pick this up on next sync and regenerate the quest.
 * Body: { admin_token, display_name, type: 'weekly'|'daily'|'both' }
 */
app.post('/admin/reset-quest', async (req, res) => {
    const { admin_token, display_name, type } = req.body;

    if (admin_token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Invalid admin token' });
    }

    if (!display_name || typeof display_name !== 'string') {
        return res.status(400).json({ error: 'display_name required' });
    }

    const validTypes = ['weekly', 'daily', 'both'];
    if (!type || !validTypes.includes(type)) {
        return res.status(400).json({ error: 'type must be "weekly", "daily", or "both"' });
    }

    if (!redis) {
        return res.status(500).json({ error: 'Redis not configured' });
    }

    try {
        // Find user by display_name
        const targetName = display_name.toLowerCase();
        let foundUser = null;
        let foundKey = null;

        // Check display_name index first (fast path)
        const indexKey = `display_name_index:${targetName}`;
        const unifiedId = await redis.get(indexKey);

        if (unifiedId) {
            const userKey = `user:${unifiedId}`;
            const userData = await redis.get(userKey);
            if (userData) {
                foundUser = typeof userData === 'string' ? JSON.parse(userData) : userData;
                foundKey = userKey;
            }
        }

        // Fallback: scan user:* keys
        if (!foundUser) {
            let cursor = "0";
            do {
                const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
                cursor = String(result[0]);
                const keys = result[1] || [];
                for (const key of keys) {
                    try {
                        const data = await redis.get(key);
                        if (data) {
                            const user = typeof data === 'string' ? JSON.parse(data) : data;
                            if (user.display_name && user.display_name.toLowerCase() === targetName) {
                                foundUser = user;
                                foundKey = key;
                                break;
                            }
                        }
                    } catch (e) { /* ignore */ }
                }
                if (foundUser) break;
            } while (cursor !== "0");
        }

        if (!foundUser || !foundKey) {
            return res.status(404).json({ error: `User "${display_name}" not found` });
        }

        // Set reset flags
        if (type === 'weekly' || type === 'both') {
            foundUser.reset_weekly_quest = true;
        }
        if (type === 'daily' || type === 'both') {
            foundUser.reset_daily_quest = true;
        }

        await redis.set(foundKey, JSON.stringify(foundUser));

        console.log(`[Admin] Set quest reset flag (${type}) for user "${foundUser.display_name}"`);

        res.json({
            success: true,
            message: `Quest reset flag (${type}) set for "${foundUser.display_name}". Will take effect on next client sync.`,
            user: {
                display_name: foundUser.display_name,
                unified_id: foundUser.unified_id,
                reset_weekly_quest: foundUser.reset_weekly_quest || false,
                reset_daily_quest: foundUser.reset_daily_quest || false
            }
        });
    } catch (error) {
        console.error('Error setting quest reset flag:', error.message);
        res.status(500).json({ error: 'Failed to set quest reset flag' });
    }
});

/**
 * POST /admin/set-streak
 * Set/fix a user's quest streak data. Supports force-override (even lowering values).
 * Body: { admin_token, display_name, daily_quest_streak?: number, last_daily_quest_date?: string,
 *         quest_completion_dates?: string[], total_daily_quests_completed?: number,
 *         total_weekly_quests_completed?: number, total_xp_from_quests?: number }
 */
app.post('/admin/set-streak', async (req, res) => {
    const { admin_token, display_name, daily_quest_streak, last_daily_quest_date,
            quest_completion_dates, total_daily_quests_completed,
            total_weekly_quests_completed, total_xp_from_quests } = req.body;

    if (admin_token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Invalid admin token' });
    }

    if (!display_name || typeof display_name !== 'string') {
        return res.status(400).json({ error: 'display_name required' });
    }

    if (!redis) {
        return res.status(500).json({ error: 'Redis not configured' });
    }

    try {
        // Find user by display_name
        const targetName = display_name.toLowerCase();
        let foundUser = null;
        let foundKey = null;

        // Check display_name index first (fast path)
        const indexKey = `display_name_index:${targetName}`;
        const unifiedId = await redis.get(indexKey);

        if (unifiedId) {
            const userKey = `user:${unifiedId}`;
            const userData = await redis.get(userKey);
            if (userData) {
                foundUser = typeof userData === 'string' ? JSON.parse(userData) : userData;
                foundKey = userKey;
            }
        }

        // Fallback: scan user:* keys
        if (!foundUser) {
            let cursor = "0";
            do {
                const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
                cursor = String(result[0]);
                const keys = result[1] || [];
                for (const key of keys) {
                    try {
                        const data = await redis.get(key);
                        if (data) {
                            const user = typeof data === 'string' ? JSON.parse(data) : data;
                            if (user.display_name && user.display_name.toLowerCase() === targetName) {
                                foundUser = user;
                                foundKey = key;
                                break;
                            }
                        }
                    } catch (e) { /* ignore */ }
                }
                if (foundUser) break;
            } while (cursor !== "0");
        }

        if (!foundUser || !foundKey) {
            return res.status(404).json({ error: `User "${display_name}" not found` });
        }

        // Ensure stats object exists
        foundUser.stats = foundUser.stats || {};

        const changes = [];

        // Apply streak changes (force-set, no Math.max)
        if (typeof daily_quest_streak === 'number') {
            foundUser.stats.daily_quest_streak = daily_quest_streak;
            changes.push(`daily_quest_streak=${daily_quest_streak}`);
        }
        if (typeof last_daily_quest_date === 'string') {
            foundUser.stats.last_daily_quest_date = last_daily_quest_date;
            changes.push(`last_daily_quest_date=${last_daily_quest_date}`);
        }
        if (Array.isArray(quest_completion_dates)) {
            foundUser.stats.quest_completion_dates = quest_completion_dates;
            changes.push(`quest_completion_dates=[${quest_completion_dates.length} dates]`);
        }
        if (typeof total_daily_quests_completed === 'number') {
            foundUser.stats.total_daily_quests_completed = total_daily_quests_completed;
            changes.push(`total_daily_quests_completed=${total_daily_quests_completed}`);
        }
        if (typeof total_weekly_quests_completed === 'number') {
            foundUser.stats.total_weekly_quests_completed = total_weekly_quests_completed;
            changes.push(`total_weekly_quests_completed=${total_weekly_quests_completed}`);
        }
        if (typeof total_xp_from_quests === 'number') {
            foundUser.stats.total_xp_from_quests = total_xp_from_quests;
            changes.push(`total_xp_from_quests=${total_xp_from_quests}`);
        }

        if (changes.length === 0) {
            return res.status(400).json({ error: 'No changes specified. Provide at least one field to update.' });
        }

        // Set force override flag so client adopts these values even if lower
        foundUser.force_streak_override = true;

        await redis.set(foundKey, JSON.stringify(foundUser));

        console.log(`[Admin] Set streak for "${foundUser.display_name}": ${changes.join(', ')}`);

        res.json({
            success: true,
            message: `Streak updated for "${foundUser.display_name}": ${changes.join(', ')}. Will force-override on next client sync.`,
            user: {
                display_name: foundUser.display_name,
                unified_id: foundUser.unified_id,
                stats: {
                    daily_quest_streak: foundUser.stats.daily_quest_streak,
                    last_daily_quest_date: foundUser.stats.last_daily_quest_date,
                    quest_completion_dates: foundUser.stats.quest_completion_dates,
                    total_daily_quests_completed: foundUser.stats.total_daily_quests_completed,
                    total_weekly_quests_completed: foundUser.stats.total_weekly_quests_completed,
                    total_xp_from_quests: foundUser.stats.total_xp_from_quests
                }
            }
        });
    } catch (error) {
        console.error('Error setting streak:', error.message);
        res.status(500).json({ error: 'Failed to set streak' });
    }
});

/**
 * POST /admin/reset-skills
 * Reset a user's skill tree (refund all points, clear unlocked skills).
 * Body: { admin_token, display_name }
 */
app.post('/admin/reset-skills', async (req, res) => {
    const { admin_token, display_name } = req.body;

    if (admin_token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Invalid admin token' });
    }
    if (!display_name || typeof display_name !== 'string') {
        return res.status(400).json({ error: 'display_name required' });
    }
    if (!redis) {
        return res.status(500).json({ error: 'Redis not configured' });
    }

    try {
        const targetName = display_name.toLowerCase();
        let foundUser = null;
        let foundKey = null;

        const indexKey = `display_name_index:${targetName}`;
        const unifiedId = await redis.get(indexKey);
        if (unifiedId) {
            const userKey = `user:${unifiedId}`;
            const userData = await redis.get(userKey);
            if (userData) {
                foundUser = typeof userData === 'string' ? JSON.parse(userData) : userData;
                foundKey = userKey;
            }
        }

        if (!foundUser) {
            let cursor = "0";
            do {
                const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
                cursor = String(result[0]);
                const keys = result[1] || [];
                for (const key of keys) {
                    try {
                        const data = await redis.get(key);
                        if (data) {
                            const user = typeof data === 'string' ? JSON.parse(data) : data;
                            if (user.display_name && user.display_name.toLowerCase() === targetName) {
                                foundUser = user;
                                foundKey = key;
                                break;
                            }
                        }
                    } catch (e) { /* ignore */ }
                }
                if (foundUser) break;
            } while (cursor !== "0");
        }

        if (!foundUser || !foundKey) {
            return res.status(404).json({ error: `User "${display_name}" not found` });
        }

        const oldSkillPoints = foundUser.skill_points || 0;
        const oldSkills = foundUser.unlocked_skills || [];
        const POINTS_PER_LEVEL = 1;
        const refundedPoints = (foundUser.level || 1) * POINTS_PER_LEVEL;

        foundUser.skill_points = refundedPoints;
        foundUser.unlocked_skills = [];
        foundUser.force_skills_reset = true;

        await redis.set(foundKey, JSON.stringify(foundUser));

        console.log(`[Admin] Reset skills for "${foundUser.display_name}": ${oldSkills.length} skills cleared, ${oldSkillPoints} -> ${refundedPoints} points`);

        res.json({
            success: true,
            message: `Skills reset for "${foundUser.display_name}". ${oldSkills.length} skills cleared, ${refundedPoints} points refunded (level ${foundUser.level} × ${POINTS_PER_LEVEL}).`,
            user: {
                display_name: foundUser.display_name,
                level: foundUser.level,
                old_skill_points: oldSkillPoints,
                new_skill_points: refundedPoints,
                cleared_skills: oldSkills
            }
        });
    } catch (error) {
        console.error('Error resetting skills:', error.message);
        res.status(500).json({ error: 'Failed to reset skills' });
    }
});

/**
 * POST /admin/reset-all-skills
 * Reset ALL users' skill trees (refund points based on level, clear unlocked skills, set force_skills_reset).
 * Body: { admin_token, dry_run?: boolean }
 */
app.post('/admin/reset-all-skills', async (req, res) => {
    const { admin_token, dry_run = true } = req.body;

    if (admin_token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Invalid admin token' });
    }
    if (!redis) {
        return res.status(500).json({ error: 'Redis not configured' });
    }

    try {
        const POINTS_PER_LEVEL = 1;
        const affected = [];
        const skipped = [];
        let cursor = "0";

        do {
            const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
            cursor = String(result[0]);
            const keys = result[1] || [];

            for (const key of keys) {
                try {
                    const data = await redis.get(key);
                    if (!data) continue;
                    const user = typeof data === 'string' ? JSON.parse(data) : data;

                    const oldSkills = user.unlocked_skills || [];
                    const oldPoints = user.skill_points || 0;
                    const level = user.level || 1;
                    const refundedPoints = level * POINTS_PER_LEVEL;

                    if (oldSkills.length === 0 && oldPoints === refundedPoints) {
                        skipped.push({ display_name: user.display_name || key, level, reason: 'already clean' });
                        continue;
                    }

                    if (!dry_run) {
                        user.skill_points = refundedPoints;
                        user.unlocked_skills = [];
                        user.force_skills_reset = true;
                        await redis.set(key, JSON.stringify(user));
                    }

                    affected.push({
                        display_name: user.display_name || key,
                        level,
                        old_skill_points: oldPoints,
                        new_skill_points: refundedPoints,
                        skills_cleared: oldSkills.length
                    });
                } catch (e) {
                    skipped.push({ key, reason: e.message });
                }
            }
        } while (cursor !== "0");

        console.log(`[Admin] reset-all-skills (dry_run=${dry_run}): ${affected.length} users affected, ${skipped.length} skipped`);

        res.json({
            success: true,
            dry_run,
            summary: {
                affected_count: affected.length,
                skipped_count: skipped.length
            },
            affected,
            skipped
        });
    } catch (error) {
        console.error('Error resetting all skills:', error.message);
        res.status(500).json({ error: 'Failed to reset all skills' });
    }
});

/**
 * POST /admin/retroactive-og-check
 * Cross-reference a list of discord IDs (from V1 leaderboard backup) against current V2 users.
 * Any V2 user whose discord_id matches a V1 entry gets flagged as is_season0_og = true.
 * Body: { admin_token: string, discord_ids: string[], dry_run?: boolean }
 */
app.post('/admin/retroactive-og-check', async (req, res) => {
    try {
        const { admin_token, discord_ids, dry_run = true } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });
        if (!discord_ids || !Array.isArray(discord_ids)) {
            return res.status(400).json({ error: 'discord_ids array required' });
        }

        const results = {
            checked: discord_ids.length,
            found_in_v2: 0,
            already_og: 0,
            newly_flagged: 0,
            not_in_v2: 0,
            flagged_users: [],
            not_found: []
        };

        for (const discordId of discord_ids) {
            if (!discordId) continue;

            // Look up V2 user by discord index
            const indexKey = `discord_index:${discordId}`;
            const unifiedId = await redis.get(indexKey);

            if (!unifiedId) {
                results.not_in_v2++;
                results.not_found.push(discordId);
                continue;
            }

            results.found_in_v2++;
            const userData = await redis.get(`user:${unifiedId}`);
            if (!userData) {
                results.not_in_v2++;
                continue;
            }

            const user = typeof userData === 'string' ? JSON.parse(userData) : userData;

            if (user.is_season0_og) {
                results.already_og++;
                continue;
            }

            // This user was in V1 but not flagged as OG
            results.newly_flagged++;
            results.flagged_users.push({
                unified_id: unifiedId,
                display_name: user.display_name,
                discord_id: discordId,
                level: user.level,
                achievements_count: (user.achievements || []).length
            });

            if (!dry_run) {
                user.is_season0_og = true;
                await redis.set(`user:${unifiedId}`, JSON.stringify(user));
                console.log(`[Admin] Retroactive OG flag set for ${user.display_name} (${unifiedId})`);
            }
        }

        res.json({
            success: true,
            dry_run,
            results
        });
    } catch (error) {
        console.error('Retroactive OG check error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /admin/import-v1-discord-ids
 * Import discord IDs from V1 leaderboard backup into a Redis set for OG detection fallback.
 * The auth endpoints use this set when season0: keys are missing.
 * Body: { admin_token: string, discord_ids: string[] }
 */
app.post('/admin/import-v1-discord-ids', async (req, res) => {
    try {
        const { admin_token, discord_ids } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });
        if (!discord_ids || !Array.isArray(discord_ids) || discord_ids.length === 0) {
            return res.status(400).json({ error: 'discord_ids array required' });
        }

        // Filter valid IDs
        const validIds = discord_ids.filter(id => id && typeof id === 'string' && id.length > 0);

        // Add all to the set
        if (validIds.length > 0) {
            await redis.sadd('season0_discord_ids', ...validIds);
        }

        const totalInSet = await redis.scard('season0_discord_ids');

        console.log(`[Admin] Imported ${validIds.length} discord IDs into season0_discord_ids set (total: ${totalInSet})`);
        res.json({
            success: true,
            imported: validIds.length,
            total_in_set: totalInSet
        });
    } catch (error) {
        console.error('Import V1 discord IDs error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /admin/start-new-season
 * Snapshot current leaderboard, reset all users, and update season config.
 * Body: { admin_token: string, new_season: string, season_title?: string, dry_run?: boolean }
 */
app.post('/admin/start-new-season', async (req, res) => {
    try {
        const { admin_token, new_season, season_title, dry_run = true } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });
        if (!new_season) {
            return res.status(400).json({ error: 'new_season required (e.g. "2026-03")' });
        }

        const currentSeason = getCurrentSeason();
        const snapshotResult = { season: currentSeason, total_users: 0, stored_as: null };
        const resetResult = { users_reset: 0, target_season: new_season };

        // Step 1: Snapshot current leaderboard
        const leaderboardKey = `leaderboard:${currentSeason}`;
        const leaderboardData = await redis.zrange(leaderboardKey, 0, -1, { withScores: true, rev: true });

        const rankings = [];
        if (leaderboardData && leaderboardData.length > 0) {
            // leaderboardData is an array of { value, score } or flat [member, score, ...]
            // Upstash returns array of { value, score } when withScores is used
            for (let i = 0; i < leaderboardData.length; i++) {
                const entry = leaderboardData[i];
                const unifiedId = typeof entry === 'object' ? entry.value : entry;
                const score = typeof entry === 'object' ? entry.score : leaderboardData[++i];

                // Look up user display name
                let displayName = unifiedId;
                let level = 1;
                try {
                    const uData = await redis.get(`user:${unifiedId}`);
                    if (uData) {
                        const u = typeof uData === 'string' ? JSON.parse(uData) : uData;
                        displayName = u.display_name || unifiedId;
                        level = u.level || 1;
                    }
                } catch (e) { /* skip lookup errors */ }

                rankings.push({
                    rank: rankings.length + 1,
                    unified_id: unifiedId,
                    display_name: displayName,
                    level: level,
                    xp: Number(score) || 0
                });
            }
        }

        snapshotResult.total_users = rankings.length;

        if (!dry_run) {
            // Store snapshot
            const snapshotKey = `leaderboard_snapshot:${currentSeason}`;
            const snapshotData = {
                season: currentSeason,
                snapshot_date: new Date().toISOString(),
                rankings: rankings
            };
            await redis.set(snapshotKey, JSON.stringify(snapshotData));
            snapshotResult.stored_as = snapshotKey;
        }

        // Step 2: Reset all users
        let cursor = "0";
        do {
            const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
            cursor = String(result[0]);

            for (const key of (result[1] || [])) {
                try {
                    const userData = await redis.get(key);
                    if (!userData) continue;

                    const user = typeof userData === 'string' ? JSON.parse(userData) : userData;
                    const unifiedId = key.replace('user:', '');

                    if (user.current_season === new_season) continue;

                    if (!dry_run) {
                        // Archive stats
                        if (!user.all_time_stats) user.all_time_stats = {};
                        user.all_time_stats.total_flashes = (user.all_time_stats.total_flashes || 0) + (user.stats?.total_flashes || 0);
                        user.all_time_stats.total_bubbles_popped = (user.all_time_stats.total_bubbles_popped || 0) + (user.stats?.total_bubbles_popped || 0);
                        user.all_time_stats.total_video_minutes = (user.all_time_stats.total_video_minutes || 0) + (user.stats?.total_video_minutes || 0);
                        user.all_time_stats.total_lock_cards_completed = (user.all_time_stats.total_lock_cards_completed || 0) + (user.stats?.total_lock_cards_completed || 0);
                        user.all_time_stats.seasons_completed = (user.all_time_stats.seasons_completed || 0) + 1;

                        user.highest_level_ever = Math.max(user.highest_level_ever || 0, user.level || 1);
                        user.unlocks = calculateUnlocks(user.highest_level_ever);

                        const oldSeason = user.current_season;

                        user.xp = 0;
                        user.level = 1;
                        user.stats = {
                            total_flashes: 0,
                            total_bubbles_popped: 0,
                            total_video_minutes: 0,
                            total_lock_cards_completed: 0
                        };
                        user.current_season = new_season;
                        user.level_reset_at = new Date().toISOString();
                        // Clear oopsie insurance for new season
                        delete user.oopsie_used_season;
                        user.updated_at = new Date().toISOString();

                        await redis.set(key, JSON.stringify(user));

                        if (oldSeason) {
                            await redis.zrem(`leaderboard:${oldSeason}`, unifiedId);
                        }
                        await redis.zadd(`leaderboard:${new_season}`, { score: 0, member: unifiedId });
                    }

                    resetResult.users_reset++;
                } catch (e) {
                    console.error(`Season reset error for ${key}:`, e.message);
                }
            }
        } while (cursor !== "0");

        // Step 3: Update season config
        if (!dry_run) {
            const seasonConfig = {
                season: new_season,
                title: season_title || null,
                started_at: new Date().toISOString()
            };
            await redis.set('season_config', JSON.stringify(seasonConfig));
        }

        console.log(`[ADMIN] start-new-season: ${new_season} (dry_run: ${dry_run}), snapshot: ${snapshotResult.total_users} users, reset: ${resetResult.users_reset} users`);

        res.json({
            success: true,
            dry_run,
            snapshot: snapshotResult,
            reset: resetResult,
            season_config: {
                title: season_title || null
            }
        });
    } catch (error) {
        console.error('Admin start-new-season error:', error.message);
        res.status(500).json({ error: 'Failed to start new season' });
    }
});

/**
 * GET /admin/leaderboard-snapshot/:season
 * Retrieve a stored leaderboard snapshot for a given season.
 * Query: ?admin_token=xxx
 */
app.get('/admin/leaderboard-snapshot/:season', async (req, res) => {
    try {
        const admin_token = req.query.admin_token;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const season = req.params.season;
        const snapshotKey = `leaderboard_snapshot:${season}`;
        const data = await redis.get(snapshotKey);

        if (!data) {
            return res.status(404).json({ error: `No snapshot found for season ${season}` });
        }

        const snapshot = typeof data === 'string' ? JSON.parse(data) : data;
        res.json(snapshot);
    } catch (error) {
        console.error('Admin leaderboard-snapshot error:', error.message);
        res.status(500).json({ error: 'Failed to fetch leaderboard snapshot' });
    }
});

/**
 * POST /admin/season/update
 * Update season config (title) and optionally quest definitions.
 * Body: { admin_token: string, title?: string, quests?: { daily: [...], weekly: [...], seasonal: [...] } }
 */
app.post('/admin/season/update', async (req, res) => {
    try {
        const { admin_token, title, quests } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const changes = [];

        // Update season config title
        if (title !== undefined) {
            let seasonConfig = {};
            try {
                const existing = await redis.get('season_config');
                if (existing) {
                    seasonConfig = typeof existing === 'string' ? JSON.parse(existing) : existing;
                }
            } catch (e) { /* start fresh */ }

            seasonConfig.title = title;
            seasonConfig.season = seasonConfig.season || getCurrentSeason();
            await redis.set('season_config', JSON.stringify(seasonConfig));
            changes.push(`title updated to "${title}"`);
        }

        // Update quest definitions if provided
        if (quests) {
            const current = await getQuestDefinitions();
            const updated = {
                daily: quests.daily || current.daily || DEFAULT_QUEST_DEFINITIONS.daily,
                weekly: quests.weekly || current.weekly || DEFAULT_QUEST_DEFINITIONS.weekly,
                seasonal: quests.seasonal || current.seasonal || [],
                version: (current.version || 0) + 1,
                updatedAt: new Date().toISOString()
            };
            await redis.set(QUEST_REDIS_KEY, JSON.stringify(updated));
            changes.push(`quests updated (v${updated.version}): ${updated.daily.length} daily, ${updated.weekly.length} weekly, ${updated.seasonal.length} seasonal`);
        }

        console.log(`[ADMIN] season/update: ${changes.join(', ')}`);

        res.json({
            success: true,
            changes
        });
    } catch (error) {
        console.error('Admin season/update error:', error.message);
        res.status(500).json({ error: 'Failed to update season config' });
    }
});

/**
 * POST /admin/merge-accounts
 * Merge two user accounts into one. Source account is merged INTO target, then deleted.
 * Body: {
 *   admin_token: string,
 *   source_id: string,              // account to merge FROM (will be deleted)
 *   target_id: string,              // account to keep
 *   override_display_name?: string, // force display name on target
 *   override_level?: number,        // force level
 *   override_xp?: number,           // force xp
 *   set_whitelisted?: boolean,      // set patreon_is_whitelisted
 *   set_og?: boolean                // set is_season0_og
 * }
 */
app.post('/admin/merge-accounts', async (req, res) => {
    try {
        const {
            admin_token, source_id, target_id,
            override_display_name, override_level, override_xp,
            set_whitelisted, set_og, dry_run = false
        } = req.body;

        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });
        if (!source_id || !target_id) {
            return res.status(400).json({ error: 'source_id and target_id required' });
        }
        if (source_id === target_id) {
            return res.status(400).json({ error: 'source_id and target_id must be different' });
        }

        // Fetch both accounts
        const [sourceData, targetData] = await Promise.all([
            redis.get(`user:${source_id}`),
            redis.get(`user:${target_id}`)
        ]);

        if (!sourceData) return res.status(404).json({ error: `Source account not found: ${source_id}` });
        if (!targetData) return res.status(404).json({ error: `Target account not found: ${target_id}` });

        const source = typeof sourceData === 'string' ? JSON.parse(sourceData) : sourceData;
        const target = typeof targetData === 'string' ? JSON.parse(targetData) : targetData;
        const changes = [];
        const deletedKeys = [];

        // 1. Merge achievements (union, deduplicated)
        const mergedAchievements = [...new Set([
            ...(target.achievements || []),
            ...(source.achievements || [])
        ])];
        if (mergedAchievements.length !== (target.achievements || []).length) {
            changes.push(`achievements: ${(target.achievements || []).length} -> ${mergedAchievements.length}`);
        }
        target.achievements = mergedAchievements;

        // 2. Merge stats into all_time_stats
        // Take max of each stat from source's stats + source's all_time_stats, accumulate into target's all_time_stats
        const sourceAllTimeStats = { ...(source.all_time_stats || {}) };
        const sourceCurrentStats = source.stats || {};
        // Combine source's current stats and all_time_stats (take max for each key)
        const sourceCombined = {};
        for (const key of new Set([...Object.keys(sourceAllTimeStats), ...Object.keys(sourceCurrentStats)])) {
            sourceCombined[key] = Math.max(sourceAllTimeStats[key] || 0, sourceCurrentStats[key] || 0);
        }
        // Now accumulate into target's all_time_stats
        const targetAllTime = { ...(target.all_time_stats || {}) };
        for (const [key, value] of Object.entries(sourceCombined)) {
            targetAllTime[key] = (targetAllTime[key] || 0) + value;
        }
        if (Object.keys(sourceCombined).length > 0) {
            changes.push(`all_time_stats: merged ${Object.keys(sourceCombined).length} stat keys from source`);
        }
        target.all_time_stats = targetAllTime;

        // 3. Transfer linked accounts if target doesn't have them
        if (source.discord_id && !target.discord_id) {
            target.discord_id = source.discord_id;
            target.discord_username = source.discord_username || target.discord_username;
            // Update discord index to point to target
            if (!dry_run) await redis.set(`discord_index:${source.discord_id}`, target_id);
            changes.push(`discord_id transferred: ${source.discord_id}`);
        } else if (source.discord_id) {
            // Source discord index needs cleanup (target already has one)
            if (!dry_run) await redis.del(`discord_index:${source.discord_id}`);
            deletedKeys.push(`discord_index:${source.discord_id}`);
        }

        if (source.patreon_id && !target.patreon_id) {
            target.patreon_id = source.patreon_id;
            target.patron_name = source.patron_name || target.patron_name;
            target.patreon_tier = source.patreon_tier || target.patreon_tier;
            target.patreon_is_active = source.patreon_is_active || target.patreon_is_active;
            // Update patreon index to point to target
            if (!dry_run) await redis.set(`patreon_index:${source.patreon_id}`, target_id);
            changes.push(`patreon_id transferred: ${source.patreon_id}`);
        } else if (source.patreon_id) {
            if (!dry_run) await redis.del(`patreon_index:${source.patreon_id}`);
            deletedKeys.push(`patreon_index:${source.patreon_id}`);
        }

        if (source.email && !target.email) {
            target.email = source.email;
            if (!dry_run) await redis.set(`email_index:${source.email.toLowerCase()}`, target_id);
            changes.push(`email transferred: ${source.email}`);
        } else if (source.email) {
            if (!dry_run) await redis.del(`email_index:${source.email.toLowerCase()}`);
            deletedKeys.push(`email_index:${source.email.toLowerCase()}`);
        }

        // 4. Preserve highest_level_ever (take max from both)
        const sourceHighest = source.highest_level_ever || source.level || 1;
        const targetHighest = target.highest_level_ever || target.level || 1;
        target.highest_level_ever = Math.max(sourceHighest, targetHighest);
        if (target.highest_level_ever !== targetHighest) {
            changes.push(`highest_level_ever: ${targetHighest} -> ${target.highest_level_ever}`);
        }

        // 5. Apply overrides
        if (override_display_name !== undefined) {
            const oldName = target.display_name;
            // Delete old display_name_index
            if (oldName) {
                if (!dry_run) await redis.del(`display_name_index:${oldName.toLowerCase()}`);
                deletedKeys.push(`display_name_index:${oldName.toLowerCase()}`);
            }
            target.display_name = override_display_name;
            if (!dry_run) await redis.set(`display_name_index:${override_display_name.toLowerCase()}`, target_id);
            changes.push(`display_name: "${oldName}" -> "${override_display_name}"`);
        }

        if (override_level !== undefined) {
            changes.push(`level: ${target.level} -> ${override_level}`);
            target.level = override_level;
        }

        if (override_xp !== undefined) {
            changes.push(`xp: ${target.xp} -> ${override_xp}`);
            target.xp = override_xp;
        }

        if (set_whitelisted !== undefined) {
            target.patreon_is_whitelisted = set_whitelisted;
            changes.push(`patreon_is_whitelisted: ${set_whitelisted}`);
        }

        if (set_og !== undefined) {
            target.is_season0_og = set_og;
            changes.push(`is_season0_og: ${set_og}`);
        }

        // 6. Recalculate unlocks
        target.unlocks = calculateUnlocks(target.highest_level_ever || 0);

        // 7. Update timestamp
        target.updated_at = new Date().toISOString();

        // 8. Save merged target
        if (!dry_run) await redis.set(`user:${target_id}`, JSON.stringify(target));

        // 9. Update leaderboard — add/update target, remove source
        const season = target.current_season || getCurrentSeason();
        const leaderboardXp = target.xp || 0;
        if (!dry_run) await redis.zadd(`leaderboard:${season}`, { score: leaderboardXp, member: target_id });
        changes.push(`leaderboard:${season} updated for target (xp: ${leaderboardXp})`);

        if (source.current_season) {
            if (!dry_run) await redis.zrem(`leaderboard:${source.current_season}`, source_id);
            deletedKeys.push(`leaderboard:${source.current_season} (source removed)`);
        }

        // 10. Delete source account and its indexes
        // Delete source display_name_index
        if (source.display_name) {
            const sourceNameKey = `display_name_index:${source.display_name.toLowerCase()}`;
            // Only delete if it still points to source (might have been overridden above)
            const currentMapping = await redis.get(sourceNameKey);
            if (currentMapping === source_id) {
                if (!dry_run) await redis.del(sourceNameKey);
                deletedKeys.push(sourceNameKey);
            }
        }

        // Delete source user record
        if (!dry_run) await redis.del(`user:${source_id}`);
        deletedKeys.push(`user:${source_id}`);

        // 11. Clean up legacy profile keys (profile:<patreon_id>, discord_profile:<discord_id>)
        // Delete source's legacy keys
        if (source.patreon_id) {
            const sourceProfileKey = `profile:${source.patreon_id}`;
            if (await redis.get(sourceProfileKey)) {
                if (!dry_run) await redis.del(sourceProfileKey);
                deletedKeys.push(sourceProfileKey);
            }
        }
        if (source.discord_id) {
            const sourceDiscordKey = `discord_profile:${source.discord_id}`;
            if (await redis.get(sourceDiscordKey)) {
                if (!dry_run) await redis.del(sourceDiscordKey);
                deletedKeys.push(sourceDiscordKey);
            }
        }

        // Update target's legacy keys to match merged state
        if (target.patreon_id) {
            const targetProfileKey = `profile:${target.patreon_id}`;
            const existing = await redis.get(targetProfileKey);
            if (existing) {
                const profile = typeof existing === 'string' ? JSON.parse(existing) : existing;
                profile.level = target.level;
                profile.xp = target.xp;
                profile.display_name = target.display_name;
                profile.achievements = target.achievements;
                profile.stats = target.stats;
                profile.updated_at = target.updated_at;
                if (!dry_run) await redis.set(targetProfileKey, JSON.stringify(profile));
                changes.push(`updated legacy key ${targetProfileKey}`);
            }
        }
        if (target.discord_id) {
            const targetDiscordKey = `discord_profile:${target.discord_id}`;
            const existing = await redis.get(targetDiscordKey);
            if (existing) {
                const profile = typeof existing === 'string' ? JSON.parse(existing) : existing;
                profile.level = target.level;
                profile.xp = target.xp;
                profile.display_name = target.display_name;
                profile.achievements = target.achievements;
                profile.stats = target.stats;
                profile.updated_at = target.updated_at;
                if (!dry_run) await redis.set(targetDiscordKey, JSON.stringify(profile));
                changes.push(`updated legacy key ${targetDiscordKey}`);
            }
        }

        console.log(`[ADMIN] ${dry_run ? 'DRY RUN ' : ''}Merged accounts: ${source_id} -> ${target_id} | Changes: ${changes.join(', ')}`);

        res.json({
            success: true,
            dry_run: !!dry_run,
            merged_from: source_id,
            merged_into: target_id,
            changes,
            deleted_keys: deletedKeys,
            merged_user: {
                unified_id: target.unified_id,
                display_name: target.display_name,
                level: target.level,
                xp: target.xp,
                achievements_count: target.achievements?.length || 0,
                discord_id: target.discord_id,
                patreon_id: target.patreon_id,
                is_season0_og: target.is_season0_og,
                patreon_is_whitelisted: target.patreon_is_whitelisted,
                highest_level_ever: target.highest_level_ever,
                all_time_stats: target.all_time_stats,
                stats: target.stats,
                current_season: target.current_season,
                unlocks: target.unlocks
            }
        });
    } catch (error) {
        console.error('Admin merge-accounts error:', error.message);
        res.status(500).json({ error: 'Failed to merge accounts', details: error.message });
    }
});

/**
 * POST /admin/clear-patron-display-names
 * Find all users whose display_name matches their patron_name (auto-populated, not user-chosen)
 * and null out their display_name so they get prompted to pick a new one on next login.
 * Body: { admin_token: string, dry_run?: boolean }
 */
app.post('/admin/clear-patron-display-names', async (req, res) => {
    try {
        const { admin_token, dry_run = true } = req.body;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const affected = [];
        const skipped = [];

        let cursor = "0";
        do {
            const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
            cursor = String(result[0]);
            for (const key of (result[1] || [])) {
                try {
                    const data = await redis.get(key);
                    if (!data) continue;
                    const user = typeof data === 'string' ? JSON.parse(data) : data;

                    // Skip users without both fields
                    if (!user.display_name || !user.patron_name) continue;

                    // Check if display_name matches patron_name (case-insensitive)
                    if (user.display_name.toLowerCase().trim() !== user.patron_name.toLowerCase().trim()) {
                        continue;
                    }

                    affected.push({
                        unified_id: user.unified_id,
                        display_name: user.display_name,
                        patron_name: user.patron_name,
                        level: user.level
                    });

                    if (!dry_run) {
                        // Delete display_name_index
                        await redis.del(`display_name_index:${user.display_name.toLowerCase()}`);

                        // Null out display_name on user record
                        user.display_name = null;
                        user.display_name_set_at = null;
                        await redis.set(key, JSON.stringify(user));

                        // Also null on legacy profile keys
                        if (user.patreon_id) {
                            const profileKey = `profile:${user.patreon_id}`;
                            const profileData = await redis.get(profileKey);
                            if (profileData) {
                                const profile = typeof profileData === 'string' ? JSON.parse(profileData) : profileData;
                                profile.display_name = null;
                                await redis.set(profileKey, JSON.stringify(profile));
                            }
                        }
                        if (user.discord_id) {
                            const discordKey = `discord_profile:${user.discord_id}`;
                            const discordData = await redis.get(discordKey);
                            if (discordData) {
                                const profile = typeof discordData === 'string' ? JSON.parse(discordData) : discordData;
                                profile.display_name = null;
                                await redis.set(discordKey, JSON.stringify(profile));
                            }
                        }
                    }
                } catch (e) {
                    skipped.push({ key, error: e.message });
                }
            }
        } while (cursor !== "0");

        console.log(`[ADMIN] clear-patron-display-names: ${affected.length} affected, ${skipped.length} skipped (dry_run=${dry_run})`);

        res.json({
            success: true,
            dry_run,
            affected_count: affected.length,
            skipped_count: skipped.length,
            affected,
            skipped
        });
    } catch (error) {
        console.error('Admin clear-patron-display-names error:', error.message);
        res.status(500).json({ error: 'Failed to clear patron display names' });
    }
});

/**
 * POST /admin/set-highest-level
 * Set a user's highest_level_ever without changing their current level/xp.
 * This is the key "unstick a user" tool — lets admins grant feature unlocks
 * without altering the user's actual progression.
 * Body: { display_name: string, highest_level: number, admin_token: string }
 */
app.post('/admin/set-highest-level', async (req, res) => {
    try {
        const { display_name, highest_level, admin_token } = req.body;

        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        if (!display_name || typeof display_name !== 'string') {
            return res.status(400).json({ error: 'display_name is required' });
        }

        if (typeof highest_level !== 'number' || highest_level < 0 || highest_level > 999) {
            return res.status(400).json({ error: 'highest_level must be a number between 0 and 999' });
        }

        if (!redis) {
            return res.status(503).json({ error: 'Redis not available' });
        }

        // Scan for V2 user:* record by display_name
        const targetName = display_name.toLowerCase();
        let foundKey = null;
        let foundProfile = null;

        let cursor = "0";
        do {
            const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
            cursor = String(result[0]);
            const keys = result[1] || [];

            for (const key of keys) {
                try {
                    const data = await redis.get(key);
                    if (data) {
                        const profile = typeof data === 'string' ? JSON.parse(data) : data;
                        if (profile.display_name && profile.display_name.toLowerCase() === targetName) {
                            foundKey = key;
                            foundProfile = profile;
                            break;
                        }
                    }
                } catch (e) { /* ignore parse errors */ }
            }
            if (foundKey) break;
        } while (cursor !== "0");

        if (!foundKey) {
            return res.status(404).json({ error: `No V2 user found with display_name "${display_name}"` });
        }

        const oldHighest = foundProfile.highest_level_ever || 0;
        foundProfile.highest_level_ever = highest_level;
        foundProfile.unlocks = calculateUnlocks(highest_level);
        foundProfile.updated_at = new Date().toISOString();

        await redis.set(foundKey, JSON.stringify(foundProfile));

        console.log(`[ADMIN] Set highest_level_ever for "${display_name}" (${foundKey}): ${oldHighest} -> ${highest_level}`);

        res.json({
            success: true,
            display_name: display_name,
            profile_key: foundKey,
            old_highest_level_ever: oldHighest,
            new_highest_level_ever: highest_level,
            current_level: foundProfile.level || 1,
            unlocks: foundProfile.unlocks
        });
    } catch (error) {
        console.error('Admin set-highest-level error:', error.message);
        res.status(500).json({ error: 'Failed to set highest level' });
    }
});

/**
 * GET /admin/suspicious-accounts
 * List accounts with anti-cheat flags for manual review
 * Query: admin_token, min_flags (default 1)
 */
app.get('/admin/suspicious-accounts', async (req, res) => {
    try {
        const { admin_token, min_flags = 1 } = req.query;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const minFlagsNum = parseInt(min_flags) || 1;
        const suspicious = [];

        let cursor = "0";
        do {
            const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
            cursor = result[0] || result.cursor || "0";
            const keys = result[1] || result.keys || [];

            for (const key of keys) {
                try {
                    const data = await redis.get(key);
                    const user = typeof data === 'string' ? JSON.parse(data) : data;
                    if (user?.anti_cheat_flags && user.anti_cheat_flags.length >= minFlagsNum) {
                        suspicious.push({
                            unified_id: user.unified_id,
                            display_name: user.display_name,
                            level: user.level,
                            xp: user.xp,
                            flag_count: user.anti_cheat_flags.length,
                            flags: user.anti_cheat_flags,
                            last_sync_at: user.last_sync_at,
                            last_seen: user.last_seen
                        });
                    }
                } catch (e) {
                    // Skip unparseable entries
                }
            }
        } while (cursor !== "0" && cursor !== 0);

        // Sort by flag count descending
        suspicious.sort((a, b) => b.flag_count - a.flag_count);

        res.json({
            total: suspicious.length,
            min_flags: minFlagsNum,
            accounts: suspicious
        });
    } catch (error) {
        console.error('Admin suspicious-accounts error:', error.message);
        res.status(500).json({ error: 'Failed to query suspicious accounts' });
    }
});

/**
 * GET /admin/xp-rate-anomalies
 * List accounts with sustained XP rates above threshold
 * Query: admin_token, min_rate (default 30000 XP/hr), min_samples (default 3)
 */
app.get('/admin/xp-rate-anomalies', async (req, res) => {
    try {
        const { admin_token, min_rate = 30000, min_samples = 3 } = req.query;
        const expectedToken = process.env.ADMIN_TOKEN;
        if (!expectedToken || admin_token !== expectedToken) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const minRateNum = parseInt(min_rate) || 30000;
        const minSamplesNum = parseInt(min_samples) || 3;
        const anomalies = [];

        let cursor = "0";
        do {
            const result = await redis.scan(cursor, { match: 'user:*', count: 100 });
            cursor = result[0] || result.cursor || "0";
            const keys = result[1] || result.keys || [];

            for (const key of keys) {
                try {
                    const data = await redis.get(key);
                    const user = typeof data === 'string' ? JSON.parse(data) : data;
                    const samples = user?.xp_rate?.hourly_samples;
                    if (!samples || samples.length < minSamplesNum) continue;

                    // Count samples above threshold
                    const highRateSamples = samples.filter(s => s.rate >= minRateNum);
                    if (highRateSamples.length >= minSamplesNum) {
                        const avgRate = Math.round(highRateSamples.reduce((sum, s) => sum + s.rate, 0) / highRateSamples.length);
                        anomalies.push({
                            unified_id: user.unified_id,
                            display_name: user.display_name,
                            level: user.level,
                            xp: user.xp,
                            high_rate_count: highRateSamples.length,
                            total_samples: samples.length,
                            avg_high_rate: avgRate,
                            recent_samples: samples.slice(-5)
                        });
                    }
                } catch (e) {
                    // Skip
                }
            }
        } while (cursor !== "0" && cursor !== 0);

        anomalies.sort((a, b) => b.avg_high_rate - a.avg_high_rate);

        res.json({
            total: anomalies.length,
            min_rate: minRateNum,
            min_samples: minSamplesNum,
            accounts: anomalies
        });
    } catch (error) {
        console.error('Admin xp-rate-anomalies error:', error.message);
        res.status(500).json({ error: 'Failed to query XP rate anomalies' });
    }
});

// =============================================================================
// REMOTE CONTROL ENDPOINTS
// =============================================================================

const REMOTE_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // No 0/O/1/I/L
const REMOTE_SESSION_TTL = 4 * 60 * 60; // 4 hours in seconds
const REMOTE_CONTROLLER_STALE_SECONDS = 15;

const REMOTE_TIER_ACTIONS = {
    light: [
        'trigger_flash', 'trigger_subliminal',
        'show_pink_filter', 'stop_pink_filter',
        'show_spiral', 'stop_spiral',
        'set_pink_opacity', 'set_spiral_opacity',
        'start_bubbles', 'stop_bubbles',
        'trigger_panic'
    ],
    standard: [
        'trigger_flash', 'trigger_subliminal',
        'show_pink_filter', 'stop_pink_filter',
        'show_spiral', 'stop_spiral',
        'set_pink_opacity', 'set_spiral_opacity',
        'start_bubbles', 'stop_bubbles',
        'trigger_panic',
        'trigger_video', 'trigger_haptic',
        'duck_audio', 'unduck_audio'
    ],
    full: [
        'trigger_flash', 'trigger_subliminal',
        'show_pink_filter', 'stop_pink_filter',
        'show_spiral', 'stop_spiral',
        'set_pink_opacity', 'set_spiral_opacity',
        'start_bubbles', 'stop_bubbles',
        'trigger_panic',
        'trigger_video', 'trigger_haptic',
        'duck_audio', 'unduck_audio',
        'start_autonomy', 'stop_autonomy',
        'trigger_bubble_count',
        'enable_strict_lock', 'disable_strict_lock',
        'disable_panic', 'enable_panic'
    ]
};

function generateRemoteCode() {
    const crypto = require('crypto');
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += REMOTE_CODE_CHARSET[bytes[i] % REMOTE_CODE_CHARSET.length];
    }
    return code;
}

/**
 * POST /v2/remote/start
 * Sub starts a remote control session. Generates a 6-char code.
 * Body: { unified_id: string, tier: "light"|"standard"|"full" }
 */
app.post('/v2/remote/start', async (req, res) => {
    try {
        const { unified_id, tier } = req.body;

        if (!unified_id) return res.status(400).json({ error: 'unified_id required' });
        if (!tier || !REMOTE_TIER_ACTIONS[tier]) {
            return res.status(400).json({ error: 'Invalid tier. Must be light, standard, or full' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        // Verify user exists
        const userData = await redis.get(`user:${unified_id}`);
        if (!userData) return res.status(404).json({ error: 'User not found' });

        const user = typeof userData === 'string' ? JSON.parse(userData) : userData;

        // Check for existing session and clean it up
        const existingCode = await redis.get(`remote:lookup:${unified_id}`);
        if (existingCode) {
            await redis.del(`remote:${existingCode}`);
            await redis.del(`remote:commands:${existingCode}`);
            await redis.del(`remote:status:${existingCode}`);
            await redis.del(`remote:lookup:${unified_id}`);
        }

        // Generate unique code (retry if collision)
        let code;
        for (let attempt = 0; attempt < 10; attempt++) {
            code = generateRemoteCode();
            const existing = await redis.get(`remote:${code}`);
            if (!existing) break;
            if (attempt === 9) return res.status(500).json({ error: 'Failed to generate unique code' });
        }

        const now = new Date().toISOString();
        const expiresAt = new Date(Date.now() + REMOTE_SESSION_TTL * 1000).toISOString();

        const session = {
            unified_id,
            display_name: user.display_name || 'Anonymous',
            tier,
            created_at: now,
            controller_connected: false,
            controller_id: null,
            last_controller_ping: null
        };

        // Store session data + lookup + initial status, all with TTL
        await redis.set(`remote:${code}`, JSON.stringify(session), { ex: REMOTE_SESSION_TTL });
        await redis.set(`remote:lookup:${unified_id}`, code, { ex: REMOTE_SESSION_TTL });
        await redis.set(`remote:status:${code}`, JSON.stringify({
            online: true,
            last_poll: now,
            last_executed: null,
            active_services: [],
            level: user.level || 1
        }), { ex: REMOTE_SESSION_TTL });

        console.log(`[Remote] Session started: ${code} by ${user.display_name} (${unified_id}), tier: ${tier}`);

        res.json({ code, expires_at: expiresAt });
    } catch (error) {
        console.error('Remote start error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v2/remote/stop
 * Sub ends the remote control session.
 * Body: { unified_id: string }
 */
app.post('/v2/remote/stop', async (req, res) => {
    try {
        const { unified_id } = req.body;
        if (!unified_id) return res.status(400).json({ error: 'unified_id required' });
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const code = await redis.get(`remote:lookup:${unified_id}`);
        if (!code) return res.status(404).json({ error: 'No active session' });

        await redis.del(`remote:${code}`);
        await redis.del(`remote:commands:${code}`);
        await redis.del(`remote:status:${code}`);
        await redis.del(`remote:lookup:${unified_id}`);

        console.log(`[Remote] Session stopped: ${code} by ${unified_id}`);

        res.json({ ok: true });
    } catch (error) {
        console.error('Remote stop error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v2/remote/poll
 * Sub polls for pending commands from the controller.
 * Body: { unified_id: string }
 */
app.post('/v2/remote/poll', async (req, res) => {
    try {
        const { unified_id } = req.body;
        if (!unified_id) return res.status(400).json({ error: 'unified_id required' });
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const code = await redis.get(`remote:lookup:${unified_id}`);
        if (!code) return res.status(404).json({ error: 'No active session' });

        // Pop up to 5 commands from the queue (RPOP from right end of list)
        const commands = [];
        for (let i = 0; i < 5; i++) {
            const cmd = await redis.rpop(`remote:commands:${code}`);
            if (!cmd) break;
            commands.push(typeof cmd === 'string' ? JSON.parse(cmd) : cmd);
        }

        // Update status with last_poll timestamp
        const statusRaw = await redis.get(`remote:status:${code}`);
        const status = statusRaw ? (typeof statusRaw === 'string' ? JSON.parse(statusRaw) : statusRaw) : {};
        status.online = true;
        status.last_poll = new Date().toISOString();
        await redis.set(`remote:status:${code}`, JSON.stringify(status), { ex: REMOTE_SESSION_TTL });

        // Get session to check controller status
        const sessionRaw = await redis.get(`remote:${code}`);
        const session = sessionRaw ? (typeof sessionRaw === 'string' ? JSON.parse(sessionRaw) : sessionRaw) : {};

        // Check if controller is stale
        let controllerConnected = session.controller_connected || false;
        if (controllerConnected && session.last_controller_ping) {
            const pingAge = (Date.now() - new Date(session.last_controller_ping).getTime()) / 1000;
            if (pingAge > REMOTE_CONTROLLER_STALE_SECONDS) {
                controllerConnected = false;
                session.controller_connected = false;
                session.controller_id = null;
                await redis.set(`remote:${code}`, JSON.stringify(session), { ex: REMOTE_SESSION_TTL });
            }
        }

        res.json({ commands, controller_connected: controllerConnected });
    } catch (error) {
        console.error('Remote poll error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v2/remote/status
 * Sub pushes current app status for the controller to see.
 * Body: { unified_id: string, active_services: string[], level: number, last_executed: object|null }
 */
app.post('/v2/remote/status', async (req, res) => {
    try {
        const { unified_id, active_services, level, last_executed } = req.body;
        if (!unified_id) return res.status(400).json({ error: 'unified_id required' });
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const code = await redis.get(`remote:lookup:${unified_id}`);
        if (!code) return res.status(404).json({ error: 'No active session' });

        const status = {
            online: true,
            last_poll: new Date().toISOString(),
            last_executed: last_executed || null,
            active_services: active_services || [],
            level: level || 1
        };

        await redis.set(`remote:status:${code}`, JSON.stringify(status), { ex: REMOTE_SESSION_TTL });

        res.json({ ok: true });
    } catch (error) {
        console.error('Remote status error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /remote/connect
 * Controller connects to a Sub's session using the 6-char code.
 * Body: { code: string }
 */
app.post('/remote/connect', async (req, res) => {
    try {
        const { code } = req.body;
        if (!code || code.length !== 6) return res.status(400).json({ error: 'Valid 6-character code required' });
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const normalizedCode = code.toUpperCase();
        const sessionRaw = await redis.get(`remote:${normalizedCode}`);
        if (!sessionRaw) return res.status(404).json({ error: 'Session not found or expired' });

        const session = typeof sessionRaw === 'string' ? JSON.parse(sessionRaw) : sessionRaw;

        // If another controller is connected, replace it (they may have closed the page)
        if (session.controller_connected && session.controller_id) {
            console.log(`[Remote] Replacing previous controller on ${normalizedCode}`);
        }

        const crypto = require('crypto');
        const controllerId = crypto.randomUUID();
        const now = new Date().toISOString();

        session.controller_connected = true;
        session.controller_id = controllerId;
        session.last_controller_ping = now;

        await redis.set(`remote:${normalizedCode}`, JSON.stringify(session), { ex: REMOTE_SESSION_TTL });

        // Get status for initial data
        const statusRaw = await redis.get(`remote:status:${normalizedCode}`);
        const status = statusRaw ? (typeof statusRaw === 'string' ? JSON.parse(statusRaw) : statusRaw) : {};

        console.log(`[Remote] Controller connected to ${normalizedCode} (${session.display_name})`);

        res.json({
            controller_id: controllerId,
            tier: session.tier,
            display_name: session.display_name,
            level: status.level || 1
        });
    } catch (error) {
        console.error('Remote connect error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /remote/command
 * Controller sends a command to the Sub's app.
 * Body: { code: string, controller_id: string, action: string, params: object }
 */
app.post('/remote/command', async (req, res) => {
    try {
        const { code, controller_id, action, params } = req.body;
        if (!code || !controller_id || !action) {
            return res.status(400).json({ error: 'code, controller_id, and action required' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const normalizedCode = code.toUpperCase();
        const sessionRaw = await redis.get(`remote:${normalizedCode}`);
        if (!sessionRaw) return res.status(404).json({ error: 'Session not found or expired' });

        const session = typeof sessionRaw === 'string' ? JSON.parse(sessionRaw) : sessionRaw;

        // Validate controller identity
        if (session.controller_id !== controller_id) {
            return res.status(403).json({ error: 'Invalid controller_id' });
        }

        // Validate action against tier
        const allowedActions = REMOTE_TIER_ACTIONS[session.tier] || [];
        if (!allowedActions.includes(action)) {
            return res.status(403).json({ error: `Action '${action}' not permitted for tier '${session.tier}'` });
        }

        // Rate limit: max 1 command per second per session
        const rateLimitKey = `remote:ratelimit:${normalizedCode}`;
        const lastCmd = await redis.get(rateLimitKey);
        if (lastCmd) {
            return res.status(429).json({ error: 'Rate limit: max 1 command per second' });
        }
        await redis.set(rateLimitKey, '1', { ex: 1 });

        // Update controller ping
        session.last_controller_ping = new Date().toISOString();
        await redis.set(`remote:${normalizedCode}`, JSON.stringify(session), { ex: REMOTE_SESSION_TTL });

        // Build command and push to queue
        const crypto = require('crypto');
        const command = {
            id: crypto.randomUUID(),
            action,
            params: params || {},
            sent_at: new Date().toISOString()
        };

        await redis.lpush(`remote:commands:${normalizedCode}`, JSON.stringify(command));
        // Ensure the command list has a TTL
        await redis.expire(`remote:commands:${normalizedCode}`, REMOTE_SESSION_TTL);

        res.json({ ok: true, command_id: command.id });
    } catch (error) {
        console.error('Remote command error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /remote/status/:code
 * Controller polls the Sub's current status.
 * Query: ?controller_id=uuid
 */
app.get('/remote/status/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const { controller_id } = req.query;
        if (!code || !controller_id) {
            return res.status(400).json({ error: 'code and controller_id required' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const normalizedCode = code.toUpperCase();
        const sessionRaw = await redis.get(`remote:${normalizedCode}`);
        if (!sessionRaw) return res.status(404).json({ error: 'Session not found or expired' });

        const session = typeof sessionRaw === 'string' ? JSON.parse(sessionRaw) : sessionRaw;

        if (session.controller_id !== controller_id) {
            return res.status(403).json({ error: 'Invalid controller_id' });
        }

        // Update controller ping
        session.last_controller_ping = new Date().toISOString();
        await redis.set(`remote:${normalizedCode}`, JSON.stringify(session), { ex: REMOTE_SESSION_TTL });

        // Get sub status
        const statusRaw = await redis.get(`remote:status:${normalizedCode}`);
        const status = statusRaw ? (typeof statusRaw === 'string' ? JSON.parse(statusRaw) : statusRaw) : {};

        // Check if sub is still online (last poll within 15 seconds)
        let online = false;
        if (status.last_poll) {
            const pollAge = (Date.now() - new Date(status.last_poll).getTime()) / 1000;
            online = pollAge < 15;
        }

        res.json({
            online,
            last_poll: status.last_poll || null,
            last_executed: status.last_executed || null,
            active_services: status.active_services || [],
            level: status.level || 1
        });
    } catch (error) {
        console.error('Remote status error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /remote/disconnect
 * Controller disconnects from the session.
 * Body: { code: string, controller_id: string }
 */
app.post('/remote/disconnect', async (req, res) => {
    try {
        const { code, controller_id } = req.body;
        if (!code || !controller_id) {
            return res.status(400).json({ error: 'code and controller_id required' });
        }
        if (!redis) return res.status(503).json({ error: 'Redis not available' });

        const normalizedCode = code.toUpperCase();
        const sessionRaw = await redis.get(`remote:${normalizedCode}`);
        if (!sessionRaw) return res.status(404).json({ error: 'Session not found or expired' });

        const session = typeof sessionRaw === 'string' ? JSON.parse(sessionRaw) : sessionRaw;

        if (session.controller_id !== controller_id) {
            return res.status(403).json({ error: 'Invalid controller_id' });
        }

        session.controller_connected = false;
        session.controller_id = null;
        session.last_controller_ping = null;

        await redis.set(`remote:${normalizedCode}`, JSON.stringify(session), { ex: REMOTE_SESSION_TTL });

        console.log(`[Remote] Controller disconnected from ${normalizedCode}`);

        res.json({ ok: true });
    } catch (error) {
        console.error('Remote disconnect error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        patreon_configured: !!CONFIG.PATREON_CLIENT_ID,
        discord_configured: !!CONFIG.DISCORD_CLIENT_ID,
        openrouter_configured: !!CONFIG.OPENROUTER_API_KEY,
        ai_model: CONFIG.AI_MODEL,
        rate_limit: {
            enabled: !!redis,
            daily_requests: RATE_LIMIT.DAILY_REQUESTS
        },
        profile_sync: {
            enabled: !!redis
        },
        pack_downloads: {
            enabled: true,
            daily_limit: PACK_RATE_LIMIT.DOWNLOADS_PER_DAY,
            bunny_configured: !!BUNNY_CONFIG.SECURITY_KEY
        }
    });
});

// =============================================================================
// START SERVER (for local development) / EXPORT (for Vercel)
// =============================================================================

// Export for Vercel serverless
module.exports = app;

// Only start server if running directly (not imported by Vercel)
if (require.main === module) {
    app.listen(CONFIG.PORT, () => {
        console.log(`Patreon proxy server running on port ${CONFIG.PORT}`);
        console.log(`Health check: http://localhost:${CONFIG.PORT}/health`);
        console.log(`AI Model: ${CONFIG.AI_MODEL}`);

        // Warn about missing config
        if (!CONFIG.PATREON_CLIENT_ID) {
            console.warn('WARNING: PATREON_CLIENT_ID not set');
        }
        if (!CONFIG.PATREON_CLIENT_SECRET) {
            console.warn('WARNING: PATREON_CLIENT_SECRET not set');
        }
        if (!CONFIG.OPENROUTER_API_KEY) {
            console.warn('WARNING: OPENROUTER_API_KEY not set');
        }
    });
}
