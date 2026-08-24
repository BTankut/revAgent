using System.Diagnostics;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Dispatch;
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

/// <summary>
/// The P3-T5 invocation-journal handoff receipt. The durable receipt row
/// accepts only a bounded journal-record identifier and a lowercase SHA-256
/// digest of that record; arbitrary context JSON, parameters, and paths MUST
/// NOT enter the compacted row (see the P3-T4b compaction contract in
/// <c>packages/bridge/README.md</c> and <c>RbpJournalWriteContext</c>).
/// </summary>
internal sealed record RbpInboundJournalReceipt(
    string CorrelationId,
    string JournalRecordDigest);

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
    TimeSpan? CloseTimeout = null,
    TimeSpan? InvocationDrainTimeout = null,
    IRbpCredentialClaimInvalidator? CredentialClaimInvalidator = null,
    IRbpSessionRouteBindingAuthority? SessionRouteBindingAuthority = null)
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

    /// <summary>
    /// How long a closing cycle waits for in-flight invocations to reach a
    /// durable decision.
    /// </summary>
    /// <remarks>
    /// P-UPD-4 states the worker "finishes in-flight invocation **or journals
    /// it**", so this budget may expire without loss: the dispatcher persists
    /// the terminal outcome before returning, and a redelivery is then answered
    /// from the journal under Section 12.2 rule 1. Kept short so the P3-T2
    /// sub-10s service stop holds even with an add-in call outstanding.
    /// </remarks>
    internal TimeSpan EffectiveInvocationDrainTimeout =>
        InvocationDrainTimeout ?? TimeSpan.FromSeconds(3);
}

internal enum RbpCoordinatorErrorCode
{
    AlreadyRunning,
    InvalidCatalogSnapshot,
    InvalidControlPayload,
    UnexpectedControl,
    SessionAuthorityConflict,
    SessionRouteBindingFailed,
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
    int OwnedBackgroundTaskCount,
    int ActiveInvocationCount = 0);
