using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Host.Platform;

namespace RevAgent.Bridge.Host.Hosting;

internal interface IBridgeHostRunner
{
    Task<int> RunAsync(
        bool windowsService,
        CancellationToken cancellationToken);
}

internal sealed class BridgeHostRunner : IBridgeHostRunner
{
    private readonly WorkerSupervisor _supervisor;
    private readonly IBridgeLog _log;
    private readonly ILifecycleEventLog _eventLog;
    private readonly HostRuntimeState _runtimeState;

    internal BridgeHostRunner(
        WorkerSupervisor supervisor,
        IBridgeLog log,
        ILifecycleEventLog eventLog,
        HostRuntimeState runtimeState)
    {
        _supervisor = supervisor ?? throw new ArgumentNullException(nameof(supervisor));
        _log = log ?? throw new ArgumentNullException(nameof(log));
        _eventLog = eventLog ?? throw new ArgumentNullException(nameof(eventLog));
        _runtimeState = runtimeState ??
            throw new ArgumentNullException(nameof(runtimeState));
    }

    public async Task<int> RunAsync(
        bool windowsService,
        CancellationToken cancellationToken)
    {
        IHostBuilder builder = Microsoft.Extensions.Hosting.Host
            .CreateDefaultBuilder(Array.Empty<string>())
            .ConfigureServices(services =>
            {
                services.AddSingleton(_supervisor);
                services.AddSingleton(_log);
                services.AddSingleton(_eventLog);
                services.AddSingleton(_runtimeState);
                services.AddSingleton<IHostedService>(provider =>
                    new BridgeHostService(
                        provider.GetRequiredService<WorkerSupervisor>(),
                        provider.GetRequiredService<IHostApplicationLifetime>(),
                        provider.GetRequiredService<IBridgeLog>(),
                        provider.GetRequiredService<ILifecycleEventLog>(),
                        provider.GetRequiredService<HostRuntimeState>(),
                        windowsService
                            ? WorkerStopReason.ScmStop
                            : WorkerStopReason.ConsoleStop));
            });

        if (windowsService)
        {
            builder.UseWindowsService(options =>
            {
                options.ServiceName =
                    BridgeInstallLayout.ServiceName;
            });
        }
        else
        {
            builder.UseConsoleLifetime();
        }

        using IHost host = builder.Build();
        await host.RunAsync(cancellationToken).ConfigureAwait(false);
        return _runtimeState.ExitCode;
    }
}
