using System.Text.Json;

namespace RevAgent.Bridge.Gateway.Storage;

/// <summary>
/// Frozen O1 Section 12.1 batch coordination states. <c>received</c> durably
/// proves that no add-in byte was sent for this batch; <c>dispatched</c>
/// records that atomic dispatch or ordered fan-out may have started;
/// <c>terminal</c> carries the immutable durable batch outcome.
/// </summary>
internal enum RbpBatchState
{
    Received,
    Dispatched,
    Terminal,
}

/// <summary>
/// One frozen Section 11 batch step exactly as it participates in the
/// <c>batch_digest</c> material: identity, method, mutability, scope, the
/// explicit on-wire <c>params_digest</c>, and the complete policy binding
/// with <c>confirmation_id</c> explicitly null when unused.
/// </summary>
internal sealed record RbpBatchStepIdentity(
    string InvocationId,
    string Method,
    bool Mutating,
    string? MutationScopeJcs,
    string ParamsDigest,
    string PolicyClass,
    string? ConfirmationId,
    string Decision);

/// <summary>
/// The immutable identity a batch is admitted under: the verified Section 11
/// <c>batch_digest</c>, <c>batch_id</c>, <c>atomic</c> flag, timeout, the
/// canonical recovery-clearance array, and the complete ordered step set.
/// Spec ~1071-1075 requires every element durably bound before any add-in
/// byte; spec ~1102-1105 makes any changed element on redelivery a terminal
/// <c>protocol</c> fault.
/// </summary>
internal sealed record RbpBatchIdentity(
    string Rsid,
    string BatchId,
    string BatchDigest,
    bool Atomic,
    long TimeoutMilliseconds,
    string RecoveryClearancesJcs,
    IReadOnlyList<RbpBatchStepIdentity> Steps)
{
    internal string BatchKey => Rsid + "/" + BatchId;
}

/// <summary>
/// A durable batch coordination row as stored. <c>StepsJcs</c> is the RFC
/// 8785 serialization of the complete ordered step representation, so step
/// omission, reordering, or any per-step change is detectable by ordinal
/// comparison alone; no journal path reconstructs a batch from a prefix or
/// from digest-only steps.
/// </summary>
internal sealed record RbpStoredBatch(
    string Rsid,
    string BatchId,
    string BatchDigest,
    bool Atomic,
    long TimeoutMilliseconds,
    string RecoveryClearancesJcs,
    string StepsJcs,
    long StepCount,
    RbpBatchState State,
    string? TerminalOutcomeJson,
    string? ResultDigest,
    long CreatedAtMilliseconds,
    long? DispatchedAtMilliseconds,
    long? FinishedAtMilliseconds)
{
    internal string BatchKey => Rsid + "/" + BatchId;
}

/// <summary>
/// What the caller must do with an admitted batch, mirroring the frozen
/// Section 12.2 <c>invoke_batch</c> redelivery rules (~1102-1131) so no rule
/// is decided ad hoc at the call site.
/// </summary>
internal enum RbpBatchAdmission
{
    /// <summary>
    /// First delivery: the coordination row and every ordered step row are
    /// durable before any add-in byte may be written.
    /// </summary>
    Accepted,

    /// <summary>
    /// A durable terminal batch outcome replays with identical semantics
    /// without calling the add-in (spec ~1121-1122).
    /// </summary>
    ReplayTerminal,

    /// <summary>
    /// An <c>atomic:true</c> coordination row still in <c>received</c>
    /// durably proves that no add-in byte was sent, so the batch may execute
    /// once (spec ~1122-1123).
    /// </summary>
    ExecuteFromReceived,

    /// <summary>
    /// Atomic dispatch may have started and the terminal outcome is missing:
    /// the whole transaction and all possibly mutating steps are
    /// indeterminate, holds are installed per distinct conflicting mutation
    /// scope, and no individual step is retried (spec ~1123-1131).
    /// </summary>
    DispatchLossArbitrated,

    /// <summary>
    /// An <c>atomic:false</c> redelivery arbitrated step by step under spec
    /// ~1109-1119: replayed terminal prefix, stop at the first terminal
    /// non-success, rule-3 read retry or rule-4 mutating refusal at the
    /// first non-terminal step, <c>not_started</c> suffix.
    /// </summary>
    ArbitratedSteps,
}

/// <summary>
/// The per-step outcome of batch redelivery arbitration, applying the frozen
/// Section 12.2 core to each ordered step.
/// </summary>
internal enum RbpBatchStepDisposition
{
    /// <summary>The step row is durably <c>received</c> and may dispatch.</summary>
    Accepted,

    /// <summary>Rule 1: the stored terminal outcome replays; no add-in call.</summary>
    ReplayTerminal,

    /// <summary>Rule 2: evidence-only replay of a late durable terminal after
    /// <c>journal_indeterminate</c>; the hold is not cleared by this replay.</summary>
    ReplayLateAfterIndeterminate,

    /// <summary>Rule 3: the first non-terminal read step may execute once.</summary>
    RetryNonMutating,

    /// <summary>Rule 4: a possibly dispatched mutation is refused as
    /// <c>journal_indeterminate</c> with its Section 6.2.1 scope hold.</summary>
    RefuseIndeterminate,

    /// <summary>The narrow known <c>environment</c> failure for a read whose
    /// atomic carrier is unavailable; never a synthetic success
    /// (spec ~983-994, ~1128-1129).</summary>
    EnvironmentFailed,

    /// <summary>An ordered successor behind the stopping step.</summary>
    NotStarted,
}

/// <summary>
/// One arbitrated step: its input position, the frozen rule that applied,
/// the durable row the caller must answer from, and the hold correlation
/// when rule 4 applied.
/// </summary>
internal sealed record RbpBatchStepArbitration(
    int BatchIndex,
    string InvocationId,
    RbpBatchStepDisposition Disposition,
    RbpStoredInvocation? Stored,
    string? VerificationHoldId);

/// <summary>
/// The outcome of admitting a batch. <see cref="FirstNonSuccessStepIndex"/>
/// is the earliest step known terminal and not <c>completed</c>;
/// <see cref="ReplayPermitted"/> is true only when no step may execute
/// during this delivery (spec ~1117-1119, ~1129-1131).
/// </summary>
internal sealed record RbpBatchAdmissionResult(
    RbpBatchAdmission Admission,
    RbpStoredBatch Stored,
    IReadOnlyList<RbpBatchStepArbitration> Steps,
    int? FirstNonSuccessStepIndex,
    bool ReplayPermitted);

/// <summary>
/// The outcome of a clearance-gated batch admission. Exactly one property is
/// set: a blocked batch wrote no coordination or step row and must be
/// answered from the blocking hold without add-in contact
/// (Section 21 item 28).
/// </summary>
internal sealed record RbpBatchGatedAdmission(
    RbpBatchAdmissionResult? Admission,
    RbpVerificationHold? BlockingHold);

/// <summary>
/// The durable terminal batch outcome persisted before any Section 11.1
/// carrier reaches the Gateway.
/// </summary>
internal sealed record RbpBatchTerminal(
    JsonElement Outcome,
    string ResultDigest);
