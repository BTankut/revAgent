using System.Globalization;
using System.Security.Cryptography;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed partial class RbpConnectionCoordinator
{
    /// <summary>
    /// Consumes exactly one durable C39 reservation.  This is not a generic
    /// outbound operation: the store owns the sequence and protected source,
    /// while this coordinator owns one framed write under the outbound gate.
    /// </summary>
    private async Task SendRecoveryCarrierAsync(
        ConnectionCycleContext context,
        RbpRecoveryCarrierReservation reservation)
    {
        if (!context.IsDispatchAllowed(reservation.Rsid)) return;
        // The durable send-start timestamp is retained across reconnect.  The
        // phase may already be send_started after transport loss, so phase
        // alone is not a truthful resend discriminator.
        bool restartResend = reservation.SendStartedAtMilliseconds is not null;

        CurrentOperationResult<RbpRecoveryCarrierReservation> startMarked =
            await TryRunCurrentOperationAsync(
                    context,
                    () => _journal.MarkRecoveryCarrierSendStartedAsync(
                        reservation.RecoveryInvocationId, context.Token))
                .ConfigureAwait(false);
        if (!startMarked.Started) return;
        RbpRecoveryCarrierReservation started = startMarked.Value;
        if (started.Phase != RbpRecoveryCarrierPhase.SendStarted ||
            !string.Equals(started.Rsid, reservation.Rsid,
                StringComparison.Ordinal)) return;

        var claim = new RecoveryCarrierCycleKey(
            context,
            started.RecoveryInvocationId,
            started.CurrentReservedSequence,
            started.PlanVersion);
        bool claimAcquired = false;
        if (!TryCommitCurrent(context, () =>
            {
                if (context.IsDispatchAllowed(started.Rsid))
                    claimAcquired = TryAcquireRecoveryCarrierClaim(claim);
            }) || !claimAcquired)
            return;
        bool retainClaim = false;
        try
        {

            CurrentOperationResult<RbpRecoveryCarrierMaterializedFrame?> frame =
                await TryRunCurrentOperationAsync(
                        context,
                        () => _recoveryCarrierMaterializer
                            .MaterializeCurrentAsync(
                                started.RecoveryInvocationId,
                                started.Rsid,
                                context.Token))
                    .ConfigureAwait(false);
            if (!frame.Started) return;
            RbpRecoveryCarrierMaterializedFrame? materialized = frame.Value;
            if (materialized is null ||
                materialized.ReservedSequence != started.CurrentReservedSequence ||
                materialized.PlanVersion != started.PlanVersion) return;

        // All outer fields are reproducible from durable metadata.  A retry
        // therefore re-encodes identical bytes without retaining a raw frame,
        // base64 carrier, or payload outside the protected journal source.
            var snapshot = new RbpDataEnvelopeSnapshot(
                Type: materialized.Answer.Type,
                Id: started.RecoveryInvocationId,
                Rsid: started.Rsid,
                Sequence: materialized.ReservedSequence,
                Payload: materialized.Answer.Payload,
                Acknowledgement: started.InboundAcknowledgementBaseline,
                Timestamp: DateTimeOffset
                    .FromUnixTimeMilliseconds(started.CreatedAtMilliseconds)
                    .ToString("O", CultureInfo.InvariantCulture));
            RbpEnvelope envelope = CreateDataEnvelope(snapshot);
            byte[] outerBytes = RbpEnvelopeCodec.Encode(envelope);
            try
            {
                string outerDigest = "sha256:" + Convert.ToHexString(
                    SHA256.HashData(outerBytes)).ToLowerInvariant();
                CurrentOperationResult<bool> materializedObserved =
                    await TryRunCurrentOperationAsync(
                            context,
                            () =>
                            {
                                ObserveRecoveryCarrier(
                                    context,
                                    RbpRecoveryCarrierObservationPhase
                                        .Materialized,
                                    started,
                                    outerDigest);
                                return Task.FromResult(true);
                            })
                        .ConfigureAwait(false);
                if (!materializedObserved.Started) return;
                CurrentOperationResult<bool> confirmation =
                    await TryRunCurrentOperationAsync(
                            context,
                            () => _journal
                                .ConfirmRecoveryCarrierMaterializationAsync(
                                    started.RecoveryInvocationId,
                                    started.Rsid,
                                    started.PlanVersion,
                                    materialized.ReservedSequence,
                                    materialized.PayloadDigest,
                                    outerDigest,
                                    context.Token))
                        .ConfigureAwait(false);
                if (!confirmation.Started) return;
                bool confirmed = confirmation.Value;
                if (!confirmed || !context.IsDispatchAllowed(started.Rsid)) return;
                // Test-only crash seam.  Production composition leaves this
                // null.  Once final confirmation succeeded, retain the claim
                // until this cycle closes even if the seam aborts before any
                // socket byte can be emitted.
                CurrentOperationResult<bool> writeObserved =
                    await TryRunCurrentOperationAsync(
                            context,
                            () =>
                            {
                                retainClaim = true;
                                ObserveRecoveryCarrier(
                                    context,
                                    restartResend
                                        ? RbpRecoveryCarrierObservationPhase
                                            .RestartResend
                                        : RbpRecoveryCarrierObservationPhase
                                            .Write,
                                    started,
                                    outerDigest);
                                return Task.FromResult(true);
                            })
                        .ConfigureAwait(false);
                if (!writeObserved.Started) return;
                if (_beforeRecoveryCarrierWrite is { } beforeWrite)
                {
                    CurrentOperationResult<bool> callback =
                        await TryRunCurrentOperationAsync(
                                context,
                                () => beforeWrite(context.Token))
                            .ConfigureAwait(false);
                    if (!callback.Started) return;
                }

                // The only recovery-carrier socket write.  Do not route through
                // QueueOutboundDataAsync, generic outbox/spool, or diagnostics.
                await SendCurrentPreparedAsync(
                        context, envelope, started.Rsid)
                    .ConfigureAwait(false);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(outerBytes);
            }
        }
        finally
        {
            if (!retainClaim)
            {
                ReleaseRecoveryCarrierClaim(claim);
            }
        }
    }

    /// <summary>
    /// Runs before generic heartbeat acknowledgement so an equal recovery ACK
    /// is first consumed by its durable C39 fence, never as an outbox ACK.
    /// </summary>
    private async Task ApplyRecoveryCarrierAcknowledgementsAsync(
        ConnectionCycleContext context,
        IReadOnlyList<RbpSessionAcknowledgement> acknowledgements)
    {
        foreach (RbpSessionAcknowledgement acknowledgement in acknowledgements
                     .OrderBy(value => value.Rsid, StringComparer.Ordinal))
        {
            if (TryDropGatedRecoveryCarrierAcknowledgement(
                    context, acknowledgement, out _)) continue;
            CurrentOperationResult<RbpRecoveryCarrierReservation?> appliedResult =
                await TryRunCurrentOperationAsync(
                        context,
                        () => _journal
                            .ApplyRecoveryCarrierFenceAcknowledgementAsync(
                                acknowledgement.Rsid,
                                acknowledgement.Sequence,
                                context.Token))
                    .ConfigureAwait(false);
            if (!appliedResult.Started) return;
            RbpRecoveryCarrierReservation? applied = appliedResult.Value;
            if (applied?.Phase == RbpRecoveryCarrierPhase.Tombstoned)
            {
                _ = await TryRunCurrentOperationAsync(
                        context,
                        () =>
                        {
                            ReleaseRecoveryCarrierClaims(
                                context, acknowledgement.Rsid,
                                applied.RecoveryInvocationId, long.MaxValue);
                            return Task.FromResult(true);
                        })
                    .ConfigureAwait(false);
                // The journal has durably blocked this RSID.  Abort the
                // transport before generic acknowledgement can advance across
                // the fault; normal reconnect lifecycle owns its close path.
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.UnexpectedControl,
                    "Recovery carrier acknowledgement violated its durable fence.");
            }
            bool carrierReceiptApplied = applied?.Phase ==
                RbpRecoveryCarrierPhase.Reserved ||
                (applied?.Phase == RbpRecoveryCarrierPhase.Completed &&
                 acknowledgement.Sequence == applied.CurrentReservedSequence);
            if (carrierReceiptApplied && applied is not null)
            {
                CurrentOperationResult<bool> receiptObserved =
                    await TryRunCurrentOperationAsync(
                            context,
                            () =>
                            {
                                ObserveRecoveryCarrierAcknowledgement(
                                    context, applied,
                                    acknowledgement.Sequence);
                                ReleaseRecoveryCarrierClaims(
                                    context, acknowledgement.Rsid,
                                    applied.RecoveryInvocationId,
                                    acknowledgement.Sequence);
                                return Task.FromResult(true);
                            })
                        .ConfigureAwait(false);
                if (!receiptObserved.Started) return;
            }
            if (applied?.Phase == RbpRecoveryCarrierPhase.Completed &&
                acknowledgement.Sequence == applied.CurrentReservedSequence)
            {
                // The final partial receipt opens exactly one v9 terminal
                // plan. Reservation is idempotent, so a duplicate heartbeat
                // cannot allocate a second terminal sequence.
                CurrentOperationResult<RbpRecoveryTerminalPlan> reserved =
                    await TryRunCurrentOperationAsync(
                            context,
                            () => _journal.ReserveRecoveryTerminalAsync(
                                applied.RecoveryInvocationId,
                                applied.Rsid,
                                context.Token))
                        .ConfigureAwait(false);
                if (!reserved.Started) return;
            }
        }
    }

    private IReadOnlyList<RbpSessionAcknowledgement>
        GateRecoveryCarrierAcknowledgements(
            ConnectionCycleContext context,
            IReadOnlyList<RbpSessionAcknowledgement> acknowledgements) =>
        acknowledgements.Select(acknowledgement =>
        {
            return TryDropGatedRecoveryCarrierAcknowledgement(
                context, acknowledgement, out long cursor)
                ? new RbpSessionAcknowledgement(acknowledgement.Rsid, cursor)
                : acknowledgement;
        }).ToArray();

    private async Task ApplyRecoveryTerminalAcknowledgementsAsync(
        ConnectionCycleContext context,
        IReadOnlyList<RbpSessionAcknowledgement> acknowledgements)
    {
        foreach (RbpSessionAcknowledgement acknowledgement in acknowledgements
                     .OrderBy(value => value.Rsid, StringComparer.Ordinal))
        {
            // A heartbeat acknowledgement is the Gateway delivery receipt for
            // this direct, no-outbox terminal frame. No replay/admin surface
            // can supply either of these authority facts.
            CurrentOperationResult<RbpRecoveryTerminalPlan?> appliedResult =
                await TryRunCurrentOperationAsync(
                        context,
                        () => _journal.ApplyRecoveryTerminalAcknowledgementAsync(
                            acknowledgement.Rsid,
                            acknowledgement.Sequence,
                            gatewayDeliveryReceiptRecorded: true,
                            sourceReleaseEligible: true,
                            context.Token))
                    .ConfigureAwait(false);
            if (!appliedResult.Started) return;
            RbpRecoveryTerminalPlan? applied = appliedResult.Value;
            if (applied?.State == "tombstoned")
            {
                _ = await TryRunCurrentOperationAsync(
                        context,
                        () =>
                        {
                            ReleaseRecoveryTerminalClaims(
                                context, acknowledgement.Rsid,
                                applied.RecoveryInvocationId, long.MaxValue);
                            return Task.FromResult(true);
                        })
                    .ConfigureAwait(false);
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.UnexpectedControl,
                    "Recovery terminal acknowledgement violated its durable fence.");
            }
            if (applied?.State == "confirmed")
            {
                CurrentOperationResult<bool> terminalObserved =
                    await TryRunCurrentOperationAsync(
                            context,
                            () =>
                            {
                                ObserveRecoveryTerminalAcknowledgement(
                                    context, applied);
                                ReleaseRecoveryTerminalClaims(
                                    context, acknowledgement.Rsid,
                                    applied.RecoveryInvocationId,
                                    acknowledgement.Sequence);
                                return Task.FromResult(true);
                            })
                        .ConfigureAwait(false);
                if (!terminalObserved.Started) return;
            }
        }
    }

    private async Task ScheduleActiveRecoveryCarriersAsync(
        ConnectionCycleContext context)
    {
        CurrentOperationResult<IReadOnlyList<RbpRecoveryCarrierReservation>>
            listed = await TryRunCurrentOperationAsync(
                context,
                () => _journal.ListActiveRecoveryCarrierReservationsAsync(
                    context.Token)).ConfigureAwait(false);
        if (!listed.Started) return;
        IReadOnlyList<RbpRecoveryCarrierReservation> active = listed.Value;
        foreach (RbpRecoveryCarrierReservation reservation in active
                     .OrderBy(value => value.Rsid, StringComparer.Ordinal)
                     .ThenBy(value => value.CurrentReservedSequence))
        {
            if (!context.IsDispatchAllowed(reservation.Rsid)) continue;
            CurrentOperationResult<bool> gate =
                await TryRunCurrentOperationAsync(
                        context,
                        async () => await context.OutboundGate
                            .WaitAsync(context.Token).ConfigureAwait(false))
                    .ConfigureAwait(false);
            if (!gate.Started) return;
            try
            {
                CurrentOperationResult<bool> sent =
                    await TryRunCurrentOperationAsync(
                            context,
                            () => SendRecoveryCarrierAsync(
                                context, reservation))
                        .ConfigureAwait(false);
                if (!sent.Started) return;
            }
            finally
            {
                context.OutboundGate.Release();
            }
        }
    }

    private async Task ScheduleActiveRecoveryTerminalsAsync(
        ConnectionCycleContext context)
    {
        CurrentOperationResult<IReadOnlyList<RbpRecoveryTerminalPlan>> listed =
            await TryRunCurrentOperationAsync(
                    context,
                    () => _journal.ListActiveRecoveryTerminalPlansAsync(
                        context.Token))
                .ConfigureAwait(false);
        if (!listed.Started) return;
        IReadOnlyList<RbpRecoveryTerminalPlan> active = listed.Value;
        foreach (RbpRecoveryTerminalPlan plan in active
                     .OrderBy(value => value.Rsid, StringComparer.Ordinal)
                     .ThenBy(value => value.FinalSequence))
        {
            if (!context.IsDispatchAllowed(plan.Rsid)) continue;
            CurrentOperationResult<bool> gate =
                await TryRunCurrentOperationAsync(
                        context,
                        async () => await context.OutboundGate
                            .WaitAsync(context.Token).ConfigureAwait(false))
                    .ConfigureAwait(false);
            if (!gate.Started) return;
            try
            {
                CurrentOperationResult<bool> sent =
                    await TryRunCurrentOperationAsync(
                            context,
                            () => SendRecoveryTerminalAsync(context, plan))
                        .ConfigureAwait(false);
                if (!sent.Started) return;
            }
            finally
            {
                context.OutboundGate.Release();
            }
        }
    }

    private async Task SendRecoveryTerminalAsync(
        ConnectionCycleContext context,
        RbpRecoveryTerminalPlan plan)
    {
        if (!context.IsDispatchAllowed(plan.Rsid)) return;
        var claim = new RecoveryTerminalCycleKey(context,
            plan.RecoveryInvocationId, plan.FinalSequence, plan.PlanVersion);
        bool claimAcquired = false;
        if (!TryCommitCurrent(context, () =>
            {
                if (context.IsDispatchAllowed(plan.Rsid))
                    claimAcquired = TryAcquireRecoveryTerminalClaim(claim);
            }) || !claimAcquired)
            return;
        bool retainClaim = false;
        try
        {
            CurrentOperationResult<RbpRecoveryTerminalMaterializedFrame?> frame =
                await TryRunCurrentOperationAsync(
                        context,
                        () => _recoveryCarrierMaterializer
                            .MaterializeTerminalAsync(plan, context.Token))
                    .ConfigureAwait(false);
            if (!frame.Started) return;
            RbpRecoveryTerminalMaterializedFrame? materialized = frame.Value;
            if (materialized is null ||
                materialized.ReservedSequence != plan.FinalSequence ||
                materialized.PlanVersion != plan.PlanVersion ||
                !string.Equals(materialized.PayloadCommitment,
                    plan.PayloadCommitment, StringComparison.Ordinal) ||
                !string.Equals(materialized.PayloadDigest, plan.TerminalDigest,
                    StringComparison.Ordinal)) return;

            var snapshot = new RbpDataEnvelopeSnapshot(
                Type: materialized.Answer.Type,
                Id: plan.RecoveryInvocationId,
                Rsid: plan.Rsid,
                Sequence: materialized.ReservedSequence,
                Payload: materialized.Answer.Payload,
                Acknowledgement: plan.InboundAcknowledgementBaseline,
                Timestamp: DateTimeOffset
                    .FromUnixTimeMilliseconds(plan.CreatedAtMilliseconds)
                    .ToString("O", CultureInfo.InvariantCulture));
            RbpEnvelope envelope = CreateDataEnvelope(snapshot);
            byte[] outerBytes = RbpEnvelopeCodec.Encode(envelope);
            try
            {
                // This digest stays volatile. Persisting it would create a
                // second replay authority beside the v9 terminal commitment.
                string outerDigest = "sha256:" + Convert.ToHexString(
                    SHA256.HashData(outerBytes)).ToLowerInvariant();
                CurrentOperationResult<bool> materializedObserved =
                    await TryRunCurrentOperationAsync(
                            context,
                            () =>
                            {
                                ObserveRecoveryCarrier(
                                    context,
                                    RbpRecoveryCarrierObservationPhase
                                        .Materialized,
                                    plan.RecoveryInvocationId,
                                    plan.Rsid,
                                    plan.FinalSequence,
                                    plan.TerminalDigest);
                                return Task.FromResult(true);
                            })
                        .ConfigureAwait(false);
                if (!materializedObserved.Started) return;
                CurrentOperationResult<bool> confirmed =
                    await TryRunCurrentOperationAsync(
                            context,
                            () => _journal
                                .ConfirmRecoveryTerminalMaterializationAsync(
                                    plan.RecoveryInvocationId,
                                    plan.Rsid,
                                    materialized.PlanVersion,
                                    materialized.ReservedSequence,
                                    materialized.PayloadCommitment,
                                    context.Token))
                        .ConfigureAwait(false);
                if (!string.Equals(Rfc8785Json.Sha256Digest(
                        materialized.Answer.Payload), plan.TerminalDigest,
                        StringComparison.Ordinal) ||
                    string.IsNullOrEmpty(outerDigest) ||
                    !confirmed.Started || !confirmed.Value ||
                    !context.IsDispatchAllowed(plan.Rsid)) return;

                bool restartResend = false;
                CurrentOperationResult<bool> deliveryMarked =
                    await TryRunCurrentOperationAsync(
                            context,
                            () =>
                            {
                                retainClaim = true;
                                restartResend =
                                    !TryMarkRecoveryTerminalDelivery(
                                        plan.Rsid,
                                        plan.RecoveryInvocationId,
                                        plan.FinalSequence);
                                ObserveRecoveryCarrier(
                                    context,
                                    restartResend
                                        ? RbpRecoveryCarrierObservationPhase
                                            .RestartResend
                                        : RbpRecoveryCarrierObservationPhase
                                            .Write,
                                    plan.RecoveryInvocationId,
                                    plan.Rsid,
                                    plan.FinalSequence,
                                    plan.TerminalDigest);
                                return Task.FromResult(true);
                            })
                        .ConfigureAwait(false);
                if (!deliveryMarked.Started) return;
                if (_beforeRecoveryTerminalWrite is { } beforeTerminalWrite)
                {
                    CurrentOperationResult<bool> callback =
                        await TryRunCurrentOperationAsync(
                                context,
                                () => beforeTerminalWrite(context.Token))
                            .ConfigureAwait(false);
                    if (!callback.Started) return;
                }
                RecoveryCarrierAckGateKey? ackGate =
                    _afterRecoveryCarrierWriteBeforeAck is null ? null :
                    new RecoveryCarrierAckGateKey(context, plan.Rsid,
                        plan.RecoveryInvocationId, plan.FinalSequence,
                        plan.AcknowledgementBaseline);
                if (ackGate is not null)
                {
                    CurrentOperationResult<bool> gateInstalled =
                        await TryRunCurrentOperationAsync(
                                context,
                                () =>
                                {
                                    InstallRecoveryCarrierAckGate(ackGate);
                                    return Task.FromResult(true);
                                })
                            .ConfigureAwait(false);
                    if (!gateInstalled.Started) return;
                }
                bool postWriteCallbackReturned = false;
                try
                {
                    bool sent = await SendCurrentPreparedAsync(
                            context, envelope, plan.Rsid)
                        .ConfigureAwait(false);
                    if (!sent) return;
                    if (_afterRecoveryCarrierWriteBeforeAck is { } afterWrite)
                    {
                        CurrentOperationResult<bool> callback =
                            await TryRunCurrentOperationAsync(
                                    context,
                                    () => afterWrite(context.Token))
                                .ConfigureAwait(false);
                        if (!callback.Started) return;
                        postWriteCallbackReturned = true;
                    }
                }
                finally
                {
                    if (ackGate is not null &&
                        (_afterRecoveryCarrierWriteBeforeAck is null ||
                         postWriteCallbackReturned))
                        RemoveRecoveryCarrierAckGate(ackGate);
                }
            }
            finally
            {
                CryptographicOperations.ZeroMemory(outerBytes);
            }
        }
        finally
        {
            if (!retainClaim)
            {
                ReleaseRecoveryTerminalClaim(claim);
            }
        }
    }

    private bool TryAcquireRecoveryCarrierClaim(RecoveryCarrierCycleKey claim)
    {
        lock (_recoveryCarrierClaimSync)
        {
            return _recoveryCarrierClaims.Add(claim);
        }
    }

    private void ReleaseRecoveryCarrierClaim(RecoveryCarrierCycleKey claim)
    {
        lock (_recoveryCarrierClaimSync)
        {
            _recoveryCarrierClaims.Remove(claim);
        }
    }

    private void ReleaseRecoveryCarrierClaims(
        ConnectionCycleContext context,
        string rsid,
        string recoveryInvocationId,
        long throughSequence)
    {
        lock (_recoveryCarrierClaimSync)
        {
            _recoveryCarrierClaims.RemoveWhere(claim =>
                ReferenceEquals(claim.Context, context) &&
                string.Equals(claim.RecoveryInvocationId, recoveryInvocationId,
                    StringComparison.Ordinal) &&
                claim.ReservedSequence <= throughSequence);
            RemoveRecoveryCarrierOuterDigests(
                recoveryInvocationId, throughSequence);
        }
    }

    private void ClearRecoveryCarrierClaims(ConnectionCycleContext context)
    {
        lock (_recoveryCarrierClaimSync)
        {
            _recoveryCarrierClaims.RemoveWhere(claim =>
                ReferenceEquals(claim.Context, context));
            _recoveryCarrierAckGates.RemoveWhere(gate =>
                ReferenceEquals(gate.Context, context));
            _recoveryTerminalClaims.RemoveWhere(claim =>
                ReferenceEquals(claim.Context, context));
            // Do not clear the digest here: a resume receipt may arrive on
            // the next connection cycle. It is consumed by acknowledgement,
            // or removed with the related recovery claim/tombstone.
        }
    }

    private bool TryMarkRecoveryTerminalDelivery(
        string rsid, string recoveryInvocationId, long sequence)
    {
        lock (_recoveryCarrierClaimSync)
        {
            return _recoveryTerminalDeliveries.Add(
                new RecoveryTerminalDeliveryKey(rsid, recoveryInvocationId,
                    sequence));
        }
    }

    private void InstallRecoveryCarrierAckGate(RecoveryCarrierAckGateKey gate)
    {
        lock (_recoveryCarrierClaimSync) _recoveryCarrierAckGates.Add(gate);
    }

    private void RemoveRecoveryCarrierAckGate(RecoveryCarrierAckGateKey gate)
    {
        lock (_recoveryCarrierClaimSync) _recoveryCarrierAckGates.Remove(gate);
    }

    private bool TryDropGatedRecoveryCarrierAcknowledgement(
        ConnectionCycleContext context, RbpSessionAcknowledgement acknowledgement,
        out long cursor)
    {
        lock (_recoveryCarrierClaimSync)
        {
            RecoveryCarrierAckGateKey? gate = _recoveryCarrierAckGates.FirstOrDefault(
                item => ReferenceEquals(item.Context, context) &&
                    string.Equals(item.Rsid, acknowledgement.Rsid,
                        StringComparison.Ordinal) &&
                    item.Sequence == acknowledgement.Sequence);
            cursor = gate?.AcknowledgementCursor ?? acknowledgement.Sequence;
            return gate is not null;
        }
    }

    private void ObserveRecoveryCarrier(
        ConnectionCycleContext context,
        RbpRecoveryCarrierObservationPhase phase,
        RbpRecoveryCarrierReservation reservation,
        string outerDigest)
        => ObserveRecoveryCarrier(context, phase,
            reservation.RecoveryInvocationId,
            reservation.Rsid, reservation.CurrentReservedSequence, outerDigest);

    private void ObserveRecoveryCarrier(
        ConnectionCycleContext context,
        RbpRecoveryCarrierObservationPhase phase,
        string recoveryInvocationId,
        string rsid,
        long sequence,
        string outerDigest)
    {
        try
        {
            var key = new RecoveryCarrierDigestKey(recoveryInvocationId,
                sequence);
            lock (_recoveryCarrierClaimSync)
            {
                if (_recoveryCarrierOuterDigests.TryGetValue(key,
                        out string? prior) &&
                    !string.Equals(prior, outerDigest,
                        StringComparison.Ordinal))
                {
                    // A resend with different bytes is not acknowledgement
                    // evidence. Suppress any later false positive.
                    _recoveryCarrierOuterDigests.Remove(key);
                    return;
                }
                _recoveryCarrierOuterDigests[key] = outerDigest;
            }
            long ordinal = Interlocked.Increment(ref _recoveryCarrierObservationOrdinal);
            long causalOrdinal = NextC39CausalOrdinal();
            _recoveryCarrierObservationSink.Observe(
                new RbpRecoveryCarrierObservation(phase,
                    RbpRecoveryCarrierObservation.HashRecoveryId(
                        recoveryInvocationId), sequence, outerDigest, ordinal,
                    RouteAuthorityCheckpoint: GetRouteAuthorityCheckpoint(context, rsid),
                    ConnectionDigest: RbpRouteRebindProof.MakeConnectionDigest(rsid, context.Cycle.Acknowledgement.ConnectionId),
                    RouteRebindProofGranted: context.GrantedConnectionCapabilities.Contains(RbpHelloProfile.RouteRebindProofCapability, StringComparer.Ordinal),
                    CausalOrdinal: causalOrdinal));
        }
        catch
        {
            // Observation is not a transport or durability authority.
        }
    }

    private void ObserveRecoveryCarrierAcknowledgement(
        ConnectionCycleContext context,
        RbpRecoveryCarrierReservation reservation,
        long acknowledgedSequence)
        => ObserveRecoveryCarrierAcknowledgement(context,
            reservation.RecoveryInvocationId, reservation.Rsid, acknowledgedSequence);

    private void ObserveRecoveryCarrierAcknowledgement(
        ConnectionCycleContext context,
        string recoveryInvocationId,
        string rsid,
        long acknowledgedSequence)
    {
        try
        {
            string? outerDigest;
            lock (_recoveryCarrierClaimSync)
            {
                var key = new RecoveryCarrierDigestKey(recoveryInvocationId,
                    acknowledgedSequence);
                _recoveryCarrierOuterDigests.TryGetValue(key, out outerDigest);
                _recoveryCarrierOuterDigests.Remove(key);
            }
            if (outerDigest is null) return;
            long ordinal = Interlocked.Increment(ref _recoveryCarrierObservationOrdinal);
            _recoveryCarrierObservationSink.Observe(
                new RbpRecoveryCarrierObservation(
                    RbpRecoveryCarrierObservationPhase.Acknowledged,
                    RbpRecoveryCarrierObservation.HashRecoveryId(
                        recoveryInvocationId),
                    acknowledgedSequence, outerDigest, ordinal,
                    RouteAuthorityCheckpoint: GetRouteAuthorityCheckpoint(context, rsid),
                    ConnectionDigest: RbpRouteRebindProof.MakeConnectionDigest(rsid, context.Cycle.Acknowledgement.ConnectionId),
                    RouteRebindProofGranted: context.GrantedConnectionCapabilities.Contains(RbpHelloProfile.RouteRebindProofCapability, StringComparer.Ordinal),
                    CausalOrdinal: NextC39CausalOrdinal()));
        }
        catch
        {
            // An observer cannot affect acknowledgement application.
        }
    }

    /// <summary>
    /// A confirmed v9 terminal is the only durable authority for a terminal
    /// acknowledgement observation. The volatile cache can corroborate the
    /// exact value but must never be required after a reconnect or restart.
    /// </summary>
    private void ObserveRecoveryTerminalAcknowledgement(
        ConnectionCycleContext context, RbpRecoveryTerminalPlan terminal)
    {
        _ = context;
        try
        {
            if (!RbpJournalSerialization.IsSha256Digest(terminal.TerminalDigest))
            {
                return;
            }
            var key = new RecoveryCarrierDigestKey(
                terminal.RecoveryInvocationId, terminal.FinalSequence);
            lock (_recoveryCarrierClaimSync)
            {
                if (_recoveryCarrierOuterDigests.TryGetValue(key,
                        out string? cached) &&
                    !string.Equals(cached, terminal.TerminalDigest,
                        StringComparison.Ordinal))
                {
                    _recoveryCarrierOuterDigests.Remove(key);
                    return;
                }
                _recoveryCarrierOuterDigests.Remove(key);
            }
            long ordinal = Interlocked.Increment(ref _recoveryCarrierObservationOrdinal);
            _recoveryCarrierObservationSink.Observe(
                new RbpRecoveryCarrierObservation(
                    RbpRecoveryCarrierObservationPhase.Acknowledged,
                    RbpRecoveryCarrierObservation.HashRecoveryId(
                        terminal.RecoveryInvocationId),
                    terminal.FinalSequence, terminal.TerminalDigest, ordinal,
                    RouteAuthorityCheckpoint: GetRouteAuthorityCheckpoint(context, terminal.Rsid),
                    ConnectionDigest: RbpRouteRebindProof.MakeConnectionDigest(terminal.Rsid, context.Cycle.Acknowledgement.ConnectionId),
                    RouteRebindProofGranted: context.GrantedConnectionCapabilities.Contains(RbpHelloProfile.RouteRebindProofCapability, StringComparer.Ordinal),
                    CausalOrdinal: NextC39CausalOrdinal()));
        }
        catch
        {
            // Observation is not a transport or durability authority.
        }
    }

    private bool TryAcquireRecoveryTerminalClaim(RecoveryTerminalCycleKey claim)
    {
        lock (_recoveryCarrierClaimSync)
        {
            return _recoveryTerminalClaims.Add(claim);
        }
    }

    private void ReleaseRecoveryTerminalClaim(RecoveryTerminalCycleKey claim)
    {
        lock (_recoveryCarrierClaimSync)
        {
            _recoveryTerminalClaims.Remove(claim);
        }
    }

    private void ReleaseRecoveryTerminalClaims(
        ConnectionCycleContext context,
        string rsid,
        string recoveryInvocationId,
        long throughSequence)
    {
        lock (_recoveryCarrierClaimSync)
        {
            _recoveryTerminalClaims.RemoveWhere(claim =>
                ReferenceEquals(claim.Context, context) &&
                string.Equals(claim.RecoveryInvocationId, recoveryInvocationId,
                    StringComparison.Ordinal) &&
                    claim.ReservedSequence <= throughSequence);
            RemoveRecoveryCarrierOuterDigests(
                recoveryInvocationId, throughSequence);
        }
    }

    private void RemoveRecoveryCarrierOuterDigests(
        string recoveryInvocationId, long throughSequence)
    {
        _recoveryCarrierOuterDigests.Keys
            .Where(key => string.Equals(key.RecoveryInvocationId,
                recoveryInvocationId, StringComparison.Ordinal) &&
                key.Sequence <= throughSequence)
            .ToList()
            .ForEach(key => _recoveryCarrierOuterDigests.Remove(key));
    }

    private void ClearAllRecoveryCarrierOuterDigests()
    {
        lock (_recoveryCarrierClaimSync)
        {
            _recoveryCarrierOuterDigests.Clear();
        }
    }

    private sealed record RecoveryCarrierCycleKey(
        ConnectionCycleContext Context,
        string RecoveryInvocationId,
        long ReservedSequence,
        int PlanVersion);

    private sealed record RecoveryCarrierAckGateKey(
        ConnectionCycleContext Context, string Rsid, string RecoveryInvocationId,
        long Sequence, long AcknowledgementCursor);

    private sealed record RecoveryTerminalDeliveryKey(
        string Rsid, string RecoveryInvocationId, long Sequence);

    private sealed record RecoveryTerminalCycleKey(
        ConnectionCycleContext Context,
        string RecoveryInvocationId,
        long ReservedSequence,
        int PlanVersion);

    private sealed record RecoveryCarrierDigestKey(
        string RecoveryInvocationId,
        long Sequence);
}
