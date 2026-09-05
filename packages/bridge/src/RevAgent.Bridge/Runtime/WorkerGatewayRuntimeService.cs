using Microsoft.Extensions.Hosting;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Gateway.Connection;

namespace RevAgent.Bridge.Runtime;

/// <summary>
/// Runs the RBP data plane inside the supervised worker process, beside
/// <see cref="WorkerControlService"/>.
/// </summary>
/// <remarks>
/// <para>
/// The fail-closed matrix this service implements:
/// </para>
/// <list type="bullet">
/// <item>
/// <description>
/// <b>Missing or malformed precondition.</b> Composition happens in
/// <see cref="StartAsync"/>. A journal that cannot open, a credential store
/// that cannot be constructed, or a configuration the coordinator refuses
/// throws out of host startup, so the worker exits non-successfully with a
/// structured reason and no partially wired runtime ever runs.
/// </description>
/// </item>
/// <item>
/// <description>
/// <b>Not enrolled.</b> The runtime starts and attempts to connect. The
/// unchanged handshake refuses with <c>enrollment_required</c>, the connection
/// reducer parks in the frozen <c>RetryPaused</c>/<c>Auth</c> state, and the
/// coordinator waits on its retry-condition signal instead of reconnecting.
/// The worker keeps serving its control channel and exits cleanly on stop.
/// </description>
/// </item>
/// <item>
/// <description>
/// <b>Unreachable Gateway.</b> Connecting is a background task started after
/// composition, so SCM start never waits on the network, and reconnect keeps
/// the existing full-jitter backoff.
/// </description>
/// </item>
/// <item>
/// <description>
/// <b>Poisoned connection authority.</b> A connection-owned handler that
/// ignores cancellation past the bounded close deadline surfaces as
/// <see cref="RbpCoordinatorErrorCode.NonDrainingConnectionAuthority"/>. This
/// service treats that as a must-exit condition: it fails the worker exit
/// state and stops the application rather than letting anything open a
/// replacement generation in the poisoned process.
/// </description>
/// </item>
/// </list>
/// </remarks>
internal sealed class WorkerGatewayRuntimeService : IHostedService,
    IAsyncDisposable
{
    /// <summary>
    /// The drain budget for a stop. Deliberately below the supervisor's
    /// 8-second graceful stop timeout so a slow drain is bounded here rather
    /// than by a forced process-tree kill.
    /// </summary>
    internal static readonly TimeSpan DefaultStopBudget =
        TimeSpan.FromSeconds(5);

    private const string LogCategory = nameof(WorkerGatewayRuntimeService);

    private readonly Func<WorkerGatewayRuntime> _runtimeFactory;
    private readonly IHostApplicationLifetime _applicationLifetime;
    private readonly IBridgeLog _log;
    private readonly WorkerExitState _exitState;
    private readonly TimeSpan _stopBudget;
    private readonly Func<CancellationToken, Task>? _beforeConnect;

    private WorkerGatewayRuntime? _runtime;
    private readonly object _disposeSync = new();
    private CancellationTokenSource? _runCancellation;
    private Task _run = Task.CompletedTask;
    private Task? _disposeTask;
    private int _disposed;
    private int _mustExit;

    internal WorkerGatewayRuntimeService(
        Func<WorkerGatewayRuntime> runtimeFactory,
        IHostApplicationLifetime applicationLifetime,
        IBridgeLog log,
        WorkerExitState exitState,
        TimeSpan? stopBudget = null,
        Func<CancellationToken, Task>? beforeConnect = null)
    {
        _runtimeFactory = runtimeFactory ??
            throw new ArgumentNullException(nameof(runtimeFactory));
        _applicationLifetime = applicationLifetime ??
            throw new ArgumentNullException(nameof(applicationLifetime));
        _log = log ?? throw new ArgumentNullException(nameof(log));
        _exitState = exitState ??
            throw new ArgumentNullException(nameof(exitState));
        _stopBudget = stopBudget ?? DefaultStopBudget;
        _beforeConnect = beforeConnect;
        if (_stopBudget <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(stopBudget));
        }
    }

    /// <summary>
    /// True once the runtime object graph exists. A false value after a
    /// failed start is the evidence that nothing half-built survived.
    /// </summary>
    internal bool IsComposed => Volatile.Read(ref _runtime) is not null;

    internal WorkerGatewayRuntime? Runtime => Volatile.Read(ref _runtime);

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        WorkerGatewayRuntime runtime;
        try
        {
            runtime = _runtimeFactory() ??
                throw new InvalidOperationException(
                    "The worker gateway runtime factory returned no runtime.");
        }
        catch (Exception exception)
        {
            _exitState.Fail();
            await TryLogAsync(
                    "Error",
                    "worker.gateway_runtime_precondition_failed",
                    "The worker gateway runtime could not be composed; the " +
                    "worker will not run a partially wired data plane.",
                    exception)
                .ConfigureAwait(false);
            throw;
        }

        Volatile.Write(ref _runtime, runtime);
        _runCancellation = new CancellationTokenSource();

        // Connecting is background work on purpose: SCM start must never wait
        // on Gateway reachability or on enrollment being present.
        _run = RunAsync(_runCancellation.Token);
        await TryLogAsync(
                "Information",
                "worker.gateway_runtime_started",
                "The worker gateway runtime is composed and connecting.")
            .ConfigureAwait(false);
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        WorkerGatewayRuntime? runtime = Volatile.Read(ref _runtime);
        Task<RbpCoordinatorTeardownResult>? teardown =
            runtime?.Coordinator.RequestStopTeardown();
        _runCancellation?.Cancel();
        RbpCoordinatorTeardownResult? teardownResult = null;
        if (teardown is not null)
        {
            teardownResult = await teardown.ConfigureAwait(false);
            if (teardownResult.Disposition ==
                RbpCoordinatorTeardownDisposition.EmergencyMustExit)
            {
                Interlocked.Exchange(ref _mustExit, 1);
                ObserveRetainedTask(_run);
                FailStopBudget();
                return;
            }
        }
        TimeSpan remaining = teardownResult?.Remaining(_stopBudget) ??
            _stopBudget;
        if (remaining <= TimeSpan.Zero)
        {
            ObserveRetainedTask(_run);
            FailStopBudget();
            return;
        }
        // The coordinator supplies the absolute attempt deadline. This one CTS
        // is created from its exact remainder and is shared by the Root join
        // and runtime disposal; it is not a second graceful-work budget.
        using var budget = new CancellationTokenSource(remaining);
        Task run = _run;
        if (!run.IsCompleted)
        {
            try
            {
                await run.WaitAsync(budget.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
                when (budget.IsCancellationRequested)
            {
                ObserveRetainedTask(run);
                FailStopBudget();
                return;
            }
        }

        if (budget.IsCancellationRequested)
        {
            FailStopBudget();
            return;
        }

        Task dispose = DisposeAsync().AsTask();
        try
        {
            await dispose.WaitAsync(budget.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
            when (budget.IsCancellationRequested)
        {
            ObserveRetainedTask(dispose);
            FailStopBudget();
        }
    }

    public ValueTask DisposeAsync()
    {
        TaskCompletionSource? owner = null;
        Task dispose;
        lock (_disposeSync)
        {
            if (_disposeTask is null)
            {
                owner = new TaskCompletionSource(
                    TaskCreationOptions.RunContinuationsAsynchronously);
                _disposeTask = owner.Task;
            }
            dispose = _disposeTask;
        }
        if (owner is not null) _ = CompleteDisposeAsync(owner);
        return new ValueTask(dispose);
    }

    private async Task CompleteDisposeAsync(TaskCompletionSource completion)
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            completion.TrySetResult();
            return;
        }
        try
        {
            Task run = _run;
            WorkerGatewayRuntime? runtime = Volatile.Read(ref _runtime);
            Task<RbpCoordinatorTeardownResult>? teardown =
                !run.IsCompleted && runtime is not null
                    ? runtime.Coordinator.RequestStopTeardown()
                    : null;
            // Direct Dispose owns the same decisive ordering as StopAsync:
            // publish the exact coordinator owner before cancelling Root.
            _runCancellation?.Cancel();
            if (Volatile.Read(ref _mustExit) != 0)
            {
                ObserveRetainedTask(run);
                completion.TrySetResult();
                return;
            }
            RbpCoordinatorTeardownResult? teardownResult = null;
            if (teardown is not null)
            {
                teardownResult = await teardown.ConfigureAwait(false);
                if (teardownResult.Disposition ==
                    RbpCoordinatorTeardownDisposition.EmergencyMustExit)
                {
                    ObserveRetainedTask(run);
                    FailStopBudget();
                    completion.TrySetResult();
                    return;
                }
            }
            TimeSpan remaining = teardownResult?.Remaining(_stopBudget) ??
                _stopBudget;
            if (remaining <= TimeSpan.Zero)
            {
                ObserveRetainedTask(run);
                FailStopBudget();
                completion.TrySetResult();
                return;
            }
            using var budget = new CancellationTokenSource(remaining);
            if (!run.IsCompleted)
            {
                try
                {
                    await run.WaitAsync(budget.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                    when (budget.IsCancellationRequested)
                {
                    ObserveRetainedTask(run);
                    FailStopBudget();
                    completion.TrySetResult();
                    return;
                }
            }
            // RunAsync can discover a must-exit authority failure while this
            // method is awaiting it. Recheck at the disposal boundary so a
            // quarantined runtime is retained and never touched by normal
            // disposal after the poison winner publishes.
            if (Volatile.Read(ref _mustExit) != 0)
            {
                ObserveRetainedTask(run);
                completion.TrySetResult();
                return;
            }
            if (budget.IsCancellationRequested)
            {
                FailStopBudget();
                completion.TrySetResult();
                return;
            }
            if (runtime is not null)
            {
                Task dispose = runtime.DisposeAsync().AsTask();
                try
                {
                    await dispose.WaitAsync(budget.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                    when (budget.IsCancellationRequested)
                {
                    ObserveRetainedTask(dispose);
                    FailStopBudget();
                    completion.TrySetResult();
                    return;
                }
            }

            _runCancellation?.Dispose();
            _runCancellation = null;
            completion.TrySetResult();
        }
        catch (Exception exception)
        {
            completion.TrySetException(exception);
        }
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        WorkerGatewayRuntime runtime = Volatile.Read(ref _runtime)!;
        try
        {
            if (_beforeConnect is not null)
                await _beforeConnect(cancellationToken).ConfigureAwait(false);
            await runtime.RunAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
            when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (RbpCoordinatorException exception)
            when (exception.ErrorCode ==
                  RbpCoordinatorErrorCode.NonDrainingConnectionAuthority)
        {
            Interlocked.Exchange(ref _mustExit, 1);
            // The P3-T4 host-wiring prerequisite: non-draining connection
            // authority is a must-exit condition, not a reconnect condition.
            _exitState.Fail();
            await TryLogAsync(
                    "Error",
                    "worker.gateway_authority_poisoned",
                    "RBP connection authority is poisoned; the worker must " +
                    "exit so no replacement generation opens in this process.",
                    exception)
                .ConfigureAwait(false);
            _applicationLifetime.StopApplication();
        }
        catch (Exception exception)
        {
            _exitState.Fail();
            await TryLogAsync(
                    "Error",
                    "worker.gateway_runtime_failed",
                    "The worker gateway runtime stopped with an unrecoverable " +
                    "fault.",
                    exception)
                .ConfigureAwait(false);
            _applicationLifetime.StopApplication();
        }
    }

    private void FailStopBudget()
    {
        Interlocked.Exchange(ref _mustExit, 1);
        _exitState.Fail();
        _applicationLifetime.StopApplication();
        _ = TryLogAsync(
            "Error",
            "worker.gateway_runtime_drain_timeout",
            "The worker gateway runtime did not prove shutdown within its " +
            "single stop deadline; process exit is required.");
    }

    private static void ObserveRetainedTask(Task task) =>
        _ = task.ContinueWith(
            completed => _ = completed.Exception,
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted |
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

    private async ValueTask TryLogAsync(
        string level,
        string eventId,
        string message,
        Exception? exception = null)
    {
        try
        {
            await _log.WriteAsync(
                    level,
                    eventId,
                    LogCategory,
                    message,
                    exception,
                    CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch
        {
            // Logging must never own worker lifecycle.
        }
    }
}
