using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed partial class RbpConnectionCoordinator
{
    private async Task ReceiveLoopAsync(ConnectionCycleContext context)
    {
        try
        {
            while (!context.Token.IsCancellationRequested)
            {
                RbpEnvelope envelope =
                    await context.Cycle.ReceiveAsync(context.Token)
                        .ConfigureAwait(false);
                if (!IsCurrentContext(context))
                {
                    return;
                }

                switch (envelope.Scope)
                {
                    case RbpEnvelopeScope.Control:
                        await HandleControlEnvelopeAsync(context, envelope)
                            .ConfigureAwait(false);
                        break;
                    case RbpEnvelopeScope.Data:
                        await HandleDataEnvelopeAsync(context, envelope)
                            .ConfigureAwait(false);
                        break;
                    default:
                        throw new RbpCoordinatorException(
                            RbpCoordinatorErrorCode.UnexpectedControl,
                            "A negotiated connection returned a " +
                            "pre-negotiation envelope.");
                }
            }
        }
        catch (OperationCanceledException)
            when (context.Token.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            context.FailPending(exception);
            context.Cancel();
            throw;
        }
    }

    private async Task HandleControlEnvelopeAsync(
        ConnectionCycleContext context,
        RbpEnvelope envelope)
    {
        switch (envelope.Type)
        {
            case "session_registered":
                await context.DeliverRegistrationAsync(envelope)
                    .ConfigureAwait(false);
                return;
            case "resume_ack":
                await context.DeliverResumeAsync(
                        RequiredString(
                            envelope.Payload,
                            "rsid",
                            maximumLength: 256),
                        envelope)
                    .ConfigureAwait(false);
                return;
            case "heartbeat_ack":
                await ApplyHeartbeatAcknowledgementAsync(context, envelope)
                    .ConfigureAwait(false);
                return;
            case "goodbye":
                throw ParseGoodbye(
                    envelope,
                    context.ContinuousSteadyMilliseconds);
            default:
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.UnexpectedControl,
                    $"Unexpected RBP control message '{envelope.Type}'.");
        }
    }

    private async Task HandleDataEnvelopeAsync(
        ConnectionCycleContext context,
        RbpEnvelope envelope)
    {
        if (envelope.Rsid is not { } rsid ||
            envelope.Sequence is not { } sequence ||
            !context.IsDispatchAllowed(rsid))
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.SessionAuthorityConflict,
                "Inbound RBP data targets a session that is not bound to " +
                "the current connection.");
        }

        var snapshot = new RbpDataEnvelopeSnapshot(
            envelope.Type,
            envelope.Id,
            rsid,
            sequence,
            envelope.Payload,
            envelope.Acknowledgement,
            envelope.Timestamp,
            envelope.Version ?? 1);
        RbpInboundDataResult accepted =
            await _journal.AcceptInboundDataAsync(snapshot, context.Token)
                .ConfigureAwait(false);
        if (accepted.Kind is RbpInboundDataKind.Gap or
            RbpInboundDataKind.ProtocolFault)
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.SequenceFault,
                "Inbound RBP sequence authority rejected the data envelope.");
        }

        if (accepted.Kind == RbpInboundDataKind.Accepted)
        {
            await JournalAcceptedInboundAsync(snapshot, context.Token)
                .ConfigureAwait(false);
        }
    }

    private async Task FlushPendingRetransmitAsync(
        ConnectionCycleContext context)
    {
        foreach (RbpDataEnvelopeSnapshot retransmit in
                 context.GetPendingRetransmit())
        {
            await context.Cycle.SendAsync(
                    CreateDataEnvelope(retransmit),
                    context.Token)
                .ConfigureAwait(false);
        }

        context.ClearPendingRetransmit();
    }

    private async Task HeartbeatLoopAsync(ConnectionCycleContext context)
    {
        long priorTick = _clock.MonotonicMilliseconds;
        while (!context.Token.IsCancellationRequested)
        {
            await _clock.DelayAsync(
                    TimeSpan.FromMilliseconds(
                        context.Cycle.Acknowledgement
                            .HeartbeatIntervalMilliseconds),
                    context.Token)
                .ConfigureAwait(false);
            long currentTick = _clock.MonotonicMilliseconds;
            long gap = currentTick - priorTick;
            if (gap < 0 ||
                gap >= _options.EffectiveWakeGapThreshold.TotalMilliseconds)
            {
                throw new RbpWakeGapException(
                    Math.Max(0, priorTick - context.SteadyStartedMilliseconds));
            }

            priorTick = currentTick;
            await ReconcileCurrentCatalogAsync(context).ConfigureAwait(false);
            await SendHeartbeatAsync(context).ConfigureAwait(false);
        }
    }

    private async Task SendHeartbeatAsync(ConnectionCycleContext context)
    {
        IReadOnlyList<BoundSession> sessions = context.GetBoundSessions();
        IReadOnlyList<string> activeRsids = sessions
            .Where(item => item.Lifecycle.DispatchAllowed)
            .Select(item => item.Stored.Rsid)
            .Order(StringComparer.Ordinal)
            .ToArray();
        IReadOnlyList<RbpSessionAcknowledgement> acknowledgements =
            await _journal.LoadJournaledAcknowledgementsAsync(
                    activeRsids,
                    context.Token)
                .ConfigureAwait(false);
        IReadOnlyList<string> tombstones =
            context.GetSentUnregisterRsids();
        var fence = new RbpHeartbeatFence(
            context.Generation,
            activeRsids,
            acknowledgements,
            tombstones);
        Task heartbeatAcknowledged = context.InstallHeartbeatFlight(fence);

        JsonElement payload = CreateHeartbeatPayload(
            sessions,
            acknowledgements);
        try
        {
            await context.Cycle.SendAsync(
                    CreateControlEnvelope("heartbeat", payload),
                    context.Token)
                .ConfigureAwait(false);
        }
        catch
        {
            context.RollbackHeartbeatFlight(fence);
            throw;
        }

        using var deadlineCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(context.Token);
        Task deadline = _clock.DelayAsync(
            _options.EffectiveHeartbeatAcknowledgementTimeout,
            deadlineCancellation.Token);
        Task completed = await Task.WhenAny(
                heartbeatAcknowledged,
                deadline)
            .ConfigureAwait(false);
        if (ReferenceEquals(completed, deadline))
        {
            context.RollbackHeartbeatFlight(fence);
            context.Token.ThrowIfCancellationRequested();
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.HeartbeatTimeout,
                "The Gateway did not acknowledge the heartbeat within " +
                "10 seconds.");
        }

        deadlineCancellation.Cancel();
        await heartbeatAcknowledged.ConfigureAwait(false);
    }

    private async Task ApplyHeartbeatAcknowledgementAsync(
        ConnectionCycleContext context,
        RbpEnvelope envelope)
    {
        if (!IsCurrentContext(context))
        {
            return;
        }

        HeartbeatFlight? flight = context.ConsumeHeartbeatFlight();
        if (flight is null)
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.UnexpectedControl,
                "An unsolicited heartbeat_ack cannot finalize connection " +
                "state.");
        }

        IReadOnlyList<RbpSessionAcknowledgement> acknowledgements =
            ParseHeartbeatAcknowledgements(envelope);
        RbpHeartbeatFence fence = flight.Fence with
        {
            Acknowledgements = acknowledgements,
        };
        try
        {
            RbpHeartbeatFenceResult applied =
                await _journal.ApplyHeartbeatFenceAcknowledgementAsync(
                        fence,
                        context.Token)
                    .ConfigureAwait(false);
            foreach (string rsid in applied.ConfirmedUnregisterRsids)
            {
                context.MarkUnregisterConfirmed(rsid);
                _ = await _journal.CompleteConfirmedUnregisterAsync(
                        rsid,
                        context.Token)
                    .ConfigureAwait(false);
            }

            flight.Completion.TrySetResult();
        }
        catch (Exception exception)
        {
            flight.Completion.TrySetException(exception);
            throw;
        }
    }

    private async Task RecoverPendingInboundHandoffsAsync(
        IReadOnlyList<RbpPendingInboundHandoff> pending,
        CancellationToken cancellationToken)
    {
        foreach (RbpPendingInboundHandoff handoff in pending
                     .OrderBy(item => item.Rsid, StringComparer.Ordinal)
                     .ThenBy(item => item.Envelope.Sequence))
        {
            await JournalAcceptedInboundAsync(
                    handoff.Envelope,
                    cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private async Task JournalAcceptedInboundAsync(
        RbpDataEnvelopeSnapshot envelope,
        CancellationToken cancellationToken)
    {
        string immutableDigest =
            Rfc8785Json.ImmutableEnvelopeDigest(envelope);
        long now = _clock.UtcNow.ToUnixTimeMilliseconds();
        await _journal.ExecuteImmediateAsync(
                context =>
                {
                    RbpInboundJournalReceipt receipt =
                        _inboundJournal.Journal(context, envelope);
                    context.MarkInboundJournaled(
                        envelope.Rsid,
                        envelope.Sequence,
                        envelope.Id,
                        immutableDigest,
                        receipt.CorrelationId,
                        receipt.ContextJson,
                        now);
                    return true;
                },
                cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task CompleteConfirmedCleanupAsync(
        IReadOnlyList<RbpUnregisterTombstone> confirmed,
        CancellationToken cancellationToken)
    {
        foreach (RbpUnregisterTombstone tombstone in confirmed.OrderBy(
                     item => item.Rsid,
                     StringComparer.Ordinal))
        {
            _ = await _journal.CompleteConfirmedUnregisterAsync(
                    tombstone.Rsid,
                    cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private async Task TryRecordShutdownUnregistersAsync(
        ConnectionCycleContext context)
    {
        using var timeout = new CancellationTokenSource(
            _options.EffectiveCloseTimeout);
        foreach (BoundSession session in context.GetBoundSessions())
        {
            try
            {
                RbpUnregisterTombstone tombstone =
                    await _journal.RecordUnregisterIntentAsync(
                            session.Stored.Rsid,
                            RbpSessionUnregisterReason.BridgeShutdown,
                            timeout.Token)
                        .ConfigureAwait(false);
                context.RevokeBoundSession(
                    session.Stored.Rsid,
                    RbpSessionUnregisterReason.BridgeShutdown);
                await context.Cycle.SendAsync(
                        CreateControlEnvelope(
                            "session_unregister",
                            JsonObject(
                                ("rsid", tombstone.Rsid),
                                ("reason", "bridge_shutdown"))),
                        timeout.Token)
                    .ConfigureAwait(false);
            }
            catch (Exception exception)
                when (exception is OperationCanceledException or
                      RbpGatewayTransportException or
                      RbpJournalException)
            {
                return;
            }
        }
    }

}
