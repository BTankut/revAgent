using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Host.Hosting;
using RevAgent.Bridge.Host.Platform;

namespace RevAgent.Bridge.Host.Install;

internal sealed record InstallResult(
    bool ServiceCreated,
    bool ServiceStarted,
    ServiceRuntimeState State);

internal sealed record UninstallResult(
    bool ServiceExisted,
    bool ServiceDeleted);

internal sealed class ServiceRegistrationConflictException : Exception
{
    internal ServiceRegistrationConflictException(string message)
        : base(message)
    {
    }
}

internal sealed class ServiceInstaller
{
    internal const string ServiceDescription =
        "Maintains the outbound revAgent Bridge connection and supervises its worker.";

    private static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan StopTimeout = TimeSpan.FromSeconds(10);

    private readonly BridgeInstallLayout _layout;
    private readonly string _executingHostPath;
    private readonly IServiceControlManager _services;
    private readonly ILifecycleEventLog _eventLog;
    private readonly IBridgeLog _log;
    private readonly TimeProvider _timeProvider;
    private readonly Func<bool> _isWindows;

    internal ServiceInstaller(
        BridgeInstallLayout layout,
        string executingHostPath,
        IServiceControlManager services,
        ILifecycleEventLog eventLog,
        IBridgeLog log,
        TimeProvider? timeProvider = null,
        Func<bool>? isWindows = null)
    {
        _layout = layout ?? throw new ArgumentNullException(nameof(layout));
        _executingHostPath = executingHostPath ??
            throw new ArgumentNullException(nameof(executingHostPath));
        _services = services ?? throw new ArgumentNullException(nameof(services));
        _eventLog = eventLog ?? throw new ArgumentNullException(nameof(eventLog));
        _log = log ?? throw new ArgumentNullException(nameof(log));
        _timeProvider = timeProvider ?? TimeProvider.System;
        _isWindows = isWindows ?? OperatingSystem.IsWindows;
    }

    internal async Task<InstallResult> InstallAsync(
        CancellationToken cancellationToken)
    {
        ValidateInstallationInputs();

        bool eventSourceCreated = false;
        bool serviceCreated = false;
        bool serviceStarted = false;
        try
        {
            ServiceDefinition desired = CreateDefinition();
            ServiceSnapshot? existing = await _services.QueryAsync(
                desired.Name,
                cancellationToken).ConfigureAwait(false);
            if (existing is null)
            {
                await _services.CreateAsync(desired, cancellationToken)
                    .ConfigureAwait(false);
                serviceCreated = true;
            }
            else
            {
                EnsureExactRegistration(existing, desired);
            }

            eventSourceCreated = _eventLog.EnsureSource();

            ServiceSnapshot? beforeStart = await _services.QueryAsync(
                desired.Name,
                cancellationToken).ConfigureAwait(false);
            if (beforeStart?.State != ServiceRuntimeState.Running)
            {
                await _services.StartAsync(
                    desired.Name,
                    StartTimeout,
                    cancellationToken).ConfigureAwait(false);
                serviceStarted = true;
            }

            ServiceSnapshot afterStart = await _services.QueryAsync(
                desired.Name,
                cancellationToken).ConfigureAwait(false) ??
                throw new InvalidOperationException(
                    "SCM service disappeared after start.");
            if (afterStart.State != ServiceRuntimeState.Running)
            {
                throw new InvalidOperationException(
                    $"SCM reported '{afterStart.State}' after service start.");
            }

            TryWriteLifecycleEvent(
                2000,
                "service_installed",
                LifecycleEventLevel.Information,
                serviceCreated
                    ? "revAgent Bridge service was installed and started."
                    : "Existing exact revAgent Bridge service registration was started or already running.");
            await TryLogAsync(
                "information",
                "service_installed",
                $"Service install completed; created={serviceCreated}, " +
                $"started={serviceStarted}, state={afterStart.State}.",
                cancellationToken).ConfigureAwait(false);

            return new InstallResult(
                serviceCreated,
                serviceStarted,
                afterStart.State);
        }
        catch
        {
            if (serviceCreated)
            {
                await BestEffortRollbackAsync().ConfigureAwait(false);
            }

            if (eventSourceCreated)
            {
                try
                {
                    _eventLog.RemoveSource();
                }
                catch
                {
                    // Preserve the original install exception.
                }
            }

            throw;
        }
    }

    internal async Task<UninstallResult> UninstallAsync(
        CancellationToken cancellationToken)
    {
        ServiceSnapshot? existing = await _services.QueryAsync(
            BridgeInstallLayout.ServiceName,
            cancellationToken).ConfigureAwait(false);
        if (existing is null)
        {
            TryRemoveEventSource();
            return new UninstallResult(
                ServiceExisted: false,
                ServiceDeleted: false);
        }

        EnsureExactRegistration(existing, CreateDefinition());
        await _services.StopAsync(
            BridgeInstallLayout.ServiceName,
            StopTimeout,
            cancellationToken).ConfigureAwait(false);
        await _services.DeleteAsync(
            BridgeInstallLayout.ServiceName,
            cancellationToken).ConfigureAwait(false);

        TryWriteLifecycleEvent(
            2001,
            "service_uninstalled",
            LifecycleEventLevel.Information,
            "revAgent Bridge service was stopped and uninstalled.");
        await TryLogAsync(
            "information",
            "service_uninstalled",
            "Service stop and delete completed.",
            cancellationToken).ConfigureAwait(false);
        TryRemoveEventSource();
        return new UninstallResult(
            ServiceExisted: true,
            ServiceDeleted: true);
    }

    private ServiceDefinition CreateDefinition() =>
        new(
            BridgeInstallLayout.ServiceName,
            BridgeInstallLayout.ServiceDisplayName,
            ServiceDescription,
            QuoteServiceBinaryPath(_layout.HostExecutablePath),
            BridgeInstallLayout.ServiceAccount,
            Automatic: true,
            DelayedAutomatic: true,
            OwnProcess: true,
            NormalErrorControl: true);

    private void ValidateInstallationInputs()
    {
        if (!_isWindows())
        {
            throw new PlatformNotSupportedException(
                "revAgent Bridge service installation is Windows-only.");
        }

        string executing = Path.GetFullPath(_executingHostPath);
        string canonical = Path.GetFullPath(_layout.HostExecutablePath);
        if (!File.Exists(executing) ||
            !string.Equals(executing, canonical, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Install must run from the canonical stable host '{canonical}'.");
        }

        _ = WorkerExecutableResolver.Resolve(_layout);
        if (!Path.IsPathFullyQualified(_layout.ConfigurationPath) ||
            !File.Exists(_layout.ConfigurationPath))
        {
            throw new FileNotFoundException(
                "Bridge configuration is missing from the machine state root.",
                _layout.ConfigurationPath);
        }
    }

    private static void EnsureExactRegistration(
        ServiceSnapshot existing,
        ServiceDefinition desired)
    {
        var mismatches = new List<string>();
        if (!string.Equals(
            existing.DisplayName,
            desired.DisplayName,
            StringComparison.Ordinal))
        {
            mismatches.Add("display_name");
        }

        if (!string.Equals(
            existing.Description,
            desired.Description,
            StringComparison.Ordinal))
        {
            mismatches.Add("description");
        }

        if (!string.Equals(
            existing.BinaryPathName.Trim(),
            desired.BinaryPathName,
            StringComparison.OrdinalIgnoreCase))
        {
            mismatches.Add("binary_path");
        }

        if (!string.Equals(
            existing.AccountName,
            desired.AccountName,
            StringComparison.OrdinalIgnoreCase))
        {
            mismatches.Add("account");
        }

        if (existing.Automatic != desired.Automatic)
        {
            mismatches.Add("start_mode");
        }

        if (existing.DelayedAutomatic != desired.DelayedAutomatic)
        {
            mismatches.Add("delayed_auto");
        }

        if (existing.OwnProcess != desired.OwnProcess)
        {
            mismatches.Add("service_type");
        }

        if (existing.NormalErrorControl != desired.NormalErrorControl)
        {
            mismatches.Add("error_control");
        }

        if (mismatches.Count != 0)
        {
            throw new ServiceRegistrationConflictException(
                $"Service '{desired.Name}' already exists with conflicting " +
                $"configuration: {string.Join(", ", mismatches)}.");
        }
    }

    private async Task BestEffortRollbackAsync()
    {
        try
        {
            await _services.StopAsync(
                BridgeInstallLayout.ServiceName,
                StopTimeout,
                CancellationToken.None).ConfigureAwait(false);
        }
        catch
        {
            // Continue to deletion.
        }

        try
        {
            await _services.DeleteAsync(
                BridgeInstallLayout.ServiceName,
                CancellationToken.None).ConfigureAwait(false);
        }
        catch
        {
            // Preserve the original install exception.
        }
    }

    private void TryWriteLifecycleEvent(
        int eventId,
        string code,
        LifecycleEventLevel level,
        string message)
    {
        try
        {
            _eventLog.Write(
                new LifecycleEvent(
                    eventId,
                    code,
                    level,
                    message,
                    _timeProvider.GetUtcNow()));
        }
        catch
        {
            // File logging remains authoritative when Event Log is unavailable.
        }
    }

    private void TryRemoveEventSource()
    {
        try
        {
            _eventLog.RemoveSource();
        }
        catch
        {
            // Service removal must not be reversed by Event Log cleanup failure.
        }
    }

    private async ValueTask TryLogAsync(
        string level,
        string eventId,
        string message,
        CancellationToken cancellationToken)
    {
        try
        {
            await _log.WriteAsync(
                level,
                eventId,
                "host.install",
                message,
                cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            // Logging must not own SCM state transitions.
        }
    }

    internal static string QuoteServiceBinaryPath(string executablePath)
    {
        if (!Path.IsPathFullyQualified(executablePath) ||
            executablePath.Contains('"', StringComparison.Ordinal))
        {
            throw new ArgumentException(
                "Service executable path must be absolute and contain no quote.",
                nameof(executablePath));
        }

        return $"\"{Path.GetFullPath(executablePath)}\"";
    }
}
