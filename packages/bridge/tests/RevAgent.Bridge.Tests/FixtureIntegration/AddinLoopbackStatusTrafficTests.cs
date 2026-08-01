using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Bootstrap.Configuration;
using RevAgent.Contracts.AddinLoopback;

namespace RevAgent.Bridge.Tests.FixtureIntegration;

/// <summary>
/// P3-T3 acceptance, clause 4: "a normal invoke emits zero <c>mcp_status</c>
/// traffic, while heartbeat/failure enrichment may probe it" — proven with the
/// fixture's own <c>snapshot_evidence</c> method counters rather than a
/// bridge-side spy.
/// </summary>
[Collection(AddinLoopbackFixtureCollection.Name)]
public sealed class AddinLoopbackStatusTrafficTests
{
    private static readonly string[] OrdinaryMethods =
    {
        "get_current_view_info",
        "get_selected_elements",
        "find_elements",
    };

    [Fact]
    public async Task OrdinaryInvocationsEmitNoStatusTrafficButDiscoveryProbesIt()
    {
        await using AddinLoopbackFixtureProcess fixture =
            await AddinLoopbackFixtureProcess.StartAsync();
        var attestor = new FixtureProcessAttestor(fixture);
        var transport = new AddinTcpTransport();
        AddinEndpoint endpoint = AddinEndpoint.Ipv4Loopback(fixture.Port);

        foreach (string method in OrdinaryMethods)
        {
            AddinCallResult result = await transport.InvokeAsync(
                endpoint,
                new AddinCall(
                    "m3-ordinary-" + method,
                    method,
                    new JObject(),
                    TimeSpan.FromSeconds(10)),
                CancellationToken.None,
                CancellationToken.None,
                attestor);
            Assert.True(result.Response.IsSuccess);
        }

        FixtureEvidence beforeProbe = await fixture.SnapshotEvidenceAsync();
        Assert.Equal(0, beforeProbe.MethodExecutionCount("mcp_status"));
        Assert.DoesNotContain(
            beforeProbe.Observations,
            observation => observation.Method == "mcp_status");
        foreach (string method in OrdinaryMethods)
        {
            Assert.Equal(1, beforeProbe.MethodExecutionCount(method));
        }

        // The heartbeat/enrichment path — bounded discovery — is the only
        // bridge surface that issues mcp_status, and it issues exactly one.
        var discovery = new AddinDiscovery(transport, attestor);
        AddinDiscoveryResult discovered = await discovery.DiscoverAsync(
            FixtureBridgeConfiguration.ExplicitPortOverride(fixture.Port),
            TimeSpan.FromSeconds(10));

        ProbedAddinSession session = Assert.Single(discovered.Sessions);
        Assert.Equal(
            AddinDiscoverySource.ExplicitEnvironmentOverride,
            discovered.Evidence.Source);
        Assert.Equal(fixture.Port, session.Target.Port);
        Assert.Equal(fixture.ProcessId, session.Status.Revit.ProcessId);

        FixtureEvidence afterProbe = await fixture.SnapshotEvidenceAsync();
        Assert.Equal(1, afterProbe.MethodExecutionCount("mcp_status"));

        // A further ordinary invoke still adds no status traffic: there is no
        // busy preflight on the invoke hot path (RES-10).
        AddinCallResult afterDiscovery = await transport.InvokeAsync(
            endpoint,
            new AddinCall(
                "m3-ordinary-after-discovery",
                "get_ui_state",
                new JObject(),
                TimeSpan.FromSeconds(10)),
            CancellationToken.None,
            CancellationToken.None,
            attestor);
        Assert.True(afterDiscovery.Response.IsSuccess);

        FixtureEvidence finalEvidence = await fixture.SnapshotEvidenceAsync();
        Assert.Equal(1, finalEvidence.MethodExecutionCount("mcp_status"));
        Assert.Equal(1, finalEvidence.MethodExecutionCount("get_ui_state"));
    }

    [Fact]
    public async Task ProbedStatusAdvertisesTheFrozenFramingAndBatchableSet()
    {
        await using AddinLoopbackFixtureProcess fixture =
            await AddinLoopbackFixtureProcess.StartAsync();
        var attestor = new FixtureProcessAttestor(fixture);
        var discovery = new AddinDiscovery(
            new AddinTcpTransport(),
            attestor);

        AddinDiscoveryResult discovered = await discovery.DiscoverAsync(
            FixtureBridgeConfiguration.ExplicitPortOverride(fixture.Port),
            TimeSpan.FromSeconds(10));
        ProbedAddinSession session = Assert.Single(discovered.Sessions);
        AddinStatusSnapshot status = session.Status;

        Assert.Equal(4, status.Service.Framing.HeaderBytes);
        Assert.Equal(
            "length_prefixed_jsonrpc_v1",
            status.Service.Framing.Protocol);
        Assert.Equal("big_endian", status.Service.Framing.ByteOrder);
        Assert.Equal("utf-8", status.Service.Framing.PayloadEncoding);
        Assert.Equal("loopback_only", status.Service.Binding);
        Assert.Equal(
            FixtureProcessAttestor.FixtureRevitVersion,
            status.Revit.Version);
        Assert.Contains("127.0.0.1", status.Service.BoundAddresses);

        Assert.NotNull(status.BatchAtomic);
        List<string> batchable = status.BatchAtomic!.BatchableCommands
            .Select(descriptor => descriptor.Method)
            .OrderBy(method => method, StringComparer.Ordinal)
            .ToList();

        // The advertised batchable descriptors are exactly the manifest
        // commands the fixture answers, minus send_code_to_revit, which the
        // fixture models as a non-batchable model transaction.
        List<string> expected = AddinCommandManifest.FixtureAnsweredCommands
            .Where(method => method != "send_code_to_revit")
            .OrderBy(method => method, StringComparer.Ordinal)
            .ToList();
        Assert.Equal(expected, batchable);
    }

    [Fact]
    public async Task ContradictoryDiscoveryConfigurationNeverReachesTheFixture()
    {
        await using AddinLoopbackFixtureProcess fixture =
            await AddinLoopbackFixtureProcess.StartAsync();
        var attestor = new FixtureProcessAttestor(fixture);
        var discovery = new AddinDiscovery(
            new FixtureAttestationTransport(attestor),
            attestor);

        ResolvedBridgeConfiguration widenedEnvironmentOverride =
            FixtureBridgeConfiguration.Create(
                fixture.Port,
                fixture.Port + 1,
                FixtureBridgeConfiguration.EnvironmentSource(),
                FixtureBridgeConfiguration.EnvironmentSource());
        ResolvedBridgeConfiguration unfrozenFileScan =
            FixtureBridgeConfiguration.Create(
                9000,
                9005,
                FixtureBridgeConfiguration.FileSource(),
                FixtureBridgeConfiguration.FileSource());
        ResolvedBridgeConfiguration mixedSources =
            FixtureBridgeConfiguration.Create(
                fixture.Port,
                fixture.Port,
                FixtureBridgeConfiguration.FileSource(),
                FixtureBridgeConfiguration.EnvironmentSource());

        foreach (ResolvedBridgeConfiguration rejected in new[]
                 {
                     widenedEnvironmentOverride,
                     unfrozenFileScan,
                     mixedSources,
                 })
        {
            AddinDiscoveryConfigurationException exception =
                await Assert.ThrowsAsync<AddinDiscoveryConfigurationException>(
                    () => discovery.DiscoverAsync(
                        rejected,
                        TimeSpan.FromSeconds(2)));
            Assert.Equal(
                "addin_discovery_configuration_invalid",
                exception.Code);
        }

        FixtureEvidence evidence = await fixture.SnapshotEvidenceAsync();
        Assert.Empty(evidence.Observations);
        Assert.Empty(evidence.MethodExecutionCounts);
        Assert.Equal(0, evidence.OpenSocketCount);
    }
}
