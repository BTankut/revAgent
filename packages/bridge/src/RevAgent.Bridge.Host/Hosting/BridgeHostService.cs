using Microsoft.Extensions.Hosting;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Host.Cli;
using RevAgent.Bridge.Host.Platform;

namespace RevAgent.Bridge.Host.Hosting;

internal sealed class HostRuntimeState
{
    internal int ExitCode { get; set; }
}

internal sealed class BridgeHostService : IHostedService
{
    private readonly WorkerSupervisor _supervisor;
    private readonly IHostApplicationLifetime _applicationLifetime;
    private readonly IBridgeLog _log;
    private readonly ILifecycleEventLog _eventLog;
    private readonly HostRuntimeState _runtimeState;
    private readonly WorkerStopReason _stopReason;
    private readonly TimeProvider _timeProvider;

    private Task? _monitorTask;
    private int _stopping;

    internal BridgeHostService(
        WorkerSupervisor supervisor,
        IHostApplicationLifetime applicationLifetime,
        IBridgeLog log,
        ILifecycleEventLog eventLog,
        HostRuntimeState runtimeState,
        WorkerStopReason stopReason,
        TimeProvider? timeProvider = null)
    {
        _supervisor = supervisor ?? throw new ArgumentNullException(nameof(supervisor));
        _applicationLifetime = applicationLifetime ??
            throw new ArgumentNullException(nameof(applicationLifetime));
        _log = log ?? throw new ArgumentNullException(nameof(log));
        _eventLog = eventLog ?? throw new ArgumentNullException(nameof(eventLog));
        _runtimeState = runtimeState ??
            throw new ArgumentNullException(nameof(runtimeState));
        _stopReason = stopReason;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await TryLogAsync(
            "information",
            "host_starting",
            "Stable revAgent Bridge host is starting.",
            cancellationToken).ConfigureAwait(false);
        TryWriteEvent(
            1000,
            "host_starting",
            LifecycleEventLevel.Information,
            "Stable revAgent Bridge host is starting.");

        try
        {
            await _supervisor.StartAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _runtimeState.ExitCode = (int)HostExitCode.WorkerLifecycle;
            await TryLogAsync(
                "error",
                "worker_start_failed",
                "Bridge worker did not reach READY.",
                cancellationToken,
                ex).ConfigureAwait(false);
            TryWriteEvent(
                1900,
                "worker_start_failed",
                LifecycleEventLevel.Error,
                $"Bridge worker did not reach READY: {ex.Message}");
            throw;
        }

        TryWriteEvent(
            1001,
            "worker_ready",
            LifecycleEventLevel.Information,
            "Bridge worker reached READY.");
        _monitorTask = MonitorWorkerAsync();
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        Interlocked.Exchange(ref _stopping, 1);
        try
        {
            WorkerStopResult result = await _supervisor.StopAsync(
                _stopReason,
                WorkerSupervisor.GracefulStopTimeout,
                cancellationToken).ConfigureAwait(false);
            await TryLogAsync(
                result.Forced ? "error" : "information",
                result.Forced ? "worker_stop_forced" : "worker_stopped",
                result.Forced
                    ? "Bridge worker exceeded the stop deadline and was terminated."
                    : $"Bridge worker stopped with exit code {result.ExitCode?.ToString() ?? "unknown"}.",
                cancellationToken).ConfigureAwait(false);
            TryWriteEvent(
                result.Forced ? 1902 : 1002,
                result.Forced ? "worker_stop_forced" : "worker_stopped",
                result.Forced
                    ? LifecycleEventLevel.Error
                    : LifecycleEventLevel.Information,
                result.Forced
                    ? "Bridge worker exceeded the stop deadline and was terminated."
                    : "Bridge worker stopped.");
        }
        catch (InvalidOperationException)
        {
            // Startup failed before a worker became active.
        }
        finally
        {
            TryWriteEvent(
                1003,
                "host_stopped",
                LifecycleEventLevel.Information,
                "Stable revAgent Bridge host stopped.");
        }

        if (_monitorTask is not null)
        {
            try
            {
                await _monitorTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Host shutdown already owns the terminal state.
            }
        }
    }

    private async Task MonitorWorkerAsync()
    {
        try
        {
            WorkerExit exit = await _supervisor.WaitForExitAsync(
                CancellationToken.None).ConfigureAwait(false);
            if (Volatile.Read(ref _stopping) != 0)
            {
                return;
            }

            _runtimeState.ExitCode = (int)HostExitCode.WorkerLifecycle;
            string message =
                $"Bridge worker exited unexpectedly with code {exit.ExitCode}; " +
                $"restartCount={exit.RestartCount}, " +
                $"restartBudgetExhausted={exit.RestartBudgetExhausted}.";
            await TryLogAsync(
                "error",
                "worker_restart_budget_exhausted",
                message,
                CancellationToken.None).ConfigureAwait(false);
            TryWriteEvent(
                1901,
                "worker_restart_budget_exhausted",
                LifecycleEventLevel.Error,
                message);
            _applicationLifetime.StopApplication();
        }
        catch (Exception ex)
        {
            if (Volatile.Read(ref _stopping) != 0)
            {
                return;
            }

            _runtimeState.ExitCode = (int)HostExitCode.WorkerLifecycle;
            await TryLogAsync(
                "error",
                "worker_monitor_failed",
                "Worker monitor failed.",
                CancellationToken.None,
                ex).ConfigureAwait(false);
            TryWriteEvent(
                1903,
                "worker_monitor_failed",
                LifecycleEventLevel.Error,
                $"Worker monitor failed: {ex.Message}");
            _applicationLifetime.StopApplication();
        }
    }

    private async ValueTask TryLogAsync(
        string level,
        string eventId,
        string message,
        CancellationToken cancellationToken,
        Exception? exception = null)
    {
        try
        {
            await _log.WriteAsync(
                level,
                eventId,
                "host.lifecycle",
                message,
                exception,
                cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            // Logging must not own process lifecycle.
        }
    }

    private void TryWriteEvent(
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
            // JSONL logging remains available when Event Log is unavailable.
        }
    }
}
