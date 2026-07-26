using System.Text;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

public sealed class RbpJournalInboundRecoveryTests
{
    [Fact]
    public async Task PendingEnvelopeSurvivesReopenAndCannotAdvanceWireAck()
    {
        using var directory = new RbpJournalTestDirectory();
        RbpDataEnvelopeSnapshot incoming = RbpJournalTestData.Inbound(
            "rs-test",
            sequence: 1,
            id: "0197a3c2-0000-7000-8000-000000000101",
            value: 41);

        await using (RbpJournalStore store = RbpJournalStore.Open(
                         directory.JournalPath,
                         new TestResumeTokenProtector(),
                         RbpJournalTestData.Options()))
        {
            _ = await store.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration());
            RbpInboundDataResult accepted =
                await store.AcceptInboundDataAsync(incoming);
            Assert.Equal(RbpInboundDataKind.Accepted, accepted.Kind);
            Assert.Equal(0, accepted.Acknowledgement);

            RbpReceiveFrontier frontier =
                await store.GetReceiveFrontierAsync("rs-test");
            Assert.Equal(1, frontier.LastAcceptedSequence);
            Assert.Equal(0, frontier.LastJournaledSequence);

            RbpInboundDataResult conflictingDuplicate =
                await store.AcceptInboundDataAsync(
                    RbpJournalTestData.Inbound(
                        "rs-test",
                        sequence: 1,
                        id: incoming.Id,
                        value: 42));
            Assert.Equal(
                RbpInboundDataKind.ProtocolFault,
                conflictingDuplicate.Kind);
            Assert.Equal(
                RbpSequenceFault.DuplicateIdentityMismatch,
                conflictingDuplicate.Fault);
            Assert.Equal(0, conflictingDuplicate.Acknowledgement);
            frontier = await store.GetReceiveFrontierAsync("rs-test");
            Assert.Equal(1, frontier.LastAcceptedSequence);
            Assert.Equal(0, frontier.LastJournaledSequence);

            RbpSessionAcknowledgement heartbeat =
                Assert.Single(
                    await store.LoadJournaledAcknowledgementsAsync(
                        new[] { "rs-test" }));
            Assert.Equal(0, heartbeat.Sequence);

            RbpJournalRecoveryPlan recovery =
                await store.LoadRecoveryPlanAsync();
            RbpPendingInboundHandoff handoff =
                Assert.Single(recovery.PendingInboundHandoffs);
            Assert.Equal(incoming.Id, handoff.Envelope.Id);
            Assert.Equal(
                41,
                handoff.Envelope.Payload.GetProperty("value").GetInt32());
            Assert.Equal(
                0,
                Assert.Single(recovery.ResumeCandidates)
                    .LastJournaledReceivedSequence);

            RbpJournalException overAck =
                await Assert.ThrowsAsync<RbpJournalException>(
                    () => store.QueueOutboundDataAsync(
                        "rs-test",
                        RbpJournalTestData.Outbound(
                            "0197a3c2-0000-7000-8000-000000000201",
                            value: 1,
                            acknowledgement: 1)));
            Assert.Equal(
                RbpJournalErrorCode.ProtocolConflict,
                overAck.ErrorCode);
        }

        await using (RbpJournalStore reopened = RbpJournalStore.Open(
                         directory.JournalPath,
                         new TestResumeTokenProtector(),
                         RbpJournalTestData.Options()))
        {
            RbpJournalRecoveryPlan recovery =
                await reopened.LoadRecoveryPlanAsync();
            RbpPendingInboundHandoff handoff =
                Assert.Single(recovery.PendingInboundHandoffs);
            Assert.Equal(incoming.Id, handoff.Envelope.Id);
            Assert.Equal(
                0,
                Assert.Single(recovery.ResumeCandidates)
                    .LastJournaledReceivedSequence);

            RbpInboundDataResult duplicate =
                await reopened.AcceptInboundDataAsync(incoming);
            Assert.Equal(RbpInboundDataKind.Duplicate, duplicate.Kind);
            Assert.Equal(0, duplicate.Acknowledgement);

            _ = await reopened.ExecuteImmediateAsync(
                context =>
                {
                    MarkInboundJournaled(
                        context,
                        incoming,
                        "0197a3c2-0000-7000-8000-000000000301",
                        """{"invocation_id":"inv-1"}""");
                    return true;
                });

            RbpReceiveFrontier frontier =
                await reopened.GetReceiveFrontierAsync("rs-test");
            Assert.Equal(1, frontier.LastAcceptedSequence);
            Assert.Equal(1, frontier.LastJournaledSequence);
            recovery = await reopened.LoadRecoveryPlanAsync();
            Assert.Empty(recovery.PendingInboundHandoffs);
            Assert.Equal(
                1,
                Assert.Single(recovery.ResumeCandidates)
                    .LastJournaledReceivedSequence);

            RbpInboundDataResult acknowledgedDuplicate =
                await reopened.AcceptInboundDataAsync(incoming);
            Assert.Equal(
                RbpInboundDataKind.Duplicate,
                acknowledgedDuplicate.Kind);
            Assert.Equal(1, acknowledgedDuplicate.Acknowledgement);
        }
    }

    [Fact]
    public async Task CrashAfterReceiptCommitRecoversExactPendingEnvelope()
    {
        using var directory = new RbpJournalTestDirectory();
        var faults = new ArmedJournalFaultInjector();
        RbpDataEnvelopeSnapshot incoming = RbpJournalTestData.Inbound(
            "rs-test",
            sequence: 1,
            id: "0197a3c2-0000-7000-8000-000000000111",
            value: 73);
        await using (RbpJournalStore store = RbpJournalStore.Open(
                         directory.JournalPath,
                         new TestResumeTokenProtector(),
                         RbpJournalTestData.Options(faults)))
        {
            _ = await store.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration());
            faults.Arm(RbpJournalFaultPoint.AfterCommitBeforeReturn);
            RbpInboundDataResult recovered =
                await store.AcceptInboundDataAsync(incoming);
            Assert.Equal(RbpInboundDataKind.Accepted, recovered.Kind);
            Assert.Equal(0, recovered.Acknowledgement);
        }

        await using RbpJournalStore reopened = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        RbpJournalRecoveryPlan recovery =
            await reopened.LoadRecoveryPlanAsync();
        RbpPendingInboundHandoff pending =
            Assert.Single(recovery.PendingInboundHandoffs);
        Assert.Equal(incoming.Id, pending.Envelope.Id);
        Assert.Equal(
            Rfc8785Json.ImmutableEnvelopeDigest(incoming),
            Rfc8785Json.ImmutableEnvelopeDigest(pending.Envelope));
        Assert.Equal(
            0,
            Assert.Single(recovery.ResumeCandidates)
                .LastJournaledReceivedSequence);
    }

    [Fact]
    public async Task InvocationInsertAndReceiptHandoffShareOneImmediateCommit()
    {
        using var directory = new RbpJournalTestDirectory();
        var faults = new ArmedJournalFaultInjector();
        var migration = new RbpJournalMigration(
            3,
            "test",
            "test_atomic_handoff_v3",
            """
            CREATE TABLE test_invocation(
              invocation_id TEXT PRIMARY KEY,
              rsid TEXT NOT NULL REFERENCES rbp_sessions(rsid)
                ON DELETE RESTRICT,
              state TEXT NOT NULL CHECK(state='received')
            ) STRICT;
            """);
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(
                faults,
                new[] { migration }));
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpDataEnvelopeSnapshot incoming = RbpJournalTestData.Inbound(
            "rs-test",
            1,
            "0197a3c2-0000-7000-8000-000000000121",
            99);
        _ = await store.AcceptInboundDataAsync(incoming);

        faults.Arm(RbpJournalFaultPoint.BeforeCommit);
        await Assert.ThrowsAsync<IOException>(
            () => store.ExecuteImmediateAsync(
                context =>
                {
                    InsertInvocation(context, "inv-atomic");
                    MarkInboundJournaled(
                        context,
                        incoming,
                        "inv-atomic",
                        """{"state":"received"}""");
                    return true;
                }));
        Assert.Equal(0, await CountInvocationsAsync(store));
        Assert.Equal(
            0,
            (await store.GetReceiveFrontierAsync("rs-test"))
                .LastJournaledSequence);
        Assert.Single(
            (await store.LoadRecoveryPlanAsync())
                .PendingInboundHandoffs);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => store.ExecuteImmediateAsync(
                context =>
                {
                    InsertInvocation(context, "inv-async-escape");
                    return Task.CompletedTask;
                }));
        Assert.Equal(0, await CountInvocationsAsync(store));

        _ = await store.ExecuteImmediateAsync(
            context =>
            {
                InsertInvocation(context, "inv-atomic");
                MarkInboundJournaled(
                    context,
                    incoming,
                    "inv-atomic",
                    """{"state":"received"}""");
                return true;
            });
        Assert.Equal(1, await CountInvocationsAsync(store));
        Assert.Equal(
            1,
            (await store.GetReceiveFrontierAsync("rs-test"))
                .LastJournaledSequence);
        Assert.Empty(
            (await store.LoadRecoveryPlanAsync())
                .PendingInboundHandoffs);
    }

    [Fact]
    public async Task JournaledReceiveFrontierAdvancesOnlyContiguously()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpDataEnvelopeSnapshot first = RbpJournalTestData.Inbound(
            "rs-test",
            1,
            "0197a3c2-0000-7000-8000-000000000131",
            1);
        RbpDataEnvelopeSnapshot second = RbpJournalTestData.Inbound(
            "rs-test",
            2,
            "0197a3c2-0000-7000-8000-000000000132",
            2);
        _ = await store.AcceptInboundDataAsync(first);
        _ = await store.AcceptInboundDataAsync(second);

        _ = await store.ExecuteImmediateAsync(
            context =>
            {
                MarkInboundJournaled(
                    context,
                    second,
                    "inv-2",
                    """{"state":"received"}""");
                return true;
            });
        RbpReceiveFrontier blocked =
            await store.GetReceiveFrontierAsync("rs-test");
        Assert.Equal(2, blocked.LastAcceptedSequence);
        Assert.Equal(0, blocked.LastJournaledSequence);
        Assert.Equal(
            0,
            Assert.Single(
                    (await store.LoadRecoveryPlanAsync())
                        .ResumeCandidates)
                .LastJournaledReceivedSequence);

        _ = await store.ExecuteImmediateAsync(
            context =>
            {
                MarkInboundJournaled(
                    context,
                    first,
                    "inv-1",
                    """{"state":"received"}""");
                return true;
            });
        RbpReceiveFrontier advanced =
            await store.GetReceiveFrontierAsync("rs-test");
        Assert.Equal(2, advanced.LastJournaledSequence);
    }

    [Fact]
    public async Task PostCommitRecoveryPreservesNonDispatchClassifications()
    {
        using var directory = new RbpJournalTestDirectory();
        var faults = new ArmedJournalFaultInjector();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options(faults));
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpDataEnvelopeSnapshot incoming = RbpJournalTestData.Inbound(
            "rs-test",
            1,
            "0197a3c2-0000-7000-8000-000000000141",
            14);

        faults.Arm(RbpJournalFaultPoint.AfterCommitBeforeReturn);
        RbpInboundDataResult gap =
            await store.AcceptInboundDataAsync(
                RbpJournalTestData.Inbound(
                    "rs-test",
                    2,
                    "0197a3c2-0000-7000-8000-000000000142",
                    15));
        Assert.Equal(RbpInboundDataKind.Gap, gap.Kind);
        Assert.Equal(1, gap.ExpectedSequence);
        Assert.Equal(2, gap.ReceivedSequence);
        Assert.Equal(0, gap.Acknowledgement);

        _ = await store.AcceptInboundDataAsync(incoming);

        faults.Arm(RbpJournalFaultPoint.AfterCommitBeforeReturn);
        RbpInboundDataResult protocolFault =
            await store.AcceptInboundDataAsync(
                RbpJournalTestData.Inbound(
                    "rs-test",
                    1,
                    "0197a3c2-0000-7000-8000-000000000143",
                    16));
        Assert.Equal(
            RbpInboundDataKind.ProtocolFault,
            protocolFault.Kind);
        Assert.Equal(
            RbpSequenceFault.DuplicateIdentityMismatch,
            protocolFault.Fault);
        Assert.Equal(0, protocolFault.Acknowledgement);

        faults.Arm(RbpJournalFaultPoint.AfterCommitBeforeReturn);
        RbpInboundDataResult duplicate =
            await store.AcceptInboundDataAsync(incoming);

        Assert.Equal(RbpInboundDataKind.Duplicate, duplicate.Kind);
        Assert.Equal(0, duplicate.Acknowledgement);
        Assert.Single(
            (await store.LoadRecoveryPlanAsync()).PendingInboundHandoffs);
    }

    [Fact]
    public async Task JournalHandoffRequiresExactRetainedEnvelopeIdentity()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        RbpDataEnvelopeSnapshot incoming = RbpJournalTestData.Inbound(
            "rs-test",
            1,
            "0197a3c2-0000-7000-8000-000000000151",
            15);
        _ = await store.AcceptInboundDataAsync(incoming);
        string digest = Rfc8785Json.ImmutableEnvelopeDigest(incoming);

        RbpJournalException wrongId =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.ExecuteImmediateAsync(
                    context =>
                    {
                        context.MarkInboundJournaled(
                            incoming.Rsid,
                            incoming.Sequence,
                            "0197a3c2-0000-7000-8000-000000000159",
                            digest,
                            "inv-15",
                            """{"state":"received"}""",
                            RbpJournalTestData.Now.ToUnixTimeMilliseconds());
                        return true;
                    }));
        Assert.Equal(RbpJournalErrorCode.ProtocolConflict, wrongId.ErrorCode);

        RbpJournalException wrongDigest =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.ExecuteImmediateAsync(
                    context =>
                    {
                        context.MarkInboundJournaled(
                            incoming.Rsid,
                            incoming.Sequence,
                            incoming.Id,
                            "sha256:" + new string('0', 64),
                            "inv-15",
                            """{"state":"received"}""",
                            RbpJournalTestData.Now.ToUnixTimeMilliseconds());
                        return true;
                    }));
        Assert.Equal(
            RbpJournalErrorCode.ProtocolConflict,
            wrongDigest.ErrorCode);
        Assert.Equal(
            0,
            (await store.GetReceiveFrontierAsync("rs-test"))
                .LastJournaledSequence);

        _ = await store.ExecuteImmediateAsync(
            context =>
            {
                MarkInboundJournaled(
                    context,
                    incoming,
                    "inv-15",
                    """{"state":"received"}""");
                return true;
            });
        Assert.Equal(
            1,
            (await store.GetReceiveFrontierAsync("rs-test"))
                .LastJournaledSequence);
    }

    [Fact]
    public async Task WireAckRejectsAFrontierThatExceedsJournaledPrefix()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        _ = await store.AcceptInboundDataAsync(
            RbpJournalTestData.Inbound(
                "rs-test",
                1,
                "0197a3c2-0000-7000-8000-000000000161",
                16));
        _ = await store.ExecuteImmediateAsync(
            context =>
            {
                using Microsoft.Data.Sqlite.SqliteCommand corrupt =
                    context.CreateCommand(
                        """
                        UPDATE rbp_session_sequence
                        SET last_journaled_rx_seq=1
                        WHERE rsid='rs-test';
                        """);
                Assert.Equal(1, corrupt.ExecuteNonQuery());
                return true;
            });

        RbpJournalException blocked =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.LoadJournaledAcknowledgementsAsync(
                    new[] { "rs-test" }));
        Assert.Equal(
            RbpJournalErrorCode.IntegrityCheckFailed,
            blocked.ErrorCode);
    }

    [Fact]
    public async Task InboundEnvelopeIdCannotMoveToAnotherSequence()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        const string envelopeId =
            "0197a3c2-0000-7000-8000-000000000171";
        _ = await store.AcceptInboundDataAsync(
            RbpJournalTestData.Inbound(
                "rs-test",
                1,
                envelopeId,
                17));

        RbpJournalException conflict =
            await Assert.ThrowsAsync<RbpJournalException>(
                () => store.AcceptInboundDataAsync(
                    RbpJournalTestData.Inbound(
                        "rs-test",
                        2,
                        envelopeId,
                        18)));
        Assert.Equal(
            RbpJournalErrorCode.ProtocolConflict,
            conflict.ErrorCode);
        Assert.Equal(
            1,
            (await store.GetReceiveFrontierAsync("rs-test"))
                .LastAcceptedSequence);
    }

    [Fact]
    public async Task JournalHandoffCompactsPlaintextFromEverySqliteArtifact()
    {
        using var directory = new RbpJournalTestDirectory();
        const string sentinel =
            "receipt-plaintext-must-disappear-0197a3c2";
        RbpDataEnvelopeSnapshot incoming =
            RbpJournalTestData.Inbound(
                "rs-test",
                1,
                "0197a3c2-0000-7000-8000-000000000181",
                18) with
            {
                Payload = RbpJournalTestData.Json(
                    $$"""{"sensitive":"{{sentinel}}"}"""),
            };
        string digest = Rfc8785Json.ImmutableEnvelopeDigest(incoming);

        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        _ = await store.AcceptInboundDataAsync(incoming);
        _ = await store.ExecuteImmediateAsync(
            context =>
            {
                MarkInboundJournaled(
                    context,
                    incoming,
                    "inv-compacted",
                    """{"state":"received"}""");
                return true;
            });

        long compactedRows = await store.ReadAsync(
            connection =>
            {
                using Microsoft.Data.Sqlite.SqliteCommand command =
                    connection.CreateCommand();
                command.CommandText =
                    """
                    SELECT COUNT(*)
                    FROM rbp_inbound_receipts
                    WHERE rsid='rs-test'
                      AND seq=1
                      AND immutable_digest=$digest
                      AND envelope_json IS NULL;
                    """;
                command.Parameters.AddWithValue("$digest", digest);
                return Convert.ToInt64(command.ExecuteScalar());
            });
        Assert.Equal(1, compactedRows);

        foreach (string path in Directory.GetFiles(
                     directory.Path,
                     "journal.db*",
                     SearchOption.TopDirectoryOnly))
        {
            string artifact = Encoding.UTF8.GetString(
                await ReadSharedFileAsync(path));
            Assert.DoesNotContain(
                sentinel,
                artifact,
                StringComparison.Ordinal);
        }

        RbpInboundDataResult duplicate =
            await store.AcceptInboundDataAsync(incoming);
        Assert.Equal(RbpInboundDataKind.Duplicate, duplicate.Kind);
        Assert.Equal(1, duplicate.Acknowledgement);
    }

    [Fact]
    public async Task LongJournaledHistoryLoadsAsBoundsNotEnvelopeMaterial()
    {
        using var directory = new RbpJournalTestDirectory();
        const int receiptCount = 10_000;
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());

        _ = await store.ExecuteImmediateAsync(
            context =>
            {
                using Microsoft.Data.Sqlite.SqliteCommand insert =
                    context.CreateCommand(
                        """
                        WITH RECURSIVE receipt(seq) AS (
                          VALUES(1)
                          UNION ALL
                          SELECT seq+1
                          FROM receipt
                          WHERE seq < $receipt_count
                        )
                        INSERT INTO rbp_inbound_receipts(
                          rsid,seq,envelope_id,message_type,
                          immutable_digest,envelope_json,handoff_state,
                          correlation_id,context_json,accepted_at_ms,
                          journaled_at_ms
                        )
                        SELECT
                          'rs-test',
                          seq,
                          printf('bulk-envelope-%010d',seq),
                          'invoke',
                          'sha256:' || lower(hex(zeroblob(32))),
                          NULL,
                          'journaled',
                          printf('bulk-invocation-%010d',seq),
                          '{"state":"received"}',
                          $now,
                          $now
                        FROM receipt;
                        """);
                insert.Parameters.AddWithValue(
                    "$receipt_count",
                    receiptCount);
                insert.Parameters.AddWithValue(
                    "$now",
                    RbpJournalTestData.Now.ToUnixTimeMilliseconds());
                Assert.Equal(receiptCount, insert.ExecuteNonQuery());

                using Microsoft.Data.Sqlite.SqliteCommand update =
                    context.CreateCommand(
                        """
                        UPDATE rbp_session_sequence
                        SET last_rx_seq=$receipt_count,
                            last_journaled_rx_seq=$receipt_count
                        WHERE rsid='rs-test';
                        """);
                update.Parameters.AddWithValue(
                    "$receipt_count",
                    receiptCount);
                Assert.Equal(1, update.ExecuteNonQuery());
                return true;
            });

        RbpSequenceState state =
            await store.LoadSequenceAsync("rs-test");
        Assert.Equal(receiptCount, state.LastRxSequence);
        Assert.Empty(state.AcceptedInbound);
        RbpReceiveFrontier frontier =
            await store.GetReceiveFrontierAsync("rs-test");
        Assert.Equal(receiptCount, frontier.LastAcceptedSequence);
        Assert.Equal(receiptCount, frontier.LastJournaledSequence);
    }

    [Fact]
    public async Task ReopenRejectsAHoleInCompactedReceiptHistory()
    {
        using var directory = new RbpJournalTestDirectory();
        await using (RbpJournalStore store = RbpJournalStore.Open(
                         directory.JournalPath,
                         new TestResumeTokenProtector(),
                         RbpJournalTestData.Options()))
        {
            _ = await store.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration());
            for (int sequence = 1; sequence <= 3; sequence++)
            {
                RbpDataEnvelopeSnapshot incoming =
                    RbpJournalTestData.Inbound(
                        "rs-test",
                        sequence,
                        $"0197a3c2-0000-7000-8000-{sequence:D12}",
                        sequence);
                _ = await store.AcceptInboundDataAsync(incoming);
                _ = await store.ExecuteImmediateAsync(
                    context =>
                    {
                        MarkInboundJournaled(
                            context,
                            incoming,
                            $"inv-{sequence}",
                            """{"state":"received"}""");
                        return true;
                    });
            }

            _ = await store.ExecuteImmediateAsync(
                context =>
                {
                    using Microsoft.Data.Sqlite.SqliteCommand corrupt =
                        context.CreateCommand(
                            """
                            DELETE FROM rbp_inbound_receipts
                            WHERE rsid='rs-test' AND seq=2;
                            """);
                    Assert.Equal(1, corrupt.ExecuteNonQuery());
                    return true;
                });
        }

        RbpJournalException rejected =
            Assert.Throws<RbpJournalException>(
                () => RbpJournalStore.Open(
                    directory.JournalPath,
                    new TestResumeTokenProtector(),
                    RbpJournalTestData.Options()));
        Assert.Equal(
            RbpJournalErrorCode.IntegrityCheckFailed,
            rejected.ErrorCode);
    }

    private static void InsertInvocation(
        RbpJournalWriteContext context,
        string invocationId)
    {
        using Microsoft.Data.Sqlite.SqliteCommand command =
            context.CreateCommand(
                """
                INSERT INTO test_invocation(invocation_id,rsid,state)
                VALUES($invocation_id,'rs-test','received');
                """);
        command.Parameters.AddWithValue(
            "$invocation_id",
            invocationId);
        _ = command.ExecuteNonQuery();
    }

    private static void MarkInboundJournaled(
        RbpJournalWriteContext context,
        RbpDataEnvelopeSnapshot envelope,
        string correlationId,
        string contextJson)
    {
        context.MarkInboundJournaled(
            envelope.Rsid,
            envelope.Sequence,
            envelope.Id,
            Rfc8785Json.ImmutableEnvelopeDigest(envelope),
            correlationId,
            contextJson,
            RbpJournalTestData.Now.ToUnixTimeMilliseconds());
    }

    private static Task<long> CountInvocationsAsync(
        RbpJournalStore store)
    {
        return store.ReadAsync(
            connection =>
            {
                using Microsoft.Data.Sqlite.SqliteCommand command =
                    connection.CreateCommand();
                command.CommandText =
                    "SELECT COUNT(*) FROM test_invocation;";
                return Convert.ToInt64(command.ExecuteScalar());
            });
    }

    private static async Task<byte[]> ReadSharedFileAsync(string path)
    {
        await using var input = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,
            bufferSize: 4_096,
            useAsync: true);
        using var output = new MemoryStream();
        await input.CopyToAsync(output);
        return output.ToArray();
    }
}
