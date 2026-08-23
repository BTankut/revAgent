using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Contracts.AddinLoopback;

namespace RevAgent.Bridge.Tests.AddinLoopback;

public sealed class AddinSessionRouterTests
{
    private const long TestProcessStartFileTime = 133_000_000_000_000_000;

    [Fact]
    public void InvocationLeaseHasNoAutomaticDisposeEscapeHatch()
    {
        Assert.DoesNotContain(
            typeof(IDisposable),
            typeof(AddinSessionRouter.InvocationLease).GetInterfaces());
        Assert.DoesNotContain(
            typeof(IAsyncDisposable),
            typeof(AddinSessionRouter.InvocationLease).GetInterfaces());
        Assert.Null(
            typeof(AddinSessionRouter.InvocationLease).GetMethod(
                "Finalize",
                System.Reflection.BindingFlags.Instance |
                System.Reflection.BindingFlags.NonPublic |
                System.Reflection.BindingFlags.DeclaredOnly));
    }

    [Fact]
    public void Reconcile_DuplicateProcessFailsAtomically()
    {
        var transport = new RecordingTransport((_, call, _, _) =>
            Task.FromResult(Success(call)));
        var router = new AddinSessionRouter(transport);
        AddinSessionRouter.ReconciliationResult initial = ReconcileFresh(
            router,
            Snapshot(Session(8080, 1001)));
        AddinSessionRouter.SessionRoute initialRoute =
            Assert.Single(initial.AvailableSessions);

        AddinSessionRouter.SnapshotException error = Assert.Throws<
            AddinSessionRouter.SnapshotException>(() =>
                ReconcileFresh(
                    router,
                    Snapshot(
                        Session(8080, 1001),
                        Session(8081, 1001))));

        Assert.Equal("duplicate_revit_process_identity", error.Code);
        AddinSessionRouter.SessionRoute current =
            Assert.Single(router.GetAvailableSessions());
        Assert.Same(initialRoute.Handle, current.Handle);
        Assert.Equal(8080, current.Session.Target.Port);
        Assert.Empty(transport.Calls);
    }

    [Fact]
    public void Reconcile_DuplicateProcessRejectionEvidenceFailsAtomically()
    {
        var router = new AddinSessionRouter(
            new RecordingTransport((_, call, _, _) =>
                Task.FromResult(Success(call))));
        AddinSessionRouter.SessionRoute initial = Assert.Single(
            ReconcileFresh(
                router,
                Snapshot(Session(8080, 1005)))
                .AvailableSessions);
        AddinDiscoveryResult duplicateEvidence =
            Snapshot(Session(8080, 1005));
        AddinDiscoveryRejection[] rejections = duplicateEvidence
            .Evidence
            .RejectedTargets
            .Select(rejection =>
                rejection.Target.Port == 8081
                    ? rejection with
                    {
                        Kind =
                            AddinDiscoveryFailureKind
                                .DuplicateProcessIdentity,
                        Code = "duplicate_revit_process_identity",
                    }
                    : rejection)
            .ToArray();
        duplicateEvidence = duplicateEvidence with
        {
            Evidence = duplicateEvidence.Evidence with
            {
                RejectedTargets = rejections,
            },
        };

        AddinSessionRouter.SnapshotException rejected = Assert.Throws<
            AddinSessionRouter.SnapshotException>(() =>
                ReconcileFresh(router, duplicateEvidence));

        Assert.Equal("duplicate_revit_process_identity", rejected.Code);
        AddinSessionRouter.SessionRoute retained =
            Assert.Single(router.GetAvailableSessions());
        Assert.Same(initial.Handle, retained.Handle);
    }

    [Fact]
    public void Reconcile_AmbiguousStableSlotMappingFailsAtomically()
    {
        var transport = new RecordingTransport((_, call, _, _) =>
            Task.FromResult(Success(call)));
        var router = new AddinSessionRouter(transport);
        AddinSessionRouter.SessionRoute initial = Assert.Single(
            ReconcileFresh(
                router,
                Snapshot(Session(8080, 1010)))
                .AvailableSessions);

        AddinSessionRouter.SnapshotException error = Assert.Throws<
            AddinSessionRouter.SnapshotException>(() =>
                ReconcileFresh(
                    router,
                    Snapshot(
                        Session(8080, 1011),
                        Session(8081, 1010))));

        Assert.Equal("ambiguous_addin_session_replacement", error.Code);
        AddinSessionRouter.SessionRoute current =
            Assert.Single(router.GetAvailableSessions());
        Assert.Same(initial.Handle, current.Handle);
        Assert.Equal(1010, current.Session.Status.Revit.ProcessId);
        Assert.Empty(transport.Calls);
    }

    [Fact]
    public void Reconcile_IdenticalRegistrationShapeIsOrderedAndIdempotent()
    {
        var router = new AddinSessionRouter(
            new RecordingTransport((_, call, _, _) =>
                Task.FromResult(Success(call))));
        AddinSessionRouter.ReconciliationResult initial = ReconcileFresh(
            router,
            Snapshot(
                Session(8082, 1002),
                Session(8080, 1000)));

        Assert.Equal(
            new[] { 8080, 8082 },
            initial.AvailableSessions.Select(route => route.Session.Target.Port));
        Assert.Equal(
            new[]
            {
                LocalSessionKey(8080, 1000),
                LocalSessionKey(8082, 1002),
            },
            initial.AvailableSessions.Select(
                route => route.Handle.LocalSessionKey));
        Assert.All(
            initial.Changes,
            change => Assert.Equal(
                AddinSessionRouter.LifecycleChangeKind.Added,
                change.Kind));
        Dictionary<int, AddinSessionRouter.SessionHandle> originalHandles =
            initial.AvailableSessions.ToDictionary(
                route => route.Session.Target.Port,
                route => route.Handle);

        AddinSessionRouter.ReconciliationResult refreshed = ReconcileFresh(
            router,
            Snapshot(
                Session(8082, 1002, planMarker: "two"),
                Session(8080, 1000, planMarker: "zero")));

        Assert.Empty(refreshed.Changes);
        Assert.Equal(
            new[] { 8080, 8082 },
            refreshed.AvailableSessions.Select(
                route => route.Session.Target.Port));
        Assert.All(
            refreshed.AvailableSessions,
            route => Assert.Same(
                originalHandles[route.Session.Target.Port],
                route.Handle));
        Assert.Equal(
            new[] { "zero", "two" },
            refreshed.AvailableSessions.Select(
                route => Assert.Single(
                    route.Session.Status.Plan.Completed)));
    }

    [Fact]
    public void Reconcile_RejectsAnOutOfOrderCompletedRefresh()
    {
        var router = new AddinSessionRouter(
            new RecordingTransport((_, call, _, _) =>
                Task.FromResult(Success(call))));
        AddinSessionRouter.SessionRoute original = Assert.Single(
            ReconcileFresh(
                router,
                Snapshot(Session(8080, 1050)))
                .AvailableSessions);
        AddinSessionRouter.RefreshTicket stale = router.BeginRefresh();
        AddinSessionRouter.RefreshTicket current = router.BeginRefresh();
        Assert.True(current.Generation > stale.Generation);

        AddinSessionRouter.ReconciliationResult replacement =
            router.Reconcile(
                current,
                Snapshot(
                    Session(
                        8080,
                        1051,
                        addinVersion: "2026.07.26.2")));
        AddinSessionRouter.SessionRoute currentRoute =
            Assert.Single(replacement.AvailableSessions);

        AddinSessionRouter.SnapshotException rejected = Assert.Throws<
            AddinSessionRouter.SnapshotException>(() =>
                router.Reconcile(
                    stale,
                    Snapshot(Session(8080, 1050))));

        Assert.Equal("stale_addin_session_snapshot", rejected.Code);
        Assert.Equal(current.Generation, replacement.RefreshGeneration);
        AddinSessionRouter.SnapshotException replayed = Assert.Throws<
            AddinSessionRouter.SnapshotException>(() =>
                router.Reconcile(
                    current,
                    Snapshot(Session(8080, 1051))));
        Assert.Equal("stale_addin_session_snapshot", replayed.Code);
        Assert.NotSame(original.Handle, currentRoute.Handle);
        AddinSessionRouter.SessionRoute retained =
            Assert.Single(router.GetAvailableSessions());
        Assert.Same(currentRoute.Handle, retained.Handle);
        Assert.Equal(1051, retained.Session.Status.Revit.ProcessId);
    }

    [Fact]
    public void Reconcile_RejectsAnIncompleteEvidencePartitionAtomically()
    {
        var router = new AddinSessionRouter(
            new RecordingTransport((_, call, _, _) =>
                Task.FromResult(Success(call))));
        AddinSessionRouter.SessionRoute original = Assert.Single(
            ReconcileFresh(
                router,
                Snapshot(Session(8080, 1060)))
                .AvailableSessions);
        AddinDiscoveryResult incomplete = Snapshot();
        incomplete = incomplete with
        {
            Evidence = incomplete.Evidence with
            {
                RejectedTargets = incomplete
                    .Evidence
                    .RejectedTargets
                    .Where(rejection => rejection.Target.Port != 8085)
                    .ToArray(),
            },
        };
        AddinSessionRouter.RefreshTicket refresh = router.BeginRefresh();

        AddinSessionRouter.SnapshotException rejected = Assert.Throws<
            AddinSessionRouter.SnapshotException>(() =>
                router.Reconcile(refresh, incomplete));

        Assert.Equal(
            "addin_session_snapshot_partition_invalid",
            rejected.Code);
        AddinSessionRouter.SessionRoute retained =
            Assert.Single(router.GetAvailableSessions());
        Assert.Same(original.Handle, retained.Handle);
    }

    [Fact]
    public async Task Reconcile_MissingSessionIsUnavailableAndReappearanceRotatesHandle()
    {
        var transport = new RecordingTransport((_, call, _, _) =>
            Task.FromResult(Success(call)));
        var router = new AddinSessionRouter(transport);
        AddinSessionRouter.SessionRoute first = Assert.Single(
            ReconcileFresh(
                router,
                Snapshot(Session(8080, 1100)))
                .AvailableSessions);

        AddinSessionRouter.ReconciliationResult missing =
            ReconcileFresh(router, Snapshot());

        Assert.Empty(missing.AvailableSessions);
        AddinSessionRouter.LifecycleChange unavailable =
            Assert.Single(missing.Changes);
        Assert.Equal(
            AddinSessionRouter.LifecycleChangeKind.Unavailable,
            unavailable.Kind);
        Assert.Same(first.Handle, unavailable.Previous!.Handle);
        Assert.Null(unavailable.Current);

        AddinSessionRouter.RouteException unavailableError =
            await Assert.ThrowsAsync<AddinSessionRouter.RouteException>(
                () => router.InvokeAsync(
                    first.Handle,
                    Call("missing-session")));
        Assert.Equal(
            AddinSessionRouter.RouteFailureKind.Unavailable,
            unavailableError.Kind);
        Assert.Empty(transport.Calls);

        AddinSessionRouter.ReconciliationResult reappeared =
            ReconcileFresh(router, Snapshot(Session(8080, 1100)));
        AddinSessionRouter.LifecycleChange restored =
            Assert.Single(reappeared.Changes);
        AddinSessionRouter.SessionRoute restoredRoute =
            Assert.Single(reappeared.AvailableSessions);

        Assert.Equal(
            AddinSessionRouter.LifecycleChangeKind.Reappeared,
            restored.Kind);
        Assert.Same(first.Handle, restored.Previous!.Handle);
        Assert.Same(restoredRoute.Handle, restored.Current!.Handle);
        Assert.Equal(
            first.Handle.Generation + 1,
            restoredRoute.Handle.Generation);

        AddinSessionRouter.RouteException staleError =
            await Assert.ThrowsAsync<AddinSessionRouter.RouteException>(
                () => router.InvokeAsync(
                    first.Handle,
                    Call("stale-after-reappear")));
        Assert.Equal(
            AddinSessionRouter.RouteFailureKind.StaleHandle,
            staleError.Kind);

        AddinCallResult result = await InvokeAndCompleteAsync(
            router,
            restoredRoute.Handle,
            Call("restored-session"));
        Assert.True(result.Response.IsSuccess);
        Assert.Single(transport.Calls);
    }

    [Fact]
    public async Task InvokeAsync_RejectsSecondSameSessionBeforeFirstCompletes()
    {
        var entered = Signal();
        var release = Signal();
        var transport = new RecordingTransport(
            async (_, call, _, _) =>
            {
                entered.TrySetResult();
                await release.Task.ConfigureAwait(false);
                return Success(call);
            });
        var router = new AddinSessionRouter(transport);
        AddinSessionRouter.SessionRoute route = Assert.Single(
            ReconcileFresh(
                router,
                Snapshot(Session(8080, 1200)))
                .AvailableSessions);

        Task<AddinSessionRouter.InvocationLease> first = router.InvokeAsync(
            route.Handle,
            Call("first"));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));

        Task<AddinSessionRouter.InvocationLease> second =
            router.InvokeAsync(
                route.Handle,
                Call("second"));

        Assert.True(second.IsCompleted);
        AddinSessionRouter.RouteException error =
            await Assert.ThrowsAsync<AddinSessionRouter.RouteException>(
                () => second);
        Assert.Equal(
            AddinSessionRouter.RouteFailureKind.InvocationInFlight,
            error.Kind);
        Assert.Equal("same_session_invocation_inflight", error.Code);
        Assert.True(error.IsTerminalProtocolFault);
        Assert.Equal("protocol", error.FaultClass);
        Assert.False(error.Retryable);
        Assert.Equal("known", error.Outcome);
        Assert.False(error.VerificationRequired);
        Assert.Equal(
            AddinDispatchState.NotStarted,
            error.Evidence.DispatchState);
        Assert.Equal(0, error.Evidence.BytesWrittenLowerBound);
        Assert.False(error.Evidence.RequestFullyWritten);
        Assert.Single(transport.Calls);

        release.TrySetResult();
        AddinSessionRouter.InvocationLease firstLease = await first;
        Assert.True(firstLease.GetResult().Response.IsSuccess);
        Assert.False(firstLease.IsReleased);

        AddinSessionRouter.RouteException beforeDurableTerminal =
            await Assert.ThrowsAsync<AddinSessionRouter.RouteException>(
                () => router.InvokeAsync(
                    route.Handle,
                    Call("before-durable-terminal")));
        Assert.Equal(
            AddinSessionRouter.RouteFailureKind.InvocationInFlight,
            beforeDurableTerminal.Kind);
        Assert.Single(transport.Calls);

        firstLease.ReleaseAfterDurableDecision();
        Assert.True(firstLease.IsReleased);
        AddinSessionRouter.InvocationLease afterTerminal =
            await router.InvokeAsync(
                route.Handle,
                Call("after-durable-terminal"));
        Assert.True(afterTerminal.GetResult().Response.IsSuccess);
        afterTerminal.ReleaseAfterDurableDecision();
        afterTerminal.ReleaseAfterDurableDecision();
        Assert.True(afterTerminal.IsReleased);
        Assert.Equal(2, transport.Calls.Count);
    }

    [Fact]
    public async Task Reconcile_ReplacementKeepsTheInFlightDefenseGate()
    {
        var entered = Signal();
        var release = Signal();
        var transport = new RecordingTransport(
            async (_, call, _, _) =>
            {
                entered.TrySetResult();
                await release.Task.ConfigureAwait(false);
                return Success(call);
            });
        var router = new AddinSessionRouter(transport);
        AddinSessionRouter.SessionRoute original = Assert.Single(
            ReconcileFresh(
                router,
                Snapshot(Session(8080, 1300)))
                .AvailableSessions);
        Task<AddinSessionRouter.InvocationLease> first =
            router.InvokeAsync(
                original.Handle,
                Call("original"));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));

        AddinSessionRouter.ReconciliationResult replacement =
            ReconcileFresh(
                router,
                Snapshot(
                    Session(
                        8080,
                        1301,
                        addinVersion: "2026.07.26.1")));
        AddinSessionRouter.LifecycleChange change =
            Assert.Single(replacement.Changes);
        AddinSessionRouter.SessionRoute current =
            Assert.Single(replacement.AvailableSessions);

        Assert.Equal(
            AddinSessionRouter.LifecycleChangeKind.Replaced,
            change.Kind);
        Assert.Same(original.Handle, change.Previous!.Handle);
        Assert.Same(current.Handle, change.Current!.Handle);
        Assert.Equal(
            original.Handle.Generation + 1,
            current.Handle.Generation);
        Assert.Equal(
            LocalSessionKey(8080, 1300),
            original.Handle.LocalSessionKey);
        Assert.Equal(
            LocalSessionKey(8080, 1301),
            current.Handle.LocalSessionKey);

        Task<AddinSessionRouter.InvocationLease> whileOriginalRuns =
            router.InvokeAsync(
                current.Handle,
                Call("replacement-overlap"));
        Assert.True(whileOriginalRuns.IsCompleted);
        AddinSessionRouter.RouteException overlap =
            await Assert.ThrowsAsync<AddinSessionRouter.RouteException>(
                () => whileOriginalRuns);
        Assert.Equal(
            AddinSessionRouter.RouteFailureKind.InvocationInFlight,
            overlap.Kind);
        Assert.Single(transport.Calls);

        release.TrySetResult();
        AddinSessionRouter.InvocationLease originalLease = await first;
        Assert.True(originalLease.GetResult().Response.IsSuccess);
        AddinSessionRouter.RouteException beforeOriginalTerminal =
            await Assert.ThrowsAsync<AddinSessionRouter.RouteException>(
                () => router.InvokeAsync(
                    current.Handle,
                    Call("replacement-before-durable-terminal")));
        Assert.Equal(
            AddinSessionRouter.RouteFailureKind.InvocationInFlight,
            beforeOriginalTerminal.Kind);

        originalLease.ReleaseAfterDurableDecision();
        Assert.True(
            (await InvokeAndCompleteAsync(
                router,
                current.Handle,
                Call("replacement-after-terminal"))).Response.IsSuccess);
        Assert.Equal(2, transport.Calls.Count);

        ReconcileFresh(router, Snapshot());
        AddinSessionRouter.RouteException staleAfterMissing =
            await Assert.ThrowsAsync<AddinSessionRouter.RouteException>(
                () => router.InvokeAsync(
                    original.Handle,
                    Call("old-generation-after-missing")));
        Assert.Equal(
            AddinSessionRouter.RouteFailureKind.StaleHandle,
            staleAfterMissing.Kind);
        AddinSessionRouter.RouteException currentUnavailable =
            await Assert.ThrowsAsync<AddinSessionRouter.RouteException>(
                () => router.InvokeAsync(
                    current.Handle,
                    Call("current-generation-missing")));
        Assert.Equal(
            AddinSessionRouter.RouteFailureKind.Unavailable,
            currentUnavailable.Kind);
        Assert.Equal(2, transport.Calls.Count);
    }

    [Fact]
    public void Reconcile_SameEndpointAndPidWithNewProcessStartReplacesHandle()
    {
        var router = new AddinSessionRouter(
            new RecordingTransport((_, call, _, _) =>
                Task.FromResult(Success(call))));
        AddinSessionRouter.SessionRoute original = Assert.Single(
            ReconcileFresh(
                router,
                Snapshot(
                    Session(
                        8080,
                        1350,
                        processStartFileTimeUtc:
                            TestProcessStartFileTime + 1350)))
                .AvailableSessions);

        AddinSessionRouter.ReconciliationResult replacement =
            ReconcileFresh(
                router,
                Snapshot(
                    Session(
                        8080,
                        1350,
                        processStartFileTimeUtc:
                            TestProcessStartFileTime + 2350)));

        AddinSessionRouter.LifecycleChange change =
            Assert.Single(replacement.Changes);
        AddinSessionRouter.SessionRoute current =
            Assert.Single(replacement.AvailableSessions);
        Assert.Equal(
            AddinSessionRouter.LifecycleChangeKind.Replaced,
            change.Kind);
        Assert.Equal(
            original.Handle.Generation + 1,
            current.Handle.Generation);
        Assert.NotEqual(
            original.Handle.LocalSessionKey,
            current.Handle.LocalSessionKey);
        Assert.Same(original.Handle, change.Previous!.Handle);
        Assert.Same(current.Handle, change.Current!.Handle);
    }

    [Fact]
    public async Task InvokeAsync_PinsTheDiscoveredProcessIdentity()
    {
        var transport = new RecordingTransport((_, call, _, _) =>
            Task.FromResult(Success(call)));
        var router = new AddinSessionRouter(transport);
        AddinSessionRouter.SessionRoute route = Assert.Single(
            ReconcileFresh(
                router,
                Snapshot(Session(8080, 1360)))
                .AvailableSessions);

        AddinCallResult result = await InvokeAndCompleteAsync(
            router,
            route.Handle,
            Call("pinned-process"));

        Assert.True(result.Response.IsSuccess);
        ObservedCall observation = Assert.Single(transport.Calls);
        Assert.Equal(
            route.Session.ProcessAttestation.Identity,
            observation.ExpectedProcessIdentity);
    }

    [Fact]
    public async Task InvokeAsync_UsesInjectedAttestorAndPreservesDiscoveredIdentity()
    {
        ProbedAddinSession session = Session(8080, 1365);
        var attestor = new RecordingProcessAttestor(
            session.ProcessAttestation);
        var transport = new RecordingTransport(
            (_, call, _, _) => Task.FromResult(Success(call)),
            executeProcessAttestation: true);
        var router = new AddinSessionRouter(transport, attestor);
        AddinSessionRouter.SessionRoute route = Assert.Single(
            ReconcileFresh(router, Snapshot(session)).AvailableSessions);

        AddinCallResult result = await InvokeAndCompleteAsync(
            router,
            route.Handle,
            Call("injected-attestor"));

        Assert.True(result.Response.IsSuccess);
        Assert.Equal(1, attestor.BeforeDispatchCount);
        Assert.Equal(1, attestor.AfterResponseCount);
        Assert.Equal(1, transport.HandlerInvocationCount);
        Assert.Equal(
            route.Session.ProcessAttestation.Identity,
            Assert.Single(transport.Calls).ExpectedProcessIdentity);
    }

    [Fact]
    public async Task InvokeAsync_InjectedAttestorDenialPreventsTransportDispatch()
    {
        ProbedAddinSession session = Session(8080, 1366);
        var attestor = new RecordingProcessAttestor(
            session.ProcessAttestation,
            denyBeforeDispatch: true);
        var transport = new RecordingTransport(
            (_, call, _, _) => Task.FromResult(Success(call)),
            executeProcessAttestation: true);
        var router = new AddinSessionRouter(transport, attestor);
        AddinSessionRouter.SessionRoute route = Assert.Single(
            ReconcileFresh(router, Snapshot(session)).AvailableSessions);

        AddinSessionRouter.InvocationLease lease = await router.InvokeAsync(
            route.Handle,
            Call("injected-attestor-denied"));
        try
        {
            AddinProcessAttestationException failure = Assert.Throws<
                AddinProcessAttestationException>(() => lease.GetResult());
            Assert.Equal("addin_test_attestation_denied", failure.Code);
        }
        finally
        {
            lease.ReleaseAfterDurableDecision();
        }

        Assert.Equal(1, attestor.BeforeDispatchCount);
        Assert.Equal(0, attestor.AfterResponseCount);
        Assert.Equal(0, transport.HandlerInvocationCount);
    }

    [Fact]
    public async Task InvokeAsync_DefaultAttestorRemainsWindowsAttestor()
    {
        var transport = new RecordingTransport((_, call, _, _) =>
            Task.FromResult(Success(call)));
        var router = new AddinSessionRouter(transport);
        AddinSessionRouter.SessionRoute route = Assert.Single(
            ReconcileFresh(router, Snapshot(Session(8080, 1367))).AvailableSessions);

        Assert.True((await InvokeAndCompleteAsync(
            router,
            route.Handle,
            Call("default-attestor"))).Response.IsSuccess);

        ExpectedAddinProcessAttestor expected = Assert.IsType<
            ExpectedAddinProcessAttestor>(
            Assert.Single(transport.ProcessAttestors));
        var field = (IAddinProcessAttestor?)typeof(ExpectedAddinProcessAttestor)
            .GetField("_inner", System.Reflection.BindingFlags.Instance |
                System.Reflection.BindingFlags.NonPublic)
            ?.GetValue(expected);
        Assert.IsType<WindowsAddinProcessAttestor>(field);
    }

    [Fact]
    public async Task InvokeAsync_DifferentSessionsEnterTransportConcurrently()
    {
        var entered = new ConcurrentDictionary<int, TaskCompletionSource>();
        var releases = new ConcurrentDictionary<int, TaskCompletionSource>();
        foreach (int port in new[] { 8080, 8081 })
        {
            entered[port] = Signal();
            releases[port] = Signal();
        }

        var transport = new RecordingTransport(
            async (endpoint, call, _, _) =>
            {
                entered[endpoint.Port].TrySetResult();
                await releases[endpoint.Port].Task.ConfigureAwait(false);
                return Success(call);
            });
        var router = new AddinSessionRouter(transport);
        IReadOnlyList<AddinSessionRouter.SessionRoute> routes =
            ReconcileFresh(
                router,
                Snapshot(
                    Session(8081, 1401),
                    Session(8080, 1400)))
                .AvailableSessions;

        Task<AddinSessionRouter.InvocationLease> first =
            router.InvokeAsync(
                routes[0].Handle,
                Call("session-a"));
        Task<AddinSessionRouter.InvocationLease> second =
            router.InvokeAsync(
                routes[1].Handle,
                Call("session-b"));

        await Task.WhenAll(
                entered[8080].Task,
                entered[8081].Task)
            .WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, transport.Calls.Count);

        releases[8080].TrySetResult();
        releases[8081].TrySetResult();
        AddinSessionRouter.InvocationLease[] leases =
            await Task.WhenAll(first, second);
        Assert.All(
            leases,
            lease => Assert.True(lease.GetResult().Response.IsSuccess));
        foreach (AddinSessionRouter.InvocationLease lease in leases)
        {
            lease.ReleaseAfterDurableDecision();
        }
    }

    [Fact]
    public async Task InvokeAsync_LeaseRequiresDurableCompletionForEveryOutcome()
    {
        int callIndex = 0;
        var transport = new RecordingTransport(
            (_, call, _, _) =>
            {
                return Interlocked.Increment(ref callIndex) switch
                {
                    1 => Task.FromResult(Success(call)),
                    2 => Task.FromException<AddinCallResult>(
                        TransportFailure("addin_transport_io")),
                    3 => Task.FromResult(JsonRpcError(call)),
                    4 => Task.FromException<AddinCallResult>(
                        TransportFailure("addin_call_cancelled")),
                    _ => Task.FromResult(Success(call)),
                };
            });
        var router = new AddinSessionRouter(transport);
        AddinSessionRouter.SessionRoute route = Assert.Single(
            ReconcileFresh(
                router,
                Snapshot(Session(8080, 1500)))
                .AvailableSessions);

        AddinSessionRouter.InvocationLease success =
            await router.InvokeAsync(
                route.Handle,
                Call("success-before-failure"));
        Assert.True(success.GetResult().Response.IsSuccess);
        await AssertInvocationInFlightAsync(router, route.Handle);
        success.ReleaseAfterDurableDecision();

        AddinSessionRouter.InvocationLease transportFailure =
            await router.InvokeAsync(
                route.Handle,
                Call("transport-failure"));
        AddinTransportException transportError = Assert.IsType<
            AddinTransportException>(transportFailure.Failure);
        Assert.Equal("addin_transport_io", transportError.Code);
        await AssertInvocationInFlightAsync(router, route.Handle);
        transportFailure.ReleaseAfterDurableDecision();

        AddinSessionRouter.InvocationLease jsonRpcFailure =
            await router.InvokeAsync(
                route.Handle,
                Call("jsonrpc-error"));
        Assert.False(
            jsonRpcFailure.GetResult().Response.IsSuccess);
        await AssertInvocationInFlightAsync(router, route.Handle);
        jsonRpcFailure.ReleaseAfterDurableDecision();

        AddinSessionRouter.InvocationLease cancelled =
            await router.InvokeAsync(
                route.Handle,
                Call("cancelled"));
        AddinTransportException cancellation = Assert.IsType<
            AddinTransportException>(cancelled.Failure);
        Assert.Equal("addin_call_cancelled", cancellation.Code);
        await AssertInvocationInFlightAsync(router, route.Handle);
        cancelled.ReleaseAfterDurableDecision();

        Assert.True(
            (await InvokeAndCompleteAsync(
                router,
                route.Handle,
                Call("success-after-failures"))).Response.IsSuccess);
        Assert.Equal(5, transport.Calls.Count);
    }

    [Fact]
    public async Task InvokeAsync_PreCancelledLeaseStaysClosedUntilCompletion()
    {
        var transport = new RecordingTransport(
            (_, call, callerCancellation, _) =>
                callerCancellation.IsCancellationRequested
                    ? Task.FromException<AddinCallResult>(
                        TransportFailure("addin_call_cancelled"))
                    : Task.FromResult(Success(call)));
        var router = new AddinSessionRouter(transport);
        AddinSessionRouter.SessionRoute route = Assert.Single(
            ReconcileFresh(
                router,
                Snapshot(Session(8080, 1510)))
                .AvailableSessions);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        AddinSessionRouter.InvocationLease cancelled =
            await router.InvokeAsync(
                route.Handle,
                Call("pre-cancelled"),
                cancellation.Token);

        AddinTransportException failure = Assert.IsType<
            AddinTransportException>(cancelled.Failure);
        Assert.Equal("addin_call_cancelled", failure.Code);
        await AssertInvocationInFlightAsync(router, route.Handle);
        cancelled.ReleaseAfterDurableDecision();
        Assert.True(
            (await InvokeAndCompleteAsync(
                router,
                route.Handle,
                Call("after-pre-cancel"))).Response.IsSuccess);
        Assert.Equal(2, transport.Calls.Count);
    }

    [Fact]
    public async Task InvokeAsync_PostDispatchAbandonmentKeepsOneLease()
    {
        int callIndex = 0;
        var entered = Signal();
        var release = Signal();
        var transport = new RecordingTransport(
            async (_, call, callerCancellation, _) =>
            {
                if (Interlocked.Increment(ref callIndex) == 1)
                {
                    entered.TrySetResult();
                    await release.Task.ConfigureAwait(false);
                    Assert.True(callerCancellation.IsCancellationRequested);
                }

                return Success(call);
            });
        var router = new AddinSessionRouter(transport);
        AddinSessionRouter.SessionRoute route = Assert.Single(
            ReconcileFresh(
                router,
                Snapshot(Session(8080, 1520)))
                .AvailableSessions);
        using var cancellation = new CancellationTokenSource();

        Task<AddinSessionRouter.InvocationLease> pending =
            router.InvokeAsync(
                route.Handle,
                Call("post-dispatch-abandonment"),
                cancellation.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await AssertInvocationInFlightAsync(router, route.Handle);

        release.TrySetResult();
        AddinSessionRouter.InvocationLease completed = await pending;
        Assert.True(completed.GetResult().Response.IsSuccess);
        await AssertInvocationInFlightAsync(router, route.Handle);
        completed.ReleaseAfterDurableDecision();

        Assert.True(
            (await InvokeAndCompleteAsync(
                router,
                route.Handle,
                Call("after-abandonment-outcome"))).Response.IsSuccess);
        Assert.Equal(2, transport.Calls.Count);
    }

    [Fact]
    public async Task InvokeAsync_ShutdownFailureNeedsExplicitCompletion()
    {
        int callIndex = 0;
        var entered = Signal();
        var release = Signal();
        var transport = new RecordingTransport(
            async (_, call, _, shutdown) =>
            {
                if (Interlocked.Increment(ref callIndex) == 1)
                {
                    entered.TrySetResult();
                    await release.Task.ConfigureAwait(false);
                    Assert.True(shutdown.IsCancellationRequested);
                    throw TransportFailure("addin_transport_shutdown");
                }

                return Success(call);
            });
        var router = new AddinSessionRouter(transport);
        AddinSessionRouter.SessionRoute route = Assert.Single(
            ReconcileFresh(
                router,
                Snapshot(Session(8080, 1530)))
                .AvailableSessions);
        using var shutdown = new CancellationTokenSource();
        Task<AddinSessionRouter.InvocationLease> pending =
            router.InvokeAsync(
                route.Handle,
                Call("shutdown"),
                transportShutdownToken: shutdown.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await AssertInvocationInFlightAsync(router, route.Handle);
        shutdown.Cancel();
        release.TrySetResult();

        AddinSessionRouter.InvocationLease stopped = await pending;

        AddinTransportException failure = Assert.IsType<
            AddinTransportException>(stopped.Failure);
        Assert.Equal("addin_transport_shutdown", failure.Code);
        await AssertInvocationInFlightAsync(router, route.Handle);
        stopped.ReleaseAfterDurableDecision();
        Assert.True(
            (await InvokeAndCompleteAsync(
                router,
                route.Handle,
                Call("after-shutdown-decision"))).Response.IsSuccess);
        Assert.Equal(2, transport.Calls.Count);
    }

    [Fact]
    public async Task InvokeAsync_TimeoutFailureNeedsExplicitCompletion()
    {
        int callIndex = 0;
        var entered = Signal();
        var release = Signal();
        var transport = new RecordingTransport(
            async (_, call, _, _) =>
            {
                if (Interlocked.Increment(ref callIndex) == 1)
                {
                    entered.TrySetResult();
                    await release.Task.ConfigureAwait(false);
                    throw TransportFailure(
                        "addin_call_timeout",
                        PossiblyDispatchedEvidence());
                }

                return Success(call);
            });
        var router = new AddinSessionRouter(transport);
        AddinSessionRouter.SessionRoute route = Assert.Single(
            ReconcileFresh(
                router,
                Snapshot(Session(8080, 1540)))
                .AvailableSessions);

        Task<AddinSessionRouter.InvocationLease> pending =
            router.InvokeAsync(
                route.Handle,
                Call("timeout"));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await AssertInvocationInFlightAsync(router, route.Handle);
        release.TrySetResult();

        AddinSessionRouter.InvocationLease timedOut = await pending;

        AddinTransportException failure = Assert.IsType<
            AddinTransportException>(timedOut.Failure);
        Assert.Equal("addin_call_timeout", failure.Code);
        Assert.Equal(
            AddinDispatchState.MayHaveReachedAddin,
            failure.Evidence.DispatchState);
        await AssertInvocationInFlightAsync(router, route.Handle);
        timedOut.ReleaseAfterDurableDecision();
        Assert.True(
            (await InvokeAndCompleteAsync(
                router,
                route.Handle,
                Call("after-timeout-decision"))).Response.IsSuccess);
        Assert.Equal(2, transport.Calls.Count);
    }

    [Fact]
    public async Task DiscoveryThenOrdinaryInvokesEmitNoExtraMcpStatus()
    {
        var transport = new RecordingTransport((endpoint, call, _, _) =>
            Task.FromResult(
                call.Method == "mcp_status"
                    ? Success(
                        call,
                        StatusResult(endpoint.Port, processId: 1600))
                    : Success(call)));
        var router = new AddinSessionRouter(transport);
        var discovery = new AddinDiscovery(
            transport,
            new FixedProcessAttestor(1600));
        AddinSessionRouter.RefreshTicket refresh = router.BeginRefresh();
        AddinDiscoveryResult snapshot = await discovery.DiscoverAsync(
            EnvironmentConfiguration(8080));
        AddinSessionRouter.SessionRoute route = Assert.Single(
            router.Reconcile(refresh, snapshot)
                .AvailableSessions);
        int statusBaseline = transport.Calls.Count(observation =>
            observation.Method == "mcp_status");
        Assert.Equal(1, statusBaseline);

        _ = await InvokeAndCompleteAsync(
            router,
            route.Handle,
            Call("ordinary-1", "get_current_view_info"));
        _ = await InvokeAndCompleteAsync(
            router,
            route.Handle,
            Call("ordinary-2", "list_open_views"));

        Assert.Equal(
            statusBaseline,
            transport.Calls.Count(observation =>
                observation.Method == "mcp_status"));
        Assert.Equal(
            new[]
            {
                "mcp_status",
                "get_current_view_info",
                "list_open_views",
            },
            transport.Calls.Select(observation => observation.Method));
    }

    [Fact]
    public async Task InvokeAsync_ClampsCallsToTheProbedRequestLimit()
    {
        var transport = new RecordingTransport((_, call, _, _) =>
            Task.FromResult(Success(call)));
        var router = new AddinSessionRouter(transport);
        AddinSessionRouter.SessionRoute route = Assert.Single(
            ReconcileFresh(
                router,
                Snapshot(
                    Session(
                        8080,
                        1700,
                        maxRequestPayloadBytes:
                            AddinFrameLimits.MinimumRequestPayloadBytes)))
                .AvailableSessions);
        var call = new AddinCall(
            "probed-cap",
            "fixture_echo",
            new JObject { ["value"] = "hello" },
            TimeSpan.FromSeconds(5),
            AddinFrameLimits.DefaultMaxRequestPayloadBytes);

        Assert.True(
            (await InvokeAndCompleteAsync(
                router,
                route.Handle,
                call)).Response.IsSuccess);

        ObservedCall observed = Assert.Single(transport.Calls);
        Assert.Equal(
            AddinFrameLimits.MinimumRequestPayloadBytes,
            observed.MaxRequestPayloadBytes);
        Assert.Equal(
            AddinFrameLimits.DefaultMaxRequestPayloadBytes,
            call.MaxRequestPayloadBytes);
    }

    private static AddinCall Call(
        string invocationId,
        string method = "fixture_echo") =>
        new(
            invocationId,
            method,
            new JObject { ["value"] = "hello" },
            TimeSpan.FromSeconds(5));

    private static AddinSessionRouter.ReconciliationResult ReconcileFresh(
        AddinSessionRouter router,
        AddinDiscoveryResult snapshot)
    {
        AddinSessionRouter.RefreshTicket refresh = router.BeginRefresh();
        return router.Reconcile(refresh, snapshot);
    }

    private static async Task<AddinCallResult> InvokeAndCompleteAsync(
        AddinSessionRouter router,
        AddinSessionRouter.SessionHandle handle,
        AddinCall call,
        CancellationToken preDispatchCancellationToken = default,
        CancellationToken transportShutdownToken = default)
    {
        AddinSessionRouter.InvocationLease lease =
            await router.InvokeAsync(
                handle,
                call,
                preDispatchCancellationToken,
                transportShutdownToken);
        try
        {
            return lease.GetResult();
        }
        finally
        {
            lease.ReleaseAfterDurableDecision();
        }
    }

    private static async Task AssertInvocationInFlightAsync(
        AddinSessionRouter router,
        AddinSessionRouter.SessionHandle handle)
    {
        AddinSessionRouter.RouteException blocked =
            await Assert.ThrowsAsync<AddinSessionRouter.RouteException>(
                () => router.InvokeAsync(
                    handle,
                    Call("lease-still-active")));
        Assert.Equal(
            AddinSessionRouter.RouteFailureKind.InvocationInFlight,
            blocked.Kind);
        Assert.Equal(
            AddinDispatchState.NotStarted,
            blocked.Evidence.DispatchState);
    }

    private static ProbedAddinSession Session(
        int port,
        long processId,
        string? addinVersion = null,
        string? planMarker = null,
        int? maxRequestPayloadBytes = null,
        long? processStartFileTimeUtc = null)
    {
        JObject scenario = LoadProtocolFixture();
        JObject result = (JObject)RequireObject(
            RequireObject(scenario, "response"),
            "result").DeepClone();
        RequireObject(result, "service")["port"] = port;
        RequireObject(result, "service")["boundAddresses"] =
            new JArray("127.0.0.1");
        RequireObject(result, "revit")["processId"] = processId;
        if (addinVersion != null)
        {
            result["addinVersion"] = addinVersion;
        }

        if (planMarker != null)
        {
            RequireObject(result, "plan")["completed"] =
                new JArray(planMarker);
        }

        if (maxRequestPayloadBytes != null)
        {
            RequireObject(
                RequireObject(result, "service"),
                "framing")["maxRequestPayloadBytes"] =
                maxRequestPayloadBytes.Value;
            RequireObject(
                RequireObject(result, "capabilityContracts"),
                "batch_atomic")["maxRequestPayloadBytes"] =
                maxRequestPayloadBytes.Value;
        }

        AddinStatusSnapshot status = AddinStatusParser.ParseResult(result);
        long startTimeFileTimeUtc =
            processStartFileTimeUtc ??
            TestProcessStartFileTime + processId;
        return new ProbedAddinSession(
            AddinEndpoint.Ipv4Loopback(port),
            LocalSessionKey(
                port,
                processId,
                startTimeFileTimeUtc),
            status,
            new AddinProcessAttestation(
                new AddinProcessIdentity(
                    checked((int)processId),
                    startTimeFileTimeUtc),
                status.Revit.Version,
                @"C:\Program Files\Autodesk\Revit 2026\Revit.exe"));
    }

    private static string LocalSessionKey(
        int port,
        long processId,
        long? processStartFileTimeUtc = null) =>
        "port:" +
        port.ToString(CultureInfo.InvariantCulture) +
        ":pid:" +
        processId.ToString(CultureInfo.InvariantCulture) +
        ":started:" +
        (processStartFileTimeUtc ??
            TestProcessStartFileTime + processId)
        .ToString(CultureInfo.InvariantCulture);

    private static AddinDiscoveryResult Snapshot(
        params ProbedAddinSession[] sessions)
    {
        AddinEndpoint[] accepted = sessions
            .Select(session => session.Target)
            .ToArray();
        AddinEndpoint[] probed = Enumerable
            .Range(
                AddinDiscovery.ScanStartPort,
                AddinDiscovery.ScanEndPort -
                AddinDiscovery.ScanStartPort +
                1)
            .Select(AddinEndpoint.Ipv4Loopback)
            .ToArray();
        var acceptedSet = new HashSet<AddinEndpoint>(accepted);
        AddinDiscoveryRejection[] rejected = probed
            .Where(target => !acceptedSet.Contains(target))
            .Select(target =>
                new AddinDiscoveryRejection(
                    target,
                    AddinDiscoveryFailureKind.Unreachable,
                    "addin_connect_failed",
                    NotStartedEvidence()))
            .ToArray();
        return new AddinDiscoveryResult(
            sessions,
            new AddinDiscoveryEvidence(
                AddinDiscoverySource.BoundedScan,
                probed,
                accepted,
                rejected));
    }

    private static ResolvedBridgeConfiguration EnvironmentConfiguration(
        int port) =>
        new(
            schemaVersion: 1,
            gatewayUri: new Uri("wss://127.0.0.1:4317/rbp"),
            addin: new BridgeAddinConfiguration(port, port),
            logging: new BridgeLoggingConfiguration(1024 * 1024, 3),
            sourceMetadata: new BridgeConfigurationSourceMetadata(
                "bridge.config.json",
                new Dictionary<string, BridgeConfigurationValueSource>(
                    StringComparer.Ordinal)
                {
                    ["addin.scanStartPort"] = new(
                        BridgeConfigurationSourceKind.Environment,
                        BridgeConfigurationLoader
                            .AddinPortEnvironmentVariable),
                    ["addin.scanEndPort"] = new(
                        BridgeConfigurationSourceKind.Environment,
                        BridgeConfigurationLoader
                            .AddinPortEnvironmentVariable),
                }));

    private static JObject StatusResult(int port, long processId)
    {
        JObject scenario = LoadProtocolFixture();
        JObject result = (JObject)RequireObject(
            RequireObject(scenario, "response"),
            "result").DeepClone();
        RequireObject(result, "service")["port"] = port;
        RequireObject(result, "service")["boundAddresses"] =
            new JArray("127.0.0.1");
        RequireObject(result, "revit")["processId"] = processId;
        return result;
    }

    private static AddinCallResult Success(AddinCall call)
    {
        var envelope = new JObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = call.InvocationId,
            ["result"] = new JObject
            {
                ["resultContractVersion"] =
                    AddinJsonRpcCodec.ResultContractVersion,
                ["success"] = true,
            },
        };
        return ParsedResult(call, envelope);
    }

    private static AddinCallResult Success(
        AddinCall call,
        JObject result)
    {
        var envelope = new JObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = call.InvocationId,
            ["result"] = result.DeepClone(),
        };
        return ParsedResult(call, envelope);
    }

    private static AddinCallResult JsonRpcError(AddinCall call)
    {
        var envelope = new JObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = call.InvocationId,
            ["error"] = new JObject
            {
                ["code"] = -32601,
                ["message"] = "Method not found",
            },
        };
        return ParsedResult(call, envelope);
    }

    private static AddinCallResult ParsedResult(
        AddinCall call,
        JObject envelope)
    {
        AddinJsonRpcResponse response = AddinJsonRpcCodec.ParseResponse(
            Encoding.UTF8.GetBytes(envelope.ToString(Formatting.None)),
            call.InvocationId);
        return new AddinCallResult(response, ResponseEvidence());
    }

    private static AddinTransportException TransportFailure(
        string code,
        AddinTransportEvidence? evidence = null) =>
        new(
            code,
            code,
            evidence ?? NotStartedEvidence());

    private static AddinTransportEvidence NotStartedEvidence() =>
        new(
            AddinDispatchState.NotStarted,
            RequestPayloadBytes: 0,
            RequestFrameBytes: 0,
            BytesWrittenLowerBound: 0,
            RequestFullyWritten: false,
            ResponseBytesObserved: 0);

    private static AddinTransportEvidence ResponseEvidence() =>
        new(
            AddinDispatchState.ResponseObserved,
            RequestPayloadBytes: 1,
            RequestFrameBytes: 5,
            BytesWrittenLowerBound: 5,
            RequestFullyWritten: true,
            ResponseBytesObserved: 5);

    private static AddinTransportEvidence PossiblyDispatchedEvidence() =>
        new(
            AddinDispatchState.MayHaveReachedAddin,
            RequestPayloadBytes: 64,
            RequestFrameBytes: 68,
            BytesWrittenLowerBound: 68,
            RequestFullyWritten: true,
            ResponseBytesObserved: 0);

    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static JObject LoadProtocolFixture()
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
        using var jsonReader = new JsonTextReader(textReader)
        {
            DateParseHandling = DateParseHandling.None,
            FloatParseHandling = FloatParseHandling.Decimal,
        };
        return JObject.Load(jsonReader);
    }

    private static string FindRepositoryRoot()
    {
        DirectoryInfo? current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current != null)
        {
            if (File.Exists(Path.Combine(current.FullName, "AGENTS.md")) &&
                Directory.Exists(
                    Path.Combine(current.FullName, "packages", "protocol")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not locate the revAgent repository root.");
    }

    private static JObject RequireObject(JObject parent, string propertyName) =>
        Assert.IsType<JObject>(parent[propertyName]);

    private sealed record ObservedCall(
        AddinEndpoint Endpoint,
        string Method,
        int MaxRequestPayloadBytes,
        AddinProcessIdentity? ExpectedProcessIdentity);

    private sealed class RecordingTransport : IAddinTransport
    {
        private readonly object _sync = new();
        private readonly Func<
            AddinEndpoint,
            AddinCall,
            CancellationToken,
            CancellationToken,
            Task<AddinCallResult>> _handler;
        private readonly List<ObservedCall> _calls = new();
        private readonly List<IAddinProcessAttestor?> _processAttestors = new();
        private readonly bool _executeProcessAttestation;
        private int _handlerInvocationCount;

        internal RecordingTransport(
            Func<
                AddinEndpoint,
                AddinCall,
                CancellationToken,
                CancellationToken,
                Task<AddinCallResult>> handler,
            bool executeProcessAttestation = false)
        {
            _handler = handler;
            _executeProcessAttestation = executeProcessAttestation;
        }

        internal IReadOnlyList<ObservedCall> Calls
        {
            get
            {
                lock (_sync)
                {
                    return _calls.ToArray();
                }
            }
        }

        internal IReadOnlyList<IAddinProcessAttestor?> ProcessAttestors
        {
            get
            {
                lock (_sync)
                {
                    return _processAttestors.ToArray();
                }
            }
        }

        internal int HandlerInvocationCount =>
            Volatile.Read(ref _handlerInvocationCount);

        public async Task<AddinCallResult> InvokeAsync(
            AddinEndpoint endpoint,
            AddinCall call,
            CancellationToken preDispatchCancellationToken = default,
            CancellationToken transportShutdownToken = default,
            IAddinProcessAttestor? processAttestor = null)
        {
            lock (_sync)
            {
                _calls.Add(
                    new ObservedCall(
                        endpoint,
                        call.Method,
                        call.MaxRequestPayloadBytes,
                        (processAttestor as ExpectedAddinProcessAttestor)
                            ?.Expected.Identity));
                _processAttestors.Add(processAttestor);
            }

            var peer = new AddinConnectedPeer(
                new System.Net.IPEndPoint(
                    System.Net.IPAddress.Loopback,
                    50_000 + endpoint.Port % 1_000),
                new System.Net.IPEndPoint(
                    endpoint.Address,
                    endpoint.Port));
            AddinProcessAttestation? attestation = null;
            if (processAttestor is ExpectedAddinProcessAttestor expected &&
                !_executeProcessAttestation)
            {
                attestation = expected.Expected;
            }
            else if (processAttestor != null)
            {
                attestation =
                    await processAttestor.AttestBeforeDispatchAsync(
                        peer,
                        preDispatchCancellationToken);
            }

            Interlocked.Increment(ref _handlerInvocationCount);
            AddinCallResult result = await _handler(
                endpoint,
                call,
                preDispatchCancellationToken,
                transportShutdownToken);
            if (processAttestor == null || attestation == null)
            {
                return result;
            }

            if (processAttestor is not ExpectedAddinProcessAttestor ||
                _executeProcessAttestation)
            {
                await processAttestor.VerifyAfterResponseAsync(
                    peer,
                    attestation,
                    transportShutdownToken);
            }
            return result with
            {
                ProcessAttestation = attestation,
            };
        }
    }

    private sealed class FixedProcessAttestor : IAddinProcessAttestor
    {
        private readonly int _processId;

        internal FixedProcessAttestor(int processId)
        {
            _processId = processId;
        }

        public Task<AddinProcessAttestation> AttestBeforeDispatchAsync(
            AddinConnectedPeer peer,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(
                new AddinProcessAttestation(
                    new AddinProcessIdentity(
                        _processId,
                        TestProcessStartFileTime + _processId),
                    "2026",
                    @"C:\Program Files\Autodesk\Revit 2026\Revit.exe"));
        }

        public Task VerifyAfterResponseAsync(
            AddinConnectedPeer peer,
            AddinProcessAttestation attestation,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.CompletedTask;
        }
    }

    private sealed class RecordingProcessAttestor : IAddinProcessAttestor
    {
        private readonly AddinProcessAttestation _attestation;
        private readonly bool _denyBeforeDispatch;
        private int _beforeDispatchCount;
        private int _afterResponseCount;

        internal RecordingProcessAttestor(
            AddinProcessAttestation attestation,
            bool denyBeforeDispatch = false)
        {
            _attestation = attestation;
            _denyBeforeDispatch = denyBeforeDispatch;
        }

        internal int BeforeDispatchCount => Volatile.Read(ref _beforeDispatchCount);

        internal int AfterResponseCount => Volatile.Read(ref _afterResponseCount);

        public Task<AddinProcessAttestation> AttestBeforeDispatchAsync(
            AddinConnectedPeer peer,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Interlocked.Increment(ref _beforeDispatchCount);
            if (_denyBeforeDispatch)
            {
                throw new AddinProcessAttestationException(
                    "addin_test_attestation_denied",
                    "The test attestor denied pre-dispatch routing.");
            }

            return Task.FromResult(_attestation);
        }

        public Task VerifyAfterResponseAsync(
            AddinConnectedPeer peer,
            AddinProcessAttestation attestation,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Assert.Equal(_attestation, attestation);
            Interlocked.Increment(ref _afterResponseCount);
            return Task.CompletedTask;
        }
    }
}
