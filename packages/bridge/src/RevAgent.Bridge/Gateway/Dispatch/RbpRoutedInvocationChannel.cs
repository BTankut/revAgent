using System.Text.Json;
using System.Text;
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
/// Application status and transport reachability are independent evidence.
/// Effect classification remains the dispatcher's responsibility, because only
/// it knows whether the invocation was mutating.
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

        if (RbpDispatchDecisionQuarantine.For(this).IsQuarantined(rsid))
            return NotDispatched("environment", "An earlier dispatch decision is not durably proven.", routeFailure: true);

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
            // Only the router's typed refusal proves no send. An unexpected
            // exception supplies no such proof, including cancellation.
            return new RbpAddinOutcome(RbpAddinOutcomeKind.PossiblyDispatched,
                default, [], 0, 0, Message: exception.Message);
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
            return FromFailure(exception, lease, leaseHandle) with
            {
                RouteLocalSessionKey = handle.LocalSessionKey,
                RouteAuthority = RouteSnapshot(lease.Authority),
            };
        }

        bool current = lease.TryReadCurrentIncarnation(out var currentAuthority) &&
            currentAuthority == lease.Authority;
        bool attestationMatches = result.ProcessAttestation is { } attestation &&
            string.Equals(
                AddinSessionRouter.ProcessAttestationDigest(attestation),
                lease.Authority.ProcessAttestationDigest,
                StringComparison.Ordinal);
        return FromResponse(result, leaseHandle) with
        {
            RouteLocalSessionKey = handle.LocalSessionKey,
            RouteAuthority = RouteSnapshot(lease.Authority),
            RouteFailure = !current || !attestationMatches,
        };
    }

    private static RbpRouteAuthoritySnapshot RouteSnapshot(
        AddinSessionRouter.InvocationAuthoritySnapshot value) =>
        new(
            value.LocalSessionKey,
            value.HandleGeneration,
            value.RegistrationSignatureDigest,
            value.ProcessAttestationDigest);

    private static RbpAddinOutcome FromResponse(
        AddinCallResult result,
        IRbpDispatchLease lease)
    {
        AddinTransportEvidence evidence = result.Evidence;
        if (result.Response.Error is { } error)
        {
            // Application status is not transaction-effect evidence.
            return new RbpAddinOutcome(
                RbpAddinOutcomeKind.ApplicationError,
                default,
                result.Response.RawPayload,
                evidence.RequestPayloadBytes,
                evidence.ResponseBytesObserved,
                FaultClass: MapAddinErrorFaultClass(error.Code),
                Message: RbpApplicationResultClassifier.Diagnostic(error.Message),
                AddinError: new AddinErrorDetail(error.Code, RbpApplicationResultClassifier.Diagnostic(error.Message)),
                Lease: lease,
                Retryable: false,
                ProcessAttestation: result.ProcessAttestation);
        }

        // Inspect original bytes, not a JObject reserialization which loses
        // duplicate properties. RawResponsePayload remains untouched.
        JsonElement body = default;
        RbpApplicationResultClassification classification;
        try
        {
            using JsonDocument document = JsonDocument.Parse(result.Response.RawPayload);
            body = document.RootElement.GetProperty("result").Clone();
            classification = RbpApplicationResultClassifier.Classify(body);
        }
        catch (Exception exception) when (exception is System.Text.Json.JsonException or InvalidOperationException or KeyNotFoundException)
        {
            classification = RbpApplicationResultClassification.Unclassifiable;
        }
        bool guarded = classification == RbpApplicationResultClassification.Guarded;
        string? guardedReason = guarded ? ReadGuard(result.Response.Result).Reason : null;

        return new RbpAddinOutcome(
            classification switch
            {
                RbpApplicationResultClassification.Guarded => RbpAddinOutcomeKind.Guarded,
                RbpApplicationResultClassification.ApplicationError => RbpAddinOutcomeKind.ApplicationError,
                RbpApplicationResultClassification.Unclassifiable => RbpAddinOutcomeKind.PossiblyDispatched,
                _ => RbpAddinOutcomeKind.Completed,
            },
            body,
            result.Response.RawPayload,
            evidence.RequestPayloadBytes,
            evidence.ResponseBytesObserved,
            GuardedReason: guarded ? guardedReason : null,
            FaultClass: classification == RbpApplicationResultClassification.ApplicationError ? "revit_api" :
                classification == RbpApplicationResultClassification.Unclassifiable ? "protocol" : null,
            Message: classification == RbpApplicationResultClassification.ApplicationError ? "The add-in reported an application failure." :
                classification == RbpApplicationResultClassification.Unclassifiable ? "The add-in result could not be classified safely." : null,
            Lease: lease,
            Retryable: classification is RbpApplicationResultClassification.ApplicationError or RbpApplicationResultClassification.Unclassifiable ? false : null,
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
        AddinTransportEvidence? evidence = (exception as AddinTransportException)?.Evidence ?? lease.Result?.Evidence;
        bool possiblyDispatched =
            evidence?.DispatchState is
                AddinDispatchState.MayHaveReachedAddin or
                AddinDispatchState.ResponseObserved ||
            evidence is null;
        bool unusableResponse = exception is AddinJsonRpcProtocolException or StrictJsonException ||
            exception.InnerException is AddinJsonRpcProtocolException or StrictJsonException;

        return new RbpAddinOutcome(
            possiblyDispatched
                ? RbpAddinOutcomeKind.PossiblyDispatched
                : RbpAddinOutcomeKind.KnownNotDispatched,
            default,
            [],
            evidence?.RequestPayloadBytes ?? 0,
            evidence?.ResponseBytesObserved ?? 0,
            FaultClass: unusableResponse ? "protocol" : MapTransportFailureFaultClass(
                exception,
                possiblyDispatched),
            Message: unusableResponse ? "The add-in response could not be validated safely." : exception.Message,
            Lease: leaseHandle,
            Retryable: unusableResponse ? false : null).ConservativeClassification();
    }

    /// <summary>
    /// Maps an add-in JSON-RPC error code onto the frozen Section 15 class.
    /// </summary>
    /// <remarks>
    /// <c>-32601</c> is an unsupported method; <c>-32700</c>, <c>-32600</c>,
    /// and <c>-32602</c> are the invalid-request/parse/params family that
    /// Section 15 folds into <c>parameter</c>. Every other reported code —
    /// including <c>-32603</c> add-in exceptions and the app-level codes a
    /// failure-shaped add-in result is surfaced under — reports a Revit/API
    /// failure, which is <c>revit_api</c>. This does not prove execution,
    /// non-execution, commit, or rollback.
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
            body["guardReason"]?.ToString() ??
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

internal enum RbpApplicationResultClassification { Completed, Guarded, ApplicationError, Unclassifiable }

/// <summary>Only the documented result chain is interpreted; payload properties are opaque.</summary>
internal static class RbpApplicationResultClassifier
{
    internal const int MaximumDecodedBytes = 1_048_576;
    internal const int MaximumTokens = 4096;
    private static readonly string[] Reserved =
        ["success", "result", "error", "errorMessage", "message", "status", "guarded",
         "guardedReason", "guarded_reason", "guardReason", "reason"];
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly System.Text.RegularExpressions.Regex ErrorPrefix = new(
        @"^ERROR(?:\b|:)",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase |
        System.Text.RegularExpressions.RegexOptions.CultureInvariant |
        System.Text.RegularExpressions.RegexOptions.NonBacktracking,
        TimeSpan.FromMilliseconds(100));

    internal static string Diagnostic(string? message)
    {
        if (string.IsNullOrEmpty(message)) return "The add-in reported an application failure.";
        var text = new StringBuilder();
        int bytes = 0;
        foreach (Rune rune in message.EnumerateRunes())
        {
            if (bytes + rune.Utf8SequenceLength > 512) break;
            text.Append(rune.ToString());
            bytes += rune.Utf8SequenceLength;
        }
        return text.ToString();
    }

    internal static RbpApplicationResultClassification Classify(JsonElement result)
    {
        try { return Read(result); }
        catch (Exception exception) when (exception is System.Text.Json.JsonException or
            InvalidOperationException or ArgumentException or OverflowException or
            System.Text.RegularExpressions.RegexMatchTimeoutException)
        { return RbpApplicationResultClassification.Unclassifiable; }
    }

    private static RbpApplicationResultClassification Read(JsonElement node)
    {
        int hops = 0, decodes = 0, decodedBytes = 0;
        bool native = true;
        while (true)
        {
            if (node.ValueKind == JsonValueKind.Object)
            {
                if (!ValidateNode(node)) return RbpApplicationResultClassification.Unclassifiable;
                bool? success = Boolean(node, "success");
                string? status = Text(node, "status");
                bool guard = Boolean(node, "guarded") == true ||
                    string.Equals(status, "guarded", StringComparison.OrdinalIgnoreCase);
                if ((Boolean(node, "guarded") == false && guard) || (guard && status is "failed" or "completed"))
                    return RbpApplicationResultClassification.Unclassifiable;
                if (native && guard) return RbpApplicationResultClassification.Guarded;
                bool failedStatus = status == "failed";
                if ((success == true && failedStatus) || (success == false && status == "completed") ||
                    (Boolean(node, "guarded") == false && status == "guarded"))
                    return RbpApplicationResultClassification.Unclassifiable;
                bool error = node.TryGetProperty("error", out JsonElement e) &&
                    (e.ValueKind == JsonValueKind.Object && e.EnumerateObject().Any() ||
                     e.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(e.GetString()));
                if (success == false || failedStatus || error)
                    return RbpApplicationResultClassification.ApplicationError;
                if (!node.TryGetProperty("result", out JsonElement next))
                    return RbpApplicationResultClassification.Completed;
                if (++hops > 2) return RbpApplicationResultClassification.Unclassifiable;
                node = next;
                native = false;
                continue;
            }
            if (node.ValueKind != JsonValueKind.String)
                return node.ValueKind == JsonValueKind.Undefined
                    ? RbpApplicationResultClassification.Unclassifiable
                    : RbpApplicationResultClassification.Completed;
            string input = node.GetString()!;
            string value = input.Trim();
            if (ErrorPrefix.IsMatch(value))
                return RbpApplicationResultClassification.ApplicationError;
            if (value.Length == 0 || value[0] is not ('{' or '[' or '"'))
                return RbpApplicationResultClassification.Completed;
            int length = StrictUtf8.GetByteCount(input);
            decodedBytes = checked(decodedBytes + length);
            if (++decodes > 2 || length > MaximumDecodedBytes || decodedBytes > 2 * MaximumDecodedBytes)
                return RbpApplicationResultClassification.Unclassifiable;
            byte[] utf8 = StrictUtf8.GetBytes(input);
            ValidateDecodedTree(utf8);
            using JsonDocument document = JsonDocument.Parse(utf8, new JsonDocumentOptions { MaxDepth = 32 });
            node = document.RootElement.Clone();
            native = false;
        }
    }

    private static bool ValidateNode(JsonElement node)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        string? reason = null;
        foreach (JsonProperty property in node.EnumerateObject())
        {
            if (!names.Add(property.Name)) return false;
            if (Reserved.Any(key => string.Equals(key, property.Name, StringComparison.OrdinalIgnoreCase)) &&
                !Reserved.Contains(property.Name, StringComparer.Ordinal)) return false;
            JsonValueKind kind = property.Value.ValueKind;
            switch (property.Name)
            {
                case "success":
                case "guarded":
                    if (kind is not (JsonValueKind.True or JsonValueKind.False)) return false;
                    break;
                case "status":
                    if (kind != JsonValueKind.String) return false;
                    break;
                case "error":
                    if (kind is not (JsonValueKind.Null or JsonValueKind.String or JsonValueKind.Object)) return false;
                    break;
                case "message":
                case "errorMessage":
                    if (kind is not (JsonValueKind.Null or JsonValueKind.String)) return false;
                    break;
                case "guardedReason":
                case "guarded_reason":
                case "guardReason":
                case "reason":
                    if (kind is not (JsonValueKind.Null or JsonValueKind.String)) return false;
                    string? current = kind == JsonValueKind.Null ? null : property.Value.GetString();
                    if (current is not null && reason is not null && current != reason) return false;
                    reason ??= current;
                    break;
            }
        }
        return true;
    }

    private static bool? Boolean(JsonElement node, string name) =>
        node.TryGetProperty(name, out JsonElement value) ? value.GetBoolean() : null;
    private static string? Text(JsonElement node, string name) =>
        node.TryGetProperty(name, out JsonElement value) ? value.GetString() : null;

    private static void ValidateDecodedTree(ReadOnlySpan<byte> bytes)
    {
        var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { MaxDepth = 32 });
        var objects = new Stack<HashSet<string>>();
        int tokens = 0;
        while (reader.Read())
        {
            if (++tokens > MaximumTokens) throw new System.Text.Json.JsonException();
            if (reader.TokenType == JsonTokenType.StartObject) objects.Push(new(StringComparer.Ordinal));
            if (reader.TokenType == JsonTokenType.EndObject) objects.Pop();
            if (reader.TokenType == JsonTokenType.PropertyName && !objects.Peek().Add(reader.GetString()!))
                throw new System.Text.Json.JsonException();
            if (reader.TokenType == JsonTokenType.Number &&
                (!reader.TryGetDouble(out double number) || !double.IsFinite(number)))
                throw new System.Text.Json.JsonException();
        }
    }
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

    /// <summary>
    /// Publishes a lock-free monotonic deny fence before retained teardown can
    /// wait on route synchronization.
    /// </summary>
    void DenyConnectionEpoch(long epoch) { }

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
