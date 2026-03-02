namespace ConditioningControlPanel.Models.CommandData;

public record Media(
    string Title,
    string Path
) : AICommandData;