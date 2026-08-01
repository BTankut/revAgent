using RevAgent.Bridge.Bootstrap.Control;

namespace RevAgent.Bridge.Tests.Control;

/// <summary>
/// The worker parks in <see cref="ControlConnection.ReceiveAsync"/> for its
/// whole life. When shutdown is reached from anywhere other than a host
/// control message, <c>WorkerControlService.StopAsync</c> disposes the
/// connection while that receive is still parked. These tests pin the
/// ordering that production hit: the connection finishes disposing before the
/// parked read unwinds, so the receive's release must still be safe.
/// </summary>
public sealed class ControlConnectionDisposeTests
{
    [Fact]
    public async Task ParkedReceiveThatUnwindsAfterDisposeDoesNotFaultOnTheGate()
    {
        using var stream = new BlockingControlStream();
        var connection = new ControlConnection(stream, Guid.NewGuid());
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        Task<ControlMessage?> parked = connection
            .ReceiveAsync(timeout.Token)
            .AsTask();
        await stream.ReadStarted.WaitAsync(timeout.Token);

        // Dispose runs to completion first; the parked read is still holding
        // the receive gate at this point, exactly as it does in the service.
        await connection.DisposeAsync();
        stream.FailPendingRead();

        Exception? observed = await Record.ExceptionAsync(async () => await parked);

        Assert.IsNotType<ObjectDisposedException>(observed);
        Assert.IsType<IOException>(observed);
    }

    [Fact]
    public async Task ParkedSendThatUnwindsAfterDisposeDoesNotFaultOnTheGate()
    {
        using var stream = new BlockingControlStream();
        Guid instanceId = Guid.NewGuid();
        var connection = new ControlConnection(stream, instanceId);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        Task parked = connection
            .SendAsync(
                new WorkerStopping(
                    ControlProtocol.Version,
                    instanceId,
                    Environment.ProcessId),
                timeout.Token)
            .AsTask();
        await stream.WriteStarted.WaitAsync(timeout.Token);

        await connection.DisposeAsync();
        stream.FailPendingWrite();

        Exception? observed = await Record.ExceptionAsync(async () => await parked);

        Assert.IsNotType<ObjectDisposedException>(observed);
        Assert.IsType<IOException>(observed);
    }

    /// <summary>
    /// A stream whose read and write park until the test releases them, so
    /// disposal is guaranteed to complete while the operation still holds its
    /// gate. A real pipe cannot express that ordering reliably.
    /// </summary>
    private sealed class BlockingControlStream : Stream
    {
        private readonly TaskCompletionSource _readStarted =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _writeStarted =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<int> _readResult =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _writeResult =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal Task ReadStarted => _readStarted.Task;

        internal Task WriteStarted => _writeStarted.Task;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => true;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        internal void FailPendingRead() =>
            _readResult.TrySetException(new IOException("control pipe closed"));

        internal void FailPendingWrite() =>
            _writeResult.TrySetException(new IOException("control pipe closed"));

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            _readStarted.TrySetResult();
            return await _readResult.Task.WaitAsync(cancellationToken)
                .ConfigureAwait(false);
        }

        public override async ValueTask WriteAsync(
            ReadOnlyMemory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            _writeStarted.TrySetResult();
            await _writeResult.Task.WaitAsync(cancellationToken)
                .ConfigureAwait(false);
        }

        public override Task FlushAsync(CancellationToken cancellationToken) =>
            Task.CompletedTask;

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) =>
            throw new NotSupportedException();

        public override void SetLength(long value) =>
            throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();
    }
}
