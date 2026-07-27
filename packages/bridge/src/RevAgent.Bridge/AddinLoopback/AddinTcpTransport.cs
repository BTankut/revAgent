using System.Net.Sockets;
using System.Text;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.AddinLoopback;

namespace RevAgent.Bridge.AddinLoopback;

internal interface IAddinTransport
{
    /*
     * The pre-dispatch token represents Gateway/user abandonment and cannot
     * erase a possibly-dispatched outcome. The shutdown token represents
     * worker/service lifetime and can stop socket I/O at any phase while the
     * returned evidence preserves dispatch uncertainty.
     */
    Task<AddinCallResult> InvokeAsync(
        AddinEndpoint endpoint,
        AddinCall call,
        CancellationToken preDispatchCancellationToken = default,
        CancellationToken transportShutdownToken = default,
        IAddinProcessAttestor? processAttestor = null);
}

internal sealed class AddinTcpTransport : IAddinTransport
{
    private const int WriteChunkBytes = AddinFrameLimits.SocketReadBufferBytes;

    public async Task<AddinCallResult> InvokeAsync(
        AddinEndpoint endpoint,
        AddinCall call,
        CancellationToken preDispatchCancellationToken = default,
        CancellationToken transportShutdownToken = default,
        IAddinProcessAttestor? processAttestor = null)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        ArgumentNullException.ThrowIfNull(call);

        if (transportShutdownToken.IsCancellationRequested)
        {
            throw Failure(
                "addin_transport_shutdown",
                "The add-in transport stopped with the bridge worker.",
                AddinDispatchState.NotStarted,
                requestPayloadBytes: 0,
                requestFrameBytes: 0,
                bytesWrittenLowerBound: 0,
                requestFullyWritten: false,
                responseBytesObserved: 0,
                new OperationCanceledException(transportShutdownToken));
        }

        if (preDispatchCancellationToken.IsCancellationRequested)
        {
            throw Failure(
                "addin_call_cancelled",
                "The add-in call was cancelled before transport started.",
                AddinDispatchState.NotStarted,
                requestPayloadBytes: 0,
                requestFrameBytes: 0,
                bytesWrittenLowerBound: 0,
                requestFullyWritten: false,
                responseBytesObserved: 0,
                new OperationCanceledException(preDispatchCancellationToken));
        }

        using var callDeadline = new CancellationTokenSource(call.Timeout);
        using var transportLifetimeCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(
                callDeadline.Token,
                transportShutdownToken);

        var requestPayload = Array.Empty<byte>();
        var requestFrame = Array.Empty<byte>();
        try
        {
            requestPayload = AddinJsonRpcCodec.SerializeRequest(
                call.InvocationId,
                call.Method,
                call.CopyParameters());
            requestFrame = LengthPrefixedFrameCodec.EncodePayload(
                requestPayload,
                call.MaxRequestPayloadBytes);
        }
        catch (AddinJsonRpcProtocolException exception)
        {
            throw Failure(
                exception.Code,
                exception.Message,
                AddinDispatchState.NotStarted,
                requestPayloadBytes: 0,
                requestFrameBytes: 0,
                bytesWrittenLowerBound: 0,
                requestFullyWritten: false,
                responseBytesObserved: 0,
                exception);
        }
        catch (FrameCodecException exception)
        {
            throw Failure(
                exception.Code,
                exception.Message,
                AddinDispatchState.NotStarted,
                requestPayloadBytes: requestPayload.Length,
                requestFrameBytes: 0,
                bytesWrittenLowerBound: 0,
                requestFullyWritten: false,
                responseBytesObserved: 0,
                exception);
        }
        catch (EncoderFallbackException exception)
        {
            throw Failure(
                "invalid_utf16",
                "The add-in request contains text that cannot be encoded as UTF-8.",
                AddinDispatchState.NotStarted,
                requestPayloadBytes: 0,
                requestFrameBytes: 0,
                bytesWrittenLowerBound: 0,
                requestFullyWritten: false,
                responseBytesObserved: 0,
                exception);
        }

        using var preDispatchCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(
                transportLifetimeCancellation.Token,
                preDispatchCancellationToken);

        if (preDispatchCancellation.IsCancellationRequested)
        {
            throw CancellationFailure(
                call,
                preDispatchCancellationToken,
                transportShutdownToken,
                AddinDispatchState.NotStarted,
                requestPayload.Length,
                requestFrame.Length,
                bytesWrittenLowerBound: 0,
                requestFullyWritten: false,
                responseBytesObserved: 0,
                new OperationCanceledException(preDispatchCancellation.Token));
        }

        using var client = new TcpClient(endpoint.Address.AddressFamily);
        try
        {
            await client.ConnectAsync(
                endpoint.Address,
                endpoint.Port,
                preDispatchCancellation.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException exception)
        {
            throw CancellationFailure(
                call,
                preDispatchCancellationToken,
                transportShutdownToken,
                AddinDispatchState.NotStarted,
                requestPayload.Length,
                requestFrame.Length,
                bytesWrittenLowerBound: 0,
                requestFullyWritten: false,
                responseBytesObserved: 0,
                exception);
        }
        catch (Exception exception) when (
            exception is SocketException or IOException)
        {
            throw Failure(
                "addin_connect_failed",
                "The bridge could not connect to the add-in loopback endpoint.",
                AddinDispatchState.NotStarted,
                requestPayload.Length,
                requestFrame.Length,
                bytesWrittenLowerBound: 0,
                requestFullyWritten: false,
                responseBytesObserved: 0,
                exception);
        }

        if (preDispatchCancellation.IsCancellationRequested)
        {
            throw CancellationFailure(
                call,
                preDispatchCancellationToken,
                transportShutdownToken,
                AddinDispatchState.NotStarted,
                requestPayload.Length,
                requestFrame.Length,
                bytesWrittenLowerBound: 0,
                requestFullyWritten: false,
                responseBytesObserved: 0,
                new OperationCanceledException(preDispatchCancellation.Token));
        }

        AddinConnectedPeer? connectedPeer = null;
        AddinProcessAttestation? processAttestation = null;
        if (processAttestor != null)
        {
            try
            {
                connectedPeer = AddinConnectedPeer.FromConnectedClient(client);
                processAttestation =
                    await processAttestor.AttestBeforeDispatchAsync(
                        connectedPeer,
                        preDispatchCancellation.Token).ConfigureAwait(false);
                if (processAttestation == null)
                {
                    throw new AddinProcessAttestationException(
                        "addin_process_attestation_invalid",
                        "The pre-dispatch process attestation was empty.");
                }
            }
            catch (AddinProcessAttestationException exception)
            {
                throw Failure(
                    exception.Code,
                    exception.Message,
                    AddinDispatchState.NotStarted,
                    requestPayload.Length,
                    requestFrame.Length,
                    bytesWrittenLowerBound: 0,
                    requestFullyWritten: false,
                    responseBytesObserved: 0,
                    exception);
            }
            catch (OperationCanceledException exception)
            {
                throw CancellationFailure(
                    call,
                    preDispatchCancellationToken,
                    transportShutdownToken,
                    AddinDispatchState.NotStarted,
                    requestPayload.Length,
                    requestFrame.Length,
                    bytesWrittenLowerBound: 0,
                    requestFullyWritten: false,
                    responseBytesObserved: 0,
                    exception);
            }
        }

        /*
         * The caller token is intentionally detached at the dispatch boundary.
         * Once a request may have reached Revit, O1 cancellation semantics
         * require the bridge to keep observing the add-in outcome for journal
         * evidence. The per-call deadline remains the hard bound.
         */

        var dispatchState = AddinDispatchState.NotStarted;
        var bytesWrittenLowerBound = 0;
        var requestFullyWritten = false;
        var responseBytesObserved = 0;

        try
        {
            using NetworkStream stream = client.GetStream();
            dispatchState = AddinDispatchState.MayHaveReachedAddin;

            for (var offset = 0; offset < requestFrame.Length;)
            {
                var count = Math.Min(
                    WriteChunkBytes,
                    requestFrame.Length - offset);
                await stream.WriteAsync(
                    requestFrame.AsMemory(offset, count),
                    transportLifetimeCancellation.Token).ConfigureAwait(false);
                offset += count;
                bytesWrittenLowerBound += count;
            }

            requestFullyWritten = true;

            var responseHeader = new byte[AddinFrameLimits.HeaderBytes];
            await ReadExactlyAsync(
                stream,
                responseHeader,
                bytesRead =>
                {
                    responseBytesObserved += bytesRead;
                    dispatchState = AddinDispatchState.ResponseObserved;
                },
                transportLifetimeCancellation.Token).ConfigureAwait(false);

            var responsePayloadLength = LengthPrefixedFrameCodec.ReadPayloadLength(
                responseHeader,
                0);
            if (responsePayloadLength > AddinFrameLimits.MaxResponsePayloadBytes)
            {
                throw Failure(
                    "response_frame_too_large",
                    "The add-in response frame exceeds the 32 MiB contract limit.",
                    dispatchState,
                    requestPayload.Length,
                    requestFrame.Length,
                    bytesWrittenLowerBound,
                    requestFullyWritten,
                    responseBytesObserved);
            }

            var responsePayload = new byte[(int)responsePayloadLength];
            await ReadExactlyAsync(
                stream,
                responsePayload,
                bytesRead =>
                {
                    responseBytesObserved += bytesRead;
                    dispatchState = AddinDispatchState.ResponseObserved;
                },
                transportLifetimeCancellation.Token).ConfigureAwait(false);

            AddinJsonRpcResponse response;
            try
            {
                response = AddinJsonRpcCodec.ParseResponse(
                    responsePayload,
                    call.InvocationId);
            }
            catch (AddinJsonRpcProtocolException exception)
            {
                throw Failure(
                    exception.Code,
                    exception.Message,
                    dispatchState,
                    requestPayload.Length,
                    requestFrame.Length,
                    bytesWrittenLowerBound,
                    requestFullyWritten,
                    responseBytesObserved,
                    exception);
            }
            catch (StrictJsonException exception)
            {
                throw Failure(
                    exception.Code,
                    exception.Message,
                    dispatchState,
                    requestPayload.Length,
                    requestFrame.Length,
                    bytesWrittenLowerBound,
                    requestFullyWritten,
                    responseBytesObserved,
                    exception);
            }

            if (processAttestor != null)
            {
                await processAttestor.VerifyAfterResponseAsync(
                    connectedPeer!,
                    processAttestation!,
                    transportLifetimeCancellation.Token).ConfigureAwait(false);
            }

            return new AddinCallResult(
                response,
                Evidence(
                    dispatchState,
                    requestPayload.Length,
                    requestFrame.Length,
                    bytesWrittenLowerBound,
                    requestFullyWritten,
                    responseBytesObserved),
                processAttestation);
        }
        catch (AddinTransportException)
        {
            throw;
        }
        catch (AddinProcessAttestationException exception)
        {
            throw Failure(
                exception.Code,
                exception.Message,
                dispatchState,
                requestPayload.Length,
                requestFrame.Length,
                bytesWrittenLowerBound,
                requestFullyWritten,
                responseBytesObserved,
                exception);
        }
        catch (OperationCanceledException exception)
        {
            throw CancellationFailure(
                call,
                preDispatchCancellationToken,
                transportShutdownToken,
                dispatchState,
                requestPayload.Length,
                requestFrame.Length,
                bytesWrittenLowerBound,
                requestFullyWritten,
                responseBytesObserved,
                exception);
        }
        catch (EndOfStreamException exception)
        {
            throw Failure(
                "addin_response_incomplete",
                "The add-in connection closed before the response frame completed.",
                dispatchState,
                requestPayload.Length,
                requestFrame.Length,
                bytesWrittenLowerBound,
                requestFullyWritten,
                responseBytesObserved,
                exception);
        }
        catch (Exception exception) when (
            exception is IOException or SocketException or ObjectDisposedException)
        {
            throw Failure(
                "addin_transport_io",
                "The add-in loopback connection failed during the call.",
                dispatchState,
                requestPayload.Length,
                requestFrame.Length,
                bytesWrittenLowerBound,
                requestFullyWritten,
                responseBytesObserved,
                exception);
        }
    }

    private static async Task ReadExactlyAsync(
        NetworkStream stream,
        byte[] destination,
        Action<int> bytesObserved,
        CancellationToken cancellationToken)
    {
        for (var offset = 0; offset < destination.Length;)
        {
            var bytesRead = await stream.ReadAsync(
                destination.AsMemory(offset),
                cancellationToken).ConfigureAwait(false);
            if (bytesRead == 0)
            {
                throw new EndOfStreamException(
                    "The add-in connection closed before the response frame completed.");
            }

            bytesObserved(bytesRead);
            offset += bytesRead;
        }
    }

    private static AddinTransportException CancellationFailure(
        AddinCall call,
        CancellationToken callerCancellationToken,
        CancellationToken shutdownCancellationToken,
        AddinDispatchState dispatchState,
        int requestPayloadBytes,
        int requestFrameBytes,
        int bytesWrittenLowerBound,
        bool requestFullyWritten,
        int responseBytesObserved,
        OperationCanceledException exception)
    {
        var shuttingDown = shutdownCancellationToken.IsCancellationRequested;
        var callerCancelled = callerCancellationToken.IsCancellationRequested;
        return Failure(
            shuttingDown
                ? "addin_transport_shutdown"
                : callerCancelled && dispatchState == AddinDispatchState.NotStarted
                    ? "addin_call_cancelled"
                    : "addin_call_timeout",
            shuttingDown
                ? "The add-in transport stopped with the bridge worker."
                : callerCancelled && dispatchState == AddinDispatchState.NotStarted
                    ? "The add-in call was cancelled before request dispatch."
                    : $"The add-in call exceeded its {call.Timeout.TotalMilliseconds:0} ms deadline.",
            dispatchState,
            requestPayloadBytes,
            requestFrameBytes,
            bytesWrittenLowerBound,
            requestFullyWritten,
            responseBytesObserved,
            exception);
    }

    private static AddinTransportException Failure(
        string code,
        string message,
        AddinDispatchState dispatchState,
        int requestPayloadBytes,
        int requestFrameBytes,
        int bytesWrittenLowerBound,
        bool requestFullyWritten,
        int responseBytesObserved,
        Exception? innerException = null) =>
        new(
            code,
            message,
            Evidence(
                dispatchState,
                requestPayloadBytes,
                requestFrameBytes,
                bytesWrittenLowerBound,
                requestFullyWritten,
                responseBytesObserved),
            innerException);

    private static AddinTransportEvidence Evidence(
        AddinDispatchState dispatchState,
        int requestPayloadBytes,
        int requestFrameBytes,
        int bytesWrittenLowerBound,
        bool requestFullyWritten,
        int responseBytesObserved) =>
        new(
            dispatchState,
            requestPayloadBytes,
            requestFrameBytes,
            bytesWrittenLowerBound,
            requestFullyWritten,
            responseBytesObserved);
}
