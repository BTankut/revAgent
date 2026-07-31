using System.Text.Json;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// One in-flight claim on an <c>rsid</c> under frozen Section 10.1.
/// </summary>
/// <remarks>
/// P-BRIDGE-4 makes the Gateway dispatcher the authority for the
/// one-in-flight-per-session window and the bridge's own queue defence in
/// depth, rejecting a second concurrent invocation as an RBP <c>protocol</c>
/// fault rather than treating the queue as the authority. This claim is that
/// defence made explicit, so the moment of acquisition is a decision the caller
/// makes rather than an accident of task scheduling.
/// </remarks>
internal interface IRbpInvocationClaim : IDisposable
{
    string Rsid { get; }
}

internal interface IRbpInvocationDispatcher
{
    /// <summary>
    /// Claims the Section 10.1 window for a session, or returns
    /// <see langword="null"/> when an invocation is already in flight.
    /// </summary>
    /// <remarks>
    /// MUST be called synchronously, in frame-arrival order, before the
    /// invocation task starts. Claiming inside the task would make *which*
    /// of two racing invokes gets rejected a scheduling accident rather than
    /// the second one, which is what Section 10.1 actually specifies.
    /// </remarks>
    IRbpInvocationClaim? TryClaim(string rsid);

    /// <summary>
    /// Answers a claimed <c>invoke</c>.
    /// </summary>
    /// <remarks>
    /// Takes the raw payload rather than a parsed request so that a malformed
    /// invoke becomes that invocation's own terminal Section 15 <c>protocol</c>
    /// error instead of an exception thrown into the connection.
    /// </remarks>
    Task<RbpInvocationAnswer> DispatchClaimedAsync(
        IRbpInvocationClaim claim,
        JsonElement invokePayload,
        CancellationToken cancellationToken);

    /// <summary>
    /// The terminal answer for an invoke refused because
    /// <see cref="TryClaim"/> found the session already busy. No add-in byte is
    /// written and no journal row is reserved.
    /// </summary>
    RbpInvocationAnswer RejectConcurrent(string invocationId);
}
