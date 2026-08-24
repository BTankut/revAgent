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
                if (_beforeRecoveryCarrierWrite is { } beforeWrite)
                {
                    await beforeWrite(context.Token).ConfigureAwait(false);
                }

                // The only recovery-carrier socket write.  Do not route through
                // QueueOutboundDataAsync, generic outbox/spool, or diagnostics.
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
                ReleaseRecoveryCarrierClaims(context, acknowledgement.Rsid,
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
        }
    }

    private sealed record RecoveryCarrierCycleKey(
        ConnectionCycleContext Context,
        string RecoveryInvocationId,
        long ReservedSequence,
        int PlanVersion);
}
