using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed partial class RbpConnectionCoordinator
{
    /// <summary>Test-host caller may signal an already-attested eligible watch only.</summary>
    internal Task<RbpImmediatePollOutcome>? RequestImmediateDocumentContextPollAsync(
        string rsid)
    {
        if (_docContextWatcher is not { } watcher) return null;
        ConnectionCycleContext? context;
        lock (_sync)
        {
            if (_attemptStopState is 3 or 4 or 5) return Task.FromResult(
                RbpImmediatePollOutcome.Cancelled);
            context = _active;
        }
        return context is null
            ? Task.FromResult(RbpImmediatePollOutcome.Cancelled)
            : RequestImmediateDocumentContextPollCoreAsync(
                context, watcher, rsid);
    }

    private async Task<RbpImmediatePollOutcome>
        RequestImmediateDocumentContextPollCoreAsync(
            ConnectionCycleContext context,
            RbpDocContextWatcher watcher,
            string rsid)
    {
        CurrentOperationResult<RbpImmediatePollOutcome> requested =
            await TryRunCurrentOperationAsync(
                    context,
                    () => watcher.RequestImmediatePollAsync(rsid) ??
                        Task.FromResult(RbpImmediatePollOutcome.Cancelled))
                .ConfigureAwait(false);
        return requested.Started
            ? requested.Value
            : RbpImmediatePollOutcome.Cancelled;
    }
    /// <summary>
    /// The optional P3-T7 document-context watcher. When absent the
    /// coordinator behaves exactly as before: nothing polls
    /// <c>get_document_context</c> and no <c>doc_context_update</c> is
    /// emitted, which is the fail-closed posture for a worker without an
    /// add-in dispatch surface.
    /// </summary>
    private readonly RbpDocContextWatcher? _docContextWatcher;

    /// <summary>
    /// Arms the Section 14 watcher for a session that just registered or
    /// resumed on this cycle. The watcher itself enforces the
    /// <c>doc_context_cached_v1</c> capability gate and polls immediately,
    /// which satisfies the RES-3 register/resume trigger.
    /// </summary>
    private void StartDocContextWatch(
        ConnectionCycleContext context,
        string rsid,
        RbpLocalSessionSnapshot local)
    {
        if (_docContextWatcher is not { } watcher) return;
        RbpDocContextWatcher.PreparedWatch prepared = watcher.PrepareWatch(
            rsid,
            local,
            (payload, diagnosticPair, _) =>
                TryEmitDocContextUpdateAsync(
                    context, rsid, payload, diagnosticPair),
            context.Token,
            context.Generation);
        RbpDocContextWatcher.WatchCommitReceipt? receipt = null;
        RbpDocContextWatcher.WatchCommitReceipt? replacedReceipt = null;
        bool published = false;
        bool startReserved = false;
        bool committed = TryCommitCurrent(
                context,
                () =>
                {
                    if (!context.TryReservePreparedWatch(rsid)) return;
                    receipt = prepared.Commit();
                    if (receipt is not null)
                        published = context.CommitPreparedWatchReservation(
                            rsid, receipt, out replacedReceipt);
                    if (published)
                        startReserved = receipt!.TryReserveStart();
                    else
                        context.AbortPreparedWatchReservation(rsid);
                });
        if (!committed || receipt is null)
        {
            prepared.Abort();
            return;
        }
        if (!published || !startReserved)
        {
            context.AbortPreparedWatchReservation(rsid);
            RetainQuarantinedTeardownTask(receipt.Abort());
            return;
        }
        if (replacedReceipt is not null)
            context.RetainWatcherTask(rsid, replacedReceipt.Abort());
        receipt.Launch();
    }

    /// <summary>
    /// Cleanly stops a session's watcher when the session itself ends. A
    /// connection loss deliberately does not come through here, so the
    /// watcher keeps its last-emitted snapshot and a resume stays silent
    /// for unchanged context.
    /// </summary>
    private void StopDocContextWatch(
        ConnectionCycleContext context,
        string rsid)
    {
        context.RemovePreparedWatch(rsid);
        _docContextWatcher?.EndWatch(rsid);
    }

    /// <summary>
    /// Queues one <c>doc_context_update</c> through the coordinator's
    /// outbound data path and sends it on the active cycle.
    /// </summary>
    /// <remarks>
    /// Returns <see langword="true"/> once the update is durably queued in
    /// the session outbox: a transport failure after that point is not a
    /// loss, because Section 6.2 retransmission delivers the queued
    /// envelope on resume, and reporting a failure to the watcher would
    /// only queue a duplicate. The receive loop owns the reconnect
    /// decision for the failed socket.
    /// </remarks>
    private async Task<bool> TryEmitDocContextUpdateAsync(
        ConnectionCycleContext context,
        string rsid,
        JsonElement payload,
        RbpDocumentContextDiagnosticPair? diagnosticPair)
    {
        if (!TryCommitCurrent(context, () => { }))
        {
            return false;
        }

        CurrentOperationResult<bool> gate =
            await TryRunCurrentOperationAsync(
                    context,
                    async () => await context.OutboundGate
                        .WaitAsync(context.Token).ConfigureAwait(false))
                .ConfigureAwait(false);
        if (!gate.Started) return false;
        try
        {
            CurrentOperationResult<RbpQueueOutboundResult> queue =
                await TryRunCurrentOperationAsync(
                        context,
                        () => _journal.QueueOutboundDataAsync(
                            rsid,
                            new RbpOutboundDataDraft(
                                "doc_context_update",
                                _identifiers.NewId(),
                                payload),
                            context.Token))
                    .ConfigureAwait(false);
            if (!queue.Started) return false;
            RbpQueueOutboundResult queued = queue.Value;
            if (queued.Envelope is not { } outbound)
            {
                // RenewalRequired: the session has no usable transmit
                // sequence until it resumes, so nothing durable happened
                // and the watcher retries at its next tick.
                await ObserveDocumentContextCurrentAsync(
                        context,
                        "queue",
                        "renewal_required",
                        rsid,
                        payload,
                        diagnosticPair: diagnosticPair)
                    .ConfigureAwait(false);
                return false;
            }

            if (!TryCommitCurrent(context, () =>
                    TrackDocumentContextQueued(
                        rsid, outbound.Sequence, diagnosticPair)))
                return true;
            await ObserveDocumentContextCurrentAsync(
                    context,
                    "queue",
                    "durably_queued",
                    rsid,
                    payload,
                    outbound.Sequence,
                    diagnosticPair)
                .ConfigureAwait(false);

            if (!context.IsDispatchAllowed(rsid))
            {
                await ObserveDocumentContextCurrentAsync(
                        context,
                        "send",
                        "dispatch_not_allowed",
                        rsid,
                        payload,
                        outbound.Sequence,
                        diagnosticPair)
                    .ConfigureAwait(false);
                return true;
            }

            try
            {
                bool sent = await SendCurrentPreparedAsync(
                        context, CreateDataEnvelope(outbound), rsid)
                    .ConfigureAwait(false);
                if (sent)
                    await ObserveDocumentContextCurrentAsync(
                            context,
                        "send", "sent", rsid, payload,
                        outbound.Sequence, diagnosticPair)
                        .ConfigureAwait(false);
            }
            catch (RbpGatewayTransportException)
            {
                // Durably queued; retransmission owns delivery.
                await ObserveDocumentContextCurrentAsync(
                        context,
                        "failure", "send_deferred", rsid,
                        payload, outbound.Sequence, diagnosticPair)
                    .ConfigureAwait(false);
            }

            return true;
        }
        finally
        {
            context.OutboundGate.Release();
        }
    }

    private async Task ObserveDocumentContextCurrentAsync(
        ConnectionCycleContext context,
        string stage,
        string outcome,
        string rsid,
        JsonElement? payload = null,
        long? sequence = null,
        RbpDocumentContextDiagnosticPair? diagnosticPair = null)
    {
        _ = await TryRunCurrentOperationAsync(
                context,
                () =>
                {
                    ObserveDocumentContext(
                        stage,
                        outcome,
                        rsid,
                        payload,
                        sequence,
                        diagnosticPair);
                    return Task.FromResult(true);
                })
            .ConfigureAwait(false);
    }

    private void TrackDocumentContextQueued(
        string rsid,
        long sequence,
        RbpDocumentContextDiagnosticPair? diagnosticPair)
    {
        lock (_sync)
        {
            if (!_documentContextQueued.TryGetValue(rsid, out DocumentContextQueuedDiagnostic? prior) ||
                sequence > prior.Sequence)
            {
                _documentContextQueued[rsid] = new DocumentContextQueuedDiagnostic(
                    sequence,
                    diagnosticPair);
            }
        }
    }

    private void ObserveDocumentContextAcknowledgements(
        IReadOnlyList<RbpSessionAcknowledgement> acknowledgements)
    {
        foreach (RbpSessionAcknowledgement acknowledgement in acknowledgements)
        {
            DocumentContextQueuedDiagnostic? queued;
            lock (_sync)
            {
                if (!_documentContextQueued.TryGetValue(
                        acknowledgement.Rsid, out queued) ||
                    acknowledgement.Sequence < queued.Sequence)
                {
                    continue;
                }

                _documentContextQueued.Remove(acknowledgement.Rsid);
            }

            ObserveDocumentContext("ack", "durably_acknowledged",
                acknowledgement.Rsid, sequence: queued!.Sequence,
                diagnosticPair: queued.DiagnosticPair);
        }
    }

    private void ObserveDocumentContext(
        string stage,
        string outcome,
        string rsid,
        JsonElement? payload = null,
        long? sequence = null,
        RbpDocumentContextDiagnosticPair? diagnosticPair = null)
    {
        if (_onDocumentContextObservation is null)
        {
            return;
        }

        if (!RbpDocumentContextObservation.TryCreate(
                stage,
                outcome,
                rsid,
                payload,
                sequence,
                out RbpDocumentContextObservation? observation,
                sourceRevision: diagnosticPair?.SourceRevision,
                cacheIncarnationDigest: diagnosticPair?.CacheIncarnationDigest,
                requireDiagnosticPair: payload is not null) ||
            observation is null)
        {
            // Payload-bearing lifecycle diagnostics are admitted only with a
            // canonical, domain-separated context digest. This is
            // diagnostic-only: it does not affect the already chosen queue,
            // send, retransmission, or authorization behavior.
            return;
        }

        try
        {
            _ = _onDocumentContextObservation(
                observation)
                .AsTask().ContinueWith(
                    completed => _ = completed.Exception,
                    CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted |
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
        }
        catch
        {
            // Observation is diagnostic-only and cannot alter delivery.
        }
    }

    private sealed record DocumentContextQueuedDiagnostic(
        long Sequence,
        RbpDocumentContextDiagnosticPair? DiagnosticPair);
}
