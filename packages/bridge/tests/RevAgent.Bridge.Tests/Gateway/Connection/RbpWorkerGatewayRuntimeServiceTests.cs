using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Enrollment;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Host.Hosting;
using RevAgent.Bridge.Runtime;
using RevAgent.Bridge.Tests.Gateway.Storage;
using RevAgent.Contracts.AddinLoopback;
using RevAgent.Contracts.Rbp;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

/// <summary>
/// The worker host actually running the composed RBP data plane: the
/// coordinator connects, registers, dispatches, and starts the standing
/// document-context watcher inside the supervised worker process, and every
/// refusal path leaves the worker fail-closed instead of half-wired.
/// </summary>
public sealed partial class RbpConnectionCoordinatorTests
{
    [Fact]
    public async Task WorkerRuntimeServiceConnectsRegistersAndWatchesInProcess()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var routes = new RecordingRouteAuthority();
        RbpConnectionCoordinator coordinator =
            WorkerGatewayComposition.CreateCoordinator(
                new WorkerGatewayServices(
                    new FakeConnectionCycleFactory(cycle),
                    store,
                    new MutableSessionCatalog(
                        WatchedLocalSession(8080, 1000)),
                    CompositionOptions() with
                    {
                        SessionRouteBindingAuthority = routes,
                    },
                    new WorkerAddinDispatchSurface(
                        new AddinSessionRouter(
                            new NeverInvokedAddinTransport()),
                        routes),
                    clock,
                    new FixedRandomSource(0)));
        var runtime = new WorkerGatewayRuntime(coordinator);
        var lifetime = new RuntimeLifetime();
        var exitState = new WorkerExitState();
        var service = new WorkerGatewayRuntimeService(
            () => runtime,
            lifetime,
            new RuntimeLog(),
            exitState);

        await service.StartAsync(CancellationToken.None);
        try
        {
            // The coordinator owns a live connection and a registered session,
            // which is exactly what the worker process never did before.
            await EventuallyAsync(
                () => coordinator.GetSnapshot().ActiveRsids.Count == 1);
            Assert.Contains(
                cycle.Sent,
                envelope => envelope.Type == "session_register");

            // The standing document-context watcher polls immediately on
            // register, and every poll travels the same routed channel the
            // dispatch path uses, so a recorded route lookup for the session's
            // rsid proves the watcher is constructed and running.
            await EventuallyAsync(
                () => routes.Resolved.Contains("rs-8080"));
            Assert.Contains("rs-8080", routes.Bound);
            Assert.Equal(0, routes.ResolveBeforeBindingCount);

            // The invocation dispatcher is composed too: an inbound invoke is
            // journaled, admitted, and answered rather than refused by the
            // fail-closed inbound stub.
            cycle.Deliver(
                DataEnvelope(
                    "invoke",
                    Id(701),
                    "rs-8080",
                    1,
                    Json(
                        $$"""
                        {
                          "invocation_id":"{{Id(702)}}",
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
            RbpEnvelope error = await EventuallySentAsync(
                cycle,
                envelope => envelope.Type == "error");
            Assert.Equal(
                "addin_unreachable",
                error.Payload.GetProperty("fault_class").GetString());
            RbpReceiveFrontier frontier =
                await store.GetReceiveFrontierAsync("rs-8080");
            Assert.Equal(1, frontier.LastJournaledSequence);

            Assert.Equal(0, exitState.ExitCode);
            Assert.False(lifetime.StopRequested);
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task UnenrolledWorkerRuntimeStaysFailClosedWithoutCrashing()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);

        // The production cycle factory over the always-refuse enrollment
        // provider: the unchanged handshake never opens a socket.
        var coordinator = new RbpConnectionCoordinator(
            WorkerGatewayComposition.CreateConnectionCycleFactory(
                new EnrollmentRequiredStateProvider()),
            store,
            new MutableSessionCatalog(),
            CompositionOptions(),
            new StubInvocationDispatcher(),
            inboundJournal: null,
            clock,
            new FixedRandomSource(0));
        await using var runtime = new WorkerGatewayRuntime(coordinator);
        var lifetime = new RuntimeLifetime();
        var exitState = new WorkerExitState();
        var service = new WorkerGatewayRuntimeService(
            () => runtime,
            lifetime,
            new RuntimeLog(),
            exitState);

        await service.StartAsync(CancellationToken.None);
        try
        {
            await EventuallyAsync(
                () => coordinator.GetSnapshot().Lifecycle.Phase ==
                    RbpConnectionPhase.RetryPaused);
            RbpConnectionLifecycleState lifecycle =
                coordinator.GetSnapshot().Lifecycle;

            // Frozen refusal: paused on the Auth reason, waiting on a retry
            // condition change rather than reconnecting.
            Assert.Equal(RbpRetryPauseReason.Auth, lifecycle.RetryPauseReason);
            Assert.Equal(
                RbpRetryAction.Pause,
                lifecycle.LastRetryDecision!.Action);
            Assert.False(coordinator.GetSnapshot().HasActiveConnection);

            // No retry storm and no crash: the worker stays alive and its exit
            // state stays successful while it waits for enrollment.
            await Task.Delay(60);
            Assert.Equal(
                RbpConnectionPhase.RetryPaused,
                coordinator.GetSnapshot().Lifecycle.Phase);
            Assert.Equal(0, exitState.ExitCode);
            Assert.False(lifetime.StopRequested);
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }

        Assert.Equal(0, exitState.ExitCode);
        Assert.False(lifetime.StopRequested);
    }

    [Fact]
    public async Task PoisonedConnectionAuthorityExitsTheWorkerNonSuccessfully()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        var faults = new BlockingJournalFaultInjector();
        await using RbpJournalStore store =
            OpenStore(directory, clock, faults);
        var responder = new ScriptedGatewayResponder(clock);
        var first = new FakeConnectionCycle(responder.Respond);
        var second = new FakeConnectionCycle(responder.Respond);
        var factory = new FakeConnectionCycleFactory(first, second);
        var coordinator = Coordinator(
            factory,
            store,
            new MutableSessionCatalog(),
            clock,
            closeTimeout: TimeSpan.FromMilliseconds(20));
        await using var runtime = new WorkerGatewayRuntime(coordinator);
        var lifetime = new RuntimeLifetime();
        var exitState = new WorkerExitState();
        var service = new WorkerGatewayRuntimeService(
            () => runtime,
            lifetime,
            new RuntimeLog(),
            exitState);

        await service.StartAsync(CancellationToken.None);
        try
        {
            await EventuallyAsync(
                () => coordinator.GetSnapshot().HasActiveConnection);

            // A heartbeat acknowledgement handler that ignores cancellation
            // past the bounded close deadline is the deterministic
            // blocked-handler condition the P3-T4 host-wiring prerequisite
            // card names.
            faults.Arm(RbpJournalFaultPoint.BeforeCommit);
            clock.Advance(TimeSpan.FromSeconds(15));
            await faults.Entered.WaitAsync(TimeSpan.FromSeconds(2));
            clock.Advance(TimeSpan.FromSeconds(65));

            await EventuallyAsync(() => lifetime.StopRequested);

            // The worker must exit non-successfully and no replacement
            // generation may open in this process.
            Assert.Equal(1, exitState.ExitCode);
            Assert.Equal(1, factory.OpenCount);
            Assert.Empty(second.Sent);
            Assert.Equal(1, coordinator.GetSnapshot().ConnectionGeneration);

            // The poison is sticky: the coordinator refuses to run again in
            // this process rather than reconnecting beside a stale handler.
            RbpCoordinatorException restart =
                await Assert.ThrowsAsync<RbpCoordinatorException>(
                    () => coordinator.RunAsync());
            Assert.Equal(
                RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
                restart.ErrorCode);
            Assert.Equal(1, factory.OpenCount);
        }
        finally
        {
            faults.Release();
            await service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task DisposeWaitingOnRunRechecksMustExitBeforeRuntimeDispose()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(
            responder.Respond,
            hangCloseAndDispose: true);
        var coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(),
            clock,
            closeTimeout: TimeSpan.FromMilliseconds(40));
        var runtime = new WorkerGatewayRuntime(coordinator);
        var lifetime = new RuntimeLifetime();
        var exitState = new WorkerExitState();
        var service = new WorkerGatewayRuntimeService(
            () => runtime,
            lifetime,
            new RuntimeLog(),
            exitState);

        await service.StartAsync(CancellationToken.None);
        Task? dispose = null;
        try
        {
            await EventuallyAsync(
                () => coordinator.GetSnapshot().HasActiveConnection);

            dispose = service.DisposeAsync().AsTask();
            await dispose.WaitAsync(TimeSpan.FromSeconds(2));

            Assert.Equal(1, exitState.ExitCode);
            Assert.True(lifetime.StopRequested);
            Assert.Equal(0, RuntimeDisposed(runtime));
            Assert.Equal(1, cycle.CloseCount);
            Assert.Equal(0, cycle.DisposeCount);
        }
        finally
        {
            if (dispose is not null)
            {
                try { await dispose.WaitAsync(TimeSpan.FromSeconds(2)); }
                catch { }
            }
        }
    }

    [Fact]
    public async Task WorkerRuntimeStopCompletesWithinTheSupervisorBudget()
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
                        new RecordingRouteResolver()),
                    clock,
                    new FixedRandomSource(0)));
        await using var runtime = new WorkerGatewayRuntime(coordinator);
        var lifetime = new RuntimeLifetime();
        var exitState = new WorkerExitState();
        var service = new WorkerGatewayRuntimeService(
            () => runtime,
            lifetime,
            new RuntimeLog(),
            exitState);

        await service.StartAsync(CancellationToken.None);
        await EventuallyAsync(
            () => coordinator.GetSnapshot().ActiveRsids.Count == 1);

        var stopwatch = Stopwatch.StartNew();
        await service.StopAsync(CancellationToken.None);
        stopwatch.Stop();

        Assert.True(
            stopwatch.Elapsed < WorkerSupervisor.GracefulStopTimeout,
            $"Worker gateway stop took {stopwatch.Elapsed}.");
        Assert.Equal(
            RbpConnectionPhase.Shutdown,
            coordinator.GetSnapshot().Lifecycle.Phase);
        Assert.False(coordinator.GetSnapshot().HasActiveConnection);
        Assert.Equal(0, exitState.ExitCode);
    }

    [Fact]
    public async Task WorkerRuntimeBindsActiveSessionsThroughTheJournal()
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
                        new RecordingRouteResolver()),
                    clock,
                    new FixedRandomSource(0)));
        await using var runtime = new WorkerGatewayRuntime(coordinator);
        var service = new WorkerGatewayRuntimeService(
            () => runtime,
            new RuntimeLifetime(),
            new RuntimeLog(),
            new WorkerExitState());

        await service.StartAsync(CancellationToken.None);
        try
        {
            await EventuallyAsync(() => coordinator.GetSnapshot().ActiveRsids.Contains("rs-8080"));
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }

        // There is no resolver-miss/background binding pump: route authority
        // is published only by the acknowledged lifecycle path.
    }

    [Fact]
    public async Task WorkerCompositionBindsResumeRouteBeforeWatching()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot local = WatchedLocalSession(8080, 1000);
        _ = await store.PersistRegisteredSessionAsync(
            Registration(local, "rs-8080"));
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var routes = new RecordingRouteAuthority();
        RbpConnectionCoordinator coordinator =
            WorkerGatewayComposition.CreateCoordinator(
                new WorkerGatewayServices(
                    new FakeConnectionCycleFactory(cycle),
                    store,
                    new MutableSessionCatalog(local),
                    CompositionOptions() with
                    {
                        SessionRouteBindingAuthority = routes,
                    },
                    new WorkerAddinDispatchSurface(
                        new AddinSessionRouter(
                            new NeverInvokedAddinTransport()),
                        routes),
                    clock,
                    new FixedRandomSource(0)));
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);
        try
        {
            await EventuallyAsync(() => routes.Resolved.Contains("rs-8080"));
            _ = Assert.Single(routes.Bound, rsid => rsid == "rs-8080");
            Assert.True(routes.IsBound("rs-8080"));
            Assert.Equal(1, routes.BindAttempts);
            Assert.Equal(1, routes.SuccessfulPublications);
            Assert.Equal(1, routes.ActiveRouteCount);
            Assert.Equal(0, routes.RevokeCount);
            Assert.Equal(0, routes.ResolveBeforeBindingCount);
            Assert.Contains(cycle.Sent, envelope => envelope.Type == "session_resume");
        }
        finally
        {
            stop.Cancel();
            await run.WaitAsync(TimeSpan.FromSeconds(5));
        }
        Assert.False(routes.IsBound("rs-8080"));
        Assert.Equal(0, routes.ActiveRouteCount);
        Assert.True(routes.FenceCount >= 1);
    }

    [Fact]
    public async Task WorkerCompositionDoesNotWatchSessionWithoutDocumentCapability()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var routes = new RecordingRouteAuthority();
        RbpConnectionCoordinator coordinator =
            WorkerGatewayComposition.CreateCoordinator(
                new WorkerGatewayServices(
                    new FakeConnectionCycleFactory(cycle),
                    store,
                    new MutableSessionCatalog(LocalSession(8080, 1000)),
                    CompositionOptions() with
                    {
                        SessionRouteBindingAuthority = routes,
                    },
                    new WorkerAddinDispatchSurface(
                        new AddinSessionRouter(
                            new NeverInvokedAddinTransport()),
                        routes),
                    clock,
                    new FixedRandomSource(0)));
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);
        try
        {
            await EventuallyAsync(
                () => coordinator.GetSnapshot().ActiveRsids.Contains("rs-8080"));
            await Task.Delay(75);
            Assert.Contains("rs-8080", routes.Bound);
            Assert.Empty(routes.Resolved);
        }
        finally
        {
            stop.Cancel();
            await run.WaitAsync(TimeSpan.FromSeconds(5));
        }
    }

    [Fact]
    public async Task ResumeMismatchedAckPublishesNoRoute()
    {
        using var fixture = await ResumeRouteFixture.CreateAsync(
            respondToResume: false);
        RbpEnvelope resume = await EventuallySentAsync(fixture.Cycle,
            envelope => envelope.Type == "session_resume");
        fixture.Cycle.Deliver(ResumeAck(fixture.Clock, "rs-other"));
        await EventuallyAsync(() => fixture.Cycle.CloseCount > 0);
        await EventuallyAsync(() => !fixture.Routes.IsBound("rs-8080"));
        Assert.Empty(fixture.Routes.Bound);
        Assert.Equal(0, fixture.Routes.BindAttempts);
        Assert.Equal(0, fixture.Routes.SuccessfulPublications);
        Assert.Equal(0, fixture.Routes.ActiveRouteCount);
        Assert.Null(fixture.Routes.Resolve("rs-8080"));
        await fixture.StopAfterAssertedFailureAsync();
    }

    [Fact]
    public async Task AlteredDuplicateResumeAckDoesNotBindTwiceAndFencesRoute()
    {
        using var fixture = await ResumeRouteFixture.CreateAsync(
            respondToResume: true);
        await EventuallyAsync(() => fixture.Routes.IsBound("rs-8080"));
        _ = Assert.Single(fixture.Routes.Bound, rsid => rsid == "rs-8080");
        Assert.Equal(1, fixture.Routes.BindAttempts);
        Assert.Equal(1, fixture.Routes.SuccessfulPublications);
        Assert.Equal(1, fixture.Routes.ActiveRouteCount);
        fixture.Cycle.Deliver(ResumeAck(fixture.Clock, "rs-altered"));
        await EventuallyAsync(() => !fixture.Routes.IsBound("rs-8080"));
        _ = Assert.Single(fixture.Routes.Bound, rsid => rsid == "rs-8080");
        Assert.Equal(1, fixture.Routes.BindAttempts);
        Assert.Equal(1, fixture.Routes.SuccessfulPublications);
        Assert.Equal(0, fixture.Routes.ActiveRouteCount);
        Assert.True(fixture.Routes.FenceCount >= 1);
        Assert.Null(fixture.Routes.Resolve("rs-8080"));
        await fixture.StopAfterAssertedFailureAsync();
    }

    [Fact]
    public async Task LostResumeAckLeavesRouteAbsent()
    {
        using var fixture = await ResumeRouteFixture.CreateAsync(
            respondToResume: false);
        _ = await EventuallySentAsync(fixture.Cycle,
            envelope => envelope.Type == "session_resume");
        await EventuallyAsync(() => fixture.Clock.HasDelayDueIn(
            TimeSpan.FromSeconds(10)));
        Assert.Empty(fixture.Routes.Bound);
        Assert.Null(fixture.Routes.Resolve("rs-8080"));
        fixture.Clock.Advance(TimeSpan.FromSeconds(10));
        await EventuallyAsync(() => fixture.Timeouts.Any(
            item => item.LifecycleControl == "session_resume"));
        await EventuallyAsync(() => fixture.Cycle.CloseCount > 0);
        Assert.Empty(fixture.Routes.Bound);
        Assert.Equal(0, fixture.Routes.BindAttempts);
        Assert.Equal(0, fixture.Routes.SuccessfulPublications);
        Assert.Null(fixture.Routes.Resolve("rs-8080"));
        await fixture.StopAfterAssertedFailureAsync();
        Assert.Null(fixture.Routes.Resolve("rs-8080"));
    }

    [Fact]
    public async Task LostResumeAckTimeoutFencesRouteBeforeTeardown()
    {
        using var fixture = await ResumeRouteFixture.CreateAsync(false);
        int fenceBaseline = fixture.Routes.FenceCount;
        Assert.Equal(0, fixture.TeardownOrder.FirstFenceOrdinal);
        Assert.Equal(0, fixture.TeardownOrder.FirstCloseStartedOrdinal);
        Assert.Null(fixture.Routes.Resolve("rs-8080"));
        Assert.Equal(0, fixture.Routes.ActiveRouteCount);
        _ = await EventuallySentAsync(fixture.Cycle,
            envelope => envelope.Type == "session_resume");
        await EventuallyAsync(() => fixture.Clock.HasDelayDueIn(TimeSpan.FromSeconds(10)));
        fixture.Clock.Advance(TimeSpan.FromSeconds(10));
        await EventuallyAsync(() => fixture.Timeouts.Any(
            item => item.LifecycleControl == "session_resume"));
        await EventuallyAsync(() => fixture.TeardownOrder.FirstFenceOrdinal > 0);
        await EventuallyAsync(() => fixture.TeardownOrder.FirstCloseStartedOrdinal > 0);
        long fenceOrdinal = fixture.TeardownOrder.FirstFenceOrdinal;
        long closeStartedOrdinal = fixture.TeardownOrder.FirstCloseStartedOrdinal;
        Assert.True(
            fenceOrdinal < closeStartedOrdinal,
            $"Route authority fence ordinal {fenceOrdinal} must precede " +
            $"transport close-start ordinal {closeStartedOrdinal}.");
        await EventuallyAsync(() => fixture.Routes.FenceCount > fenceBaseline);
        await EventuallyAsync(() => fixture.Routes.ActiveRouteCount == 0);
        await EventuallyAsync(() => fixture.Routes.Resolve("rs-8080") is null);
        await EventuallyAsync(() => fixture.Cycle.CloseCount > 0);
        Assert.Empty(fixture.Routes.Bound);
        Assert.Null(fixture.Routes.Resolve("rs-8080"));
        await fixture.StopAfterAssertedFailureAsync();
        Assert.True(fixture.Routes.FenceCount > fenceBaseline);
        Assert.Equal(fenceOrdinal, fixture.TeardownOrder.FirstFenceOrdinal);
        Assert.Equal(
            closeStartedOrdinal,
            fixture.TeardownOrder.FirstCloseStartedOrdinal);
        Assert.Equal(0, fixture.Routes.ActiveRouteCount);
        Assert.Null(fixture.Routes.Resolve("rs-8080"));
    }

    [Fact]
    public async Task ResolverMissCannotAsynchronouslyPublishPreResumeRoute()
    {
        int durableLookups = 0;
        var transport = new ScriptedStatusTransport();
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()), router,
            ScanConfiguration(), () => new FixedCredentialProvider(),
            (_, _) =>
            {
                Interlocked.Increment(ref durableLookups);
                return Task.FromResult<string?>("unexpected");
            },
            "0.1.0-test", "WS01");
        Assert.Null(catalog.Resolve("rs-miss"));
        await Task.Delay(TimeSpan.FromMilliseconds(300));
        Assert.Equal(0, Volatile.Read(ref durableLookups));
        Assert.Null(catalog.Resolve("rs-miss"));
        Assert.DoesNotContain("get_document_context", transport.Methods);
    }

    [Fact]
    public async Task ResumeTransportResetBeforeAckLeavesRouteAbsent()
    {
        using var fixture = await ResumeRouteFixture.CreateAsync(
            respondToResume: false);
        _ = await EventuallySentAsync(fixture.Cycle,
            envelope => envelope.Type == "session_resume");
        fixture.Cycle.Fail(new IOException("test reset before resume_ack"));
        await EventuallyAsync(() => fixture.Cycle.CloseCount > 0);
        await EventuallyAsync(() => !fixture.Routes.IsBound("rs-8080"));
        Assert.Empty(fixture.Routes.Bound);
        Assert.Null(fixture.Routes.Resolve("rs-8080"));
        await fixture.StopAfterAssertedFailureAsync();
    }

    [Fact]
    public async Task GenerationDriftImmediatelyBeforeBindPublishesNoRoute()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot local = WatchedLocalSession(8080, 1000);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        var routes = new RecordingRouteAuthority
        {
            FenceImmediatelyBeforeBind = true,
        };
        RbpConnectionCoordinator coordinator = WorkerGatewayComposition.CreateCoordinator(
            new WorkerGatewayServices(
                new FakeConnectionCycleFactory(cycle), store,
                new MutableSessionCatalog(local),
                CompositionOptions() with { SessionRouteBindingAuthority = routes },
                new WorkerAddinDispatchSurface(
                    new AddinSessionRouter(new NeverInvokedAddinTransport()), routes),
                clock, new FixedRandomSource(0)));
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);
        _ = await EventuallySentAsync(cycle, envelope =>
            envelope.Type == "session_register");
        await EventuallyAsync(() => routes.BindAttempts == 1);
        await EventuallyAsync(() => routes.FenceCount >= 1);
        await EventuallyAsync(() => cycle.CloseCount > 0);
        Assert.Equal(1, routes.BindAttempts);
        Assert.Equal(0, routes.SuccessfulPublications);
        Assert.Empty(routes.Bound);
        Assert.Null(routes.Resolve("rs-8080"));
        await StopAfterAssertedConnectionFailureAsync(
            coordinator, stop, run, () => cycle.CloseCount > 0);
    }

    [Fact]
    public async Task PriorCycleRouteIsFencedUntilTheNextExactResumeAck()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var first = new FakeConnectionCycle(responder.Respond);
        var second = new FakeConnectionCycle(envelope =>
            envelope.Type == "session_resume" ? null : responder.Respond(envelope));
        var factory = new FakeConnectionCycleFactory(first, second);
        var transport = new ScriptedStatusTransport(result =>
        {
            result["sessionCapabilities"] = new JArray("batch_atomic");
            ((JObject)result["capabilityContracts"]!).Remove(
                "doc_context_cached_v1");
        });
        var router = new AddinSessionRouter(transport);
        string? localSessionKey = null;
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()), router,
            ScanConfiguration(), () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(
                rsid == "rs-8080" ? localSessionKey : null),
            "0.1.0-test", "WS01");
        RbpLocalSessionSnapshot local = Assert.Single(await catalog.ReadAsync());
        localSessionKey = local.LocalSessionKey;
        _ = await store.PersistRegisteredSessionAsync(Registration(local, "rs-8080"));
        var channel = new RbpRoutedInvocationChannel(router, catalog);
        RbpConnectionCoordinator coordinator = WorkerGatewayComposition.CreateCoordinator(
            new WorkerGatewayServices(
                factory, store, catalog,
                CompositionOptions() with { SessionRouteBindingAuthority = catalog },
                new WorkerAddinDispatchSurface(router, catalog, catalog),
                clock, new FixedRandomSource(0)));
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);
        try
        {
            await EventuallyAsync(() => catalog.Resolve("rs-8080") is not null);
            Assert.NotNull(catalog.Resolve("rs-8080"));
            RbpAddinOutcome firstOutcome = await channel.InvokeAsync(
                "rs-8080",
                new AddinCall(
                    "cycle-one-current-view",
                    "get_current_view_info",
                    new JObject(),
                    TimeSpan.FromSeconds(1)),
                CancellationToken.None);
            try
            {
                Assert.Equal(RbpAddinOutcomeKind.Completed, firstOutcome.Kind);
                Assert.False(firstOutcome.RouteFailure);
                Assert.True(firstOutcome.RequestBytes > 0);
                Assert.True(firstOutcome.ResponseBytes > 0);
            }
            finally
            {
                firstOutcome.Lease?.ReleaseAfterDurableDecision();
            }
            Assert.Equal(
                1,
                transport.Methods.Count(method => method == "get_current_view_info"));

            first.Fail(new IOException("force cycle-one teardown"));
            await EventuallyAsync(() => first.CloseCount > 0);
            await EventuallyAsync(() => factory.OpenCount >= 2);
            _ = await EventuallySentAsync(second,
                envelope => envelope.Type == "session_resume");

            Assert.Null(catalog.Resolve("rs-8080"));
            RbpAddinOutcome withheldOutcome = await channel.InvokeAsync(
                "rs-8080",
                new AddinCall(
                    "cycle-two-withheld-current-view",
                    "get_current_view_info",
                    new JObject(),
                    TimeSpan.FromSeconds(1)),
                CancellationToken.None);
            Assert.Equal(RbpAddinOutcomeKind.KnownNotDispatched, withheldOutcome.Kind);
            Assert.True(withheldOutcome.RouteFailure);
            Assert.Equal(0, withheldOutcome.RequestBytes);
            Assert.Equal(
                1,
                transport.Methods.Count(method => method == "get_current_view_info"));

            second.Deliver(ResumeAck(clock, "rs-8080"));
            await EventuallyAsync(() => catalog.Resolve("rs-8080") is not null);
            Assert.NotNull(catalog.Resolve("rs-8080"));
            RbpAddinOutcome secondOutcome = await channel.InvokeAsync(
                "rs-8080",
                new AddinCall(
                    "cycle-two-current-view",
                    "get_current_view_info",
                    new JObject(),
                    TimeSpan.FromSeconds(1)),
                CancellationToken.None);
            try
            {
                Assert.Equal(RbpAddinOutcomeKind.Completed, secondOutcome.Kind);
                Assert.False(secondOutcome.RouteFailure);
                Assert.True(secondOutcome.RequestBytes > 0);
                Assert.True(secondOutcome.ResponseBytes > 0);
            }
            finally
            {
                secondOutcome.Lease?.ReleaseAfterDurableDecision();
            }
            Assert.Equal(
                2,
                transport.Methods.Count(method => method == "get_current_view_info"));
        }
        finally
        {
            Task<RbpCoordinatorTeardownResult> teardown =
                coordinator.RequestStopTeardown();
            stop.Cancel();
            _ = await teardown.WaitAsync(TimeSpan.FromSeconds(5));
            await run.WaitAsync(TimeSpan.FromSeconds(5));
        }
        Assert.Null(catalog.Resolve("rs-8080"));
    }

    [Fact]
    public async Task FreshProofConstructionFailureClosesBeforeResumeAndRoutePublication()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        RbpLocalSessionSnapshot local = WatchedLocalSession(8080, 1000);
        _ = await store.PersistRegisteredSessionAsync(Registration(local, "rs-8080"));
        string[] capability = [RbpHelloProfile.RouteRebindProofCapability];
        var fresh = new ScriptedFreshResumeProofReader();
        var watcher = new RbpDocContextWatcher(
            new ScriptedDocContextChannel(), clock,
            freshResumeProofReader: fresh);
        var routes = new RecordingRouteAuthority();
        var cycle = new FakeConnectionCycle(
            new ScriptedGatewayResponder(clock).Respond,
            grantedConnectionCapabilities: capability,
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0401");
        RbpConnectionCoordinator coordinator = new(
            new FakeConnectionCycleFactory(cycle), store,
            new MutableSessionCatalog(local),
            new RbpConnectionCoordinatorOptions(
                new Uri("wss://gateway.revagent.app/bridge/v1"),
                new RbpHelloProfile("0.1.0", "WS01", "Windows 11",
                    new[] { "2026.07.26.0" }, capability),
                SessionRouteBindingAuthority: routes),
            new StubInvocationDispatcher(), new RecordingInboundJournal(),
            clock, new ThrowingRandomSource(throwOnFill: 2), watcher);
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);
        try
        {
            await EventuallyAsync(() => fresh.CallCount == 1);
            await EventuallyAsync(() => cycle.CloseCount > 0);
            Assert.DoesNotContain(cycle.Sent, item => item.Type == "session_resume");
            Assert.Equal(0, routes.BindAttempts);
            Assert.Equal(0, routes.SuccessfulPublications);
            Assert.Equal(0, routes.ActiveRouteCount);
            Assert.Null(routes.Resolve("rs-8080"));
        }
        finally
        {
            await StopAfterAssertedConnectionFailureAsync(
                coordinator, stop, run, () => cycle.CloseCount > 0);
        }
    }

    [Fact]
    public async Task WrongResumeLifecycleResponseClosesWithoutApplyingOrBindingRoute()
    {
        using var fixture = await ResumeRouteFixture.CreateAsync(
            respondToResume: false);
        _ = await EventuallySentAsync(fixture.Cycle,
            envelope => envelope.Type == "session_resume");
        fixture.Cycle.Deliver(ResumeAck(fixture.Clock, "rs-8080") with
        {
            Type = "session_registered",
        });
        await EventuallyAsync(() => fixture.Cycle.CloseCount > 0);
        Assert.Equal(0, fixture.Routes.BindAttempts);
        Assert.Equal(0, fixture.Routes.SuccessfulPublications);
        Assert.Equal(0, fixture.Routes.ActiveRouteCount);
        Assert.Null(fixture.Routes.Resolve("rs-8080"));
        await fixture.StopAfterAssertedFailureAsync();
        Assert.Null(fixture.Routes.Resolve("rs-8080"));
    }

    [Fact]
    public async Task WorkerRuntimePurgeUsesSevenDayJournalReleaseForSpoolCleanup()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        RbpJournalStore store = OpenStore(directory, clock);
        RbpArtifactCarrierProducer producer =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        RbpCarrierEmission emission = Assert.IsType<RbpCarrierEmission>(
            await producer.TryPrepareAsync(
                "rs-sweep",
                Json("""{"invocation_id":"sweep-carrier"}"""),
                JsonSerializer.SerializeToElement(new
                {
                    payload = new string(
                        'x', RbpArtifactCarrierProducer.MaximumChunkBytes + 1),
                }),
                CancellationToken.None));
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                rsid: "rs-sweep",
                expiresInHours: 24 * 365));
        const string invocationId = "0197a3c2-0000-7000-8000-000000000412";
        var identity = new RbpInvocationIdentity(
            "rs-sweep", invocationId, "get_current_view_info", false, null,
            "sha256:" + new string('a', 64), "{}", "[]");
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        JsonElement prefixes = JsonSerializer.SerializeToElement(
            emission.Prefixes.Select(value => new
            {
                type = value.Type,
                payload = value.Payload,
            }));
        string prefixDigest = RbpArtifactCarrierProducer.Digest(
            System.Text.Encoding.UTF8.GetBytes(prefixes.GetRawText()));
        string terminalDigest = RbpArtifactCarrierProducer.Digest(
            System.Text.Encoding.UTF8.GetBytes(
                emission.TerminalPayload.GetRawText()));
        _ = await store.PersistInvocationTerminalAsync(
            identity.IdempotencyKey,
            new RbpInvocationTerminal(
                RbpInvocationState.Completed,
                emission.TerminalPayload,
                terminalDigest,
                new RbpCarrierPlan(
                    "sha256:" + new string('c', 64),
                    emission.CarrierKey,
                    emission.Prefixes.Select(value =>
                        new RbpCarrierPlanFrame(value.Type, value.Payload))
                        .ToArray(),
                    emission.TerminalPayload,
                    prefixDigest,
                    terminalDigest)));
        RbpQueueOutboundResult terminal = await store.QueueOutboundDataAsync(
            "rs-sweep",
            new RbpOutboundDataDraft(
                "result", "sweep-terminal", emission.TerminalPayload));
        long terminalSequence = Assert.IsType<RbpDataEnvelopeSnapshot>(
            terminal.Envelope).Sequence;
        await store.RecordCarrierTerminalQueuedAsync(
            emission.CarrierKey, "rs-sweep", terminalSequence);
        producer.RecordTerminalQueued(emission.CarrierKey, "rs-sweep", 1);
        string carrierRoot = Path.Combine(
            directory.Path, "artifact-spool", emission.CarrierKey);
        Assert.Equal(1, terminalSequence);
        IReadOnlyList<RbpReleasedCarrier> released =
            await store.ApplyCarrierPlanAcknowledgementsAsync(
            new[] { new RbpSessionAcknowledgement("rs-sweep", terminalSequence) });
        producer.SweepExpired(released);
        await store.ConfirmSpoolReleasedAsync(Assert.Single(released));
        clock.Advance(TimeSpan.FromDays(8));

        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        RbpConnectionCoordinator coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(),
            clock);
        await using var runtime = new WorkerGatewayRuntime(
            coordinator,
            ownedJournal: store,
            carrierProducer: producer,
            carrierSweepInterval: TimeSpan.FromMilliseconds(10));
        var service = new WorkerGatewayRuntimeService(
            () => runtime,
            new RuntimeLifetime(),
            new RuntimeLog(),
            new WorkerExitState());

        await service.StartAsync(CancellationToken.None);
        try
        {
            await EventuallyAsync(() => !Directory.Exists(carrierRoot));
            Assert.Null(await store.GetInvocationAsync(identity.IdempotencyKey));
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task WorkerCarrierPumpReachesBoundedJournalRetention()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        RbpJournalStore store = OpenStore(directory, clock);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(expiresInHours: 24 * 365));
        const string invocationId = "0197a3c2-0000-7000-8000-000000000411";
        var identity = new RbpInvocationIdentity(
            "rs-test",
            invocationId,
            "get_current_view_info",
            false,
            null,
            "sha256:" + new string('a', 64),
            "{}",
            "[]");
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        _ = await store.PersistInvocationTerminalAsync(
            identity.IdempotencyKey,
            new RbpInvocationTerminal(
                RbpInvocationState.Completed,
                Json("""{"ok":true}"""),
                "sha256:" + new string('b', 64)));
        clock.Advance(TimeSpan.FromDays(8));

        RbpArtifactCarrierProducer producer =
            RbpArtifactCarrierProducer.CreateProduction(directory.Path, store);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);
        RbpConnectionCoordinator coordinator = Coordinator(
            new FakeConnectionCycleFactory(cycle),
            store,
            new MutableSessionCatalog(),
            clock);
        await using var runtime = new WorkerGatewayRuntime(
            coordinator,
            ownedJournal: store,
            carrierProducer: producer,
            carrierSweepInterval: TimeSpan.FromMilliseconds(10));
        var service = new WorkerGatewayRuntimeService(
            () => runtime,
            new RuntimeLifetime(),
            new RuntimeLog(),
            new WorkerExitState());

        await service.StartAsync(CancellationToken.None);
        try
        {
            await EventuallyAsync(async () =>
                await store.GetInvocationAsync(identity.IdempotencyKey) is null);
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task WorkerCatalogProjectsDiscoveryIntoFrozenRegistrations()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(responder.Respond);

        var transport = new ScriptedStatusTransport();
        var router = new AddinSessionRouter(transport);
        var credentialClaims = new RbpCredentialClaimBinding(
            new RuntimeEnrollmentProvider(
                "token-0123456789ABCDEFGHIJKLMNOP",
                TestMachineFingerprint));
        Assert.Equal(
            RbpEnrollmentStatus.Ready,
            (await credentialClaims.ReadAsync()).Status);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()),
            router,
            ScanConfiguration(),
            () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(null),
            "0.1.0-test",
            "WS01",
            credentialClaims: credentialClaims);
        RbpConnectionCoordinator coordinator =
            WorkerGatewayComposition.CreateCoordinator(
                new WorkerGatewayServices(
                    new FakeConnectionCycleFactory(cycle),
                    store,
                    catalog,
                    CompositionOptions(),
                    new WorkerAddinDispatchSurface(router, catalog),
                    clock,
                    new FixedRandomSource(0)));
        await using var runtime = new WorkerGatewayRuntime(coordinator);
        var service = new WorkerGatewayRuntimeService(
            () => runtime,
            new RuntimeLifetime(),
            new RuntimeLog(),
            new WorkerExitState());

        await service.StartAsync(CancellationToken.None);
        try
        {
            // Reaching an active rsid proves the projected payload survived
            // the coordinator's own frozen catalog validation, its canonical
            // registration digest, and the Gateway register round trip.
            await EventuallyAsync(
                () => coordinator.GetSnapshot().ActiveRsids.Count == 1);
            RbpEnvelope register = Assert.Single(
                cycle.Sent,
                envelope => envelope.Type == "session_register");
            JsonElement payload = register.Payload;

            Assert.Equal(
                $"port:8080:pid:4242:started:{ScriptedStartTimeFileTimeUtc}",
                payload.GetProperty("local_session_key").GetString());
            Assert.Equal(
                string.Empty,
                payload.GetProperty("user_hint")
                    .GetProperty("name")
                    .GetString());
            Assert.Equal(
                "WS01",
                payload.GetProperty("machine")
                    .GetProperty("hostname")
                    .GetString());
            Assert.Equal(
                TestMachineFingerprint,
                payload.GetProperty("machine")
                    .GetProperty("fingerprint")
                    .GetString());
            Assert.Equal(
                "2026",
                payload.GetProperty("revit").GetProperty("version").GetString());
            Assert.Equal(
                4242,
                payload.GetProperty("revit").GetProperty("pid").GetInt32());
            Assert.Equal(
                "2026.07.22.0",
                payload.GetProperty("addin_version").GetString());
            Assert.Equal(
                "0.1.0-test",
                payload.GetProperty("bridge_version").GetString());
            Assert.Equal(8080, payload.GetProperty("port").GetInt32());
            Assert.Equal(
                new[] { "batch_atomic", "doc_context_cached_v1" },
                payload.GetProperty("session_capabilities")
                    .EnumerateArray()
                    .Select(item => item.GetString())
                    .ToArray());

            // Section 14 owns document state; registration never carries a
            // snapshot that could go stale.
            Assert.Empty(payload.GetProperty("documents").EnumerateArray());

            // No Gateway-owned authority may be claimed by the bridge.
            foreach (string forbidden in
                     new[] { "tenant_id", "user_id", "seat_id", "principal", "seat" })
            {
                Assert.False(payload.TryGetProperty(forbidden, out _));
            }

            // Only the accepted target became a route; the rest of the frozen
            // 8080-8085 scan is rejected evidence, not a session.
            Assert.Equal(
                8080,
                Assert.Single(router.GetAvailableSessions())
                    .Session.Target.Port);
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task WorkerCatalogProjectsBatchCapabilityWithoutDocumentContext()
    {
        var transport = new ScriptedStatusTransport(result =>
        {
            result["sessionCapabilities"] = new JArray("batch_atomic");
            ((JObject)result["capabilityContracts"]!).Remove(
                "doc_context_cached_v1");
        });
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()),
            router,
            ScanConfiguration(),
            () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(null),
            "0.1.0-test",
            "WS01");

        RbpLocalSessionSnapshot snapshot = Assert.Single(
            await catalog.ReadAsync());
        string[] capabilities = snapshot.RegistrationPayload
            .GetProperty("session_capabilities")
            .EnumerateArray()
            .Select(item => item.GetString())
            .ToArray()!;

        Assert.Equal(new[] { "batch_atomic" }, capabilities);
        Assert.DoesNotContain("journal_v1", capabilities);
        Assert.DoesNotContain("transport_streamable_http", capabilities);
    }

    [Fact]
    public async Task WorkerCatalogFreshProofReadRequiresCurrentDocumentContextCapabilityAndEpoch()
    {
        string? durableKey = null;
        var transport = new ScriptedStatusTransport(result =>
        {
            result["sessionCapabilities"] = new JArray("batch_atomic");
            ((JObject)result["capabilityContracts"]!).Remove(
                "doc_context_cached_v1");
        });
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()), router,
            ScanConfiguration(), () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(rsid == "rs-cap" ? durableKey : null),
            "0.1.0-test", "WS01");
        RbpLocalSessionSnapshot local = Assert.Single(await catalog.ReadAsync());
        durableKey = local.LocalSessionKey;

        // Neither a durable exact mapping nor an answering transport is enough
        // before a coordinator-owned epoch and this session's advertised cap.
        Assert.Null(await catalog.ReadAsync("rs-cap", CancellationToken.None));
        Assert.True(catalog.BeginConnectionEpoch(1));
        Assert.Null(await catalog.ReadAsync("rs-cap", CancellationToken.None));
        Assert.DoesNotContain("get_document_context", transport.Methods);
        Assert.Null(catalog.Resolve("rs-cap"));
    }

    [Fact]
    public async Task WorkerCatalogDoesNotRetainWithdrawnSessionCapability()
    {
        bool batchAdvertised = true;
        var transport = new ScriptedStatusTransport(result =>
        {
            if (batchAdvertised)
            {
                result["sessionCapabilities"] = new JArray("batch_atomic");
                ((JObject)result["capabilityContracts"]!).Remove(
                    "doc_context_cached_v1");
                return;
            }

            result["sessionCapabilities"] = new JArray();
            result["capabilityContracts"] = new JObject();
        });
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()),
            router,
            ScanConfiguration(),
            () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(null),
            "0.1.0-test",
            "WS01");

        RbpLocalSessionSnapshot granted = Assert.Single(
            await catalog.ReadAsync());
        Assert.Equal(
            new[] { "batch_atomic" },
            granted.RegistrationPayload
                .GetProperty("session_capabilities")
                .EnumerateArray()
                .Select(item => item.GetString()));

        batchAdvertised = false;
        RbpLocalSessionSnapshot withdrawn = Assert.Single(
            await catalog.ReadAsync());
        Assert.Empty(
            withdrawn.RegistrationPayload
                .GetProperty("session_capabilities")
                .EnumerateArray());
    }

    [Fact]
    public async Task WorkerCatalogRevocationRemovesTheBoundRoute()
    {
        bool listenerAvailable = true;
        var transport = new ScriptedStatusTransport(
            isAvailable: () => listenerAvailable);
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()),
            router,
            ScanConfiguration(),
            () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(null),
            "0.1.0-test",
            "WS01");

        RbpLocalSessionSnapshot active = Assert.Single(
            await catalog.ReadAsync());
        Assert.True(catalog.BeginConnectionEpoch(1));
        Assert.True(catalog.TryBindRegisteredSession("rs-revoked", active.LocalSessionKey, 1));
        Assert.NotNull(catalog.Resolve("rs-revoked"));

        catalog.RevokeBoundSession("rs-revoked", 1);
        listenerAvailable = false;
        Assert.Empty(await catalog.ReadAsync());
        Assert.Null(catalog.Resolve("rs-revoked"));
        // A late duplicate registration/resume acknowledgement from this
        // epoch may not resurrect a session that was revoked.
        Assert.False(catalog.TryBindRegisteredSession(
            "rs-revoked", active.LocalSessionKey, 1));
    }

    [Fact]
    public async Task WorkerCatalogBindRequiresTheCurrentAttestedHandle()
    {
        var transport = new ScriptedStatusTransport();
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()),
            router,
            ScanConfiguration(),
            () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(null),
            "0.1.0-test",
            "WS01");

        Assert.True(catalog.BeginConnectionEpoch(1));
        Assert.False(catalog.TryBindRegisteredSession("rs-preflight", "key", 1));
        RbpLocalSessionSnapshot active = Assert.Single(await catalog.ReadAsync());
        Assert.True(catalog.TryBindRegisteredSession(
            "rs-preflight", active.LocalSessionKey, 1));
        Assert.NotNull(catalog.Resolve("rs-preflight"));
    }

    [Fact]
    public async Task WorkerCatalogFreshProofReadUsesExactDurableRsidWithoutPublishingRoute()
    {
        string? durableKey = null;
        var transport = new ScriptedStatusTransport();
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()), router,
            ScanConfiguration(), () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(
                rsid == "rs-direct" ? durableKey : null),
            "0.1.0-test", "WS01");
        RbpLocalSessionSnapshot active = Assert.Single(await catalog.ReadAsync());
        durableKey = active.LocalSessionKey;
        Assert.True(catalog.BeginConnectionEpoch(1));

        RbpFreshDocumentContext? fresh = await catalog.ReadAsync(
            "rs-direct", CancellationToken.None);

        Assert.NotNull(fresh);
        Assert.Null(catalog.Resolve("rs-direct"));
        Assert.Null(await catalog.ReadAsync("rs-wrong", CancellationToken.None));
        Assert.Equal(1, transport.Methods.Count(
            method => method == "get_document_context"));

        // A stale/previous-cycle global route is never an alternate proof
        // path. The direct reader refuses it before selecting a handle.
        Assert.True(catalog.TryBindRegisteredSession(
            "rs-direct", active.LocalSessionKey, 1));
        Assert.Null(await catalog.ReadAsync("rs-direct", CancellationToken.None));
        catalog.FenceConnectionEpoch(1);
        int directCalls = transport.Methods.Count(
            method => method == "get_document_context");
        Assert.Null(await catalog.ReadAsync("rs-direct", CancellationToken.None));
        Assert.Equal(directCalls, transport.Methods.Count(
            method => method == "get_document_context"));
    }

    [Fact]
    public async Task WorkerCatalogFreshProofReadFailsClosedOnWarmingTransportAndKeyDrift()
    {
        string? durableKey = null;
        bool available = true;
        string state = "ready";
        int directLookupCount = 0;
        bool driftDuringRead = false;
        var transport = new ScriptedStatusTransport(
            configureCall: (result, method) =>
            {
                if (method == "get_document_context") result["cacheState"] = state;
            },
            isAvailable: () => available);
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()), router,
            ScanConfiguration(), () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(rsid == "rs-direct"
                ? driftDuringRead && ++directLookupCount == 2
                    ? "other-key"
                    : durableKey
                : null),
            "0.1.0-test", "WS01");
        RbpLocalSessionSnapshot active = Assert.Single(await catalog.ReadAsync());
        durableKey = active.LocalSessionKey;
        Assert.True(catalog.BeginConnectionEpoch(1));

        state = "warming";
        Assert.Null(await catalog.ReadAsync("rs-direct", CancellationToken.None));
        state = "ready";
        available = false;
        Assert.Null(await catalog.ReadAsync("rs-direct", CancellationToken.None));
        available = true;
        durableKey = "other-key";
        Assert.Null(await catalog.ReadAsync("rs-direct", CancellationToken.None));
        durableKey = active.LocalSessionKey;
        directLookupCount = 0;
        driftDuringRead = true;
        Assert.Null(await catalog.ReadAsync("rs-direct", CancellationToken.None));
        Assert.Null(catalog.Resolve("rs-direct"));
    }

    [Fact]
    public async Task WorkerCatalogFreshProofCancellationReleasesLeaseAndSecondReadCanProceed()
    {
        string? durableKey = null;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int blocked = 0;
        var transport = new ScriptedStatusTransport(
            beforeResponse: async call =>
            {
                if (call.Method == "get_document_context" &&
                    Interlocked.Increment(ref blocked) == 1)
                {
                    entered.TrySetResult();
                    await release.Task.ConfigureAwait(false);
                }
            });
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()), router,
            ScanConfiguration(), () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(rsid == "rs-cancel" ? durableKey : null),
            "0.1.0-test", "WS01");
        RbpLocalSessionSnapshot local = Assert.Single(await catalog.ReadAsync());
        durableKey = local.LocalSessionKey;
        Assert.True(catalog.BeginConnectionEpoch(1));
        using var cancelled = new CancellationTokenSource();
        Task<RbpFreshDocumentContext?> first = catalog.ReadAsync(
            "rs-cancel", cancelled.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        cancelled.Cancel();
        release.TrySetResult();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
        Assert.Null(catalog.Resolve("rs-cancel"));

        Assert.NotNull(await catalog.ReadAsync("rs-cancel", CancellationToken.None));
        Assert.Null(catalog.Resolve("rs-cancel"));
    }

    [Fact]
    public async Task WorkerCatalogFreshProofReadDefersInFlightHandleReplacement()
    {
        string? durableKey = null;
        string addinVersion = "2026.07.22.0";
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new ScriptedStatusTransport(
            configure: result => result["addinVersion"] = addinVersion,
            beforeResponse: async call =>
            {
                if (call.Method == "get_document_context")
                {
                    entered.TrySetResult();
                    await release.Task.ConfigureAwait(false);
                }
            });
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()), router,
            ScanConfiguration(), () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(rsid == "rs-replace" ? durableKey : null),
            "0.1.0-test", "WS01");
        RbpLocalSessionSnapshot local = Assert.Single(await catalog.ReadAsync());
        durableKey = local.LocalSessionKey;
        Assert.True(catalog.BeginConnectionEpoch(1));
        Task<RbpFreshDocumentContext?> read = catalog.ReadAsync("rs-replace", CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        addinVersion = "2026.07.22.1";
        _ = Assert.Single(await catalog.ReadAsync());
        release.TrySetResult();

        Assert.NotNull(await read);
        _ = Assert.Single(await catalog.ReadAsync());
        Assert.Null(catalog.Resolve("rs-replace"));
    }

    [Fact]
    public async Task WorkerCatalogFreshProofReadDefersInFlightAttestationDrift()
    {
        string? durableKey = null;
        string image = @"C:\Program Files\Autodesk\Revit 2026\Revit.exe";
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new ScriptedStatusTransport(
            attestation: () => new AddinProcessAttestation(
                new AddinProcessIdentity(4242, ScriptedStartTimeFileTimeUtc), "2026", image),
            beforeResponse: async call =>
            {
                if (call.Method == "get_document_context")
                {
                    entered.TrySetResult();
                    await release.Task.ConfigureAwait(false);
                }
            });
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()), router,
            ScanConfiguration(), () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(rsid == "rs-attestation" ? durableKey : null),
            "0.1.0-test", "WS01");
        RbpLocalSessionSnapshot local = Assert.Single(await catalog.ReadAsync());
        durableKey = local.LocalSessionKey;
        Assert.True(catalog.BeginConnectionEpoch(1));
        Task<RbpFreshDocumentContext?> read = catalog.ReadAsync("rs-attestation", CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        image = @"C:\Unexpected\Revit.exe";
        _ = Assert.Single(await catalog.ReadAsync());
        release.TrySetResult();

        Assert.NotNull(await read);
        _ = Assert.Single(await catalog.ReadAsync());
        Assert.Null(catalog.Resolve("rs-attestation"));
    }

    [Fact]
    public async Task CoordinatorCancellationDuringScopedFreshReadMustExitAndFencesRoute()
    {
        using var directory = new RbpJournalTestDirectory();
        var clock = new ManualCoordinatorClock();
        await using RbpJournalStore store = OpenStore(directory, clock);
        string? durableKey = null;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int blocked = 0;
        var transport = new ScriptedStatusTransport(
            beforeResponse: async call =>
            {
                if (call.Method == "get_document_context" &&
                    Interlocked.Increment(ref blocked) == 1)
                {
                    entered.TrySetResult();
                    await release.Task.ConfigureAwait(false);
                }
            });
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()), router,
            ScanConfiguration(), () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(rsid == "rs-8080" ? durableKey : null),
            "0.1.0-test", "WS01");
        RbpLocalSessionSnapshot local = Assert.Single(await catalog.ReadAsync());
        durableKey = local.LocalSessionKey;
        _ = await store.PersistRegisteredSessionAsync(Registration(local, "rs-8080"));
        string[] capability = [RbpHelloProfile.RouteRebindProofCapability];
        var responder = new ScriptedGatewayResponder(clock);
        var cycle = new FakeConnectionCycle(
            responder.Respond,
            grantedConnectionCapabilities: capability,
            connectionId: "019f9add-7a83-7d11-a6a9-d2f8108c0301");
        RbpConnectionCoordinator coordinator = WorkerGatewayComposition.CreateCoordinator(
            new WorkerGatewayServices(
                new FakeConnectionCycleFactory(cycle), store, catalog,
                new RbpConnectionCoordinatorOptions(
                    new Uri("wss://gateway.revagent.app/bridge/v1"),
                    new RbpHelloProfile("0.1.0", "WS01", "Windows 11",
                        new[] { "2026.07.26.0" }, capability),
                    SessionRouteBindingAuthority: catalog),
                new WorkerAddinDispatchSurface(router, catalog, catalog),
                clock, new FixedRandomSource(0)));
        using var stop = new CancellationTokenSource();
        Task run = coordinator.RunAsync(stop.Token);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            stop.Cancel();
        }
        finally
        {
            release.TrySetResult();
            stop.Cancel();
        }
        RbpCoordinatorException failure =
            await Assert.ThrowsAsync<RbpCoordinatorException>(
                () => run.WaitAsync(TimeSpan.FromSeconds(5)));

        Assert.Equal(
            RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
            failure.ErrorCode);
        Assert.Equal(RbpConnectionPhase.Shutdown,
            coordinator.GetSnapshot().Lifecycle.Phase);
        Assert.Null(catalog.Resolve("rs-8080"));
    }

    [Fact]
    public async Task WorkerCatalogRefreshFencesChangedHandleUntilNewAcknowledgedBind()
    {
        string addinVersion = "2026.07.22.0";
        var transport = new ScriptedStatusTransport(result =>
            result["addinVersion"] = addinVersion);
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()),
            router,
            ScanConfiguration(),
            () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(null),
            "0.1.0-test",
            "WS01");

        RbpLocalSessionSnapshot first = Assert.Single(await catalog.ReadAsync());
        Assert.True(catalog.BeginConnectionEpoch(1));
        Assert.True(catalog.TryBindRegisteredSession("rs-refresh", first.LocalSessionKey, 1));
        AddinSessionRouter.SessionHandle before = Assert.IsType<AddinSessionRouter.SessionHandle>(
            catalog.Resolve("rs-refresh"));

        addinVersion = "2026.07.22.1";
        _ = Assert.Single(await catalog.ReadAsync());

        // Discovery/attestation refresh cannot republish an existing rsid to a
        // different handle. A new matching session lifecycle acknowledgement
        // is required before anything becomes dispatchable again.
        Assert.Null(catalog.Resolve("rs-refresh"));
    }

    [Fact]
    public async Task WorkerCatalogAttestationImageDriftFencesBoundRoute()
    {
        string image = @"C:\Program Files\Autodesk\Revit 2026\Revit.exe";
        var transport = new ScriptedStatusTransport(
            attestation: () => new AddinProcessAttestation(
                new AddinProcessIdentity(4242, ScriptedStartTimeFileTimeUtc),
                "2026", image));
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()), router,
            ScanConfiguration(), () => new FixedCredentialProvider(),
            (_, _) => Task.FromResult<string?>(null), "0.1.0-test", "WS01");
        RbpLocalSessionSnapshot active = Assert.Single(await catalog.ReadAsync());
        Assert.True(catalog.BeginConnectionEpoch(1));
        Assert.True(catalog.TryBindRegisteredSession("rs-attested", active.LocalSessionKey, 1));
        Assert.NotNull(catalog.Resolve("rs-attested"));

        image = @"C:\Unexpected\Revit.exe";
        _ = Assert.Single(await catalog.ReadAsync());

        Assert.Null(catalog.Resolve("rs-attested"));
    }

    [Fact]
    public async Task RoutedChannelFailsClosedWithRouteFailureAfterHandleRemoval()
    {
        bool listenerAvailable = true;
        var transport = new ScriptedStatusTransport(
            isAvailable: () => listenerAvailable);
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()),
            router,
            ScanConfiguration(),
            () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(null),
            "0.1.0-test",
            "WS01");
        RbpLocalSessionSnapshot active = Assert.Single(await catalog.ReadAsync());
        Assert.True(catalog.BeginConnectionEpoch(1));
        Assert.True(catalog.TryBindRegisteredSession("rs-removed", active.LocalSessionKey, 1));
        var channel = new RbpRoutedInvocationChannel(router, catalog);

        listenerAvailable = false;
        Assert.Empty(await catalog.ReadAsync());
        RbpAddinOutcome outcome = await channel.InvokeAsync(
            "rs-removed",
            new AddinCall("route-removed", "get_document_context", new JObject(), TimeSpan.FromSeconds(1)),
            CancellationToken.None);

        Assert.Equal(RbpAddinOutcomeKind.KnownNotDispatched, outcome.Kind);
        Assert.True(outcome.RouteFailure);
        Assert.Equal(0, outcome.RequestBytes);
    }

    [Fact]
    public async Task RoutedCatalogChannelInvokesCachedDocumentContextWithBoundHandle()
    {
        var transport = new ScriptedStatusTransport();
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()),
            router,
            ScanConfiguration(),
            () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(null),
            "0.1.0-test",
            "WS01");
        RbpLocalSessionSnapshot active = Assert.Single(await catalog.ReadAsync());
        Assert.True(catalog.BeginConnectionEpoch(1));
        Assert.True(catalog.TryBindRegisteredSession("rs-document", active.LocalSessionKey, 1));
        var channel = new RbpRoutedInvocationChannel(router, catalog);

        RbpAddinOutcome outcome = await channel.InvokeAsync(
            "rs-document",
            new AddinCall("document-1", "get_document_context", new JObject(), TimeSpan.FromSeconds(1)),
            CancellationToken.None);

        try
        {
            Assert.Equal(RbpAddinOutcomeKind.Completed, outcome.Kind);
            Assert.True(outcome.RequestBytes > 0);
            Assert.True(outcome.ResponseBytes > 0);
            AddinDocumentContextResponse response =
                AddinDocumentContextParser.ParseResponse(
                    System.Text.Encoding.UTF8.GetString(outcome.RawResponsePayload));
            Assert.Equal("document-1", response.RequestId);
            Assert.Equal(DocumentContextCacheState.Ready, response.Context.CacheState);
        }
        finally
        {
            outcome.Lease?.ReleaseAfterDurableDecision();
        }
    }

    [Fact]
    public async Task WorkerCatalogRejectsMismatchedOrDuplicateRouteBindings()
    {
        var transport = new ScriptedStatusTransport();
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()),
            router,
            ScanConfiguration(),
            () => new FixedCredentialProvider(),
            (rsid, _) => Task.FromResult<string?>(null),
            "0.1.0-test",
            "WS01");
        RbpLocalSessionSnapshot active = Assert.Single(await catalog.ReadAsync());

        Assert.True(catalog.BeginConnectionEpoch(1));
        Assert.False(catalog.TryBindRegisteredSession("rs-bind", "unknown", 1));
        Assert.True(catalog.TryBindRegisteredSession(
            "rs-bind", active.LocalSessionKey, 1));
        Assert.False(catalog.TryBindRegisteredSession(
            "rs-bind", "other-local-session", 1));
        Assert.NotNull(catalog.Resolve("rs-bind"));
        catalog.FenceConnectionEpoch(1);
        Assert.Null(catalog.Resolve("rs-bind"));
        Assert.False(catalog.TryBindRegisteredSession(
            "rs-bind", active.LocalSessionKey, 1));
        Assert.True(catalog.BeginConnectionEpoch(2));
        Assert.True(catalog.TryBindRegisteredSession(
            "rs-bind", active.LocalSessionKey, 2));
        Assert.NotNull(catalog.Resolve("rs-bind"));
        catalog.DenyConnectionEpoch(2);
        Assert.Null(catalog.Resolve("rs-bind"));
        Assert.False(catalog.TryBindRegisteredSession(
            "rs-bind", active.LocalSessionKey, 2));
        Assert.False(catalog.BeginConnectionEpoch(2));
        Assert.True(catalog.BeginConnectionEpoch(3));
    }

    [Fact]
    public async Task WorkerCatalogRejectsPairDriftUntilCredentialRotationBinds()
    {
        string currentToken = "token-0123456789ABCDEFGHIJKLMNOP";
        var enrollment = new RuntimeEnrollmentProvider(
            currentToken,
            TestMachineFingerprint);
        var credentialClaims = new RbpCredentialClaimBinding(enrollment);
        Assert.Equal(
            RbpEnrollmentStatus.Ready,
            (await credentialClaims.ReadAsync()).Status);

        var transport = new ScriptedStatusTransport();
        var router = new AddinSessionRouter(transport);
        var catalog = new WorkerAddinSessionCatalog(
            new AddinDiscovery(transport, new NoOpProcessAttestor()),
            router,
            ScanConfiguration(),
            () => new RuntimeCredentialProvider(
                currentToken,
                TestMachineFingerprint),
            (rsid, _) => Task.FromResult<string?>(null),
            "0.1.0-test",
            "WS01",
            credentialClaims: credentialClaims);

        Assert.Single(await catalog.ReadAsync());

        currentToken += "-rotated";
        RbpGatewayTransportException mismatch =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => catalog.ReadAsync());
        Assert.Equal(RbpGatewayFailureKind.Authorization, mismatch.Kind);
        Assert.Equal(4403, mismatch.CloseCode);

        enrollment.Token = currentToken;
        Assert.Equal(
            RbpEnrollmentStatus.Ready,
            (await credentialClaims.ReadAsync()).Status);
        Assert.Single(await catalog.ReadAsync());
    }

    private const string TestMachineFingerprint =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    private const long ScriptedStartTimeFileTimeUtc = 133_000_000_000_000_000;

    private static ResolvedBridgeConfiguration ScanConfiguration() =>
        new(
            schemaVersion: 1,
            gatewayUri: new Uri("wss://gateway.revagent.app/bridge/v1"),
            addin: new BridgeAddinConfiguration(8080, 8085),
            logging: new BridgeLoggingConfiguration(1024 * 1024, 3),
            sourceMetadata: new BridgeConfigurationSourceMetadata(
                "bridge-config.json",
                new Dictionary<string, BridgeConfigurationValueSource>(
                    StringComparer.Ordinal)
                {
                    ["addin.scanStartPort"] = new(
                        BridgeConfigurationSourceKind.File,
                        "bridge-config.json"),
                    ["addin.scanEndPort"] = new(
                        BridgeConfigurationSourceKind.File,
                        "bridge-config.json"),
                }));

    /// <summary>
    /// Answers the frozen positive <c>mcp_status</c> fixture on 8080 and
    /// refuses every other port of the bounded scan, so the discovery evidence
    /// partition is complete and exactly one session survives.
    /// </summary>
    private sealed class ScriptedStatusTransport : IAddinTransport
    {
        private readonly Action<JObject>? _configure;
        private readonly Action<JObject, string>? _configureCall;
        private readonly Func<AddinProcessAttestation>? _attestation;
        private readonly Func<AddinCall, Task>? _beforeResponse;
        private readonly Func<bool> _isAvailable;

        internal ScriptedStatusTransport(
            Action<JObject>? configure = null,
            Action<JObject, string>? configureCall = null,
            Func<AddinProcessAttestation>? attestation = null,
            Func<AddinCall, Task>? beforeResponse = null,
            Func<bool>? isAvailable = null)
        {
            _configure = configure;
            _configureCall = configureCall;
            _attestation = attestation;
            _beforeResponse = beforeResponse;
            _isAvailable = isAvailable ?? (() => true);
        }

        internal ConcurrentQueue<string> Methods { get; } = new();

        public async Task<AddinCallResult> InvokeAsync(
            AddinEndpoint endpoint,
            AddinCall call,
            CancellationToken preDispatchCancellationToken = default,
            CancellationToken transportShutdownToken = default,
            IAddinProcessAttestor? processAttestor = null)
        {
            _ = processAttestor;
            Methods.Enqueue(call.Method);
            preDispatchCancellationToken.ThrowIfCancellationRequested();
            transportShutdownToken.ThrowIfCancellationRequested();
            if (endpoint.Port != 8080 || !_isAvailable())
            {
                throw new AddinTransportException(
                    "addin_connect_failed",
                    "No add-in listener on this port.",
                    new AddinTransportEvidence(
                        AddinDispatchState.NotStarted,
                        RequestPayloadBytes: 0,
                        RequestFrameBytes: 0,
                        BytesWrittenLowerBound: 0,
                        RequestFullyWritten: false,
                        ResponseBytesObserved: 0));
            }

            JObject result = string.Equals(
                call.Method,
                "get_document_context",
                StringComparison.Ordinal)
                ? DocumentContextResult()
                : LoadStatusFixtureResult();
            if (!string.Equals(call.Method, "get_document_context", StringComparison.Ordinal))
            {
                _configure?.Invoke(result);
            }
            _configureCall?.Invoke(result, call.Method);
            if (_beforeResponse is not null)
            {
                await _beforeResponse(call).ConfigureAwait(false);
            }
            var envelope = new JObject
            {
                ["jsonrpc"] = "2.0",
                ["id"] = call.InvocationId,
                ["result"] = result,
            };
            AddinJsonRpcResponse response = AddinJsonRpcCodec.ParseResponse(
                System.Text.Encoding.UTF8.GetBytes(
                    envelope.ToString(Newtonsoft.Json.Formatting.None)),
                call.InvocationId);
            return new AddinCallResult(
                    response,
                    new AddinTransportEvidence(
                        AddinDispatchState.ResponseObserved,
                        RequestPayloadBytes: 1,
                        RequestFrameBytes: 5,
                        BytesWrittenLowerBound: 5,
                        RequestFullyWritten: true,
                        ResponseBytesObserved: 5),
                    _attestation?.Invoke() ?? new AddinProcessAttestation(
                        new AddinProcessIdentity(
                            4242,
                            ScriptedStartTimeFileTimeUtc),
                        "2026",
                        @"C:\Program Files\Autodesk\Revit 2026\Revit.exe"));
        }

        private static JObject LoadStatusFixtureResult()
        {
            string path = Path.Combine(
                FindRepositoryRoot(),
                "packages",
                "protocol",
                "fixtures",
                "addin-loopback",
                "v1",
                "mcp-status.positive.json");
            using var textReader = File.OpenText(path);
            using var jsonReader = new Newtonsoft.Json.JsonTextReader(
                textReader)
            {
                DateParseHandling = Newtonsoft.Json.DateParseHandling.None,
                FloatParseHandling =
                    Newtonsoft.Json.FloatParseHandling.Decimal,
            };
            JObject scenario = JObject.Load(jsonReader);
            return (JObject)((JObject)scenario["response"]!)["result"]!
                .DeepClone();
        }

        private static JObject DocumentContextResult() => JObject.Parse(
            """
            {
              "resultContractVersion":2,
              "documentContextContractVersion":1,
              "capturedAtUtc":"2026-08-24T00:00:00.000Z",
              "revision":1,
              "cache_incarnation_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "cacheState":"ready",
              "unavailableReason":null,
              "documents":[],
              "activeDocumentId":null,
              "activeView":null,
              "disciplineHint":null
            }
            """);

        private static string FindRepositoryRoot()
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory is not null)
            {
                if (File.Exists(Path.Combine(directory.FullName, "package.json")) &&
                    Directory.Exists(
                        Path.Combine(directory.FullName, "packages")))
                {
                    return directory.FullName;
                }

                directory = directory.Parent;
            }

            throw new InvalidOperationException(
                "The repository root could not be located.");
        }
    }

    private sealed class NoOpProcessAttestor : IAddinProcessAttestor
    {
        public Task<AddinProcessAttestation> AttestBeforeDispatchAsync(
            AddinConnectedPeer peer,
            CancellationToken cancellationToken) =>
            throw new InvalidOperationException(
                "The scripted transport never attests a real socket.");

        public Task VerifyAfterResponseAsync(
            AddinConnectedPeer peer,
            AddinProcessAttestation attestation,
            CancellationToken cancellationToken) =>
            throw new InvalidOperationException(
                "The scripted transport never attests a real socket.");
    }

    private sealed class FixedCredentialProvider :
        IBridgeDeviceCredentialProvider
    {
        public BridgeGatewayCredential GetRequired() =>
            new(
                "device-1",
                new BridgeSecretString("token-0123456789ABCDEFGHIJKLMNOP"),
                TestMachineFingerprint);
    }

    private sealed class RuntimeCredentialProvider :
        IBridgeDeviceCredentialProvider
    {
        private readonly string _token;
        private readonly string _claim;

        internal RuntimeCredentialProvider(string token, string claim)
        {
            _token = token;
            _claim = claim;
        }

        public BridgeGatewayCredential GetRequired() =>
            new(
                "device-1",
                new BridgeSecretString(_token),
                _claim);
    }

    private sealed class RuntimeEnrollmentProvider :
        IRbpEnrollmentStateProvider
    {
        internal RuntimeEnrollmentProvider(string token, string claim)
        {
            Token = token;
            Claim = claim;
        }

        internal string Token { get; set; }

        internal string Claim { get; }

        public ValueTask<RbpEnrollmentSnapshot> ReadAsync(
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(
                RbpEnrollmentSnapshot.Ready(
                    new RbpDeviceCredential("device-1", Token, Claim)));
        }
    }

    private static RbpLocalSessionSnapshot WatchedLocalSession(
        int port,
        int processId)
    {
        string localKey = $"port:{port}:pid:{processId}:started:100";
        return new RbpLocalSessionSnapshot(
            localKey,
            Json(
                $$"""
                {
                  "local_session_key":"{{localKey}}",
                  "user_hint":{"name":""},
                  "machine":{
                    "hostname":"WS01",
                    "fingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                  },
                  "revit":{
                    "version":"2024",
                    "build":"24.1",
                    "pid":{{processId}}
                  },
                  "addin_version":"2026.07.26.0",
                  "result_contract_version":2,
                  "session_capabilities":["doc_context_cached_v1"],
                  "bridge_version":"0.1.0",
                  "documents":[],
                  "port":{{port}}
                }
                """),
            port,
            Json("""{"active_task":null,"addin_reachable":true}"""));
    }

    /// <summary>
    /// Records every rsid the composed dispatch path and document-context
    /// watcher ask about, and always refuses the route so no add-in byte is
    /// written from a test.
    /// </summary>
    private sealed class RecordingRouteResolver : IRbpSessionRouteResolver
    {
        internal ConcurrentQueue<string> Resolved { get; } = new();

        public AddinSessionRouter.SessionHandle? Resolve(string rsid)
        {
            Resolved.Enqueue(rsid);
            return null;
        }
    }

    private static RbpEnvelope ResumeAck(
        ManualCoordinatorClock clock,
        string rsid) => new(
        1,
        "resume_ack",
        Id(9911),
        clock.UtcNow.ToString("O"),
        JsonSerializer.SerializeToElement(new
        {
            rsid,
            last_rx_seq = 0,
            resume_expires_at = "2026-07-27T10:00:00.000Z",
        }),
        RbpEnvelopeScope.Control,
        Rsid: null,
        Sequence: null,
        Acknowledgement: null,
        Hello: null,
        HelloAck: null,
        RbpEnvelopeDisposition.Known,
        RbpEnvelope.FreezeAdditionalProperties(
            new Dictionary<string, JsonElement>()));

    private sealed class ResumeRouteFixture : IDisposable
    {
        private readonly RbpJournalTestDirectory _directory;
        private readonly RbpJournalStore _store;
        private readonly CancellationTokenSource _stop = new();

        private ResumeRouteFixture(
            RbpJournalTestDirectory directory,
            RbpJournalStore store,
            ManualCoordinatorClock clock,
            FakeConnectionCycle cycle,
            RecordingRouteAuthority routes,
            ConcurrentQueue<RbpLifecycleTimeoutObservation> timeouts,
            TeardownOrderProbe teardownOrder,
            RbpConnectionCoordinator coordinator)
        {
            _directory = directory;
            _store = store;
            Clock = clock;
            Cycle = cycle;
            Routes = routes;
            Timeouts = timeouts;
            TeardownOrder = teardownOrder;
            Coordinator = coordinator;
        }

        internal ManualCoordinatorClock Clock { get; }
        internal FakeConnectionCycle Cycle { get; }
        internal RecordingRouteAuthority Routes { get; }
        internal ConcurrentQueue<RbpLifecycleTimeoutObservation> Timeouts { get; }
        internal TeardownOrderProbe TeardownOrder { get; }
        internal RbpConnectionCoordinator Coordinator { get; }
        internal Task Run { get; private set; } = Task.CompletedTask;

        internal static async Task<ResumeRouteFixture> CreateAsync(
            bool respondToResume)
        {
            var directory = new RbpJournalTestDirectory();
            var clock = new ManualCoordinatorClock();
            RbpJournalStore store = OpenStore(directory, clock);
            RbpLocalSessionSnapshot local = WatchedLocalSession(8080, 1000);
            _ = await store.PersistRegisteredSessionAsync(
                Registration(local, "rs-8080"));
            var responder = new ScriptedGatewayResponder(clock);
            var teardownOrder = new TeardownOrderProbe();
            var cycle = new FakeConnectionCycle(
                envelope =>
                    envelope.Type == "session_resume" && !respondToResume
                        ? null
                        : responder.Respond(envelope),
                onCloseStarted: teardownOrder.RecordCloseStarted);
            var routes = new RecordingRouteAuthority(teardownOrder.RecordFence);
            var timeouts = new ConcurrentQueue<RbpLifecycleTimeoutObservation>();
            RbpConnectionCoordinator coordinator =
                WorkerGatewayComposition.CreateCoordinator(
                    new WorkerGatewayServices(
                        new FakeConnectionCycleFactory(cycle), store,
                        new MutableSessionCatalog(local),
                        CompositionOptions() with
                        {
                            SessionRouteBindingAuthority = routes,
                        },
                        new WorkerAddinDispatchSurface(
                            new AddinSessionRouter(
                                new NeverInvokedAddinTransport()), routes),
                        clock, new FixedRandomSource(0),
                        OnLifecycleTimeoutObservation: observation =>
                        {
                            timeouts.Enqueue(observation);
                            return ValueTask.CompletedTask;
                        }));
            var fixture = new ResumeRouteFixture(
                directory, store, clock, cycle, routes, timeouts,
                teardownOrder, coordinator);
            fixture.Run = coordinator.RunAsync(fixture._stop.Token);
            return fixture;
        }

        internal async Task StopAfterAssertedFailureAsync()
        {
            Task<RbpCoordinatorTeardownResult> teardown =
                Coordinator.RequestStopTeardown();
            _stop.Cancel();
            RbpCoordinatorTeardownResult result = await teardown
                .WaitAsync(TimeSpan.FromSeconds(5));
            try
            {
                await Run.WaitAsync(TimeSpan.FromSeconds(5));
            }
            catch (RbpCoordinatorException exception) when (
                exception.ErrorCode ==
                    RbpCoordinatorErrorCode.NonDrainingConnectionAuthority &&
                (result.Disposition ==
                    RbpCoordinatorTeardownDisposition.EmergencyMustExit ||
                 Cycle.CloseCount > 0))
            {
                // The test already asserted the exact resume/lifecycle fault.
                // A one-cycle fixture stopped during its replacement
                // PreSteady attempt must preserve V11 must-exit semantics.
            }
        }

        public void Dispose()
        {
            _stop.Cancel();
            _store.DisposeAsync().AsTask().GetAwaiter().GetResult();
            _stop.Dispose();
            _directory.Dispose();
        }
    }

    private sealed class TeardownOrderProbe
    {
        private long _nextOrdinal;
        private long _firstFenceOrdinal;
        private long _firstCloseStartedOrdinal;

        internal long FirstFenceOrdinal =>
            Volatile.Read(ref _firstFenceOrdinal);

        internal long FirstCloseStartedOrdinal =>
            Volatile.Read(ref _firstCloseStartedOrdinal);

        internal void RecordFence(long epoch)
        {
            _ = epoch;
            long ordinal = Interlocked.Increment(ref _nextOrdinal);
            _ = Interlocked.CompareExchange(
                ref _firstFenceOrdinal,
                ordinal,
                0);
        }

        internal void RecordCloseStarted()
        {
            long ordinal = Interlocked.Increment(ref _nextOrdinal);
            _ = Interlocked.CompareExchange(
                ref _firstCloseStartedOrdinal,
                ordinal,
                0);
        }
    }

    private sealed class RecordingRouteAuthority :
        IRbpSessionRouteResolver,
        IRbpSessionRouteBindingAuthority
    {
        private readonly ConcurrentDictionary<string, string> _bound =
            new(StringComparer.Ordinal);
        private readonly Action<long>? _onFenceObserved;
        private int _resolveBeforeBindingCount;
        private long _activeEpoch;
        private int _bindAttempts;
        private int _successfulPublications;
        private int _revokeCount;
        private int _fenceCount;

        internal RecordingRouteAuthority(
            Action<long>? onFenceObserved = null)
        {
            _onFenceObserved = onFenceObserved;
        }

        internal ConcurrentQueue<string> Resolved { get; } = new();

        internal ConcurrentQueue<string> Bound { get; } = new();

        internal int ResolveBeforeBindingCount =>
            Volatile.Read(ref _resolveBeforeBindingCount);

        internal bool IsBound(string rsid) => _bound.ContainsKey(rsid);

        internal int ActiveRouteCount => _bound.Count;

        internal bool FenceImmediatelyBeforeBind { get; set; }

        internal int BindAttempts => Volatile.Read(ref _bindAttempts);
        internal int SuccessfulPublications => Volatile.Read(ref _successfulPublications);
        internal int RevokeCount => Volatile.Read(ref _revokeCount);
        internal int FenceCount => Volatile.Read(ref _fenceCount);

        public AddinSessionRouter.SessionHandle? Resolve(string rsid)
        {
            Resolved.Enqueue(rsid);
            if (!_bound.ContainsKey(rsid))
            {
                Interlocked.Increment(ref _resolveBeforeBindingCount);
            }

            return null;
        }

        public bool BeginConnectionEpoch(long epoch)
        {
            _activeEpoch = epoch;
            return epoch > 0;
        }

        public void FenceConnectionEpoch(long epoch)
        {
            _onFenceObserved?.Invoke(epoch);
            Interlocked.Increment(ref _fenceCount);
            if (_activeEpoch == epoch) _activeEpoch = 0;
            _bound.Clear();
        }

        public void RevokeBoundSession(string rsid, long epoch) =>
            Revoke(rsid);

        private void Revoke(string rsid)
        {
            Interlocked.Increment(ref _revokeCount);
            _bound.TryRemove(rsid, out _);
        }

        public bool TryBindRegisteredSession(string rsid, string localSessionKey, long epoch)
        {
            Interlocked.Increment(ref _bindAttempts);
            if (FenceImmediatelyBeforeBind)
            {
                FenceConnectionEpoch(epoch);
                return false;
            }
            if (_activeEpoch != epoch) return false;
            if (_bound.TryGetValue(rsid, out string? existing))
            {
                return string.Equals(
                    existing,
                    localSessionKey,
                    StringComparison.Ordinal);
            }

            if (_bound.TryAdd(rsid, localSessionKey))
            {
                Interlocked.Increment(ref _successfulPublications);
                Bound.Enqueue(rsid);
                return true;
            }

            return false;
        }
    }

    /// <summary>
    /// Test-only identifier failure: hello consumes the first fill and the
    /// fresh route proof consumes the second, so this proves the fresh read
    /// completed before proof construction failed.
    /// </summary>
    private sealed class ThrowingRandomSource : IRbpRandomSource
    {
        private readonly int _throwOnFill;
        private int _fills;

        internal ThrowingRandomSource(int throwOnFill)
        {
            _throwOnFill = throwOnFill;
        }

        public void Fill(Span<byte> destination)
        {
            int fill = Interlocked.Increment(ref _fills);
            if (fill == _throwOnFill)
            {
                throw new InvalidOperationException(
                    "test-only proof identifier construction failure");
            }

            destination.Clear();
        }

        public double NextUnitInterval() => 0;
    }

    private sealed class RuntimeLifetime : IHostApplicationLifetime
    {
        private readonly CancellationTokenSource _started = new();
        private readonly CancellationTokenSource _stopping = new();
        private readonly CancellationTokenSource _stopped = new();

        internal RuntimeLifetime() => _started.Cancel();

        public CancellationToken ApplicationStarted => _started.Token;

        public CancellationToken ApplicationStopping => _stopping.Token;

        public CancellationToken ApplicationStopped => _stopped.Token;

        internal bool StopRequested => _stopping.IsCancellationRequested;

        public void StopApplication()
        {
            _stopping.Cancel();
            _stopped.Cancel();
        }
    }

    private sealed class RuntimeLog : IBridgeLog
    {
        public ValueTask WriteAsync(
            string level,
            string eventId,
            string category,
            string message,
            Exception? exception = null,
            CancellationToken cancellationToken = default)
        {
            _ = level;
            _ = eventId;
            _ = category;
            _ = message;
            _ = exception;
            _ = cancellationToken;
            return ValueTask.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private static async Task StopAfterAssertedConnectionFailureAsync(
        RbpConnectionCoordinator coordinator,
        CancellationTokenSource stop,
        Task run,
        Func<bool> failureWasAsserted)
    {
        Task<RbpCoordinatorTeardownResult> teardown =
            coordinator.RequestStopTeardown();
        stop.Cancel();
        RbpCoordinatorTeardownResult result = await teardown
            .WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            await run.WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (RbpCoordinatorException exception) when (
            failureWasAsserted() &&
            exception.ErrorCode ==
                RbpCoordinatorErrorCode.NonDrainingConnectionAuthority &&
            (result.Disposition ==
                RbpCoordinatorTeardownDisposition.EmergencyMustExit ||
             AttemptStopState(coordinator) == 4))
        {
            // The owning test already proved the exact route/lifecycle fault;
            // cancellation racing its synthetic replacement PreSteady attempt
            // must retain the V11 must-exit primary.
        }
    }

    private static int RuntimeDisposed(WorkerGatewayRuntime runtime) =>
        (int)(typeof(WorkerGatewayRuntime).GetField(
                  "_disposed",
                  BindingFlags.Instance | BindingFlags.NonPublic)?
              .GetValue(runtime) ??
          throw new MissingFieldException("WorkerGatewayRuntime._disposed"));
}
