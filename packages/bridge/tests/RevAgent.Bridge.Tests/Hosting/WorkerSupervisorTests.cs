using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Control;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Host.Hosting;

namespace RevAgent.Bridge.Tests.Hosting;

public sealed class WorkerSupervisorTests
{
    [Fact]
    public async Task ReadyStopStoppingLifecycleIsGraceful()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var fixture = new SupervisorFixture();
        var launcher = new InProcessWorkerLauncher("1.2.3");
        await using var log = new NullBridgeLog();
        await using var supervisor = new WorkerSupervisor(
            fixture.Layout,
            launcher,
            log);

        await supervisor.StartAsync(CancellationToken.None);
        Task<WorkerExit> monitor = supervisor.WaitForExitAsync(
            CancellationToken.None);
        WorkerStopResult stop = await supervisor.StopAsync(
            WorkerStopReason.ScmStop,
            TimeSpan.FromSeconds(2),
            CancellationToken.None);
        WorkerExit exit = await monitor;

        Assert.True(stop.Graceful);
        Assert.False(stop.Forced);
        Assert.Equal(0, stop.ExitCode);
        Assert.Equal(0, exit.ExitCode);
        Assert.Equal(0, exit.RestartCount);
        Assert.NotNull(launcher.LastStart);
        Assert.Equal("__worker", launcher.LastStart!.Arguments[0]);
        Assert.Equal(
            fixture.Layout.ConfigurationPath,
            ValueAfter(launcher.LastStart.Arguments, "--config"));
        Assert.Equal(
            fixture.Layout.BundleExtractionRoot,
            launcher.LastStart.Environment["DOTNET_BUNDLE_EXTRACT_BASE_DIR"]);
    }

    [Fact]
    public async Task StopTimeoutKillsWorkerTree()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var fixture = new SupervisorFixture();
        var launcher = new InProcessWorkerLauncher(
            "1.2.3",
            ignoreStop: true);
        await using var log = new NullBridgeLog();
        await using var supervisor = new WorkerSupervisor(
            fixture.Layout,
            launcher,
            log);

        await supervisor.StartAsync(CancellationToken.None);
        Task<WorkerExit> monitor = supervisor.WaitForExitAsync(
            CancellationToken.None);
        WorkerStopResult stop = await supervisor.StopAsync(
            WorkerStopReason.ScmStop,
            TimeSpan.FromMilliseconds(100),
            CancellationToken.None);
        WorkerExit exit = await monitor;

        Assert.False(stop.Graceful);
        Assert.True(stop.Forced);
        Assert.True(launcher.LastProcess?.Killed);
        Assert.Equal(-9, exit.ExitCode);
    }

    [Fact]
    public async Task InvalidStoppingAcknowledgementKillsWorkerTree()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var fixture = new SupervisorFixture();
        var launcher = new InProcessWorkerLauncher(
            "1.2.3",
            invalidStopping: true);
        await using var log = new NullBridgeLog();
        await using var supervisor = new WorkerSupervisor(
            fixture.Layout,
            launcher,
            log);

        await supervisor.StartAsync(CancellationToken.None);
        Task<WorkerExit> monitor = supervisor.WaitForExitAsync(
            CancellationToken.None);
        WorkerStopResult stop = await supervisor.StopAsync(
            WorkerStopReason.ScmStop,
            TimeSpan.FromSeconds(2),
            CancellationToken.None);
        WorkerExit exit = await monitor;

        Assert.False(stop.Graceful);
        Assert.True(stop.Forced);
        Assert.True(launcher.LastProcess?.Killed);
        Assert.Equal(-9, exit.ExitCode);
    }

    [Fact]
    public async Task ReadyVersionMustMatchIndependentVersionProbe()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var fixture = new SupervisorFixture();
        var launcher = new InProcessWorkerLauncher(
            probedVersion: "1.2.3",
            readyVersion: "9.9.9");
        await using var log = new NullBridgeLog();
        await using var supervisor = new WorkerSupervisor(
            fixture.Layout,
            launcher,
            log);

        WorkerStartupException error =
            await Assert.ThrowsAsync<WorkerStartupException>(
                () => supervisor.StartAsync(CancellationToken.None));

        Assert.Equal("worker_ready_version_mismatch", error.Code);
        Assert.True(launcher.LastProcess?.Killed);
    }

    private static string ValueAfter(
        IReadOnlyList<string> arguments,
        string option)
    {
        int index = arguments.IndexOf(option);
        Assert.InRange(index, 0, arguments.Count - 2);
        return arguments[index + 1];
    }

    private sealed class SupervisorFixture : IDisposable
    {
        private readonly string _root = Path.Combine(
            Path.GetTempPath(),
            $"revagent-bridge-supervisor-tests-{Guid.NewGuid():N}");

        internal SupervisorFixture()
        {
            Layout = new BridgeInstallLayout(
                Path.Combine(_root, "install"),
                Path.Combine(_root, "state"));
            Directory.CreateDirectory(Layout.CurrentWorkerDirectory);
            Directory.CreateDirectory(Layout.StateRoot);
            File.WriteAllText(Layout.WorkerExecutablePath, "worker");
            File.WriteAllText(Layout.ConfigurationPath, "{}");
        }

        internal BridgeInstallLayout Layout { get; }

        public void Dispose()
        {
            if (Directory.Exists(_root))
            {
                Directory.Delete(_root, recursive: true);
            }
        }
    }

    private sealed class InProcessWorkerLauncher : IWorkerProcessLauncher
    {
        private readonly string _probedVersion;
        private readonly string _readyVersion;
        private readonly bool _ignoreStop;
        private readonly bool _invalidStopping;

        internal InProcessWorkerLauncher(
            string probedVersion,
            string? readyVersion = null,
            bool ignoreStop = false,
            bool invalidStopping = false)
        {
            _probedVersion = probedVersion;
            _readyVersion = readyVersion ?? probedVersion;
            _ignoreStop = ignoreStop;
            _invalidStopping = invalidStopping;
        }

        internal WorkerStartRequest? LastStart { get; private set; }
        internal FakeWorkerProcess? LastProcess { get; private set; }

        public IWorkerProcess Start(WorkerStartRequest request)
        {
            LastStart = request;
            var process = new FakeWorkerProcess(Environment.ProcessId);
            LastProcess = process;

            string pipeName = ValueAfter(request.Arguments, "--control-pipe");
            int hostPid = int.Parse(
                ValueAfter(request.Arguments, "--host-pid"),
                System.Globalization.CultureInfo.InvariantCulture);
            Guid instanceId = Guid.ParseExact(
                ValueAfter(request.Arguments, "--instance-id"),
                "D");
            _ = RunWorkerAsync(
                process,
                pipeName,
                hostPid,
                instanceId);
            return process;
        }

        public ValueTask<WorkerCommandResult> RunOneShotAsync(
            WorkerOneShotRequest request,
            TimeSpan timeout,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Assert.Equal(["--version"], request.Arguments);
            return ValueTask.FromResult(
                new WorkerCommandResult(
                    0,
                    _probedVersion + Environment.NewLine,
                    string.Empty,
                    false,
                    false));
        }

        private async Task RunWorkerAsync(
            FakeWorkerProcess process,
            string pipeName,
            int hostPid,
            Guid instanceId)
        {
            try
            {
                await using ControlConnection connection =
                    await WorkerControlClient.ConnectAsync(
                        pipeName,
                        hostPid,
                        instanceId,
                        CancellationToken.None);
                await connection.SendAsync(
                    new WorkerReady(
                        ControlProtocol.Version,
                        instanceId,
                        process.Id,
                        _readyVersion),
                    CancellationToken.None);
                ControlMessage? message = await connection.ReceiveAsync(
                    CancellationToken.None);
                if (message is StopWorker && _ignoreStop)
                {
                    _ = await process.WaitForExitAsync(CancellationToken.None);
                    return;
                }

                if (message is StopWorker && _invalidStopping)
                {
                    await connection.SendAsync(
                        new WorkerStopping(
                            ControlProtocol.Version,
                            instanceId,
                            process.Id + 1),
                        CancellationToken.None);
                    _ = await process.WaitForExitAsync(CancellationToken.None);
                    return;
                }

                if (message is StopWorker)
                {
                    await connection.SendAsync(
                        new WorkerStopping(
                            ControlProtocol.Version,
                            instanceId,
                            process.Id),
                        CancellationToken.None);
                    process.Complete(0);
                }
            }
            catch (ObjectDisposedException)
            {
                process.Complete(-9);
            }
            catch (IOException)
            {
                process.Complete(-9);
            }
        }
    }

    private sealed class FakeWorkerProcess : IWorkerProcess
    {
        private readonly TaskCompletionSource<int> _exit =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal FakeWorkerProcess(int id)
        {
            Id = id;
        }

        public int Id { get; }
        internal bool Killed { get; private set; }

        public async Task<int> WaitForExitAsync(
            CancellationToken cancellationToken) =>
            await _exit.Task.WaitAsync(cancellationToken);

        public ValueTask<WorkerProcessDiagnostics> GetDiagnosticsAsync() =>
            ValueTask.FromResult(
                new WorkerProcessDiagnostics(
                    string.Empty,
                    string.Empty,
                    false,
                    false));

        public void KillTree()
        {
            Killed = true;
            Complete(-9);
        }

        internal void Complete(int exitCode) =>
            _exit.TrySetResult(exitCode);

        public void Dispose()
        {
        }
    }

    private sealed class NullBridgeLog : IBridgeLog
    {
        public ValueTask WriteAsync(
            string level,
            string eventId,
            string category,
            string message,
            Exception? exception = null,
            CancellationToken cancellationToken = default) =>
            ValueTask.CompletedTask;

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

internal static class ReadOnlyListTestExtensions
{
    internal static int IndexOf(
        this IReadOnlyList<string> values,
        string value)
    {
        for (int index = 0; index < values.Count; index++)
        {
            if (string.Equals(values[index], value, StringComparison.Ordinal))
            {
                return index;
            }
        }

        return -1;
    }
}
