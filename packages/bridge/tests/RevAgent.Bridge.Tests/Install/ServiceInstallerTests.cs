using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Host.Install;
using RevAgent.Bridge.Host.Platform;

namespace RevAgent.Bridge.Tests.Install;

public sealed class ServiceInstallerTests
{
    [Fact]
    public async Task FreshInstallCreatesStartsAndRecordsLifecycle()
    {
        using var fixture = new InstallFixture();
        var services = new FakeServiceControlManager();
        var eventLog = new RecordingLifecycleEventLog();
        await using var log = new RecordingBridgeLog();
        ServiceInstaller installer = fixture.CreateInstaller(
            services,
            eventLog,
            log);

        InstallResult result = await installer.InstallAsync(
            CancellationToken.None);

        Assert.True(result.ServiceCreated);
        Assert.True(result.ServiceStarted);
        Assert.Equal(ServiceRuntimeState.Running, result.State);
        Assert.Single(services.Created);
        Assert.Equal(
            BridgeInstallLayout.ServiceAccount,
            services.Created[0].AccountName);
        Assert.True(services.Created[0].Automatic);
        Assert.True(services.Created[0].DelayedAutomatic);
        Assert.True(services.Created[0].OwnProcess);
        Assert.True(services.Created[0].NormalErrorControl);
        Assert.Equal(
            ServiceInstaller.ServiceDescription,
            services.Created[0].Description);
        Assert.Equal(1, services.StartCalls);
        Assert.Contains(
            eventLog.Events,
            entry => entry.Code == "service_installed");
    }

    [Fact]
    public async Task ExactRunningRegistrationIsIdempotent()
    {
        using var fixture = new InstallFixture();
        ServiceSnapshot exact = fixture.ExactSnapshot(ServiceRuntimeState.Running);
        var services = new FakeServiceControlManager(exact);
        var eventLog = new RecordingLifecycleEventLog();
        await using var log = new RecordingBridgeLog();
        ServiceInstaller installer = fixture.CreateInstaller(
            services,
            eventLog,
            log);

        InstallResult result = await installer.InstallAsync(
            CancellationToken.None);

        Assert.False(result.ServiceCreated);
        Assert.False(result.ServiceStarted);
        Assert.Empty(services.Created);
        Assert.Equal(0, services.StartCalls);
    }

    [Fact]
    public async Task ConflictingRegistrationFailsWithoutMutation()
    {
        using var fixture = new InstallFixture();
        ServiceSnapshot conflicting = fixture.ExactSnapshot(
            ServiceRuntimeState.Running) with
        {
            BinaryPathName = "\"C:\\Elsewhere\\other.exe\"",
        };
        var services = new FakeServiceControlManager(conflicting);
        var eventLog = new RecordingLifecycleEventLog();
        await using var log = new RecordingBridgeLog();
        ServiceInstaller installer = fixture.CreateInstaller(
            services,
            eventLog,
            log);

        ServiceRegistrationConflictException error =
            await Assert.ThrowsAsync<ServiceRegistrationConflictException>(
                () => installer.InstallAsync(CancellationToken.None));

        Assert.Contains("binary_path", error.Message, StringComparison.Ordinal);
        Assert.Empty(services.Created);
        Assert.Equal(0, services.StartCalls);
        Assert.Equal(0, eventLog.EnsureCalls);
    }

    [Fact]
    public async Task RegistrationOwnershipIncludesDescriptionTypeAndErrorControl()
    {
        using var fixture = new InstallFixture();
        ServiceSnapshot conflicting = fixture.ExactSnapshot(
            ServiceRuntimeState.Running) with
        {
            Description = "Owned by another product.",
            OwnProcess = false,
            NormalErrorControl = false,
        };
        var services = new FakeServiceControlManager(conflicting);
        var eventLog = new RecordingLifecycleEventLog();
        await using var log = new RecordingBridgeLog();
        ServiceInstaller installer = fixture.CreateInstaller(
            services,
            eventLog,
            log);

        ServiceRegistrationConflictException error =
            await Assert.ThrowsAsync<ServiceRegistrationConflictException>(
                () => installer.InstallAsync(CancellationToken.None));

        Assert.Contains("description", error.Message, StringComparison.Ordinal);
        Assert.Contains("service_type", error.Message, StringComparison.Ordinal);
        Assert.Contains("error_control", error.Message, StringComparison.Ordinal);
        Assert.Empty(services.Mutations);
        Assert.Equal(0, eventLog.EnsureCalls);
    }

    [Fact]
    public async Task StartFailureRollsBackNewRegistrationAndSource()
    {
        using var fixture = new InstallFixture();
        var services = new FakeServiceControlManager
        {
            StartException = new InvalidOperationException("injected start failure"),
        };
        var eventLog = new RecordingLifecycleEventLog();
        await using var log = new RecordingBridgeLog();
        ServiceInstaller installer = fixture.CreateInstaller(
            services,
            eventLog,
            log);

        InvalidOperationException error =
            await Assert.ThrowsAsync<InvalidOperationException>(
                () => installer.InstallAsync(CancellationToken.None));

        Assert.Equal("injected start failure", error.Message);
        Assert.Equal(1, services.StopCalls);
        Assert.Equal(1, services.DeleteCalls);
        Assert.Equal(1, eventLog.RemoveCalls);
    }

    [Fact]
    public async Task UninstallIsIdempotentWhenServiceIsMissing()
    {
        using var fixture = new InstallFixture();
        var services = new FakeServiceControlManager();
        var eventLog = new RecordingLifecycleEventLog();
        await using var log = new RecordingBridgeLog();
        ServiceInstaller installer = fixture.CreateInstaller(
            services,
            eventLog,
            log);

        UninstallResult result = await installer.UninstallAsync(
            CancellationToken.None);

        Assert.False(result.ServiceExisted);
        Assert.False(result.ServiceDeleted);
        Assert.Equal(0, services.StopCalls);
        Assert.Equal(0, services.DeleteCalls);
        Assert.Equal(1, eventLog.RemoveCalls);
    }

    [Fact]
    public async Task UninstallStopsThenDeletesExistingService()
    {
        using var fixture = new InstallFixture();
        var services = new FakeServiceControlManager(
            fixture.ExactSnapshot(ServiceRuntimeState.Running));
        var eventLog = new RecordingLifecycleEventLog();
        await using var log = new RecordingBridgeLog();
        ServiceInstaller installer = fixture.CreateInstaller(
            services,
            eventLog,
            log);

        UninstallResult result = await installer.UninstallAsync(
            CancellationToken.None);

        Assert.True(result.ServiceExisted);
        Assert.True(result.ServiceDeleted);
        Assert.Equal(["stop", "delete"], services.Mutations);
        Assert.Contains(
            eventLog.Events,
            entry => entry.Code == "service_uninstalled");
        Assert.Equal(1, eventLog.RemoveCalls);
    }

    [Fact]
    public async Task UninstallRefusesConflictingRegistrationWithoutMutation()
    {
        using var fixture = new InstallFixture();
        // Any account other than the canonical one; LocalSystem is now the
        // canonical logon account and would no longer be a conflict.
        ServiceSnapshot conflicting = fixture.ExactSnapshot(
            ServiceRuntimeState.Running) with
        {
            AccountName = @"NT AUTHORITY\NetworkService",
        };
        var services = new FakeServiceControlManager(conflicting);
        var eventLog = new RecordingLifecycleEventLog();
        await using var log = new RecordingBridgeLog();
        ServiceInstaller installer = fixture.CreateInstaller(
            services,
            eventLog,
            log);

        ServiceRegistrationConflictException error =
            await Assert.ThrowsAsync<ServiceRegistrationConflictException>(
                () => installer.UninstallAsync(CancellationToken.None));

        Assert.Contains("account", error.Message, StringComparison.Ordinal);
        Assert.Empty(services.Mutations);
        Assert.Equal(0, eventLog.RemoveCalls);
    }

    private sealed class InstallFixture : IDisposable
    {
        private readonly string _root = Path.Combine(
            Path.GetTempPath(),
            $"revagent-bridge-service-tests-{Guid.NewGuid():N}");

        internal InstallFixture()
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

        internal ServiceInstaller CreateInstaller(
            IServiceControlManager services,
            ILifecycleEventLog eventLog,
            IBridgeLog log) =>
            new(
                Layout,
                Layout.HostExecutablePath,
                services,
                eventLog,
                log,
                isWindows: static () => true);

        internal ServiceSnapshot ExactSnapshot(ServiceRuntimeState state) =>
            new(
                BridgeInstallLayout.ServiceName,
                BridgeInstallLayout.ServiceDisplayName,
                ServiceInstaller.ServiceDescription,
                ServiceInstaller.QuoteServiceBinaryPath(
                    Layout.HostExecutablePath),
                BridgeInstallLayout.ServiceAccount,
                Automatic: true,
                DelayedAutomatic: true,
                OwnProcess: true,
                NormalErrorControl: true,
                State: state);

        public void Dispose()
        {
            if (Directory.Exists(_root))
            {
                Directory.Delete(_root, recursive: true);
            }
        }
    }

    private sealed class FakeServiceControlManager : IServiceControlManager
    {
        private ServiceSnapshot? _snapshot;

        internal FakeServiceControlManager(ServiceSnapshot? snapshot = null)
        {
            _snapshot = snapshot;
        }

        internal List<ServiceDefinition> Created { get; } = [];
        internal List<string> Mutations { get; } = [];
        internal int StartCalls { get; private set; }
        internal int StopCalls { get; private set; }
        internal int DeleteCalls { get; private set; }
        internal Exception? StartException { get; init; }

        public ValueTask<ServiceSnapshot?> QueryAsync(
            string serviceName,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(_snapshot);
        }

        public ValueTask CreateAsync(
            ServiceDefinition definition,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Created.Add(definition);
            Mutations.Add("create");
            _snapshot = new ServiceSnapshot(
                definition.Name,
                definition.DisplayName,
                definition.Description,
                definition.BinaryPathName,
                definition.AccountName,
                definition.Automatic,
                definition.DelayedAutomatic,
                definition.OwnProcess,
                definition.NormalErrorControl,
                ServiceRuntimeState.Stopped);
            return ValueTask.CompletedTask;
        }

        public ValueTask StartAsync(
            string serviceName,
            TimeSpan timeout,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            StartCalls++;
            Mutations.Add("start");
            if (StartException is not null)
            {
                return ValueTask.FromException(StartException);
            }

            _snapshot = _snapshot! with { State = ServiceRuntimeState.Running };
            return ValueTask.CompletedTask;
        }

        public ValueTask StopAsync(
            string serviceName,
            TimeSpan timeout,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            StopCalls++;
            Mutations.Add("stop");
            if (_snapshot is not null)
            {
                _snapshot = _snapshot with { State = ServiceRuntimeState.Stopped };
            }

            return ValueTask.CompletedTask;
        }

        public ValueTask DeleteAsync(
            string serviceName,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            DeleteCalls++;
            Mutations.Add("delete");
            _snapshot = null;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class RecordingLifecycleEventLog : ILifecycleEventLog
    {
        internal List<LifecycleEvent> Events { get; } = [];
        internal int EnsureCalls { get; private set; }
        internal int RemoveCalls { get; private set; }

        public bool EnsureSource()
        {
            EnsureCalls++;
            return true;
        }

        public void Write(LifecycleEvent entry) => Events.Add(entry);

        public void RemoveSource() => RemoveCalls++;
    }

    private sealed class RecordingBridgeLog : IBridgeLog
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
