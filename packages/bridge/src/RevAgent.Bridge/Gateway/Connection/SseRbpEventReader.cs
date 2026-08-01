using System.Text;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed class SseRbpEventReader
{
    private const int MaximumLineBytes =
        RbpProtocolLimits.MaximumWireFrameBytes + 16;
    private static readonly UTF8Encoding StrictUtf8 =
        new(
            encoderShouldEmitUTF8Identifier: false,
            throwOnInvalidBytes: true);

    private readonly Stream _stream;
    private readonly byte[] _readBuffer = new byte[16 * 1024];
    private int _readOffset;
    private int _readLength;
    private int _pendingByte = -1;
    private bool _firstLine = true;

    internal SseRbpEventReader(Stream stream)
    {
        _stream = stream ?? throw new ArgumentNullException(nameof(stream));
    }

    internal async Task<byte[]> ReadAsync(
        CancellationToken cancellationToken)
    {
        string? eventName = null;
        byte[]? data = null;
        while (true)
        {
            byte[]? lineBytes =
                await ReadLineAsync(cancellationToken)
                    .ConfigureAwait(false);
            if (lineBytes is null)
            {
                throw new RbpGatewayTransportException(
                    RbpGatewayFailureKind.RemoteClosed,
                    "The fallback SSE stream reached EOF.");
            }

            string line;
            try
            {
                line = StrictUtf8.GetString(lineBytes);
            }
            catch (DecoderFallbackException exception)
            {
                throw RbpHttpBindingProtocol.Protocol(
                    "The fallback SSE stream is not valid UTF-8.",
                    exception);
            }

            if (_firstLine)
            {
                _firstLine = false;
                if (line.StartsWith('\uFEFF'))
                {
                    line = line[1..];
                }
            }

            if (line.Length == 0)
            {
                if (eventName is null && data is null)
                {
                    continue;
                }

                if (!string.Equals(
                        eventName,
                        "rbp",
                        StringComparison.Ordinal) ||
                    data is null)
                {
                    throw RbpHttpBindingProtocol.Protocol(
                        "The fallback SSE event must contain exactly one " +
                        "event: rbp field and one data field.");
                }

                return data;
            }

            if (line[0] == ':')
            {
                continue;
            }

            int delimiter = line.IndexOf(':');
            string field = delimiter < 0
                ? line
                : line[..delimiter];
            string value = delimiter < 0
                ? string.Empty
                : line[(delimiter + 1)..];
            if (value.StartsWith(' '))
            {
                value = value[1..];
            }

            switch (field)
            {
                case "event":
                    if (eventName is not null)
                    {
                        throw RbpHttpBindingProtocol.Protocol(
                            "The fallback SSE event repeats event:.");
                    }

                    eventName = value;
                    break;
                case "data":
                    if (data is not null)
                    {
                        throw RbpHttpBindingProtocol.Protocol(
                            "The fallback SSE event contains multi-line data.");
                    }

                    data = StrictUtf8.GetBytes(value);
                    if (data.Length >
                        RbpProtocolLimits.MaximumWireFrameBytes)
                    {
                        throw RbpHttpBindingProtocol.Protocol(
                            "The fallback SSE data exceeds the frozen RBP " +
                            "wire limit.");
                    }

                    break;
                case "id":
                    // Deliberately ignored. RBP seq/ack is the only replay
                    // authority and Last-Event-ID is never emitted.
                    break;
                default:
                    // SSE fields that are not part of the frozen RBP event
                    // have no authority and are ignored.
                    break;
            }
        }
    }

    private async Task<byte[]?> ReadLineAsync(
        CancellationToken cancellationToken)
    {
        using var line = new MemoryStream();
        while (true)
        {
            int value = await ReadByteAsync(cancellationToken)
                .ConfigureAwait(false);
            if (value < 0)
            {
                return line.Length == 0 ? null : line.ToArray();
            }

            if (value == '\n')
            {
                return line.ToArray();
            }

            if (value == '\r')
            {
                int next = await ReadByteAsync(cancellationToken)
                    .ConfigureAwait(false);
                if (next >= 0 && next != '\n')
                {
                    _pendingByte = next;
                }

                return line.ToArray();
            }

            if (line.Length >= MaximumLineBytes)
            {
                throw RbpHttpBindingProtocol.Protocol(
                    "The fallback SSE line exceeds the frozen RBP limit.");
            }

            line.WriteByte((byte)value);
        }
    }

    private async ValueTask<int> ReadByteAsync(
        CancellationToken cancellationToken)
    {
        if (_pendingByte >= 0)
        {
            int value = _pendingByte;
            _pendingByte = -1;
            return value;
        }

        if (_readOffset >= _readLength)
        {
            _readLength = await _stream.ReadAsync(
                    _readBuffer.AsMemory(),
                    cancellationToken)
                .ConfigureAwait(false);
            _readOffset = 0;
            if (_readLength == 0)
            {
                return -1;
            }
        }

        return _readBuffer[_readOffset++];
    }
}
