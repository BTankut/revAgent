using System.Diagnostics;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

/// <summary>
/// The coordinator side of invocation dispatch: the receive loop stays free
/// while the add-in works, Section 10.1 rejects the second invoke
/// deterministically, and a closing cycle is bounded.
/// </summary>
public sealed partial class RbpConnectionCoordinatorTests
{
    [Fact]
    public async Task AnInFlightInvocationDoesNotBlockTheReceiveLoop()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var handoff = new RecordingInboundJournal();
        var dispatcher = new StubInvocationDispatcher
        {
            Hold = new TaskCompletionSource(),
        };
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            clock,
            handoff,
            invocationDispatcher: dispatcher);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);

        cycle.Deliver(
            DataEnvelope(
                "invoke",
                Id(401),
                "rs-8080",
                1,
                Json($$"""{"invocation_id":"{{Id(402)}}"}""")));
        await EventuallyAsync(() => dispatcher.Dispatched.Count == 1);

        // The add-in is still working. A second inbound frame must still be
        // sequenced and journaled — this is the regression guard: awaiting the
        // dispatch on the receive loop would stall every later frame, including
        // the Section 16 cancel for the very invocation that is running.
        cycle.Deliver(
            DataEnvelope(
                "cancel",
                Id(403),
                "rs-8080",
                2,
                Json($$"""{"invocation_id":"{{Id(402)}}"}""")));

        await EventuallyAsync(() => handoff.Count == 2);
        RbpReceiveFrontier frontier =
            await store.GetReceiveFrontierAsync("rs-8080");
        Assert.Equal(2, frontier.LastJournaledSequence);
        Assert.Equal(1, coordinator.GetSnapshot().ActiveInvocationCount);

        dispatcher.Hold!.SetResult();
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task Section101RejectsTheSecondInvokeWithoutDispatchingIt()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var dispatcher = new StubInvocationDispatcher
        {
            Hold = new TaskCompletionSource(),
        };
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            clock,
            new RecordingInboundJournal(),
            invocationDispatcher: dispatcher);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);

        cycle.Deliver(
            DataEnvelope(
                "invoke",
                Id(411),
                "rs-8080",
                1,
                Json($$"""{"invocation_id":"{{Id(412)}}"}""")));
        await EventuallyAsync(() => dispatcher.Dispatched.Count == 1);

        cycle.Deliver(
            DataEnvelope(
                "invoke",
                Id(413),
                "rs-8080",
                2,
                Json($$"""{"invocation_id":"{{Id(414)}}"}""")));

        await EventuallyAsync(
            () => dispatcher.RejectedInvocationIds.Count == 1);

        // The claim is taken synchronously on the receive loop, in arrival
        // order, so it is deterministically the SECOND invoke that loses.
        Assert.True(
            dispatcher.RejectedInvocationIds.TryDequeue(out string? rejected));
        Assert.Equal(Id(414), rejected);
        Assert.Single(dispatcher.Dispatched);

        dispatcher.Hold!.SetResult();
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task DistinctSessionsExecuteConcurrently()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var dispatcher = new StubInvocationDispatcher
        {
            Hold = new TaskCompletionSource(),
        };
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(
                LocalSession(8080, 1000),
                LocalSession(8081, 1001)),
            clock,
            new RecordingInboundJournal(),
            invocationDispatcher: dispatcher);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 2);

        cycle.Deliver(
            DataEnvelope(
                "invoke", Id(421), "rs-8080", 1,
                Json($$"""{"invocation_id":"{{Id(422)}}"}""")));
        cycle.Deliver(
            DataEnvelope(
                "invoke", Id(423), "rs-8081", 1,
                Json($$"""{"invocation_id":"{{Id(424)}}"}""")));

        // Section 10.1 bounds concurrency per rsid, not per connection.
        await EventuallyAsync(() => dispatcher.ConcurrentPeak == 2);
        Assert.Equal(2, coordinator.GetSnapshot().ActiveInvocationCount);

        dispatcher.Hold!.SetResult();
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task ClosingWithAnInvocationInFlightStaysBoundedAndUnpoisoned()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var dispatcher = new StubInvocationDispatcher
        {
            // Never completes: stands in for an add-in call that cannot be
            // cancelled past the dispatch boundary.
            Hold = new TaskCompletionSource(),
        };
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            clock,
            new RecordingInboundJournal(),
            invocationDispatcher: dispatcher,
            invocationDrainTimeout: TimeSpan.FromMilliseconds(200));
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);
        cycle.Deliver(
            DataEnvelope(
                "invoke", Id(431), "rs-8080", 1,
                Json($$"""{"invocation_id":"{{Id(432)}}"}""")));
        await EventuallyAsync(() => dispatcher.Dispatched.Count == 1);

        var elapsed = Stopwatch.StartNew();
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));
        elapsed.Stop();

        // P3-T2 requires a clean stop well inside 10 s. An add-in call that
        // will not finish must not extend it, and — because invocation tasks
        // are deliberately not enrolled in AwaitOwnedTasksAsync — must not
        // poison connection authority either.
        Assert.True(
            elapsed.Elapsed < TimeSpan.FromSeconds(10),
            $"stop took {elapsed.Elapsed}");
        Assert.Equal(0, coordinator.GetSnapshot().OwnedBackgroundTaskCount);

        dispatcher.Hold!.SetResult();
    }

    [Fact]
    public async Task AMalformedInvokeIsThatInvocationsFaultNotTheConnections()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var handoff = new RecordingInboundJournal();

        // The real dispatcher, so the real parse path runs.
        var dispatcher = new RevAgent.Bridge.Gateway.Dispatch
            .RbpInvocationDispatcher(
                store,
                new UnreachableChannel(),
                new RevAgent.Bridge.Gateway.Dispatch.RbpInFlightGate());
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(LocalSession(8080, 1000)),
            clock,
            handoff,
            invocationDispatcher: dispatcher);
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);

        // Missing every required Section 10.2 field but `invocation_id`.
        cycle.Deliver(
            DataEnvelope(
                "invoke", Id(441), "rs-8080", 1,
                Json($$"""{"invocation_id":"{{Id(442)}}"}""")));

        RbpEnvelope error = await EventuallySentAsync(
            cycle,
            envelope => envelope.Type == "error");
        Assert.Equal(
            "protocol",
            error.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(
            "known",
            error.Payload.GetProperty("outcome").GetString());

        // The connection survived: it is still bound and still sequencing.
        Assert.Single(coordinator.GetSnapshot().ActiveRsids);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    private static async Task<RbpEnvelope> EventuallySentAsync(
        FakeConnectionCycle cycle,
        Func<RbpEnvelope, bool> predicate)
    {
        RbpEnvelope? found = null;
        await EventuallyAsync(() =>
        {
            found = cycle.Sent.FirstOrDefault(predicate);
            return found is not null;
        });
        return found!;
    }

    /// <summary>
    /// Fails if the add-in is ever reached. A malformed invoke must be refused
    /// before dispatch, so this channel exists to prove no byte was written.
    /// </summary>
    private sealed class UnreachableChannel
        : RevAgent.Bridge.Gateway.Dispatch.IRbpInvocationChannel
    {
        public Task<RevAgent.Bridge.Gateway.Dispatch.RbpAddinOutcome>
            InvokeAsync(
                string rsid,
                RevAgent.Bridge.AddinLoopback.AddinCall call,
                CancellationToken cancellationToken) =>
            throw new InvalidOperationException(
                "A malformed invoke must never reach the add-in.");
    }
}
