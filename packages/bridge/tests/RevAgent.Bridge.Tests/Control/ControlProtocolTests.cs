using RevAgent.Bridge.Bootstrap.Control;
using System.Buffers.Binary;
using System.Text;

namespace RevAgent.Bridge.Tests.Control;

public sealed class ControlProtocolTests
{
    [Fact]
    public void ReadyRoundTripsWithBigEndianFrame()
    {
        Guid instanceId = Guid.NewGuid();
        var ready = new WorkerReady(
            ControlProtocol.Version,
            instanceId,
            1234,
            "1.2.3");

        byte[] frame = ControlProtocol.Encode(ready);

        Assert.Equal(
            frame.Length - ControlProtocol.HeaderBytes,
            BinaryPrimitives.ReadInt32BigEndian(
                frame.AsSpan(0, ControlProtocol.HeaderBytes)));
        WorkerReady decoded = Assert.IsType<WorkerReady>(
            ControlProtocol.Decode(frame.AsSpan(ControlProtocol.HeaderBytes)));
        Assert.Equal(instanceId, decoded.InstanceId);
        Assert.Equal(1234, decoded.WorkerPid);
        Assert.Equal("1.2.3", decoded.WorkerVersion);
    }

    [Fact]
    public void StopAndStoppingRoundTrip()
    {
        Guid instanceId = Guid.NewGuid();
        var stop = new StopWorker(
            ControlProtocol.Version,
            instanceId,
            "scm_stop",
            1_800_000_000_000);
        var stopping = new WorkerStopping(
            ControlProtocol.Version,
            instanceId,
            4321);

        StopWorker decodedStop = Assert.IsType<StopWorker>(
            ControlProtocol.Decode(
                ControlProtocol.Encode(stop).AsSpan(ControlProtocol.HeaderBytes)));
        WorkerStopping decodedStopping = Assert.IsType<WorkerStopping>(
            ControlProtocol.Decode(
                ControlProtocol.Encode(stopping).AsSpan(ControlProtocol.HeaderBytes)));

        Assert.Equal(stop, decodedStop);
        Assert.Equal(stopping, decodedStopping);
    }

    [Fact]
    public void DuplicatePropertiesAreRejected()
    {
        Guid instanceId = Guid.NewGuid();
        byte[] payload = Encoding.UTF8.GetBytes(
            $$"""
            {"protocol_version":1,"protocol_version":1,"type":"ready","instance_id":"{{instanceId:D}}","worker_pid":1,"worker_version":"1.0"}
            """);

        ControlProtocolException error = Assert.Throws<ControlProtocolException>(
            () => ControlProtocol.Decode(payload));

        Assert.Equal("control_json_duplicate_property", error.Code);
    }

    [Fact]
    public void UnknownAdditivePropertiesAreIgnoredWithinVersion()
    {
        Guid instanceId = Guid.NewGuid();
        byte[] payload = Encoding.UTF8.GetBytes(
            "{\"protocol_version\":1,\"type\":\"ready\",\"instance_id\":\"" +
            instanceId.ToString("D") +
            "\",\"worker_pid\":7,\"worker_version\":\"1.0\"," +
            "\"future_field\":{\"safe\":true}}");

        WorkerReady ready = Assert.IsType<WorkerReady>(
            ControlProtocol.Decode(payload));

        Assert.Equal(7, ready.WorkerPid);
    }

    [Fact]
    public void WrongVersionAndOversizedPayloadFailClosed()
    {
        Guid instanceId = Guid.NewGuid();
        byte[] wrongVersion = Encoding.UTF8.GetBytes(
            $$"""
            {"protocol_version":2,"type":"ready","instance_id":"{{instanceId:D}}","worker_pid":7,"worker_version":"1.0"}
            """);

        ControlProtocolException versionError =
            Assert.Throws<ControlProtocolException>(
                () => ControlProtocol.Decode(wrongVersion));
        ControlProtocolException sizeError =
            Assert.Throws<ControlProtocolException>(
                () => ControlProtocol.Decode(
                    new byte[ControlProtocol.MaxFrameBytes + 1]));

        Assert.Equal("control_protocol_version_mismatch", versionError.Code);
        Assert.Equal("control_frame_size_invalid", sizeError.Code);
    }

    [Fact]
    public async Task ConnectionReportsCleanEofAndRejectsTruncation()
    {
        Guid instanceId = Guid.NewGuid();
        byte[] frame = ControlProtocol.Encode(
            new WorkerReady(
                ControlProtocol.Version,
                instanceId,
                99,
                "test"));
        await using var connection = new ControlConnection(
            new MemoryStream(frame, writable: true),
            instanceId);

        Assert.IsType<WorkerReady>(
            await connection.ReceiveAsync(CancellationToken.None));
        Assert.Null(await connection.ReceiveAsync(CancellationToken.None));

        await using var truncated = new ControlConnection(
            new MemoryStream([0, 0], writable: true),
            instanceId);
        ControlProtocolException error =
            await Assert.ThrowsAsync<ControlProtocolException>(
                async () => await truncated.ReceiveAsync(CancellationToken.None));
        Assert.Equal("control_frame_truncated", error.Code);
    }

    [Fact]
    public async Task ConnectionRejectsWrongInstanceBeforeWriting()
    {
        Guid expected = Guid.NewGuid();
        await using var stream = new MemoryStream();
        await using var connection = new ControlConnection(stream, expected);

        ControlProtocolException error =
            await Assert.ThrowsAsync<ControlProtocolException>(
                async () => await connection.SendAsync(
                    new WorkerReady(
                        ControlProtocol.Version,
                        Guid.NewGuid(),
                        1,
                        "test"),
                    CancellationToken.None));

        Assert.Equal("control_instance_mismatch", error.Code);
        Assert.Equal(0, stream.Length);
    }

    [Fact]
    public void EncodeRejectsInvalidOutgoingMessage()
    {
        ControlProtocolException error =
            Assert.Throws<ControlProtocolException>(
                () => ControlProtocol.Encode(
                    new WorkerReady(
                        ControlProtocol.Version,
                        Guid.NewGuid(),
                        0,
                        "test")));

        Assert.Equal("control_ready_invalid", error.Code);
    }
}
