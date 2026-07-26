namespace RevAgent.Bridge.Bootstrap.Logging;

internal interface IBridgeLog : IAsyncDisposable
{
    internal ValueTask WriteAsync(
        string level,
        string eventId,
        string category,
        string message,
        Exception? exception = null,
        CancellationToken cancellationToken = default);
}
