using System.Diagnostics;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed record RbpLocalSessionSnapshot(
    string LocalSessionKey,
    JsonElement RegistrationPayload,
    int Port,
    JsonElement RevitStatus);

internal interface IRbpLocalSessionCatalog
{
    Task<IReadOnlyList<RbpLocalSessionSnapshot>> ReadAsync(
        CancellationToken cancellationToken = default);
}

internal sealed record RbpInboundJournalReceipt(
    string CorrelationId,
    string ContextJson);

internal interface IRbpInboundDataJournal
{
    RbpInboundJournalReceipt Journal(
        RbpJournalWriteContext context,
        RbpDataEnvelopeSnapshot envelope);
}

internal sealed class FailClosedRbpInboundDataJournal :
    IRbpInboundDataJournal
{
    internal static FailClosedRbpInboundDataJournal Instance { get; } = new();

    private FailClosedRbpInboundDataJournal()
    {
    }

    public RbpInboundJournalReceipt Journal(
        RbpJournalWriteContext context,
        RbpDataEnvelopeSnapshot envelope)
    {
        _ = context;
        _ = envelope;
        throw new RbpCoordinatorException(
            RbpCoordinatorErrorCode.InboundJournalUnavailable,
            "Inbound RBP data cannot be acknowledged until the invocation " +
            "journal handoff is installed.");
    }
}

internal interface IRbpCoordinatorClock
{
    DateTimeOffset UtcNow { get; }

    long MonotonicMilliseconds { get; }

    Task DelayAsync(
        TimeSpan delay,
        CancellationToken cancellationToken = default);
}

internal sealed class SystemRbpCoordinatorClock : IRbpCoordinatorClock
{
    internal static SystemRbpCoordinatorClock Instance { get; } = new();

    private SystemRbpCoordinatorClock()
    {
    }

    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

    public long MonotonicMilliseconds
    {
        get
        {
            double milliseconds =
                Stopwatch.GetTimestamp() * 1000d / Stopwatch.Frequency;
            return checked((long)Math.Floor(milliseconds));
        }
    }

    public Task DelayAsync(
        TimeSpan delay,
        CancellationToken cancellationToken = default) =>
        Task.Delay(delay, cancellationToken);
}

internal sealed record RbpConnectionCoordinatorOptions(
    Uri Endpoint,
    RbpHelloProfile HelloProfile,
    TimeSpan? HeartbeatAcknowledgementTimeout = null,
    TimeSpan? HeartbeatCompletionTimeout = null,
    TimeSpan? WakeGapThreshold = null,
    TimeSpan? CloseTimeout = null)
{
    internal TimeSpan EffectiveHeartbeatAcknowledgementTimeout =>
        HeartbeatAcknowledgementTimeout ?? TimeSpan.FromSeconds(10);

    internal TimeSpan EffectiveWakeGapThreshold =>
        WakeGapThreshold ??
        TimeSpan.FromMilliseconds(
            RbpConnectionReducer.HeartbeatDisconnectedAfterMilliseconds);

    internal TimeSpan EffectiveHeartbeatCompletionTimeout =>
        HeartbeatCompletionTimeout ??
        TimeSpan.FromMilliseconds(
            RbpConnectionReducer.HeartbeatDisconnectedAfterMilliseconds);

    internal TimeSpan EffectiveCloseTimeout =>
        CloseTimeout ?? TimeSpan.FromSeconds(2);
}

internal enum RbpCoordinatorErrorCode
{
    AlreadyRunning,
    InvalidCatalogSnapshot,
    InvalidControlPayload,
    UnexpectedControl,
    SessionAuthorityConflict,
    InboundJournalUnavailable,
    HeartbeatTimeout,
    HeartbeatApplicationTimeout,
    NonDrainingConnectionAuthority,
    SequenceFault,
}

internal sealed class RbpCoordinatorException : Exception
{
    internal RbpCoordinatorException(
        RbpCoordinatorErrorCode errorCode,
        string message,
        Exception? innerException = null)
        : base(message, innerException)
    {
        ErrorCode = errorCode;
    }

    internal RbpCoordinatorErrorCode ErrorCode { get; }
}

internal sealed record RbpConnectionCoordinatorSnapshot(
    RbpConnectionLifecycleState Lifecycle,
    long ConnectionGeneration,
    bool HasActiveConnection,
    IReadOnlyList<string> ActiveRsids,
    int OwnedBackgroundTaskCount);
