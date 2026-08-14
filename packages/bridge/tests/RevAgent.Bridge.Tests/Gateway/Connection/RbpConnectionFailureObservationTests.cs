using System.Collections.Concurrent;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed partial class RbpConnectionCoordinatorTests
{
    [Fact]
    public async Task AuthorizationRefusalObserverIsValueFreeAndCannotRetry()
    {
        const string correlationId =
            "018f3f5e-7b6a-7abc-8def-0123456789ab";
        string[] canaries =
        [
            "SYNTHETIC-CREDENTIAL-DO-NOT-LOG",
            "SYNTHETIC-TOKEN-DO-NOT-LOG",
            "SYNTHETIC-HOST-DO-NOT-LOG",
            "SYNTHETIC-PATH-DO-NOT-LOG",
            "SYNTHETIC-EXCEPTION-DO-NOT-LOG",
        ];
        RbpGatewayTransportException Refusal(string suffix) =>
            new RbpGatewayTransportException(
                RbpGatewayFailureKind.Authorization,
                string.Join("|", canaries) + suffix,
                closeCode: 4403,
                innerException: new InvalidOperationException(
                    canaries[^1]))
            .WithOpeningContext(correlationId, RbpOpeningBinding.Wss);

        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var factory = new RefusingConnectionCycleFactory(
            Refusal("-first"),
            Refusal("-second"));
        var observations = new ConcurrentQueue<
            RbpConnectionFailureObservation>();
        var log = new RecordingObservationLog();
        int callbackCount = 0;
        var postAwaitFaultReached = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock,
            onConnectionFailureObservation: async observation =>
            {
                observations.Enqueue(observation);
                Interlocked.Increment(ref callbackCount);
                await RevAgent.Bridge.Program.LogGatewayRetryPaused(
                        log,
                        observation)
                    .ConfigureAwait(false);
                await Task.Yield();
                postAwaitFaultReached.TrySetResult();
                throw new InvalidOperationException(
                    "SYNTHETIC-OBSERVER-FAULT");
            });
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => Volatile.Read(ref callbackCount) == 1 &&
                  coordinator.GetSnapshot().Lifecycle.Phase ==
                  RbpConnectionPhase.RetryPaused);
        await postAwaitFaultReached.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await Task.Delay(100);

        RbpConnectionCoordinatorSnapshot first = coordinator.GetSnapshot();
        Assert.Equal(1, factory.OpenCount);
        Assert.Equal(1, Volatile.Read(ref callbackCount));
        Assert.Equal(RbpConnectionPhase.RetryPaused, first.Lifecycle.Phase);
        Assert.Equal(
            RbpRetryPauseReason.Auth,
            first.Lifecycle.RetryPauseReason);
        Assert.Equal(
            RbpRetryAction.Pause,
            first.Lifecycle.LastRetryDecision!.Action);
        RbpConnectionFailureObservation observation =
            Assert.Single(observations);
        Assert.Equal(correlationId, observation.CorrelationId);
        Assert.Equal(RbpOpeningBinding.Wss, observation.Binding);
        Assert.Equal(
            RbpGatewayFailureKind.Authorization,
            observation.GatewayFailure);
        Assert.Equal(
            RbpRetryWaitAuthority.RetryConditionSignal,
            observation.WaitAuthority);
        string expectedMessage =
            "observer_contract=revagent.m4-rbp-refusal-observer/v1 " +
            $"correlation_id={correlationId} binding=wss " +
            "gateway_failure=authorization http_status=none " +
            "close_code=4403 opening_failure=auth " +
            "phase=retry_paused retry_pause_reason=auth " +
            "retry_action=pause wait_authority=retry_condition_signal";
        Assert.Equal(expectedMessage, observation.ToLogMessage());

        ObservationLogEntry logged = Assert.Single(log.Entries);
        Assert.Equal("Warning", logged.Level);
        Assert.Equal("worker.gateway_retry_paused", logged.EventId);
        Assert.Equal("RbpConnection", logged.Category);
        Assert.Equal(expectedMessage, logged.Message);
        Assert.Null(logged.Exception);
        foreach (string canary in canaries.Append(
                     "SYNTHETIC-OBSERVER-FAULT"))
        {
            Assert.DoesNotContain(
                canary,
                logged.Message,
                StringComparison.Ordinal);
        }

        // Only the existing explicit retry-condition authority may open the
        // next attempt; neither observation nor its post-await callback fault
        // can release authority or terminate the worker.
        coordinator.NotifyRetryConditionChanged();
        await EventuallyAsync(
            () => factory.OpenCount == 2 &&
                  Volatile.Read(ref callbackCount) == 2);
        Assert.Equal(
            RbpConnectionPhase.RetryPaused,
            coordinator.GetSnapshot().Lifecycle.Phase);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    private sealed class RefusingConnectionCycleFactory :
        IRbpConnectionCycleFactory
    {
        private readonly Queue<Exception> _failures;
        private int _openCount;

        internal RefusingConnectionCycleFactory(params Exception[] failures)
        {
            _failures = new Queue<Exception>(failures);
        }

        internal int OpenCount => Volatile.Read(ref _openCount);

        public Task<IRbpConnectionCycle> OpenAsync(
            Uri endpoint,
            RbpHelloProfile profile,
            CancellationToken cancellationToken = default)
        {
            _ = endpoint;
            _ = profile;
            cancellationToken.ThrowIfCancellationRequested();
            Interlocked.Increment(ref _openCount);
            return Task.FromException<IRbpConnectionCycle>(
                _failures.Dequeue());
        }
    }

    private sealed class RecordingObservationLog : IBridgeLog
    {
        internal ConcurrentQueue<ObservationLogEntry> Entries { get; } =
            new();

        public ValueTask WriteAsync(
            string level,
            string eventId,
            string category,
            string message,
            Exception? exception = null,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Entries.Enqueue(
                new ObservationLogEntry(
                    level,
                    eventId,
                    category,
                    message,
                    exception));
            return ValueTask.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed record ObservationLogEntry(
        string Level,
        string EventId,
        string Category,
        string Message,
        Exception? Exception);
}
