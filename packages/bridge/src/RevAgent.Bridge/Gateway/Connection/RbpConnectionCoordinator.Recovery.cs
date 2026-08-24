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

        RbpRecoveryCarrierReservation started = await _journal
            .MarkRecoveryCarrierSendStartedAsync(
                reservation.RecoveryInvocationId,
                context.Token)
            .ConfigureAwait(false);
        if (started.Phase != RbpRecoveryCarrierPhase.SendStarted ||
            !string.Equals(started.Rsid, reservation.Rsid,
                StringComparison.Ordinal)) return;

        var claim = new RecoveryCarrierCycleKey(
            context,
            started.RecoveryInvocationId,
            started.CurrentReservedSequence,
            started.PlanVersion);
        if (!TryAcquireRecoveryCarrierClaim(claim)) return;
        bool retainClaim = false;
        try
        {

            RbpRecoveryCarrierMaterializedFrame? materialized =
                await _recoveryCarrierMaterializer.MaterializeCurrentAsync(
                        started.RecoveryInvocationId,
                        started.Rsid,
                        context.Token)
                    .ConfigureAwait(false);
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
                Acknowledgement: started.AcknowledgementCursor,
                Timestamp: DateTimeOffset
                    .FromUnixTimeMilliseconds(started.CreatedAtMilliseconds)
                    .ToString("O", CultureInfo.InvariantCulture));
            RbpEnvelope envelope = CreateDataEnvelope(snapshot);
            byte[] outerBytes = RbpEnvelopeCodec.Encode(envelope);
            try
            {
                string outerDigest = "sha256:" + Convert.ToHexString(
                    SHA256.HashData(outerBytes)).ToLowerInvariant();
                ObserveRecoveryCarrier(context,
                    RbpRecoveryCarrierObservationPhase.Materialized, started,
                    outerDigest);
                bool confirmed = await _journal
                    .ConfirmRecoveryCarrierMaterializationAsync(
                        started.RecoveryInvocationId,
                        started.Rsid,
                        started.PlanVersion,
                        materialized.ReservedSequence,
                        materialized.PayloadDigest,
                        outerDigest,
                        context.Token)
                    .ConfigureAwait(false);
                if (!confirmed || !context.IsDispatchAllowed(started.Rsid)) return;
                // Test-only crash seam.  Production composition leaves this
                // null.  Once final confirmation succeeded, retain the claim
                // until this cycle closes even if the seam aborts before any
                // socket byte can be emitted.
                retainClaim = true;
                ObserveRecoveryCarrier(context,
                    restartResend
                        ? RbpRecoveryCarrierObservationPhase.RestartResend
                        : RbpRecoveryCarrierObservationPhase.Write, started,
                    outerDigest);
                if (_beforeRecoveryCarrierWrite is { } beforeWrite)
                {
                    await beforeWrite(context.Token).ConfigureAwait(false);
                }

                // The only recovery-carrier socket write.  Do not route through
                // QueueOutboundDataAsync, generic outbox/spool, or diagnostics.
            await context.Cycle.SendAsync(envelope, context.Token)
                .ConfigureAwait(false);
            if (_afterRecoveryCarrierWriteBeforeAck is { } afterWrite)
            {
                await afterWrite(context.Token).ConfigureAwait(false);
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
            RbpRecoveryCarrierReservation? applied = await _journal
                .ApplyRecoveryCarrierFenceAcknowledgementAsync(
                    acknowledgement.Rsid,
                    acknowledgement.Sequence,
                    context.Token)
                .ConfigureAwait(false);
            if (applied?.Phase == RbpRecoveryCarrierPhase.Tombstoned)
            {
                ReleaseRecoveryCarrierClaims(context, acknowledgement.Rsid,
                    applied.RecoveryInvocationId, long.MaxValue);
                // The journal has durably blocked this RSID.  Abort the
                // transport before generic acknowledgement can advance across
                // the fault; normal reconnect lifecycle owns its close path.
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.UnexpectedControl,
                    "Recovery carrier acknowledgement violated its durable fence.");
            }
            if (applied is { Phase: RbpRecoveryCarrierPhase.Completed or
                RbpRecoveryCarrierPhase.Reserved })
            {
                ObserveRecoveryCarrierAcknowledgement(context, applied,
                    acknowledgement.Sequence);
                ReleaseRecoveryCarrierClaims(context, acknowledgement.Rsid,
                    applied.RecoveryInvocationId, acknowledgement.Sequence);
            }
            if (applied?.Phase == RbpRecoveryCarrierPhase.Completed)
            {
                // The final partial receipt opens exactly one v9 terminal
                // plan. Reservation is idempotent, so a duplicate heartbeat
                // cannot allocate a second terminal sequence.
                _ = await _journal.ReserveRecoveryTerminalAsync(
                        applied.RecoveryInvocationId, applied.Rsid,
                        context.Token)
                    .ConfigureAwait(false);
            }
        }
    }

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
            RbpRecoveryTerminalPlan? applied = await _journal
                .ApplyRecoveryTerminalAcknowledgementAsync(
                    acknowledgement.Rsid, acknowledgement.Sequence,
                    gatewayDeliveryReceiptRecorded: true,
                    sourceReleaseEligible: true, context.Token)
                .ConfigureAwait(false);
            if (applied?.State == "tombstoned")
            {
                ReleaseRecoveryTerminalClaims(context, acknowledgement.Rsid,
                    applied.RecoveryInvocationId, long.MaxValue);
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.UnexpectedControl,
                    "Recovery terminal acknowledgement violated its durable fence.");
            }
            if (applied?.State == "confirmed")
            {
                ObserveRecoveryCarrierAcknowledgement(context,
                    applied.RecoveryInvocationId, applied.FinalSequence);
                ReleaseRecoveryTerminalClaims(context, acknowledgement.Rsid,
                    applied.RecoveryInvocationId, acknowledgement.Sequence);
            }
        }
    }

    private async Task ScheduleActiveRecoveryCarriersAsync(
        ConnectionCycleContext context)
    {
        IReadOnlyList<RbpRecoveryCarrierReservation> active = await _journal
            .ListActiveRecoveryCarrierReservationsAsync(context.Token)
            .ConfigureAwait(false);
        foreach (RbpRecoveryCarrierReservation reservation in active
                     .OrderBy(value => value.Rsid, StringComparer.Ordinal)
                     .ThenBy(value => value.CurrentReservedSequence))
        {
            if (!context.IsDispatchAllowed(reservation.Rsid)) continue;
            await context.OutboundGate.WaitAsync(context.Token)
                .ConfigureAwait(false);
            try
            {
                await SendRecoveryCarrierAsync(context, reservation)
                    .ConfigureAwait(false);
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
        IReadOnlyList<RbpRecoveryTerminalPlan> active = await _journal
            .ListActiveRecoveryTerminalPlansAsync(context.Token)
            .ConfigureAwait(false);
        foreach (RbpRecoveryTerminalPlan plan in active
                     .OrderBy(value => value.Rsid, StringComparer.Ordinal)
                     .ThenBy(value => value.FinalSequence))
        {
            if (!context.IsDispatchAllowed(plan.Rsid)) continue;
            await context.OutboundGate.WaitAsync(context.Token)
                .ConfigureAwait(false);
            try
            {
                await SendRecoveryTerminalAsync(context, plan)
                    .ConfigureAwait(false);
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
        if (!TryAcquireRecoveryTerminalClaim(claim)) return;
        bool retainClaim = false;
        try
        {
            RbpRecoveryTerminalMaterializedFrame? materialized = await
                _recoveryCarrierMaterializer.MaterializeTerminalAsync(
                    plan, context.Token).ConfigureAwait(false);
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
                Acknowledgement: plan.AcknowledgementBaseline,
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
                ObserveRecoveryCarrier(context,
                    RbpRecoveryCarrierObservationPhase.Materialized,
                    plan.RecoveryInvocationId, plan.FinalSequence, outerDigest);
                if (!string.Equals(Rfc8785Json.Sha256Digest(
                        materialized.Answer.Payload), plan.TerminalDigest,
                        StringComparison.Ordinal) ||
                    string.IsNullOrEmpty(outerDigest) ||
                    !await _journal.ConfirmRecoveryTerminalMaterializationAsync(
                        plan.RecoveryInvocationId, plan.Rsid,
                        materialized.PlanVersion,
                        materialized.ReservedSequence,
                        materialized.PayloadCommitment, context.Token)
                        .ConfigureAwait(false) ||
                    !context.IsDispatchAllowed(plan.Rsid)) return;

                retainClaim = true;
                ObserveRecoveryCarrier(context,
                    RbpRecoveryCarrierObservationPhase.Write,
                    plan.RecoveryInvocationId, plan.FinalSequence, outerDigest);
                await context.Cycle.SendAsync(envelope, context.Token)
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
        }
    }

    private void ClearRecoveryCarrierClaims(ConnectionCycleContext context)
    {
        lock (_recoveryCarrierClaimSync)
        {
            _recoveryCarrierClaims.RemoveWhere(claim =>
                ReferenceEquals(claim.Context, context));
            _recoveryTerminalClaims.RemoveWhere(claim =>
                ReferenceEquals(claim.Context, context));
            _recoveryCarrierOuterDigests.Keys
                .Where(key => ReferenceEquals(key.Context, context))
                .ToList()
                .ForEach(key => _recoveryCarrierOuterDigests.Remove(key));
        }
    }

    private void ObserveRecoveryCarrier(
        ConnectionCycleContext context,
        RbpRecoveryCarrierObservationPhase phase,
        RbpRecoveryCarrierReservation reservation,
        string outerDigest)
        => ObserveRecoveryCarrier(context, phase,
            reservation.RecoveryInvocationId,
            reservation.CurrentReservedSequence, outerDigest);

    private void ObserveRecoveryCarrier(
        ConnectionCycleContext context,
        RbpRecoveryCarrierObservationPhase phase,
        string recoveryInvocationId,
        long sequence,
        string outerDigest)
    {
        try
        {
            var key = new RecoveryCarrierDigestCycleKey(context,
                recoveryInvocationId, sequence);
            lock (_recoveryCarrierClaimSync)
            {
                _recoveryCarrierOuterDigests[key] = outerDigest;
            }
            long ordinal = Interlocked.Increment(
                ref _recoveryCarrierObservationOrdinal);
            _recoveryCarrierObservationSink.Observe(
                new RbpRecoveryCarrierObservation(phase,
                    RbpRecoveryCarrierObservation.HashRecoveryId(
                        recoveryInvocationId), sequence, outerDigest, ordinal));
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
            reservation.RecoveryInvocationId, acknowledgedSequence);

    private void ObserveRecoveryCarrierAcknowledgement(
        ConnectionCycleContext context,
        string recoveryInvocationId,
        long acknowledgedSequence)
    {
        try
        {
            string? outerDigest;
            lock (_recoveryCarrierClaimSync)
            {
                var key = new RecoveryCarrierDigestCycleKey(context,
                    recoveryInvocationId, acknowledgedSequence);
                _recoveryCarrierOuterDigests.TryGetValue(key, out outerDigest);
                _recoveryCarrierOuterDigests.Remove(key);
            }
            if (outerDigest is null) return;
            long ordinal = Interlocked.Increment(
                ref _recoveryCarrierObservationOrdinal);
            _recoveryCarrierObservationSink.Observe(
                new RbpRecoveryCarrierObservation(
                    RbpRecoveryCarrierObservationPhase.Acknowledged,
                    RbpRecoveryCarrierObservation.HashRecoveryId(
                        recoveryInvocationId),
                    acknowledgedSequence, outerDigest, ordinal));
        }
        catch
        {
            // An observer cannot affect acknowledgement application.
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
        }
    }

    private sealed record RecoveryCarrierCycleKey(
        ConnectionCycleContext Context,
        string RecoveryInvocationId,
        long ReservedSequence,
        int PlanVersion);

    private sealed record RecoveryTerminalCycleKey(
        ConnectionCycleContext Context,
        string RecoveryInvocationId,
        long ReservedSequence,
        int PlanVersion);

    private sealed record RecoveryCarrierDigestCycleKey(
        ConnectionCycleContext Context,
        string RecoveryInvocationId,
        long Sequence);
}
