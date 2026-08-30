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
    private const int MaximumDeferredRegistrations = 128;
    private const int MaximumRegistrationAssessmentsPerPass = 4;
    private const long RegistrationReassessmentMilliseconds = 30_000;

    private enum DeferredRegistrationDisposition
    {
        Deferred,
        CleanupPending,
    }

    private sealed record DeferredRegistration(
        string RegistrationDigest,
        string SafetyDecisionDigest,
        DeferredRegistrationDisposition Disposition,
        long LastAssessedMonotonicMilliseconds);

    private sealed record RegistrationPreflight(
        bool AssessmentPerformed,
        RbpRegistrationSafetyAssessment? EligibleAssessment);

    private readonly Dictionary<string, DeferredRegistration>
        _deferredRegistrations = new(StringComparer.Ordinal);

    private async Task SynchronizeSessionsAsync(
        ConnectionCycleContext context,
        RbpJournalRecoveryPlan recovery)
    {
        CurrentOperationResult<IReadOnlyList<RbpLocalSessionSnapshot>> catalog =
            await TryRunCurrentOperationAsync(
                    context,
                    () => _catalog.ReadAsync(context.Token))
                .ConfigureAwait(false);
        if (!catalog.Started) return;
        IReadOnlyList<RbpLocalSessionSnapshot> locals =
            ValidateCatalogSnapshot(catalog.Value);
        var localByKey = locals.ToDictionary(
            item => item.LocalSessionKey,
            StringComparer.Ordinal);
        await RehydrateRegistrationCleanupSuppressionsAsync(
                context,
                recovery.PendingUnregister,
                context.Token)
            .ConfigureAwait(false);
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
            if (!TryCommitCurrent(context, () => AdvanceConnection(
                    new RbpConnectionEvent(
                        RbpConnectionEventType.BeginResume))))
                return;
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

        int registrationAssessments = 0;
        foreach (RbpLocalSessionSnapshot local in locals)
        {
            if (!claimedLocalKeys.Contains(local.LocalSessionKey))
            {
                RegistrationPreflight preflight =
                    await AssessRegistrationPreflightAsync(
                            context,
                            local,
                            registrationAssessments <
                                MaximumRegistrationAssessmentsPerPass,
                            context.Token)
                        .ConfigureAwait(false);
                if (preflight.AssessmentPerformed)
                {
                    registrationAssessments++;
                }

                if (preflight.EligibleAssessment is not { } eligible)
                {
                    continue;
                }

                await RegisterSessionAsync(context, local, eligible)
                    .ConfigureAwait(false);
                _ = claimedLocalKeys.Add(local.LocalSessionKey);
            }
        }

        if (hasResume)
        {
            _ = TryCommitCurrent(context, () => AdvanceConnection(
                new RbpConnectionEvent(
                    RbpConnectionEventType.ResumeComplete)));
        }
    }

    private async Task ReconcileCurrentCatalogAsync(
        ConnectionCycleContext context)
    {
        CurrentOperationResult<IReadOnlyList<RbpLocalSessionSnapshot>> catalog =
            await TryRunCurrentOperationAsync(
                    context,
                    () => _catalog.ReadAsync(context.Token))
                .ConfigureAwait(false);
        if (!catalog.Started) return;
        IReadOnlyList<RbpLocalSessionSnapshot> locals =
            ValidateCatalogSnapshot(catalog.Value);
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

            if (!TryCommitCurrent(context, () =>
                    context.RefreshBoundSession(
                        session.Stored.Rsid, current)))
                return;
        }

        var activeLocalKeys = new HashSet<string>(
            context.GetBoundSessions().Select(
                item => item.Local.LocalSessionKey),
            StringComparer.Ordinal);
        int registrationAssessments = 0;
        foreach (RbpLocalSessionSnapshot local in locals)
        {
            if (!activeLocalKeys.Contains(local.LocalSessionKey))
            {
                RegistrationPreflight preflight =
                    await AssessRegistrationPreflightAsync(
                            context,
                            local,
                            registrationAssessments <
                                MaximumRegistrationAssessmentsPerPass,
                            context.Token)
                        .ConfigureAwait(false);
                if (preflight.AssessmentPerformed)
                {
                    registrationAssessments++;
                }

                if (preflight.EligibleAssessment is not { } eligible)
                {
                    continue;
                }

                await RegisterSessionAsync(context, local, eligible)
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
            CurrentOperationResult<RbpResumeControl> payloadRead =
                await TryRunCurrentOperationAsync(
                        context,
                        () => CreateResumePayloadAsync(
                            context, candidate, local))
                    .ConfigureAwait(false);
            if (!payloadRead.Started)
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "Resume proof preparation lost current authority.");
            RbpResumeControl payload = payloadRead.Value;
            // The control envelope is deliberately composed once, before the
            // pending flight is installed.  No data sequence/outbox allocation
            // occurs here, and a same-cycle wait can only retain these exact
            // bytes; a new connection always re-enters CreateResumePayloadAsync
            // and obtains a new fresh read/proof.
            RbpEnvelope resume = CreateControlEnvelope("session_resume", payload.Payload);
            Task<RbpEnvelope>? response = null;
            if (!TryCommitCurrent(context, () =>
                    response = context.BeginResume(candidate.Session.Rsid)))
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "The resume attempt lost current connection authority.");
            CurrentOperationResult<bool> resumeSent =
                await TryRunCurrentOperationAsync(
                        context,
                        () => context.Cycle.SendAsync(resume, context.Token))
                    .ConfigureAwait(false);
            if (!resumeSent.Started)
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "The resume send lost current connection authority.");
            RbpResumeAck parsed = ParseResumeAck(
                await WaitForLifecycleControlAsync(
                        response!,
                        _cycleFactory.BindingKind,
                        "session_resume",
                        context.Token)
                    .ConfigureAwait(false),
                candidate.Session.Rsid);
            CurrentOperationResult<RbpRecoveryTerminalPlan?> terminalApplied =
                await TryRunCurrentOperationAsync(
                        context,
                        () => _journal.ApplyRecoveryTerminalAcknowledgementAsync(
                            parsed.Rsid,
                            parsed.LastReceivedSequence,
                            gatewayDeliveryReceiptRecorded: true,
                            sourceReleaseEligible: true,
                            context.Token))
                    .ConfigureAwait(false);
            if (!terminalApplied.Started)
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "Recovery terminal resume acknowledgement lost current " +
                    "authority.");
            RbpRecoveryTerminalPlan? terminal = terminalApplied.Value;
            if (terminal?.State == "tombstoned")
            {
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.UnexpectedControl,
                    "Recovery terminal resume acknowledgement violated its durable fence.");
            }
            if (terminal?.State == "confirmed")
            {
                CurrentOperationResult<bool> terminalObserved =
                    await TryRunCurrentOperationAsync(
                            context,
                            () =>
                            {
                                ObserveRecoveryTerminalAcknowledgement(
                                    context, terminal);
                                ReleaseRecoveryTerminalClaims(
                                    context, parsed.Rsid,
                                    terminal.RecoveryInvocationId,
                                    parsed.LastReceivedSequence);
                                return Task.FromResult(true);
                            })
                        .ConfigureAwait(false);
                if (!terminalObserved.Started)
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.SessionAuthorityConflict,
                        "Recovery terminal acknowledgement lost current " +
                        "connection authority.");
            }
            CurrentOperationResult<RbpResumeAcknowledgementResult> resumeApplied =
                await TryRunCurrentOperationAsync(
                        context,
                        () => _journal.ApplyResumeAcknowledgementAsync(
                            parsed.Rsid,
                            parsed.LastReceivedSequence,
                            parsed.ResumeExpiresAt,
                            context.Token))
                    .ConfigureAwait(false);
            if (!resumeApplied.Started)
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "Resume acknowledgement lost current authority.");
            RbpResumeAcknowledgementResult applied = resumeApplied.Value;
            lifecycle = AdvanceSession(
                lifecycle,
                new RbpSessionEvent(
                    RbpSessionEventType.Resumed,
                    Rsid: parsed.Rsid));
            bool routeBound = TryBindRegisteredRoute(
                context, parsed.Rsid, local, lifecycle);
            if (!routeBound || !TryCommitCurrent(context, () =>
                {
                    if (payload.RouteAuthorityCheckpoint is { } checkpoint)
                        MarkRouteAuthorityCheckpoint(
                            context, parsed.Rsid, checkpoint);
                    context.AddBoundSession(
                        new BoundSession(local, applied.Session, lifecycle));
                    context.QueueRetransmit(applied.Retransmit);
                    context.AcknowledgeResumeApplied(
                        candidate.Session.Rsid);
                }))
            {
                if (routeBound) RevokeBoundRoute(context, parsed.Rsid);
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "The resume connection generation changed before route publication.");
            }
            StartDocContextWatch(context, parsed.Rsid, local);
            _ = await TryRunCurrentOperationAsync(
                    context,
                    () =>
                    {
                        ObserveReconnectWatchReadiness(
                            context,
                            applied.Session,
                            payload.RouteAuthorityCheckpoint,
                            watcherStarted:
                                _docContextWatcher?.IsWatching(parsed.Rsid) ==
                                true);
                        return Task.FromResult(true);
                    })
                .ConfigureAwait(false);
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
        if (!TryCommitCurrent(context, () => { }))
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.SessionAuthorityConflict,
                "The resume connection generation is no longer current.");
        }

        bool protectedRecovery = await HasActiveProtectedRecoveryAsync(
                context,
                candidate.Session.Rsid)
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

        RbpFreshDocumentContext? fresh = null;
        if (_docContextWatcher is not null)
        {
            CurrentOperationResult<RbpFreshDocumentContext?> freshRead =
                await TryRunCurrentOperationAsync(
                        context,
                        () => _docContextWatcher
                            .ReadFreshResumeProofContextAsync(
                                candidate.Session.Rsid,
                                context.Token))
                    .ConfigureAwait(false);
            if (!freshRead.Started)
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "The resume route proof read lost current authority.");
            fresh = freshRead.Value;
        }
        if (!TryCommitCurrent(context, () => { }))
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
        ConnectionCycleContext context,
        string rsid)
    {
        CurrentOperationResult<IReadOnlyList<RbpRecoveryCarrierReservation>>
            carrierRead = await TryRunCurrentOperationAsync(
                context,
                () => _journal.ListActiveRecoveryCarrierReservationsAsync(
                    context.Token)).ConfigureAwait(false);
        if (!carrierRead.Started) return false;
        IReadOnlyList<RbpRecoveryCarrierReservation> carriers =
            carrierRead.Value;
        if (carriers.Any(item => string.Equals(
                item.Rsid, rsid, StringComparison.Ordinal)))
        {
            return true;
        }

        CurrentOperationResult<IReadOnlyList<RbpRecoveryTerminalPlan>>
            terminalRead = await TryRunCurrentOperationAsync(
                context,
                () => _journal.ListActiveRecoveryTerminalPlansAsync(
                    context.Token)).ConfigureAwait(false);
        if (!terminalRead.Started) return false;
        IReadOnlyList<RbpRecoveryTerminalPlan> terminals = terminalRead.Value;
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
        RbpLocalSessionSnapshot local,
        RbpRegistrationSafetyAssessment preflight)
    {
        RbpSessionLifecycleState lifecycle =
            RbpConnectionReducer.CreateSessionLifecycle(
                local.LocalSessionKey);
        lifecycle = AdvanceSession(
            lifecycle,
            new RbpSessionEvent(RbpSessionEventType.RegisterRequested));

        Task<RbpEnvelope>? response = null;
        if (!TryCommitCurrent(context, () =>
                response = context.BeginRegistration(local.LocalSessionKey)))
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.SessionAuthorityConflict,
                "The registration attempt lost current connection authority.");
        try
        {
            CurrentOperationResult<bool> registrationSent =
                await TryRunCurrentOperationAsync(
                        context,
                        () => context.Cycle.SendAsync(
                            CreateControlEnvelope(
                                "session_register",
                                local.RegistrationPayload),
                            context.Token))
                    .ConfigureAwait(false);
            if (!registrationSent.Started)
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "The registration send lost current connection authority.");
            RbpSessionRegistered parsed = ParseSessionRegistered(
                await WaitForLifecycleControlAsync(
                        response!,
                        _cycleFactory.BindingKind,
                        "session_register",
                        context.Token)
                    .ConfigureAwait(false));
            long registrationAcknowledgedAt =
                _clock.MonotonicMilliseconds;
            ValidateGrantedSessionCapabilities(
                local.RegistrationPayload,
                parsed.GrantedCapabilities);
            CurrentOperationResult<RbpRegistrationCommitResult>
                registrationCommitted = await TryRunCurrentOperationAsync(
                    context,
                    () => _journal.PersistRegistrationAfterAcknowledgementAsync(
                        new RbpSessionRegistration(
                            parsed.Rsid,
                            local.LocalSessionKey,
                            local.RegistrationPayload,
                            parsed.ResumeToken,
                            parsed.ResumeExpiresAt,
                            parsed.GrantedCapabilities),
                        preflight,
                        context.Token)).ConfigureAwait(false);
            if (!registrationCommitted.Started)
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "Registration acknowledgement lost current authority.");
            RbpRegistrationCommitResult committed =
                registrationCommitted.Value;
            if (committed.Disposition ==
                RbpLocalRegistrationDisposition.CleanupPending)
            {
                RbpCleanupRegistrationReceipt receipt =
                    committed.CleanupReceipt ??
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.SessionAuthorityConflict,
                        "A cleanup-pending registration omitted its durable " +
                        "receipt.");
                if (!TryCommitCurrent(context, () =>
                    {
                        MarkRegistrationCleanupPending(
                            receipt.Session.LocalSessionKey,
                            receipt.Session.RegistrationDigest,
                            receipt.SafetyDecisionDigest);
                        context.InstallCleanupReceivePermit(
                            receipt,
                            registrationAcknowledgedAt);
                        context.AcknowledgeRegistrationDeferred(
                            local.LocalSessionKey);
                        context.EndRegistration(local.LocalSessionKey);
                    }))
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.SessionAuthorityConflict,
                        "Cleanup-pending registration lost current authority.");
                await SendUnregisterAsync(context, receipt.Tombstone)
                    .ConfigureAwait(false);
                return;
            }

            if (committed.Disposition !=
                    RbpLocalRegistrationDisposition.Registered ||
                committed.CleanupReceipt is not null)
            {
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionAuthorityConflict,
                    "The registration journal returned an invalid typed " +
                    "disposition.");
            }

            RbpStoredSession stored = committed.Session;
            lifecycle = AdvanceSession(
                lifecycle,
                new RbpSessionEvent(
                    RbpSessionEventType.Registered,
                    Rsid: parsed.Rsid));
            bool routeBound = TryBindRegisteredRoute(
                context, parsed.Rsid, local, lifecycle);
            if (!routeBound || !TryCommitCurrent(context, () =>
                {
                    context.AddBoundSession(
                        new BoundSession(local, stored, lifecycle));
                    context.AcknowledgeRegistrationApplied(
                        local.LocalSessionKey);
                }))
            {
                if (routeBound) RevokeBoundRoute(context, parsed.Rsid);
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.SessionRouteBindingFailed,
                    "The registered RBP session lost current route authority.");
            }
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

    private async Task<RegistrationPreflight>
        AssessRegistrationPreflightAsync(
            ConnectionCycleContext context,
            RbpLocalSessionSnapshot local,
            bool assessmentAllowed,
            CancellationToken cancellationToken)
    {
        (_, string registrationDigest) =
            RbpJournalSerialization.CanonicalRegistration(
                local.RegistrationPayload);
        long now = _clock.MonotonicMilliseconds;
        lock (_sync)
        {
            if (_deferredRegistrations.TryGetValue(
                    local.LocalSessionKey,
                    out DeferredRegistration? existing))
            {
                if (existing.Disposition ==
                    DeferredRegistrationDisposition.CleanupPending)
                {
                    return new RegistrationPreflight(false, null);
                }

                bool unchanged = string.Equals(
                    existing.RegistrationDigest,
                    registrationDigest,
                    StringComparison.Ordinal);
                if (unchanged &&
                    now - existing.LastAssessedMonotonicMilliseconds <
                        RegistrationReassessmentMilliseconds)
                {
                    return new RegistrationPreflight(false, null);
                }
            }
            else if (_deferredRegistrations.Count >=
                     MaximumDeferredRegistrations)
            {
                return new RegistrationPreflight(false, null);
            }

            if (!assessmentAllowed)
            {
                return new RegistrationPreflight(false, null);
            }
        }

        CurrentOperationResult<RbpRegistrationSafetyAssessment> assessed =
            await TryRunCurrentOperationAsync(
                    context,
                    () => _journal.AssessRegistrationSafetyAsync(
                        local.LocalSessionKey,
                        registrationDigest,
                        cancellationToken))
                .ConfigureAwait(false);
        if (!assessed.Started) return new RegistrationPreflight(false, null);
        RbpRegistrationSafetyAssessment assessment = assessed.Value;
        RequireExactRegistrationAssessment(
            assessment,
            local.LocalSessionKey,
            registrationDigest);
        RegistrationPreflight? committed = null;
        if (!TryCommitCurrent(context, () =>
        {
            lock (_sync)
            {
                if (assessment.Disposition ==
                    RbpRegistrationSafetyDisposition.Eligible)
                {
                    _ = _deferredRegistrations.Remove(
                        local.LocalSessionKey);
                    committed = new RegistrationPreflight(true, assessment);
                    return;
                }

                if (!_deferredRegistrations.ContainsKey(
                        local.LocalSessionKey) &&
                    _deferredRegistrations.Count >=
                        MaximumDeferredRegistrations)
                {
                    committed = new RegistrationPreflight(true, null);
                    return;
                }

                _deferredRegistrations[local.LocalSessionKey] =
                    new DeferredRegistration(
                        registrationDigest,
                        assessment.SafetyDecisionDigest,
                        DeferredRegistrationDisposition.Deferred,
                        now);
                committed = new RegistrationPreflight(true, null);
            }
        }))
            return new RegistrationPreflight(false, null);
        return committed ?? new RegistrationPreflight(false, null);
    }

    private async Task RehydrateRegistrationCleanupSuppressionsAsync(
        ConnectionCycleContext context,
        IReadOnlyList<RbpUnregisterTombstone> tombstones,
        CancellationToken cancellationToken)
    {
        foreach (RbpUnregisterTombstone tombstone in tombstones)
        {
            CurrentOperationResult<RbpStoredSession?> stored =
                await TryRunCurrentOperationAsync(
                        context,
                        () => _journal.GetStoredSessionAsync(
                            tombstone.Rsid, cancellationToken))
                    .ConfigureAwait(false);
            if (!stored.Started) return;
            RbpStoredSession session = stored.Value ??
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "A pending unregister tombstone has no stored session.");
            if (!TryCommitCurrent(context, () =>
                    MarkRegistrationCleanupPending(
                        session.LocalSessionKey,
                        session.RegistrationDigest,
                        CleanupSuppressionDigest(session, tombstone))))
                return;
        }
    }

    private void MarkRegistrationCleanupPending(
        string localSessionKey,
        string registrationDigest,
        string safetyDecisionDigest)
    {
        lock (_sync)
        {
            if (_deferredRegistrations.TryGetValue(
                    localSessionKey,
                    out DeferredRegistration? existing) &&
                existing.Disposition ==
                    DeferredRegistrationDisposition.CleanupPending &&
                (!string.Equals(
                     existing.RegistrationDigest,
                     registrationDigest,
                     StringComparison.Ordinal) ||
                 !string.Equals(
                     existing.SafetyDecisionDigest,
                     safetyDecisionDigest,
                     StringComparison.Ordinal)))
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "Conflicting cleanup ownership claims the same local " +
                    "registration key.");
            }

            if (!_deferredRegistrations.ContainsKey(localSessionKey) &&
                _deferredRegistrations.Count >=
                    MaximumDeferredRegistrations)
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "The bounded registration cleanup inventory is full.");
            }

            _deferredRegistrations[localSessionKey] =
                new DeferredRegistration(
                    registrationDigest,
                    safetyDecisionDigest,
                    DeferredRegistrationDisposition.CleanupPending,
                    _clock.MonotonicMilliseconds);
        }
    }

    private void MarkRegistrationCleanupCompleted(string localSessionKey)
    {
        lock (_sync)
        {
            if (_deferredRegistrations.TryGetValue(
                    localSessionKey,
                    out DeferredRegistration? existing) &&
                existing.Disposition ==
                    DeferredRegistrationDisposition.CleanupPending)
            {
                _ = _deferredRegistrations.Remove(localSessionKey);
            }
        }
    }

    private static void RequireExactRegistrationAssessment(
        RbpRegistrationSafetyAssessment assessment,
        string localSessionKey,
        string registrationDigest)
    {
        bool exact = string.Equals(
                         assessment.LocalSessionKey,
                         localSessionKey,
                         StringComparison.Ordinal) &&
                     string.Equals(
                         assessment.RegistrationDigest,
                         registrationDigest,
                         StringComparison.Ordinal) &&
                     RbpJournalSerialization.IsSha256Digest(
                         assessment.SafetyDecisionDigest) &&
                     assessment.Disposition switch
                     {
                         RbpRegistrationSafetyDisposition.Eligible =>
                             assessment.Reason is null,
                         RbpRegistrationSafetyDisposition.Deferred =>
                             assessment.Reason is
                                 "unresolved_predecessor" or
                                 "inventory_limit",
                         _ => false,
                     };
        if (!exact)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The registration safety assessment is malformed or does " +
                "not bind the exact local registration.");
        }
    }

    private static string CleanupSuppressionDigest(
        RbpStoredSession session,
        RbpUnregisterTombstone tombstone) =>
        Rfc8785Json.Sha256Digest(
            JsonSerializer.SerializeToElement(
                new
                {
                    schema = "bridge.registration-cleanup-suppression/v1",
                    session.Rsid,
                    session.LocalSessionKey,
                    session.RegistrationDigest,
                    Reason = tombstone.Reason.ToString(),
                    Phase = tombstone.Phase.ToString(),
                }));

    private bool TryBindRegisteredRoute(
        ConnectionCycleContext context,
        string rsid,
        RbpLocalSessionSnapshot local,
        RbpSessionLifecycleState lifecycle)
    {
        IRbpSessionRouteBindingAuthority? authority =
            _options.SessionRouteBindingAuthority;
        if (authority is null)
        {
            return lifecycle.Phase == RbpSessionPhase.Registered;
        }

        return lifecycle.Phase == RbpSessionPhase.Registered &&
            authority.TryBindRegisteredSession(
                rsid, local.LocalSessionKey, context.Generation);
    }

    private async Task RevokeBoundSessionAsync(
        ConnectionCycleContext context,
        BoundSession session,
        RbpSessionUnregisterReason reason)
    {
        RevokeBoundRoute(context, session.Stored.Rsid);
        CurrentOperationResult<RbpUnregisterTombstone> intent =
            await TryRunCurrentOperationAsync(
                    context,
                    () => _journal.RecordUnregisterIntentAsync(
                        session.Stored.Rsid, reason, context.Token))
                .ConfigureAwait(false);
        if (!intent.Started) return;
        RbpUnregisterTombstone tombstone = intent.Value;
        if (!TryCommitCurrent(context, () =>
            {
                MarkRegistrationCleanupPending(
                    session.Stored.LocalSessionKey,
                    session.Stored.RegistrationDigest,
                    CleanupSuppressionDigest(session.Stored, tombstone));
                context.RevokeBoundSession(session.Stored.Rsid, reason);
            }))
            return;
        StopDocContextWatch(context, session.Stored.Rsid);
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
        RevokeBoundRoute(context, rsid);
        CurrentOperationResult<RbpUnregisterTombstone> intent =
            await TryRunCurrentOperationAsync(
                    context,
                    () => _journal.RecordUnregisterIntentAsync(
                        rsid, reason, context.Token))
                .ConfigureAwait(false);
        if (!intent.Started) return;
        RbpUnregisterTombstone tombstone = intent.Value;
        CurrentOperationResult<RbpStoredSession?> storedRead =
            await TryRunCurrentOperationAsync(
                    context,
                    () => _journal.GetStoredSessionAsync(rsid, context.Token))
                .ConfigureAwait(false);
        if (!storedRead.Started) return;
        RbpStoredSession stored = storedRead.Value ??
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "A newly recorded unregister tombstone has no stored session.");
        if (!TryCommitCurrent(context, () =>
                MarkRegistrationCleanupPending(
                    stored.LocalSessionKey,
                    stored.RegistrationDigest,
                    CleanupSuppressionDigest(stored, tombstone))))
            return;
        StopDocContextWatch(context, rsid);
        await SendUnregisterAsync(context, tombstone).ConfigureAwait(false);
    }

    private void BeginRouteAuthorityEpoch(long epoch)
    {
        IRbpSessionRouteBindingAuthority? authority =
            _options.SessionRouteBindingAuthority;
        if (authority is not null && !authority.BeginConnectionEpoch(epoch))
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.SessionRouteBindingFailed,
                "The route authority rejected the new connection epoch.");
        }
    }

    private void FenceRouteAuthorityEpoch(long epoch) =>
        _options.SessionRouteBindingAuthority?.FenceConnectionEpoch(epoch);

    private void DenyRouteAuthorityEpoch(long epoch) =>
        _options.SessionRouteBindingAuthority?.DenyConnectionEpoch(epoch);

    private void RevokeBoundRoute(ConnectionCycleContext context, string rsid) =>
        _options.SessionRouteBindingAuthority?.RevokeBoundSession(
            rsid, context.Generation);

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
        CurrentOperationResult<bool> sent = await TryRunCurrentOperationAsync(
                context,
                () => context.Cycle.SendAsync(
                    CreateControlEnvelope("session_unregister", payload),
                    context.Token))
            .ConfigureAwait(false);
        if (!sent.Started) return;
        _ = TryCommitCurrent(context, () =>
            context.MarkUnregisterSent(tombstone.Rsid));
    }

}
