using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Contracts.AddinLoopback;

namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// Executes a frozen Section 10.2 <c>invoke</c> against the add-in under the
/// Section 12 journal.
/// </summary>
/// <remarks>
/// <para>
/// This type owns the Section 12.1 durability ordering, and the ordering is the
/// reason the code is shaped the way it is:
/// </para>
/// <list type="number">
/// <item><c>received</c> is durable before the first add-in byte. The journal
/// commits inside <see cref="RbpJournalStore.AdmitInvocationAsync"/>, which
/// returns before <see cref="IRbpInvocationChannel"/> is ever touched.</item>
/// <item><c>executing</c> is durable before dispatch ownership is taken.</item>
/// <item>The terminal outcome is durable before the <c>result</c> or
/// <c>error</c> is queued for the Gateway.</item>
/// </list>
/// <para>
/// A crash between steps 2 and 3 deliberately leaves <c>executing</c>, which
/// Section 12.1 calls indeterminate by design. That is the state the Section
/// 12.2 rules then arbitrate on redelivery.
/// </para>
/// </remarks>
internal sealed class RbpInvocationDispatcher : IRbpInvocationDispatcher
{
    internal const string DispatchPayloadRecoveryMethod = "dispatch_payload_recovery";
    /// <summary>
    /// Section 12.1 step 3 must not be cancellable.
    /// </summary>
    /// <remarks>
    /// The store takes its write gate with
    /// <c>_gate.WaitAsync(cancellationToken)</c>, so a cancel arriving between
    /// the add-in answering and the terminal persist would destroy an outcome
    /// that has already happened: the row stays <c>executing</c>, and the next
    /// mutating redelivery is answered <c>journal_indeterminate</c> with a
    /// Section 6.2.1 hold that a human has to clear. The connection dropping is
    /// never a reason to forget what the add-in did. This does not make the
    /// write unbounded — the store still fails closed once disposed.
    /// </remarks>
    private static readonly CancellationToken DurableDecisionToken =
        CancellationToken.None;

    private readonly RbpJournalStore _journal;
    private readonly IRbpInvocationChannel _channel;
    private readonly RbpDispatchDecisionQuarantine _decisionQuarantine;
    private readonly IRbpInFlightGate _inFlightGate;
    private readonly IRbpRevitBusyProbe? _busyProbe;
    private readonly TimeProvider _timeProvider;
    private readonly RbpArtifactCarrierProducer? _carrierProducer;
    private readonly RbpConformanceOmittedOriginObservation _omittedOriginObservation;
    private readonly AsyncLocal<IReadOnlyList<string>?> _connectionCapabilities = new();

    internal RbpInvocationDispatcher(
        RbpJournalStore journal,
        IRbpInvocationChannel channel,
        IRbpInFlightGate inFlightGate,
        IRbpRevitBusyProbe? busyProbe = null,
        TimeProvider? timeProvider = null,
        RbpArtifactCarrierProducer? carrierProducer = null,
        RbpConformanceOmittedOriginObservation? omittedOriginObservation = null)
    {
        _journal = journal ?? throw new ArgumentNullException(nameof(journal));
        _channel = channel ?? throw new ArgumentNullException(nameof(channel));
        _decisionQuarantine = RbpDispatchDecisionQuarantine.For(channel);
        _inFlightGate = inFlightGate ??
            throw new ArgumentNullException(nameof(inFlightGate));
        _busyProbe = busyProbe;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _carrierProducer = carrierProducer;
        _omittedOriginObservation = omittedOriginObservation ??
            RbpConformanceOmittedOriginObservation.Never;
    }

    /// <summary>
    /// Answers one <c>invoke</c>. The returned draft is what the coordinator
    /// queues outbound; this method never writes to the connection itself.
    /// </summary>
    internal async Task<RbpInvocationAnswer> DispatchAsync(
        RbpInvokeRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        // Section 10.1: a second data-plane invocation for the same rsid before
        // the first is terminal is a protocol defect, and the bridge MUST
        // reject it *without sending bytes to the add-in*. The gate is taken
        // before the journal so a rejected duplicate never even reserves a row.
        if (!_inFlightGate.TryEnter(request.Rsid))
        {
            return RbpInvocationAnswer.Error(
                RbpInvocationPayloads.KnownError(
                    request.InvocationId,
                    faultClass: "protocol",
                    retryable: false,
                    message:
                        "A data-plane invocation is already in flight for this " +
                        "session; Section 10.1 allows exactly one."));
        }

        try
        {
            return await DispatchUnderGateAsync(request, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            _inFlightGate.Exit(request.Rsid);
        }
    }

    private async Task<RbpInvocationAnswer> DispatchUnderGateAsync(
        RbpInvokeRequest request,
        CancellationToken cancellationToken)
    {
        if (_decisionQuarantine.IsBlocked(request.Rsid))
            return RbpInvocationAnswer.Error(RbpInvocationPayloads.KnownError(
                request.InvocationId, "environment", false,
                "An earlier dispatch decision is not durably proven; this request was not dispatched."));
        RbpPayloadRecoveryRequest? recovery = null;
        if (string.Equals(request.Method, DispatchPayloadRecoveryMethod, StringComparison.Ordinal))
        {
            try { recovery = RbpPayloadRecoveryRequest.Parse(request); }
            catch (RbpDispatchException)
            {
                return RbpInvocationAnswer.Error(RbpInvocationPayloads.KnownError(
                    request.InvocationId, "protocol", false,
                    "The correlated recovery request is invalid."));
            }
        }
        RbpInvocationIdentity identity = request.ToIdentity();
        (RbpInvocationAdmissionResult? admitted, RbpInvocationAnswer? answered)
            = await AdmitAsync(request, identity, cancellationToken)
                .ConfigureAwait(false);
        if (answered is not null)
        {
            return answered;
        }

        RbpInvocationAdmissionResult admission =
            admitted ??
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "The journal returned neither an admission nor an answer.");

        switch (admission.Admission)
        {
            case RbpInvocationAdmission.ReplayTerminal:
                return await ReplayTerminalAsync(
                        request, admission.Stored, cancellationToken)
                    .ConfigureAwait(false);

            case RbpInvocationAdmission.ReplayLateAfterIndeterminate:
                return ReplayLate(admission.Stored);

            case RbpInvocationAdmission.RefuseIndeterminate:
                return RefuseIndeterminate(request, admission);

            case RbpInvocationAdmission.BlockedByConflictingHold:
                return BlockedByHold(
                    request,
                    admission.BlockingHold ??
                        throw new RbpDispatchException(
                            RbpDispatchErrorCode.Environment,
                            "A blocked admission requires the original " +
                            "Section 6.2.1 hold it is answered from."));

            case RbpInvocationAdmission.Accepted:
                return await ExecuteAsync(
                        request,
                        identity,
                        claimDispatchOwnership: true,
                        cancellationToken, recovery)
                    .ConfigureAwait(false);

            case RbpInvocationAdmission.RetryNonMutating:
                // Rule 3 resumes a row that is already `received` or
                // `executing`. Dispatch ownership was taken on the delivery
                // that stalled, and Section 12.1 makes that claim once-only, so
                // re-asserting it here would be refused by the journal.
                return await ExecuteAsync(
                        request,
                        identity,
                        claimDispatchOwnership:
                            admission.Stored.State ==
                                RbpInvocationState.Received,
                        cancellationToken, recovery)
                    .ConfigureAwait(false);

            default:
                throw new RbpDispatchException(
                    RbpDispatchErrorCode.Environment,
                    "The journal returned an unknown invocation admission.");
        }
    }

    /// <summary>
    /// Section 12.1 durability step 1, under the Section 6.2.1 clearance
    /// gate. Returns either the journal's admission or the terminal answer
    /// that replaces it; no add-in byte has been written either way.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Section 6.2.1 permits exactly one evidence-bound envelope while a hold
    /// is <c>resolved_pending_bridge</c>: "The bridge MUST match the
    /// clearance to its active hold and durable evidence, then atomically
    /// mark the hold <c>cleared</c> with acceptance of the new invocation
    /// before any add-in byte. A mismatch is a terminal <c>protocol</c>
    /// fault." That transition exists only in
    /// <see cref="RbpJournalStore.AdmitInvocationWithClearancesAsync"/>,
    /// which also runs the durable conflict-index check a fresh mutating id
    /// must pass. An <c>invoke</c> whose <c>recovery_clearances</c> array is
    /// non-empty is therefore admitted there.
    /// </para>
    /// <para>
    /// An <c>invoke</c> that carries no clearance keeps the ordinary Section
    /// 12.2 admission unchanged, including which exceptions it surfaces. That
    /// admission is not, however, exempt from the Section 6.2.1 conflict
    /// block: spec ~480-485 requires the check before the first add-in byte of
    /// <em>every</em> new mutating invocation, and names redelivery of an
    /// origin key and a correlated read-only verification as the only
    /// exemptions. The store therefore runs the same gate on both paths and
    /// answers a blocked delivery with
    /// <see cref="RbpInvocationAdmission.BlockedByConflictingHold"/>.
    /// </para>
    /// </remarks>
    private async Task<(
        RbpInvocationAdmissionResult? Admission,
        RbpInvocationAnswer? Answer)> AdmitAsync(
            RbpInvokeRequest request,
            RbpInvocationIdentity identity,
            CancellationToken cancellationToken)
    {
        IReadOnlyList<RbpRecoveryClearance> clearances;
        try
        {
            clearances = request.ParseClearances();
        }
        catch (Exception exception) when (
            exception is FormatException ||
            (exception is RbpDispatchException dispatch &&
             dispatch.ErrorCode == RbpDispatchErrorCode.Protocol))
        {
            return (null, ProtocolFault(request, exception.Message));
        }

        if (clearances.Count == 0)
        {
            // Durability step 1. Section 12.2 rule 5 (a changed digest,
            // method, scope, policy, or clearance under the same key)
            // surfaces here as a journal protocol conflict, before any add-in
            // contact.
            try
            {
                return (
                    await _journal
                        .AdmitInvocationAsync(identity, cancellationToken)
                        .ConfigureAwait(false),
                    null);
            }
            catch (RbpJournalException exception)
                when (exception.ErrorCode ==
                      RbpJournalErrorCode.ProtocolConflict)
            {
                return (null, ProtocolFault(request, exception.Message));
            }
        }

        RbpClearanceGatedAdmission gated;
        try
        {
            gated = await _journal
                .AdmitInvocationWithClearancesAsync(
                    identity,
                    clearances,
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (RbpJournalException exception)
            when (exception.ErrorCode == RbpJournalErrorCode.ProtocolConflict)
        {
            return (null, ProtocolFault(request, exception.Message));
        }
        catch (Exception exception) when (
            exception is RbpFrameException or FormatException ||
            exception is ArgumentException and not ArgumentNullException)
        {
            // A clearance envelope that cannot become an acceptance input
            // fails closed at this boundary, leaves every hold uncleared, and
            // never reaches the add-in.
            return (null, ProtocolFault(request, exception.Message));
        }

        if (gated.BlockingHold is { } hold)
        {
            return (null, BlockedByHold(request, hold));
        }

        return (
            gated.Admission ??
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "A clearance-gated admission returned neither a decision nor " +
                "a blocking hold."),
            null);
    }

    private static RbpInvocationAnswer ProtocolFault(
        RbpInvokeRequest request,
        string message) =>
        RbpInvocationAnswer.Error(
            RbpInvocationPayloads.KnownError(
                request.InvocationId,
                faultClass: "protocol",
                retryable: false,
                message));

    /// <summary>
    /// Section 6.2.1 / Section 21 item 28: a fresh mutating envelope that
    /// still conflicts with an uncleared hold wrote no journal row and is
    /// answered with the original hold's <c>journal_indeterminate</c> error
    /// without add-in contact.
    /// </summary>
    private static RbpInvocationAnswer BlockedByHold(
        RbpInvokeRequest request,
        RbpVerificationHold hold)
    {
        using JsonDocument scope = JsonDocument.Parse(hold.ScopeJcs);
        return RbpInvocationAnswer.Error(
            RbpInvocationPayloads.JournalIndeterminateError(
                request.InvocationId,
                hold.VerificationHoldId,
                scope.RootElement,
                RbpInvocationPayloads.MutationMayHaveExecutedMessage,
                replayed: false));
    }

    public IRbpInvocationClaim? TryClaim(string rsid) =>
        _inFlightGate.TryEnter(rsid) ? new GateClaim(_inFlightGate, rsid) : null;

    public RbpInvocationAnswer RejectConcurrent(string invocationId) =>
        RbpInvocationAnswer.Error(
            RbpInvocationPayloads.KnownError(
                invocationId,
                faultClass: "protocol",
                retryable: false,
                message:
                    "A data-plane invocation is already in flight for this " +
                    "session; Section 10.1 allows exactly one."));

    /// <summary>
    /// Answers an invoke whose Section 10.1 claim the caller already holds.
    /// </summary>
    /// <remarks>
    /// Parsing happens here rather than in the caller so a malformed payload
    /// becomes this invocation's terminal Section 15 <c>protocol</c> error
    /// instead of an exception thrown into the connection cycle. No add-in byte
    /// is written and no journal row is reserved on that path.
    /// </remarks>
    public async Task<RbpInvocationAnswer> DispatchClaimedAsync(
        IRbpInvocationClaim claim,
        JsonElement invokePayload,
        IReadOnlyList<string> grantedConnectionCapabilities,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(claim);
        ArgumentNullException.ThrowIfNull(grantedConnectionCapabilities);
        IReadOnlyList<string>? prior = _connectionCapabilities.Value;
        _connectionCapabilities.Value = grantedConnectionCapabilities;
        try
        {

            RbpInvokeRequest request;
            try
            {
                request = RbpInvokeRequest.Parse(claim.Rsid, invokePayload);
            }
            catch (RbpDispatchException exception)
                when (exception.ErrorCode == RbpDispatchErrorCode.Protocol)
            {
                return RbpInvocationAnswer.Error(
                    RbpInvocationPayloads.KnownError(
                        ReadInvocationId(invokePayload),
                        faultClass: "protocol",
                        retryable: false,
                        message: exception.Message));
            }

            return await DispatchUnderGateAsync(request, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            _connectionCapabilities.Value = prior;
        }
    }

    private static string ReadInvocationId(JsonElement payload) =>
        payload.ValueKind == JsonValueKind.Object &&
        payload.TryGetProperty("invocation_id", out JsonElement value) &&
        value.ValueKind == JsonValueKind.String &&
        value.GetString() is { Length: > 0 } text
            ? text
            : "00000000-0000-7000-8000-000000000000";

    private async Task<RbpInvocationAnswer> ReplayTerminalAsync(
        RbpInvokeRequest request,
        RbpStoredInvocation stored,
        CancellationToken cancellationToken)
    {
        if (stored.State == RbpInvocationState.Indeterminate)
        {
            return ReplayIndeterminate(stored);
        }

        RbpConformanceOmittedOriginReplay? omitted = await _omittedOriginObservation
            .TryPrepareReplayAsync(request, stored, _journal, cancellationToken)
            .ConfigureAwait(false);
        if (omitted is not null)
        {
            return RbpInvocationAnswer.Result(
                RbpInvocationPayloads.ConformanceOmittedOriginReplay(
                    omitted.OriginInvocationId, omitted.ResultDigest),
                omittedOriginReplay: omitted);
        }

        JsonElement outcome = RequireOutcome(
            stored.TerminalOutcomeJson,
            "terminal");
        if (stored.CarrierPlan is { } plan)
        {
            IReadOnlyList<RbpInvocationAnswer> prefixes = plan.OrderedPrefixes
                .Select(frame => new RbpInvocationAnswer(frame.Type, frame.Payload))
                .ToArray();
            return RbpInvocationAnswer.Result(
                RbpInvocationPayloads.ReplayTerminal(plan.TerminalPayload),
                prefixes,
                plan.CarrierKey);
        }
        return RbpInvocationAnswer.Result(
            RbpInvocationPayloads.ReplayTerminal(outcome));
    }

    /// <summary>
    /// Section 12.2 rule 1 replay of an indeterminate mutation.
    /// </summary>
    /// <remarks>
    /// The durable rule 4 body is journal evidence and deliberately carries
    /// only the scope, hold, and outcome flags. Section 15 makes the wire
    /// error a complete shape — <c>invocation_id</c>, <c>fault_class</c>,
    /// <c>replayed</c>, and a bounded <c>message</c> included — so the answer
    /// is rebuilt from the stored row rather than echoing the evidence
    /// verbatim, exactly as the first delivery built it, with
    /// <c>replayed:true</c>.
    /// </remarks>
    private static RbpInvocationAnswer ReplayIndeterminate(
        RbpStoredInvocation stored)
    {
        if (stored.VerificationHoldId is not { Length: > 0 } holdId)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "An indeterminate replay requires the installed " +
                "Section 6.2.1 verification hold id.");
        }

        if (stored.Identity.MutationScopeJcs is not { Length: > 0 } scopeJcs)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "An indeterminate replay requires the durable mutation " +
                "scope.");
        }

        using JsonDocument scope = JsonDocument.Parse(scopeJcs);
        return RbpInvocationAnswer.Error(
            RbpInvocationPayloads.JournalIndeterminateError(
                stored.Identity.InvocationId,
                holdId,
                scope.RootElement,
                RbpInvocationPayloads.MutationMayHaveExecutedMessage,
                replayed: true));
    }

    private static RbpInvocationAnswer ReplayLate(RbpStoredInvocation stored)
    {
        // Section 12.2 rule 2 and Section 10.3 both make the hold id and the
        // exact late-result digest REQUIRED here. A row that reached this
        // admission without them is a storage defect, not a peer fault.
        JsonElement outcome = RequireOutcome(
            stored.LateTerminalOutcomeJson,
            "late terminal");
        if (stored.VerificationHoldId is not { Length: > 0 } holdId ||
            stored.LateResultDigest is not { Length: > 0 } digest)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "A late-after-indeterminate replay requires both a " +
                "verification hold id and the durable late result digest.");
        }

        return RbpInvocationAnswer.Result(
            RbpInvocationPayloads.ReplayLateAfterIndeterminate(
                outcome,
                holdId,
                digest));
    }

    private static RbpInvocationAnswer RefuseIndeterminate(
        RbpInvokeRequest request,
        RbpInvocationAdmissionResult admission)
    {
        if (admission.VerificationHoldId is not { Length: > 0 } holdId)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "Section 12.2 rule 4 requires an installed verification hold.");
        }

        return RbpInvocationAnswer.Error(
            RbpInvocationPayloads.JournalIndeterminateError(
                request.InvocationId,
                holdId,
                request.MutationScope,
                RbpInvocationPayloads.MutationMayHaveExecutedMessage,
                replayed: false));
    }

    private async Task<RbpInvocationAnswer> ExecuteAsync(
        RbpInvokeRequest request,
        RbpInvocationIdentity identity,
        bool claimDispatchOwnership,
        CancellationToken cancellationToken,
        RbpPayloadRecoveryRequest? recovery)
    {
        if (recovery is null && !_decisionQuarantine.TryReserve(request.Rsid))
            throw new RbpDispatchException(RbpDispatchErrorCode.Environment,
                "The bounded dispatch-decision owner is unavailable.");
        // Durability step 2, before dispatch ownership.
        if (claimDispatchOwnership)
        {
            await _journal
                .MarkInvocationExecutingAsync(
                    identity.IdempotencyKey,
                    cancellationToken)
                .ConfigureAwait(false);
        }

        if (recovery is not null)
        {
            return await ReservePayloadRecoveryAsync(request, identity, recovery)
                .ConfigureAwait(false);
        }

        long startedTimestamp = Stopwatch.GetTimestamp();
        RbpAddinOutcome outcome;
        try
        {
            outcome = await _channel
                .InvokeAsync(
                    request.Rsid,
                    new AddinCall(
                        request.InvocationId,
                        request.Method,
                        JObject.Parse(request.Parameters.GetRawText()),
                        request.Timeout),
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            // The channel threw rather than reporting dispatch evidence, so we
            // cannot prove the add-in was untouched. Treat it as possibly
            // dispatched: Section 15 forbids labelling an unknown write as a
            // retryable environment fault.
            outcome = new RbpAddinOutcome(RbpAddinOutcomeKind.PossiblyDispatched,
                default, [], 0, 0, Message: exception.Message);
        }

        outcome = outcome.ConservativeClassification();
        _decisionQuarantine.Own(request.Rsid, outcome.Lease);

        var metrics = new RbpInvocationMetrics(
            (long)Stopwatch
                .GetElapsedTime(startedTimestamp, Stopwatch.GetTimestamp())
                .TotalMilliseconds,
            outcome.RequestBytes,
            outcome.ResponseBytes);

        bool durableDecisionProven = false;
        try
        {
            RbpInvocationAnswer answer = outcome.Kind switch
            {
                RbpAddinOutcomeKind.Completed or RbpAddinOutcomeKind.Guarded =>
                    await TerminalizeSuccessAsync(
                            request,
                            identity,
                            outcome,
                            metrics,
                            cancellationToken,
                            () => durableDecisionProven = true)
                        .ConfigureAwait(false),

                RbpAddinOutcomeKind.KnownNotDispatched =>
                    await TerminalizeKnownFailureAsync(
                            request,
                            identity,
                            outcome,
                            cancellationToken)
                        .ConfigureAwait(false),

                RbpAddinOutcomeKind.ApplicationError when !request.Mutating =>
                    await TerminalizeKnownFailureAsync(request, identity,
                        outcome with { Retryable = false }, DurableDecisionToken).ConfigureAwait(false),

                RbpAddinOutcomeKind.PossiblyDispatched when !request.Mutating && outcome.Retryable == false =>
                    await TerminalizeKnownFailureAsync(request, identity,
                        outcome, DurableDecisionToken).ConfigureAwait(false),

                _ => await TerminalizeUnknownAsync(
                            request,
                            identity,
                            outcome.Message ??
                                "The add-in dispatch outcome is unknown.",
                            outcome.FaultClass,
                            cancellationToken)
                        .ConfigureAwait(false),
            };
            durableDecisionProven = true;
            return answer;
        }
        finally
        {
            // Only now. Releasing before the outcome is durable would reopen
            // the add-in session while this invocation's fate lives solely in
            // memory; a crash in that window lets a redelivery dispatch again
            // against a row the journal still reports as `executing`.
            if (durableDecisionProven)
                _decisionQuarantine.ReleaseProven(request.Rsid, outcome.Lease);
        }
    }

    private async Task<RbpInvocationAnswer> ReservePayloadRecoveryAsync(
        RbpInvokeRequest request, RbpInvocationIdentity identity,
        RbpPayloadRecoveryRequest recovery)
    {
        RbpRecoveredPayload? lease = await _journal.GetCorrelatedRecoveryPayloadAsync(
            request.Rsid, recovery.OriginInvocationId, recovery.ExpectedResultDigest,
            DurableDecisionToken).ConfigureAwait(false);
        if (lease is null)
            return await TerminalizeRecoveryUnavailableAsync(request, identity).ConfigureAwait(false);
        using (lease)
        {
            if (lease.RawResponseBytes.Length is <= 0 or > RbpArtifactCarrierProducer.MaximumCombinedBytes ||
                !(_connectionCapabilities.Value ?? Array.Empty<string>()).Contains("chunked_results", StringComparer.Ordinal))
                return await TerminalizeRecoveryUnavailableAsync(request, identity).ConfigureAwait(false);
            try
            {
                RbpRecoveryCarrierReservation reservation = await _journal
                    .PersistProtectedRecoveryTerminalAndReserveAsync(
                        new RbpRecoveryCarrierReservationRequest(request.Rsid, request.InvocationId,
                            recovery.OriginInvocationId, recovery.ExpectedResultDigest,
                            RbpArtifactCarrierProducer.MaximumChunkBytes,
                            new RbpRecoveryCarrierHeader("application/json", "base64"),
                            recovery.EnvelopeDigest(request.InvocationId),
                            DateTimeOffset.UtcNow.Add(RbpJournalStore.DefaultRetentionPeriod)),
                        DurableDecisionToken).ConfigureAwait(false);
                return RbpInvocationAnswer.Recovery(reservation);
            }
            catch (Exception)
            {
                RbpRecoveryCarrierReservation? readback = await _journal
                    .GetRecoveryCarrierReservationAsync(request.InvocationId, DurableDecisionToken)
                    .ConfigureAwait(false);
                if (readback is not null && readback.Phase != RbpRecoveryCarrierPhase.Tombstoned)
                    return RbpInvocationAnswer.Recovery(readback);
                return await TerminalizeRecoveryUnavailableAsync(request, identity).ConfigureAwait(false);
            }
        }
    }

    private async Task<RbpInvocationAnswer> TerminalizeRecoveryUnavailableAsync(
        RbpInvokeRequest request, RbpInvocationIdentity identity)
    {
        JsonElement body = RbpInvocationPayloads.KnownError(request.InvocationId,
            "environment", false, "The correlated recovery payload is unavailable.");
        Exception? failure = null;
        try
        {
            await _journal.PersistInvocationTerminalAsync(identity.IdempotencyKey,
                new RbpInvocationTerminal(RbpInvocationState.Failed, body,
                    JournalEvidenceDigest(body)), DurableDecisionToken).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            failure = exception;
        }
        RbpStoredInvocation? stored = await _journal
            .GetInvocationAsync(identity.IdempotencyKey, DurableDecisionToken)
            .ConfigureAwait(false);
        string digest = JournalEvidenceDigest(body);
        if (stored?.State == RbpInvocationState.Failed &&
            string.Equals(stored.ResultDigest, digest, StringComparison.Ordinal) &&
            stored.TerminalOutcomeJson is { Length: > 0 } terminal &&
            string.Equals(Rfc8785Json.Canonicalize(JsonDocument.Parse(terminal).RootElement),
                Rfc8785Json.Canonicalize(body), StringComparison.Ordinal))
        {
            return RbpInvocationAnswer.Error(body);
        }
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo
            .Capture(failure).Throw();
        throw new RbpDispatchException(RbpDispatchErrorCode.Environment,
            "The recovery terminal was not durably recorded.");
    }

    private async Task<RbpInvocationAnswer> TerminalizeSuccessAsync(
        RbpInvokeRequest request,
        RbpInvocationIdentity identity,
        RbpAddinOutcome outcome,
        RbpInvocationMetrics metrics,
        CancellationToken cancellationToken,
        Action durableDecisionProven)
    {
        bool guarded = outcome.Kind == RbpAddinOutcomeKind.Guarded;

        // Section 10.3: the digest is over the exact raw UTF-8 add-in JSON-RPC
        // response body, after the 4-byte length prefix is removed and before
        // parsing or RBP wrapping. It is REQUIRED for a terminal read carrying
        // a non-null Section 6.2.1 verification correlation so both peers can
        // check a later evidence digest independently.
        string digest = ComputeResultDigest(outcome.RawResponsePayload);
        bool digestRequired =
            request.Verification.ValueKind is not (JsonValueKind.Null or
                JsonValueKind.Undefined);

        // Section 10.3 makes guarded_reason REQUIRED exactly when the status
        // is guarded. A channel that reports a guard without a usable code
        // falls back to the frozen `unspecified_guarded` value rather than
        // emitting a non-conformant body.
        JsonElement body = RbpInvocationPayloads.InvocationResult(
            request.InvocationId,
            guarded ? "guarded" : "completed",
            outcome.Result,
            guarded ? outcome.GuardedReason ?? "unspecified_guarded" : null,
            digestRequired ? digest : null,
            metrics);

        // The producer runs above binding selection and before the terminal
        // decision is persisted.  Therefore the journal stores the exact
        // manifest that will follow durable chunk frames, rather than an
        // inline body that a reconnect could reinterpret differently.
        IReadOnlyList<RbpInvocationAnswer> prefixes =
            Array.AsReadOnly(Array.Empty<RbpInvocationAnswer>());
        string? carrierKey = null;
        RbpInvocationState terminalState = guarded
            ? RbpInvocationState.Guarded
            : RbpInvocationState.Completed;
        if (_carrierProducer is not null)
        {
            try
            {
                RbpCarrierEmission? carrier = await _carrierProducer
                    .TryPrepareAsync(
                        request.Rsid,
                        body,
                        outcome.Result,
                        _connectionCapabilities.Value ?? Array.Empty<string>(),
                        DurableDecisionToken)
                    .ConfigureAwait(false);
                if (carrier is not null)
                {
                    body = carrier.TerminalPayload;
                    prefixes = carrier.Prefixes;
                    carrierKey = carrier.CarrierKey;
                }
            }
            catch (Exception exception) when (
                exception is RbpArtifactCarrierException or IOException or
                    UnauthorizedAccessException or System.Security.SecurityException)
            {
                // The add-in has already answered. Persist a narrow terminal
                // error rather than leaving the invocation executing or
                // exposing a raw local artifact/path in an inline result.
                body = RbpInvocationPayloads.KnownError(
                    request.InvocationId,
                    faultClass: "environment",
                    retryable: false,
                    message: "The bridge could not durably prepare the result carrier.");
                prefixes = Array.AsReadOnly(Array.Empty<RbpInvocationAnswer>());
                carrierKey = null;
                terminalState = RbpInvocationState.Failed;
            }
        }

        // The sealed production policy is Never. Only the real-worker host
        // can arm this after the routed channel carried its verified fixture
        // process attestation; ordinary completed terminals stay unchanged.
        bool armSuppressedOrigin = _omittedOriginObservation.TryArm(
            request, identity, outcome, digest);

        // Durability step 3, before the answer leaves the bridge.
        await _journal
            .PersistInvocationTerminalAsync(
                identity.IdempotencyKey,
                new RbpInvocationTerminal(
                    terminalState,
                    body,
                    digest,
                    carrierKey is null
                        ? null
                        : CreateCarrierPlan(carrierKey, prefixes, body),
                    (IsOmittedPayload(body) || armSuppressedOrigin)
                        ? new RbpRecoveryPayload(digest, outcome.RawResponsePayload)
                        : null),
                DurableDecisionToken, expectedIdentity: identity)
            .ConfigureAwait(false);

        durableDecisionProven();

        if (armSuppressedOrigin)
        {
            throw new RbpConformanceOriginSuppressedException();
        }

        return terminalState == RbpInvocationState.Failed
            ? RbpInvocationAnswer.Error(body)
            : RbpInvocationAnswer.Result(body, prefixes, carrierKey);
    }

    private async Task<RbpInvocationAnswer> TerminalizeKnownFailureAsync(
        RbpInvokeRequest request,
        RbpInvocationIdentity identity,
        RbpAddinOutcome outcome,
        CancellationToken cancellationToken)
    {
        // Reached only when the channel can prove no add-in byte was written,
        // so the outcome really is known and a read may be retried by the
        // orchestrator.
        (string faultClass, bool retryable, string message) =
            await EnrichFailureWithLocalStatusAsync(
                    request.Rsid,
                    outcome.FaultClass ?? "addin_unreachable",
                    outcome.Retryable ?? !request.Mutating,
                    outcome.Message ?? "The add-in could not be reached.",
                    cancellationToken)
                .ConfigureAwait(false);
        JsonElement body = RbpInvocationPayloads.KnownError(
            request.InvocationId,
            faultClass,
            retryable,
            message,
            outcome.AddinError);

        await _journal
            .PersistInvocationTerminalAsync(
                identity.IdempotencyKey,
                new RbpInvocationTerminal(
                    RbpInvocationState.Failed,
                    body,
                    JournalEvidenceDigest(body)),
                DurableDecisionToken, expectedIdentity: identity)
            .ConfigureAwait(false);

        return RbpInvocationAnswer.Error(body);
    }

    private async Task<RbpInvocationAnswer> TerminalizeUnknownAsync(
        RbpInvokeRequest request,
        RbpInvocationIdentity identity,
        string message,
        string? faultClassHint,
        CancellationToken cancellationToken)
    {
        if (!request.Mutating)
        {
            // A read whose dispatch is uncertain is still a known-outcome
            // failure: re-running it cannot commit anything. The channel's
            // classification hint distinguishes a deadline expiry
            // (`revit_timeout`) from the generic transient class; both stay
            // retryable for a read under the Section 15 table.
            (string faultClass, bool retryable, string enrichedMessage) =
                await EnrichFailureWithLocalStatusAsync(
                        request.Rsid,
                        faultClassHint ?? "environment",
                        retryable: true,
                        message,
                        cancellationToken)
                    .ConfigureAwait(false);
            JsonElement readBody = RbpInvocationPayloads.KnownError(
                request.InvocationId,
                faultClass,
                retryable,
                enrichedMessage);
            await _journal
                .PersistInvocationTerminalAsync(
                    identity.IdempotencyKey,
                    new RbpInvocationTerminal(
                        RbpInvocationState.Failed,
                        readBody,
                        JournalEvidenceDigest(readBody)),
                    DurableDecisionToken, expectedIdentity: identity)
                .ConfigureAwait(false);
            return RbpInvocationAnswer.Error(readBody);
        }

        // Section 15: after the first add-in byte may have been sent,
        // journal_indeterminate replaces the otherwise retryable environment
        // class and activates the Section 6.2.1 scope hold. The store mints and
        // installs the hold as part of persisting the indeterminate terminal.
        string? holdId = await _journal
            .PersistInvocationTerminalAsync(
                identity.IdempotencyKey,
                new RbpInvocationTerminal(
                    RbpInvocationState.Indeterminate,
                    Outcome: default,
                    ResultDigest: null),
                DurableDecisionToken, expectedIdentity: identity)
            .ConfigureAwait(false);

        if (holdId is not { Length: > 0 })
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "Persisting an indeterminate mutation must install a " +
                "Section 6.2.1 scope hold.");
        }

        return RbpInvocationAnswer.Error(
            RbpInvocationPayloads.JournalIndeterminateError(
                request.InvocationId,
                holdId,
                request.MutationScope,
                message,
                replayed: false));
    }

    /// <summary>
    /// RES-10 failure-path enrichment: consults local <c>mcp_status</c>
    /// evidence only after a transport-shaped failure and never on the invoke
    /// hot path.
    /// </summary>
    /// <remarks>
    /// Only <c>addin_unreachable</c>, <c>environment</c>, and
    /// <c>revit_timeout</c> qualify — classes where the add-in never answered
    /// and a competing active Revit task is a plausible diagnosis. A class the
    /// add-in itself reported (<c>revit_api</c>, <c>parameter</c>,
    /// <c>unsupported</c>) is already a known answer, and the Section 15
    /// <c>journal_indeterminate</c> promotion never reaches this method at
    /// all. Enrichment is best-effort evidence: a probe fault leaves the
    /// original failure untouched.
    /// </remarks>
    private async Task<(string FaultClass, bool Retryable, string Message)>
        EnrichFailureWithLocalStatusAsync(
            string rsid,
            string faultClass,
            bool retryable,
            string message,
            CancellationToken cancellationToken)
    {
        if (_busyProbe is null ||
            faultClass is not ("addin_unreachable" or
                "environment" or
                "revit_timeout"))
        {
            return (faultClass, retryable, message);
        }

        string? activeTask;
        try
        {
            activeTask = await _busyProbe
                .FindActiveTaskAsync(rsid, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception exception)
            when (exception is not OperationCanceledException)
        {
            return (faultClass, retryable, message);
        }

        if (activeTask is not { Length: > 0 })
        {
            return (faultClass, retryable, message);
        }

        // Section 15: revit_busy is retryable by default — the competing task
        // ends and the same read can succeed unchanged.
        return (
            "revit_busy",
            true,
            $"An active Revit task occupies this session: {activeTask}. " +
            message);
    }

    /// <summary>
    /// The digest the journal stores alongside a terminal row that has no
    /// add-in response to digest.
    /// </summary>
    /// <remarks>
    /// This is journal evidence, not the Section 10.3 wire <c>result_digest</c>
    /// — that one is defined over the raw add-in response bytes and there are
    /// none here. Section 15 in fact forbids a wire <c>result_digest</c> on a
    /// <c>journal_indeterminate</c> error, so the two must not be conflated.
    /// The store uses this same canonical-body convention when it mints an
    /// indeterminate outcome itself.
    /// </remarks>
    private static string JournalEvidenceDigest(JsonElement body) =>
        Rfc8785Json.Sha256Digest(body);

    private static RbpCarrierPlan CreateCarrierPlan(
        string carrierKey,
        IReadOnlyList<RbpInvocationAnswer> prefixes,
        JsonElement terminal)
    {
        if (prefixes.Count == 0)
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                "A carrier terminal cannot be persisted without prefix frames.");
        }

        RbpCarrierPlanFrame[] frames = prefixes
            .Select(value => new RbpCarrierPlanFrame(value.Type, value.Payload.Clone()))
            .ToArray();
        JsonElement serializedPrefixes = JsonSerializer.SerializeToElement(
            frames.Select(frame => new { type = frame.Type, payload = frame.Payload }));
        string prefixDigest = RawJsonDigest(serializedPrefixes.GetRawText());
        string terminalDigest = RawJsonDigest(terminal.GetRawText());
        byte[] identity = Encoding.UTF8.GetBytes(
            carrierKey + "\n" + prefixDigest + "\n" + terminalDigest);
        string planId = "sha256:" + Convert.ToHexString(SHA256.HashData(identity))
            .ToLowerInvariant();
        return new RbpCarrierPlan(
            planId,
            carrierKey,
            Array.AsReadOnly(frames),
            terminal.Clone(),
            prefixDigest,
            terminalDigest);
    }

    private static string RawJsonDigest(string json) => "sha256:" +
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json)))
            .ToLowerInvariant();

    private static string ComputeResultDigest(byte[] rawResponsePayload) =>
        "sha256:" +
        Convert.ToHexString(SHA256.HashData(rawResponsePayload))
            .ToLowerInvariant();

    private static bool IsOmittedPayload(JsonElement body) =>
        body.ValueKind == JsonValueKind.Object &&
        body.TryGetProperty("payload_omitted", out JsonElement omitted) &&
        omitted.ValueKind is JsonValueKind.True;

    private static JsonElement RequireOutcome(string? json, string what)
    {
        if (json is not { Length: > 0 })
        {
            throw new RbpDispatchException(
                RbpDispatchErrorCode.Environment,
                $"The journal row is missing its {what} outcome body.");
        }

        using JsonDocument document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }
}

/// <summary>
/// What the bridge sends back for one invocation: a Section 10.3 <c>result</c>
/// or a Section 15 <c>error</c>, already terminal and already durable.
/// </summary>
internal sealed record RbpInvocationAnswer(
    string Type,
    JsonElement Payload,
    IReadOnlyList<RbpInvocationAnswer>? Prefixes = null,
    string? CarrierKey = null,
    RbpRecoveryCarrierReservation? RecoveryReservation = null,
    RbpConformanceOmittedOriginReplay? OmittedOriginReplay = null)
{
    internal static RbpInvocationAnswer Result(
        JsonElement payload,
        IReadOnlyList<RbpInvocationAnswer>? prefixes = null,
        string? carrierKey = null,
        RbpConformanceOmittedOriginReplay? omittedOriginReplay = null) =>
        new("result", payload, prefixes, carrierKey,
            OmittedOriginReplay: omittedOriginReplay);

    internal static RbpInvocationAnswer Error(JsonElement payload) =>
        new("error", payload);

    internal static RbpInvocationAnswer Partial(JsonElement payload) =>
        new("partial", payload);

    internal static RbpInvocationAnswer Recovery(RbpRecoveryCarrierReservation reservation) =>
        new("recovery_carrier", default, RecoveryReservation: reservation);
}
