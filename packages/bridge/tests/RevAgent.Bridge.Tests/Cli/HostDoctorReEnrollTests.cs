using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Host.Cli;
using RevAgent.Bridge.Host.Hosting;
using RevAgent.Bridge.Host.Install;
using RevAgent.Bridge.Host.Platform;

namespace RevAgent.Bridge.Tests.Cli;

public sealed class HostDoctorReEnrollTests
{
    [Fact]
    public void DoctorReEnrollFlagParsesExactly()
    {
        HostCommandParseResult parsed = HostCommandParser.Parse(
            ["doctor", "--re-enroll"],
            isWindowsService: false);

        Assert.True(parsed.Success);
        Assert.Equal(HostCommandKind.Doctor, parsed.Command!.Kind);
        Assert.True(parsed.Command.ReEnroll);
    }

    [Fact]
    public void PlainDoctorDoesNotReEnroll()
    {
        HostCommandParseResult parsed = HostCommandParser.Parse(
            ["doctor"],
            isWindowsService: false);

        Assert.True(parsed.Success);
        Assert.False(parsed.Command!.ReEnroll);
    }

    [Theory]
    [InlineData("doctor", "--reenroll")]
    [InlineData("doctor", "--re-enroll ")]
    [InlineData("--re-enroll", "doctor")]
    public void MisshapenReEnrollFormsAreRejected(
        string first,
        string second)
    {
        HostCommandParseResult parsed = HostCommandParser.Parse(
            [first, second],
            isWindowsService: false);

        Assert.False(parsed.Success);
    }

    [Fact]
    public async Task ReEnrollDoctorDelegatesTheExplicitWorkerFlag()
    {
        using var fixture = new ReEnrollCliFixture();
        var launcher = new RecordingWorkerLauncher
        {
            Result = new WorkerCommandResult(
                0,
                """{"schema_version":"revagent-bridge-doctor/v1","success":true}""",
                string.Empty,
                false,
                false),
        };
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        await using var log = new NullBridgeLog();
        HostCommandDispatcher dispatcher = fixture.CreateDispatcher(
            launcher,
            log,
            stdout,
            stderr);

        int exitCode = await dispatcher.ExecuteAsync(
            new HostCommand(HostCommandKind.Doctor, ReEnroll: true),
            CancellationToken.None);

        Assert.Equal((int)HostExitCode.Success, exitCode);
        Assert.Equal(
            [
                "__doctor",
                "--config",
                fixture.Layout.ConfigurationPath,
                "--re-enroll",
                "true",
            ],
            launcher.LastOneShot!.Arguments);
    }

    [Fact]
    public async Task PlainDoctorStillDelegatesWithoutTheFlag()
    {
        using var fixture = new ReEnrollCliFixture();
        var launcher = new RecordingWorkerLauncher
        {
            Result = new WorkerCommandResult(
                0,
                """{"schema_version":"revagent-bridge-doctor/v1","success":true}""",
                string.Empty,
                false,
                false),
        };
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        await using var log = new NullBridgeLog();
        HostCommandDispatcher dispatcher = fixture.CreateDispatcher(
            launcher,
            log,
            stdout,
            stderr);

        int exitCode = await dispatcher.ExecuteAsync(
            new HostCommand(HostCommandKind.Doctor),
            CancellationToken.None);

        Assert.Equal((int)HostExitCode.Success, exitCode);
        Assert.Equal(
            ["__doctor", "--config", fixture.Layout.ConfigurationPath],
            launcher.LastOneShot!.Arguments);
    }

    private sealed class ReEnrollCliFixture : IDisposable
    {
        private readonly string _root = Path.Combine(
            Path.GetTempPath(),
            $"revagent-bridge-reenroll-cli-tests-{Guid.NewGuid():N}");

        internal ReEnrollCliFixture()
        {
            Layout = new BridgeInstallLayout(
                Path.Combine(_root, "install"),
                Path.Combine(_root, "state"));
            Directory.CreateDirectory(Layout.CurrentWorkerDirectory);
            Directory.CreateDirectory(Layout.StateRoot);
            File.WriteAllText(Layout.HostExecutablePath, "host");
            File.WriteAllText(Layout.WorkerExecutablePath, "worker");
            File.WriteAllText(Layout.ConfigurationPath, "{}");
        }

        internal BridgeInstallLayout Layout { get; }

        internal HostCommandDispatcher CreateDispatcher(
            IWorkerProcessLauncher launcher,
            IBridgeLog log,
            TextWriter stdout,
            TextWriter stderr)
        {
            var installer = new ServiceInstaller(
                Layout,
                Layout.HostExecutablePath,
                new NullServiceManager(),
                new NullEventLog(),
                log,
                isWindows: static () => true);
            return new HostCommandDispatcher(
                Layout,
                installer,
                new NullHostRunner(),
                launcher,
                log,
                stdout,
                stderr);
        }

        public void Dispose()
        {
            if (Directory.Exists(_root))
            {
                Directory.Delete(_root, recursive: true);
            }
        }
    }

    private sealed class RecordingWorkerLauncher : IWorkerProcessLauncher
    {
        internal WorkerCommandResult Result { get; init; } =
            new(0, "{}", string.Empty, false, false);

        internal WorkerOneShotRequest? LastOneShot { get; private set; }

        public IWorkerProcess Start(WorkerStartRequest request) =>
            throw new NotSupportedException();

        public ValueTask<WorkerCommandResult> RunOneShotAsync(
            WorkerOneShotRequest request,
            TimeSpan timeout,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            LastOneShot = request;
            return ValueTask.FromResult(Result);
        }
    }

    private sealed class NullHostRunner : IBridgeHostRunner
    {
        public Task<int> RunAsync(
            bool windowsService,
            CancellationToken cancellationToken) =>
            Task.FromResult(0);
    }

    private sealed class NullServiceManager : IServiceControlManager
    {
        public ValueTask<ServiceSnapshot?> QueryAsync(
            string serviceName,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult<ServiceSnapshot?>(null);

        public ValueTask CreateAsync(
            ServiceDefinition definition,
            CancellationToken cancellationToken) =>
            ValueTask.CompletedTask;

        public ValueTask StartAsync(
            string serviceName,
            TimeSpan timeout,
            CancellationToken cancellationToken) =>
            ValueTask.CompletedTask;

        public ValueTask StopAsync(
            string serviceName,
            TimeSpan timeout,
            CancellationToken cancellationToken) =>
            ValueTask.CompletedTask;

        public ValueTask DeleteAsync(
            string serviceName,
            CancellationToken cancellationToken) =>
            ValueTask.CompletedTask;
    }

    private sealed class NullEventLog : ILifecycleEventLog
    {
        public bool EnsureSource() => false;

        public void Write(LifecycleEvent entry)
        {
        }

        public void RemoveSource()
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
