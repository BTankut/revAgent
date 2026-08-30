using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using System.Threading.Channels;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed partial class RbpConnectionCoordinatorTests
{
    [Fact]
    public async Task SnapshotProjectsOnlyTheCurrentRouteRebindProofGrant()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(
            responder.Respond,
            grantedConnectionCapabilities:
                new[] { RbpHelloProfile.RouteRebindProofCapability });
        var profile = new RbpHelloProfile(
            "0.1.0", "WS01", "Windows 11", new[] { "2026.07.26.0" },
            new[] { RbpHelloProfile.RouteRebindProofCapability });
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle), store,
            new MutableSessionCatalog(LocalSession(8080, 1000)), clock,
            helloProfile: profile);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => coordinator.GetSnapshot().HasActiveConnection);
        Assert.True(coordinator.GetSnapshot().RouteRebindProofGranted);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.False(coordinator.GetSnapshot().RouteRebindProofGranted);
    }

    [Fact]
    public async Task RegistersTwoSessionsAndOwnsHeartbeatLifecycle()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var catalog = new MutableSessionCatalog(
            LocalSession(8080, 1000),
            LocalSession(8081, 1001));
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            catalog,
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 2);

        Assert.Equal(
            new[] { "rs-8080", "rs-8081" },
            coordinator.GetSnapshot().ActiveRsids);
        Assert.Equal(
            2,
            cycle.Sent.Count(item => item.Type == "session_register"));
        Assert.DoesNotContain(
            cycle.Sent,
            envelope =>
                envelope.Payload.GetRawText().Contains(
                    "mcp_status",
                    StringComparison.Ordinal));

        clock.Advance(TimeSpan.FromSeconds(15));
        await EventuallyAsync(
            () => cycle.Sent.Any(item => item.Type == "heartbeat"));

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
        RbpConnectionCoordinatorSnapshot stopped =
            coordinator.GetSnapshot();
        Assert.Equal(RbpConnectionPhase.Shutdown, stopped.Lifecycle.Phase);
        Assert.Equal(0, stopped.OwnedBackgroundTaskCount);
        Assert.False(stopped.HasActiveConnection);
    }

    [Fact]
    public async Task ReconnectResumePreservesSequenceAndOutboxIdentity()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot local = LocalSession(8080, 1000);
        await store.PersistRegisteredSessionAsync(
            Registration(local, "rs-8080"));
        RbpQueueOutboundResult queued = await store.QueueOutboundDataAsync(
            "rs-8080",
            new RbpOutboundDataDraft(
                "result",
                Id(201),
                Json("""{"status":"success"}"""),
                Timestamp: clock.UtcNow.ToString("O")));
        var responder = new ScriptedGatewayResponder(clock);
        var first = new FakeConnectionCycle(responder.Respond);
        var second = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(first, second);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(local),
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => first.Sent.Any(item => item.Scope == RbpEnvelopeScope.Data));
        RbpEnvelope firstReplay = Assert.Single(
            first.Sent,
            item => item.Scope == RbpEnvelopeScope.Data);
        Assert.Equal(queued.Envelope!.Id, firstReplay.Id);
        Assert.Equal(1, firstReplay.Sequence);

        first.Fail(new IOException("link killed"));
        await EventuallyAsync(() => factory.OpenCount == 2);
        await EventuallyAsync(
            () => second.Sent.Any(
                item => item.Scope == RbpEnvelopeScope.Data));
        RbpEnvelope secondReplay = Assert.Single(
            second.Sent,
            item => item.Scope == RbpEnvelopeScope.Data);

        Assert.Equal(firstReplay.Id, secondReplay.Id);
        Assert.Equal(firstReplay.Sequence, secondReplay.Sequence);
        Assert.Equal(
            firstReplay.Payload.GetRawText(),
            secondReplay.Payload.GetRawText());
        Assert.Equal(2, coordinator.GetSnapshot().ConnectionGeneration);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task InboundDataNeedsAtomicJournalHandoffBeforeAckFrontier()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var handoff = new RecordingInboundJournal();
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            clock,
            handoff);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        cycle.Deliver(
            DataEnvelope(
                "invoke",
                Id(301),
                "rs-8080",
                1,
                Json($$"""{"invocation_id":"{{Id(302)}}"}""")));

        await EventuallyAsync(() => handoff.Count == 1);
        RbpReceiveFrontier frontier =
            await store.GetReceiveFrontierAsync("rs-8080");
        Assert.Equal(1, frontier.LastAcceptedSequence);
        Assert.Equal(1, frontier.LastJournaledSequence);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task RegistrationIsDurableBeforeFollowingDataIsExposed()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var handoff = new RecordingInboundJournal();
        int delivered = 0;
        cycle.AfterResponse = envelope =>
        {
            if (envelope.Type == "session_register" &&
                Interlocked.Exchange(ref delivered, 1) == 0)
            {
                cycle.Deliver(
                    DataEnvelope(
                        "invoke",
                        Id(351),
                        "rs-8080",
                        1,
                        Json($$"""{"invocation_id":"{{Id(352)}}"}""")));
            }
        };
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            clock,
            handoff);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => handoff.Count == 1);

        Assert.Equal(
            new[] { "rs-8080" },
            coordinator.GetSnapshot().ActiveRsids);
        Assert.Equal(
            1,
            (await store.GetReceiveFrontierAsync("rs-8080"))
            .LastJournaledSequence);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task UnregisterIsSentBeforeHeartbeatFenceDeletesSession()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var catalog = new MutableSessionCatalog(
            LocalSession(8080, 1000));
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            catalog,
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        catalog.Replace();
        clock.Advance(TimeSpan.FromSeconds(15));

        await EventuallyAsync(
            async () =>
                await store.GetStoredSessionAsync("rs-8080") is null);
        RbpEnvelope[] sent = cycle.Sent.ToArray();
        int unregisterIndex = Array.FindIndex(
            sent,
            item => item.Type == "session_unregister");
        int heartbeatIndex = Array.FindIndex(
            sent,
            item => item.Type == "heartbeat");
        Assert.True(unregisterIndex >= 0);
        Assert.True(heartbeatIndex > unregisterIndex);
        Assert.Empty(coordinator.GetSnapshot().ActiveRsids);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task PresteadyStopPublishesPrimaryBeforeBlockedOpenSettles()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var factory = new BlockingOpenFactory();
        var cycle = new FakeConnectionCycle(
            new ScriptedGatewayResponder(clock).Respond);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock,
            closeTimeout: TimeSpan.FromSeconds(1));
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        try
        {
            await factory.Entered.WaitAsync(TimeSpan.FromSeconds(2));
            Task<RbpCoordinatorTeardownResult> teardown =
                coordinator.RequestStopTeardown();
            RbpCoordinatorTeardownResult primary = await teardown.WaitAsync(
                TimeSpan.FromMilliseconds(250));

            Assert.Equal(
                RbpCoordinatorTeardownDisposition.EmergencyMustExit,
                primary.Disposition);
            Assert.False(run.IsCompleted);
        }
        finally
        {
            stop.Cancel();
            factory.Release(cycle);
        }

        RbpCoordinatorException failure =
            await Assert.ThrowsAsync<RbpCoordinatorException>(
                () => run.WaitAsync(TimeSpan.FromSeconds(2)));
        Assert.Equal(
            RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
            failure.ErrorCode);
        Assert.Equal(1, cycle.CloseCount);
        Assert.Equal(1, cycle.DisposeCount);
    }

    [Fact]
    public async Task RetryIdleStopPublishesOneFreshNormalJoinDeadline()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var factory = new PausedOpenFactory();
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock,
            closeTimeout: TimeSpan.FromMilliseconds(500));
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);
        try
        {
            await EventuallyAsync(() =>
                factory.OpenCount == 1 &&
                AttemptStopState(coordinator) == 5 &&
                coordinator.GetSnapshot().Lifecycle.Phase ==
                    RbpConnectionPhase.RetryPaused);
            Task<RbpCoordinatorTeardownResult> first =
                coordinator.RequestStopTeardown();
            Task<RbpCoordinatorTeardownResult> repeated =
                coordinator.RequestStopTeardown();

            Assert.Same(first, repeated);
            RbpCoordinatorTeardownResult result = await first;
            Assert.Equal(
                RbpCoordinatorTeardownDisposition.NormalStopped,
                result.Disposition);
            Assert.NotNull(result.DeadlineTimestamp);
            Assert.InRange(
                result.Remaining(TimeSpan.Zero),
                TimeSpan.Zero,
                TimeSpan.FromMilliseconds(500));
        }
        finally
        {
            stop.Cancel();
        }
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public void AttemptRegistryIsExactlyTwelveAndRejectsLiveOverwrite()
    {
        Type coordinatorType = typeof(RbpConnectionCoordinator);
        Type leafType = coordinatorType.GetNestedType(
            "AttemptLeaf", BindingFlags.NonPublic) ??
            throw new MissingMemberException("AttemptLeaf");
        Type registryType = coordinatorType.GetNestedType(
            "AttemptLeafRegistry", BindingFlags.NonPublic) ??
            throw new MissingMemberException("AttemptLeafRegistry");
        Type preparedType = coordinatorType.GetNestedType(
            "PreparedAttemptLeaf", BindingFlags.NonPublic) ??
            throw new MissingMemberException("PreparedAttemptLeaf");
        Assert.Equal(12, Enum.GetValues(leafType).Length);
        object registry = Activator.CreateInstance(
            registryType, nonPublic: true) ??
            throw new InvalidOperationException("Attempt registry unavailable.");
        ConstructorInfo constructor = preparedType.GetConstructors(
                BindingFlags.Instance | BindingFlags.NonPublic)
            .Single();
        var never = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        object first = constructor.Invoke(
            new object[] { registry, 1L, (Func<Task>)(() => never.Task) });
        object second = constructor.Invoke(
            new object[] { registry, 1L, (Func<Task>)(() => Task.CompletedTask) });
        MethodInfo publish = registryType.GetMethod(
            "TryPublish", BindingFlags.Instance | BindingFlags.NonPublic) ??
            throw new MissingMethodException("AttemptLeafRegistry.TryPublish");
        object slot = Enum.Parse(leafType, "TransportOpen");
        var holder = new object();

        Assert.True((bool)publish.Invoke(
            registry, new[] { slot, first, holder })!);
        Assert.False((bool)publish.Invoke(
            registry, new[] { slot, second, holder })!);

        MethodInfo abort = registryType.GetMethod(
            "AbortPrepared", BindingFlags.Instance | BindingFlags.NonPublic) ??
            throw new MissingMethodException(
                "AttemptLeafRegistry.AbortPrepared");
        abort.Invoke(registry, null);
        MethodInfo abortLeaf = preparedType.GetMethod(
            "AbortBeforeStart",
            BindingFlags.Instance | BindingFlags.NonPublic) ??
            throw new MissingMethodException(
                "PreparedAttemptLeaf.AbortBeforeStart");
        _ = abortLeaf.Invoke(second, null);
    }

    [Fact]
    public async Task InvariantNonDrainingIsStickyAndRefusesReplacementRun()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var factory = new NullCycleFactory();
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock);

        RbpCoordinatorException first =
            await Assert.ThrowsAsync<RbpCoordinatorException>(
                () => coordinator.RunAsync());
        RbpCoordinatorException restart =
            await Assert.ThrowsAsync<RbpCoordinatorException>(
                () => coordinator.RunAsync());

        Assert.Equal(
            RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
            first.ErrorCode);
        Assert.Equal(
            RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
            restart.ErrorCode);
        Assert.Equal(1, factory.OpenCount);
        Assert.Equal(4, AttemptStopState(coordinator));
    }

    [Fact]
    public async Task WrappedNonDrainingIsStickyAndRefusesReplacementRun()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var factory = new WrappedNonDrainingFactory();
        var coordinator = Coordinator(
            factory, store, new MutableSessionCatalog(), clock);

        RbpCoordinatorException first =
            await Assert.ThrowsAsync<RbpCoordinatorException>(
                () => coordinator.RunAsync());
        RbpCoordinatorException restart =
            await Assert.ThrowsAsync<RbpCoordinatorException>(
                () => coordinator.RunAsync());

        Assert.Equal(
            RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
            first.ErrorCode);
        Assert.Equal(
            RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
            restart.ErrorCode);
        Assert.Equal(1, factory.OpenCount);
        Assert.Equal(4, AttemptStopState(coordinator));
    }

    private sealed class BlockingOpenFactory : IRbpConnectionCycleFactory
    {
        private readonly TaskCompletionSource<IRbpConnectionCycle> _cycle =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _entered =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal Task Entered => _entered.Task;

        public RbpConnectionBindingKind BindingKind =>
            RbpConnectionBindingKind.Wss;

        public Task<IRbpConnectionCycle> OpenAsync(
            Uri endpoint,
            RbpHelloProfile profile,
            CancellationToken cancellationToken = default)
        {
            _ = endpoint;
            _ = profile;
            _ = cancellationToken;
            _entered.TrySetResult();
            return _cycle.Task;
        }

        internal void Release(IRbpConnectionCycle cycle) =>
            _cycle.TrySetResult(cycle);
    }

    private sealed class NullCycleFactory : IRbpConnectionCycleFactory
    {
        private int _openCount;
        internal int OpenCount => Volatile.Read(ref _openCount);
        public RbpConnectionBindingKind BindingKind =>
            RbpConnectionBindingKind.Wss;

        public Task<IRbpConnectionCycle> OpenAsync(
            Uri endpoint,
            RbpHelloProfile profile,
            CancellationToken cancellationToken = default)
        {
            _ = endpoint;
            _ = profile;
            cancellationToken.ThrowIfCancellationRequested();
            Interlocked.Increment(ref _openCount);
            return Task.FromResult<IRbpConnectionCycle>(null!);
        }
    }

    private sealed class PausedOpenFactory : IRbpConnectionCycleFactory
    {
        private int _openCount;
        internal int OpenCount => Volatile.Read(ref _openCount);
        public RbpConnectionBindingKind BindingKind =>
            RbpConnectionBindingKind.Wss;

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
                new RbpGatewayTransportException(
                    RbpGatewayFailureKind.Version,
                    "scripted version pause"));
        }
    }

    private sealed class WrappedNonDrainingFactory :
        IRbpConnectionCycleFactory
    {
        private int _openCount;
        internal int OpenCount => Volatile.Read(ref _openCount);
        public RbpConnectionBindingKind BindingKind =>
            RbpConnectionBindingKind.Wss;

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
                new InvalidOperationException(
                    "wrapped invariant failure",
                    new RbpCoordinatorException(
                        RbpCoordinatorErrorCode
                            .NonDrainingConnectionAuthority,
                        "nested non-draining authority")));
        }
    }

    private static int AttemptStopState(
        RbpConnectionCoordinator coordinator) =>
        (int)(typeof(RbpConnectionCoordinator).GetField(
                  "_attemptStopState",
                  BindingFlags.Instance | BindingFlags.NonPublic)?
              .GetValue(coordinator) ??
          throw new MissingFieldException("_attemptStopState"));

}
