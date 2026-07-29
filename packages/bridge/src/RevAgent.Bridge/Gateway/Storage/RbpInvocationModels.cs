using System.Text.Json;

namespace RevAgent.Bridge.Gateway.Storage;

/// <summary>
/// Frozen O1 Section 12.1 invocation states. The only legal progression is
/// <c>received -&gt; executing -&gt; completed|failed|guarded|cancelled|indeterminate</c>.
/// </summary>
internal enum RbpInvocationState
{
    Received,
    Executing,
    Completed,
    Failed,
    Guarded,
    Cancelled,
    Indeterminate,
}

/// <summary>
/// Frozen O1 Section 12.1 hold states for the distinct mutation-recovery
/// relation. A hold is never a flag on the invocation row.
/// </summary>
internal enum RbpHoldState
{
    Active,
    EvidenceRecorded,
    ResolvedPendingBridge,
    Cleared,
}

/// <summary>
/// The immutable identity an invocation is admitted under. Every field
/// participates in the Section 12.2 rule 5 mismatch check: the same
/// canonical key with a different digest, method, scope, policy, clearance,
/// or batch binding is a terminal <c>protocol</c> fault.
/// </summary>
internal sealed record RbpInvocationIdentity(
    string Rsid,
    string InvocationId,
    string Method,
    bool Mutating,
    string? MutationScopeJcs,
    string ParamsDigest,
    string PolicyJcs,
    string RecoveryClearancesJcs,
    string? BatchId = null,
    long? BatchIndex = null)
{
    internal string IdempotencyKey => Rsid + "/" + InvocationId;
}

/// <summary>
/// A durable invocation row as stored, including any late evidence recorded
/// after an indeterminate terminal.
/// </summary>
internal sealed record RbpStoredInvocation(
    RbpInvocationIdentity Identity,
    RbpInvocationState State,
    string? TerminalOutcomeJson,
    string? ResultDigest,
    string? VerificationHoldId,
    string? VerificationCorrelationJson,
    string? LateTerminalOutcomeJson,
    string? LateResultDigest,
    long CreatedAtMilliseconds,
    long? StartedAtMilliseconds,
    long? FinishedAtMilliseconds)
{
    internal bool IsTerminal =>
        State is not (RbpInvocationState.Received or RbpInvocationState.Executing);
}

/// <summary>
/// What the caller must do with an admitted invocation. Mirrors the frozen
/// Section 12.2 redelivery rules one-for-one so no rule is decided ad hoc at
/// the call site.
/// </summary>
internal enum RbpInvocationAdmission
{
    /// <summary>First delivery: <c>received</c> persisted, dispatch may proceed.</summary>
    Accepted,

    /// <summary>Rule 1: a known terminal row replays; the add-in is not called.</summary>
    ReplayTerminal,

    /// <summary>
    /// Rule 2: an indeterminate row carrying a later durable terminal outcome
    /// replays as evidence only. The add-in is not called and the hold is NOT
    /// cleared by this replay.
    /// </summary>
    ReplayLateAfterIndeterminate,

    /// <summary>
    /// Rule 3: a non-terminal, non-mutating row may execute once more. The
    /// caller MAY consult <c>mcp_status</c> first to avoid colliding with a
    /// still-running add-in task.
    /// </summary>
    RetryNonMutating,

    /// <summary>
    /// Rule 4: a non-terminal mutating row MUST NOT be re-executed. The caller
    /// returns <c>journal_indeterminate</c> with the installed scope hold.
    /// </summary>
    RefuseIndeterminate,
}

/// <summary>
/// The outcome of admitting an invocation. <see cref="Admission"/> is the
/// frozen rule that applied; <see cref="Stored"/> is the durable row the
/// caller must answer from when the rule is a replay or refusal.
/// </summary>
internal sealed record RbpInvocationAdmissionResult(
    RbpInvocationAdmission Admission,
    RbpStoredInvocation Stored,
    string? VerificationHoldId = null);

/// <summary>
/// A durable mutation-recovery hold. <c>ScopeJcs</c> is the exact RFC 8785
/// JCS string of the frozen <c>mutation_scope</c>.
/// </summary>
internal sealed record RbpVerificationHold(
    string VerificationHoldId,
    string Rsid,
    string ScopeKind,
    string? DocumentId,
    string ScopeJcs,
    IReadOnlyList<string> OrderedOriginIdempotencyKeys,
    RbpHoldState State,
    string? VerificationInvocationId,
    string? EvidenceDigest,
    string? ResolutionId,
    string? ResolutionBasis,
    string? ResolutionDecision,
    string? AuditId,
    long CreatedAtMilliseconds,
    long UpdatedAtMilliseconds,
    long? ClearedAtMilliseconds);

/// <summary>
/// The terminal outcome persisted before any <c>result</c>/<c>error</c> is
/// sent to the Gateway (frozen Section 12.1 durability ordering, step 3).
/// </summary>
internal sealed record RbpInvocationTerminal(
    RbpInvocationState State,
    JsonElement Outcome,
    string? ResultDigest);
