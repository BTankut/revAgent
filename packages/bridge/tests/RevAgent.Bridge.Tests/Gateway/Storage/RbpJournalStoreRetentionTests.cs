using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Dispatch;

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
    public async Task ParentRetentionPruneRemovesItsRecoveryChildWithoutExtendingParent()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(RbpJournalTestData.Registration(expiresInHours: 24 * 365));
        RbpInvocationIdentity identity = ReadIdentity("0197a3c2-0000-7000-8000-0000000000f1");
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        byte[] raw = System.Text.Encoding.UTF8.GetBytes("{\"retained\":true}");
        string digest = "sha256:" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(raw)).ToLowerInvariant();
        using JsonDocument body = JsonDocument.Parse("{\"ok\":true}");
        _ = await store.PersistInvocationTerminalAsync(identity.IdempotencyKey,
            new RbpInvocationTerminal(RbpInvocationState.Completed, body.RootElement.Clone(), digest,
                RecoveryPayload: new RbpRecoveryPayload(digest, raw)));
        Assert.NotNull(await store.GetCorrelatedRecoveryPayloadAsync(identity.Rsid, identity.InvocationId, digest));
        AdvanceDays(15);
        _ = await store.ApplyRetentionAsync();
        Assert.Null(await store.GetInvocationAsync(identity.IdempotencyKey));
        Assert.Null(await store.GetCorrelatedRecoveryPayloadAsync(identity.Rsid, identity.InvocationId, digest));
    }

    [Fact]
    public async Task ConfiguredThirtyDayRetentionKeepsRecoveryChildAtDayFifteen()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(expiresInHours: 24 * 365));
        RbpInvocationIdentity identity = ReadIdentity(
            "0197a3c2-0000-7000-8000-0000000000f2");
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        byte[] raw = System.Text.Encoding.UTF8.GetBytes("{\"retained\":true}");
        string digest = "sha256:" + Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(raw)).ToLowerInvariant();
        using JsonDocument body = JsonDocument.Parse("{\"ok\":true}");
        _ = await store.PersistInvocationTerminalAsync(identity.IdempotencyKey,
            new RbpInvocationTerminal(RbpInvocationState.Completed, body.RootElement.Clone(), digest,
                RecoveryPayload: new RbpRecoveryPayload(digest, raw)));

        AdvanceDays(15);
        RbpJournalRetentionResult swept = await store.ApplyRetentionAsync(
            TimeSpan.FromDays(30));

        Assert.Equal(new RbpJournalRetentionResult(0, 0, 0, 0, 0), swept);
        Assert.NotNull(await store.GetInvocationAsync(identity.IdempotencyKey));
        // C39's public recovery lookup TTL is independently fixed at
        // fourteen days. Retention's thirty-day ownership rule is proved by
        // the bounded physical child row, not by that intentionally expired
        // public retrieval surface.
        long childRows = await store.ReadAsync(connection =>
        {
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText =
                "SELECT COUNT(*) FROM rbp_recovery_payloads " +
                "WHERE idempotency_key=$key AND result_digest=$digest;";
            command.Parameters.AddWithValue("$key", identity.IdempotencyKey);
            command.Parameters.AddWithValue("$digest", digest);
            return Convert.ToInt64(command.ExecuteScalar());
        });
        Assert.Equal(1, childRows);
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
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(
            store, fixture, expiresInHours: 24 * 365);
        RbpInvocationIdentity origin = WriteIdentity();
        string holdId = await InstallIndeterminateHoldAsync(store, origin);
        _ = await store.PersistInvocationTerminalAsync(
            origin.IdempotencyKey,
            Terminal(RbpInvocationState.Completed, """{"late":true}"""));
        RbpHoldVerificationEvidence evidence =
            await RbpJournalStoreProductionEvidence
                .ProduceEligibleCorrelatedReadAsync(
                    store, fixture, holdId, DocumentScope, VerificationId);

        // The hold is uncleared, so neither the hold nor the indeterminate
        // origin row carrying its late evidence may ever be pruned.
        AdvanceDays(40);
        RbpJournalRetentionResult swept = await store.ApplyRetentionAsync();

        Assert.Equal(0, swept.PrunedInvocations);
        Assert.Equal(0, swept.PrunedClearedHolds);
        RbpVerificationHold? hold =
            await store.GetHoldAsync("rs-test", holdId);
        Assert.Equal(RbpHoldState.EvidenceRecorded, hold?.State);
        Assert.Equal(evidence.EvidenceDigest, hold?.EvidenceDigest);
        RbpStoredInvocation? originRow =
            await store.GetInvocationAsync(origin.IdempotencyKey);
        Assert.Equal(RbpInvocationState.Indeterminate, originRow?.State);
        Assert.Equal("""{"late":true}""", originRow?.LateTerminalOutcomeJson);
    }

    [Fact]
    public async Task ClearedHoldsAndTheirEvidenceRemainForTheWindow()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(
            store, fixture, expiresInHours: 24 * 365);
        RbpInvocationIdentity origin = WriteIdentity();
        string holdId = await InstallIndeterminateHoldAsync(store, origin);
        RbpHoldVerificationEvidence evidence =
            await RbpJournalStoreProductionEvidence
                .ProduceEligibleCorrelatedReadAsync(
                    store, fixture, holdId, DocumentScope, VerificationId);
        RbpRecoveryClearance clearance = new(
            holdId,
            DocumentScope,
            ResolutionId,
            RbpClearanceBasis.VerificationRead,
            evidence.VerificationInvocationId,
            evidence.EvidenceDigest,
            RbpClearanceDecision.PostconditionVerified,
            AuditId);
        RbpInvocationIdentity cleared = WriteIdentity(
            invocationId: "0197a3c2-0000-7000-8000-0000000000f4") with
        {
            RecoveryClearancesJcs = RbpBatchTestData.ClearanceArrayJcs(clearance),
        };
        _ = await store.AdmitInvocationWithClearancesAsync(
            cleared,
            [clearance]);
        await store.MarkInvocationExecutingAsync(cleared.IdempotencyKey);
        _ = await store.PersistInvocationTerminalAsync(
            cleared.IdempotencyKey,
            Terminal(RbpInvocationState.Completed, """{"ok":true}"""));

        // Inside the window the cleared hold and its evidence remain.
        AdvanceDays(10);
        RbpJournalRetentionResult inside = await store.ApplyRetentionAsync();
        Assert.Equal(new RbpJournalRetentionResult(0, 0, 0, 0, 0), inside);
        Assert.NotNull(await store.GetHoldAsync("rs-test", holdId));

        // Outside the window the origin, the production-correlated read
        // evidence, the cleared consumer, and the cleared hold are pruned
        // together, deterministically, with exact counts.
        AdvanceDays(5);
        RbpJournalRetentionResult outside = await store.ApplyRetentionAsync();
        Assert.Equal(3, outside.PrunedInvocations);
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

    [Theory]
    [InlineData("failed")]
    [InlineData("cancelled")]
    public async Task LegacyNoStartFailureShapedMutationIsPinnedBeforeAnyRetentionOrAdmission(
        string terminalState)
    {
        // v2/v3 safety invariant: a legacy row with no durable start marker
        // is not automatically a no-send proof.  A canonical application
        // error is contradictory evidence for a mutating origin, so the
        // first retention sweep after reopen must retain it and a later
        // conflicting admission must fail closed.
        using var directory = new RbpJournalTestDirectory();
        RbpInvocationIdentity unsafeOrigin = WriteIdentity(
            terminalState == "failed"
                ? "0197a3c2-0000-7000-8000-0000000003f1"
                : "0197a3c2-0000-7000-8000-0000000003f2");
        await using (RbpJournalStore seeded = OpenStore(directory))
        {
            _ = await seeded.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration(expiresInHours: 24 * 365));
            await CompleteReadAsync(seeded, unsafeOrigin);
            await RewriteLegacyTerminalAsync(
                seeded,
                unsafeOrigin.IdempotencyKey,
                terminalState,
                "{\"success\":false}");
        }

        AdvanceDays(40);
        await using RbpJournalStore reopened = OpenStore(directory);

        // Retention is deliberately the first public operation after reopen;
        // a sweep may inspect a legacy row but must neither erase it nor
        // infer that a missing start marker proves no model execution.
        RbpJournalRetentionResult swept = await reopened.ApplyRetentionAsync();
        Assert.Equal(0, swept.PrunedInvocations);
        RbpStoredInvocation retained = Assert.IsType<RbpStoredInvocation>(
            await reopened.GetInvocationAsync(unsafeOrigin.IdempotencyKey));
        Assert.Equal(
            terminalState == "failed"
                ? RbpInvocationState.Failed
                : RbpInvocationState.Cancelled,
            retained.State);
        Assert.Null(retained.StartedAtMilliseconds);
        Assert.Equal("{\"success\":false}", retained.TerminalOutcomeJson);

        RbpClearanceGatedAdmission refused =
            await reopened.AdmitInvocationWithClearancesAsync(
                WriteIdentity("0197a3c2-0000-7000-8000-0000000003f3"),
                Array.Empty<RbpRecoveryClearance>());
        Assert.Null(refused.Admission);
        Assert.NotNull(refused.BlockingHold);
        Assert.NotNull(await reopened.GetInvocationAsync(unsafeOrigin.IdempotencyKey));
    }

    [Fact]
    public async Task LegacyNoStartGuardedMutationWithExactNoSendProofMayExpire()
    {
        // The converse matters just as much: the classifier may release a
        // missing-start legacy mutation only where the retained terminal is
        // the exact non-contradictory guarded/no-send carrier.  This keeps
        // the failure-shaped cases above from being "fixed" by pinning every
        // historical guarded record forever.
        using var directory = new RbpJournalTestDirectory();
        RbpInvocationIdentity guarded = WriteIdentity(
            "0197a3c2-0000-7000-8000-0000000003f4");
        await using (RbpJournalStore seeded = OpenStore(directory))
        {
            _ = await seeded.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration(expiresInHours: 24 * 365));
            await CompleteReadAsync(seeded, guarded);
            await RewriteLegacyTerminalAsync(
                seeded,
                guarded.IdempotencyKey,
                "guarded",
                "{\"guarded\":true}");
        }

        AdvanceDays(40);
        await using RbpJournalStore reopened = OpenStore(directory);
        RbpJournalRetentionResult swept = await reopened.ApplyRetentionAsync();

        Assert.Equal(1, swept.PrunedInvocations);
        Assert.Null(await reopened.GetInvocationAsync(guarded.IdempotencyKey));
    }

    [Theory]
    [InlineData("completed_origin")]
    [InlineData("missing_origin_hold_reference")]
    public async Task MalformedActiveHoldPinsItsAffectedRsidInsteadOfReleasingItsOrigin(
        string alteration)
    {
        // Historical states can contain a canonical active hold but a
        // contradictory origin reference.  It is not repairable evidence:
        // retention must pin this RSID rather than treating the terminal row
        // as independently deletable.
        using var directory = new RbpJournalTestDirectory();
        RbpInvocationIdentity origin = WriteIdentity(
            alteration == "completed_origin"
                ? "0197a3c2-0000-7000-8000-0000000003f5"
                : "0197a3c2-0000-7000-8000-0000000003f6");
        string holdId;
        await using (RbpJournalStore seeded = OpenStore(directory))
        {
            _ = await seeded.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration(expiresInHours: 24 * 365));
            holdId = await InstallIndeterminateHoldAsync(seeded, origin);
            await seeded.ExecuteImmediateAsync(
                context =>
                {
                    using SqliteCommand update = context.CreateCommand(
                        alteration == "completed_origin"
                            ? """
                              UPDATE rbp_invocations
                              SET state='completed',terminal_outcome_json='{"success":true}',
                                  result_digest=$digest
                              WHERE idempotency_key=$key;
                              """
                            : """
                              UPDATE rbp_invocations
                              SET state='completed',
                                  verification_hold_id=NULL,
                                  terminal_outcome_json='{"success":true}',
                                  result_digest=$digest
                              WHERE idempotency_key=$key;
                              """);
                    update.Parameters.AddWithValue("$key", origin.IdempotencyKey);
                    update.Parameters.AddWithValue("$digest", EvidenceDigest);
                    Assert.Equal(1, update.ExecuteNonQuery());
                    return true;
                });
        }

        AdvanceDays(40);
        await using RbpJournalStore reopened = OpenStore(directory);
        RbpJournalRetentionResult swept = await reopened.ApplyRetentionAsync();

        Assert.Equal(0, swept.PrunedInvocations);
        Assert.NotNull(await reopened.GetInvocationAsync(origin.IdempotencyKey));
        RbpVerificationHold hold = Assert.IsType<RbpVerificationHold>(
            await reopened.GetHoldAsync("rs-test", holdId));
        Assert.Equal(RbpHoldState.Active, hold.State);
    }

    [Fact]
    public async Task ActiveLegacyHoldMayBindAnUnsafeFailureShapedOriginWithoutItsDirectHoldColumn()
    {
        // A v2 barrier can have appended an exact hold after a legacy
        // failure-shaped terminal was retained.  That differs materially
        // from the malformed completed-success case above: the active hold
        // is valid quarantine evidence even though the historical row lacks
        // the newer direct hold column.  Retention pins it and admission
        // reports the exact blocking hold instead of rejecting the journal
        // as malformed or releasing the origin.
        using var directory = new RbpJournalTestDirectory();
        RbpInvocationIdentity origin = WriteIdentity(
            "0197a3c2-0000-7000-8000-0000000003f7");
        string holdId;
        await using (RbpJournalStore seeded = OpenStore(directory))
        {
            _ = await seeded.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration(expiresInHours: 24 * 365));
            holdId = await InstallIndeterminateHoldAsync(seeded, origin);
            await RewriteLegacyTerminalAsync(
                seeded,
                origin.IdempotencyKey,
                "failed",
                "{\"success\":false}");
            await seeded.ExecuteImmediateAsync(
                context =>
                {
                    using SqliteCommand update = context.CreateCommand("""
                        UPDATE rbp_invocations
                        SET verification_hold_id=NULL
                        WHERE idempotency_key=$key;
                        """);
                    update.Parameters.AddWithValue("$key", origin.IdempotencyKey);
                    Assert.Equal(1, update.ExecuteNonQuery());
                    return true;
                });
        }

        AdvanceDays(40);
        await using RbpJournalStore reopened = OpenStore(directory);
        RbpJournalRetentionResult swept = await reopened.ApplyRetentionAsync();
        Assert.Equal(0, swept.PrunedInvocations);
        Assert.NotNull(await reopened.GetInvocationAsync(origin.IdempotencyKey));

        RbpClearanceGatedAdmission blocked =
            await reopened.AdmitInvocationWithClearancesAsync(
                WriteIdentity("0197a3c2-0000-7000-8000-0000000003f8"),
                Array.Empty<RbpRecoveryClearance>());
        Assert.Null(blocked.Admission);
        Assert.Equal(holdId, blocked.BlockingHold?.VerificationHoldId);
    }

    [Fact]
    public async Task CompletedFailureShapedLegacyOriginPinsExpiredPayloadAndReleasedCarrier()
    {
        // B2's first-sweep invariant is closure based, not merely a terminal
        // state check.  This origin looks completed to old retention code but
        // carries an application failure and no durable start/hold marker.
        // Every dependent replay byte must survive the first reopened sweep,
        // even after both C39 release fences have completed.
        using var directory = new RbpJournalTestDirectory();
        RbpInvocationIdentity origin = WriteIdentity(
            "0197a3c2-0000-7000-8000-000000000401");
        byte[] raw = System.Text.Encoding.UTF8.GetBytes("{\"recovery\":true}");
        string digest = "sha256:" + Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(raw)).ToLowerInvariant();
        string carrierKey;
        await using (RbpJournalStore seeded = OpenStore(directory))
        {
            _ = await seeded.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration(expiresInHours: 24 * 365));
            _ = await seeded.AdmitInvocationAsync(origin);
            await seeded.MarkInvocationExecutingAsync(origin.IdempotencyKey);
            using JsonDocument body = JsonDocument.Parse("{\"ok\":true}");
            _ = await seeded.PersistInvocationTerminalAsync(
                origin.IdempotencyKey,
                new RbpInvocationTerminal(
                    RbpInvocationState.Completed,
                    body.RootElement.Clone(),
                    digest,
                    RecoveryPayload: new RbpRecoveryPayload(digest, raw)));
            await RewriteLegacyTerminalAsync(
                seeded, origin.IdempotencyKey, "completed", "{\"success\":false}");
            carrierKey = await AttachCarrierPlanAsync(
                seeded, origin, 'e', acknowledged: true);
            await MarkCarrierSpoolReleasedAsync(seeded, carrierKey);
        }

        AdvanceDays(40);
        await using RbpJournalStore reopened = OpenStore(directory);

        // Retention is deliberately the first public operation after reopen.
        RbpJournalRetentionResult swept = await reopened.ApplyRetentionAsync();

        Assert.Equal(0, swept.PrunedInvocations);
        Assert.DoesNotContain(swept.ExactReleasedCarriers,
            carrier => carrier.CarrierKey == carrierKey);
        RbpStoredInvocation retained = Assert.IsType<RbpStoredInvocation>(
            await reopened.GetInvocationAsync(origin.IdempotencyKey));
        Assert.Equal(RbpInvocationState.Completed, retained.State);
        Assert.Equal("{\"success\":false}", retained.TerminalOutcomeJson);
        Assert.Null(retained.StartedAtMilliseconds);
        Assert.Equal(1, await CountRowsAsync(
            reopened,
            "rbp_recovery_payloads",
            "idempotency_key=$key",
            ("$key", origin.IdempotencyKey)));
        Assert.Equal(1, await CountRowsAsync(
            reopened,
            "rbp_carrier_plans",
            "idempotency_key=$key",
            ("$key", origin.IdempotencyKey)));
    }

    [Fact]
    public async Task CapPlusOneCandidateWindowPinsUnscannedMalformedRsidWhileSafeRsidExpires()
    {
        // A limit+1 inventory must not turn unscanned into safe.  The window
        // rotates deterministically: first scan the independent safe RSID
        // while the malformed origin is outside the 128-item window, then
        // scan that origin directly and prove it still cannot be released.
        using var directory = new RbpJournalTestDirectory();
        const string unsafeRsid = "rs-000-unsafe";
        const string safeRsid = "rs-001-safe";
        RbpInvocationIdentity malformed = WriteIdentity(
            "0197a3c2-0000-7000-8000-000000000402") with
        { Rsid = unsafeRsid };
        RbpInvocationIdentity safe = ReadIdentity(
            "0197a3c2-0000-7000-8000-000000000403") with
        { Rsid = safeRsid };
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                rsid: unsafeRsid, expiresInHours: 24 * 365));
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                rsid: safeRsid, expiresInHours: 24 * 365));
        for (int index = 0; index < 128; index++)
        {
            await InsertCandidateSessionStubAsync(
                store,
                safeRsid,
                $"rs-window-{index:D3}");
        }
        await CompleteReadAsync(store, malformed);
        await RewriteLegacyTerminalAsync(
            store, malformed.IdempotencyKey, "completed", "{not-json");
        await CompleteReadAsync(store, safe);

        AdvanceDays(40);
        AdvanceToCandidateWindowOffset(candidateCount: 130, offset: 1);
        RbpJournalRetentionResult first = await store.ApplyRetentionAsync();

        Assert.Equal(1, first.PrunedInvocations);
        Assert.Null(await store.GetInvocationAsync(safe.IdempotencyKey));
        Assert.Equal(1, await CountRowsAsync(
            store,
            "rbp_invocations",
            "idempotency_key=$key",
            ("$key", malformed.IdempotencyKey)));

        AdvanceToCandidateWindowOffset(candidateCount: 130, offset: 0);
        _ = await store.ApplyRetentionAsync();
        Assert.Equal(1, await CountRowsAsync(
            store,
            "rbp_invocations",
            "idempotency_key=$key",
            ("$key", malformed.IdempotencyKey)));
    }

    [Fact]
    public async Task UnlinkedLegacyOriginAcceptsOnlyActualCorrelatedResolutionAndPrunesCoupledClosure()
    {
        // Historical v2 rows can predate the direct verification_hold_id
        // column.  Their ordered-origin link remains authoritative.  A real
        // production-correlated read and exact clearance must make that
        // append-only state resolvable; retention keeps the certificate with
        // the ambiguous origin until every ordinary retention floor permits
        // one coupled delete.
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(
            store, fixture, expiresInHours: 24 * 365);
        RbpInvocationIdentity origin = WriteIdentity(
            "0197a3c2-0000-7000-8000-000000000404");
        string holdId = await InstallIndeterminateHoldAsync(store, origin);
        await RewriteLegacyTerminalAsync(
            store, origin.IdempotencyKey, "failed", "{\"success\":false}");
        await UnlinkOriginHoldAsync(store, origin.IdempotencyKey);
        RbpHoldVerificationEvidence evidence =
            await RbpJournalStoreProductionEvidence.ProduceEligibleCorrelatedReadAsync(
                store,
                fixture,
                holdId,
                DocumentScope,
                "0197a3c2-0000-7000-8000-000000000405");
        RbpRecoveryClearance clearance = MakeClearance(holdId, evidence);
        RbpInvocationIdentity consumer = WriteIdentity(
            "0197a3c2-0000-7000-8000-000000000406") with
        {
            RecoveryClearancesJcs = RbpBatchTestData.ClearanceArrayJcs(clearance),
        };
        RbpClearanceGatedAdmission cleared =
            await store.AdmitInvocationWithClearancesAsync(consumer, [clearance]);
        Assert.NotNull(cleared.Admission);
        await store.MarkInvocationExecutingAsync(consumer.IdempotencyKey);
        _ = await store.PersistInvocationTerminalAsync(
            consumer.IdempotencyKey,
            Terminal(RbpInvocationState.Completed, "{\"ok\":true}"));

        // The classifier must accept the durable proof on the next ordinary
        // admission and not mislabel the unlinked legacy hold as corrupt.
        RbpClearanceGatedAdmission followup =
            await store.AdmitInvocationWithClearancesAsync(
                WriteIdentity("0197a3c2-0000-7000-8000-000000000407"),
                Array.Empty<RbpRecoveryClearance>());
        Assert.NotNull(followup.Admission);
        await store.MarkInvocationExecutingAsync(
            followup.Admission!.Stored.Identity.IdempotencyKey);
        _ = await store.PersistInvocationTerminalAsync(
            followup.Admission.Stored.Identity.IdempotencyKey,
            Terminal(RbpInvocationState.Completed, "{\"ok\":true}"));

        AdvanceDays(10);
        RbpJournalRetentionResult inside = await store.ApplyRetentionAsync();
        Assert.Equal(0, inside.PrunedInvocations);
        Assert.NotNull(await store.GetInvocationAsync(origin.IdempotencyKey));
        Assert.NotNull(await store.GetInvocationAsync(
            "rs-test/" + evidence.VerificationInvocationId));
        Assert.NotNull(await store.GetHoldAsync("rs-test", holdId));

        AdvanceDays(5);
        RbpJournalRetentionResult outside = await store.ApplyRetentionAsync();
        Assert.Equal(4, outside.PrunedInvocations);
        Assert.Equal(1, outside.PrunedClearedHolds);
        Assert.Null(await store.GetInvocationAsync(origin.IdempotencyKey));
        Assert.Null(await store.GetInvocationAsync(
            "rs-test/" + evidence.VerificationInvocationId));
        Assert.Null(await store.GetHoldAsync("rs-test", holdId));
    }

    [Fact]
    public async Task ForgedUnlinkedResolutionPinsTheOriginAndCannotAgeOut()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = OpenStore(directory);
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(expiresInHours: 24 * 365));
        RbpInvocationIdentity origin = WriteIdentity(
            "0197a3c2-0000-7000-8000-000000000408");
        string holdId = await InstallIndeterminateHoldAsync(store, origin);
        await RewriteLegacyTerminalAsync(
            store, origin.IdempotencyKey, "failed", "{\"success\":false}");
        await UnlinkOriginHoldAsync(store, origin.IdempotencyKey);
        await ForgeClearedResolutionAsync(store, holdId);

        AdvanceDays(40);
        RbpJournalRetentionResult swept = await store.ApplyRetentionAsync();

        Assert.Equal(0, swept.PrunedInvocations);
        Assert.NotNull(await store.GetInvocationAsync(origin.IdempotencyKey));
        RbpVerificationHold hold = Assert.IsType<RbpVerificationHold>(
            await store.GetHoldAsync("rs-test", holdId));
        Assert.Equal(RbpHoldState.Cleared, hold.State);
    }

    [Fact]
    public async Task RetentionAndClearAdmitSerializeToACompleteState()
    {
        using var directory = new RbpJournalTestDirectory();
        var fixture = new RbpApplicationErrorSafetyTests.RoutedFixture("{}", null);
        await using RbpJournalStore store = OpenStore(directory);
        await RbpJournalStoreProductionEvidence.RegisterRoutedSessionAsync(
            store, fixture, expiresInHours: 24 * 365);
        RbpInvocationIdentity origin = WriteIdentity(
            "0197a3c2-0000-7000-8000-000000000409");
        string holdId = await InstallIndeterminateHoldAsync(store, origin);
        RbpHoldVerificationEvidence evidence =
            await RbpJournalStoreProductionEvidence.ProduceEligibleCorrelatedReadAsync(
                store,
                fixture,
                holdId,
                DocumentScope,
                "0197a3c2-0000-7000-8000-00000000040a");
        RbpRecoveryClearance clearance = MakeClearance(holdId, evidence);
        RbpInvocationIdentity consumer = WriteIdentity(
            "0197a3c2-0000-7000-8000-00000000040b") with
        {
            RecoveryClearancesJcs = RbpBatchTestData.ClearanceArrayJcs(clearance),
        };

        AdvanceDays(15);
        Task<RbpJournalRetentionResult> retention = store.ApplyRetentionAsync();
        Task<RbpClearanceGatedAdmission> admit =
            store.AdmitInvocationWithClearancesAsync(consumer, [clearance]);
        await Task.WhenAll(retention, admit);

        RbpJournalRetentionResult swept = await retention;
        RbpClearanceGatedAdmission admitted = await admit;
        Assert.NotNull(admitted.Admission);
        RbpVerificationHold hold = Assert.IsType<RbpVerificationHold>(
            await store.GetHoldAsync("rs-test", holdId));
        Assert.Equal(RbpHoldState.Cleared, hold.State);
        Assert.NotNull(await store.GetInvocationAsync(origin.IdempotencyKey));
        Assert.NotNull(await store.GetInvocationAsync(
            "rs-test/" + evidence.VerificationInvocationId));
        Assert.NotNull(await store.GetInvocationAsync(consumer.IdempotencyKey));
        Assert.Equal(0, swept.PrunedClearedHolds);
    }

    private RbpJournalStore OpenStore(RbpJournalTestDirectory directory) =>
        RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(
                nowMilliseconds: () => _nowMilliseconds),
            new TestRecoveryPayloadProtector());

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

    private async Task RewriteLegacyTerminalAsync(
        RbpJournalStore store,
        string idempotencyKey,
        string state,
        string terminalOutcomeJson)
    {
        await store.ExecuteImmediateAsync(
            context =>
            {
                using SqliteCommand update = context.CreateCommand("""
                    UPDATE rbp_invocations
                    SET state=$state,
                        started_at_ms=NULL,
                        terminal_outcome_json=$terminal,
                        result_digest=$digest,
                        finished_at_ms=$finished
                    WHERE idempotency_key=$key;
                    """);
                update.Parameters.AddWithValue("$state", state);
                update.Parameters.AddWithValue("$terminal", terminalOutcomeJson);
                update.Parameters.AddWithValue("$digest", EvidenceDigest);
                update.Parameters.AddWithValue("$finished", _nowMilliseconds);
                update.Parameters.AddWithValue("$key", idempotencyKey);
                Assert.Equal(1, update.ExecuteNonQuery());
                return true;
            });
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

    private async Task<string> AttachCarrierPlanAsync(
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
        return carrierKey;
    }

    private async Task MarkCarrierSpoolReleasedAsync(
        RbpJournalStore store,
        string carrierKey)
    {
        await store.ExecuteImmediateAsync(
            context =>
            {
                using SqliteCommand update = context.CreateCommand("""
                    UPDATE rbp_carrier_plans
                    SET spool_release_state='completed',
                        spool_release_token=$token,
                        spool_released_at_ms=$now
                    WHERE carrier_key=$carrier;
                    """);
                update.Parameters.AddWithValue("$token", "release:" + carrierKey);
                update.Parameters.AddWithValue("$now", _nowMilliseconds);
                update.Parameters.AddWithValue("$carrier", carrierKey);
                Assert.Equal(1, update.ExecuteNonQuery());
                return true;
            });
    }

    private void AdvanceToCandidateWindowOffset(int candidateCount, int offset)
    {
        long minute = _nowMilliseconds / 60_000;
        long delta = (offset - (minute % candidateCount) + candidateCount) %
            candidateCount;
        _nowMilliseconds += delta * 60_000;
    }

    private async Task InsertCandidateSessionStubAsync(
        RbpJournalStore store,
        string templateRsid,
        string rsid)
    {
        // The cap oracle must create cap+1 durable candidates without
        // exercising B3 registration policy 128 times.  This is a narrowly
        // scoped historical SQLite setup: copy an already canonical, sealed
        // registration record and its pristine receive frontier, then only
        // vary the candidate RSID/local key used by retention ordering.
        await store.ExecuteImmediateAsync(
            context =>
            {
                using SqliteCommand session = context.CreateCommand("""
                    INSERT INTO rbp_sessions(
                      rsid,local_session_key,registration_json,registration_digest,
                      resume_token_protected,resume_token_protection,
                      resume_expires_at_ms,granted_capabilities_json,
                      created_at_ms,updated_at_ms
                    )
                    SELECT $rsid,$local,registration_json,registration_digest,
                           resume_token_protected,resume_token_protection,
                           resume_expires_at_ms,granted_capabilities_json,
                           $now,$now
                    FROM rbp_sessions WHERE rsid=$template;
                    """);
                session.Parameters.AddWithValue("$rsid", rsid);
                session.Parameters.AddWithValue("$local", "stub:" + rsid);
                session.Parameters.AddWithValue("$now", _nowMilliseconds);
                session.Parameters.AddWithValue("$template", templateRsid);
                Assert.Equal(1, session.ExecuteNonQuery());
                using SqliteCommand sequence = context.CreateCommand("""
                    INSERT INTO rbp_session_sequence(
                      rsid,next_tx_seq,highest_tx_seq,last_rx_seq,
                      last_journaled_rx_seq,last_peer_ack,updated_at_ms
                    ) VALUES($rsid,1,0,0,0,0,$now);
                    """);
                sequence.Parameters.AddWithValue("$rsid", rsid);
                sequence.Parameters.AddWithValue("$now", _nowMilliseconds);
                Assert.Equal(1, sequence.ExecuteNonQuery());
                return true;
            });
    }

    private static Task<long> CountRowsAsync(
        RbpJournalStore store,
        string table,
        string predicate,
        params (string Name, object Value)[] parameters) =>
        store.ReadAsync(connection =>
        {
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText = $"SELECT COUNT(*) FROM {table} WHERE {predicate};";
            foreach ((string name, object value) in parameters)
                command.Parameters.AddWithValue(name, value);
            return Convert.ToInt64(command.ExecuteScalar());
        });

    private static async Task UnlinkOriginHoldAsync(
        RbpJournalStore store,
        string idempotencyKey)
    {
        await store.ExecuteImmediateAsync(
            context =>
            {
                using SqliteCommand update = context.CreateCommand("""
                    UPDATE rbp_invocations
                    SET verification_hold_id=NULL
                    WHERE idempotency_key=$key;
                    """);
                update.Parameters.AddWithValue("$key", idempotencyKey);
                Assert.Equal(1, update.ExecuteNonQuery());
                return true;
            });
    }

    private async Task ForgeClearedResolutionAsync(
        RbpJournalStore store,
        string holdId)
    {
        await store.ExecuteImmediateAsync(
            context =>
            {
                using SqliteCommand update = context.CreateCommand("""
                    UPDATE rbp_verification_holds
                    SET state='cleared',
                        verification_invocation_id=$verification,
                        evidence_digest=$digest,
                        resolution_id=$resolution,
                        resolution_basis='verification_read',
                        resolution_decision='postcondition_verified',
                        audit_id=$audit,
                        updated_at_ms=$now,
                        cleared_at_ms=$now
                    WHERE verification_hold_id=$hold;
                    """);
                update.Parameters.AddWithValue("$verification", VerificationId);
                update.Parameters.AddWithValue("$digest", EvidenceDigest);
                update.Parameters.AddWithValue("$resolution", ResolutionId);
                update.Parameters.AddWithValue("$audit", AuditId);
                update.Parameters.AddWithValue("$now", _nowMilliseconds);
                update.Parameters.AddWithValue("$hold", holdId);
                Assert.Equal(1, update.ExecuteNonQuery());
                return true;
            });
    }

    private static RbpRecoveryClearance MakeClearance(
        string holdId,
        RbpHoldVerificationEvidence evidence) =>
        new(
            holdId,
            DocumentScope,
            ResolutionId,
            RbpClearanceBasis.VerificationRead,
            evidence.VerificationInvocationId,
            evidence.EvidenceDigest,
            RbpClearanceDecision.PostconditionVerified,
            AuditId);

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
