using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;

namespace RevAgent.Bridge.Tests.FixtureIntegration;

/// <summary>
/// P3-T3 acceptance, clause 2: "LAN/wildcard/remote overrides are rejected
/// before JSON-RPC bytes" — the zero-bytes claim is proven against the real
/// O1-T3 fixture, whose evidence counters show no connection and no request.
/// </summary>
/// <remarks>
/// The bridge cannot express a non-loopback add-in target at all: every
/// transport entry point takes an <c>AddinEndpoint</c>, and the endpoint
/// factory is the override gate. A refused literal therefore aborts before a
/// socket exists, which is strictly earlier than the first JSON-RPC byte.
/// </remarks>
[Collection(AddinLoopbackFixtureCollection.Name)]
public sealed class AddinLoopbackOverrideRejectionTests
{
    [Fact]
    public async Task NonLoopbackOverridesAreRejectedBeforeAnyFixtureTraffic()
    {
        await using AddinLoopbackFixtureProcess fixture =
            await AddinLoopbackFixtureProcess.StartAsync();
        var attestor = new FixtureProcessAttestor(fixture);
        var transport = new FixtureAttestationTransport(attestor);

        foreach ((string literal, string kind) in RejectedEndpointOverrides.All)
        {
            AddinEndpointException rejection =
                Assert.Throws<AddinEndpointException>(() =>
                    AddinEndpoint.Create(literal, fixture.Port));
            Assert.Equal("non_loopback_target", rejection.Code);
            Assert.True(
                rejection.Message.Contains(
                    "loopback",
                    StringComparison.Ordinal),
                kind + " override '" + literal +
                "' must be refused as a non-loopback target.");
        }

        foreach (int invalidPort in new[] { 0, -1, 65_536 })
        {
            AddinEndpointException rejection =
                Assert.Throws<AddinEndpointException>(() =>
                    AddinEndpoint.Create("127.0.0.1", invalidPort));
            Assert.Equal("invalid_addin_port", rejection.Code);
        }

        // The refusal happens while building the target, so the transport is
        // never entered: the fixture observed no frame and no socket.
        FixtureEvidence rejectedEvidence = await fixture.SnapshotEvidenceAsync();
        Assert.Empty(rejectedEvidence.Observations);
        Assert.Empty(rejectedEvidence.ExecutionCounts);
        Assert.Empty(rejectedEvidence.MethodExecutionCounts);
        Assert.Equal(0, rejectedEvidence.OpenSocketCount);
        Assert.False(rejectedEvidence.Crashed);

        // Control: the identical call over the accepted numeric loopback
        // target does move every counter, so the zero above is a refusal and
        // not a blind fixture.
        AddinCallResult accepted = await transport.InvokeAsync(
            AddinEndpoint.Create(
                RejectedEndpointOverrides.AcceptedLoopback.ToString(),
                fixture.Port),
            new AddinCall(
                "m3-override-control",
                "get_current_view_info",
                new JObject(),
                TimeSpan.FromSeconds(10)),
            CancellationToken.None,
            CancellationToken.None,
            attestor);
        Assert.True(accepted.Response.IsSuccess);

        FixtureEvidence acceptedEvidence = await fixture.SnapshotEvidenceAsync();
        Assert.NotEmpty(acceptedEvidence.Observations);
        Assert.Equal(1, acceptedEvidence.ExecutionCount("m3-override-control"));
        Assert.Equal(
            1,
            acceptedEvidence.MethodExecutionCount("get_current_view_info"));
    }

    [Fact]
    public void LoopbackFormsRemainAcceptedTargets()
    {
        foreach (string literal in new[] { "127.0.0.1", "127.5.6.7", "::1" })
        {
            AddinEndpoint endpoint = AddinEndpoint.Create(literal, 8080);
            Assert.Equal(8080, endpoint.Port);
        }

        AddinEndpoint mapped = AddinEndpoint.Create("::ffff:127.0.0.1", 8081);
        Assert.Equal("127.0.0.1:8081", mapped.ToString());
    }

    [Fact]
    public async Task TheFixtureItselfRefusesWildcardAndUnsafeBindOverrides()
    {
        (int wildcardExit, string wildcardDiagnostics) =
            await AddinLoopbackFixtureProcess.RunRejectedBindAsync(
                "--host",
                "0.0.0.0",
                "--port",
                "0");
        Assert.NotEqual(0, wildcardExit);
        Assert.Contains(
            "numeric IP loopback address",
            wildcardDiagnostics,
            StringComparison.Ordinal);

        (int unsafeExit, string unsafeDiagnostics) =
            await AddinLoopbackFixtureProcess.RunRejectedBindAsync(
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--allow-unsafe-bind");
        Assert.NotEqual(0, unsafeExit);
        Assert.Contains(
            "Unsafe bind override is forbidden",
            unsafeDiagnostics,
            StringComparison.Ordinal);
    }
}
