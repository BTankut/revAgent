using System.Text.Json;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed partial class RbpConnectionCoordinator
{
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
                .DispatchClaimedAsync(claim, envelope.Payload, context.Token)
                .ConfigureAwait(false);
            await SendDataAsync(context, envelope.Rsid, answer)
                .ConfigureAwait(false);
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
            context.FailPending(exception);
            context.Cancel();
        }
        finally
        {
            claim.Dispose();
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
            await SendDataAsync(
                    context,
                    envelope.Rsid,
                    _invocationDispatcher.RejectConcurrent(invocationId))
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
            context.FailPending(exception);
            context.Cancel();
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
        RbpInvocationAnswer answer)
    {
        await context.OutboundGate.WaitAsync(context.Token)
            .ConfigureAwait(false);
        try
        {
            RbpQueueOutboundResult queued = await _journal
                .QueueOutboundDataAsync(
                    rsid,
                    new RbpOutboundDataDraft(
                        answer.Type,
                        _identifiers.NewId(),
                        answer.Payload),
                    context.Token)
                .ConfigureAwait(false);

            // The only path that yields no envelope is RenewalRequired: the
            // session has no usable transmit sequence until it resumes. A
            // session that was unregistered or tombstoned throws instead, and
            // the caller treats that as a per-session condition.
            if (queued.Envelope is not { } outbound)
            {
                return;
            }

            if (!context.IsDispatchAllowed(rsid))
            {
                return;
            }

            await context.Cycle
                .SendAsync(CreateDataEnvelope(outbound), context.Token)
                .ConfigureAwait(false);
        }
        finally
        {
            context.OutboundGate.Release();
        }
    }
}
