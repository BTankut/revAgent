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

}
