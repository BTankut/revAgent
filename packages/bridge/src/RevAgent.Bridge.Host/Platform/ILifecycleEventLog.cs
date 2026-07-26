namespace RevAgent.Bridge.Host.Platform;

internal enum LifecycleEventLevel
{
    Information,
    Warning,
    Error,
}

internal sealed record LifecycleEvent(
    int EventId,
    string Code,
    LifecycleEventLevel Level,
    string Message,
    DateTimeOffset Timestamp);

internal interface ILifecycleEventLog
{
    bool EnsureSource();

    void Write(LifecycleEvent entry);

    void RemoveSource();
}
