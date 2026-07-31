using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;

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
                return false;
            }

            if (!context.IsDispatchAllowed(rsid))
            {
                return true;
            }

            try
            {
                await context.Cycle
                    .SendAsync(CreateDataEnvelope(outbound), context.Token)
                    .ConfigureAwait(false);
            }
            catch (RbpGatewayTransportException)
            {
                // Durably queued; retransmission owns delivery.
            }

            return true;
        }
        finally
        {
            context.OutboundGate.Release();
        }
    }
}
