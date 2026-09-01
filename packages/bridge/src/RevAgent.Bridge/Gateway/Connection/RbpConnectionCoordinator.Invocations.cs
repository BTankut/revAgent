using System.Text.Json;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed partial class RbpConnectionCoordinator
{
    private async Task RunJournaledInvocationWorkAsync(
        ConnectionCycleContext context,
        RbpDataEnvelopeSnapshot envelope,
        IRbpInvocationClaim? claim,
        bool batch)
    {
        try
        {
            await JournalAcceptedInboundAsync(envelope, context.Token)
                .ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            claim?.Dispose();
            context.CompleteInvocation();
            HandleInvocationFailure(context, exception);
            throw;
        }

        CurrentOperationResult<bool> continued =
            await TryRunCurrentOperationAsync(
                    context,
                    async () =>
                    {
                        if (claim is null)
                        {
                            if (batch)
                                await RunBatchConcurrentRejectionAsync(
                                        context, envelope)
                                    .ConfigureAwait(false);
                            else
                                await RunConcurrentRejectionAsync(
                                        context, envelope)
                                    .ConfigureAwait(false);
                            return;
                        }

                        if (batch)
                            await RunBatchAsync(context, claim, envelope)
                                .ConfigureAwait(false);
                        else
                            await RunInvocationAsync(context, claim, envelope)
                                .ConfigureAwait(false);
                    })
                .ConfigureAwait(false);
        if (continued.Started) return;

        claim?.Dispose();
        context.CompleteInvocation();
        RbpCoordinatorException failure = NonDrainingConnectionAuthority();
        PromoteConnectionAuthorityMustExit(context, failure);
        throw failure;
    }

    /// <summary>
    /// Runs one claimed invocation to its terminal answer.
    /// </summary>
    /// <remarks>
    /// Started as a detached, cycle-scoped task so the receive loop keeps
    /// sequencing frames while the add-in works. Without that, a Section 16
    /// <c>cancel</c> for the running invocation could not be read until the
    /// invocation it cancels had already finished.
    /// </remarks>
    private async Task RunInvocationAsync(
        ConnectionCycleContext context,
        IRbpInvocationClaim claim,
        RbpDataEnvelopeSnapshot envelope)
    {
        try
        {
            RbpInvocationAnswer answer = await _invocationDispatcher
                .DispatchClaimedAsync(
                    claim,
                    envelope.Payload,
                    context.GrantedConnectionCapabilities,
                    context.Token)
                .ConfigureAwait(false);
            CurrentOperationResult<bool> sent =
                await TryRunCurrentOperationAsync(
                        context,
                        () => SendDataAsync(
                            context, envelope.Rsid, envelope.Sequence, answer))
                    .ConfigureAwait(false);
            if (!sent.Started) return;
        }
        catch (OperationCanceledException)
        {
            // The cycle is ending. The terminal outcome is already durable, so
            // Section 12.2 arbitrates the redelivery rather than this delivery.
        }
        catch (RbpJournalException exception) when (
            exception.ErrorCode is RbpJournalErrorCode.SessionNotFound
                or RbpJournalErrorCode.SessionConflict
                or RbpJournalErrorCode.StoreClosed)
        {
            // Per-session and teardown conditions, not connection faults.
            // TryRecordShutdownUnregistersAsync writes an unregister tombstone
            // for every bound session before cancelling the cycle, so
            // SessionConflict here is the ordinary stop path. Killing the
            // connection for it would take every other session's work with it.
        }
        catch (RbpGatewayTransportException)
        {
            // The socket is gone; the receive loop observes the same failure
            // and owns the reconnect decision.
        }
        catch (Exception exception)
        {
            // Anything else compromises durability authority. Fail closed, the
            // same way the receive loop does.
            HandleInvocationFailure(context, exception);
        }
        finally
        {
            claim.Dispose();
            context.CompleteInvocation();
        }
    }

    /// <summary>
    /// Runs one claimed batch to its terminal Section 11.1 carrier. The fault
    /// envelope set mirrors <see cref="RunInvocationAsync"/> exactly: the
    /// carrier is durable before it is sent, so every abandoned delivery is
    /// re-arbitrated by Section 12.2 rather than re-executed.
    /// </summary>
    private async Task RunBatchAsync(
        ConnectionCycleContext context,
        IRbpInvocationClaim claim,
        RbpDataEnvelopeSnapshot envelope)
    {
        Diagnose($"batch start rsid={envelope.Rsid} envelope={envelope.Id}");
        try
        {
            RbpInvocationAnswer answer = _batchCoordinator is { } batches
                ? await batches
                    .DispatchAsync(
                        envelope.Rsid,
                        envelope.Payload,
                        context.Token)
                    .ConfigureAwait(false)
                : RbpBatchCoordinator.Unavailable(envelope.Payload);
            Diagnose(
                $"batch answered type={answer.Type} payload={answer.Payload.GetRawText()}");
            CurrentOperationResult<bool> sent =
                await TryRunCurrentOperationAsync(
                        context,
                        () => SendDataAsync(
                            context, envelope.Rsid, envelope.Sequence, answer))
                    .ConfigureAwait(false);
            if (!sent.Started) return;
            Diagnose("batch sent");
        }
        catch (OperationCanceledException)
        {
            Diagnose("batch cancelled with the cycle");
        }
        catch (RbpJournalException exception) when (
            exception.ErrorCode is RbpJournalErrorCode.SessionNotFound
                or RbpJournalErrorCode.SessionConflict
                or RbpJournalErrorCode.StoreClosed)
        {
            Diagnose($"batch per-session journal condition {exception.ErrorCode}");
        }
        catch (RbpGatewayTransportException)
        {
            Diagnose("batch transport gone");
        }
        catch (Exception exception)
        {
            Diagnose($"batch fatal {exception.GetType().Name}: {exception.Message}");
            HandleInvocationFailure(context, exception);
        }
        finally
        {
            claim.Dispose();
            context.CompleteInvocation();
        }
    }

    private void Diagnose(string message)
    {
        if (_onDispatchDiagnostic is not { } sink)
        {
            return;
        }

        try
        {
            sink(message.Length <= 3000 ? message : message[..3000]);
        }
        catch (Exception)
        {
            // Tracing must never own dispatch.
        }
    }

    /// <summary>
    /// Answers a batch refused by the Section 10.1 window without reserving a
    /// journal row or writing an add-in byte.
    /// </summary>
    private async Task RunBatchConcurrentRejectionAsync(
        ConnectionCycleContext context,
        RbpDataEnvelopeSnapshot envelope)
    {
        try
        {
            _ = await TryRunCurrentOperationAsync(
                    context,
                    () => SendDataAsync(
                        context,
                        envelope.Rsid,
                        envelope.Sequence,
                        RbpBatchCoordinator.RejectConcurrent(envelope.Payload)))
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        catch (RbpJournalException exception) when (
            exception.ErrorCode is RbpJournalErrorCode.SessionNotFound
                or RbpJournalErrorCode.SessionConflict
                or RbpJournalErrorCode.StoreClosed)
        {
        }
        catch (RbpGatewayTransportException)
        {
        }
        catch (Exception exception)
        {
            HandleInvocationFailure(context, exception);
        }
        finally
        {
            context.CompleteInvocation();
        }
    }

    /// <summary>
    /// Answers an invoke refused by the Section 10.1 window without reserving a
    /// journal row or writing an add-in byte.
    /// </summary>
    private async Task RunConcurrentRejectionAsync(
        ConnectionCycleContext context,
        RbpDataEnvelopeSnapshot envelope)
    {
        try
        {
            string invocationId = ReadInvocationId(envelope.Payload);
            _ = await TryRunCurrentOperationAsync(
                    context,
                    () => SendDataAsync(
                        context,
                        envelope.Rsid,
                        envelope.Sequence,
                        _invocationDispatcher.RejectConcurrent(invocationId)))
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        catch (RbpJournalException exception) when (
            exception.ErrorCode is RbpJournalErrorCode.SessionNotFound
                or RbpJournalErrorCode.SessionConflict
                or RbpJournalErrorCode.StoreClosed)
        {
        }
        catch (RbpGatewayTransportException)
        {
        }
        catch (Exception exception)
        {
            HandleInvocationFailure(context, exception);
        }
        finally
        {
            context.CompleteInvocation();
        }
    }

    private static string ReadInvocationId(JsonElement payload) =>
        payload.ValueKind == JsonValueKind.Object &&
        payload.TryGetProperty("invocation_id", out JsonElement value) &&
        value.ValueKind == JsonValueKind.String &&
        value.GetString() is { Length: > 0 } text
            ? text
            : "00000000-0000-7000-8000-000000000000";

    private void HandleInvocationFailure(
        ConnectionCycleContext context,
        Exception exception)
    {
        if (IsNonDrainingConnectionAuthority(exception))
        {
            PromoteConnectionAuthorityMustExit(context, exception);
            return;
        }
        context.FailPending(exception);
        context.Cancel();
    }

    /// <summary>
    /// Queues one outbound data envelope and sends it.
    /// </summary>
    /// <remarks>
    /// The whole queue-then-send runs under the cycle's outbound gate.
    /// <c>QueueOutboundDataAsync</c> allocates the sequence number inside the
    /// journal's own write gate and releases it before the frame is written, so
    /// two concurrent senders on one connection could otherwise allocate
    /// seq N and N+1 and then write them in the opposite order. The transport's
    /// own send lock orders frames, not the sequence numbers inside them.
    /// </remarks>
    private async Task SendDataAsync(
        ConnectionCycleContext context,
        string rsid,
        long inboundSequence,
        RbpInvocationAnswer answer)
    {
        CurrentOperationResult<bool> gate =
            await TryRunCurrentOperationAsync(
                    context,
                    async () =>
                    {
                        await context.OutboundGate.WaitAsync(context.Token)
                            .ConfigureAwait(false);
                    })
                .ConfigureAwait(false);
        if (!gate.Started) return;
        try
        {
            if (!TryCommitCurrent(context, () => { })) return;
            if (answer.RecoveryReservation is { } recovery)
            {
                await SendRecoveryCarrierAsync(context, recovery)
                    .ConfigureAwait(false);
                return;
            }

            if (answer.Prefixes is not null)
            {
                foreach (RbpInvocationAnswer prefix in answer.Prefixes)
                {
                    CurrentOperationResult<bool> prefixSent =
                        await TryRunCurrentOperationAsync(
                                context,
                                () => QueueAndSendDataAsync(
                                    context, rsid, inboundSequence, prefix))
                            .ConfigureAwait(false);
                    if (!prefixSent.Started) return;
                }
            }

            _ = await TryRunCurrentOperationAsync(
                    context,
                    () => QueueAndSendDataAsync(
                        context, rsid, inboundSequence, answer))
                .ConfigureAwait(false);
        }
        finally
        {
            context.OutboundGate.Release();
        }
    }

    private async Task QueueAndSendDataAsync(
        ConnectionCycleContext context,
        string rsid,
        long inboundSequence,
        RbpInvocationAnswer answer)
    {
        CurrentOperationResult<RbpQueueOutboundResult> queue =
            await TryRunCurrentOperationAsync(
                    context,
                    async () =>
                    {
                        IReadOnlyList<RbpSessionAcknowledgement>
                            acknowledgements = await _journal
                                .LoadJournaledAcknowledgementsAsync(
                                    new[] { rsid }, context.Token)
                                .ConfigureAwait(false);
                        RbpSessionAcknowledgement acknowledgement =
                            RequireTerminalAcknowledgement(
                                acknowledgements, rsid, inboundSequence);
                        return await _journal.QueueOutboundDataAsync(
                                rsid,
                                new RbpOutboundDataDraft(
                                    answer.Type,
                                    _identifiers.NewId(),
                                    answer.Payload,
                                    Acknowledgement:
                                        acknowledgement.Sequence),
                                context.Token)
                            .ConfigureAwait(false);
                    })
                .ConfigureAwait(false);
        if (!queue.Started) return;
        RbpQueueOutboundResult queued = queue.Value;

        // The only path that yields no envelope is RenewalRequired: the
        // session has no usable transmit sequence until it resumes. A
        // session that was unregistered or tombstoned throws instead, and
        // the caller treats that as a per-session condition.
        if (queued.Envelope is not { } outbound)
        {
            Diagnose($"send suppressed: no transmit sequence for {rsid}");
            return;
        }

        if (answer.CarrierKey is { } carrierKey)
        {
            CurrentOperationResult<bool> recorded =
                await TryRunCurrentOperationAsync(
                        context,
                        () => _journal.RecordCarrierTerminalQueuedAsync(
                            carrierKey,
                            rsid,
                            outbound.Sequence,
                            context.Token))
                    .ConfigureAwait(false);
            if (!recorded.Started) return;
            CurrentOperationResult<bool> producerRecorded =
                await TryRunCurrentOperationAsync(
                        context,
                        () =>
                        {
                            _carrierProducer?.RecordTerminalQueued(
                                carrierKey,
                                rsid,
                                outbound.Sequence);
                            return Task.FromResult(true);
                        })
                    .ConfigureAwait(false);
            if (!producerRecorded.Started) return;
        }

        if (!context.IsDispatchAllowed(rsid))
        {
            Diagnose($"send suppressed: dispatch not allowed for {rsid}");
            return;
        }

        RbpEnvelope outboundEnvelope = CreateDataEnvelope(outbound);
        RbpPreparedSend prepared = context.Cycle.PrepareSend(
            outboundEnvelope,
            context.Token);
        string? outerDigest = answer.OmittedOriginReplay is not null
            ? ExactWireEnvelopeDigest(outboundEnvelope)
            : null;

        bool markerBound = answer.OmittedOriginReplay is null;
        bool published = false;
        bool committed = TryCommitCurrent(context, () =>
        {
            if (!context.IsDispatchAllowed(rsid)) return;
            if (answer.OmittedOriginReplay is { } omitted)
                markerBound = _omittedOriginObservation.TryBindReplay(
                    omitted, context.Generation, outbound.Sequence,
                    outerDigest!);
            if (!markerBound) return;
            published = context.TryPublishPreparedInvocationSend(
                prepared, outbound.Sequence, outerDigest);
            if (!published && answer.OmittedOriginReplay is { } rollback)
                markerBound = _omittedOriginObservation.AbortBoundReplay(
                    rollback, context.Generation, outbound.Sequence,
                    outerDigest!);
        });
        if (!committed || !markerBound || !published)
        {
            _ = prepared.TryCancelBeforeStart();
            if (!markerBound)
                throw new RbpCoordinatorException(
                    RbpCoordinatorErrorCode.UnexpectedControl,
                    "The C39 fixture replay marker could not bind its terminal.");
            return;
        }
        Diagnose("prepared invocation send committed");

        if (context.Token.IsCancellationRequested ||
            !context.IsDispatchAllowed(rsid))
        {
            if (prepared.TryCancelBeforeStart())
            {
                bool abortValid = answer.OmittedOriginReplay is null;
                bool abortCommitted = TryCommitCurrent(context, () =>
                {
                    if (answer.OmittedOriginReplay is { } localAbort)
                        abortValid = _omittedOriginObservation.AbortBoundReplay(
                            localAbort, context.Generation, outbound.Sequence,
                            outerDigest!);
                    _ = context.CompletePreparedInvocationSend(prepared);
                });
                if (abortCommitted && !abortValid)
                    throw new RbpCoordinatorException(
                        RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
                        "The exact current no-start replay marker could not abort.");
            }
            context.Token.ThrowIfCancellationRequested();
            return;
        }

        if (!prepared.TryStart(out Task? send) || send is null)
        {
            if (prepared.IsCancelledBeforeStart)
                context.Token.ThrowIfCancellationRequested();
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
                "The prepared outbound send lost exact start ownership.");
        }
        bool exposureValid = true;
        bool exposureCommitted = true;
        if (answer.OmittedOriginReplay is { } exposed)
        {
            exposureValid = false;
            exposureCommitted = TryCommitCurrent(context, () =>
                exposureValid = _omittedOriginObservation.TryExposeReplay(
                    exposed, context.Generation, outbound.Sequence,
                    outerDigest!));
        }
        if (!exposureCommitted || !exposureValid)
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
                "The started omitted-origin send lost its exact replay marker.");
        }
        try
        {
            await send.ConfigureAwait(false);
        }
        finally
        {
            _ = TryCommitCurrent(context, () =>
                context.CompletePreparedInvocationSend(prepared));
        }
    }

    internal static RbpSessionAcknowledgement
        RequireTerminalAcknowledgement(
        IReadOnlyList<RbpSessionAcknowledgement>? acknowledgements,
        string rsid,
        long inboundSequence)
    {
        if (acknowledgements is null || acknowledgements.Count != 1 ||
            !string.Equals(
                acknowledgements[0].Rsid, rsid, StringComparison.Ordinal) ||
            acknowledgements[0].Sequence < inboundSequence ||
            acknowledgements[0].Sequence < 0 ||
            acknowledgements[0].Sequence >
                RbpProtocolLimits.MaximumSafeInteger)
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.SequenceFault,
                "The terminal answer has no single exact durable journal " +
                "acknowledgement frontier.");
        }

        return acknowledgements[0];
    }

    private async Task<bool> SendCurrentPreparedAsync(
        ConnectionCycleContext context,
        RbpEnvelope envelope,
        string rsid)
    {
        RbpPreparedSend prepared = context.Cycle.PrepareSend(
            envelope, context.Token);
        bool published = false;
        if (!TryCommitCurrent(context, () =>
            {
                if (context.IsDispatchAllowed(rsid))
                    published = context.TryPublishPreparedInvocationSend(
                        prepared, envelope.Sequence ?? 0, outerDigest: null);
            }) || !published)
        {
            _ = prepared.TryCancelBeforeStart();
            return false;
        }
        if (context.Token.IsCancellationRequested)
        {
            _ = prepared.TryCancelBeforeStart();
            context.Token.ThrowIfCancellationRequested();
        }
        if (!prepared.TryStart(out Task? send) || send is null)
            throw NonDrainingConnectionAuthority();
        try
        {
            await send.ConfigureAwait(false);
            return true;
        }
        finally
        {
            _ = TryCommitCurrent(context, () =>
                context.CompletePreparedInvocationSend(prepared));
        }
    }

    private static string ExactWireEnvelopeDigest(RbpEnvelope envelope)
    {
        byte[] bytes = RbpEnvelopeCodec.Encode(envelope);
        try
        {
            return "sha256:" + Convert.ToHexString(
                System.Security.Cryptography.SHA256.HashData(bytes))
                .ToLowerInvariant();
        }
        finally
        {
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(
                bytes);
        }
    }
}
