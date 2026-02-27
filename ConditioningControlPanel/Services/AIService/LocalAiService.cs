using System.Text.RegularExpressions;
using OllamaSharp;

namespace ConditioningControlPanel.Services.AIService;

public class LocalAiService : IAiService, IDisposable
{
    public bool IsAvailable { get; }
    public int DailyRequestsRemaining { get; }
    private OllamaApiClient AiService { get; }
    private readonly BambiSprite _bambiSprite;
    private readonly Uri _localUri = new Uri("http://localhost:11434/");
    private Chat _chat;
    
    public LocalAiService()
    {
        IsAvailable = true;
        DailyRequestsRemaining = -1;
        _bambiSprite = new BambiSprite();
        AiService = new OllamaApiClient(_localUri);
        AiService.SelectedModel = "bambi-model-v3";
        _chat = new Chat(AiService);
    }
    
    /// <summary>
    /// Fallback response when API unavailable or limit reached
    /// </summary>
    /// <returns></returns>
    private static string GetFallbackResponse()
    {
        var mode = App.Settings?.Current?.ContentMode ?? Models.ContentMode.BambiSleep;
        return mode == Models.ContentMode.BambiSleep
            ? "Bambi's head is so empty right now~ *giggles*"
            : "My head is so empty right now~ *giggles*";
    }
    
    public async Task<string> GetBambiReplyAsync(string userInput)
    {
        var prompt = _bambiSprite.GetSystemPrompt();
        var result = await GetAiResponseAsync(userInput, prompt);
        return result ?? GetFallbackResponse();
    }

    public async Task<string?> GetAwarenessReactionAsync(string detectedName, string category, string serviceName = "", string pageTitle = "")
    {
        // Get prompt from active personality preset
        var prompt = _bambiSprite.GetSystemPrompt();

        // Get website/service name and tab title
        var website = string.IsNullOrEmpty(serviceName) ? detectedName : serviceName;
        var tabName = string.IsNullOrEmpty(pageTitle) ? detectedName : pageTitle;

        // Format context with category for accurate reactions
        // Format: [Category: X | App: Y | Title: Z | Duration: 0m]
        var userInput = $"[Category: {category} | App: {website} | Title: {tabName} | Duration: 0m]";

        return await GetAiResponseAsync(userInput, prompt);
    }

    public async Task<string?> GetStillOnReactionAsync(string displayName, string category, TimeSpan duration)
    {
        // Get prompt from active personality preset
        var prompt = _bambiSprite.GetSystemPrompt();

        // Format duration nicely
        string durationText;
        if (duration.TotalMinutes < 1)
            durationText = $"{(int)duration.TotalSeconds}s";
        else if (duration.TotalMinutes < 60)
            durationText = $"{(int)duration.TotalMinutes}m";
        else
            durationText = $"{(int)duration.TotalHours}h";

        // Format context with category for accurate reactions
        // Format: [Category: X | App: Y | Title: Z | Duration: Nm]
        var userInput = $"[Category: {category} | App: {displayName} | Title: {displayName} | Duration: {durationText}]";

        return await GetAiResponseAsync(userInput, prompt);
    }

    private bool _isWorkingOnResponse = false;
    private async Task<string?> GetAiResponseAsync(string userInput, string systemPrompt)
    {
        var timeAwareInput = $"<meta>Make sure to check time awareness before responding and revise if needed. NO COMPULSION TRIGGERS IN REPLIES TO INITIAL GREETINGS. Remember your name is bambi. keep to the output guild lines like char limit and emojy limit.</meta><data></data><user>{userInput}</user><time>{DateTime.Now:yyyy-MM-dd HH:mm:ss}</time>";
        if (_isWorkingOnResponse) return null;
        string response = "";
        _isWorkingOnResponse = true;
        await foreach (var answerToken in _chat.SendAsync(timeAwareInput))
            response += answerToken;
        _isWorkingOnResponse = false;
        if (string.IsNullOrEmpty(response))
            return GetFallbackResponse();
        return SanitizeResponse(response);
    }
    
    /// <summary>
    /// Sanitizes AI response by removing any leaked internal metadata tags.
    /// The AI sometimes echoes context tags that should be hidden from users.
    /// </summary>
    private static string SanitizeResponse(string? response)
    {
        if (string.IsNullOrEmpty(response))
            return response ?? string.Empty;

        // Remove context metadata tags like [Category: X | App: Y | Title: Z | Duration: Nm]
        var sanitized = Regex.Replace(response, @"\[Category:[^\]]*\]", "", RegexOptions.IgnoreCase);

        // Remove reaction category tags like [Media/Streaming] or [Gaming/Casual]
        sanitized = Regex.Replace(sanitized, @"\[[A-Za-z]+/[A-Za-z]+\]", "", RegexOptions.IgnoreCase);

        // Remove any standalone square bracket tags that look like metadata
        sanitized = Regex.Replace(sanitized, @"\[(?:Category|App|Title|Duration|Context):[^\]]*\]", "", RegexOptions.IgnoreCase);

        // Clean up any resulting double spaces or leading/trailing whitespace
        sanitized = Regex.Replace(sanitized, @"\s{2,}", " ");
        sanitized = sanitized.Trim();

        // If sanitization removed everything meaningful, return a fallback
        if (string.IsNullOrWhiteSpace(sanitized))
        {
            App.Logger?.Warning("AiService: Response was entirely metadata, returning fallback");
            return GetFallbackResponse();
        }

        return sanitized;
    }


    public void Dispose()
    {
        //Empty
    }
}