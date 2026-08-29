using System.Security.Cryptography;
using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;
using static RevAgent.Bridge.Tests.Gateway.Dispatch.RbpApplicationErrorSafetyTests;
using static RevAgent.Bridge.Tests.Gateway.Dispatch.RbpBatchCoordinatorTestData;

namespace RevAgent.Bridge.Tests.Gateway.Dispatch;

public sealed class RbpCorrelatedVerificationFlowTests
{
    private const string Fourth = "0197a3c2-0000-7000-8000-0000000000a4";
    private const string Fifth = "0197a3c2-0000-7000-8000-0000000000a5";
    private const string Resolution = "0197a3c2-0000-7000-8000-0000000000c1";
    private const string Audit = "0197a3c2-0000-7000-8000-0000000000c2";
    private const string WrongClearanceBatch = "0197a3c2-0000-7000-8000-0000000000b2";
    private const string ClearedNextBatch = "0197a3c2-0000-7000-8000-0000000000b3";

    [Theory]
    [InlineData("{\"success\":true,\"observed\":\"postcondition-context\"}", true)]
    [InlineData("{\"success\":false}", false)]
    [InlineData("{\"guarded\":true,\"reason\":\"needs_scope\"}", false)]
    [InlineData("{\"result\":\"{broken\"}", false)]
    public async Task RealRoutedReadProducesOnlyAnEvidenceCandidate(string response, bool eligible)
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenForRoute(directory, fixture);
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        RbpInvocationAnswer mutation = await dispatcher.DispatchAsync(Request(true), CancellationToken.None);
        string holdId = mutation.Payload.GetProperty("verification_hold_id").GetString()!;
        fixture.Transport.SetResponse(response);
        RbpInvokeRequest read = VerificationRequest(Second, holdId);
        string? receivedCorrelation = null;
        fixture.Transport.BeforeReturn = () =>
        {
            // A separate read proves received correlation existed before the
            // transport returned; this callback does not manufacture evidence.
            using var connection = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={directory.JournalPath};Pooling=False");
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT verification_correlation_json FROM rbp_invocations WHERE idempotency_key=$key;";
            command.Parameters.AddWithValue("$key", Rsid + "/" + Second);
            receivedCorrelation = (string?)command.ExecuteScalar();
        };
        RbpInvocationAnswer answer = await dispatcher.DispatchAsync(read, CancellationToken.None);
        Assert.NotNull(receivedCorrelation);
        Assert.Equal(JsonValueKind.Null, Json(receivedCorrelation!).GetProperty("terminal").ValueKind);
        RbpStoredInvocation stored = (await store.GetInvocationAsync(Rsid + "/" + Second))!;
        JsonElement facts = Json(stored.VerificationCorrelationJson!).GetProperty("terminal");
        Assert.Equal(eligible, facts.GetProperty("eligible").GetBoolean());
        string rawDigest = "sha256:" + Convert.ToHexString(
            SHA256.HashData(fixture.Transport.LastBytes)).ToLowerInvariant();
        Assert.Equal(rawDigest, facts.GetProperty("raw_response_digest").GetString());
        RbpVerificationHold hold = (await store.GetHoldAsync(Rsid, holdId))!;
        Assert.Equal(eligible ? RbpHoldState.EvidenceRecorded : RbpHoldState.Active, hold.State);
        Assert.Null(hold.ResolutionId);
        Assert.Null(hold.ResolutionDecision);
        Assert.Null(hold.AuditId);
        if (eligible)
        {
            Assert.Equal(rawDigest, answer.Payload.GetProperty("result_digest").GetString());
            Assert.Equal(rawDigest, hold.EvidenceDigest);
            Assert.Equal(Second, hold.VerificationInvocationId);
        }
        Assert.Equal(2, fixture.Transport.Calls);
        _ = await dispatcher.DispatchAsync(read, CancellationToken.None);
        Assert.Equal(2, fixture.Transport.Calls);
        RbpInvocationAnswer blocked = await dispatcher.DispatchAsync(Request(true, Third), CancellationToken.None);
        Assert.Equal("journal_indeterminate", blocked.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(2, fixture.Transport.Calls);
    }

    [Fact]
    public async Task OrdinaryReadCannotBePromotedByAddingVerificationOnReplay()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenForRoute(directory, fixture);
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        string holdId = (await dispatcher.DispatchAsync(Request(true), CancellationToken.None)).Payload.GetProperty("verification_hold_id").GetString()!;
        fixture.Transport.SetResponse("{\"success\":true}");
        _ = await dispatcher.DispatchAsync(Request(false, Second), CancellationToken.None);
        RbpInvocationAnswer refused = await dispatcher.DispatchAsync(VerificationRequest(Second, holdId), CancellationToken.None);
        Assert.Equal("protocol", refused.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(2, fixture.Transport.Calls);
        Assert.Equal(RbpHoldState.Active, (await store.GetHoldAsync(Rsid, holdId))!.State);
    }

    [Fact]
    public async Task MutatingInvocationCannotCarryVerification()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenForRoute(directory, fixture);
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        string holdId = (await dispatcher.DispatchAsync(Request(true), CancellationToken.None)).Payload.GetProperty("verification_hold_id").GetString()!;

        RbpInvokeRequest request = Request(true, Second) with
        {
            Verification = VerificationRequest(Second, holdId).Verification,
        };
        RbpInvocationAnswer answer = await dispatcher.DispatchAsync(request, CancellationToken.None);

        Assert.Equal("protocol", answer.Payload.GetProperty("fault_class").GetString());
        Assert.Null(await store.GetInvocationAsync(Rsid + "/" + Second));
        Assert.Equal(1, fixture.Transport.Calls);
    }

    [Fact]
    public async Task MissingHoldAndForeignSessionHoldAreRejectedBeforeDispatch()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenForRoute(directory, fixture);
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());

        RbpInvocationAnswer missing = await dispatcher.DispatchAsync(
            VerificationRequest(Second, "vh:" + new string('a', 64)), CancellationToken.None);
        Assert.Equal("protocol", missing.Payload.GetProperty("fault_class").GetString());

        const string foreignRsid = "rs-foreign";
        await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration(
            foreignRsid, "port:9090:pid:9999", "foreign-resume-token"));
        var origin = new RbpInvocationIdentity(foreignRsid, First, WriteMethod, true, DocumentScope,
            "sha256:" + new string('b', 64), "{\"decision\":\"confirmed\"}", "[]");
        _ = await store.AdmitInvocationAsync(origin);
        await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
        string foreignHold = (await store.AdmitInvocationAsync(origin)).VerificationHoldId!;

        RbpInvocationAnswer foreign = await dispatcher.DispatchAsync(
            VerificationRequest(Third, foreignHold), CancellationToken.None);
        Assert.Equal("protocol", foreign.Payload.GetProperty("fault_class").GetString());
        Assert.Null(await store.GetInvocationAsync(Rsid + "/" + Third));
        Assert.Equal(0, fixture.Transport.Calls);
    }

    [Fact]
    public async Task ReboundRouteAndMissingAttestationCannotProduceCandidate()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenForRoute(directory, fixture);
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        string firstHold = (await dispatcher.DispatchAsync(Request(true), CancellationToken.None)).Payload.GetProperty("verification_hold_id").GetString()!;
        fixture.Transport.SetResponse("{\"success\":true}");
        fixture.RebindToFreshSlot();

        _ = await dispatcher.DispatchAsync(VerificationRequest(Second, firstHold), CancellationToken.None);
        await AssertIneligibleAsync(store, firstHold, Second);

        fixture.Transport.SetResponse("{}", -32603);
        string secondHold = (await dispatcher.DispatchAsync(Request(true, Third) with
        {
            MutationScope = Json("{\"kind\":\"document\",\"document_id\":\"doc-2\"}"),
        }, CancellationToken.None)).Payload.GetProperty("verification_hold_id").GetString()!;
        fixture.Transport.SetResponse("{\"success\":true}");
        var stripped = new EvidenceTransformChannel(fixture.Channel, outcome => outcome with { ProcessAttestation = null });
        var strippedDispatcher = new RbpInvocationDispatcher(store, stripped, new RbpInFlightGate());
        _ = await strippedDispatcher.DispatchAsync(
            VerificationRequest(Fourth, secondHold, "{\"kind\":\"document\",\"document_id\":\"doc-2\"}"),
            CancellationToken.None);
        await AssertIneligibleAsync(store, secondHold, Fourth);
    }

    [Fact]
    public async Task DurableUnregisterIntentBetweenResponseAndTerminalSuppressesCandidateAcrossReopen()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RoutedFixture("{}", -32603);
        RbpJournalStore store = await OpenForRoute(directory, fixture);
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        string holdId = (await dispatcher.DispatchAsync(Request(true), CancellationToken.None)).Payload.GetProperty("verification_hold_id").GetString()!;
        fixture.Transport.SetResponse("{\"success\":true}");
        fixture.Transport.BeforeReturn = () => store.RecordUnregisterIntentAsync(
            Rsid, RbpSessionUnregisterReason.OperatorRequested).GetAwaiter().GetResult();

        _ = await dispatcher.DispatchAsync(VerificationRequest(Second, holdId), CancellationToken.None);
        await AssertIneligibleAsync(store, holdId, Second);
        await store.DisposeAsync();

        await using RbpJournalStore reopened = RbpJournalStore.Open(directory.JournalPath,
            new TestResumeTokenProtector(), RbpJournalTestData.Options());
        await AssertIneligibleAsync(reopened, holdId, Second);
    }

    [Fact]
    public async Task FirstCandidateIsImmutableAndReplayBindingCannotChange()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenForRoute(directory, fixture);
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        string holdId = (await dispatcher.DispatchAsync(Request(true), CancellationToken.None)).Payload.GetProperty("verification_hold_id").GetString()!;
        fixture.Transport.SetResponse("{\"success\":true}");
        _ = await dispatcher.DispatchAsync(VerificationRequest(Second, holdId), CancellationToken.None);
        RbpVerificationHold first = (await store.GetHoldAsync(Rsid, holdId))!;

        _ = await dispatcher.DispatchAsync(VerificationRequest(Third, holdId), CancellationToken.None);
        RbpVerificationHold after = (await store.GetHoldAsync(Rsid, holdId))!;
        Assert.Equal(first.VerificationInvocationId, after.VerificationInvocationId);
        Assert.Equal(first.EvidenceDigest, after.EvidenceDigest);
        Assert.False(Json((await store.GetInvocationAsync(Rsid + "/" + Third))!.VerificationCorrelationJson!)
            .GetProperty("terminal").GetProperty("eligible").GetBoolean());

        RbpInvocationAnswer mismatch = await dispatcher.DispatchAsync(
            VerificationRequest(Second, "vh:" + new string('c', 64)), CancellationToken.None);
        Assert.Equal("protocol", mismatch.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(3, fixture.Transport.Calls);
    }

    [Fact]
    public async Task CandidateSurvivesReopenAndOnlyMatchingClearanceClearsIt()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RoutedFixture("{}", -32603);
        RbpJournalStore store = await OpenForRoute(directory, fixture);
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        string holdId = (await dispatcher.DispatchAsync(Request(true), CancellationToken.None)).Payload.GetProperty("verification_hold_id").GetString()!;
        fixture.Transport.SetResponse("{\"success\":true}");
        _ = await dispatcher.DispatchAsync(VerificationRequest(Second, holdId), CancellationToken.None);
        RbpVerificationHold candidate = (await store.GetHoldAsync(Rsid, holdId))!;
        await store.DisposeAsync();

        await using RbpJournalStore reopened = RbpJournalStore.Open(directory.JournalPath,
            new TestResumeTokenProtector(), RbpJournalTestData.Options());
        var reopenedDispatcher = new RbpInvocationDispatcher(reopened, fixture.Channel, new RbpInFlightGate());
        _ = await reopenedDispatcher.DispatchAsync(VerificationRequest(Second, holdId), CancellationToken.None);
        Assert.Equal(2, fixture.Transport.Calls);
        _ = await reopenedDispatcher.DispatchAsync(
            ClearanceRequest(Fourth, holdId, candidate.VerificationInvocationId!, candidate.EvidenceDigest!),
            CancellationToken.None);
        Assert.Equal(RbpHoldState.Cleared, (await reopened.GetHoldAsync(Rsid, holdId))!.State);

        RbpInvocationAnswer refused = await reopenedDispatcher.DispatchAsync(
            VerificationRequest(Fifth, holdId), CancellationToken.None);
        Assert.Equal("protocol", refused.Payload.GetProperty("fault_class").GetString());
        Assert.Null(await reopened.GetInvocationAsync(Rsid + "/" + Fifth));
    }

    [Fact]
    public async Task ClosedTerminalShapeIsRevalidatedBeforeReplay()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenForRoute(directory, fixture);
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        string holdId = (await dispatcher.DispatchAsync(Request(true), CancellationToken.None)).Payload.GetProperty("verification_hold_id").GetString()!;
        fixture.Transport.SetResponse("{\"success\":true}");
        _ = await dispatcher.DispatchAsync(VerificationRequest(Second, holdId), CancellationToken.None);
        RbpStoredInvocation stored = (await store.GetInvocationAsync(Rsid + "/" + Second))!;
        JsonElement correlation = Json(stored.VerificationCorrelationJson!);
        JsonElement terminal = correlation.GetProperty("terminal");
        string malformed = Rfc8785Json.Canonicalize(JsonSerializer.SerializeToElement(new
        {
            schema = "bridge.verification-correlation/v1",
            rsid = Rsid,
            invocation_id = Second,
            verification = correlation.GetProperty("verification"),
            terminal = new
            {
                status = terminal.GetProperty("status").GetString(),
                raw_response_digest = terminal.GetProperty("raw_response_digest").GetString(),
                eligible = true,
                extra = "not-closed",
            },
        }));
        using (var connection = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={directory.JournalPath};Pooling=False"))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "UPDATE rbp_invocations SET verification_correlation_json=$json WHERE idempotency_key=$key;";
            command.Parameters.AddWithValue("$json", malformed);
            command.Parameters.AddWithValue("$key", Rsid + "/" + Second);
            Assert.Equal(1, command.ExecuteNonQuery());
        }

        RbpInvocationAnswer replay = await dispatcher.DispatchAsync(VerificationRequest(Second, holdId), CancellationToken.None);
        Assert.Equal("protocol", replay.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(2, fixture.Transport.Calls);
    }

    [Fact]
    public async Task OmittedTerminalPayloadCannotBecomeCandidate()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenForRoute(directory, fixture);
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        string holdId = (await dispatcher.DispatchAsync(Request(true), CancellationToken.None)).Payload.GetProperty("verification_hold_id").GetString()!;
        RbpInvokeRequest verification = VerificationRequest(Second, holdId);
        RbpInvocationIdentity identity = verification.ToIdentity();
        _ = await store.AdmitInvocationAsync(identity, verification: verification.Verification);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        byte[] raw = System.Text.Encoding.UTF8.GetBytes($"{{\"jsonrpc\":\"2.0\",\"id\":\"{Second}\",\"result\":{{\"resultContractVersion\":2,\"success\":true}}}}");
        string digest = "sha256:" + Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant();
        var attestation = new AddinProcessAttestation(new AddinProcessIdentity(4242, 133000000000004242),
            "2026", @"C:\Program Files\Autodesk\Revit 2026\Revit.exe");
        var evidence = new RbpAddinOutcome(RbpAddinOutcomeKind.Completed,
            JsonSerializer.SerializeToElement(new { resultContractVersion = 2, success = true }), raw, 1, raw.Length,
            ProcessAttestation: attestation, RouteLocalSessionKey: fixture.Route.Handle!.LocalSessionKey);
        _ = await store.PersistInvocationTerminalAsync(identity.IdempotencyKey,
            new RbpInvocationTerminal(RbpInvocationState.Completed,
                JsonSerializer.SerializeToElement(new { kind = "invocation", payload_omitted = true }), digest),
            expectedIdentity: identity, responseEvidence: evidence);

        RbpStoredInvocation stored = (await store.GetInvocationAsync(Rsid + "/" + Second))!;
        JsonElement terminal = Json(stored.VerificationCorrelationJson!).GetProperty("terminal");
        Assert.False(terminal.GetProperty("eligible").GetBoolean());
        Assert.Equal(digest, terminal.GetProperty("raw_response_digest").GetString());
        Assert.Equal(RbpHoldState.Active, (await store.GetHoldAsync(Rsid, holdId))!.State);
    }

    [Fact]
    public async Task AtomicRepeatedScopeGroupClearsAndAdmitsExactlyOneAuditedNextBatch()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RoutedFixture("{}", -32602);
        await using RbpJournalStore store = await OpenForRoute(directory, fixture);
        var coordinator = new RbpBatchCoordinator(
            store, fixture.Channel, StubBatchCapabilities.Standard(true));
        JsonElement originPayload = Payload(Batch, atomic: true, [Write(First), Write(Second)]);

        RbpInvocationAnswer uncertain = await coordinator.DispatchAsync(
            Rsid, originPayload, CancellationToken.None);
        Assert.Equal("indeterminate", uncertain.Payload.GetProperty("transaction_state").GetString());
        RbpStoredInvocation firstOrigin = (await store.GetInvocationAsync(Rsid + "/" + First))!;
        RbpStoredInvocation secondOrigin = (await store.GetInvocationAsync(Rsid + "/" + Second))!;
        Assert.Equal(firstOrigin.VerificationHoldId, secondOrigin.VerificationHoldId);
        string holdId = firstOrigin.VerificationHoldId!;
        string[] orderedOrigins = [Rsid + "/" + First, Rsid + "/" + Second];
        RbpVerificationHold grouped = (await store.GetHoldAsync(Rsid, holdId))!;
        Assert.Equal(orderedOrigins, grouped.OrderedOriginIdempotencyKeys);
        Assert.Equal(1, fixture.Transport.Calls);

        fixture.Transport.SetResponse("{\"success\":true,\"observed\":\"group-postcondition-context\"}");
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        _ = await dispatcher.DispatchAsync(
            VerificationRequest(Third, holdId, DocumentScope), CancellationToken.None);
        RbpVerificationHold candidate = (await store.GetHoldAsync(Rsid, holdId))!;
        Assert.Equal(RbpHoldState.EvidenceRecorded, candidate.State);
        Assert.Equal(Third, candidate.VerificationInvocationId);
        Assert.NotNull(candidate.EvidenceDigest);
        Assert.Null(candidate.ResolutionId);
        Assert.Null(candidate.ResolutionDecision);
        Assert.Null(candidate.AuditId);
        Assert.Equal(orderedOrigins, candidate.OrderedOriginIdempotencyKeys);
        Assert.Equal(2, fixture.Transport.Calls);

        string wrongClearance = ClearanceArrayJson(
            holdId, Third, "sha256:" + new string('a', 64));
        JsonElement wrongPayload = Payload(
            WrongClearanceBatch, atomic: true, [Write(Fifth)],
            recoveryClearancesJson: wrongClearance);
        RbpInvocationAnswer denied = await coordinator.DispatchAsync(
            Rsid, wrongPayload, CancellationToken.None);
        Assert.Equal("error", denied.Type);
        Assert.Equal("protocol", denied.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(2, fixture.Transport.Calls);
        Assert.Null(await store.GetBatchAsync(Rsid + "/" + WrongClearanceBatch));
        Assert.Null(await store.GetInvocationAsync(Rsid + "/" + Fifth));
        Assert.Equal(RbpHoldState.EvidenceRecorded, (await store.GetHoldAsync(Rsid, holdId))!.State);

        string exactClearance = ClearanceArrayJson(
            holdId, Third, candidate.EvidenceDigest!);
        JsonElement nextPayload = Payload(
            ClearedNextBatch, atomic: true, [Write(Fourth)],
            recoveryClearancesJson: exactClearance);
        RbpAddinOutcome native = AtomicEnvelope(
            ClearedNextBatch,
            nextPayload.GetProperty("batch_digest").GetString()!,
            [new AtomicStepSpec(
                Fourth, WriteMethod, "completed", "committed",
                ResultJson: "{\"ok\":true}")]);
        fixture.Transport.SetResponse(native.Result.GetRawText());
        RbpVerificationHold? holdObservedAtDispatch = null;
        RbpStoredBatch? batchObservedAtDispatch = null;
        fixture.Transport.BeforeReturn = () =>
        {
            holdObservedAtDispatch = store.GetHoldAsync(Rsid, holdId).GetAwaiter().GetResult();
            batchObservedAtDispatch = store.GetBatchAsync(
                Rsid + "/" + ClearedNextBatch).GetAwaiter().GetResult();
        };

        int callsBeforeNext = fixture.Transport.Calls;
        RbpInvocationAnswer admitted = await coordinator.DispatchAsync(
            Rsid, nextPayload, CancellationToken.None);

        Assert.Equal(callsBeforeNext + 1, fixture.Transport.Calls);
        Assert.Equal("result", admitted.Type);
        Assert.Equal(RbpHoldState.Cleared, holdObservedAtDispatch!.State);
        Assert.Equal(RbpBatchState.Dispatched, batchObservedAtDispatch!.State);
        RbpVerificationHold cleared = (await store.GetHoldAsync(Rsid, holdId))!;
        Assert.Equal(RbpHoldState.Cleared, cleared.State);
        Assert.Equal(Resolution, cleared.ResolutionId);
        Assert.Equal(Audit, cleared.AuditId);
        Assert.Equal(orderedOrigins, cleared.OrderedOriginIdempotencyKeys);
        Assert.Equal(RbpInvocationState.Indeterminate,
            (await store.GetInvocationAsync(Rsid + "/" + First))!.State);
        Assert.Equal(RbpInvocationState.Indeterminate,
            (await store.GetInvocationAsync(Rsid + "/" + Second))!.State);
    }

    [Theory]
    [InlineData("failed", "{\"success\":false}", true)]
    [InlineData("completed", "{\"success\":true}", false)]
    public async Task LegacyUnsafeUnlinkedOriginIsAcceptedButCompletedSafeOriginIsRejected(
        string originState,
        string terminalOutcome,
        bool accepted)
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenForRoute(directory, fixture);
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        string holdId = (await dispatcher.DispatchAsync(
            Request(true), CancellationToken.None)).Payload
            .GetProperty("verification_hold_id").GetString()!;
        using (var connection = new Microsoft.Data.Sqlite.SqliteConnection(
            $"Data Source={directory.JournalPath};Pooling=False"))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText =
                "UPDATE rbp_invocations SET state=$state, terminal_outcome_json=$outcome, " +
                "verification_hold_id=NULL " +
                "WHERE idempotency_key=$key;";
            command.Parameters.AddWithValue("$state", originState);
            command.Parameters.AddWithValue("$outcome", terminalOutcome);
            command.Parameters.AddWithValue("$key", Rsid + "/" + First);
            Assert.Equal(1, command.ExecuteNonQuery());
        }
        fixture.Transport.SetResponse("{\"success\":true}");

        RbpInvocationAnswer refused = await dispatcher.DispatchAsync(
            VerificationRequest(Second, holdId), CancellationToken.None);

        if (accepted)
        {
            Assert.Equal("result", refused.Type);
            Assert.Equal(2, fixture.Transport.Calls);
            Assert.Equal(RbpInvocationState.Completed,
                (await store.GetInvocationAsync(Rsid + "/" + Second))!.State);
            Assert.Equal(RbpHoldState.EvidenceRecorded,
                (await store.GetHoldAsync(Rsid, holdId))!.State);
        }
        else
        {
            Assert.Equal("protocol", refused.Payload.GetProperty("fault_class").GetString());
            Assert.Equal(1, fixture.Transport.Calls);
            Assert.Null(await store.GetInvocationAsync(Rsid + "/" + Second));
            Assert.Equal(RbpHoldState.Active, (await store.GetHoldAsync(Rsid, holdId))!.State);
        }
    }

    [Fact]
    public async Task CallerConclusiveFlagCannotManufactureEvidence()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenForRoute(directory, fixture);
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        string holdId = (await dispatcher.DispatchAsync(Request(true), CancellationToken.None)).Payload.GetProperty("verification_hold_id").GetString()!;
        await Assert.ThrowsAsync<RbpJournalException>(() => store.RecordHoldVerificationEvidenceAsync(Rsid,
            new RbpHoldVerificationEvidence(holdId, Second, "sha256:" + new string('a', 64), Conclusive: true)));
        Assert.Equal(RbpHoldState.Active, (await store.GetHoldAsync(Rsid, holdId))!.State);
        Assert.Equal(1, fixture.Transport.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task VerificationTerminalAndCandidateHaveOneDurableDecision(bool afterCommit)
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RoutedFixture("{}", -32603);
        var faults = new DecisionFaults();
        await using RbpJournalStore store = await OpenForRoute(directory, fixture, faults);
        var dispatcher = new RbpInvocationDispatcher(store, fixture.Channel, new RbpInFlightGate());
        string holdId = (await dispatcher.DispatchAsync(Request(true), CancellationToken.None)).Payload.GetProperty("verification_hold_id").GetString()!;
        fixture.Transport.SetResponse("{\"success\":true}");
        fixture.Transport.BeforeReturn = () => faults.Arm(afterCommit ? RbpJournalFaultPoint.AfterCommitBeforeReturn : RbpJournalFaultPoint.BeforeCommit,
            afterCommit ? 1 : 2);
        RbpInvokeRequest read = VerificationRequest(Second, holdId);
        if (afterCommit)
        {
            _ = await dispatcher.DispatchAsync(read, CancellationToken.None);
            Assert.Equal(RbpInvocationState.Completed, (await store.GetInvocationAsync(Rsid + "/" + Second))!.State);
            Assert.Equal(RbpHoldState.EvidenceRecorded, (await store.GetHoldAsync(Rsid, holdId))!.State);
        }
        else
        {
            await Assert.ThrowsAsync<IOException>(() => dispatcher.DispatchAsync(read, CancellationToken.None));
            Assert.Equal(RbpInvocationState.Executing, (await store.GetInvocationAsync(Rsid + "/" + Second))!.State);
            Assert.Equal(RbpHoldState.Active, (await store.GetHoldAsync(Rsid, holdId))!.State);
            Assert.True(RbpDispatchDecisionQuarantine.For(fixture.Channel).IsBlocked(Rsid));
        }
        Assert.Equal(2, fixture.Transport.Calls);
    }

    internal static async Task<RbpJournalStore> OpenForRoute(RbpJournalTestDirectory directory, RoutedFixture fixture,
        IRbpJournalFaultInjector? fault = null)
    {
        RbpJournalStore store = RbpJournalStore.Open(directory.JournalPath, new TestResumeTokenProtector(), RbpJournalTestData.Options(faultInjector: fault));
        await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration(localSessionKey: fixture.Route.Handle!.LocalSessionKey));
        return store;
    }

    private static async Task AssertIneligibleAsync(RbpJournalStore store, string holdId, string invocationId)
    {
        RbpStoredInvocation stored = (await store.GetInvocationAsync(Rsid + "/" + invocationId))!;
        JsonElement terminal = Json(stored.VerificationCorrelationJson!).GetProperty("terminal");
        Assert.False(terminal.GetProperty("eligible").GetBoolean());
        Assert.Equal(stored.ResultDigest, terminal.GetProperty("raw_response_digest").GetString());
        Assert.Equal(RbpHoldState.Active, (await store.GetHoldAsync(Rsid, holdId))!.State);
    }

    private static RbpInvokeRequest ClearanceRequest(
        string id, string holdId, string verificationInvocationId, string evidenceDigest) =>
        Request(true, id) with
        {
            RecoveryClearances = JsonSerializer.SerializeToElement(new[]
            {
                new
                {
                    hold_id = holdId,
                    mutation_scope = Json(DocumentScope),
                    resolution_id = Resolution,
                    basis = "verification_read",
                    verification_invocation_id = verificationInvocationId,
                    evidence_digest = evidenceDigest,
                    decision = "postcondition_verified",
                    audit_id = Audit,
                },
            }),
        };

    private static string ClearanceArrayJson(
        string holdId,
        string verificationInvocationId,
        string evidenceDigest) =>
        JsonSerializer.Serialize(new[]
        {
            new
            {
                hold_id = holdId,
                mutation_scope = Json(DocumentScope),
                resolution_id = Resolution,
                basis = "verification_read",
                verification_invocation_id = verificationInvocationId,
                evidence_digest = evidenceDigest,
                decision = "postcondition_verified",
                audit_id = Audit,
            },
        });

    private sealed class EvidenceTransformChannel(
        IRbpInvocationChannel inner,
        Func<RbpAddinOutcome, RbpAddinOutcome> transform) : IRbpInvocationChannel
    {
        public async Task<RbpAddinOutcome> InvokeAsync(string rsid, AddinCall call, CancellationToken cancellationToken) =>
            transform(await inner.InvokeAsync(rsid, call, cancellationToken));
    }

    internal static RbpInvokeRequest VerificationRequest(string id, string holdId, string scope = DocumentScope) =>
        Request(false, id) with
        {
            Verification = JsonSerializer.SerializeToElement(new
            {
                hold_id = holdId,
                mutation_scope = Json(scope),
                purpose = "resolve_indeterminate",
            }),
        };
}
