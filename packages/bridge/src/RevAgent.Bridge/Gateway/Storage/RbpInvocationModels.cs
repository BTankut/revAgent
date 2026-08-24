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
    long? FinishedAtMilliseconds,
    RbpCarrierPlan? CarrierPlan = null)
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

    /// <summary>
    /// Section 6.2.1 (spec ~480-485): a <em>new</em> mutating invocation
    /// conflicts with an uncleared hold in the durable local index. No row was
    /// written; the caller returns the original hold's
    /// <c>journal_indeterminate</c> error without add-in contact, even though
    /// the <c>invocation_id</c> is fresh.
    /// </summary>
    BlockedByConflictingHold,
}

/// <summary>
/// The outcome of admitting an invocation. <see cref="Admission"/> is the
/// frozen rule that applied; <see cref="Stored"/> is the durable row the
/// caller must answer from when the rule is a replay, a refusal, or the
/// Section 6.2.1 conflict block — for the block that row is the blocking
/// hold's first origin invocation, because the frozen answer is <em>the
/// original hold's</em> error and the blocked envelope deliberately never got
/// a row of its own. <see cref="BlockingHold"/> is set only for the block.
/// </summary>
internal sealed record RbpInvocationAdmissionResult(
    RbpInvocationAdmission Admission,
    RbpStoredInvocation Stored,
    string? VerificationHoldId = null,
    RbpVerificationHold? BlockingHold = null);

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
    string? ResultDigest,
    RbpCarrierPlan? CarrierPlan = null,
    RbpRecoveryPayload? RecoveryPayload = null);

/// <summary>
/// Exact prefix-excluded add-in response material eligible for the narrowly
/// correlated C39 recovery path.  The payload is deliberately bytes, never a
/// reserialized <see cref="JsonElement"/>: the frozen wire digest domain is
/// SHA-256 over the strict UTF-8 JSON-RPC response bytes.
/// </summary>
internal sealed class RbpRecoveryPayload
{
    private readonly byte[] _rawResponseBytes;

    internal RbpRecoveryPayload(string resultDigest, ReadOnlySpan<byte> rawResponseBytes)
    {
        ArgumentException.ThrowIfNullOrEmpty(resultDigest);
        if (rawResponseBytes.IsEmpty)
        {
            throw new ArgumentException("Recovery payload must not be empty.", nameof(rawResponseBytes));
        }

        ResultDigest = resultDigest;
        _rawResponseBytes = rawResponseBytes.ToArray();
    }

    internal string ResultDigest { get; }

    internal ReadOnlyMemory<byte> RawResponseBytes => _rawResponseBytes;

    internal byte[] CopyRawResponseBytes() => _rawResponseBytes.ToArray();

    internal void Clear() => System.Security.Cryptography.CryptographicOperations.ZeroMemory(_rawResponseBytes);

    public override string ToString() => "[recovery payload]";
}

/// <summary>
/// Returned only by the typed, owner-RSID-scoped recovery read.  Null is the
/// opaque answer for absent, pruned, corrupt, foreign, non-terminal, or
/// protection-unavailable material; callers must not turn it into a replay.
/// </summary>
internal sealed class RbpRecoveredPayload : IDisposable
{
    private byte[]? _rawResponseBytes;

    internal RbpRecoveredPayload(string resultDigest, ReadOnlySpan<byte> rawResponseBytes)
    {
        ResultDigest = resultDigest;
        _rawResponseBytes = rawResponseBytes.ToArray();
    }

    internal string ResultDigest { get; }
    /// <summary>
    /// A leased view over the decrypted raw response. It is valid only until
    /// <see cref="Dispose"/>; callers must not retain it across that boundary.
    /// </summary>
    internal ReadOnlyMemory<byte> RawResponseBytes => _rawResponseBytes ?? ReadOnlyMemory<byte>.Empty;

    /// <summary>Transfers the sole owned buffer to the caller.</summary>
    internal byte[] TakeRawResponseBytes() =>
        Interlocked.Exchange(ref _rawResponseBytes, Array.Empty<byte>()) ??
        Array.Empty<byte>();

    public void Dispose()
    {
        byte[]? bytes = Interlocked.Exchange(ref _rawResponseBytes, Array.Empty<byte>());
        if (bytes is { Length: > 0 })
        {
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(bytes);
        }
    }
    public override string ToString() => "[recovered payload]";
}

// C39 recovery-carrier metadata is deliberately kept separate from the
// frozen wire schema and contains no payload/frame material.
internal enum RbpRecoveryCarrierPhase
{
    Reserved,
    SendStarted,
    AwaitingAcknowledgement,
    Completed,
    Tombstoned,
}

internal sealed record RbpRecoveryCarrierReservationRequest(
    string Rsid,
    string RecoveryInvocationId,
    string OriginInvocationId,
    string ResultDigest,
    int ChunkSize,
    RbpRecoveryCarrierHeader Header,
    string CanonicalEnvelopeDigest,
    DateTimeOffset ExpiresAt);

/// <summary>Fixed non-secret C39 carrier header. No extension fields exist.</summary>
internal sealed record RbpRecoveryCarrierHeader(
    string ContentType,
    string ContentEncoding)
{
    internal const string RequiredContentType = "application/json";
    internal const string RequiredContentEncoding = "base64";
}

internal sealed record RbpRecoveryCarrierReservation(
    string Rsid,
    string RecoveryInvocationId,
    string OriginInvocationId,
    string ResultDigest,
    string RawIdempotencyKey,
    string HeaderJcs,
    int PlaintextLength,
    int ChunkSize,
    int ChunkCount,
    RbpRecoveryCarrierPhase Phase,
    int ChunkIndex,
    long CurrentReservedSequence,
    int RawPayloadVersion,
    string CanonicalEnvelopeDigest,
    long? SendStartedAtMilliseconds,
    long HighestReservedSequence,
    long AcknowledgementCursor,
    int PlanVersion,
    long CreatedAtMilliseconds,
    long ExpiresAtMilliseconds,
    long UpdatedAtMilliseconds,
    long? CompletedAtMilliseconds,
    long? TombstonedAtMilliseconds,
    string? TombstoneReason);

/// <summary>
/// Immutable delivery material for a chunk/artifact carrier.  The journal owns
/// this plan, not the socket: a reconnect must replay these exact prefix
/// frames before the recorded terminal rather than attempting to regenerate
/// output from a spool or add-in response.
/// </summary>
internal sealed record RbpCarrierPlan(
    string PlanId,
    string CarrierKey,
    IReadOnlyList<RbpCarrierPlanFrame> OrderedPrefixes,
    JsonElement TerminalPayload,
    string PrefixDigest,
    string TerminalDigest);

internal sealed record RbpCarrierPlanFrame(string Type, JsonElement Payload);
