using System.Text.Json;
using RevAgent.Bridge.Bootstrap.Logging;

namespace RevAgent.Bridge.Tests.Logging;

public sealed class RollingJsonBridgeLogTests
{
    [Fact]
    public async Task WriteAsync_EmitsDeterministicJsonLineWithRequiredFields()
    {
        using var directory = TemporaryDirectory.Create();
        var time = new ManualTimeProvider(
            new DateTimeOffset(2026, 7, 26, 12, 34, 56, TimeSpan.Zero));
        await using var log = new RollingJsonBridgeLog(
            directory.Path,
            "host",
            maxFileBytes: 1024 * 1024,
            retainedFileCount: 3,
            time);

        await log.WriteAsync(
            "information",
            "bridge_started",
            "lifecycle",
            "Bridge\nstarted.");

        var file = Assert.Single(Directory.GetFiles(directory.Path, "host-*.jsonl"));
        var bytes = await File.ReadAllBytesAsync(file);
        Assert.False(bytes.AsSpan().StartsWith(new byte[] { 0xEF, 0xBB, 0xBF }));
        Assert.Equal((byte)'\n', bytes[^1]);

        var line = Assert.Single(await File.ReadAllLinesAsync(file));
        using var document = JsonDocument.Parse(line);
        var properties = document.RootElement
            .EnumerateObject()
            .Select(property => property.Name)
            .ToArray();

        Assert.Equal(
            new[]
            {
                "timestampUtc",
                "level",
                "eventId",
                "category",
                "message",
                "exception",
            },
            properties);
        Assert.Equal(
            "2026-07-26T12:34:56.0000000+00:00",
            document.RootElement.GetProperty("timestampUtc").GetString());
        Assert.Equal(
            "information",
            document.RootElement.GetProperty("level").GetString());
        Assert.Equal(
            "bridge_started",
            document.RootElement.GetProperty("eventId").GetString());
        Assert.Equal(
            "lifecycle",
            document.RootElement.GetProperty("category").GetString());
        Assert.Equal(
            "Bridge\nstarted.",
            document.RootElement.GetProperty("message").GetString());
        Assert.Equal(
            JsonValueKind.Null,
            document.RootElement.GetProperty("exception").ValueKind);
    }

    [Fact]
    public async Task WriteAsync_SerializesExceptionAsStructuredData()
    {
        using var directory = TemporaryDirectory.Create();
        await using var log = new RollingJsonBridgeLog(
            directory.Path,
            "worker",
            maxFileBytes: 1024 * 1024,
            retainedFileCount: 2);
        var exception = new InvalidOperationException("worker failed");

        await log.WriteAsync(
            "error",
            "worker_failed",
            "supervision",
            "Worker exited.",
            exception);

        var file = Assert.Single(Directory.GetFiles(directory.Path, "worker-*.jsonl"));
        using var document = JsonDocument.Parse(
            Assert.Single(await File.ReadAllLinesAsync(file)));
        var exceptionElement = document.RootElement.GetProperty("exception");

        Assert.Equal(
            typeof(InvalidOperationException).FullName,
            exceptionElement.GetProperty("type").GetString());
        Assert.Equal(
            "worker failed",
            exceptionElement.GetProperty("message").GetString());
        Assert.Equal(
            JsonValueKind.Null,
            exceptionElement.GetProperty("stackTrace").ValueKind);
    }

    [Fact]
    public async Task WriteAsync_ConcurrentCallersProduceCompleteNonInterleavedLines()
    {
        using var directory = TemporaryDirectory.Create();
        await using var log = new RollingJsonBridgeLog(
            directory.Path,
            "worker",
            maxFileBytes: 10 * 1024 * 1024,
            retainedFileCount: 2);

        var writes = Enumerable.Range(0, 200)
            .Select(index => log.WriteAsync(
                "debug",
                $"event_{index:D3}",
                "concurrency",
                $"message {index}").AsTask())
            .ToArray();
        await Task.WhenAll(writes);

        var file = Assert.Single(Directory.GetFiles(directory.Path, "worker-*.jsonl"));
        var lines = await File.ReadAllLinesAsync(file);
        Assert.Equal(200, lines.Length);

        var eventIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var line in lines)
        {
            using var document = JsonDocument.Parse(line);
            eventIds.Add(document.RootElement.GetProperty("eventId").GetString()!);
        }

        Assert.Equal(200, eventIds.Count);
    }

    [Fact]
    public async Task WriteAsync_RotatesBeforeSizeLimitAndRetainsNewestFiles()
    {
        using var directory = TemporaryDirectory.Create();
        var time = new ManualTimeProvider(
            new DateTimeOffset(2026, 7, 26, 1, 0, 0, TimeSpan.Zero));
        await using var log = new RollingJsonBridgeLog(
            directory.Path,
            "host",
            maxFileBytes: 250,
            retainedFileCount: 2,
            time);

        for (var index = 0; index < 12; index++)
        {
            await log.WriteAsync(
                "information",
                $"event_{index:D2}",
                "rotation",
                new string((char)('a' + index), 80));
        }

        var files = Directory.GetFiles(directory.Path, "host-*.jsonl")
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(2, files.Length);
        Assert.EndsWith("-0011.jsonl", files[^1], StringComparison.Ordinal);
        using var newest = JsonDocument.Parse(
            Assert.Single(await File.ReadAllLinesAsync(files[^1])));
        Assert.Equal(
            "event_11",
            newest.RootElement.GetProperty("eventId").GetString());
    }

    [Fact]
    public async Task WriteAsync_RotatesOnUtcDayBoundary()
    {
        using var directory = TemporaryDirectory.Create();
        var time = new ManualTimeProvider(
            new DateTimeOffset(2026, 7, 26, 23, 59, 59, TimeSpan.Zero));
        await using var log = new RollingJsonBridgeLog(
            directory.Path,
            "worker",
            maxFileBytes: 1024 * 1024,
            retainedFileCount: 4,
            time);

        await log.WriteAsync("info", "before", "daily", "before");
        time.SetUtcNow(new DateTimeOffset(2026, 7, 27, 0, 0, 0, TimeSpan.Zero));
        await log.WriteAsync("info", "after", "daily", "after");

        var names = Directory.GetFiles(directory.Path, "worker-*.jsonl")
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(
            new[]
            {
                "worker-20260726-0000.jsonl",
                "worker-20260727-0000.jsonl",
            },
            names);
    }

    [Fact]
    public async Task WriteAsync_RestartContinuesLatestDailySequence()
    {
        using var directory = TemporaryDirectory.Create();
        var time = new ManualTimeProvider(
            new DateTimeOffset(2026, 7, 26, 1, 0, 0, TimeSpan.Zero));

        await using (var first = new RollingJsonBridgeLog(
            directory.Path,
            "host",
            maxFileBytes: 200,
            retainedFileCount: 4,
            time))
        {
            await first.WriteAsync(
                "info",
                "first",
                "restart",
                new string('a', 100));
            await first.WriteAsync(
                "info",
                "second",
                "restart",
                new string('b', 100));
        }

        await using (var second = new RollingJsonBridgeLog(
            directory.Path,
            "host",
            maxFileBytes: 200,
            retainedFileCount: 4,
            time))
        {
            await second.WriteAsync(
                "info",
                "third",
                "restart",
                new string('c', 100));
        }

        var names = Directory.GetFiles(directory.Path, "host-*.jsonl")
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(
            new[]
            {
                "host-20260726-0000.jsonl",
                "host-20260726-0001.jsonl",
                "host-20260726-0002.jsonl",
            },
            names);
    }

    [Fact]
    public async Task Retention_IsIsolatedByFilePrefix()
    {
        using var directory = TemporaryDirectory.Create();
        var time = new ManualTimeProvider(
            new DateTimeOffset(2026, 7, 26, 1, 0, 0, TimeSpan.Zero));
        await using var hostLog = new RollingJsonBridgeLog(
            directory.Path,
            "host",
            maxFileBytes: 200,
            retainedFileCount: 1,
            time);
        await using var workerLog = new RollingJsonBridgeLog(
            directory.Path,
            "worker",
            maxFileBytes: 200,
            retainedFileCount: 1,
            time);

        await hostLog.WriteAsync("info", "host_1", "prefix", new string('h', 100));
        await hostLog.WriteAsync("info", "host_2", "prefix", new string('h', 100));
        await workerLog.WriteAsync("info", "worker_1", "prefix", new string('w', 100));
        await workerLog.WriteAsync("info", "worker_2", "prefix", new string('w', 100));

        Assert.Single(Directory.GetFiles(directory.Path, "host-*.jsonl"));
        Assert.Single(Directory.GetFiles(directory.Path, "worker-*.jsonl"));
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("..")]
    [InlineData("host/log")]
    [InlineData(@"host\log")]
    public void Constructor_UnsafePrefix_IsRejected(string prefix)
    {
        using var directory = TemporaryDirectory.Create();

        Assert.Throws<ArgumentException>(
            () => new RollingJsonBridgeLog(
                directory.Path,
                prefix,
                maxFileBytes: 100,
                retainedFileCount: 1));
    }

    [Fact]
    public async Task WriteAsync_AfterDispose_IsRejected()
    {
        using var directory = TemporaryDirectory.Create();
        var log = new RollingJsonBridgeLog(
            directory.Path,
            "host",
            maxFileBytes: 1000,
            retainedFileCount: 1);
        await log.DisposeAsync();

        await Assert.ThrowsAsync<ObjectDisposedException>(
            () => log.WriteAsync(
                "info",
                "late",
                "lifecycle",
                "late").AsTask());
    }

    private sealed class ManualTimeProvider : TimeProvider
    {
        private DateTimeOffset _utcNow;

        internal ManualTimeProvider(DateTimeOffset utcNow)
        {
            SetUtcNow(utcNow);
        }

        public override DateTimeOffset GetUtcNow() => _utcNow;

        internal void SetUtcNow(DateTimeOffset utcNow)
        {
            _utcNow = utcNow.ToUniversalTime();
        }
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        private TemporaryDirectory(string path)
        {
            Path = path;
        }

        internal string Path { get; }

        internal static TemporaryDirectory Create()
        {
            var path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"revagent-bridge-log-tests-{Guid.NewGuid():N}");
            Directory.CreateDirectory(path);
            return new TemporaryDirectory(path);
        }

        public void Dispose()
        {
            if (Directory.Exists(Path))
            {
                Directory.Delete(Path, recursive: true);
            }
        }
    }
}
