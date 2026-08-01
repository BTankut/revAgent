using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Threading.Channels;
using RevAgent.Bridge.Gateway.Connection;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

internal sealed record RecordedHttpRequest(
    HttpMethod Method,
    Uri Uri,
    Version Version,
    HttpVersionPolicy VersionPolicy,
    IReadOnlyDictionary<string, string[]> Headers,
    byte[] Body)
{
    internal string[] Header(string name) =>
        Headers.TryGetValue(name, out string[]? values)
            ? values
            : Array.Empty<string>();
}

internal sealed class ScriptedHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<
        RecordedHttpRequest,
        CancellationToken,
        Task<HttpResponseMessage>> _responder;

    internal ScriptedHttpMessageHandler(
        Func<
            RecordedHttpRequest,
            CancellationToken,
            Task<HttpResponseMessage>> responder)
    {
        _responder = responder;
    }

    internal ConcurrentQueue<RecordedHttpRequest> Requests { get; } = new();

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        var headers = new Dictionary<string, string[]>(
            StringComparer.OrdinalIgnoreCase);
        foreach ((string name, IEnumerable<string> values) in request.Headers)
        {
            headers[name] = values.ToArray();
        }

        byte[] body = Array.Empty<byte>();
        if (request.Content is not null)
        {
            foreach ((string name, IEnumerable<string> values) in
                     request.Content.Headers)
            {
                headers[name] = values.ToArray();
            }

            body = await request.Content
                .ReadAsByteArrayAsync(cancellationToken);
        }

        var recorded = new RecordedHttpRequest(
            request.Method,
            request.RequestUri ??
            throw new InvalidOperationException("Request URI is absent."),
            request.Version,
            request.VersionPolicy,
            headers,
            body);
        Requests.Enqueue(recorded);
        return await _responder(recorded, cancellationToken);
    }
}

internal sealed class FixedHttpClientFactory : IRbpHttpClientFactory
{
    private readonly HttpMessageHandler _handler;

    internal FixedHttpClientFactory(HttpMessageHandler handler)
    {
        _handler = handler;
    }

    public HttpClient Create() =>
        new(_handler, disposeHandler: false)
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
}

internal sealed class PushSseStream : Stream
{
    private readonly Channel<byte[]> _segments =
        Channel.CreateUnbounded<byte[]>(
            new UnboundedChannelOptions
            {
                SingleReader = true,
                SingleWriter = false,
            });
    private byte[]? _current;
    private int _offset;
    private int _disposed;

    internal void WriteUtf8(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        WriteBytes(Encoding.UTF8.GetBytes(value));
    }

    internal void WriteBytes(byte[] value)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (Volatile.Read(ref _disposed) != 0 ||
            !_segments.Writer.TryWrite(value.ToArray()))
        {
            throw new InvalidOperationException(
                "The scripted SSE stream is closed.");
        }
    }

    internal void Complete(Exception? exception = null)
    {
        if (exception is null)
        {
            _segments.Writer.TryComplete();
        }
        else
        {
            _segments.Writer.TryComplete(exception);
        }
    }

    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length =>
        throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override void Flush()
    {
    }

    public override int Read(
        byte[] buffer,
        int offset,
        int count) =>
        ReadAsync(buffer.AsMemory(offset, count))
            .AsTask()
            .GetAwaiter()
            .GetResult();

    public override async ValueTask<int> ReadAsync(
        Memory<byte> buffer,
        CancellationToken cancellationToken = default)
    {
        while (_current is null || _offset >= _current.Length)
        {
            if (!await _segments.Reader
                    .WaitToReadAsync(cancellationToken))
            {
                return 0;
            }

            if (_segments.Reader.TryRead(out byte[]? next))
            {
                _current = next;
                _offset = 0;
            }
        }

        int count = Math.Min(buffer.Length, _current.Length - _offset);
        _current.AsMemory(_offset, count).CopyTo(buffer);
        _offset += count;
        return count;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing &&
            Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            _segments.Writer.TryComplete();
        }

        base.Dispose(disposing);
    }

    public override long Seek(long offset, SeekOrigin origin) =>
        throw new NotSupportedException();

    public override void SetLength(long value) =>
        throw new NotSupportedException();

    public override void Write(
        byte[] buffer,
        int offset,
        int count) =>
        throw new NotSupportedException();
}

internal sealed class ThrowingReadStream : Stream
{
    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length =>
        throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override void Flush()
    {
    }

    public override int Read(
        byte[] buffer,
        int offset,
        int count) =>
        throw new IOException("scripted response reset");

    public override ValueTask<int> ReadAsync(
        Memory<byte> buffer,
        CancellationToken cancellationToken = default) =>
        ValueTask.FromException<int>(
            new IOException("scripted response reset"));

    public override long Seek(long offset, SeekOrigin origin) =>
        throw new NotSupportedException();

    public override void SetLength(long value) =>
        throw new NotSupportedException();

    public override void Write(
        byte[] buffer,
        int offset,
        int count) =>
        throw new NotSupportedException();
}

internal sealed class FixedEnrollmentProvider :
    IRbpEnrollmentStateProvider
{
    private readonly RbpEnrollmentSnapshot _snapshot;

    internal FixedEnrollmentProvider(RbpDeviceCredential credential)
    {
        _snapshot = RbpEnrollmentSnapshot.Ready(credential);
    }

    public ValueTask<RbpEnrollmentSnapshot> ReadAsync(
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(_snapshot);
    }
}

internal static class StreamableHttpResponses
{
    internal static HttpResponseMessage Created(
        string connectionId,
        byte[] helloAck)
    {
        var response = new HttpResponseMessage(HttpStatusCode.Created)
        {
            Content = new ByteArrayContent(helloAck),
        };
        response.Headers.TryAddWithoutValidation(
            "RBP-Connection-Id",
            connectionId);
        response.Content.Headers.ContentType =
            new System.Net.Http.Headers.MediaTypeHeaderValue(
                "application/json");
        return response;
    }

    internal static HttpResponseMessage Events(PushSseStream stream)
    {
        var response = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StreamContent(stream),
        };
        response.Content.Headers.ContentType =
            new System.Net.Http.Headers.MediaTypeHeaderValue(
                "text/event-stream");
        return response;
    }
}
