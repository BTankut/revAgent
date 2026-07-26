namespace RevAgent.Bridge.Bootstrap.Control;

internal sealed class ControlConnection : IAsyncDisposable
{
    private readonly Stream _stream;
    private readonly Guid _expectedInstanceId;
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    private readonly SemaphoreSlim _receiveGate = new(1, 1);
    private int _disposed;

    internal ControlConnection(Stream stream, Guid expectedInstanceId)
    {
        _stream = stream ?? throw new ArgumentNullException(nameof(stream));
        if (!stream.CanRead || !stream.CanWrite)
        {
            throw new ArgumentException(
                "Control stream must be readable and writable.",
                nameof(stream));
        }

        _expectedInstanceId = expectedInstanceId;
    }

    internal async ValueTask SendAsync(
        ControlMessage message,
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        if (message.InstanceId != _expectedInstanceId)
        {
            throw new ControlProtocolException(
                "control_instance_mismatch",
                $"Control message instance '{message.InstanceId:D}' does not match " +
                $"connection instance '{_expectedInstanceId:D}'.");
        }

        byte[] frame = ControlProtocol.Encode(message);
        await _sendGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThrowIfDisposed();
            await _stream.WriteAsync(frame, cancellationToken).ConfigureAwait(false);
            await _stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _sendGate.Release();
        }
    }

    internal async ValueTask<ControlMessage?> ReceiveAsync(
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        await _receiveGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThrowIfDisposed();
            var header = new byte[ControlProtocol.HeaderBytes];
            int headerBytes = await ReadExactAsync(
                header,
                allowCleanEof: true,
                cancellationToken).ConfigureAwait(false);
            if (headerBytes == 0)
            {
                return null;
            }

            int payloadLength = ControlProtocol.ReadFrameLength(header);
            var payload = new byte[payloadLength];
            _ = await ReadExactAsync(
                payload,
                allowCleanEof: false,
                cancellationToken).ConfigureAwait(false);

            ControlMessage message = ControlProtocol.Decode(payload);
            if (message.InstanceId != _expectedInstanceId)
            {
                throw new ControlProtocolException(
                    "control_instance_mismatch",
                    $"Received instance '{message.InstanceId:D}' does not match " +
                    $"connection instance '{_expectedInstanceId:D}'.");
            }

            return message;
        }
        finally
        {
            _receiveGate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        try
        {
            await _stream.DisposeAsync().ConfigureAwait(false);
        }
        finally
        {
            _sendGate.Dispose();
            _receiveGate.Dispose();
        }
    }

    private async ValueTask<int> ReadExactAsync(
        Memory<byte> destination,
        bool allowCleanEof,
        CancellationToken cancellationToken)
    {
        int total = 0;
        while (total < destination.Length)
        {
            int read = await _stream.ReadAsync(
                destination[total..],
                cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                if (allowCleanEof && total == 0)
                {
                    return 0;
                }

                throw new ControlProtocolException(
                    "control_frame_truncated",
                    $"Control stream ended after {total} of {destination.Length} expected bytes.");
            }

            total += read;
        }

        return total;
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(
            Volatile.Read(ref _disposed) != 0,
            this);
    }
}
