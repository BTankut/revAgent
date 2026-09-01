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
using RevAgent.Bridge.Diagnostics;
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
    private static readonly TimeSpan EnrollmentArtifactCommandTimeout =
        TimeSpan.FromSeconds(45);
    private static readonly TimeSpan EnrollmentArtifactCancellationLead =
        TimeSpan.FromSeconds(5);

    public static async Task<int> Main(string[] args)
    {
        if (!args.Contains("--diagnostic-state-root", StringComparer.Ordinal) &&
            AttestationHelperProtocol.IsHelperCommand(args))
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
                WorkerCommandKind.ReEnrollFile =>
                    await RunEnrollmentArtifactAsync(command)
                        .ConfigureAwait(false),
                WorkerCommandKind.Run => await RunWorkerAsync(command)
                    .ConfigureAwait(false),
                _ => throw new InvalidOperationException(
                    $"Unsupported worker command kind '{command.Kind}'."),
            };
        }
        catch (WorkerDoctorStateException)
        {
            Console.Error.WriteLine("diagnostic_state_invalid");
            return ConfigurationExitCode;
        }
        catch (WorkerCommandLineException)
        {
            Console.Error.WriteLine("diagnostic_state_command_invalid");
            return UsageExitCode;
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
        BridgeDoctorReport report = await CreateDoctorReportAsync(command,
            new WorkerDoctorDependencies(
                () => BridgeCredentialReader.CreateProduction(BridgeInstallLayout.Canonical),
                isolated => WorkerDoctorState.Open(isolated),
                lease => lease.CreateReader(),
                BridgeConfigurationLoader.LoadFromCurrentEnvironment,
                configuration => BridgeDoctor.RunAsync(configuration),
                configuration => BridgeEnrollmentDoctor.RunReEnrollAsync(
                    () => BridgeCredentialReader.CreateProduction(BridgeInstallLayout.Canonical),
                    () => new BridgeEnrollmentCoordinator(
                        BridgeCredentialMutator.CreateProduction(BridgeInstallLayout.Canonical),
                        new BridgeEnrollmentExchangeClient(
                            BridgeEnrollmentExchangeClient
                                .CreateEnrollmentEndpoint(
                                    configuration.GatewayUri))),
                    Environment.GetEnvironmentVariable(
                        BridgeEnrollmentDoctor
                            .EnrollmentTokenEnvironmentVariable))))
            .ConfigureAwait(false);
        Console.Out.WriteLine(
            JsonSerializer.Serialize(
                report,
                new JsonSerializerOptions
                {
                    WriteIndented = false,
                }));
        return 0;
    }

    internal static async Task<BridgeDoctorReport> CreateDoctorReportAsync(
        WorkerCommand command, WorkerDoctorDependencies dependencies)
    {
        if (command.DiagnosticStateRoot is not null)
        {
            WorkerDoctorState.ValidateCommand(command);
            try
            {
                using WorkerDoctorState lease = dependencies.OpenIsolatedState(command);
                BridgeDoctorEnrollmentReport enrollment = BridgeEnrollmentDoctor.CreateStateReport(
                    () => dependencies.CreateIsolatedReader(lease));
                lease.VerifyEmpty();
                if (enrollment.Enrolled || enrollment.Error is not null ||
                    enrollment.ReEnrollAttempted || enrollment.ReEnrollSucceeded is not null)
                {
                    throw new WorkerDoctorStateException();
                }
                ResolvedBridgeConfiguration configuration = dependencies.LoadConfiguration(RequireConfigurationPath(command));
                BridgeDoctorReport report = await dependencies.RunProbes(configuration).ConfigureAwait(false);
                lease.VerifyEmpty();
                return report with { Enrollment = enrollment, StateScope = "isolated_diagnostic" };
            }
            catch { throw new WorkerDoctorStateException(); }
        }

        ResolvedBridgeConfiguration ordinaryConfiguration = dependencies.LoadConfiguration(RequireConfigurationPath(command));
        BridgeDoctorEnrollmentReport ordinaryEnrollment = command.ReEnroll
            ? await dependencies.ReEnroll(ordinaryConfiguration).ConfigureAwait(false)
            : BridgeEnrollmentDoctor.CreateStateReport(dependencies.CreateCanonicalReader);
        BridgeDoctorReport ordinaryReport = await dependencies.RunProbes(ordinaryConfiguration).ConfigureAwait(false);
        return ordinaryReport with { Enrollment = ordinaryEnrollment };
    }

    private static async Task<int> RunEnrollmentArtifactAsync(
        WorkerCommand command)
    {
        string? ambientToken = Environment.GetEnvironmentVariable(
            BridgeEnrollmentDoctor.EnrollmentTokenEnvironmentVariable);
        string configurationPath = RequireConfigurationPath(command);
        string artifactPath = command.EnrollmentArtifactPath ??
            throw new InvalidOperationException(
                "The enrollment artifact path is missing.");
        BridgeInstallLayout layout = BridgeInstallLayout.Canonical;
        var consumer = new BridgeEnrollmentArtifactConsumer(
            new WindowsBridgeEnrollmentArtifactSource(),
            async (token, cancellationToken) =>
            {
                ResolvedBridgeConfiguration configuration =
                    BridgeConfigurationLoader.LoadFromCurrentEnvironment(
                        configurationPath);
                var coordinator = new BridgeEnrollmentCoordinator(
                    BridgeCredentialMutator.CreateProduction(layout),
                    new BridgeEnrollmentExchangeClient(
                        BridgeEnrollmentExchangeClient
                            .CreateEnrollmentEndpoint(
                                configuration.GatewayUri)));
                _ = await coordinator
                    .ReEnrollExistingIdentityAsync(
                        token,
                        cancellationToken)
                    .ConfigureAwait(false);
            });
        Func<CancellationToken, Task<BridgeEnrollmentArtifactConsumerResult>>
            operation = !string.IsNullOrEmpty(ambientToken)
                ? cancellationToken =>
                    consumer.RefuseAmbiguousSecretSourceAsync(
                        artifactPath,
                        cancellationToken)
                : cancellationToken =>
                    consumer.ConsumeAsync(artifactPath, cancellationToken);
        BridgeEnrollmentArtifactConsumerResult result =
            await RunBoundedEnrollmentArtifactCommandAsync(
                    operation,
                    EnrollmentArtifactCommandTimeout,
                    EnrollmentArtifactCancellationLead)
                .ConfigureAwait(false);
        return WriteEnrollmentArtifactResult(result);
    }

    internal static async Task<BridgeEnrollmentArtifactConsumerResult>
        RunBoundedEnrollmentArtifactCommandAsync(
            Func<
                CancellationToken,
                Task<BridgeEnrollmentArtifactConsumerResult>> operation,
            TimeSpan commandTimeout,
            TimeSpan cancellationLead)
    {
        ArgumentNullException.ThrowIfNull(operation);
        if (commandTimeout <= TimeSpan.Zero ||
            cancellationLead <= TimeSpan.Zero ||
            cancellationLead >= commandTimeout)
        {
            throw new ArgumentOutOfRangeException(
                nameof(commandTimeout),
                "The bounded command timeout and cancellation lead are " +
                "invalid.");
        }

        using var cancellation = new CancellationTokenSource();
        cancellation.CancelAfter(commandTimeout - cancellationLead);
        Task<BridgeEnrollmentArtifactConsumerResult> attempt = Task.Run(
            () => operation(cancellation.Token),
            CancellationToken.None);
        try
        {
            return await attempt.WaitAsync(commandTimeout)
                .ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            cancellation.Cancel();
            _ = attempt.ContinueWith(
                static completed => _ = completed.Exception,
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted |
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
            return CreateEnrollmentArtifactRefusal("cleanup_uncertain");
        }
        catch (OperationCanceledException)
        {
            return CreateEnrollmentArtifactRefusal("operation_cancelled");
        }
        catch
        {
            return CreateEnrollmentArtifactRefusal("operation_failed");
        }
    }

    private static BridgeEnrollmentArtifactConsumerResult
        CreateEnrollmentArtifactRefusal(string error) =>
            new(
                Ok: false,
                Action: BridgeEnrollmentArtifactConsumer.Action,
                ContractVersion:
                    BridgeEnrollmentArtifactConsumer.ContractVersion,
                ArtifactContractVersion:
                    BridgeEnrollmentArtifactConsumer.ArtifactContractVersion,
                ReEnrollAttempted: false,
                ReEnrollSucceeded: false,
                SourceAbsent: false,
                Error: error);

    private static int WriteEnrollmentArtifactResult(
        BridgeEnrollmentArtifactConsumerResult result)
    {
        Console.Out.WriteLine(
            JsonSerializer.Serialize(
                result,
                new JsonSerializerOptions { WriteIndented = false }));
        return result.ExitCode;
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
