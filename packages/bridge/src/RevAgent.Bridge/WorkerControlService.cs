using System.Reflection;
using Microsoft.Extensions.Hosting;
using RevAgent.Bridge.Bootstrap.Control;
using RevAgent.Bridge.Bootstrap.Logging;

namespace RevAgent.Bridge;

internal sealed class WorkerControlService : BackgroundService
{
    private readonly WorkerRuntimeOptions _options;
    private readonly IWorkerControlSessionFactory _sessionFactory;
    private readonly IHostApplicationLifetime _applicationLifetime;
    private readonly IBridgeLog _log;
    private readonly WorkerExitState _exitState;
    private IWorkerControlSession? _session;
    private int _stoppingSent;

    internal WorkerControlService(
        WorkerRuntimeOptions options,
        IWorkerControlSessionFactory sessionFactory,
        IHostApplicationLifetime applicationLifetime,
        IBridgeLog log,
        WorkerExitState exitState)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _sessionFactory = sessionFactory ??
            throw new ArgumentNullException(nameof(sessionFactory));
        _applicationLifetime = applicationLifetime ??
            throw new ArgumentNullException(nameof(applicationLifetime));
        _log = log ?? throw new ArgumentNullException(nameof(log));
        _exitState = exitState ?? throw new ArgumentNullException(nameof(exitState));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await WaitForApplicationStartedAsync(stoppingToken).ConfigureAwait(false);
            _session = await _sessionFactory.ConnectAsync(
                _options,
                stoppingToken).ConfigureAwait(false);

            await _session.SendAsync(
                new WorkerReady(
                    ControlProtocol.Version,
                    _options.InstanceId,
                    Environment.ProcessId,
                    GetWorkerVersion()),
                stoppingToken).ConfigureAwait(false);
            await _log.WriteAsync(
                "Information",
                "worker.ready",
                nameof(WorkerControlService),
                "Worker control channel is ready.",
                cancellationToken: stoppingToken).ConfigureAwait(false);

            ControlMessage? message = await _session.ReceiveAsync(
                stoppingToken).ConfigureAwait(false);
            switch (message)
            {
                case null:
                    Interlocked.Exchange(ref _stoppingSent, 1);
                    await _log.WriteAsync(
                        "Warning",
                        "worker.host_eof",
                        nameof(WorkerControlService),
                        "The host control pipe closed; the worker will stop.",
                        cancellationToken: stoppingToken).ConfigureAwait(false);
                    break;
                case StopWorker stop:
                    await _log.WriteAsync(
                        "Information",
                        "worker.stop_requested",
                        nameof(WorkerControlService),
                        $"Host requested worker stop for reason '{stop.Reason}'.",
                        cancellationToken: stoppingToken).ConfigureAwait(false);
                    await SendStoppingOnceAsync(stoppingToken).ConfigureAwait(false);
                    break;
                default:
                    throw new ControlProtocolException(
                        "control_message_unexpected",
                        $"Worker received unexpected host message '{message.Type}'.");
            }

            _applicationLifetime.StopApplication();
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            _exitState.Fail();
            try
            {
                await _log.WriteAsync(
                    "Error",
                    "worker.control_failed",
                    nameof(WorkerControlService),
                    "Worker control channel failed.",
                    exception,
                    CancellationToken.None).ConfigureAwait(false);
            }
            finally
            {
                _applicationLifetime.StopApplication();
            }
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        try
        {
            await SendStoppingOnceAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception)
            when (exception is IOException or ObjectDisposedException or ControlProtocolException)
        {
            await _log.WriteAsync(
                "Warning",
                "worker.stopping_signal_failed",
                nameof(WorkerControlService),
                "Worker could not send its stopping control message.",
                exception,
                CancellationToken.None).ConfigureAwait(false);
        }
        finally
        {
            if (_session is not null)
            {
                await _session.DisposeAsync().ConfigureAwait(false);
                _session = null;
            }
        }

        await base.StopAsync(cancellationToken).ConfigureAwait(false);
    }

    private async ValueTask SendStoppingOnceAsync(
        CancellationToken cancellationToken)
    {
        IWorkerControlSession? session = _session;
        if (session is null ||
            Interlocked.Exchange(ref _stoppingSent, 1) != 0)
        {
            return;
        }

        await session.SendAsync(
            new WorkerStopping(
                ControlProtocol.Version,
                _options.InstanceId,
                Environment.ProcessId),
            cancellationToken).ConfigureAwait(false);
    }

    private async Task WaitForApplicationStartedAsync(
        CancellationToken cancellationToken)
    {
        if (_applicationLifetime.ApplicationStarted.IsCancellationRequested)
        {
            return;
        }

        var completion = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        using CancellationTokenRegistration startedRegistration =
            _applicationLifetime.ApplicationStarted.Register(
                static state => ((TaskCompletionSource)state!).TrySetResult(),
                completion);
        using CancellationTokenRegistration cancellationRegistration =
            cancellationToken.Register(
                static state =>
                {
                    var tuple = ((TaskCompletionSource, CancellationToken))state!;
                    tuple.Item1.TrySetCanceled(tuple.Item2);
                },
                (completion, cancellationToken));
        await completion.Task.ConfigureAwait(false);
    }

    private static string GetWorkerVersion()
    {
        Assembly assembly = Assembly.GetEntryAssembly() ??
            typeof(WorkerControlService).Assembly;
        string version = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion ??
            assembly.GetName().Version?.ToString() ??
            "unknown";
        return version.Length <= 128 ? version : version[..128];
    }
}
