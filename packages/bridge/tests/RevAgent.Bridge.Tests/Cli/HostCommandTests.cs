using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Host.Cli;
using RevAgent.Bridge.Host.Hosting;
using RevAgent.Bridge.Host.Install;
using RevAgent.Bridge.Host.Platform;

namespace RevAgent.Bridge.Tests.Cli;

public sealed class HostCommandTests
{
    [Fact]
    public void ArgumentlessModeRequiresWindowsServiceContext()
    {
        HostCommandParseResult interactive = HostCommandParser.Parse(
            [],
            isWindowsService: false);
        HostCommandParseResult service = HostCommandParser.Parse(
            [],
            isWindowsService: true);

        Assert.False(interactive.Success);
        Assert.Equal(HostCommandKind.Service, service.Command?.Kind);
    }

    [Theory]
    [InlineData("install", (int)HostCommandKind.Install)]
    [InlineData("uninstall", (int)HostCommandKind.Uninstall)]
    [InlineData("doctor", (int)HostCommandKind.Doctor)]
    [InlineData("prepare-enrollment", (int)HostCommandKind.PrepareEnrollment)]
    [InlineData("--version", (int)HostCommandKind.Version)]
    public void SingleTokenCommandsAreExact(
        string token,
        int expected)
    {
        HostCommandParseResult parsed = HostCommandParser.Parse(
            [token],
            isWindowsService: false);

        Assert.True(parsed.Success);
        Assert.Equal((HostCommandKind)expected, parsed.Command?.Kind);
    }

    [Fact]
    public void ConsoleModeRequiresExactTwoTokens()
    {
        HostCommandParseResult accepted = HostCommandParser.Parse(
            ["run", "--console"],
            isWindowsService: false);
        HostCommandParseResult rejected = HostCommandParser.Parse(
            ["run"],
            isWindowsService: false);

        Assert.Equal(HostCommandKind.RunConsole, accepted.Command?.Kind);
        Assert.False(rejected.Success);
    }

    [Fact]
    public async Task DoctorDelegatesExactHiddenWorkerCommand()
    {
        using var fixture = new CliFixture();
        var launcher = new FakeWorkerLauncher
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
        Assert.NotNull(launcher.LastOneShot);
        WorkerOneShotRequest request = launcher.LastOneShot!;
        Assert.Equal(
            ["__doctor", "--config", fixture.Layout.ConfigurationPath],
            request.Arguments);
        Assert.Equal(
            fixture.Layout.BundleExtractionRoot,
            request.Environment["DOTNET_BUNDLE_EXTRACT_BASE_DIR"]);
        Assert.Contains(
            "revagent-bridge-doctor/v1",
            stdout.ToString(),
            StringComparison.Ordinal);
        Assert.Equal(string.Empty, stderr.ToString());
    }

    [Fact]
    public async Task DoctorNonzeroIsReturnedAsDoctorFailure()
    {
        using var fixture = new CliFixture();
        var launcher = new FakeWorkerLauncher
        {
            Result = new WorkerCommandResult(
                3,
                string.Empty,
                "configuration invalid",
                false,
                false),
        };
        using var stderr = new StringWriter();
        await using var log = new NullBridgeLog();
        HostCommandDispatcher dispatcher = fixture.CreateDispatcher(
            launcher,
            log,
            new StringWriter(),
            stderr);

        int exitCode = await dispatcher.ExecuteAsync(
            new HostCommand(HostCommandKind.Doctor),
            CancellationToken.None);

        Assert.Equal((int)HostExitCode.DoctorFailed, exitCode);
        Assert.Contains(
            "configuration invalid",
            stderr.ToString(),
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task DoctorRejectsSuccessfulExitWithStandardError()
    {
        using var fixture = new CliFixture();
        var launcher = new FakeWorkerLauncher
        {
            Result = new WorkerCommandResult(
                0,
                """{"schema_version":"revagent-bridge-doctor/v1","success":true}""",
                "unexpected diagnostic",
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

        Assert.Equal((int)HostExitCode.DoctorFailed, exitCode);
        Assert.Equal(string.Empty, stdout.ToString());
        Assert.Contains(
            "unexpected diagnostic",
            stderr.ToString(),
            StringComparison.Ordinal);
    }

    private sealed class CliFixture : IDisposable
    {
        private readonly string _root = Path.Combine(
            Path.GetTempPath(),
            $"revagent-bridge-cli-tests-{Guid.NewGuid():N}");

        internal CliFixture()
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
            var eventLog = new NullEventLog();
            var installer = new ServiceInstaller(
                Layout,
                Layout.HostExecutablePath,
                new NullServiceManager(),
                eventLog,
                log,
                isWindows: static () => true);
            return new HostCommandDispatcher(
                Layout,
                installer,
                new FakeHostRunner(),
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

    private sealed class FakeWorkerLauncher : IWorkerProcessLauncher
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

    private sealed class FakeHostRunner : IBridgeHostRunner
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
        public void Write(LifecycleEvent entry) { }
        public void RemoveSource() { }
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
