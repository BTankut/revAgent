using System.Collections.ObjectModel;
using System.Globalization;
using System.Runtime.ExceptionServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using RevAgent.Bridge.Gateway.Dispatch;
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

        if (accepted.Kind != RbpInboundDataKind.Accepted)
        {
            // A duplicate the sequence authority already answered. Re-running
            // the invocation would be a second delivery of the same frame, and
            // Section 12.2 arbitrates redelivery on the invocation key, not on
            // the transport sequence.
            return;
        }

        await JournalAcceptedInboundAsync(snapshot, context.Token)
            .ConfigureAwait(false);

        if (string.Equals(snapshot.Type, "invoke", StringComparison.Ordinal))
        {
            // Synchronous: claims the Section 10.1 window in arrival order and
            // starts a detached task. The receive loop must never await the
            // add-in, or a Section 16 cancel could not be read until the
            // invocation it cancels had already finished.
            context.StartInvocation(snapshot);
        }
        else if (string.Equals(
                     snapshot.Type,
                     "invoke_batch",
                     StringComparison.Ordinal))
        {
            // Same discipline as invoke. Before this branch existed a batch
            // envelope was journaled and acknowledged here and then dropped:
            // the Gateway's Section 10.1 window stayed occupied forever while
            // the bridge held no record that anything was owed.
            context.StartBatch(snapshot);
        }
    }

    private async Task FlushPendingRetransmitAsync(
        ConnectionCycleContext context)
    {
        await context.OutboundGate.WaitAsync(context.Token)
            .ConfigureAwait(false);
        try
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
        finally
        {
            context.OutboundGate.Release();
        }
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
        JsonElement payload = CreateHeartbeatPayload(
            sessions,
            acknowledgements);
        using var deadlineCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(context.Token);
        try
        {
            Task deadline = _clock.DelayAsync(
                _options.EffectiveHeartbeatAcknowledgementTimeout,
                deadlineCancellation.Token);
            HeartbeatFlight flight =
                context.InstallHeartbeatFlight(fence, deadline);

            Task send;
            Exception? sendFailure = null;
            bool sendCompleted = false;
            try
            {
                send = context.Cycle.SendAsync(
                    CreateControlEnvelope("heartbeat", payload),
                    context.Token);
            }
            catch (Exception exception)
            {
                if (context.TryRollbackHeartbeatFlight(flight))
                {
                    throw;
                }

                send = Task.CompletedTask;
                sendCompleted = true;
                sendFailure = exception;
            }

            bool acknowledgementObserved = false;
            bool applicationCompleted = false;
            using var applicationCancellation =
                CancellationTokenSource.CreateLinkedTokenSource(context.Token);
            Task? applicationDeadline = null;
            try
            {
                while (!sendCompleted ||
                       !acknowledgementObserved ||
                       !applicationCompleted)
                {
                    var pending = new List<Task>(4);
                    if (!sendCompleted)
                    {
                        pending.Add(send);
                    }

                    if (!acknowledgementObserved)
                    {
                        pending.Add(flight.Observed.Task);
                        pending.Add(flight.Deadline);
                    }
                    else
                    {
                        if (!applicationCompleted)
                        {
                            pending.Add(flight.Applied.Task);
                        }

                        pending.Add(applicationDeadline ??
                            throw new InvalidOperationException(
                                "An observed heartbeat must own an application " +
                                "deadline."));
                    }

                    Task completed = await Task.WhenAny(pending)
                        .WaitAsync(context.Token)
                        .ConfigureAwait(false);
                    if (ReferenceEquals(completed, flight.Deadline))
                    {
                        if (context.TryRollbackHeartbeatFlight(flight))
                        {
                            ObserveLateFault(send);
                            context.Token.ThrowIfCancellationRequested();
                            throw new RbpCoordinatorException(
                                RbpCoordinatorErrorCode.HeartbeatTimeout,
                                "The Gateway did not acknowledge the heartbeat " +
                                "within 10 seconds.");
                        }

                        await flight.Observed.Task.ConfigureAwait(false);
                        acknowledgementObserved = true;
                        deadlineCancellation.Cancel();
                        applicationDeadline ??= _clock.DelayAsync(
                            _options.EffectiveHeartbeatCompletionTimeout,
                            applicationCancellation.Token);
                    }

                    if (ReferenceEquals(completed, send))
                    {
                        try
                        {
                            await send.ConfigureAwait(false);
                            sendCompleted = true;
                        }
                        catch (Exception exception)
                        {
                            sendCompleted = true;
                            if (context.TryRollbackHeartbeatFlight(flight))
                            {
                                throw;
                            }

                            sendFailure = exception;
                        }
                    }

                    if (ReferenceEquals(completed, flight.Observed.Task))
                    {
                        await flight.Observed.Task.ConfigureAwait(false);
                        acknowledgementObserved = true;
                        deadlineCancellation.Cancel();
                        applicationDeadline ??= _clock.DelayAsync(
                            _options.EffectiveHeartbeatCompletionTimeout,
                            applicationCancellation.Token);
                    }

                    if (ReferenceEquals(completed, flight.Applied.Task))
                    {
                        await flight.Applied.Task.ConfigureAwait(false);
                        applicationCompleted = true;
                    }

                    if (ReferenceEquals(completed, applicationDeadline))
                    {
                        ObserveLateFault(send);
                        context.Token.ThrowIfCancellationRequested();
                        throw new RbpCoordinatorException(
                            RbpCoordinatorErrorCode.HeartbeatApplicationTimeout,
                            "The observed heartbeat acknowledgement did not " +
                            "finish transport send and durable application " +
                            "before the connection liveness window elapsed.");
                    }
                }
            }
            catch (OperationCanceledException)
                when (context.Token.IsCancellationRequested)
            {
                _ = context.TryRollbackHeartbeatFlight(flight);
                ObserveLateFault(send);
                throw;
            }
            catch
            {
                ObserveLateFault(send);
                throw;
            }
            finally
            {
                applicationCancellation.Cancel();
            }

            if (sendFailure is not null)
            {
                ExceptionDispatchInfo.Capture(sendFailure).Throw();
                throw new InvalidOperationException(
                    "ExceptionDispatchInfo.Throw unexpectedly returned.");
            }
        }
        finally
        {
            deadlineCancellation.Cancel();
        }
    }

    private async Task ApplyHeartbeatAcknowledgementAsync(
        ConnectionCycleContext context,
        RbpEnvelope envelope)
    {
        if (!IsCurrentContext(context))
        {
            return;
        }

        HeartbeatFlight? flight =
            context.ConsumeAndObserveHeartbeatFlight();
        if (flight is null)
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.UnexpectedControl,
                "An unsolicited heartbeat_ack cannot finalize connection " +
                "state.");
        }

        try
        {
            IReadOnlyList<RbpSessionAcknowledgement> acknowledgements =
                ParseHeartbeatAcknowledgements(envelope);
            RbpHeartbeatFence fence = flight.Fence with
            {
                Acknowledgements = acknowledgements,
            };
            RbpHeartbeatFenceResult applied =
                await _journal.ApplyHeartbeatFenceAcknowledgementAsync(
                        fence,
                        context.Token)
                    .ConfigureAwait(false);
            IReadOnlyList<RbpReleasedCarrier> releasedCarriers =
                await _journal.ApplyCarrierPlanAcknowledgementsAsync(
                        acknowledgements,
                        context.Token)
                    .ConfigureAwait(false);
            if (releasedCarriers.Count > 0)
            {
                // The journal release is the authority. The producer owns the
                // spool and independently rechecks its terminal fence before
                // deleting any bytes; it is never called on send.
                await CompleteCarrierSpoolReleasesAsync(
                        releasedCarriers,
                        context.Token)
                    .ConfigureAwait(false);
            }
            foreach (string rsid in applied.ConfirmedUnregisterRsids)
            {
                context.MarkUnregisterConfirmed(rsid);
                _ = await _journal.CompleteConfirmedUnregisterAsync(
                        rsid,
                        context.Token)
                    .ConfigureAwait(false);
            }

            context.CompleteHeartbeatFlight(flight);
        }
        catch (Exception exception)
        {
            context.FailHeartbeatFlight(flight, exception);
            throw;
        }
    }

    private async Task CompleteCarrierSpoolReleasesAsync(
        IReadOnlyList<RbpReleasedCarrier> releases,
        CancellationToken cancellationToken)
    {
        if (releases.Count == 0 || _carrierProducer is null)
        {
            return;
        }

        // Cleanup first, confirmation second: a crash in between retains a
        // pending token that startup/reconnect reissues. The spool operation
        // itself is absent-safe only after a successful prior release.
        _carrierProducer.SweepExpired(releases);
        foreach (RbpReleasedCarrier release in releases)
        {
            await _journal.ConfirmSpoolReleasedAsync(release, cancellationToken)
                .ConfigureAwait(false);
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
                        receipt.JournalRecordDigest,
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
