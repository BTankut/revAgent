using System.Globalization;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;

namespace RevAgent.Bridge.Tests.FixtureIntegration;

/// <summary>
/// P3-T3 acceptance, clause 1: "all 21 commands invocable" — driven from the
/// real bridge TCP client against the real O1-T3 add-in loopback fixture.
/// </summary>
[Collection(SocketIntegrationCollection.Name)]
public sealed class AddinLoopbackCommandSurfaceTests
{
    [Fact]
    public void AddinManifestCarriesTheDocumentedTwentyOneCommandInventory()
    {
        IReadOnlyList<string> manifest =
            AddinCommandManifest.ReadManifestCommandNames();
        Assert.Equal(23, manifest.Count);
        Assert.Equal(
            manifest.Count,
            new HashSet<string>(manifest, StringComparer.Ordinal).Count);
        foreach (string addition in AddinCommandManifest.ProtocolAdditions)
        {
            Assert.Contains(addition, manifest);
        }

        IReadOnlyList<string> commands =
            AddinCommandManifest.ReadTwentyOneCommands();
        Assert.Equal(21, commands.Count);
        Assert.Equal(
            AddinCommandManifest.DocumentedCommands
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToList(),
            commands
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToList());
    }

    [Fact]
    public async Task EveryManifestCommandIsInvocableWithExactIdCorrelation()
    {
        IReadOnlyList<string> commands =
            AddinCommandManifest.ReadTwentyOneCommands();
        var fixtureAnswered = new HashSet<string>(
            AddinCommandManifest.FixtureAnsweredCommands,
            StringComparer.Ordinal);

        await using AddinLoopbackFixtureProcess fixture =
            await AddinLoopbackFixtureProcess.StartAsync();
        var attestor = new FixtureProcessAttestor(fixture);
        var transport = new AddinTcpTransport();
        AddinEndpoint endpoint = AddinEndpoint.Ipv4Loopback(fixture.Port);

        var invocationIds = new Dictionary<string, string>(StringComparer.Ordinal);
        var methodNotFound = new List<string>();
        for (var index = 0; index < commands.Count; index++)
        {
            string method = commands[index];
            string invocationId = "m3-p3t3-" +
                index.ToString("D2", CultureInfo.InvariantCulture) +
                "-" +
                method;
            invocationIds[method] = invocationId;

            var call = new AddinCall(
                invocationId,
                method,
                new JObject(),
                TimeSpan.FromSeconds(10));
            AddinCallResult result = await transport.InvokeAsync(
                endpoint,
                call,
                CancellationToken.None,
                CancellationToken.None,
                attestor);

            Assert.Equal(invocationId, result.Response.Id);
            Assert.Equal(
                AddinDispatchState.ResponseObserved,
                result.Evidence.DispatchState);
            Assert.True(
                result.Evidence.RequestFullyWritten,
                method + " must write the whole request frame.");
            Assert.Equal(
                result.Evidence.RequestPayloadBytes + 4,
                result.Evidence.RequestFrameBytes);

            if (fixtureAnswered.Contains(method))
            {
                Assert.True(
                    result.Response.IsSuccess,
                    method + " must return an ordinary success result.");
                JObject payload = Assert.IsType<JObject>(result.Response.Result);
                Assert.Equal(2, payload.Value<int?>("resultContractVersion"));
                Assert.True(payload.Value<bool?>("success"));
            }
            else
            {
                Assert.False(
                    result.Response.IsSuccess,
                    method + " is outside the frozen fixture handler set.");
                AddinJsonRpcErrorAssert(result, -32601);
                methodNotFound.Add(method);
            }
        }

        // The fixture implements fourteen of the twenty-one commands with a
        // completed ordinary result; the remaining seven are UI/view commands
        // the O1-T3 fixture deliberately does not model. Their frozen contract
        // is a correlated JSON-RPC -32601, which is still a well-formed,
        // id-correlated response over the real transport.
        Assert.Equal(7, methodNotFound.Count);

        FixtureEvidence evidence = await fixture.SnapshotEvidenceAsync();
        Assert.Equal(
            AddinLoopbackFixtureProcess.FixtureContract,
            evidence.FixtureContract);
        Assert.False(evidence.Crashed);

        foreach (string method in commands)
        {
            string invocationId = invocationIds[method];
            Assert.Equal(1, evidence.MethodExecutionCount(method));
            Assert.Equal(1, evidence.ExecutionCount(invocationId));

            IReadOnlyList<FixtureObservation> observations =
                evidence.ObservationsFor(invocationId);
            Assert.Contains(
                observations,
                observation =>
                    observation.Phase == "validated" &&
                    observation.Method == method);
            Assert.Contains(
                observations,
                observation =>
                    observation.Phase == "response_sent" &&
                    observation.Method == method);
        }

        Assert.Equal(0, evidence.MethodExecutionCount("mcp_status"));
    }

    [Fact]
    public async Task RequestAndResponseFrameByteCountsMatchTheFixtureRecord()
    {
        await using AddinLoopbackFixtureProcess fixture =
            await AddinLoopbackFixtureProcess.StartAsync();
        var attestor = new FixtureProcessAttestor(fixture);
        var transport = new AddinTcpTransport();
        AddinEndpoint endpoint = AddinEndpoint.Ipv4Loopback(fixture.Port);

        const string invocationId = "m3-framing-exactness";
        var call = new AddinCall(
            invocationId,
            "get_current_view_info",
            new JObject { ["fixtureProbe"] = "framing" },
            TimeSpan.FromSeconds(10));
        AddinCallResult result = await transport.InvokeAsync(
            endpoint,
            call,
            CancellationToken.None,
            CancellationToken.None,
            attestor);

        Assert.True(result.Response.IsSuccess);
        FixtureEvidence evidence = await fixture.SnapshotEvidenceAsync();
        IReadOnlyList<FixtureObservation> observations =
            evidence.ObservationsFor(invocationId);

        List<FixtureObservation> validatedRecords = observations
            .Where(observation => observation.Phase == "validated")
            .ToList();
        List<FixtureObservation> responseRecords = observations
            .Where(observation => observation.Phase == "response_sent")
            .ToList();
        FixtureObservation validated = Assert.Single(validatedRecords);
        FixtureObservation responseSent = Assert.Single(responseRecords);

        // The fixture counts the UTF-8 JSON payload; the bridge counts the
        // payload and the four-byte big-endian prefix separately. Both
        // implementations must agree byte for byte in both directions.
        Assert.Equal(result.Evidence.RequestPayloadBytes, validated.PayloadBytes);
        Assert.Equal(
            result.Evidence.RequestPayloadBytes + 4,
            result.Evidence.RequestFrameBytes);
        Assert.Equal(
            result.Evidence.ResponseBytesObserved,
            (responseSent.PayloadBytes ?? -1) + 4);
        Assert.Equal(
            result.Response.RawPayload.Length,
            (int)(responseSent.PayloadBytes ?? -1));
    }

    private static void AddinJsonRpcErrorAssert(
        AddinCallResult result,
        int expectedCode)
    {
        Assert.NotNull(result.Response.Error);
        Assert.Equal(expectedCode, result.Response.Error!.Code);
    }
}
