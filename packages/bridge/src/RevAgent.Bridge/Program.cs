using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Bridge.Bootstrap.Diagnostics;
using RevAgent.Bridge.Bootstrap.Logging;

namespace RevAgent.Bridge;

internal static class Program
{
    private const int UsageExitCode = 64;
    private const int ConfigurationExitCode = 78;
    private const int SoftwareExitCode = 70;

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
        BridgeDoctorReport report = await BridgeDoctor.RunAsync(configuration)
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
        builder.Services.AddSingleton<IHostedService>(
            services => new WorkerControlService(
                services.GetRequiredService<WorkerRuntimeOptions>(),
                services.GetRequiredService<IWorkerControlSessionFactory>(),
                services.GetRequiredService<IHostApplicationLifetime>(),
                services.GetRequiredService<IBridgeLog>(),
                services.GetRequiredService<WorkerExitState>()));

        using IHost host = builder.Build();
        await host.RunAsync().ConfigureAwait(false);
        return exitState.ExitCode;
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
