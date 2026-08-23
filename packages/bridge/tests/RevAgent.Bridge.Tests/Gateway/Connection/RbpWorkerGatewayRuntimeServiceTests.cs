using System.Collections.Concurrent;
using System.Diagnostics;
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
        var binder = new RecordingRouteBinder();
        await using var runtime = new WorkerGatewayRuntime(
            coordinator,
            binder,
            ownedJournal: null,
            bindingRefreshInterval: TimeSpan.FromMilliseconds(10));
        var service = new WorkerGatewayRuntimeService(
            () => runtime,
            new RuntimeLifetime(),
            new RuntimeLog(),
            new WorkerExitState());

        await service.StartAsync(CancellationToken.None);
        try
        {
            await EventuallyAsync(() => binder.Bound.Contains("rs-8080"));
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }

        // The pump never outlives the connection.
        int settled = binder.PassCount;
        await Task.Delay(60);
        Assert.Equal(settled, binder.PassCount);
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
            Assert.Contains("rs-8080", routes.Bound);
            Assert.Equal(0, routes.ResolveBeforeBindingCount);
            Assert.Contains(cycle.Sent, envelope => envelope.Type == "session_resume");
        }
        finally
        {
            stop.Cancel();
            await run.WaitAsync(TimeSpan.FromSeconds(5));
        }
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
        catalog.Bind("rs-revoked", active.LocalSessionKey);
        Assert.NotNull(catalog.Resolve("rs-revoked"));

        listenerAvailable = false;
        Assert.Empty(await catalog.ReadAsync());
        Assert.Null(catalog.Resolve("rs-revoked"));
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

        Assert.False(catalog.TryBindRegisteredSession("rs-bind", "unknown"));
        Assert.True(catalog.TryBindRegisteredSession(
            "rs-bind", active.LocalSessionKey));
        Assert.False(catalog.TryBindRegisteredSession(
            "rs-bind", "other-local-session"));
        Assert.NotNull(catalog.Resolve("rs-bind"));
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

        currentToken = "rotated-0123456789ABCDEFGHIJKLMNOP";
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
        private readonly Func<bool> _isAvailable;

        internal ScriptedStatusTransport(
            Action<JObject>? configure = null,
            Func<bool>? isAvailable = null)
        {
            _configure = configure;
            _isAvailable = isAvailable ?? (() => true);
        }

        public Task<AddinCallResult> InvokeAsync(
            AddinEndpoint endpoint,
            AddinCall call,
            CancellationToken preDispatchCancellationToken = default,
            CancellationToken transportShutdownToken = default,
            IAddinProcessAttestor? processAttestor = null)
        {
            _ = processAttestor;
            preDispatchCancellationToken.ThrowIfCancellationRequested();
            transportShutdownToken.ThrowIfCancellationRequested();
            if (endpoint.Port != 8080 || !_isAvailable())
            {
                return Task.FromException<AddinCallResult>(
                    new AddinTransportException(
                        "addin_connect_failed",
                        "No add-in listener on this port.",
                        new AddinTransportEvidence(
                            AddinDispatchState.NotStarted,
                            RequestPayloadBytes: 0,
                            RequestFrameBytes: 0,
                            BytesWrittenLowerBound: 0,
                            RequestFullyWritten: false,
                            ResponseBytesObserved: 0)));
            }

            JObject result = LoadStatusFixtureResult();
            _configure?.Invoke(result);
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
            return Task.FromResult(
                new AddinCallResult(
                    response,
                    new AddinTransportEvidence(
                        AddinDispatchState.ResponseObserved,
                        RequestPayloadBytes: 1,
                        RequestFrameBytes: 5,
                        BytesWrittenLowerBound: 5,
                        RequestFullyWritten: true,
                        ResponseBytesObserved: 5),
                    new AddinProcessAttestation(
                        new AddinProcessIdentity(
                            4242,
                            ScriptedStartTimeFileTimeUtc),
                        "2026",
                        @"C:\Program Files\Autodesk\Revit 2026\Revit.exe")));
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

    private sealed class RecordingRouteAuthority :
        IRbpSessionRouteResolver,
        IRbpSessionRouteBindingAuthority
    {
        private readonly ConcurrentDictionary<string, string> _bound =
            new(StringComparer.Ordinal);
        private int _resolveBeforeBindingCount;

        internal ConcurrentQueue<string> Resolved { get; } = new();

        internal ConcurrentQueue<string> Bound { get; } = new();

        internal int ResolveBeforeBindingCount =>
            Volatile.Read(ref _resolveBeforeBindingCount);

        public AddinSessionRouter.SessionHandle? Resolve(string rsid)
        {
            Resolved.Enqueue(rsid);
            if (!_bound.ContainsKey(rsid))
            {
                Interlocked.Increment(ref _resolveBeforeBindingCount);
            }

            return null;
        }

        public bool TryBindRegisteredSession(string rsid, string localSessionKey)
        {
            if (_bound.TryGetValue(rsid, out string? existing))
            {
                return string.Equals(
                    existing,
                    localSessionKey,
                    StringComparison.Ordinal);
            }

            if (_bound.TryAdd(rsid, localSessionKey))
            {
                Bound.Enqueue(rsid);
                return true;
            }

            return false;
        }
    }

    private sealed class RecordingRouteBinder : IRbpSessionRouteBinder
    {
        private int _passCount;

        internal ConcurrentQueue<string> Bound { get; } = new();

        internal int PassCount => Volatile.Read(ref _passCount);

        public Task BindAsync(
            IReadOnlyList<string> rsids,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Interlocked.Increment(ref _passCount);
            foreach (string rsid in rsids)
            {
                Bound.Enqueue(rsid);
            }

            return Task.CompletedTask;
        }
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
}
