using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;
using RevAgent.Contracts.AddinLoopback;
using static RevAgent.Bridge.Tests.Gateway.Dispatch.RbpBatchCoordinatorTestData;

namespace RevAgent.Bridge.Tests.Gateway.Dispatch;

public sealed class RbpApplicationErrorSafetyTests
{
    internal const string First = "0197a3c2-0000-7000-8000-0000000000a1";
    internal const string Second = "0197a3c2-0000-7000-8000-0000000000a2";
    internal const string Third = "0197a3c2-0000-7000-8000-0000000000a3";
    internal const string Batch = "0197a3c2-0000-7000-8000-0000000000b1";

    [Theory]
    [InlineData("{\"success\":false}", "ApplicationError")]
    [InlineData("{\"result\":{\"success\":false}}", "ApplicationError")]
    [InlineData("{\"success\":false,\"result\":{\"guarded\":true}}", "ApplicationError")]
    [InlineData("{\"success\":false,\"guarded\":true}", "Guarded")]
    [InlineData("{\"guarded\":false,\"status\":\"guarded\"}", "Unclassifiable")]
    [InlineData("{\"guarded\":true,\"status\":\"failed\"}", "Unclassifiable")]
    [InlineData("{\"success\":\"false\"}", "Unclassifiable")]
    [InlineData("{\"Success\":false}", "Unclassifiable")]
    [InlineData("{\"SUCCESS\":false}", "Unclassifiable")]
    [InlineData("{\"success\":true,\"success\":false}", "Unclassifiable")]
    [InlineData("{\"guarded\":true,\"reason\":\"one\",\"guarded_reason\":\"two\"}", "Unclassifiable")]
    [InlineData("{\"error\":true}", "Unclassifiable")]
    [InlineData("{\"success\":true,\"status\":\"failed\"}", "Unclassifiable")]
    [InlineData("{\"error\":null}", "Completed")]
    [InlineData("{\"error\":\"\"}", "Completed")]
    [InlineData("{\"message\":\"ERROR: diagnostic only\"}", "Completed")]
    [InlineData("{\"result\":[{\"success\":false}]}", "Completed")]
    [InlineData("{\"data\":{\"success\":false}}", "Completed")]
    [InlineData("{\"result\":\"ERROR_RATE\"}", "Completed")]
    [InlineData("{\"result\":\"text ERROR later\"}", "Completed")]
    [InlineData("{\"result\":\"  error: failure\"}", "ApplicationError")]
    [InlineData("{\"result\":\"ERROR\"}", "ApplicationError")]
    [InlineData("{\"result\":\"ERROR detail\"}", "ApplicationError")]
    [InlineData("{\"result\":\"{broken\"}", "Unclassifiable")]
    [InlineData("{\"result\":{\"result\":{\"success\":false}}}", "ApplicationError")]
    [InlineData("{\"result\":{\"result\":{\"result\":{\"success\":false}}}}", "Unclassifiable")]
    public void FixedGrammar(string json, string expected) =>
        Assert.Equal(expected, RbpApplicationResultClassifier.Classify(Json(json)).ToString());

    [Fact]
    public void DecodeAndByteDepthTokenBoundariesAreExact()
    {
        string failure = "{\"success\":false}";
        Assert.Equal(RbpApplicationResultClassification.ApplicationError, ClassifyString(failure));
        Assert.Equal(RbpApplicationResultClassification.ApplicationError, ClassifyString(JsonSerializer.Serialize(failure)));
        Assert.Equal(RbpApplicationResultClassification.Unclassifiable,
            ClassifyString(JsonSerializer.Serialize(JsonSerializer.Serialize(failure))));
        string bytes = "{\"padding\":\"" + new string('a', RbpApplicationResultClassifier.MaximumDecodedBytes - 14) + "\"}";
        Assert.Equal(RbpApplicationResultClassifier.MaximumDecodedBytes, Encoding.UTF8.GetByteCount(bytes));
        Assert.Equal(RbpApplicationResultClassification.Completed, ClassifyString(bytes));
        Assert.Equal(RbpApplicationResultClassification.Unclassifiable, ClassifyString(bytes + " "));
        string depth32 = new('[', 32);
        depth32 += "0" + new string(']', 32);
        Assert.Equal(RbpApplicationResultClassification.Completed, ClassifyString(depth32));
        Assert.Equal(RbpApplicationResultClassification.Unclassifiable, ClassifyString("[" + depth32 + "]"));
        string tokens4096 = "[" + string.Join(',', Enumerable.Repeat("0", 4094)) + "]";
        Assert.Equal(RbpApplicationResultClassification.Completed, ClassifyString(tokens4096));
        Assert.Equal(RbpApplicationResultClassification.Unclassifiable, ClassifyString(tokens4096.Insert(1, "0,")));
        Assert.Equal(RbpApplicationResultClassification.Unclassifiable, ClassifyString("{\"a\":1,\"a\":2}"));
        Assert.Equal(RbpApplicationResultClassification.Unclassifiable, ClassifyString("{\"a\":1e9999}"));
        Assert.True(Encoding.UTF8.GetByteCount(RbpApplicationResultClassifier.Diagnostic(new string('ğ', 600))) <= 512);
    }

    [Theory]
    [InlineData(-32601, "unsupported")]
    [InlineData(-32600, "parameter")]
    [InlineData(-32602, "parameter")]
    [InlineData(-32603, "revit_api")]
    public async Task RealRoutedJsonRpcErrorPreservesBytesAndReadMapping(int code, string fault)
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await Open(directory);
        var fixture = new RoutedFixture("{}", code);
        RbpAddinOutcome observed = await fixture.Channel.InvokeAsync(Rsid,
            new AddinCall(First, ReadMethod, new JObject(), TimeSpan.FromSeconds(1)), CancellationToken.None);
        Assert.Equal(RbpAddinOutcomeKind.ApplicationError, observed.Kind);
        Assert.Equal(fixture.Transport.LastBytes, observed.RawResponsePayload);
        Assert.True(observed.RequestBytes > 0 && observed.ResponseBytes > 0);
        Assert.NotNull(observed.ProcessAttestation);
        observed.Lease!.ReleaseAfterDurableDecision();
        RbpInvocationAnswer answer = await new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate())
            .DispatchAsync(Request(false), CancellationToken.None);
        Assert.Equal("error", answer.Type);
        Assert.Equal(fault, answer.Payload.GetProperty("fault_class").GetString());
        Assert.False(answer.Payload.GetProperty("retryable").GetBoolean());
        Assert.Equal("known", answer.Payload.GetProperty("outcome").GetString());
    }

    [Theory]
    [InlineData("{\"success\":false}", false)]
    [InlineData("{\"result\":{\"success\":false}}", false)]
    [InlineData("{\"result\":\"\\\"{\\\\\\\"success\\\\\\\":false}\\\"\"}", false)]
    [InlineData("{\"success\":false,\"committed\":true}", false)]
    [InlineData("{\"success\":false,\"rolled_back\":true}", false)]
    [InlineData("{}", true)]
    [InlineData("{\"success\":\"false\"}", false)]
    public async Task RealRoutedMutationHoldsAndBlocksConflictingFreshWrite(string result, bool jsonRpcError)
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await Open(directory);
        var fixture = new RoutedFixture(result, jsonRpcError ? -32603 : null);
        RbpAddinOutcome classified = await fixture.Channel.InvokeAsync(Rsid,
            new AddinCall(First, WriteMethod, new JObject(), TimeSpan.FromSeconds(1)), CancellationToken.None);
        Assert.Equal(result.Contains("\"success\":\"false\"", StringComparison.Ordinal)
            ? RbpAddinOutcomeKind.PossiblyDispatched : RbpAddinOutcomeKind.ApplicationError, classified.Kind);
        Assert.Equal(fixture.Transport.LastBytes, classified.RawResponsePayload);
        classified.Lease!.ReleaseAfterDurableDecision();
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        RbpInvocationAnswer first = await dispatcher.DispatchAsync(Request(true), CancellationToken.None);
        Assert.Equal("journal_indeterminate", first.Payload.GetProperty("fault_class").GetString());
        string holdId = first.Payload.GetProperty("verification_hold_id").GetString()!;
        RbpVerificationHold hold = Assert.IsType<RbpVerificationHold>(await store.GetHoldAsync(Rsid, holdId));
        Assert.Equal(new[] { Rsid + "/" + First }, hold.OrderedOriginIdempotencyKeys);
        Assert.Equal(holdId, (await dispatcher.DispatchAsync(Request(true, Second), CancellationToken.None))
            .Payload.GetProperty("verification_hold_id").GetString());
        Assert.True((await dispatcher.DispatchAsync(Request(true), CancellationToken.None))
            .Payload.GetProperty("replayed").GetBoolean());
        Assert.Equal(2, fixture.Transport.Calls);
        _ = await dispatcher.DispatchAsync(Request(false, Third), CancellationToken.None);
        Assert.Equal(3, fixture.Transport.Calls);
    }

    [Fact]
    public async Task ContradictoryNoSendMutationAndSequentialFailureNeverClaimNoEffect()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await Open(directory);
        var channel = new StubBatchChannel().Then(new RbpAddinOutcome(
            RbpAddinOutcomeKind.KnownNotDispatched, default, [], 1, 0));
        var coordinator = new RbpBatchCoordinator(store, channel, StubBatchCapabilities.Standard());
        RbpInvocationAnswer answer = await coordinator.DispatchAsync(Rsid,
            Payload(Batch, false, [Write(First), Write(Second)]), CancellationToken.None);
        Assert.Equal("indeterminate", answer.Payload.GetProperty("steps")[0].GetProperty("status").GetString());
        Assert.Equal("not_started", answer.Payload.GetProperty("steps")[1].GetProperty("status").GetString());
        Assert.Single(channel.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AtomicApplicationErrorPersistsAllScopesTogetherAndReplays(bool sessionScope)
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await Open(directory);
        var fixture = new RoutedFixture("{}", -32602);
        var coordinator = new RbpBatchCoordinator(store, fixture.Channel, StubBatchCapabilities.Standard(true));
        BatchStepSpec other = Write(Second) with { MutationScopeJson = sessionScope ? "{\"kind\":\"session\"}" : "{\"kind\":\"document\",\"document_id\":\"doc-2\"}" };
        JsonElement payload = Payload(Batch, true, [Write(First), other, Read(Third)]);
        RbpInvocationAnswer answer = await coordinator.DispatchAsync(Rsid, payload, CancellationToken.None);
        Assert.Equal("indeterminate", answer.Payload.GetProperty("transaction_state").GetString());
        Assert.False(answer.Payload.GetProperty("replayed").GetBoolean());
        RbpStoredInvocation one = (await store.GetInvocationAsync(Rsid + "/" + First))!;
        RbpStoredInvocation two = (await store.GetInvocationAsync(Rsid + "/" + Second))!;
        Assert.Equal(RbpInvocationState.Indeterminate, one.State);
        Assert.Equal(RbpInvocationState.Indeterminate, two.State);
        Assert.Equal(sessionScope, one.VerificationHoldId == two.VerificationHoldId);
        if (sessionScope)
            Assert.Equal(new[] { Rsid + "/" + First, Rsid + "/" + Second },
                (await store.GetHoldAsync(Rsid, one.VerificationHoldId!))!.OrderedOriginIdempotencyKeys);
        JsonElement read = answer.Payload.GetProperty("steps")[2].GetProperty("error");
        Assert.Equal("parameter", read.GetProperty("fault_class").GetString());
        Assert.False(read.GetProperty("retryable").GetBoolean());
        Assert.True((await coordinator.DispatchAsync(Rsid, payload, CancellationToken.None)).Payload.GetProperty("replayed").GetBoolean());
        Assert.Equal(1, fixture.Transport.Calls);
    }

    [Fact]
    public async Task AllReadAtomicApplicationErrorRemainsMappedNonretryable()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await Open(directory);
        var fixture = new RoutedFixture("{}", -32601);
        var coordinator = new RbpBatchCoordinator(store, fixture.Channel, StubBatchCapabilities.Standard(true));
        RbpInvocationAnswer answer = await coordinator.DispatchAsync(Rsid,
            Payload(Batch, true, [Read(First), Read(Second)]), CancellationToken.None);
        Assert.Equal("failed", answer.Payload.GetProperty("status").GetString());
        foreach (JsonElement step in answer.Payload.GetProperty("steps").EnumerateArray())
        {
            Assert.Equal("read_only", step.GetProperty("effect_state").GetString());
            Assert.Equal("unsupported", step.GetProperty("error").GetProperty("fault_class").GetString());
            Assert.False(step.GetProperty("error").GetProperty("retryable").GetBoolean());
        }
    }

    [Fact]
    public async Task StrictNativeAtomicRollbackStillMapsThroughTheRealRoutedChannel()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await Open(directory);
        JsonElement payload = Payload(Batch, true, [Write(First), Write(Second)]);
        RbpAddinOutcome native = AtomicEnvelope(Batch, payload.GetProperty("batch_digest").GetString()!,
            [new AtomicStepSpec(First, WriteMethod, "failed", "not_committed", ErrorCode: "revit_api", ErrorMessage: "rolled back"),
             new AtomicStepSpec(Second, WriteMethod, "not_started", "not_started")]);
        var fixture = new RoutedFixture(native.Result.GetRawText(), null);
        var coordinator = new RbpBatchCoordinator(store, fixture.Channel, StubBatchCapabilities.Standard(true));
        RbpInvocationAnswer answer = await coordinator.DispatchAsync(Rsid, payload, CancellationToken.None);
        Assert.Equal("rolled_back", answer.Payload.GetProperty("transaction_state").GetString());
        Assert.Equal("failed", answer.Payload.GetProperty("status").GetString());
        Assert.Null((await store.GetInvocationAsync(Rsid + "/" + First))!.VerificationHoldId);
        Assert.Equal(1, fixture.Transport.Calls);
    }

    [Fact]
    public async Task UnclassifiableRealRoutedReadIsNonretryableProtocolNotSuccess()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = await Open(directory);
        var fixture = new RoutedFixture("{\"result\":\"{bad\"}", null);
        RbpInvocationAnswer answer = await new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate())
            .DispatchAsync(Request(false), CancellationToken.None);
        Assert.Equal("error", answer.Type);
        Assert.Equal("protocol", answer.Payload.GetProperty("fault_class").GetString());
        Assert.False(answer.Payload.GetProperty("retryable").GetBoolean());
    }

    [Fact]
    public void QuarantineHasBoundedReservationsAndNeverOverwritesAnOwner()
    {
        var owner = RbpDispatchDecisionQuarantine.For(new StubBatchChannel());
        for (int index = 0; index < 1024; index++) Assert.True(owner.TryReserve("rs-" + index));
        Assert.False(owner.TryReserve("overflow"));
        Assert.False(owner.TryReserve("rs-0"));
        var lease = new CountingLease();
        owner.Own("rs-0", lease);
        Assert.Throws<InvalidOperationException>(() => owner.Own("rs-0", new CountingLease()));
        Assert.Equal(0, lease.Releases);
        owner.ReleaseProven("rs-0", lease);
        Assert.Equal(1, lease.Releases);
        Assert.Throws<InvalidOperationException>(() => owner.ReleaseProven("rs-0", lease));
        Assert.Equal(1, lease.Releases);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FailedExactReadbackNeverReleasesOrRedispatches(bool readUnavailable)
    {
        using var directory = new RbpJournalTestDirectory();
        var faults = new DecisionFaults();
        await using RbpJournalStore store = await Open(directory, faults);
        var fixture = new RoutedFixture("{}", -32603);
        fixture.Transport.BeforeReturn = () =>
        {
            faults.Arm(RbpJournalFaultPoint.AfterCommitBeforeReturn, 1);
            faults.BeforeFailure = () =>
            {
                using var connection = new SqliteConnection($"Data Source={directory.JournalPath};Pooling=False");
                connection.Open();
                using SqliteCommand command = connection.CreateCommand();
                command.CommandText = readUnavailable
                    ? "ALTER TABLE rbp_invocations RENAME TO retained_unreadable_invocations;"
                    : "UPDATE rbp_invocations SET terminal_outcome_json='{}' WHERE state='indeterminate';";
                command.ExecuteNonQuery();
            };
        };
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        await Assert.ThrowsAnyAsync<Exception>(() => dispatcher.DispatchAsync(Request(true), CancellationToken.None));
        Assert.True(RbpDispatchDecisionQuarantine.For(fixture.Channel).IsBlocked(Rsid));
        fixture.RebindToFreshSlot();
        Assert.Equal("error", (await dispatcher.DispatchAsync(Request(true, Second), CancellationToken.None)).Type);
        RbpAddinOutcome direct = await fixture.Channel.InvokeAsync(Rsid,
            new AddinCall(Third, ReadMethod, new JObject(), TimeSpan.FromSeconds(1)), CancellationToken.None);
        Assert.Equal(RbpAddinOutcomeKind.KnownNotDispatched, direct.Kind);
        Assert.Equal(0, direct.RequestBytes);
        Assert.Equal(1, fixture.Transport.Calls);
    }

    private sealed class CountingLease : IRbpDispatchLease
    {
        internal int Releases;
        public void ReleaseAfterDurableDecision() => Releases++;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PersistenceFailureRetainsLeaseAcrossRebindAndBlocksSingleAndBatch(bool committed)
    {
        using var directory = new RbpJournalTestDirectory();
        var faults = new DecisionFaults();
        await using RbpJournalStore store = await Open(directory, faults);
        var fixture = new RoutedFixture("{}", -32603);
        fixture.Transport.BeforeReturn = () => faults.Arm(committed ? RbpJournalFaultPoint.AfterCommitBeforeReturn : RbpJournalFaultPoint.BeforeCommit, committed ? 1 : 2);
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        if (committed)
        {
            RbpInvocationAnswer answer = await dispatcher.DispatchAsync(Request(true), CancellationToken.None);
            Assert.Equal("journal_indeterminate", answer.Payload.GetProperty("fault_class").GetString());
            Assert.False(RbpDispatchDecisionQuarantine.For(fixture.Channel).IsBlocked(Rsid));
        }
        else
        {
            await Assert.ThrowsAsync<IOException>(() => dispatcher.DispatchAsync(Request(true), CancellationToken.None));
            Assert.True(RbpDispatchDecisionQuarantine.For(fixture.Channel).IsBlocked(Rsid));
            fixture.RebindToFreshSlot();
            RbpInvocationAnswer denied = await dispatcher.DispatchAsync(Request(true, Second), CancellationToken.None);
            Assert.Equal("environment", denied.Payload.GetProperty("fault_class").GetString());
            var coordinator = new RbpBatchCoordinator(store, fixture.Channel, StubBatchCapabilities.Standard(true));
            Assert.Equal("error", (await coordinator.DispatchAsync(Rsid, Payload(Batch, true, [Write(Second)]), CancellationToken.None)).Type);
            Assert.Equal(1, fixture.Transport.Calls);
            Assert.Equal(2, faults.Failures);
        }
    }

    private static RbpApplicationResultClassification ClassifyString(string value) =>
        RbpApplicationResultClassifier.Classify(JsonSerializer.SerializeToElement(new { result = value }));

    internal static async Task<RbpJournalStore> Open(RbpJournalTestDirectory directory, IRbpJournalFaultInjector? faults = null)
    {
        RbpJournalStore store = RbpJournalStore.Open(directory.JournalPath, new TestResumeTokenProtector(), RbpJournalTestData.Options(faultInjector: faults));
        await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration());
        return store;
    }

    internal static RbpInvokeRequest Request(bool mutating, string id = First) =>
        RbpInvokeRequest.Parse(Rsid, JsonSerializer.SerializeToElement(new
        {
            invocation_id = id,
            method = mutating ? WriteMethod : ReadMethod,
            @params = new { },
            timeout_ms = 120000,
            mutating,
            mutation_scope = mutating ? Json(DocumentScope) : Json("null"),
            policy = new { @class = mutating ? "confirm" : "auto", decision = mutating ? "confirmed" : "auto", confirmation_id = mutating ? "c1" : null },
            verification = (object?)null,
            recovery_clearances = Array.Empty<object>(),
        }));

    internal sealed class DecisionFaults : IRbpJournalFaultInjector
    {
        private RbpJournalFaultPoint _point;
        private int _remaining;
        internal int Failures { get; private set; }
        internal Action? BeforeFailure;
        internal void Arm(RbpJournalFaultPoint point, int count) { _point = point; _remaining = count; }
        public void Hit(RbpJournalFaultPoint point)
        {
            if (point != _point || _remaining <= 0) return;
            _remaining--; Failures++;
            BeforeFailure?.Invoke();
            throw new IOException("Injected current-decision persistence fault.");
        }
    }

    internal sealed class RoutedFixture
    {
        internal readonly ResponseTransport Transport;
        internal readonly AddinSessionRouter Router;
        internal readonly MutableRoute Route = new();
        internal readonly RbpRoutedInvocationChannel Channel;
        internal RoutedFixture(string resultJson, int? errorCode)
        {
            Transport = new ResponseTransport(resultJson, errorCode);
            Router = new AddinSessionRouter(Transport);
            Bind(8080, 4242);
            Channel = new RbpRoutedInvocationChannel(Router, Route);
        }
        internal void RebindToFreshSlot() => Bind(8081, 4243);
        private void Bind(int port, int pid)
        {
            DirectoryInfo? root = new(AppContext.BaseDirectory);
            while (root is not null && !File.Exists(Path.Combine(root.FullName, "packages/protocol/fixtures/addin-loopback/v1/mcp-status.positive.json"))) root = root.Parent;
            JObject status = (JObject)JObject.Parse(File.ReadAllText(Path.Combine(root!.FullName,
                "packages/protocol/fixtures/addin-loopback/v1/mcp-status.positive.json")))["response"]!["result"]!;
            status["service"]!["port"] = port;
            status["service"]!["boundAddresses"] = new JArray("127.0.0.1");
            status["revit"]!["processId"] = pid;
            AddinStatusSnapshot parsed = AddinStatusParser.ParseResult(status);
            var attestation = new AddinProcessAttestation(new AddinProcessIdentity(pid, 133000000000000000 + pid),
                parsed.Revit.Version, @"C:\Program Files\Autodesk\Revit 2026\Revit.exe");
            var session = new ProbedAddinSession(AddinEndpoint.Ipv4Loopback(port), $"port:{port}:pid:{pid}:started:{attestation.Identity.StartTimeFileTimeUtc}", parsed, attestation);
            AddinEndpoint[] probed = Enumerable.Range(AddinDiscovery.ScanStartPort, AddinDiscovery.ScanEndPort - AddinDiscovery.ScanStartPort + 1).Select(AddinEndpoint.Ipv4Loopback).ToArray();
            AddinDiscoveryRejection[] rejected = probed.Where(p => p.Port != port).Select(p => new AddinDiscoveryRejection(p,
                AddinDiscoveryFailureKind.Unreachable, "addin_connect_failed", new AddinTransportEvidence(AddinDispatchState.NotStarted, 0, 0, 0, false, 0))).ToArray();
            var snapshot = new AddinDiscoveryResult([session], new AddinDiscoveryEvidence(AddinDiscoverySource.BoundedScan, probed, [session.Target], rejected));
            Route.Handle = Assert.Single(Router.Reconcile(Router.BeginRefresh(), snapshot).AvailableSessions).Handle;
        }
    }

    internal sealed class MutableRoute : IRbpSessionRouteResolver
    {
        internal AddinSessionRouter.SessionHandle? Handle;
        public AddinSessionRouter.SessionHandle? Resolve(string rsid) => Handle;
    }

    internal sealed class ResponseTransport(string result, int? errorCode) : IAddinTransport
    {
        internal int Calls;
        internal byte[] LastBytes = [];
        internal Action? BeforeReturn;
        public Task<AddinCallResult> InvokeAsync(AddinEndpoint endpoint, AddinCall call,
            CancellationToken preDispatchCancellationToken = default, CancellationToken transportShutdownToken = default,
            IAddinProcessAttestor? processAttestor = null)
        {
            Calls++;
            string body = result.Contains("\"resultContractVersion\"", StringComparison.Ordinal) ? result :
                result == "{}" ? "{\"resultContractVersion\":2}" :
                "{\"resultContractVersion\":2," + result[1..];
            string tail = errorCode is { } code ? $"\"error\":{{\"code\":{code},\"message\":\"commit then throw\"}}" : "\"result\":" + body;
            LastBytes = Encoding.UTF8.GetBytes("{ \"jsonrpc\":\"2.0\", \"id\":" + JsonSerializer.Serialize(call.InvocationId) + ", " + tail + " }");
            AddinJsonRpcResponse response = AddinJsonRpcCodec.ParseResponse(LastBytes, call.InvocationId);
            BeforeReturn?.Invoke();
            return Task.FromResult(new AddinCallResult(response,
                new AddinTransportEvidence(AddinDispatchState.ResponseObserved, 128, 132, 132, true, LastBytes.Length),
                ((ExpectedAddinProcessAttestor)processAttestor!).Expected));
        }
    }
}
