namespace ConditioningControlPanel.Models.CommandData;

public record GetBackToMe(
    int Delay,
    string Token, 
    List<AICommand>? Commands, 
    string? Text, 
    bool JsonOnly 
): AICommandData;