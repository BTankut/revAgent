using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;

namespace RevAgent.Bridge.Gateway.Dispatch;

internal enum RbpAddinOutcomeKind
{
    /// <summary>The add-in answered with a result.</summary>
    Completed,

    /// <summary>
    /// The add-in answered but declined to act. Section 10.3 keeps this a
    /// result, not a transport failure.
    /// </summary>
    Guarded,

    /// <summary>
    /// The call failed and the transport can prove no add-in byte was written,
    /// so the outcome is known and nothing committed.
    /// </summary>
    KnownNotDispatched,

    /// <summary>
    /// The call failed after the first byte may have reached the add-in. For a
    /// mutation this is what Section 15 promotes to
    /// <c>journal_indeterminate</c>.
    /// </summary>
    PossiblyDispatched,
}

/// <summary>
/// One add-in answer, reduced to what the journal and Section 10.3 need.
/// </summary>
/// <remarks>
/// <see cref="RawResponsePayload"/> is the exact add-in JSON-RPC body with the
/// 4-byte length prefix already removed and before any parsing, because Section
/// 10.3 defines <c>result_digest</c> over precisely those bytes. Re-serializing
/// the parsed result would produce a digest neither peer could reproduce.
/// </remarks>
internal sealed record RbpAddinOutcome(
    RbpAddinOutcomeKind Kind,
    JsonElement Result,
    byte[] RawResponsePayload,
    int RequestBytes,
    int ResponseBytes,
    string? GuardedReason = null,
    string? FaultClass = null,
    string? Message = null,
    AddinErrorDetail? AddinError = null,
    IRbpDispatchLease? Lease = null,
    bool? Retryable = null,
    // Internal-only signal for a resolver refusal before an add-in byte can
    // be written.  It lets the document-context watcher distinguish route
    // authority loss from a cache that is merely warming/not ready.
    bool RouteFailure = false,
    // This is an internal, already post-response-verified attestation from
    // AddinTcpTransport. It is never serialized or exposed to a caller.
    AddinProcessAttestation? ProcessAttestation = null);

/// <summary>
/// Ownership of an add-in session for the duration of one invocation.
/// </summary>
/// <remarks>
/// The router deliberately does not make its lease <c>IDisposable</c>:
/// abandoning a call or leaving a scope must leave the session fail-closed, and
/// the single-flight gate must stay shut until the invocation's fate is
/// durable. Releasing when the add-in merely answered would reopen the session
/// while the outcome is still only in memory, so a crash in that window would
/// let a redelivery dispatch a second time against a row the journal still
/// believes is <c>executing</c>. The dispatcher therefore releases only after
/// the terminal or indeterminate outcome has been persisted.
/// </remarks>
internal interface IRbpDispatchLease
{
    void ReleaseAfterDurableDecision();
}

/// <summary>
/// The seam between the RBP data plane and the add-in loopback transport.
/// </summary>
/// <remarks>
/// An implementation that acquires a session lease MUST hand it back on
/// <see cref="RbpAddinOutcome.Lease"/> rather than releasing it itself, so the
/// durable-decision ordering above is preserved.
/// </remarks>
internal interface IRbpInvocationChannel
{
    Task<RbpAddinOutcome> InvokeAsync(
        string rsid,
        AddinCall call,
        CancellationToken cancellationToken);
}

/// <summary>
/// Enforces the frozen Section 10.1 rule that at most one data-plane
/// invocation is in flight per <c>rsid</c>.
/// </summary>
/// <remarks>
/// The Gateway is the authority for this window; the bridge still refuses a
/// second concurrent invocation because Section 10.1 explicitly says the
/// bridge-side queue and the add-in's own intake defenses are not substitutes
/// for that enforcement.
/// </remarks>
internal interface IRbpInFlightGate
{
    bool TryEnter(string rsid);

    void Exit(string rsid);
}

/// <summary>
/// Holds the Section 10.1 window for one session until disposed.
/// </summary>
internal sealed class GateClaim(IRbpInFlightGate gate, string rsid)
    : IRbpInvocationClaim
{
    private int _released;

    public string Rsid { get; } = rsid;

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _released, 1) == 0)
        {
            gate.Exit(Rsid);
        }
    }
}

internal sealed class RbpInFlightGate : IRbpInFlightGate
{
    private readonly HashSet<string> _inFlight = new(StringComparer.Ordinal);

    public bool TryEnter(string rsid)
    {
        ArgumentException.ThrowIfNullOrEmpty(rsid);
        lock (_inFlight)
        {
            return _inFlight.Add(rsid);
        }
    }

    public void Exit(string rsid)
    {
        ArgumentException.ThrowIfNullOrEmpty(rsid);
        lock (_inFlight)
        {
            _inFlight.Remove(rsid);
        }
    }
}
