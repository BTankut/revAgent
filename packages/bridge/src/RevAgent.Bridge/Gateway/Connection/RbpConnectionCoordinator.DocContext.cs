using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed partial class RbpConnectionCoordinator
{
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
        _docContextWatcher?.BeginWatch(
            rsid,
            local,
            (payload, _) =>
                TryEmitDocContextUpdateAsync(context, rsid, payload),
            context.Token);
    }

    /// <summary>
    /// Cleanly stops a session's watcher when the session itself ends. A
    /// connection loss deliberately does not come through here, so the
    /// watcher keeps its last-emitted snapshot and a resume stays silent
    /// for unchanged context.
    /// </summary>
    private void StopDocContextWatch(string rsid) =>
        _docContextWatcher?.EndWatch(rsid);

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
        JsonElement payload)
    {
        if (!IsCurrentContext(context))
        {
            ObserveDocumentContext("failure", "stale_context", rsid, payload);
            return false;
        }

        await context.OutboundGate.WaitAsync(context.Token)
            .ConfigureAwait(false);
        try
        {
            RbpQueueOutboundResult queued = await _journal
                .QueueOutboundDataAsync(
                    rsid,
                    new RbpOutboundDataDraft(
                        "doc_context_update",
                        _identifiers.NewId(),
                        payload),
                    context.Token)
                .ConfigureAwait(false);
            if (queued.Envelope is not { } outbound)
            {
                // RenewalRequired: the session has no usable transmit
                // sequence until it resumes, so nothing durable happened
                // and the watcher retries at its next tick.
                ObserveDocumentContext("queue", "renewal_required", rsid, payload);
                return false;
            }

            TrackDocumentContextQueued(rsid, outbound.Sequence);
            ObserveDocumentContext("queue", "durably_queued", rsid, payload,
                outbound.Sequence);

            if (!context.IsDispatchAllowed(rsid))
            {
                ObserveDocumentContext("send", "dispatch_not_allowed", rsid,
                    payload, outbound.Sequence);
                return true;
            }

            try
            {
                await context.Cycle
                    .SendAsync(CreateDataEnvelope(outbound), context.Token)
                    .ConfigureAwait(false);
                ObserveDocumentContext("send", "sent", rsid, payload,
                    outbound.Sequence);
            }
            catch (RbpGatewayTransportException)
            {
                // Durably queued; retransmission owns delivery.
                ObserveDocumentContext("failure", "send_deferred", rsid,
                    payload, outbound.Sequence);
            }

            return true;
        }
        finally
        {
            context.OutboundGate.Release();
        }
    }

    private void TrackDocumentContextQueued(string rsid, long sequence)
    {
        lock (_sync)
        {
            if (!_documentContextQueued.TryGetValue(rsid, out long prior) ||
                sequence > prior)
            {
                _documentContextQueued[rsid] = sequence;
            }
        }
    }

    private void ObserveDocumentContextAcknowledgements(
        IReadOnlyList<RbpSessionAcknowledgement> acknowledgements)
    {
        foreach (RbpSessionAcknowledgement acknowledgement in acknowledgements)
        {
            long sequence;
            lock (_sync)
            {
                if (!_documentContextQueued.TryGetValue(
                        acknowledgement.Rsid, out sequence) ||
                    acknowledgement.Sequence < sequence)
                {
                    continue;
                }

                _documentContextQueued.Remove(acknowledgement.Rsid);
            }

            ObserveDocumentContext("ack", "durably_acknowledged",
                acknowledgement.Rsid, sequence: sequence);
        }
    }

    private void ObserveDocumentContext(
        string stage,
        string outcome,
        string rsid,
        JsonElement? payload = null,
        long? sequence = null)
    {
        if (_onDocumentContextObservation is null)
        {
            return;
        }

        try
        {
            _ = _onDocumentContextObservation(
                RbpDocumentContextObservation.Create(
                    stage, outcome, rsid, payload, sequence))
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
}
