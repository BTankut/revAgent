using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed partial class RbpConnectionCoordinator
{
    private async Task SynchronizeSessionsAsync(
        ConnectionCycleContext context,
        RbpJournalRecoveryPlan recovery)
    {
        IReadOnlyList<RbpLocalSessionSnapshot> locals =
            ValidateCatalogSnapshot(
                await _catalog.ReadAsync(context.Token)
                    .ConfigureAwait(false));
        var localByKey = locals.ToDictionary(
            item => item.LocalSessionKey,
            StringComparer.Ordinal);
        bool ambiguousResumeAuthority = recovery.ResumeCandidates
            .Where(candidate =>
                localByKey.TryGetValue(
                    candidate.Session.LocalSessionKey,
                    out RbpLocalSessionSnapshot? local) &&
                RegistrationMatches(candidate.Session, local))
            .GroupBy(
                candidate => candidate.Session.LocalSessionKey,
                StringComparer.Ordinal)
            .Any(group => group.Count() > 1);
        if (ambiguousResumeAuthority)
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.SessionAuthorityConflict,
                "More than one resumable RBP session claims the same " +
                "current local session.");
        }

        foreach (RbpUnregisterTombstone tombstone in
                 recovery.PendingUnregister.OrderBy(
                     item => item.Rsid,
                     StringComparer.Ordinal))
        {
            await SendUnregisterAsync(context, tombstone)
                .ConfigureAwait(false);
        }

        bool hasResume = recovery.ResumeCandidates.Count > 0;
        if (hasResume)
        {
            AdvanceConnection(
                new RbpConnectionEvent(
                    RbpConnectionEventType.BeginResume));
        }

        var claimedLocalKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (RbpResumeCandidate candidate in
                 recovery.ResumeCandidates.OrderBy(
                     item => item.Session.Rsid,
                     StringComparer.Ordinal))
        {
            if (!localByKey.TryGetValue(
                    candidate.Session.LocalSessionKey,
                    out RbpLocalSessionSnapshot? local))
            {
                await RevokeAndSendUnregisterAsync(
                        context,
                        candidate.Session.Rsid,
                        RbpSessionUnregisterReason.RevitExited)
                    .ConfigureAwait(false);
                continue;
            }

            if (!RegistrationMatches(candidate.Session, local))
            {
                await RevokeAndSendUnregisterAsync(
                        context,
                        candidate.Session.Rsid,
                        RbpSessionUnregisterReason.SessionReplaced)
                    .ConfigureAwait(false);
                continue;
            }

            if (!claimedLocalKeys.Add(local.LocalSessionKey))
            {
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "More than one durable RBP session claims the same " +
                    "current local session.");
            }

            await ResumeSessionAsync(context, candidate, local)
                .ConfigureAwait(false);
        }

        foreach (RbpExpiredSession expired in
                 recovery.ExpiredSessions.OrderBy(
                     item => item.Rsid,
                     StringComparer.Ordinal))
        {
            RbpSessionUnregisterReason reason =
                localByKey.ContainsKey(expired.LocalSessionKey)
                    ? RbpSessionUnregisterReason.SessionReplaced
                    : RbpSessionUnregisterReason.RevitExited;
            await RevokeAndSendUnregisterAsync(
                    context,
                    expired.Rsid,
                    reason)
                .ConfigureAwait(false);
        }

        foreach (RbpLocalSessionSnapshot local in locals)
        {
            if (!claimedLocalKeys.Contains(local.LocalSessionKey))
            {
                await RegisterSessionAsync(context, local)
                    .ConfigureAwait(false);
                _ = claimedLocalKeys.Add(local.LocalSessionKey);
            }
        }

        if (hasResume)
        {
            AdvanceConnection(
                new RbpConnectionEvent(
                    RbpConnectionEventType.ResumeComplete));
        }
    }

    private async Task ReconcileCurrentCatalogAsync(
        ConnectionCycleContext context)
    {
        IReadOnlyList<RbpLocalSessionSnapshot> locals =
            ValidateCatalogSnapshot(
                await _catalog.ReadAsync(context.Token)
                    .ConfigureAwait(false));
        var localByKey = locals.ToDictionary(
            item => item.LocalSessionKey,
            StringComparer.Ordinal);
        IReadOnlyList<BoundSession> bound = context.GetBoundSessions();

        foreach (BoundSession session in bound)
        {
            if (!localByKey.TryGetValue(
                    session.Local.LocalSessionKey,
                    out RbpLocalSessionSnapshot? current))
            {
                await RevokeBoundSessionAsync(
                        context,
                        session,
                        RbpSessionUnregisterReason.RevitExited)
                    .ConfigureAwait(false);
                continue;
            }

            if (!RegistrationMatches(session.Stored, current))
            {
                await RevokeBoundSessionAsync(
                        context,
                        session,
                        RbpSessionUnregisterReason.SessionReplaced)
                    .ConfigureAwait(false);
                continue;
            }

            context.RefreshBoundSession(session.Stored.Rsid, current);
        }

        var activeLocalKeys = new HashSet<string>(
            context.GetBoundSessions().Select(
                item => item.Local.LocalSessionKey),
            StringComparer.Ordinal);
        foreach (RbpLocalSessionSnapshot local in locals)
        {
            if (!activeLocalKeys.Contains(local.LocalSessionKey))
            {
                await RegisterSessionAsync(context, local)
                    .ConfigureAwait(false);
                _ = activeLocalKeys.Add(local.LocalSessionKey);
            }
        }
    }

    private async Task ResumeSessionAsync(
        ConnectionCycleContext context,
        RbpResumeCandidate candidate,
        RbpLocalSessionSnapshot local)
    {
        RbpSessionLifecycleState lifecycle =
            CreateDisconnectedSessionLifecycle(candidate.Session);
        lifecycle = AdvanceSession(
            lifecycle,
            new RbpSessionEvent(RbpSessionEventType.ResumeRequested));

        try
        {
            RbpResumeControl payload = await CreateResumePayloadAsync(
                    context,
                    candidate,
                    local)
                .ConfigureAwait(false);
            // The control envelope is deliberately composed once, before the
            // pending flight is installed.  No data sequence/outbox allocation
            // occurs here, and a same-cycle wait can only retain these exact
            // bytes; a new connection always re-enters CreateResumePayloadAsync
            // and obtains a new fresh read/proof.
            RbpEnvelope resume = CreateControlEnvelope("session_resume", payload.Payload);
            Task<RbpEnvelope> response = context.BeginResume(candidate.Session.Rsid);
            await context.Cycle.SendAsync(
                    resume,
                    context.Token)
                .ConfigureAwait(false);
            RbpResumeAck parsed = ParseResumeAck(
                await WaitForLifecycleControlAsync(
                        response,
                        _cycleFactory.BindingKind,
                        "session_resume",
                        context.Token)
                    .ConfigureAwait(false),
                candidate.Session.Rsid);
            RbpRecoveryTerminalPlan? terminal = await _journal
                .ApplyRecoveryTerminalAcknowledgementAsync(
                    parsed.Rsid, parsed.LastReceivedSequence,
                    gatewayDeliveryReceiptRecorded: true,
                    sourceReleaseEligible: true, context.Token)
                .ConfigureAwait(false);
            if (terminal?.State == "tombstoned")
            {
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.UnexpectedControl,
                    "Recovery terminal resume acknowledgement violated its durable fence.");
            }
            if (terminal?.State == "confirmed")
            {
                ObserveRecoveryTerminalAcknowledgement(context, terminal);
                ReleaseRecoveryTerminalClaims(context, parsed.Rsid,
                    terminal.RecoveryInvocationId, parsed.LastReceivedSequence);
            }
            RbpResumeAcknowledgementResult applied =
                await _journal.ApplyResumeAcknowledgementAsync(
                        parsed.Rsid,
                        parsed.LastReceivedSequence,
                        parsed.ResumeExpiresAt,
                        context.Token)
                    .ConfigureAwait(false);
            if (payload.RouteAuthorityCheckpoint is { } checkpoint)
            {
                MarkRouteAuthorityCheckpoint(context, parsed.Rsid, checkpoint);
            }
            lifecycle = AdvanceSession(
                lifecycle,
                new RbpSessionEvent(
                    RbpSessionEventType.Resumed,
                    Rsid: parsed.Rsid));
            BindRegisteredRoute(parsed.Rsid, local);
            context.AddBoundSession(
                new BoundSession(local, applied.Session, lifecycle));
            context.QueueRetransmit(applied.Retransmit);

            context.AcknowledgeResumeApplied(candidate.Session.Rsid);
            StartDocContextWatch(context, parsed.Rsid, local);
            ObserveReconnectWatchReadiness(context, applied.Session,
                payload.RouteAuthorityCheckpoint,
                watcherStarted: _docContextWatcher?.IsWatching(parsed.Rsid) == true);
        }
        catch (Exception exception)
        {
            context.RejectResumeApplication(
                candidate.Session.Rsid,
                exception);
            throw;
        }
        finally
        {
            context.EndResume(candidate.Session.Rsid);
        }
    }

    private async Task<RbpResumeControl> CreateResumePayloadAsync(
        ConnectionCycleContext context,
        RbpResumeCandidate candidate,
        RbpLocalSessionSnapshot local)
    {
        if (!IsCurrentContext(context))
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.SessionAuthorityConflict,
                "The resume connection generation is no longer current.");
        }

        bool protectedRecovery = await HasActiveProtectedRecoveryAsync(
                candidate.Session.Rsid,
                context.Token)
            .ConfigureAwait(false);
        bool proofGranted = context.GrantedConnectionCapabilities.Contains(
            RbpHelloProfile.RouteRebindProofCapability,
            StringComparer.Ordinal);
        if (!proofGranted)
        {
            if (protectedRecovery)
            {
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "Protected recovery requires a granted fresh route-rebind proof.");
            }

            return new RbpResumeControl(JsonObject(
                ("rsid", candidate.Session.Rsid),
                ("resume_token", candidate.Session.ResumeToken.Reveal()),
                ("last_rx_seq", candidate.LastJournaledReceivedSequence)), null);
        }

        RbpFreshDocumentContext? fresh = _docContextWatcher is null
            ? null
            : await _docContextWatcher.ReadFreshResumeProofContextAsync(
                    candidate.Session.Rsid,
                    context.Token)
                .ConfigureAwait(false);
        if (!IsCurrentContext(context))
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.SessionAuthorityConflict,
                "The resume connection generation changed during the fresh route read.");
        }

        if (fresh is null)
        {
            if (protectedRecovery)
            {
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "Protected recovery requires a ready current document route proof.");
            }

            // Backward-compatible ordinary resume: no proof means the
            // Gateway's legacy route-null branch remains authoritative.
            return new RbpResumeControl(JsonObject(
                ("rsid", candidate.Session.Rsid),
                ("resume_token", candidate.Session.ResumeToken.Reveal()),
                ("last_rx_seq", candidate.LastJournaledReceivedSequence)), null);
        }

        RbpRouteRebindProofResult proof = RbpRouteRebindProof.Create(
            candidate.Session.Rsid,
            context.Cycle.Acknowledgement.ConnectionId,
            fresh,
            _identifiers);
        return new RbpResumeControl(JsonObject(
            ("rsid", candidate.Session.Rsid),
            ("resume_token", candidate.Session.ResumeToken.Reveal()),
            ("last_rx_seq", candidate.LastJournaledReceivedSequence),
            ("route_rebind_proof", proof.Payload)), proof.AuthorityCheckpoint);
    }

    private async Task<bool> HasActiveProtectedRecoveryAsync(
        string rsid,
        CancellationToken token)
    {
        IReadOnlyList<RbpRecoveryCarrierReservation> carriers = await _journal
            .ListActiveRecoveryCarrierReservationsAsync(token)
            .ConfigureAwait(false);
        if (carriers.Any(item => string.Equals(
                item.Rsid, rsid, StringComparison.Ordinal)))
        {
            return true;
        }

        IReadOnlyList<RbpRecoveryTerminalPlan> terminals = await _journal
            .ListActiveRecoveryTerminalPlansAsync(token)
            .ConfigureAwait(false);
        return terminals.Any(item => string.Equals(
            item.Rsid, rsid, StringComparison.Ordinal));
    }

    private void ObserveReconnectWatchReadiness(
        ConnectionCycleContext context,
        RbpStoredSession session,
        string? routeAuthorityCheckpoint,
        bool watcherStarted)
    {
        try
        {
            long resumeOrdinal = NextC39CausalOrdinal();
            string rsidHash = RbpReconnectObservation.Hash("rsid", session.Rsid);
            string bindingDigest = RbpReconnectObservation.Hash(
                "session_binding", session.RegistrationDigest);
            string connectionDigest = RbpRouteRebindProof.MakeConnectionDigest(
                session.Rsid, context.Cycle.Acknowledgement.ConnectionId);
            _reconnectObservationSink.Observe(new RbpReconnectObservation(
                RbpReconnectObservationPhase.ResumeAcknowledgementApplied,
                context.Generation, resumeOrdinal, rsidHash, bindingDigest,
                connectionDigest, routeAuthorityCheckpoint,
                context.GrantedConnectionCapabilities.Contains(RbpHelloProfile.RouteRebindProofCapability, StringComparer.Ordinal),
                resumeOrdinal));
            if (!watcherStarted) return;
            long watchOrdinal = NextC39CausalOrdinal();
            _reconnectObservationSink.Observe(new RbpReconnectObservation(
                RbpReconnectObservationPhase.WatcherStarted,
                context.Generation, watchOrdinal, rsidHash, bindingDigest,
                connectionDigest, null,
                context.GrantedConnectionCapabilities.Contains(RbpHelloProfile.RouteRebindProofCapability, StringComparer.Ordinal),
                watchOrdinal));
        }
        catch
        {
            // Observation must not change successful durable resume/watch.
        }
    }

    private async Task RegisterSessionAsync(
        ConnectionCycleContext context,
        RbpLocalSessionSnapshot local)
    {
        RbpSessionLifecycleState lifecycle =
            RbpConnectionReducer.CreateSessionLifecycle(
                local.LocalSessionKey);
        lifecycle = AdvanceSession(
            lifecycle,
            new RbpSessionEvent(RbpSessionEventType.RegisterRequested));

        Task<RbpEnvelope> response = context.BeginRegistration(
            local.LocalSessionKey);
        try
        {
            await context.Cycle.SendAsync(
                    CreateControlEnvelope(
                        "session_register",
                        local.RegistrationPayload),
                    context.Token)
                .ConfigureAwait(false);
            RbpSessionRegistered parsed = ParseSessionRegistered(
                await WaitForLifecycleControlAsync(
                        response,
                        _cycleFactory.BindingKind,
                        "session_register",
                        context.Token)
                    .ConfigureAwait(false));
            ValidateGrantedSessionCapabilities(
                local.RegistrationPayload,
                parsed.GrantedCapabilities);
            RbpStoredSession stored =
                await _journal.PersistRegisteredSessionAsync(
                        new RbpSessionRegistration(
                            parsed.Rsid,
                            local.LocalSessionKey,
                            local.RegistrationPayload,
                            parsed.ResumeToken,
                            parsed.ResumeExpiresAt,
                            parsed.GrantedCapabilities),
                        context.Token)
                    .ConfigureAwait(false);
            lifecycle = AdvanceSession(
                lifecycle,
                new RbpSessionEvent(
                    RbpSessionEventType.Registered,
                    Rsid: parsed.Rsid));
            BindRegisteredRoute(parsed.Rsid, local);
            context.AddBoundSession(
                new BoundSession(local, stored, lifecycle));
            context.AcknowledgeRegistrationApplied(
                local.LocalSessionKey);
            StartDocContextWatch(context, parsed.Rsid, local);
        }
        catch (Exception exception)
        {
            context.RejectRegistrationApplication(
                local.LocalSessionKey,
                exception);
            throw;
        }
        finally
        {
            context.EndRegistration(local.LocalSessionKey);
        }
    }

    private void BindRegisteredRoute(
        string rsid,
        RbpLocalSessionSnapshot local)
    {
        IRbpSessionRouteBindingAuthority? authority =
            _options.SessionRouteBindingAuthority;
        if (authority is null)
        {
            return;
        }

        if (!authority.TryBindRegisteredSession(rsid, local.LocalSessionKey))
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.SessionRouteBindingFailed,
                "The registered RBP session could not be bound to its " +
                "attested local add-in session.");
        }
    }

    private async Task RevokeBoundSessionAsync(
        ConnectionCycleContext context,
        BoundSession session,
        RbpSessionUnregisterReason reason)
    {
        RbpUnregisterTombstone tombstone =
            await _journal.RecordUnregisterIntentAsync(
                    session.Stored.Rsid,
                    reason,
                    context.Token)
                .ConfigureAwait(false);
        context.RevokeBoundSession(session.Stored.Rsid, reason);
        StopDocContextWatch(session.Stored.Rsid);
        await SendUnregisterAsync(context, tombstone).ConfigureAwait(false);
    }

    private async Task<RbpEnvelope> WaitForLifecycleControlAsync(
        Task<RbpEnvelope> response,
        RbpConnectionBindingKind binding,
        string lifecycleControl,
        CancellationToken cancellationToken)
    {
        using var timeout =
            CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken);
        Task deadline = _clock.DelayAsync(
            TimeSpan.FromSeconds(10),
            timeout.Token);
        Task completed = await Task.WhenAny(response, deadline)
            .ConfigureAwait(false);
        if (ReferenceEquals(completed, deadline))
        {
            cancellationToken.ThrowIfCancellationRequested();
            ObserveLifecycleTimeout(binding, lifecycleControl);
            throw new RbpGatewayTransportException(
                RbpGatewayFailureKind.Network,
                "The Gateway did not complete the RBP session lifecycle " +
                "control within the bounded response window.");
        }

        timeout.Cancel();
        return await response.ConfigureAwait(false);
    }

    private void ObserveLifecycleTimeout(
        RbpConnectionBindingKind binding,
        string lifecycleControl)
    {
        Func<RbpLifecycleTimeoutObservation, ValueTask>? observer =
            _onLifecycleTimeoutObservation;
        if (observer is null)
        {
            return;
        }
        try
        {
            _ = observer(
                RbpLifecycleTimeoutObservation.Create(binding, lifecycleControl));
        }
        catch
        {
            // Diagnostics cannot own lifecycle cancellation or retry policy.
        }
    }

    private async Task RevokeAndSendUnregisterAsync(
        ConnectionCycleContext context,
        string rsid,
        RbpSessionUnregisterReason reason)
    {
        RbpUnregisterTombstone tombstone =
            await _journal.RecordUnregisterIntentAsync(
                    rsid,
                    reason,
                    context.Token)
                .ConfigureAwait(false);
        StopDocContextWatch(rsid);
        await SendUnregisterAsync(context, tombstone).ConfigureAwait(false);
    }

    private async Task SendUnregisterAsync(
        ConnectionCycleContext context,
        RbpUnregisterTombstone tombstone)
    {
        if (tombstone.Phase != RbpUnregisterPhase.Pending)
        {
            return;
        }

        JsonElement payload = JsonObject(
            ("rsid", tombstone.Rsid),
            (
                "reason",
                RbpJournalSerialization.ReasonToWire(tombstone.Reason)));
        await context.Cycle.SendAsync(
                CreateControlEnvelope("session_unregister", payload),
                context.Token)
            .ConfigureAwait(false);
        context.MarkUnregisterSent(tombstone.Rsid);
    }

}
