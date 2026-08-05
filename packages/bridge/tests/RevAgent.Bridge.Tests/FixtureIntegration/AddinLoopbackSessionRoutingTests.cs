using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;

namespace RevAgent.Bridge.Tests.FixtureIntegration;

/// <summary>
/// P3-T3 acceptance, clause 3: "two sessions on distinct scanned ports are
/// independently routable" — two real O1-T3 fixtures inside the frozen
/// 8080-8085 window, both discovered by the bounded scan and both routed
/// through the real session router and TCP transport.
/// </summary>
[Collection(AddinLoopbackFixtureCollection.Name)]
public sealed class AddinLoopbackSessionRoutingTests
{
    [Fact]
    public async Task TwoScannedSessionsAreIndependentlyRoutableWithoutCrossTalk()
    {
        await using AddinLoopbackFrozenPortLease portLease =
            await AddinLoopbackFrozenPortLease.AcquireAsync();
        List<int> window = Enumerable
            .Range(
                AddinDiscovery.ScanStartPort,
                AddinDiscovery.ScanEndPort - AddinDiscovery.ScanStartPort + 1)
            .ToList();

        await using AddinLoopbackFixtureProcess first =
            await AddinLoopbackFixtureProcess.StartOnFirstFreePortAsync(window);
        await using AddinLoopbackFixtureProcess second =
            await AddinLoopbackFixtureProcess.StartOnFirstFreePortAsync(
                window.Where(port => port != first.Port).ToList());

        Assert.NotEqual(first.Port, second.Port);
        Assert.NotEqual(first.ProcessId, second.ProcessId);

        var attestor = new FixtureProcessAttestor(first, second);
        var transport = new FixtureAttestationTransport(attestor);
        var discovery = new AddinDiscovery(transport, attestor);
        var router = new AddinSessionRouter(transport);

        AddinSessionRouter.RefreshTicket ticket = router.BeginRefresh();
        AddinDiscoveryResult snapshot = await discovery.DiscoverAsync(
            FixtureBridgeConfiguration.BoundedScan(),
            TimeSpan.FromSeconds(3));

        Assert.Equal(AddinDiscoverySource.BoundedScan, snapshot.Evidence.Source);
        Assert.Equal(6, snapshot.Evidence.ProbedTargets.Count);
        Assert.Equal(2, snapshot.Sessions.Count);

        ProbedAddinSession firstSession = SessionFor(snapshot, first.Port);
        ProbedAddinSession secondSession = SessionFor(snapshot, second.Port);
        Assert.Equal(first.ProcessId, firstSession.Status.Revit.ProcessId);
        Assert.Equal(second.ProcessId, secondSession.Status.Revit.ProcessId);
        Assert.NotEqual(
            firstSession.LocalSessionKey,
            secondSession.LocalSessionKey);

        AddinSessionRouter.ReconciliationResult reconciled =
            router.Reconcile(ticket, snapshot);
        Assert.Equal(2, reconciled.AvailableSessions.Count);
        Assert.Equal(2, router.GetAvailableSessions().Count);

        AddinSessionRouter.SessionRoute firstRoute =
            RouteFor(reconciled, first.Port);
        AddinSessionRouter.SessionRoute secondRoute =
            RouteFor(reconciled, second.Port);

        const string firstInvocationId = "m3-route-first";
        const string secondInvocationId = "m3-route-second";

        AddinSessionRouter.InvocationLease firstLease = await router.InvokeAsync(
            firstRoute.Handle,
            new AddinCall(
                firstInvocationId,
                "get_current_view_elements",
                new JObject(),
                TimeSpan.FromSeconds(10)));
        AddinCallResult firstResult = firstLease.GetResult();
        firstLease.ReleaseAfterDurableDecision();

        AddinSessionRouter.InvocationLease secondLease = await router.InvokeAsync(
            secondRoute.Handle,
            new AddinCall(
                secondInvocationId,
                "inspect_levels",
                new JObject(),
                TimeSpan.FromSeconds(10)));
        AddinCallResult secondResult = secondLease.GetResult();
        secondLease.ReleaseAfterDurableDecision();

        Assert.True(firstResult.Response.IsSuccess);
        Assert.Equal(firstInvocationId, firstResult.Response.Id);
        Assert.True(secondResult.Response.IsSuccess);
        Assert.Equal(secondInvocationId, secondResult.Response.Id);

        FixtureEvidence firstEvidence = await first.SnapshotEvidenceAsync();
        FixtureEvidence secondEvidence = await second.SnapshotEvidenceAsync();

        // Each fixture executed only its own invocation. Nothing crossed.
        Assert.Equal(1, firstEvidence.ExecutionCount(firstInvocationId));
        Assert.Equal(0, firstEvidence.ExecutionCount(secondInvocationId));
        Assert.Equal(1, firstEvidence.MethodExecutionCount("get_current_view_elements"));
        Assert.Equal(0, firstEvidence.MethodExecutionCount("inspect_levels"));

        Assert.Equal(1, secondEvidence.ExecutionCount(secondInvocationId));
        Assert.Equal(0, secondEvidence.ExecutionCount(firstInvocationId));
        Assert.Equal(1, secondEvidence.MethodExecutionCount("inspect_levels"));
        Assert.Equal(0, secondEvidence.MethodExecutionCount("get_current_view_elements"));

        // Each fixture saw exactly one bounded-scan mcp_status probe and no
        // status traffic from either data-plane invocation.
        Assert.Equal(1, firstEvidence.MethodExecutionCount("mcp_status"));
        Assert.Equal(1, secondEvidence.MethodExecutionCount("mcp_status"));
    }

    [Fact]
    public async Task ARetiredSessionStopsRoutingWhileTheSurvivorKeepsWorking()
    {
        await using AddinLoopbackFrozenPortLease portLease =
            await AddinLoopbackFrozenPortLease.AcquireAsync();
        List<int> window = Enumerable
            .Range(
                AddinDiscovery.ScanStartPort,
                AddinDiscovery.ScanEndPort - AddinDiscovery.ScanStartPort + 1)
            .ToList();

        await using AddinLoopbackFixtureProcess survivor =
            await AddinLoopbackFixtureProcess.StartOnFirstFreePortAsync(window);
        await using AddinLoopbackFixtureProcess retired =
            await AddinLoopbackFixtureProcess.StartOnFirstFreePortAsync(
                window.Where(port => port != survivor.Port).ToList());

        var attestor = new FixtureProcessAttestor(survivor, retired);
        var transport = new FixtureAttestationTransport(attestor);
        var discovery = new AddinDiscovery(transport, attestor);
        var router = new AddinSessionRouter(transport);

        AddinSessionRouter.RefreshTicket firstTicket = router.BeginRefresh();
        AddinSessionRouter.ReconciliationResult firstPass = router.Reconcile(
            firstTicket,
            await discovery.DiscoverAsync(
                FixtureBridgeConfiguration.BoundedScan(),
                TimeSpan.FromSeconds(3)));
        Assert.Equal(2, firstPass.AvailableSessions.Count);
        AddinSessionRouter.SessionRoute retiredRoute =
            RouteFor(firstPass, retired.Port);

        await retired.DisposeAsync();

        AddinSessionRouter.RefreshTicket secondTicket = router.BeginRefresh();
        AddinSessionRouter.ReconciliationResult secondPass = router.Reconcile(
            secondTicket,
            await discovery.DiscoverAsync(
                FixtureBridgeConfiguration.BoundedScan(),
                TimeSpan.FromSeconds(3)));

        AddinSessionRouter.SessionRoute survivorRoute =
            Assert.Single(secondPass.AvailableSessions);
        Assert.Equal(survivor.Port, survivorRoute.Session.Target.Port);

        AddinSessionRouter.RouteException routeFailure =
            await Assert.ThrowsAsync<AddinSessionRouter.RouteException>(
                () => router.InvokeAsync(
                    retiredRoute.Handle,
                    new AddinCall(
                        "m3-route-retired",
                        "get_ui_state",
                        new JObject(),
                        TimeSpan.FromSeconds(5))));
        Assert.Equal("addin_session_unavailable", routeFailure.Code);

        AddinSessionRouter.InvocationLease lease = await router.InvokeAsync(
            survivorRoute.Handle,
            new AddinCall(
                "m3-route-survivor",
                "get_ui_state",
                new JObject(),
                TimeSpan.FromSeconds(10)));
        AddinCallResult result = lease.GetResult();
        lease.ReleaseAfterDurableDecision();
        Assert.True(result.Response.IsSuccess);
        Assert.Equal("m3-route-survivor", result.Response.Id);
    }

    [Fact]
    public async Task RetiredFixtureAttestationCannotReachAReplacementOnTheSamePort()
    {
        await using AddinLoopbackFrozenPortLease portLease =
            await AddinLoopbackFrozenPortLease.AcquireAsync();
        List<int> window = Enumerable
            .Range(
                AddinDiscovery.ScanStartPort,
                AddinDiscovery.ScanEndPort - AddinDiscovery.ScanStartPort + 1)
            .ToList();

        await using AddinLoopbackFixtureProcess retired =
            await AddinLoopbackFixtureProcess.StartOnFirstFreePortAsync(window);
        int reusedPort = retired.Port;
        var attestor = new FixtureProcessAttestor(retired);
        var transport = new FixtureAttestationTransport(attestor);
        var discovery = new AddinDiscovery(transport, attestor);

        await retired.DisposeAsync();
        await using AddinLoopbackFixtureProcess replacement =
            await AddinLoopbackFixtureProcess.StartAsync(reusedPort);

        AddinDiscoveryResult snapshot = await discovery.DiscoverAsync(
            FixtureBridgeConfiguration.ExplicitPortOverride(reusedPort),
            TimeSpan.FromSeconds(3));

        Assert.Empty(snapshot.Sessions);
        AddinDiscoveryRejection rejection =
            Assert.Single(snapshot.Evidence.RejectedTargets);
        Assert.Equal(
            AddinDiscoveryFailureKind.ProcessAttestationFailure,
            rejection.Kind);
        Assert.Equal("addin_process_attestation_invalid", rejection.Code);

        FixtureEvidence replacementEvidence =
            await replacement.SnapshotEvidenceAsync();
        Assert.Equal(
            0,
            replacementEvidence.MethodExecutionCount("mcp_status"));
    }

    private static ProbedAddinSession SessionFor(
        AddinDiscoveryResult snapshot,
        int port)
    {
        List<ProbedAddinSession> matches = snapshot.Sessions
            .Where(session => session.Target.Port == port)
            .ToList();
        return Assert.Single(matches);
    }

    private static AddinSessionRouter.SessionRoute RouteFor(
        AddinSessionRouter.ReconciliationResult reconciled,
        int port)
    {
        List<AddinSessionRouter.SessionRoute> matches = reconciled
            .AvailableSessions
            .Where(route => route.Session.Target.Port == port)
            .ToList();
        return Assert.Single(matches);
    }
}
