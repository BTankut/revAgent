using Microsoft.Data.Sqlite;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

public sealed class RbpJournalUnregisterTests
{
    [Fact]
    public async Task UnregisterNeedsJournalHandoffThenHeartbeatConfirmation()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                rsid: "rs-dead",
                localSessionKey: "port:8080:pid:10"));
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                rsid: "rs-live",
                localSessionKey: "port:8081:pid:11",
                resumeToken: "other-token"));
        RbpDataEnvelopeSnapshot incoming = RbpJournalTestData.Inbound(
            "rs-dead",
            1,
            "0197a3c2-0000-7000-8000-000000000501",
            5);
        _ = await store.AcceptInboundDataAsync(incoming);
        RbpUnregisterTombstone intent =
            await store.RecordUnregisterIntentAsync(
                "rs-dead",
                RbpSessionUnregisterReason.RevitExited);
        Assert.Equal(RbpUnregisterPhase.Pending, intent.Phase);

        RbpJournalRecoveryPlan recovery =
            await store.LoadRecoveryPlanAsync();
        Assert.Equal("rs-dead", Assert.Single(
            recovery.PendingUnregister).Rsid);
        Assert.Equal("rs-dead", Assert.Single(
            recovery.PendingInboundHandoffs).Rsid);
        Assert.Equal("rs-live", Assert.Single(
            recovery.ResumeCandidates).Session.Rsid);

        RbpJournalException revoked =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.QueueOutboundDataAsync(
                    "rs-dead",
                    RbpJournalTestData.Outbound(
                        "0197a3c2-0000-7000-8000-000000000502",
                        6)));
        Assert.Equal(
            RbpJournalErrorCode.SessionConflict,
            revoked.ErrorCode);

        _ = await store.ActivateConnectionGenerationAsync(7);
        RbpJournalException premature =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.ApplyHeartbeatFenceAcknowledgementAsync(
                    FenceForLiveAndDead()));
        Assert.Equal(
            RbpJournalErrorCode.InvalidHeartbeatFence,
            premature.ErrorCode);
        Assert.Equal(
            RbpUnregisterPhase.Pending,
            (await store.GetUnregisterTombstoneAsync("rs-dead"))
                ?.Phase);

        _ = await store.ExecuteImmediateAsync(
            context =>
            {
                context.MarkInboundJournaled(
                    incoming.Rsid,
                    incoming.Sequence,
                    incoming.Id,
                    Rfc8785Json.ImmutableEnvelopeDigest(incoming),
                    "inv-dead",
                    RbpJournalTestData.JournalRecordDigest(
                        """{"state":"received"}"""),
                    RbpJournalTestData.Now.ToUnixTimeMilliseconds());
                return true;
            });
        RbpHeartbeatFenceResult confirmed =
            await store.ApplyHeartbeatFenceAcknowledgementAsync(
                FenceForLiveAndDead());
        Assert.Equal(
            new[] { "rs-dead" },
            confirmed.ConfirmedUnregisterRsids);

        recovery = await store.LoadRecoveryPlanAsync();
        Assert.Empty(recovery.PendingUnregister);
        Assert.Empty(recovery.PendingInboundHandoffs);
        Assert.Equal(
            "rs-dead",
            Assert.Single(recovery.ConfirmedCleanup).Rsid);
        Assert.Equal(
            RbpUnregisterPhase.Confirmed,
            (await store.GetUnregisterTombstoneAsync("rs-dead"))
                ?.Phase);

        Assert.True(
            await store.CompleteConfirmedUnregisterAsync("rs-dead"));
        Assert.Null(
            await store.GetUnregisterTombstoneAsync("rs-dead"));
        Assert.Null(await store.GetStoredSessionAsync("rs-dead"));
        Assert.False(
            await store.CompleteConfirmedUnregisterAsync("rs-dead"));
    }

    [Fact]
    public async Task PostCommitUnregisterFailureRevokesDispatchFailClosed()
    {
        using var directory = new RbpJournalTestDirectory();
        var faults = new ArmedJournalFaultInjector();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(faults));
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());

        faults.Arm(RbpJournalFaultPoint.AfterCommitBeforeReturn);
        RbpJournalException failure =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.RecordUnregisterIntentAsync(
                    "rs-test",
                    RbpSessionUnregisterReason.OperatorRequested));
        Assert.Equal(
            RbpJournalErrorCode.PostCommitFailure,
            failure.ErrorCode);
        Assert.True(failure.DurableStateObserved);

        RbpUnregisterTombstone tombstone =
            Assert.Single(
                (await store.LoadRecoveryPlanAsync()).PendingUnregister);
        Assert.Equal(
            RbpSessionUnregisterReason.OperatorRequested,
            tombstone.Reason);
        RbpJournalException dispatchBlocked =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.QueueOutboundDataAsync(
                    "rs-test",
                    RbpJournalTestData.Outbound(
                        "0197a3c2-0000-7000-8000-000000000511",
                        10)));
        Assert.Equal(
            RbpJournalErrorCode.SessionConflict,
            dispatchBlocked.ErrorCode);

        RbpUnregisterTombstone replay =
            await store.RecordUnregisterIntentAsync(
                "rs-test",
                RbpSessionUnregisterReason.OperatorRequested);
        Assert.Equal(RbpUnregisterPhase.Pending, replay.Phase);
        RbpJournalException reasonConflict =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.RecordUnregisterIntentAsync(
                    "rs-test",
                    RbpSessionUnregisterReason.RevitExited));
        Assert.Equal(
            RbpJournalErrorCode.SessionConflict,
            reasonConflict.ErrorCode);
    }

    [Fact]
    public async Task BackwardClockDoesNotWedgeMigrationResumeOrUnregister()
    {
        using var directory = new RbpJournalTestDirectory();
        long clock = RbpJournalTestData.Now.ToUnixTimeMilliseconds();
        Func<long> now = () => clock;
        RbpDataEnvelopeSnapshot incoming = RbpJournalTestData.Inbound(
            "rs-live",
            1,
            "0197a3c2-0000-7000-8000-000000000521",
            21);
        await using (RbpJournalStore store = RbpJournalStore.Open(
                         directory.JournalPath,
                         new TestResumeTokenProtector(),
                         RbpJournalTestData.Options(
                             nowMilliseconds: now)))
        {
            _ = await store.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration(
                    rsid: "rs-live",
                    localSessionKey: "port:8080:pid:10"));
            _ = await store.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration(
                    rsid: "rs-dead",
                    localSessionKey: "port:8081:pid:11",
                    resumeToken: "dead-token"));
            _ = await store.AcceptInboundDataAsync(incoming);
            _ = await store.RecordUnregisterIntentAsync(
                "rs-dead",
                RbpSessionUnregisterReason.RevitExited);
        }

        clock -= (long)TimeSpan.FromHours(1).TotalMilliseconds;
        var migration = new RbpJournalMigration(
            4,
            "test",
            "test_backward_clock_v4",
            """
            CREATE TABLE test_backward_clock(
              singleton INTEGER PRIMARY KEY CHECK(singleton=1)
            ) STRICT;
            """);
        await using RbpJournalStore reopened = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(
                migrations: new[] { migration },
                nowMilliseconds: now));
        Assert.Equal(4, reopened.SchemaVersion);

        DateTimeOffset renewed =
            RbpJournalTestData.Now.AddHours(48);
        RbpResumeAcknowledgementResult resume =
            await reopened.ApplyResumeAcknowledgementAsync(
                "rs-live",
                0,
                renewed);
        Assert.Equal(renewed, resume.Session.ResumeExpiresAt);
        Assert.True(
            resume.Session.UpdatedAtMilliseconds >=
            RbpJournalTestData.Now.ToUnixTimeMilliseconds());
        _ = await reopened.ExecuteImmediateAsync(
            context =>
            {
                context.MarkInboundJournaled(
                    incoming.Rsid,
                    incoming.Sequence,
                    incoming.Id,
                    Rfc8785Json.ImmutableEnvelopeDigest(incoming),
                    "inv-backward-clock",
                    RbpJournalTestData.JournalRecordDigest(
                        """{"state":"received"}"""),
                    clock);
                return true;
            });

        _ = await reopened.ActivateConnectionGenerationAsync(1);
        RbpHeartbeatFenceResult heartbeat =
            await reopened.ApplyHeartbeatFenceAcknowledgementAsync(
                new RbpHeartbeatFence(
                    1,
                    new[] { "rs-live" },
                    new[]
                    {
                        new RbpSessionAcknowledgement("rs-live", 0),
                    },
                    new[] { "rs-dead" }));
        Assert.Equal(
            new[] { "rs-dead" },
            heartbeat.ConfirmedUnregisterRsids);
        RbpUnregisterTombstone confirmed =
            Assert.IsType<RbpUnregisterTombstone>(
                await reopened.GetUnregisterTombstoneAsync("rs-dead"));
        Assert.Equal(
            RbpUnregisterPhase.Confirmed,
            confirmed.Phase);
        Assert.True(
            confirmed.UpdatedAtMilliseconds >=
            RbpJournalTestData.Now.ToUnixTimeMilliseconds());

        var connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = directory.JournalPath,
            Mode = SqliteOpenMode.ReadOnly,
            Pooling = false,
        };
        using var inspection =
            new SqliteConnection(connectionString.ToString());
        inspection.Open();
        using SqliteCommand timestamps = inspection.CreateCommand();
        timestamps.CommandText =
            """
            SELECT
              (SELECT updated_at_ms FROM rbp_session_sequence
               WHERE rsid='rs-live'),
              (SELECT accepted_at_ms FROM rbp_inbound_receipts
               WHERE rsid='rs-live' AND seq=1),
              (SELECT journaled_at_ms FROM rbp_inbound_receipts
               WHERE rsid='rs-live' AND seq=1),
              (SELECT MIN(applied_at_ms) FROM schema_migrations),
              (SELECT MAX(applied_at_ms) FROM schema_migrations);
            """;
        using SqliteDataReader reader = timestamps.ExecuteReader();
        Assert.True(reader.Read());
        Assert.True(
            reader.GetInt64(0) >=
            RbpJournalTestData.Now.ToUnixTimeMilliseconds());
        Assert.True(reader.GetInt64(2) >= reader.GetInt64(1));
        Assert.True(reader.GetInt64(4) >= reader.GetInt64(3));
    }

    [Fact]
    public async Task ConfirmedUnregisterDeletesTerminalV3Dependencies()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpInvocationIdentity identity = ReadIdentity(
            "0197a3c2-0000-7000-8000-000000000531");
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        _ = await store.PersistInvocationTerminalAsync(
            identity.IdempotencyKey,
            Terminal(RbpInvocationState.Completed));
        _ = await store.EnsureOutcomeV3ForSessionAsync("rs-test");
        await ConfirmUnregisterAsync(store, "rs-test");

        Assert.True(await store.CompleteConfirmedUnregisterAsync("rs-test"));
        Assert.Null(await store.GetStoredSessionAsync("rs-test"));
        Assert.Equal(
            0,
            await store.ReadAsync(
                connection => CountV3Rows(connection, "rs-test")));
    }

    [Fact]
    public async Task ConfirmedUnregisterPreservesUnresolvedV3Authority()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpInvocationIdentity identity = WriteIdentity(
            "0197a3c2-0000-7000-8000-000000000532");
        _ = await store.AdmitInvocationAsync(identity);
        await store.MarkInvocationExecutingAsync(identity.IdempotencyKey);
        _ = await store.EnsureOutcomeV3ForSessionAsync("rs-test");
        await ConfirmUnregisterAsync(store, "rs-test");

        RbpJournalException blocked =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.CompleteConfirmedUnregisterAsync("rs-test"));
        Assert.Equal(RbpJournalErrorCode.CleanupIncomplete, blocked.ErrorCode);
        Assert.NotNull(await store.GetStoredSessionAsync("rs-test"));
        Assert.NotNull(await store.GetInvocationAsync(identity.IdempotencyKey));
    }

    private static async Task ConfirmUnregisterAsync(
        RbpJournalStore store,
        string rsid)
    {
        _ = await store.RecordUnregisterIntentAsync(
            rsid,
            RbpSessionUnregisterReason.OperatorRequested);
        _ = await store.ActivateConnectionGenerationAsync(1);
        _ = await store.ApplyHeartbeatFenceAcknowledgementAsync(
            new RbpHeartbeatFence(
                1,
                Array.Empty<string>(),
                Array.Empty<RbpSessionAcknowledgement>(),
                new[] { rsid }));
    }

    private static long CountV3Rows(
        SqliteConnection connection,
        string rsid)
    {
        string[] tables =
        [
            "rbp_outcome_dispatch_v3",
            "rbp_batches_v3",
            "rbp_mutation_holds_v3",
            "rbp_mutation_conflicts_v3",
            "rbp_hold_cutover_v3",
            "rbp_outcome_quarantine_v3",
        ];
        long total = 0;
        foreach (string table in tables)
        {
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText =
                $"SELECT COUNT(*) FROM {table} WHERE rsid=$rsid;";
            command.Parameters.AddWithValue("$rsid", rsid);
            total += (long)command.ExecuteScalar()!;
        }

        return total;
    }

    private static RbpInvocationIdentity ReadIdentity(string invocationId) =>
        new(
            "rs-test",
            invocationId,
            "get_current_view_info",
            Mutating: false,
            MutationScopeJcs: null,
            ParamsDigest: "sha256:" + new string('a', 64),
            PolicyJcs: "{}",
            RecoveryClearancesJcs: "[]");

    private static RbpInvocationIdentity WriteIdentity(string invocationId) =>
        new(
            "rs-test",
            invocationId,
            "create_wall",
            Mutating: true,
            MutationScopeJcs:
                """{"document_id":"doc-1","kind":"document"}""",
            ParamsDigest: "sha256:" + new string('a', 64),
            PolicyJcs: "{}",
            RecoveryClearancesJcs: "[]");

    private static RbpInvocationTerminal Terminal(RbpInvocationState state)
    {
        using JsonDocument document = JsonDocument.Parse("{}");
        return new RbpInvocationTerminal(
            state,
            document.RootElement.Clone(),
            "sha256:" + new string('c', 64));
    }

    private static RbpHeartbeatFence FenceForLiveAndDead()
    {
        return new RbpHeartbeatFence(
            7,
            new[] { "rs-live" },
            new[] { new RbpSessionAcknowledgement("rs-live", 0) },
            new[] { "rs-dead" });
    }
}
