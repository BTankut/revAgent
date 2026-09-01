using Microsoft.Extensions.Hosting;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Bridge.Bootstrap.Control;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Runtime;

namespace RevAgent.Bridge.Tests.Worker;

/// <summary>
/// The worker process boundary for the in-process RBP data plane: precondition
/// failures must fail closed with a non-success worker exit and no half-built
/// runtime, and the control channel must keep working beside it.
/// </summary>
public sealed class WorkerGatewayRuntimeServiceTests
{
    [Fact]
    public async Task MissingPreconditionsFailClosedWithNoHalfBuiltRuntime()
    {
        var lifetime = new FakeLifetime();
        var exitState = new WorkerExitState();
        var log = new RecordingLog();
        var service = new WorkerGatewayRuntimeService(
            () => throw new BridgeConfigurationException(
                "config_file_not_found",
                "The bridge configuration file does not exist."),
            lifetime,
            log,
            exitState);

        BridgeConfigurationException failure =
            await Assert.ThrowsAsync<BridgeConfigurationException>(
                () => service.StartAsync(CancellationToken.None));

        // The host start fails, which is what makes the worker exit
        // non-successfully instead of holding a control pipe over a data plane
        // that was never wired.
        Assert.Equal("config_file_not_found", failure.ErrorCode);
        Assert.Equal(1, exitState.ExitCode);
        Assert.False(service.IsComposed);
        Assert.Null(service.Runtime);
        Assert.Contains(
            log.Entries,
            entry =>
                entry.EventId == "worker.gateway_runtime_precondition_failed" &&
                entry.Level == "Error");

        // Stopping an unstarted runtime stays clean and never invents state.
        await service.StopAsync(CancellationToken.None);
        Assert.False(service.IsComposed);
    }

    [Fact]
    public async Task AnUnopenableJournalFailsClosedBeforeAnyConnection()
    {
        using var directory = new WorkerRuntimeTestDirectory();

        // The canonical journal path is occupied by a directory, so the
        // machine-wide single-writer store cannot open at all.
        Directory.CreateDirectory(
            new BridgeInstallLayout(directory.Path, directory.Path)
                .JournalPath);

        var lifetime = new FakeLifetime();
        var exitState = new WorkerExitState();
        var service = new WorkerGatewayRuntimeService(
            () => WorkerGatewayRuntime.CreateProduction(
                new BridgeInstallLayout(directory.Path, directory.Path),
                Configuration(directory)),
            lifetime,
            new RecordingLog(),
            exitState);

        await Assert.ThrowsAnyAsync<Exception>(
            () => service.StartAsync(CancellationToken.None));

        Assert.Equal(1, exitState.ExitCode);
        Assert.False(service.IsComposed);
        await service.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task ProductionCompositionOpensTheCanonicalJournalAndStops()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var directory = new WorkerRuntimeTestDirectory();
        var layout = new BridgeInstallLayout(directory.Path, directory.Path);
        Directory.CreateDirectory(layout.CredentialDirectory);
        var lifetime = new FakeLifetime();
        var exitState = new WorkerExitState();
        var service = new WorkerGatewayRuntimeService(
            () => WorkerGatewayRuntime.CreateProduction(
                layout,
                Configuration(directory)),
            lifetime,
            new RecordingLog(),
            exitState);

        await service.StartAsync(CancellationToken.None);
        try
        {
            Assert.True(service.IsComposed);
            Assert.True(File.Exists(layout.JournalPath));

            // No credential store exists in this temporary state root, so the
            // production enrollment seam refuses and the coordinator parks in
            // the frozen auth pause instead of retry-storming a Gateway that
            // this test never contacts.
            RbpConnectionCoordinator coordinator = service.Runtime!.Coordinator;
            await EventuallyAsync(
                () => coordinator.GetSnapshot().Lifecycle.Phase ==
                    RbpConnectionPhase.RetryPaused);
            Assert.Equal(
                RbpRetryPauseReason.Auth,
                coordinator.GetSnapshot().Lifecycle.RetryPauseReason);
            Assert.False(coordinator.GetSnapshot().HasActiveConnection);
            Assert.Equal(0, exitState.ExitCode);
            Assert.False(lifetime.StopRequested);
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }

        // The journal writer lease is released, so a second store may open the
        // same canonical path after the worker stops.
        await using RbpJournalStore reopened = RbpJournalStore.Open(
            layout.JournalPath,
            WorkerResumeTokenProtector.CreateProduction());
        Assert.Equal(layout.JournalPath, reopened.DatabasePath);
    }

    [Fact]
    public async Task ControlServiceStillWorksBesideTheGatewayRuntime()
    {
        using var directory = new WorkerRuntimeTestDirectory();
        var layout = new BridgeInstallLayout(directory.Path, directory.Path);
        var instanceId = Guid.NewGuid();
        var lifetime = new FakeLifetime();
        var exitState = new WorkerExitState();
        var stopWorkerRelease = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var session = new FakeSession(
            new StopWorker(
                ControlProtocol.Version,
                instanceId,
                "service_stop",
                DateTimeOffset.UtcNow.AddSeconds(8).ToUnixTimeMilliseconds()),
            stopWorkerRelease.Task);
        var control = new WorkerControlService(
            new WorkerRuntimeOptions(
                "test-pipe",
                Environment.ProcessId,
                instanceId,
                Path.GetFullPath("bridge-config.json")),
            new FakeSessionFactory(session),
            lifetime,
            new RecordingLog(),
            exitState);

        await using RbpJournalStore store = RbpJournalStore.Open(
            layout.JournalPath,
            new UnusedResumeTokenProtector());
        var parkedGate = new ParkedRuntimeGate();
        RbpConnectionCoordinator coordinator =
            WorkerGatewayComposition.CreateCoordinator(
                new WorkerGatewayServices(
                    parkedGate,
                    store,
                    new EmptySessionCatalog(),
                    new RbpConnectionCoordinatorOptions(
                        new Uri("wss://gateway.revagent.app/bridge/v1"),
                        new RbpHelloProfile(
                            "0.1.0",
                            "WS01",
                            "Windows 11",
                            Array.Empty<string>()))));
        await using var runtime = new WorkerGatewayRuntime(coordinator);
        var gateway = new WorkerGatewayRuntimeService(
            () => runtime,
            lifetime,
            new RecordingLog(),
            exitState);

        // Both hosted services run in the same worker, in the same order the
        // host registers them.
        await control.StartAsync(CancellationToken.None);
        await gateway.StartAsync(CancellationToken.None);
        await WaitUntilAsync(() =>
            coordinator.GetSnapshot().Lifecycle.Phase ==
                RbpConnectionPhase.RetryPaused &&
            !coordinator.GetSnapshot().HasActiveConnection);
        Assert.Equal(1, parkedGate.OpenCount);
        stopWorkerRelease.TrySetResult();
        await WaitUntilAsync(() => lifetime.StopRequested);
        await gateway.StopAsync(CancellationToken.None);
        await control.StopAsync(CancellationToken.None);

        // The control channel is unchanged: exactly one READY and one
        // STOPPING, and a Gateway that never answers does not fail the worker.
        Assert.Collection(
            session.Sent,
            message => Assert.IsType<WorkerReady>(message),
            message => Assert.IsType<WorkerStopping>(message));
        Assert.Equal(0, exitState.ExitCode);
        Assert.Equal(
            RbpConnectionPhase.Shutdown,
            coordinator.GetSnapshot().Lifecycle.Phase);
        Assert.Equal(1, parkedGate.OpenCount);
    }

    private static ResolvedBridgeConfiguration Configuration(
        WorkerRuntimeTestDirectory directory)
    {
        string path = Path.Combine(directory.Path, "bridge-config.json");
        File.WriteAllText(
            path,
            """
            {"schemaVersion":1,"gateway":{"uri":"wss://gateway.revagent.app/bridge/v1"},"addin":{"scanStartPort":8080,"scanEndPort":8085},"logging":{"maxFileBytes":1048576,"retainedFileCount":3}}
            """);
        return BridgeConfigurationLoader.Load(
            path,
            new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase));
    }

    private static async Task EventuallyAsync(Func<bool> predicate)
    {
        for (int attempt = 0; attempt < 400; attempt++)
        {
            if (predicate())
            {
                return;
            }

            await Task.Delay(5);
        }

        Assert.Fail("The worker gateway runtime condition was not met.");
    }

    private static async Task WaitUntilAsync(Func<bool> predicate)
    {
        using var timeout = new CancellationTokenSource(
            TimeSpan.FromSeconds(5));
        while (!predicate())
        {
            await Task.Delay(10, timeout.Token);
        }
    }

    private sealed class WorkerRuntimeTestDirectory : IDisposable
    {
        internal WorkerRuntimeTestDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "revagent-worker-runtime-tests",
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        internal string Path { get; }

        public void Dispose()
        {
            try
            {
                if (Directory.Exists(Path))
                {
                    Directory.Delete(Path, recursive: true);
                }
            }
            catch (IOException)
            {
                // Retain the evidence of a failed run.
            }
            catch (UnauthorizedAccessException)
            {
                // Retain the evidence of a failed run.
            }
        }
    }

    private sealed class EmptySessionCatalog : IRbpLocalSessionCatalog
    {
        public Task<IReadOnlyList<RbpLocalSessionSnapshot>> ReadAsync(
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult<IReadOnlyList<RbpLocalSessionSnapshot>>(
                Array.Empty<RbpLocalSessionSnapshot>());
        }
    }

    /// <summary>
    /// No session ever registers in this test, so no resume token can reach
    /// the store; any call here would be a wiring defect.
    /// </summary>
    private sealed class UnusedResumeTokenProtector : IRbpResumeTokenProtector
    {
        public RbpProtectedResumeToken Protect(string plaintextToken) =>
            throw new InvalidOperationException(
                "No resume token may be protected in this test.");

        public string Unprotect(RbpProtectedResumeToken protectedToken) =>
            throw new InvalidOperationException(
                "No resume token may be unprotected in this test.");
    }

    private sealed class ParkedRuntimeGate : IRbpConnectionCycleFactory
    {
        private int _openCount;
        internal int OpenCount => Volatile.Read(ref _openCount);

        public RbpConnectionBindingKind BindingKind =>
            RbpConnectionBindingKind.Wss;

        public Task<IRbpConnectionCycle> OpenAsync(
            Uri endpoint,
            RbpHelloProfile profile,
            CancellationToken cancellationToken = default)
        {
            _ = endpoint;
            _ = profile;
            cancellationToken.ThrowIfCancellationRequested();
            Interlocked.Increment(ref _openCount);
            return Task.FromException<IRbpConnectionCycle>(
                new RbpGatewayTransportException(
                    RbpGatewayFailureKind.Version,
                    "The test parks Gateway retry authority."));
        }
    }

    private sealed class FakeSessionFactory : IWorkerControlSessionFactory
    {
        private readonly IWorkerControlSession _session;

        internal FakeSessionFactory(IWorkerControlSession session)
        {
            _session = session;
        }

        public ValueTask<IWorkerControlSession> ConnectAsync(
            WorkerRuntimeOptions options,
            CancellationToken cancellationToken)
        {
            _ = options;
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(_session);
        }
    }

    private sealed class FakeSession : IWorkerControlSession
    {
        private readonly ControlMessage? _message;
        private readonly Task _receiveGate;

        internal FakeSession(
            ControlMessage? message,
            Task? receiveGate = null)
        {
            _message = message;
            _receiveGate = receiveGate ?? Task.CompletedTask;
        }

        internal List<ControlMessage> Sent { get; } = [];

        public ValueTask SendAsync(
            ControlMessage message,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Sent.Add(message);
            return ValueTask.CompletedTask;
        }

        public async ValueTask<ControlMessage?> ReceiveAsync(
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await _receiveGate.WaitAsync(cancellationToken)
                .ConfigureAwait(false);
            return _message;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class FakeLifetime : IHostApplicationLifetime
    {
        private readonly CancellationTokenSource _started = new();
        private readonly CancellationTokenSource _stopping = new();
        private readonly CancellationTokenSource _stopped = new();

        internal FakeLifetime() => _started.Cancel();

        public CancellationToken ApplicationStarted => _started.Token;

        public CancellationToken ApplicationStopping => _stopping.Token;

        public CancellationToken ApplicationStopped => _stopped.Token;

        internal bool StopRequested => _stopping.IsCancellationRequested;

        public void StopApplication()
        {
            _stopping.Cancel();
            _stopped.Cancel();
        }
    }

    private sealed record LogEntry(
        string Level,
        string EventId,
        string Category,
        string Message);

    private sealed class RecordingLog : IBridgeLog
    {
        private readonly object _sync = new();
        private readonly List<LogEntry> _entries = [];

        internal IReadOnlyList<LogEntry> Entries
        {
            get
            {
                lock (_sync)
                {
                    return _entries.ToArray();
                }
            }
        }

        public ValueTask WriteAsync(
            string level,
            string eventId,
            string category,
            string message,
            Exception? exception = null,
            CancellationToken cancellationToken = default)
        {
            _ = exception;
            _ = cancellationToken;
            lock (_sync)
            {
                _entries.Add(new LogEntry(level, eventId, category, message));
            }

            return ValueTask.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
