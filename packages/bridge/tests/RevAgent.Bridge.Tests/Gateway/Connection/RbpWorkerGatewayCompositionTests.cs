using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

/// <summary>
/// The worker host's production composition: the journal store, routed
/// invocation channel, dispatcher, and P3-T5 inbound handoff assembled into
/// one coordinator, plus the fail-closed fallback when the add-in dispatch
/// surface preconditions are missing.
/// </summary>
public sealed partial class RbpConnectionCoordinatorTests
{
    [Fact]
    public async Task WorkerCompositionDispatchesInboundDataInsteadOfThrowing()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        RbpConnectionCoordinator coordinator =
            WorkerGatewayComposition.CreateCoordinator(
                new WorkerGatewayServices(
                    new FakeConnectionCycleFactory(cycle),
                    store,
                    new MutableSessionCatalog(LocalSession(8080, 1000)),
                    CompositionOptions(),
                    new WorkerAddinDispatchSurface(
                        new AddinSessionRouter(
                            new NeverInvokedAddinTransport()),
                        new NoRouteResolver()),
                    clock,
                    new FixedRandomSource(0)));
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);

        cycle.Deliver(
            DataEnvelope(
                "invoke",
                Id(501),
                "rs-8080",
                1,
                Json(
                    $$"""
                    {
                      "invocation_id":"{{Id(502)}}",
                      "method":"get_current_view_info",
                      "params":{},
                      "timeout_ms":120000,
                      "mutating":false,
                      "mutation_scope":null,
                      "policy":{"class":"auto","decision":"auto","confirmation_id":null},
                      "verification":null,
                      "recovery_clearances":[]
                    }
                    """)));

        // The composed inbound path must answer, not throw: the invoke is
        // journaled by the real handoff, admitted by the real dispatcher, and
        // refused by the real routed channel as a known non-dispatch because
        // no add-in session is routable.
        RbpEnvelope error = await EventuallySentAsync(
            cycle,
            envelope => envelope.Type == "error");
        Assert.Equal(
            Id(502),
            error.Payload.GetProperty("invocation_id").GetString());
        Assert.Equal(
            "addin_unreachable",
            error.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(
            "known",
            error.Payload.GetProperty("outcome").GetString());
        Assert.True(error.Payload.GetProperty("retryable").GetBoolean());

        // The terminal decision is durable in the Section 12 journal.
        RbpStoredInvocation? stored = await store.GetInvocationAsync(
            "rs-8080/" + Id(502));
        Assert.Equal(RbpInvocationState.Failed, stored!.State);

        // The real handoff committed: the journaled receive frontier covers
        // the envelope, which the fail-closed default could never allow.
        RbpReceiveFrontier frontier =
            await store.GetReceiveFrontierAsync("rs-8080");
        Assert.Equal(1, frontier.LastAcceptedSequence);
        Assert.Equal(1, frontier.LastJournaledSequence);

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task WorkerCompositionWithoutDispatchSurfaceStaysFailClosed()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        RbpConnectionCoordinator coordinator =
            WorkerGatewayComposition.CreateCoordinator(
                new WorkerGatewayServices(
                    new FakeConnectionCycleFactory(cycle),
                    store,
                    new MutableSessionCatalog(LocalSession(8080, 1000)),
                    CompositionOptions(),
                    DispatchSurface: null,
                    clock,
                    new FixedRandomSource(0)));
        using var stop = new CancellationTokenSource();

        Task run = coordinator.RunAsync(stop.Token);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);

        cycle.Deliver(
            DataEnvelope(
                "invoke",
                Id(511),
                "rs-8080",
                1,
                Json(
                    $$"""
                    {
                      "invocation_id":"{{Id(512)}}",
                      "method":"get_current_view_info",
                      "params":{},
                      "timeout_ms":120000,
                      "mutating":false,
                      "mutation_scope":null,
                      "policy":{"class":"auto","decision":"auto","confirmation_id":null},
                      "verification":null,
                      "recovery_clearances":[]
                    }
                    """)));

        // FailClosedRbpInboundDataJournal refuses the handoff, which ends the
        // binding rather than half-handling the frame.
        await EventuallyAsync(() => cycle.CloseCount >= 1);

        // Accepted but never journaled: the frontier proves the fail-closed
        // default engaged, so no acknowledgement can ever cover the envelope
        // and the Gateway keeps retransmission authority.
        RbpReceiveFrontier frontier =
            await store.GetReceiveFrontierAsync("rs-8080");
        Assert.Equal(1, frontier.LastAcceptedSequence);
        Assert.Equal(0, frontier.LastJournaledSequence);

        // No data-plane answer was fabricated for the refused invoke.
        Assert.DoesNotContain(
            cycle.Sent,
            envelope => envelope.Type is "error" or "result");
        Assert.Null(await store.GetInvocationAsync("rs-8080/" + Id(512)));

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task WorkerCompositionOpensTheJournalAtTheCanonicalPath()
    {
        using var directory = new RbpJournalTestDirectory();
        var layout = new BridgeInstallLayout(directory.Path, directory.Path);

        await using (RbpJournalStore store = WorkerGatewayComposition
                         .OpenJournal(
                             layout,
                             new TestResumeTokenProtector(),
                             RbpJournalTestData.Options()))
        {
            _ = await store.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration());
        }

        Assert.True(File.Exists(layout.JournalPath));
    }

    [Fact]
    public void WorkerCompositionRequiresEveryConstructionPrecondition()
    {
        Assert.Throws<ArgumentNullException>(
            () => WorkerGatewayComposition.CreateCoordinator(null!));
        Assert.Throws<ArgumentNullException>(
            () => WorkerGatewayComposition.OpenJournal(
                new BridgeInstallLayout("install", "state"),
                null!));
    }

    private static RbpConnectionCoordinatorOptions CompositionOptions() =>
        new(
            new Uri("wss://gateway.revagent.app/bridge/v1"),
            new RbpHelloProfile(
                "0.1.0",
                "WS01",
                "Windows 11",
                new[] { "2026.07.26.0" }));

    /// <summary>
    /// The composed dispatch path must refuse an unroutable session before the
    /// add-in transport; this transport exists to prove no byte was sent.
    /// </summary>
    private sealed class NeverInvokedAddinTransport : IAddinTransport
    {
        public Task<AddinCallResult> InvokeAsync(
            AddinEndpoint endpoint,
            AddinCall call,
            CancellationToken preDispatchCancellationToken = default,
            CancellationToken transportShutdownToken = default,
            IAddinProcessAttestor? processAttestor = null) =>
            throw new InvalidOperationException(
                "The worker composition must never reach the add-in " +
                "transport without a routable session.");
    }

    private sealed class NoRouteResolver :
        RevAgent.Bridge.Gateway.Dispatch.IRbpSessionRouteResolver
    {
        public AddinSessionRouter.SessionHandle? Resolve(string rsid) => null;
    }
}
