using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Dispatch;

/// <summary>
/// Frozen O1 Section 6.2.1 conformance for the invoke path: a Gateway-authored
/// <c>recovery_clearances</c> envelope reaches the clearance-gated admission,
/// where the bridge "MUST match the clearance to its active hold and durable
/// evidence, then atomically mark the hold <c>cleared</c> with acceptance of
/// the new invocation before any add-in byte", while an invoke that carries no
/// clearance keeps the ordinary Section 12.2 admission.
/// </summary>
public sealed class RbpInvocationClearanceGateTests
{
    [Fact]
    public async Task StoredEligibleV1CorrelationIsReadableButCannotClear()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture(
            "{}", -32603);
        await using RbpJournalStore store = await OpenAsync(directory, fixture);
        string holdId = await InstallEvidencedHoldAsync(store, fixture);
        RbpVerificationHold hold = (await store.GetHoldAsync(Rsid, holdId))!;
        RbpStoredInvocation read = (await store.GetInvocationAsync(
            Rsid + "/" + VerificationId))!;
        JsonElement current = JsonDocument.Parse(
            read.VerificationCorrelationJson!).RootElement.Clone();
        string v1 = Rfc8785Json.Canonicalize(
            JsonSerializer.SerializeToElement(new
            {
                schema = "bridge.verification-correlation/v1",
                rsid = Rsid,
                invocation_id = VerificationId,
                verification = current.GetProperty("verification"),
                terminal = new
                {
                    status = "completed",
                    raw_response_digest = hold.EvidenceDigest,
                    eligible = true,
                },
            }));
        using (var connection = new SqliteConnection(
            $"Data Source={directory.JournalPath};Pooling=False"))
        {
            connection.Open();
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText = "UPDATE rbp_invocations SET verification_correlation_json=$v1 WHERE idempotency_key=$key;";
            command.Parameters.AddWithValue("$v1", v1);
            command.Parameters.AddWithValue("$key", Rsid + "/" + VerificationId);
            Assert.Equal(1, command.ExecuteNonQuery());
        }

        RbpInvocationAnswer denied = await Dispatcher(
            store, new CountingChannel()).DispatchAsync(
            WriteRequest(clearances: ClearanceArray(
                holdId, hold.EvidenceDigest!)), CancellationToken.None);

        Assert.Equal("error", denied.Type);
        Assert.Equal("protocol",
            denied.Payload.GetProperty("fault_class").GetString());
        Assert.Equal(RbpHoldState.EvidenceRecorded,
            (await store.GetHoldAsync(Rsid, holdId))!.State);
        Assert.Equal(v1, (await store.GetInvocationAsync(
            Rsid + "/" + VerificationId))!.VerificationCorrelationJson);
    }

    private const string Rsid = "rs-test";
    private const string WriteMethod = "create_wall";
    private const string DocumentScope =
        """{"document_id":"doc-1","kind":"document"}""";
    private const string OtherDocumentScope =
        """{"document_id":"doc-2","kind":"document"}""";
    private const string OriginInvocationId =
        "0197a3c2-0000-7000-8000-0000000000b2";
    private const string FreshInvocationId =
        "0197a3c2-0000-7000-8000-0000000000f4";
    private const string VerificationId =
        "0197a3c2-0000-7000-8000-0000000000e1";
    private const string ResolutionId =
        "0197a3c2-0000-7000-8000-000000000101";
    private const string AuditId =
        "0197a3c2-0000-7000-8000-000000000102";

    [Fact]
    public async Task AnInvokeCarryingClearancesClearsItsHoldAndDispatches()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenAsync(directory, fixture);
        string holdId = await InstallEvidencedHoldAsync(store, fixture);
        string evidenceDigest = (await store.GetHoldAsync(Rsid, holdId))!.EvidenceDigest!;

        var channel = new CountingChannel();
        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                WriteRequest(clearances: ClearanceArray(holdId, evidenceDigest)),
                CancellationToken.None);

        // Only the clearance-gated admission can move a hold to `cleared`;
        // the ordinary admission never touches the hold relation, so this
        // state proves the invoke went through the gated path.
        Assert.Equal("result", answer.Type);
        Assert.Equal(1, channel.Calls);
        RbpVerificationHold? hold = await store.GetHoldAsync(Rsid, holdId);
        Assert.Equal(RbpHoldState.Cleared, hold!.State);
        Assert.Equal(ResolutionId, hold.ResolutionId);
        Assert.Equal(AuditId, hold.AuditId);
    }

    [Fact]
    public async Task AClearanceThatMatchesNoHoldIsTerminalWithoutAddinBytes()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenAsync(directory, fixture);
        string holdId = await InstallEvidencedHoldAsync(store, fixture);
        string evidenceDigest = (await store.GetHoldAsync(Rsid, holdId))!.EvidenceDigest!;

        var channel = new CountingChannel();
        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                WriteRequest(
                    clearances: ClearanceArray(
                        "vh:" + new string('a', 64),
                        evidenceDigest)),
                CancellationToken.None);

        // With the gate unwired this clearance would simply be ignored and
        // the mutation would reach the add-in.
        Assert.Equal(0, channel.Calls);
        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "protocol",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.False(answer.Payload.GetProperty("retryable").GetBoolean());
        Assert.Equal(
            RbpHoldState.EvidenceRecorded,
            (await store.GetHoldAsync(Rsid, holdId))!.State);
        Assert.Null(
            await store.GetInvocationAsync(Rsid + "/" + FreshInvocationId));
    }

    [Fact]
    public async Task AMalformedClearanceEntryFailsClosedAtTheBoundary()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenAsync(directory, fixture);
        _ = await InstallEvidencedHoldAsync(store, fixture);

        var channel = new CountingChannel();
        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                WriteRequest(
                    clearances:
                        """[{"hold_id":"not-a-hold-id"}]"""),
                CancellationToken.None);

        Assert.Equal(0, channel.Calls);
        Assert.Equal("error", answer.Type);
        Assert.Equal(
            "protocol",
            answer.Payload.GetProperty("fault_class").GetString());
        Assert.Null(
            await store.GetInvocationAsync(Rsid + "/" + FreshInvocationId));
    }

    [Fact]
    public async Task AnEmptyClearanceArrayKeepsTheOrdinaryAdmission()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", -32603);
        await using RbpJournalStore store = await OpenAsync(directory, fixture);

        // The hold is on another document, so the Section 6.2.1 conflict
        // block (spec ~480-485) does not apply and this test can isolate the
        // question it exists to answer: which admission an empty
        // `recovery_clearances` array reaches. A hold on `doc-1` would refuse
        // this write outright, which `RbpInvocationConflictGateTests` covers.
        string holdId = await InstallEvidencedHoldAsync(
            store,
            fixture,
            OtherDocumentScope);

        var channel = new CountingChannel();
        RbpInvocationAnswer answer =
            await Dispatcher(store, channel).DispatchAsync(
                WriteRequest(),
                CancellationToken.None);

        // Unchanged Section 12.2 behaviour: the envelope carries no
        // clearance, so it is admitted exactly as before and the hold is
        // left untouched.
        Assert.Equal("result", answer.Type);
        Assert.Equal(1, channel.Calls);
        Assert.Equal(
            RbpHoldState.EvidenceRecorded,
            (await store.GetHoldAsync(Rsid, holdId))!.State);
    }

    private static RbpInvocationDispatcher Dispatcher(
        RbpJournalStore store,
        IRbpInvocationChannel channel) =>
        new(store, channel, new RbpInFlightGate());

    private static async Task<RbpJournalStore> OpenAsync(
        RbpJournalTestDirectory directory,
        RbpApplicationErrorSafetyTests.RoutedFixture fixture)
    {
        RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                localSessionKey: fixture.Route.Handle!.LocalSessionKey));
        await RbpJournalStoreProductionEvidence.BindInvocationAuthorityAsync(
            store, fixture);
        return store;
    }

    /// <summary>
    /// Leaves one active hold on the supplied scope (<c>doc-1</c> by default)
    /// with durable conclusive verification evidence, which is the only state
    /// a <c>verification_read</c> clearance may be accepted from.
    /// </summary>
    private static async Task<string> InstallEvidencedHoldAsync(
        RbpJournalStore store,
        RbpApplicationErrorSafetyTests.RoutedFixture fixture,
        string scopeJcs = DocumentScope)
    {
        var origin = new RbpInvocationIdentity(
            Rsid,
            OriginInvocationId,
            WriteMethod,
            Mutating: true,
            MutationScopeJcs: scopeJcs,
            ParamsDigest: "sha256:" + new string('a', 64),
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");
        _ = await store.AdmitInvocationAsync(origin);
        await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
        RbpInvocationAdmissionResult refused =
            await store.AdmitInvocationAsync(origin);
        string holdId = refused.VerificationHoldId!;
        fixture.Transport.SetResponse("""{"success":true}""", null);
        RbpInvocationAnswer verification = await
            RbpCorrelatedVerificationFlowTests.DispatchVerificationAsync(
                Dispatcher(store, fixture.Channel),
                fixture,
                VerificationReadRequest(holdId, scopeJcs));
        Assert.Equal("result", verification.Type);
        Assert.Equal(
            RbpHoldState.EvidenceRecorded,
            (await store.GetHoldAsync(Rsid, holdId))!.State);
        return holdId;
    }

    private static string ClearanceArray(string holdId, string evidenceDigest) =>
        $$"""
        [
          {
            "hold_id": "{{holdId}}",
            "mutation_scope": {"kind":"document","document_id":"doc-1"},
            "resolution_id": "{{ResolutionId}}",
            "basis": "verification_read",
            "verification_invocation_id": "{{VerificationId}}",
            "evidence_digest": "{{evidenceDigest}}",
            "decision": "postcondition_verified",
            "audit_id": "{{AuditId}}"
          }
        ]
        """;

    private static RbpInvokeRequest WriteRequest(string clearances = "[]")
    {
        string payload =
            $$"""
            {
              "invocation_id": "{{FreshInvocationId}}",
              "method": "{{WriteMethod}}",
              "params": {"length": 3000},
              "timeout_ms": 120000,
              "mutating": true,
              "mutation_scope": {"kind":"document","document_id":"doc-1"},
              "policy": {"class":"confirm","decision":"confirmed","confirmation_id":"c1"},
              "verification": null,
              "recovery_clearances": {{clearances}}
            }
            """;
        using JsonDocument document = JsonDocument.Parse(payload);
        return RbpInvokeRequest.Parse(Rsid, document.RootElement.Clone());
    }

    private static RbpInvokeRequest VerificationReadRequest(
        string holdId,
        string scopeJcs)
    {
        string payload =
            $$"""
            {
              "invocation_id": "{{VerificationId}}",
              "method": "get_element_parameter",
              "params": {"element_id": 42},
              "timeout_ms": 30000,
              "mutating": false,
              "mutation_scope": null,
              "policy": {"class":"read","decision":"allow"},
              "verification": {
                "hold_id": "{{holdId}}",
                "mutation_scope": {{scopeJcs}},
                "purpose": "resolve_indeterminate"
              },
              "recovery_clearances": []
            }
            """;
        using JsonDocument document = JsonDocument.Parse(payload);
        return RbpInvokeRequest.Parse(Rsid, document.RootElement.Clone());
    }

    private sealed class CountingChannel : IRbpInvocationChannel
    {
        private int _calls;

        internal int Calls => Volatile.Read(ref _calls);

        public Task<RbpAddinOutcome> InvokeAsync(
            string rsid,
            AddinCall call,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _calls);
            byte[] raw = Encoding.UTF8.GetBytes("""{"ok":true}""");
            using JsonDocument document = JsonDocument.Parse(raw);
            return Task.FromResult(
                new RbpAddinOutcome(
                    RbpAddinOutcomeKind.Completed,
                    document.RootElement.Clone(),
                    raw,
                    RequestBytes: 128,
                    ResponseBytes: raw.Length));
        }
    }
}
