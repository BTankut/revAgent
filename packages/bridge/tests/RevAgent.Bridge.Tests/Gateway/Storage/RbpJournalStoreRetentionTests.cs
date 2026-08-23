using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

/// <summary>
/// Frozen O1 Section 12.2 retention conformance: the seven-day floor, the
/// fourteen-day default, and the absolute guards — non-terminal rows and
/// uncleared holds (with everything they reference) are never pruned, while
/// terminal rows and cleared holds outside the window are pruned with exact
/// counts.
/// </summary>
public sealed class RbpJournalStoreRetentionTests
{
    private const string ReadMethod = "get_current_view_info";
    private const string WriteMethod = "create_wall";
    private const string DocumentScope =
        """{"document_id":"doc-1","kind":"document"}""";
    private const string VerificationId =
        "0197a3c2-0000-7000-8000-0000000000e1";
    private const string ResolutionId =
        "0197a3c2-0000-7000-8000-000000000101";
    private const string AuditId =
        "0197a3c2-0000-7000-8000-000000000102";

    private static readonly string EvidenceDigest =
        "sha256:" + new string('d', 64);

    private long _nowMilliseconds =
        RbpJournalTestData.Now.ToUnixTimeMilliseconds();

    [Fact]
    public async Task TheFrozenSevenDayRetentionFloorIsEnforced()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(
            () => store.ApplyRetentionAsync(TimeSpan.Zero));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(
            () => store.ApplyRetentionAsync(
                TimeSpan.FromDays(7) - TimeSpan.FromMilliseconds(1)));

        // The floor itself and the fourteen-day default are both legal.
        RbpJournalRetentionResult atFloor =
            await store.ApplyRetentionAsync(TimeSpan.FromDays(7));
        RbpJournalRetentionResult atDefault =
            await store.ApplyRetentionAsync();
        Assert.Equal(new RbpJournalRetentionResult(0, 0, 0, 0, 0), atFloor);
        Assert.Equal(new RbpJournalRetentionResult(0, 0, 0, 0, 0), atDefault);
    }

    [Fact]
    public async Task TerminalRowsOutsideTheWindowArePrunedWithExactCounts()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(expiresInHours: 24 * 365));
        RbpInvocationIdentity old = ReadIdentity(
            "0197a3c2-0000-7000-8000-0000000000a1");
        await CompleteReadAsync(store, old);

        // Ten days is inside the fourteen-day default: nothing is pruned.
        AdvanceDays(10);
        RbpJournalRetentionResult inside = await store.ApplyRetentionAsync();
        Assert.Equal(new RbpJournalRetentionResult(0, 0, 0, 0, 0), inside);
        Assert.NotNull(await store.GetInvocationAsync(old.IdempotencyKey));

        // A second terminal row is only five days old at sweep time and
        // must survive while the fifteen-day-old row is pruned.
        RbpInvocationIdentity young = ReadIdentity(
            "0197a3c2-0000-7000-8000-0000000000a2");
        await CompleteReadAsync(store, young);
        AdvanceDays(5);

        RbpJournalRetentionResult outside = await store.ApplyRetentionAsync();

        Assert.Equal(1, outside.PrunedInvocations);
        Assert.Equal(0, outside.PrunedClearedHolds);
        Assert.Equal(0, outside.PrunedInboundReceipts);
        Assert.Equal(0, outside.PrunedOutboxEnvelopes);
        Assert.Equal(0, outside.PrunedTransportSessions);
        Assert.Null(await store.GetInvocationAsync(old.IdempotencyKey));
        Assert.NotNull(await store.GetInvocationAsync(young.IdempotencyKey));
    }

    [Fact]
    public async Task UnacknowledgedCarrierDoesNotBlockPairedOrOrdinaryRetention()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(expiresInHours: 24 * 365));
        RbpInvocationIdentity acknowledged = ReadIdentity(
            "0197a3c2-0000-7000-8000-0000000000c1");
        RbpInvocationIdentity unacknowledged = ReadIdentity(
            "0197a3c2-0000-7000-8000-0000000000c2");
        RbpInvocationIdentity ordinary = ReadIdentity(
            "0197a3c2-0000-7000-8000-0000000000c3");
        await CompleteReadAsync(store, acknowledged);
        await CompleteReadAsync(store, unacknowledged);
        await CompleteReadAsync(store, ordinary);
        await AttachCarrierPlanAsync(store, acknowledged, 'a', acknowledged: true);
        await AttachCarrierPlanAsync(store, unacknowledged, 'b', acknowledged: false);

        AdvanceDays(8);
        RbpJournalRetentionResult swept = await store.ApplyRetentionAsync(
            RbpJournalStore.MinimumRetentionPeriod);

        Assert.Equal(1, swept.PrunedInvocations);
        Assert.Equal(0, swept.PrunedCarrierPlans);
        Assert.NotNull(await store.GetInvocationAsync(acknowledged.IdempotencyKey));
        Assert.Null(await store.GetInvocationAsync(ordinary.IdempotencyKey));
        RbpStoredInvocation retained = Assert.IsType<RbpStoredInvocation>(
            await store.GetInvocationAsync(unacknowledged.IdempotencyKey));
        Assert.NotNull(retained.CarrierPlan);
    }

    [Fact]
    public async Task NonTerminalInvocationsAreNeverPruned()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(expiresInHours: 24 * 365));
        RbpInvocationIdentity received = ReadIdentity(
            "0197a3c2-0000-7000-8000-0000000000a1");
        _ = await store.AdmitInvocationAsync(received);
        RbpInvocationIdentity executing = ReadIdentity(
            "0197a3c2-0000-7000-8000-0000000000a2");
        _ = await store.AdmitInvocationAsync(executing);
        await store.MarkInvocationExecutingAsync(executing.IdempotencyKey);

        AdvanceDays(40);
        RbpJournalRetentionResult swept = await store.ApplyRetentionAsync();

        Assert.Equal(0, swept.PrunedInvocations);
        RbpStoredInvocation? receivedRow =
            await store.GetInvocationAsync(received.IdempotencyKey);
        RbpStoredInvocation? executingRow =
            await store.GetInvocationAsync(executing.IdempotencyKey);
        Assert.Equal(RbpInvocationState.Received, receivedRow?.State);
        Assert.Equal(RbpInvocationState.Executing, executingRow?.State);
    }

    [Fact]
    public async Task UnclearedHoldsAndEverythingTheyReferenceSurvive()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(expiresInHours: 24 * 365));
        RbpInvocationIdentity origin = WriteIdentity();
        string holdId = await InstallIndeterminateHoldAsync(store, origin);
        _ = await store.PersistInvocationTerminalAsync(
            origin.IdempotencyKey,
            Terminal(RbpInvocationState.Completed, """{"late":true}"""));
        _ = await store.RecordHoldVerificationEvidenceAsync(
            "rs-test",
            new RbpHoldVerificationEvidence(
                holdId,
                VerificationId,
                EvidenceDigest,
                Conclusive: true));

        // The hold is uncleared, so neither the hold nor the indeterminate
        // origin row carrying its late evidence may ever be pruned.
        AdvanceDays(40);
        RbpJournalRetentionResult swept = await store.ApplyRetentionAsync();

        Assert.Equal(0, swept.PrunedInvocations);
        Assert.Equal(0, swept.PrunedClearedHolds);
        RbpVerificationHold? hold =
            await store.GetHoldAsync("rs-test", holdId);
        Assert.Equal(RbpHoldState.EvidenceRecorded, hold?.State);
        RbpStoredInvocation? originRow =
            await store.GetInvocationAsync(origin.IdempotencyKey);
        Assert.Equal(RbpInvocationState.Indeterminate, originRow?.State);
        Assert.Equal("""{"late":true}""", originRow?.LateTerminalOutcomeJson);
    }

    [Fact]
    public async Task ClearedHoldsAndTheirEvidenceRemainForTheWindow()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(expiresInHours: 24 * 365));
        RbpInvocationIdentity origin = WriteIdentity();
        string holdId = await InstallIndeterminateHoldAsync(store, origin);
        _ = await store.RecordHoldVerificationEvidenceAsync(
            "rs-test",
            new RbpHoldVerificationEvidence(
                holdId,
                VerificationId,
                EvidenceDigest,
                Conclusive: true));
        RbpInvocationIdentity cleared = WriteIdentity(
            invocationId: "0197a3c2-0000-7000-8000-0000000000f4");
        _ = await store.AdmitInvocationWithClearancesAsync(
            cleared,
            new[]
            {
                new RbpRecoveryClearance(
                    holdId,
                    DocumentScope,
                    ResolutionId,
                    RbpClearanceBasis.VerificationRead,
                    VerificationId,
                    EvidenceDigest,
                    RbpClearanceDecision.PostconditionVerified,
                    AuditId),
            });
        await store.MarkInvocationExecutingAsync(cleared.IdempotencyKey);
        _ = await store.PersistInvocationTerminalAsync(
            cleared.IdempotencyKey,
            Terminal(RbpInvocationState.Completed, """{"ok":true}"""));

        // Inside the window the cleared hold and its evidence remain.
        AdvanceDays(10);
        RbpJournalRetentionResult inside = await store.ApplyRetentionAsync();
        Assert.Equal(new RbpJournalRetentionResult(0, 0, 0, 0, 0), inside);
        Assert.NotNull(await store.GetHoldAsync("rs-test", holdId));

        // Outside the window the origin evidence rows and the cleared hold
        // are pruned together, deterministically, with exact counts.
        AdvanceDays(5);
        RbpJournalRetentionResult outside = await store.ApplyRetentionAsync();
        Assert.Equal(2, outside.PrunedInvocations);
        Assert.Equal(1, outside.PrunedClearedHolds);
        Assert.Null(await store.GetHoldAsync("rs-test", holdId));
        Assert.Null(await store.GetInvocationAsync(origin.IdempotencyKey));
        Assert.Null(await store.GetInvocationAsync(cleared.IdempotencyKey));

        // A second sweep over the same durable state prunes nothing.
        RbpJournalRetentionResult repeat = await store.ApplyRetentionAsync();
        Assert.Equal(new RbpJournalRetentionResult(0, 0, 0, 0, 0), repeat);
    }

    [Fact]
    public async Task TransportRowsArePrunedOnlyPerLongExpiredSession()
    {
        using var directory = new RbpJournalTestDirectory();
        await using (RbpJournalStore store = OpenStore(directory))
        {
            _ = await store.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration(expiresInHours: 1));
            _ = await store.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration(
                    rsid: "rs-live",
                    localSessionKey: "port:8081:pid:5678",
                    resumeToken: "live-resume-token",
                    expiresInHours: 24 * 30));
            RbpDataEnvelopeSnapshot inbound = RbpJournalTestData.Inbound(
                "rs-test",
                1,
                "0197a3c2-0000-7000-8000-000000000301",
                7);
            _ = await store.AcceptInboundDataAsync(inbound);
            _ = await store.ExecuteImmediateAsync(
                context =>
                {
                    MarkInboundJournaled(context, inbound, "inv-1");
                    return true;
                });
            _ = await store.QueueOutboundDataAsync(
                "rs-test",
                RbpJournalTestData.Outbound(
                    "0197a3c2-0000-7000-8000-000000000302",
                    8));
            _ = await store.QueueOutboundDataAsync(
                "rs-live",
                RbpJournalTestData.Outbound(
                    "0197a3c2-0000-7000-8000-000000000303",
                    9));

            // rs-test's resume window closed a full retention period before
            // the sweep; rs-live can still resume and keeps every row.
            AdvanceDays(20);
            RbpJournalRetentionResult swept =
                await store.ApplyRetentionAsync();

            Assert.Equal(0, swept.PrunedInvocations);
            Assert.Equal(0, swept.PrunedClearedHolds);
            Assert.Equal(1, swept.PrunedInboundReceipts);
            Assert.Equal(1, swept.PrunedOutboxEnvelopes);
            Assert.Equal(1, swept.PrunedTransportSessions);
            RbpReceiveFrontier liveFrontier =
                await store.GetReceiveFrontierAsync("rs-live");
            Assert.Equal(0, liveFrontier.LastAcceptedSequence);
        }

        // The pruned journal reopens through every integrity check, keeps
        // the expired enrollment visible, and retains rs-live untouched.
        await using RbpJournalStore reopened = OpenStore(directory);
        RbpJournalRecoveryPlan recovery =
            await reopened.LoadRecoveryPlanAsync();
        RbpExpiredSession expired = Assert.Single(recovery.ExpiredSessions);
        Assert.Equal("rs-test", expired.Rsid);
        RbpResumeCandidate live = Assert.Single(recovery.ResumeCandidates);
        Assert.Equal("rs-live", live.Session.Rsid);
        Assert.Single(live.Outbox);
    }

    [Fact]
    public async Task PendingInboundHandoffsBlockTransportPruning()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(expiresInHours: 1));
        RbpDataEnvelopeSnapshot inbound = RbpJournalTestData.Inbound(
            "rs-test",
            1,
            "0197a3c2-0000-7000-8000-000000000311",
            7);
        _ = await store.AcceptInboundDataAsync(inbound);

        // An accepted envelope without its atomic journal handoff is
        // non-terminal work and blocks the whole session's transport sweep.
        AdvanceDays(40);
        RbpJournalRetentionResult swept = await store.ApplyRetentionAsync();

        Assert.Equal(0, swept.PrunedInboundReceipts);
        Assert.Equal(0, swept.PrunedOutboxEnvelopes);
        Assert.Equal(0, swept.PrunedTransportSessions);
        RbpJournalRecoveryPlan recovery = await store.LoadRecoveryPlanAsync();
        RbpPendingInboundHandoff handoff =
            Assert.Single(recovery.PendingInboundHandoffs);
        Assert.Equal(inbound.Id, handoff.Envelope.Id);
    }

    private RbpJournalStore OpenStore(RbpJournalTestDirectory directory) =>
        RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(
                nowMilliseconds: () => _nowMilliseconds));

    private void AdvanceDays(double days) =>
        _nowMilliseconds +=
            (long)TimeSpan.FromDays(days).TotalMilliseconds;

    private void MarkInboundJournaled(
        RbpJournalWriteContext context,
        RbpDataEnvelopeSnapshot envelope,
        string correlationId)
    {
        context.MarkInboundJournaled(
            envelope.Rsid,
            envelope.Sequence,
            envelope.Id,
            Rfc8785Json.ImmutableEnvelopeDigest(envelope),
            correlationId,
            RbpJournalTestData.JournalRecordDigest(
                """{"state":"received"}"""),
            _nowMilliseconds);
    }

    private static async Task CompleteReadAsync(
        RbpJournalStore store,
        RbpInvocationIdentity identity)
    {
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        _ = await store.PersistInvocationTerminalAsync(
            identity.IdempotencyKey,
            Terminal(RbpInvocationState.Completed, """{"ok":true}"""));
    }

    private async Task AttachCarrierPlanAsync(
        RbpJournalStore store,
        RbpInvocationIdentity identity,
        char marker,
        bool acknowledged)
    {
        string planId = "sha256:" + new string(marker, 64);
        string carrierKey = new string(marker, 64);
        string digest = "sha256:" + new string('d', 64);
        await store.ExecuteImmediateAsync(
            context =>
            {
                using SqliteCommand insert = context.CreateCommand("""
                    INSERT INTO rbp_carrier_plans(
                      plan_id,idempotency_key,carrier_key,prefixes_jcs,prefix_digest,
                      terminal_jcs,terminal_digest,created_at_ms,terminal_rsid,
                      terminal_sequence,acknowledged_at_ms
                    ) VALUES(
                      $plan,$key,$carrier,'[]',$digest,'{}',$digest,$now,'rs-test',
                      $sequence,$acknowledged);
                    """);
                insert.Parameters.AddWithValue("$plan", planId);
                insert.Parameters.AddWithValue("$key", identity.IdempotencyKey);
                insert.Parameters.AddWithValue("$carrier", carrierKey);
                insert.Parameters.AddWithValue("$digest", digest);
                insert.Parameters.AddWithValue("$now", _nowMilliseconds);
                insert.Parameters.AddWithValue("$sequence", marker == 'a' ? 1 : 2);
                insert.Parameters.AddWithValue(
                    "$acknowledged",
                    acknowledged ? _nowMilliseconds : DBNull.Value);
                _ = insert.ExecuteNonQuery();
                using SqliteCommand attach = context.CreateCommand("""
                    UPDATE rbp_invocations SET carrier_plan_id=$plan
                    WHERE idempotency_key=$key;
                    """);
                attach.Parameters.AddWithValue("$plan", planId);
                attach.Parameters.AddWithValue("$key", identity.IdempotencyKey);
                Assert.Equal(1, attach.ExecuteNonQuery());
                return true;
            });
    }

    private static async Task<string> InstallIndeterminateHoldAsync(
        RbpJournalStore store,
        RbpInvocationIdentity origin)
    {
        _ = await store.AdmitInvocationAsync(origin);
        await store.MarkInvocationExecutingAsync(origin.IdempotencyKey);
        RbpInvocationAdmissionResult refused =
            await store.AdmitInvocationAsync(origin);
        Assert.Equal(
            RbpInvocationAdmission.RefuseIndeterminate,
            refused.Admission);
        return refused.VerificationHoldId!;
    }

    private static RbpInvocationTerminal Terminal(
        RbpInvocationState state,
        string outcomeJson)
    {
        using var document = JsonDocument.Parse(outcomeJson);
        return new RbpInvocationTerminal(
            state,
            document.RootElement.Clone(),
            "sha256:" + new string('c', 64));
    }

    private static RbpInvocationIdentity ReadIdentity(
        string invocationId) =>
        new(
            "rs-test",
            invocationId,
            ReadMethod,
            Mutating: false,
            MutationScopeJcs: null,
            ParamsDigest: "sha256:" + new string('a', 64),
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");

    private static RbpInvocationIdentity WriteIdentity(
        string invocationId = "0197a3c2-0000-7000-8000-0000000000b2") =>
        new(
            "rs-test",
            invocationId,
            WriteMethod,
            Mutating: true,
            MutationScopeJcs: DocumentScope,
            ParamsDigest: "sha256:" + new string('a', 64),
            PolicyJcs: """{"decision":"allow"}""",
            RecoveryClearancesJcs: "[]");
}
