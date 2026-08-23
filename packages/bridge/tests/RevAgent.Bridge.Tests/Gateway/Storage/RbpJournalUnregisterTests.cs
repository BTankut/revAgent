using Microsoft.Data.Sqlite;
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
            6,
            "test",
            "test_backward_clock_v3",
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
        Assert.Equal(6, reopened.SchemaVersion);

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

    private static RbpHeartbeatFence FenceForLiveAndDead()
    {
        return new RbpHeartbeatFence(
            7,
            new[] { "rs-live" },
            new[] { new RbpSessionAcknowledgement("rs-live", 0) },
            new[] { "rs-dead" });
    }
}
