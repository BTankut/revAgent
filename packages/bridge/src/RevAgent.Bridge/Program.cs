using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Bridge.Bootstrap.Diagnostics;
using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Enrollment;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Runtime;

namespace RevAgent.Bridge;

internal static class Program
{
    private const int UsageExitCode = 64;
    private const int ConfigurationExitCode = 78;
    private const int SoftwareExitCode = 70;

    /// <summary>
    /// Bounds the whole worker shutdown below the supervisor's 8-second
    /// graceful stop timeout, so a slow data-plane drain still returns before
    /// the host would force-kill the process tree.
    /// </summary>
    private static readonly TimeSpan WorkerShutdownTimeout =
        TimeSpan.FromSeconds(7);

    public static async Task<int> Main(string[] args)
    {
        if (AttestationHelperProtocol.IsHelperCommand(args))
        {
            return await WindowsAttestationHelperServer.RunAsync()
                .ConfigureAwait(false);
        }

        WorkerCommand command;
        try
        {
            command = WorkerCommandLine.Parse(args);
        }
        catch (WorkerCommandLineException exception)
        {
            Console.Error.WriteLine(exception.Message);
            Console.Error.WriteLine(WorkerCommandLine.Usage);
            return UsageExitCode;
        }

        try
        {
            return command.Kind switch
            {
                WorkerCommandKind.Version => WriteVersion(),
                WorkerCommandKind.Doctor => await RunDoctorAsync(command)
                    .ConfigureAwait(false),
                WorkerCommandKind.Run => await RunWorkerAsync(command)
                    .ConfigureAwait(false),
                _ => throw new InvalidOperationException(
                    $"Unsupported worker command kind '{command.Kind}'."),
            };
        }
        catch (BridgeConfigurationException exception)
        {
            Console.Error.WriteLine(
                $"Bridge configuration rejected ({exception.ErrorCode}): {exception.Message}");
            return ConfigurationExitCode;
        }
        catch (OperationCanceledException)
        {
            return SoftwareExitCode;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"Bridge worker failed ({exception.GetType().Name}): {exception.Message}");
            return SoftwareExitCode;
        }
    }

    private static int WriteVersion()
    {
        Console.Out.WriteLine(GetVersion());
        return 0;
    }

    private static async Task<int> RunDoctorAsync(WorkerCommand command)
    {
        ResolvedBridgeConfiguration configuration =
            BridgeConfigurationLoader.LoadFromCurrentEnvironment(
                RequireConfigurationPath(command));
        BridgeInstallLayout layout = BridgeInstallLayout.Canonical;
        BridgeDoctorEnrollmentReport enrollment = command.ReEnroll
            ? await BridgeEnrollmentDoctor.RunReEnrollAsync(
                    () => BridgeCredentialReader.CreateProduction(layout),
                    () => new BridgeEnrollmentCoordinator(
                        BridgeCredentialMutator.CreateProduction(layout),
                        new BridgeEnrollmentExchangeClient(
                            BridgeEnrollmentExchangeClient
                                .CreateEnrollmentEndpoint(
                                    configuration.GatewayUri))),
                    Environment.GetEnvironmentVariable(
                        BridgeEnrollmentDoctor
                            .EnrollmentTokenEnvironmentVariable))
                .ConfigureAwait(false)
            : BridgeEnrollmentDoctor.CreateStateReport(
                () => BridgeCredentialReader.CreateProduction(layout));
        BridgeDoctorReport report = await BridgeDoctor.RunAsync(configuration)
            .ConfigureAwait(false);
        report = report with { Enrollment = enrollment };
        Console.Out.WriteLine(
            JsonSerializer.Serialize(
                report,
                new JsonSerializerOptions
                {
                    WriteIndented = false,
                }));
        return 0;
    }

    private static async Task<int> RunWorkerAsync(WorkerCommand command)
    {
        var options = new WorkerRuntimeOptions(
            command.ControlPipeName ??
                throw new InvalidOperationException("The control pipe is missing."),
            command.ExpectedHostProcessId ??
                throw new InvalidOperationException("The host PID is missing."),
            command.InstanceId ??
                throw new InvalidOperationException("The instance id is missing."),
            RequireConfigurationPath(command));
        ResolvedBridgeConfiguration configuration =
            BridgeConfigurationLoader.LoadFromCurrentEnvironment(
                options.ConfigurationPath);
        BridgeInstallLayout layout = BridgeInstallLayout.Canonical;

        await using var bridgeLog = new RollingJsonBridgeLog(
            layout.WorkerLogDirectory,
            "worker",
            configuration.Logging.MaxFileBytes,
            configuration.Logging.RetainedFileCount);
        var exitState = new WorkerExitState();

        HostApplicationBuilder builder = Host.CreateApplicationBuilder(
            new HostApplicationBuilderSettings
            {
                Args = [],
                ApplicationName = typeof(Program).Assembly.GetName().Name,
                ContentRootPath = AppContext.BaseDirectory,
            });
        builder.Logging.ClearProviders();
        builder.Services.AddSingleton(options);
        builder.Services.AddSingleton(configuration);
        builder.Services.AddSingleton<IBridgeLog>(bridgeLog);
        builder.Services.AddSingleton(exitState);
        builder.Services.AddSingleton<IWorkerControlSessionFactory,
            NamedPipeWorkerControlSessionFactory>();
        builder.Services.Configure<HostOptions>(
            hostOptions => hostOptions.ShutdownTimeout = WorkerShutdownTimeout);
        builder.Services.AddSingleton<IHostedService>(
            services => new WorkerControlService(
                services.GetRequiredService<WorkerRuntimeOptions>(),
                services.GetRequiredService<IWorkerControlSessionFactory>(),
                services.GetRequiredService<IHostApplicationLifetime>(),
                services.GetRequiredService<IBridgeLog>(),
                services.GetRequiredService<WorkerExitState>()));

        // The RBP data plane runs in this same supervised process. It is
        // registered after the control service so the host starts the control
        // channel first and stops the data plane first: a stop request is
        // acknowledged on the pipe by the same service that owns it, while the
        // connection drains inside its own bounded budget.
        builder.Services.AddSingleton<IHostedService>(
            services => new WorkerGatewayRuntimeService(
                () => WorkerGatewayRuntime.CreateProduction(
                    layout,
                    services.GetRequiredService<ResolvedBridgeConfiguration>(),
                    onDiscovered: evidence => LogAddinDiscovery(
                        services.GetRequiredService<IBridgeLog>(),
                        evidence),
                    onDispatchDiagnostic: message => _ = services
                        .GetRequiredService<IBridgeLog>()
                        .WriteAsync(
                            "Information",
                            "worker.dispatch_trace",
                            "RbpDispatch",
                            message,
                            cancellationToken: CancellationToken.None)
                        .AsTask(),
                    onConnectionFailureObservation: observation =>
                        LogGatewayRetryPaused(
                            services.GetRequiredService<IBridgeLog>(),
                            observation)),
                services.GetRequiredService<IHostApplicationLifetime>(),
                services.GetRequiredService<IBridgeLog>(),
                services.GetRequiredService<WorkerExitState>()));

        using IHost host = builder.Build();
        await host.RunAsync().ConfigureAwait(false);
        return exitState.ExitCode;
    }

    /// <summary>
    /// Records one line per discovery pass. Without it a bridge that probes a
    /// live Revit and refuses it leaves no evidence at all: the connection stays
    /// healthy, no session is ever registered, and nothing on the machine says
    /// which port was rejected or why. The codes are bounded and carry no
    /// document or user data.
    /// </summary>
    private static void LogAddinDiscovery(
        IBridgeLog log,
        AddinDiscoveryEvidence evidence)
    {
        string accepted = evidence.AcceptedTargets.Count == 0
            ? "none"
            : string.Join(
                ",",
                evidence.AcceptedTargets.Select(target => target.Port));
        string rejected = evidence.RejectedTargets.Count == 0
            ? "none"
            : string.Join(
                ",",
                evidence.RejectedTargets.Select(
                    rejection => rejection.Detail is { Length: > 0 } detail
                        ? $"{rejection.Target.Port}:{rejection.Kind}:{rejection.Code} ({detail})"
                        : $"{rejection.Target.Port}:{rejection.Kind}:{rejection.Code}"));
        _ = log.WriteAsync(
                evidence.AcceptedTargets.Count == 0
                    ? "Warning"
                    : "Information",
                "worker.addin_discovery",
                "AddinDiscovery",
                $"Add-in discovery source={evidence.Source} " +
                $"probed={evidence.ProbedTargets.Count} " +
                $"accepted=[{accepted}] rejected=[{rejected}].",
                cancellationToken: CancellationToken.None)
            .AsTask();
    }

    internal static async ValueTask LogGatewayRetryPaused(
        IBridgeLog log,
        RbpConnectionFailureObservation observation)
    {
        ArgumentNullException.ThrowIfNull(log);
        ArgumentNullException.ThrowIfNull(observation);
        try
        {
            await log.WriteAsync(
                    "Warning",
                    "worker.gateway_retry_paused",
                    "RbpConnection",
                    observation.ToLogMessage(),
                    exception: null,
                    cancellationToken: CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch
        {
            // Evidence logging cannot own retry or worker lifecycle.
        }
    }

    private static string RequireConfigurationPath(WorkerCommand command) =>
        command.ConfigurationPath ??
        throw new InvalidOperationException("The configuration path is missing.");

    private static string GetVersion()
    {
        Assembly assembly = Assembly.GetEntryAssembly() ?? typeof(Program).Assembly;
        string version = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion ??
            assembly.GetName().Version?.ToString() ??
            "unknown";
        return version.Length <= 128 ? version : version[..128];
    }
}
