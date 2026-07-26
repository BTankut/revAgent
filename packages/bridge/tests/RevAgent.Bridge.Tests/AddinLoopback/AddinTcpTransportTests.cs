using System.Net;
using System.Net.Sockets;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Contracts.AddinLoopback;

namespace RevAgent.Bridge.Tests.AddinLoopback;

public sealed class AddinTcpTransportTests
{
    [Fact]
    public async Task InvokeAsync_FragmentedResponsePreservesExactInvocationId()
    {
        JObject? observedRequest = null;
        await using var peer = new ScriptedTcpPeer(
            async (stream, cancellationToken) =>
            {
                observedRequest = await ScriptedTcpPeer.ReadRequestAsync(
                    stream,
                    cancellationToken);
                var frame = ScriptedTcpPeer.SuccessFrame(
                    "019f9add-7a83-7d11-a6a9-d2f8108c1001",
                    new JObject { ["value"] = "ok" });
                await ScriptedTcpPeer.WriteChunksAsync(
                    stream,
                    frame,
                    new[] { 1, 1, 2, 1, 8191 },
                    cancellationToken);
            });

        var call = Call("019f9add-7a83-7d11-a6a9-d2f8108c1001");
        var result = await new AddinTcpTransport().InvokeAsync(
            AddinEndpoint.Ipv4Loopback(peer.Port),
            call);

        Assert.NotNull(observedRequest);
        Assert.Equal(call.InvocationId, observedRequest!["id"]!.Value<string>());
        Assert.Equal("fixture_echo", observedRequest["method"]!.Value<string>());
        Assert.Equal(call.InvocationId, result.Response.Id);
        Assert.Equal("ok", result.Response.Result!["value"]!.Value<string>());
        Assert.Equal(AddinDispatchState.ResponseObserved, result.Evidence.DispatchState);
        Assert.True(result.Evidence.RequestFullyWritten);
        Assert.Equal(result.Evidence.RequestFrameBytes, result.Evidence.BytesWrittenLowerBound);
        Assert.True(result.Evidence.ResponseStarted);
        Assert.Equal(1, peer.AcceptCount);
    }

    [Fact]
    public async Task InvokeAsync_MismatchedResponseIdFaultsWithoutScanningAhead()
    {
        await using var peer = new ScriptedTcpPeer(
            async (stream, cancellationToken) =>
            {
                await ScriptedTcpPeer.ReadRequestAsync(stream, cancellationToken);
                var stale = ScriptedTcpPeer.SuccessFrame("stale-id");
                var matching = ScriptedTcpPeer.SuccessFrame("invocation-exact");
                var coalesced = new byte[stale.Length + matching.Length];
                Buffer.BlockCopy(stale, 0, coalesced, 0, stale.Length);
                Buffer.BlockCopy(matching, 0, coalesced, stale.Length, matching.Length);
                await stream.WriteAsync(coalesced, cancellationToken);
            });

        var error = await Assert.ThrowsAsync<AddinTransportException>(
            () => new AddinTcpTransport().InvokeAsync(
                AddinEndpoint.Ipv4Loopback(peer.Port),
                Call("invocation-exact")));

        Assert.Equal("response_id_mismatch", error.Code);
        Assert.Equal(AddinDispatchState.ResponseObserved, error.Evidence.DispatchState);
        Assert.True(error.Evidence.RequestFullyWritten);
        Assert.Equal(1, peer.AcceptCount);
    }

    [Fact]
    public async Task InvokeAsync_ReadTimeoutIsPossiblyDispatchedAndNeverRetried()
    {
        var clientEofObserved = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new ScriptedTcpPeer(
            async (stream, cancellationToken) =>
            {
                await ScriptedTcpPeer.ReadRequestAsync(stream, cancellationToken);
                var buffer = new byte[1];
                var bytesRead = await stream.ReadAsync(buffer, cancellationToken);
                if (bytesRead != 0)
                {
                    throw new InvalidOperationException(
                        "Timed-out transport wrote unexpected trailing bytes.");
                }

                clientEofObserved.SetResult();
            });

        var error = await Assert.ThrowsAsync<AddinTransportException>(
            () => new AddinTcpTransport().InvokeAsync(
                AddinEndpoint.Ipv4Loopback(peer.Port),
                Call("timeout-id", timeout: TimeSpan.FromSeconds(1))));

        Assert.Equal("addin_call_timeout", error.Code);
        Assert.Equal(
            AddinDispatchState.MayHaveReachedAddin,
            error.Evidence.DispatchState);
        Assert.True(error.Evidence.RequestFullyWritten);
        await clientEofObserved.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await Task.Delay(TimeSpan.FromMilliseconds(250));
        Assert.Equal(1, peer.AcceptCount);
    }

    [Fact]
    public async Task InvokeAsync_PostDispatchCallerCancellationStillObservesOutcome()
    {
        var requestReceived = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseResponse = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new ScriptedTcpPeer(
            async (stream, cancellationToken) =>
            {
                var request = await ScriptedTcpPeer.ReadRequestAsync(
                    stream,
                    cancellationToken);
                requestReceived.SetResult();
                await releaseResponse.Task.WaitAsync(cancellationToken);
                var response = ScriptedTcpPeer.SuccessFrame(
                    request["id"]!.Value<string>()!);
                await stream.WriteAsync(response, cancellationToken);
            });
        using var cancellation = new CancellationTokenSource();

        var invocation = new AddinTcpTransport().InvokeAsync(
            AddinEndpoint.Ipv4Loopback(peer.Port),
            Call("cancel-id", timeout: TimeSpan.FromSeconds(5)),
            cancellation.Token);
        await requestReceived.Task.WaitAsync(TimeSpan.FromSeconds(2));
        cancellation.Cancel();
        await Task.Delay(TimeSpan.FromMilliseconds(100));
        Assert.False(invocation.IsCompleted);
        releaseResponse.SetResult();

        var result = await invocation;

        Assert.Equal(
            AddinDispatchState.ResponseObserved,
            result.Evidence.DispatchState);
        Assert.True(result.Evidence.RequestFullyWritten);
        await Task.Delay(TimeSpan.FromMilliseconds(250));
        Assert.Equal(1, peer.AcceptCount);
    }

    [Fact]
    public async Task InvokeAsync_PostDispatchWorkerShutdownClosesWithUncertainEvidence()
    {
        var requestReceived = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var clientEofObserved = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new ScriptedTcpPeer(
            async (stream, cancellationToken) =>
            {
                await ScriptedTcpPeer.ReadRequestAsync(stream, cancellationToken);
                requestReceived.SetResult();
                var buffer = new byte[1];
                var bytesRead = await stream.ReadAsync(buffer, cancellationToken);
                if (bytesRead != 0)
                {
                    throw new InvalidOperationException(
                        "Shutdown transport wrote unexpected trailing bytes.");
                }

                clientEofObserved.SetResult();
            });
        using var shutdown = new CancellationTokenSource();

        var invocation = new AddinTcpTransport().InvokeAsync(
            AddinEndpoint.Ipv4Loopback(peer.Port),
            Call("shutdown-id", timeout: TimeSpan.FromSeconds(5)),
            preDispatchCancellationToken: default,
            transportShutdownToken: shutdown.Token);
        await requestReceived.Task.WaitAsync(TimeSpan.FromSeconds(2));
        shutdown.Cancel();

        var error = await Assert.ThrowsAsync<AddinTransportException>(
            () => invocation);

        Assert.Equal("addin_transport_shutdown", error.Code);
        Assert.Equal(
            AddinDispatchState.MayHaveReachedAddin,
            error.Evidence.DispatchState);
        Assert.True(error.Evidence.RequestFullyWritten);
        await clientEofObserved.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await Task.Delay(TimeSpan.FromMilliseconds(250));
        Assert.Equal(1, peer.AcceptCount);
    }

    [Fact]
    public async Task InvokeAsync_PreCancelledCallConnectsAndWritesNothing()
    {
        await using var peer = new ScriptedTcpPeer(
            (_, cancellationToken) =>
                Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        var error = await Assert.ThrowsAsync<AddinTransportException>(
            () => new AddinTcpTransport().InvokeAsync(
                AddinEndpoint.Ipv4Loopback(peer.Port),
                Call("pre-cancelled"),
                cancellation.Token));

        Assert.Equal("addin_call_cancelled", error.Code);
        Assert.Equal(AddinDispatchState.NotStarted, error.Evidence.DispatchState);
        Assert.Equal(0, error.Evidence.BytesWrittenLowerBound);
        Assert.Equal(0, peer.AcceptCount);
    }

    [Fact]
    public async Task InvokeAsync_PreCancelledWorkerShutdownConnectsAndWritesNothing()
    {
        await using var peer = new ScriptedTcpPeer(
            (_, cancellationToken) =>
                Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken));
        using var shutdown = new CancellationTokenSource();
        shutdown.Cancel();

        var error = await Assert.ThrowsAsync<AddinTransportException>(
            () => new AddinTcpTransport().InvokeAsync(
                AddinEndpoint.Ipv4Loopback(peer.Port),
                Call("pre-shutdown"),
                preDispatchCancellationToken: default,
                transportShutdownToken: shutdown.Token));

        Assert.Equal("addin_transport_shutdown", error.Code);
        Assert.Equal(AddinDispatchState.NotStarted, error.Evidence.DispatchState);
        Assert.Equal(0, error.Evidence.BytesWrittenLowerBound);
        Assert.Equal(0, peer.AcceptCount);
    }

    [Fact]
    public async Task InvokeAsync_InvalidUtf16FailsBeforeConnectWithEvidence()
    {
        await using var peer = new ScriptedTcpPeer(
            (_, cancellationToken) =>
                Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken));
        var call = new AddinCall(
            "invalid-utf16",
            "fixture_echo",
            new JObject { ["value"] = new string('\uD800', 1) },
            TimeSpan.FromSeconds(2));

        var error = await Assert.ThrowsAsync<AddinTransportException>(
            () => new AddinTcpTransport().InvokeAsync(
                AddinEndpoint.Ipv4Loopback(peer.Port),
                call));

        Assert.Equal("invalid_utf16", error.Code);
        Assert.Equal(AddinDispatchState.NotStarted, error.Evidence.DispatchState);
        Assert.Equal(0, error.Evidence.BytesWrittenLowerBound);
        Assert.Equal(0, peer.AcceptCount);
    }

    [Fact]
    public async Task InvokeAsync_OversizedRequestFailsBeforeConnect()
    {
        await using var peer = new ScriptedTcpPeer(
            (_, cancellationToken) =>
                Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken));
        var parameters = new JObject
        {
            ["payload"] = new string(
                'x',
                AddinFrameLimits.MinimumRequestPayloadBytes),
        };
        var call = new AddinCall(
            "oversize-id",
            "fixture_echo",
            parameters,
            TimeSpan.FromSeconds(2),
            AddinFrameLimits.MinimumRequestPayloadBytes);

        var error = await Assert.ThrowsAsync<AddinTransportException>(
            () => new AddinTcpTransport().InvokeAsync(
                AddinEndpoint.Ipv4Loopback(peer.Port),
                call));

        Assert.Equal("frame_payload_too_large", error.Code);
        Assert.Equal(AddinDispatchState.NotStarted, error.Evidence.DispatchState);
        Assert.Equal(0, error.Evidence.BytesWrittenLowerBound);
        Assert.Equal(0, peer.AcceptCount);
    }

    [Fact]
    public async Task InvokeAsync_PartialHeaderEofReportsObservedResponse()
    {
        await using var peer = new ScriptedTcpPeer(
            async (stream, cancellationToken) =>
            {
                await ScriptedTcpPeer.ReadRequestAsync(stream, cancellationToken);
                await stream.WriteAsync(
                    new byte[] { 0, 0 },
                    cancellationToken);
            });

        var error = await Assert.ThrowsAsync<AddinTransportException>(
            () => new AddinTcpTransport().InvokeAsync(
                AddinEndpoint.Ipv4Loopback(peer.Port),
                Call("partial-header")));

        Assert.Equal("addin_response_incomplete", error.Code);
        Assert.Equal(AddinDispatchState.ResponseObserved, error.Evidence.DispatchState);
        Assert.Equal(2, error.Evidence.ResponseBytesObserved);
    }

    [Fact]
    public async Task InvokeAsync_PartialPayloadEofReportsObservedByteCount()
    {
        await using var peer = new ScriptedTcpPeer(
            async (stream, cancellationToken) =>
            {
                await ScriptedTcpPeer.ReadRequestAsync(stream, cancellationToken);
                var header = new byte[AddinFrameLimits.HeaderBytes];
                LengthPrefixedFrameCodec.WritePayloadLength(header, 0, 10);
                await stream.WriteAsync(header, cancellationToken);
                await stream.WriteAsync(
                    new byte[] { (byte)'{', (byte)'"', (byte)'x' },
                    cancellationToken);
            });

        var error = await Assert.ThrowsAsync<AddinTransportException>(
            () => new AddinTcpTransport().InvokeAsync(
                AddinEndpoint.Ipv4Loopback(peer.Port),
                Call("partial-payload")));

        Assert.Equal("addin_response_incomplete", error.Code);
        Assert.Equal(AddinDispatchState.ResponseObserved, error.Evidence.DispatchState);
        Assert.Equal(7, error.Evidence.ResponseBytesObserved);
    }

    [Fact]
    public async Task InvokeAsync_InvalidUtf8ResponseIsTerminalProtocolFault()
    {
        await using var peer = new ScriptedTcpPeer(
            async (stream, cancellationToken) =>
            {
                await ScriptedTcpPeer.ReadRequestAsync(stream, cancellationToken);
                var frame = LengthPrefixedFrameCodec.EncodePayload(
                    new byte[] { 0xFF },
                    AddinFrameLimits.MaxResponsePayloadBytes);
                await stream.WriteAsync(frame, cancellationToken);
            });

        var error = await Assert.ThrowsAsync<AddinTransportException>(
            () => new AddinTcpTransport().InvokeAsync(
                AddinEndpoint.Ipv4Loopback(peer.Port),
                Call("invalid-utf8")));

        Assert.Equal("invalid_utf8", error.Code);
        Assert.Equal(AddinDispatchState.ResponseObserved, error.Evidence.DispatchState);
        Assert.True(error.Evidence.RequestFullyWritten);
    }

    [Fact]
    public async Task InvokeAsync_OversizedResponseHeaderFailsWithoutReadingBody()
    {
        await using var peer = new ScriptedTcpPeer(
            async (stream, cancellationToken) =>
            {
                await ScriptedTcpPeer.ReadRequestAsync(stream, cancellationToken);
                var header = new byte[AddinFrameLimits.HeaderBytes];
                LengthPrefixedFrameCodec.WritePayloadLength(
                    header,
                    0,
                    (uint)AddinFrameLimits.MaxResponsePayloadBytes + 1);
                await stream.WriteAsync(header, cancellationToken);
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            });

        var error = await Assert.ThrowsAsync<AddinTransportException>(
            () => new AddinTcpTransport().InvokeAsync(
                AddinEndpoint.Ipv4Loopback(peer.Port),
                Call("oversized-response")));

        Assert.Equal("response_frame_too_large", error.Code);
        Assert.Equal(AddinDispatchState.ResponseObserved, error.Evidence.DispatchState);
        Assert.Equal(AddinFrameLimits.HeaderBytes, error.Evidence.ResponseBytesObserved);
    }

    [Fact]
    public async Task InvokeAsync_UnreachableEndpointIsKnownNotDispatched()
    {
        using var reservedNonListener = new Socket(
            AddressFamily.InterNetwork,
            SocketType.Stream,
            ProtocolType.Tcp);
        reservedNonListener.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        var port = ((IPEndPoint)reservedNonListener.LocalEndPoint!).Port;

        var error = await Assert.ThrowsAsync<AddinTransportException>(
            () => new AddinTcpTransport().InvokeAsync(
                AddinEndpoint.Ipv4Loopback(port),
                Call(
                    "connect-refused",
                    timeout: TimeSpan.FromMilliseconds(250))));

        Assert.Contains(
            error.Code,
            new[] { "addin_connect_failed", "addin_call_timeout" });
        Assert.Equal(AddinDispatchState.NotStarted, error.Evidence.DispatchState);
        Assert.Equal(0, error.Evidence.BytesWrittenLowerBound);
    }

    private static AddinCall Call(
        string invocationId,
        TimeSpan? timeout = null) =>
        new(
            invocationId,
            "fixture_echo",
            new JObject { ["value"] = "hello" },
            timeout ?? TimeSpan.FromSeconds(2));
}
