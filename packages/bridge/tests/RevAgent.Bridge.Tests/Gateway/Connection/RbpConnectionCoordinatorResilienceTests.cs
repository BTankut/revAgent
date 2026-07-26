using System.Collections.Concurrent;
using System.Diagnostics;
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
    public async Task OldConnectionGenerationCannotConfirmTombstone()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot local = LocalSession(8080, 1000);
        await store.PersistRegisteredSessionAsync(
            Registration(local, "rs-8080"));
        _ = await store.RecordUnregisterIntentAsync(
            "rs-8080",
            RbpSessionUnregisterReason.RevitExited);
        _ = await store.ActivateConnectionGenerationAsync(1);
        _ = await store.ActivateConnectionGenerationAsync(2);

        RbpJournalException stale =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.ApplyHeartbeatFenceAcknowledgementAsync(
                    new RbpHeartbeatFence(
                        ConnectionGeneration: 1,
                        ExpectedActiveRsids: Array.Empty<string>(),
                        Acknowledgements:
                            Array.Empty<RbpSessionAcknowledgement>(),
                        ConfirmUnregisterRsids:
                            new[] { "rs-8080" })));

        Assert.Equal(
            RbpJournalErrorCode.InvalidHeartbeatFence,
            stale.ErrorCode);
        Assert.Equal(
            RbpUnregisterPhase.Pending,
            (await store.GetUnregisterTombstoneAsync("rs-8080"))!.Phase);
    }

    [Fact]
    public async Task SleepWakeGapClosesSocketAndUsesNewGeneration()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var first = new FakeConnectionCycle(responder.Respond);
        var second = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(first, second);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => factory.OpenCount == 1);
        clock.Advance(TimeSpan.FromSeconds(65));

        await EventuallyAsync(() => factory.OpenCount == 2);
        Assert.True(first.CloseCount > 0);
        Assert.DoesNotContain(
            first.Sent,
            item => item.Type == "heartbeat");
        Assert.Equal(2, coordinator.GetSnapshot().ConnectionGeneration);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task FullJitterResetsOnlyAfterContinuousSteadyWindow()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var first = new FakeConnectionCycle(responder.Respond);
        var second = new FakeConnectionCycle(responder.Respond);
        var third = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(
            first,
            second,
            third);
        var random = new FixedRandomSource(0.5);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock,
            random: random);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(() => factory.OpenCount == 1);
        first.Fail(new IOException("early failure"));
        await EventuallyAsync(
            () => coordinator.GetSnapshot().Lifecycle.Phase ==
                  RbpConnectionPhase.Backoff);
        RbpRetryDecision early =
            coordinator.GetSnapshot().Lifecycle.LastRetryDecision!;
        Assert.False(early.ResetApplied);
        Assert.Equal(0, early.WaitAttemptIndex);

        clock.Advance(TimeSpan.FromMilliseconds(501));
        await EventuallyAsync(() => factory.OpenCount == 2);
        await EventuallyAsync(
            () =>
            {
                RbpConnectionCoordinatorSnapshot snapshot =
                    coordinator.GetSnapshot();
                return snapshot.ConnectionGeneration == 2 &&
                       snapshot.HasActiveConnection &&
                       snapshot.OwnedBackgroundTaskCount == 2;
            });
        await EventuallyAsync(
            () => clock.HasDelayDueIn(TimeSpan.FromSeconds(15)));
        for (int heartbeat = 0; heartbeat < 8; heartbeat++)
        {
            int expected = heartbeat + 1;
            clock.Advance(TimeSpan.FromSeconds(15));
            await EventuallyAsync(
                () => second.Sent.Count(
                    item => item.Type == "heartbeat") >= expected);
            await EventuallyAsync(
                () => clock.HasDelayDueIn(TimeSpan.FromSeconds(15)));
        }

        second.Fail(new IOException("steady failure"));
        await EventuallyAsync(
            () => coordinator.GetSnapshot().Lifecycle.Phase ==
                  RbpConnectionPhase.Backoff);
        RbpRetryDecision steady =
            coordinator.GetSnapshot().Lifecycle.LastRetryDecision!;
        Assert.True(steady.ResetApplied);
        Assert.Equal(0, steady.WaitAttemptIndex);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task ShutdownIsBoundedAndLeavesNoOwnedTask()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var cycle = new FakeConnectionCycle(
            responder: _ => null,
            hangCloseAndDispose: true);
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(),
            clock,
            closeTimeout: TimeSpan.FromMilliseconds(20));
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().HasActiveConnection);
        var stopwatch = Stopwatch.StartNew();
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(1));

        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(1));
        Assert.Equal(
            0,
            coordinator.GetSnapshot().OwnedBackgroundTaskCount);
    }

}
