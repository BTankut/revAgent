using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Host.Hosting;
using RevAgent.Bridge.Host.Install;
using System.Reflection;
using System.Text.Json;

namespace RevAgent.Bridge.Host.Cli;

internal sealed class HostCommandDispatcher
{
    private const int MaxDoctorOutputBytes = 64 * 1024;

    private readonly BridgeInstallLayout _layout;
    private readonly ServiceInstaller _installer;
    private readonly IBridgeHostRunner _hostRunner;
    private readonly IWorkerProcessLauncher _workerLauncher;
    private readonly IBridgeLog _log;
    private readonly TextWriter _standardOutput;
    private readonly TextWriter _standardError;

    internal HostCommandDispatcher(
        BridgeInstallLayout layout,
        ServiceInstaller installer,
        IBridgeHostRunner hostRunner,
        IWorkerProcessLauncher workerLauncher,
        IBridgeLog log,
        TextWriter? standardOutput = null,
        TextWriter? standardError = null)
    {
        _layout = layout ?? throw new ArgumentNullException(nameof(layout));
        _installer = installer ?? throw new ArgumentNullException(nameof(installer));
        _hostRunner = hostRunner ?? throw new ArgumentNullException(nameof(hostRunner));
        _workerLauncher = workerLauncher ??
            throw new ArgumentNullException(nameof(workerLauncher));
        _log = log ?? throw new ArgumentNullException(nameof(log));
        _standardOutput = standardOutput ?? Console.Out;
        _standardError = standardError ?? Console.Error;
    }

    internal async Task<int> ExecuteAsync(
        HostCommand command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        try
        {
            return command.Kind switch
            {
                HostCommandKind.Install => await InstallAsync(cancellationToken)
                    .ConfigureAwait(false),
                HostCommandKind.Uninstall => await UninstallAsync(cancellationToken)
                    .ConfigureAwait(false),
                HostCommandKind.RunConsole => await _hostRunner.RunAsync(
                    windowsService: false,
                    cancellationToken).ConfigureAwait(false),
                HostCommandKind.Service => await _hostRunner.RunAsync(
                    windowsService: true,
                    cancellationToken).ConfigureAwait(false),
                HostCommandKind.Doctor => await DoctorAsync(
                    command.ReEnroll,
                    cancellationToken).ConfigureAwait(false),
                HostCommandKind.Version => await VersionAsync()
                    .ConfigureAwait(false),
                HostCommandKind.PrepareEnrollment => await PrepareEnrollmentAsync()
                    .ConfigureAwait(false),
                _ => throw new ArgumentOutOfRangeException(nameof(command)),
            };
        }
        catch (Exception ex) when (command.Kind is
            HostCommandKind.Install or HostCommandKind.Uninstall)
        {
            await _standardError.WriteLineAsync(ex.Message).ConfigureAwait(false);
            await TryLogAsync(
                "error",
                "service_command_failed",
                $"Service command '{command.Kind}' failed.",
                ex,
                cancellationToken).ConfigureAwait(false);
            return (int)HostExitCode.ServiceControl;
        }
        catch (Exception ex) when (command.Kind is
            HostCommandKind.Service or HostCommandKind.RunConsole)
        {
            await _standardError.WriteLineAsync(ex.Message).ConfigureAwait(false);
            await TryLogAsync(
                "error",
                "host_run_failed",
                $"Host command '{command.Kind}' failed.",
                ex,
                cancellationToken).ConfigureAwait(false);
            return (int)HostExitCode.WorkerLifecycle;
        }
        catch (Exception ex) when (command.Kind == HostCommandKind.Doctor)
        {
            await _standardError.WriteLineAsync(ex.Message).ConfigureAwait(false);
            await TryLogAsync(
                "error",
                "doctor_delegate_failed",
                "Worker doctor delegation failed.",
                ex,
                cancellationToken).ConfigureAwait(false);
            return (int)HostExitCode.DoctorFailed;
        }
    }

    private async Task<int> PrepareEnrollmentAsync()
    {
        // The signed installer calls this before requesting a fingerprint-bound
        // token. The existing protected store owns all randomness and DPAPI IO.
        using BridgeMachineIdentity identity =
            BridgeCredentialMutator.CreateProduction(_layout)
                .GetOrCreateMachineIdentity();
        await _standardOutput.WriteLineAsync(JsonSerializer.Serialize(new
        {
            ok = true,
            action = "prepare_bridge_enrollment",
            machineFingerprint = identity.MachineFingerprint,
        })).ConfigureAwait(false);
        return (int)HostExitCode.Success;
    }

    private async Task<int> InstallAsync(CancellationToken cancellationToken)
    {
        InstallResult result = await _installer.InstallAsync(cancellationToken)
            .ConfigureAwait(false);
        await _standardOutput.WriteLineAsync(
            $"revAgent Bridge service ready: state={result.State}, " +
            $"created={result.ServiceCreated}, started={result.ServiceStarted}.")
            .ConfigureAwait(false);
        return (int)HostExitCode.Success;
    }

    private async Task<int> UninstallAsync(CancellationToken cancellationToken)
    {
        UninstallResult result = await _installer.UninstallAsync(cancellationToken)
            .ConfigureAwait(false);
        await _standardOutput.WriteLineAsync(
            result.ServiceExisted
                ? "revAgent Bridge service stopped and removed."
                : "revAgent Bridge service was already absent.")
            .ConfigureAwait(false);
        return (int)HostExitCode.Success;
    }

    private async Task<int> DoctorAsync(
        bool reEnroll,
        CancellationToken cancellationToken)
    {
        ResolvedWorkerExecutable worker = WorkerExecutableResolver.Resolve(_layout);
        if (!File.Exists(_layout.ConfigurationPath))
        {
            throw new FileNotFoundException(
                "Bridge configuration file is missing.",
                _layout.ConfigurationPath);
        }

        Directory.CreateDirectory(_layout.BundleExtractionRoot);
        var arguments = new List<string>
        {
            "__doctor",
            "--config",
            _layout.ConfigurationPath,
        };
        if (reEnroll)
        {
            arguments.Add("--re-enroll");
            arguments.Add("true");
        }

        WorkerCommandResult result = await _workerLauncher.RunOneShotAsync(
            new WorkerOneShotRequest(
                worker.ExecutablePath,
                worker.WorkingDirectory,
                arguments,
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["DOTNET_BUNDLE_EXTRACT_BASE_DIR"] =
                        _layout.BundleExtractionRoot,
                },
                MaxDoctorOutputBytes),
            timeout: TimeSpan.FromSeconds(reEnroll ? 60 : 30),
            cancellationToken).ConfigureAwait(false);

        if (!string.IsNullOrEmpty(result.StandardError))
        {
            await _standardError.WriteAsync(result.StandardError).ConfigureAwait(false);
            if (!result.StandardError.EndsWith('\n'))
            {
                await _standardError.WriteLineAsync().ConfigureAwait(false);
            }
        }

        if (result.ExitCode != 0 ||
            !string.IsNullOrEmpty(result.StandardError) ||
            result.StandardOutputTruncated ||
            result.StandardErrorTruncated)
        {
            return (int)HostExitCode.DoctorFailed;
        }

        string json = result.StandardOutput.Trim();
        using JsonDocument document = JsonDocument.Parse(json);
        if (document.RootElement.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException(
                "Worker doctor output must be exactly one JSON object.");
        }

        await _standardOutput.WriteLineAsync(json).ConfigureAwait(false);
        return (int)HostExitCode.Success;
    }

    private async Task<int> VersionAsync()
    {
        string version =
            Assembly.GetExecutingAssembly()
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
                .InformationalVersion ??
            Assembly.GetExecutingAssembly().GetName().Version?.ToString() ??
            "unknown";
        await _standardOutput.WriteLineAsync(version).ConfigureAwait(false);
        return (int)HostExitCode.Success;
    }

    private async ValueTask TryLogAsync(
        string level,
        string eventId,
        string message,
        Exception exception,
        CancellationToken cancellationToken)
    {
        try
        {
            await _log.WriteAsync(
                level,
                eventId,
                "host.cli",
                message,
                exception,
                cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            // The command's actual exit code remains authoritative.
        }
    }
}
