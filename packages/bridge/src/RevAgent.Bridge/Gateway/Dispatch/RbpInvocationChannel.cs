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
    AddinErrorDetail? AddinError = null);

/// <summary>
/// The seam between the RBP data plane and the add-in loopback transport.
/// </summary>
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
