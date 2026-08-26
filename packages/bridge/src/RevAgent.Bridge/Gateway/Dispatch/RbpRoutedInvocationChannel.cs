using System.Text.Json;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Contracts.AddinLoopback;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// Drives an <c>invoke</c> through the add-in session router and reduces the
/// transport result to the evidence the Section 12 journal needs.
/// </summary>
/// <remarks>
/// The only judgement this type makes is whether the add-in may have been
/// reached. Everything downstream — whether that becomes a terminal failure or
/// a Section 6.2.1 hold — is the dispatcher's, because only it knows whether
/// the invocation was mutating.
/// </remarks>
internal sealed class RbpRoutedInvocationChannel(
    AddinSessionRouter router,
    IRbpSessionRouteResolver routes)
    : IRbpInvocationChannel
{
    private readonly AddinSessionRouter _router =
        router ?? throw new ArgumentNullException(nameof(router));

    private readonly IRbpSessionRouteResolver _routes =
        routes ?? throw new ArgumentNullException(nameof(routes));

    public async Task<RbpAddinOutcome> InvokeAsync(
        string rsid,
        AddinCall call,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(rsid);
        ArgumentNullException.ThrowIfNull(call);

        if (_routes.Resolve(rsid) is not { } handle)
        {
            // No add-in session is bound to this rsid. Nothing was written, so
            // the outcome is known and a read may be retried by the
            // orchestrator.
            return NotDispatched(
                "addin_unreachable",
                "No add-in session is currently routable for this RBP session.",
                routeFailure: true);
        }

        AddinSessionRouter.InvocationLease lease;
        try
        {
            lease = await _router
                .InvokeAsync(handle, call, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (AddinSessionRouter.RouteException exception)
        {
            // The router refused before dispatch: an invalid or stale handle,
            // an unavailable session, or its own single-flight gate. None of
            // these write an add-in byte.
            return NotDispatched(
                exception.FaultClass ?? "addin_unreachable",
                exception.Message,
                routeFailure: true);
        }
        catch (Exception exception)
        {
            return NotDispatched("addin_unreachable", exception.Message);
        }

        var leaseHandle = new RouterLease(lease);
        AddinCallResult result;
        try
        {
            result = lease.GetResult();
        }
        catch (Exception exception)
        {
            // The transport failed. Whether that is recoverable depends
            // entirely on how far the request got, which the evidence below
            // answers; the lease is still handed back so the dispatcher, not
            // this method, decides when the session reopens.
            return FromFailure(exception, lease, leaseHandle);
        }

        return FromResponse(result, leaseHandle);
    }

    private static RbpAddinOutcome FromResponse(
        AddinCallResult result,
        IRbpDispatchLease lease)
    {
        AddinTransportEvidence evidence = result.Evidence;
        if (result.Response.Error is { } error)
        {
            // The add-in ran and reported a failure. That is a known outcome:
            // the command executed and answered, so nothing is in doubt.
            // Section 15 defaults every add-in-reported class to
            // retryable:false — the orchestrator, not the bridge, owns retry.
            return new RbpAddinOutcome(
                RbpAddinOutcomeKind.KnownNotDispatched,
                default,
                [],
                evidence.RequestPayloadBytes,
                evidence.ResponseBytesObserved,
                FaultClass: MapAddinErrorFaultClass(error.Code),
                Message: error.Message,
                AddinError: new AddinErrorDetail(error.Code, error.Message),
                Lease: lease,
                Retryable: false);
        }

        JObject? body = result.Response.Result;
        using JsonDocument document = JsonDocument.Parse(
            body?.ToString(Formatting.None) ?? "{}");
        (bool guarded, string? guardedReason) = ReadGuard(body);

        return new RbpAddinOutcome(
            guarded
                ? RbpAddinOutcomeKind.Guarded
                : RbpAddinOutcomeKind.Completed,
            document.RootElement.Clone(),
            result.Response.RawPayload,
            evidence.RequestPayloadBytes,
            evidence.ResponseBytesObserved,
            GuardedReason: guarded ? guardedReason : null,
            Lease: lease,
            ProcessAttestation: result.ProcessAttestation);
    }

    private static RbpAddinOutcome FromFailure(
        Exception exception,
        AddinSessionRouter.InvocationLease lease,
        IRbpDispatchLease leaseHandle)
    {
        // `MayHaveReachedAddin` is set before the first write, so anything at
        // or past it means non-execution cannot be proved. Section 15 forbids
        // labelling that a retryable environment fault for a write.
        bool possiblyDispatched =
            lease.Result?.Evidence.DispatchState is
                AddinDispatchState.MayHaveReachedAddin or
                AddinDispatchState.ResponseObserved ||
            lease.Result is null;

        return new RbpAddinOutcome(
            possiblyDispatched
                ? RbpAddinOutcomeKind.PossiblyDispatched
                : RbpAddinOutcomeKind.KnownNotDispatched,
            default,
            [],
            lease.Result?.Evidence.RequestPayloadBytes ?? 0,
            lease.Result?.Evidence.ResponseBytesObserved ?? 0,
            FaultClass: MapTransportFailureFaultClass(
                exception,
                possiblyDispatched),
            Message: exception.Message,
            Lease: leaseHandle);
    }

    /// <summary>
    /// Maps an add-in JSON-RPC error code onto the frozen Section 15 class.
    /// </summary>
    /// <remarks>
    /// <c>-32601</c> is an unsupported method; <c>-32700</c>, <c>-32600</c>,
    /// and <c>-32602</c> are the invalid-request/parse/params family that
    /// Section 15 folds into <c>parameter</c>. Every other reported code —
    /// including <c>-32603</c> add-in exceptions and the app-level codes a
    /// failure-shaped add-in result is surfaced under — means the command
    /// executed and answered with a Revit/API failure, which is
    /// <c>revit_api</c>.
    /// </remarks>
    internal static string MapAddinErrorFaultClass(int code) =>
        code switch
        {
            -32601 => "unsupported",
            -32700 or -32600 or -32602 => "parameter",
            _ => "revit_api",
        };

    /// <summary>
    /// Classifies a transport failure for the Section 15 fault table.
    /// </summary>
    /// <remarks>
    /// A deadline expiry is <c>revit_timeout</c> rather than a reachability
    /// fault. When the failure is possibly dispatched, the class here is only
    /// a hint: the dispatcher still promotes an uncertain mutation to
    /// <c>journal_indeterminate</c> regardless of what the transport reported.
    /// </remarks>
    internal static string? MapTransportFailureFaultClass(
        Exception exception,
        bool possiblyDispatched)
    {
        if (exception is AddinTransportException
            {
                Code: "addin_call_timeout",
            })
        {
            return "revit_timeout";
        }

        return possiblyDispatched ? null : "addin_unreachable";
    }

    private static RbpAddinOutcome NotDispatched(
        string faultClass,
        string message,
        bool routeFailure = false) =>
        new(
            RbpAddinOutcomeKind.KnownNotDispatched,
            default,
            [],
            RequestBytes: 0,
            ResponseBytes: 0,
            FaultClass: faultClass,
            Message: message,
            RouteFailure: routeFailure);

    /// <summary>
    /// Reads the add-in's guard signal. Section 10.3 keeps a guarded answer a
    /// result rather than a transport failure, and requires a stable
    /// lower-snake-case reason code.
    /// </summary>
    internal static (bool Guarded, string? Reason) ReadGuard(JObject? body)
    {
        if (body is null) return (false, null);
        string? reason =
            body["guardedReason"]?.ToString() ??
            body["guarded_reason"]?.ToString() ??
            body["reason"]?.ToString();
        bool guarded =
            string.Equals(
                body["status"]?.ToString(),
                "guarded",
                StringComparison.OrdinalIgnoreCase) ||
            body["guarded"]?.ToObject<bool>() == true;
        if (!guarded) return (false, null);

        // Section 10.3: when a legacy guarded payload carries no usable code
        // the bridge uses `unspecified_guarded` and preserves the original
        // bounded detail inside `result` — which it does, because the whole
        // body is carried through untouched.
        return (
            true,
            IsStableReasonCode(reason) ? reason : "unspecified_guarded");
    }

    private static bool IsStableReasonCode(string? reason)
    {
        if (reason is not { Length: > 0 and <= 64 }) return false;
        if (reason[0] is < 'a' or > 'z') return false;
        foreach (char character in reason)
        {
            bool allowed =
                character is >= 'a' and <= 'z' ||
                character is >= '0' and <= '9' ||
                character == '_';
            if (!allowed) return false;
        }

        return true;
    }

    private sealed class RouterLease(AddinSessionRouter.InvocationLease lease)
        : IRbpDispatchLease
    {
        public void ReleaseAfterDurableDecision() =>
            lease.ReleaseAfterDurableDecision();
    }
}

/// <summary>
/// Maps an RBP session id onto the add-in session the router owns.
/// </summary>
internal interface IRbpSessionRouteResolver
{
    AddinSessionRouter.SessionHandle? Resolve(string rsid);
}

/// <summary>
/// Publishes a just-attested local add-in session as the only route for a
/// Gateway-issued RBP session id. This is deliberately synchronous: the
/// registration control path must either make the route available before it
/// arms follow-on work, or fail the connection without dispatching anything.
/// </summary>
internal interface IRbpSessionRouteBindingAuthority
{
    /// <summary>Begins one coordinator-owned route epoch and fences all prior routes.</summary>
    bool BeginConnectionEpoch(long epoch);

    /// <summary>Fences exactly the active epoch before its work is cancelled or drained.</summary>
    void FenceConnectionEpoch(long epoch);

    /// <summary>
    /// Publishes a route only after the matching lifecycle acknowledgement is
    /// durable and the coordinator has proved this exact epoch current.
    /// </summary>
    bool TryBindRegisteredSession(string rsid, string localSessionKey, long epoch);

    /// <summary>Revokes the exact epoch's route when its session is withdrawn.</summary>
    void RevokeBoundSession(string rsid, long epoch);
}
