using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Storage;

public sealed class RbpInvocationJournalSchemaTests
{
    private const string Digest =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task MigrationCreatesInvocationAndConflictIndexedHoldAuthorities()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());

        IReadOnlyList<string> authorities = await store.ReadAsync(
            connection =>
            {
                using SqliteCommand command = connection.CreateCommand();
                command.CommandText =
                    """
                    SELECT type || ':' || name
                    FROM sqlite_master
                    WHERE name IN (
                      'rbp_verification_holds',
                      'ux_rbp_verification_holds_uncleared_scope',
                      'ix_rbp_verification_holds_conflict',
                      'rbp_invocations',
                      'ix_rbp_invocations_session_state',
                      'ix_rbp_invocations_batch'
                    )
                    ORDER BY type,name;
                    """;
                using SqliteDataReader reader = command.ExecuteReader();
                var values = new List<string>();
                while (reader.Read())
                {
                    values.Add(reader.GetString(0));
                }

                return (IReadOnlyList<string>)values.AsReadOnly();
            });

        Assert.Equal(
            new[]
            {
                "index:ix_rbp_invocations_batch",
                "index:ix_rbp_invocations_session_state",
                "index:ix_rbp_verification_holds_conflict",
                "index:ux_rbp_verification_holds_uncleared_scope",
                "table:rbp_invocations",
                "table:rbp_verification_holds",
            },
            authorities);

        await store.ExecuteImmediateAsync(
            context =>
            {
                using SqliteCommand insert = context.CreateCommand(
                    """
                    INSERT INTO rbp_invocations(
                      idempotency_key,rsid,invocation_id,method,mutating,
                      mutation_scope_jcs,params_digest,
                      policy_jcs,recovery_clearances_jcs,state,created_at_ms
                    ) VALUES(
                      $key,'rs-test',$invocation,'get_ui_state',0,
                      NULL,$digest,'{}','[]','received',1
                    );
                    """);
                insert.Parameters.AddWithValue(
                    "$key",
                    "rs-test/0197a3c2-0000-7000-8000-000000000201");
                insert.Parameters.AddWithValue(
                    "$invocation",
                    "0197a3c2-0000-7000-8000-000000000201");
                insert.Parameters.AddWithValue("$digest", Digest);
                Assert.Equal(1, insert.ExecuteNonQuery());
                return true;
            });
    }

    [Fact]
    public async Task SchemaRejectsChangedKeyDuplicateActiveScopeAndUnheldUnknownWrite()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());

        await Assert.ThrowsAsync<SqliteException>(
            () => store.ExecuteImmediateAsync(
                context =>
                {
                    InsertReceivedRead(
                        context,
                        idempotencyKey:
                            "rs-test/0197a3c2-0000-7000-8000-000000000202",
                        invocationId:
                            "0197a3c2-0000-7000-8000-000000000203");
                    return true;
                }));

        await store.ExecuteImmediateAsync(
            context =>
            {
                InsertActiveHold(
                    context,
                    "vh:" + new string('a', 64));
                return true;
            });

        await Assert.ThrowsAsync<SqliteException>(
            () => store.ExecuteImmediateAsync(
                context =>
                {
                    InsertActiveHold(
                        context,
                        "vh:" + new string('b', 64));
                    return true;
                }));

        await Assert.ThrowsAsync<SqliteException>(
            () => store.ExecuteImmediateAsync(
                context =>
                {
                    using SqliteCommand insert = context.CreateCommand(
                        """
                        INSERT INTO rbp_invocations(
                          idempotency_key,rsid,invocation_id,method,mutating,
                          mutation_scope_jcs,params_digest,
                          policy_jcs,recovery_clearances_jcs,state,
                          terminal_outcome_json,result_digest,
                          created_at_ms,finished_at_ms
                        ) VALUES(
                          'rs-test/0197a3c2-0000-7000-8000-000000000204',
                          'rs-test','0197a3c2-0000-7000-8000-000000000204',
                          'set_element_parameter',1,
                          '{"kind":"session"}',$digest,'{}','[]',
                          'indeterminate','{}',$digest,1,2
                        );
                        """);
                    insert.Parameters.AddWithValue("$digest", Digest);
                    _ = insert.ExecuteNonQuery();
                    return true;
                }));
    }

    [Fact]
    public async Task OutcomeV3CompositeHoldForeignKeysRejectCrossSessionLinks()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration(
                rsid: "rs-other",
                localSessionKey: "port:8080:pid:9876"));
        _ = await store.EnsureOutcomeV3ForSessionAsync("rs-test");
        _ = await store.EnsureOutcomeV3ForSessionAsync("rs-other");

        var identity = new RbpInvocationIdentity(
            "rs-test",
            "0197a3c2-0000-7000-8000-000000000205",
            "set_element_parameter",
            Mutating: true,
            MutationScopeJcs: "{\"document_id\":\"doc-1\",\"kind\":\"document\"}",
            ParamsDigest: Digest,
            PolicyJcs: "{\"decision\":\"allow\"}",
            RecoveryClearancesJcs: "[]");
        _ = await store.AdmitInvocationOutcomeV3Async(
            identity,
            Array.Empty<RbpRecoveryClearance>(),
            RbpTransactionMode.Native);
        await store.MarkInvocationExecutingOutcomeV3Async(
            identity.IdempotencyKey,
            RbpTransactionMode.Native);
        RbpClearanceGatedAdmission refused =
            await store.AdmitInvocationOutcomeV3Async(
                identity,
                Array.Empty<RbpRecoveryClearance>(),
                RbpTransactionMode.Native);
        string holdId = refused.Admission!.VerificationHoldId!;

        await Assert.ThrowsAsync<SqliteException>(
            () => store.ExecuteImmediateAsync(
                context =>
                {
                    using SqliteCommand insert = context.CreateCommand(
                        """
                        INSERT INTO rbp_mutation_conflicts_v3(
                          conflict_key,record_schema,rsid,scope_digest,hold_id,
                          mutation_scope_jcs,active,record_version,created_at_ms,
                          updated_at_ms
                        ) VALUES(
                          'rs-other/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                          'bridge.mutation-conflict/v1','rs-other',
                          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                          $hold,'{"document_id":"doc-1","kind":"document"}',
                          1,1,1,1);
                        """);
                    insert.Parameters.AddWithValue("$hold", holdId);
                    _ = insert.ExecuteNonQuery();
                    return true;
                }));

        await Assert.ThrowsAsync<SqliteException>(
            () => store.ExecuteImmediateAsync(
                context =>
                {
                    using SqliteCommand insert = context.CreateCommand(
                        """
                        INSERT INTO rbp_mutation_resolutions_v3(
                          resolution_id,record_schema,rsid,hold_id,basis,
                          verification_invocation_id,evidence_digest,decision,
                          audit_id,state,record_version,created_at_ms,updated_at_ms
                        ) VALUES(
                          'res-cross-session','bridge.mutation-resolution/v1',
                          'rs-other',$hold,'late_terminal',NULL,
                          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                          'postcondition_verified','audit-1','pending_bridge',1,1,1);
                        """);
                    insert.Parameters.AddWithValue("$hold", holdId);
                    _ = insert.ExecuteNonQuery();
                    return true;
                }));
    }

    [Fact]
    public async Task V3AdmissionRecoversPriorDispatchedMutationBeforeFreshScopeAdmission()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        const string scope = "{\"document_id\":\"doc-1\",\"kind\":\"document\"}";
        var origin = new RbpInvocationIdentity(
            "rs-test",
            "0197a3c2-0000-7000-8000-000000000206",
            "set_element_parameter",
            Mutating: true,
            MutationScopeJcs: scope,
            ParamsDigest: Digest,
            PolicyJcs: "{\"decision\":\"allow\"}",
            RecoveryClearancesJcs: "[]");
        _ = await store.AdmitInvocationOutcomeV3Async(
            origin,
            Array.Empty<RbpRecoveryClearance>(),
            RbpTransactionMode.Native);
        await store.MarkInvocationExecutingOutcomeV3Async(
            origin.IdempotencyKey,
            RbpTransactionMode.Native);

        var fresh = origin with
        {
            InvocationId = "0197a3c2-0000-7000-8000-000000000207",
            ParamsDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        };
        RbpClearanceGatedAdmission admission =
            await store.AdmitInvocationOutcomeV3Async(
                fresh,
                Array.Empty<RbpRecoveryClearance>(),
                RbpTransactionMode.Native);

        Assert.Null(admission.Admission);
        Assert.NotNull(admission.BlockingHold);
        Assert.Equal(
            RbpInvocationState.Indeterminate,
            (await store.GetInvocationAsync(origin.IdempotencyKey))!.State);
        Assert.Null(await store.GetInvocationAsync(fresh.IdempotencyKey));
    }

    [Fact]
    public async Task V3LateTerminalEvidenceIsFirstWriteImmutable()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        var identity = new RbpInvocationIdentity(
            "rs-test",
            "0197a3c2-0000-7000-8000-000000000208",
            "set_element_parameter",
            Mutating: true,
            MutationScopeJcs: "{\"document_id\":\"doc-1\",\"kind\":\"document\"}",
            ParamsDigest: Digest,
            PolicyJcs: "{\"decision\":\"allow\"}",
            RecoveryClearancesJcs: "[]");
        _ = await store.AdmitInvocationOutcomeV3Async(
            identity,
            Array.Empty<RbpRecoveryClearance>(),
            RbpTransactionMode.Native);
        await store.MarkInvocationExecutingOutcomeV3Async(
            identity.IdempotencyKey,
            RbpTransactionMode.Native);
        _ = await store.AdmitInvocationOutcomeV3Async(
            identity,
            Array.Empty<RbpRecoveryClearance>(),
            RbpTransactionMode.Native);

        JsonElement late = RbpJournalTestData.Json("{\"late\":true}");
        var terminal = new RbpInvocationTerminal(
            RbpInvocationState.Completed,
            late,
            Rfc8785Json.Sha256Digest(late));
        RbpMutationOutcomeEvidence evidence =
            RbpMutationOutcomeEvidence.NativeResponse(
                RbpEffectState.Committed,
                "late_terminal");
        _ = await store.PersistInvocationOutcomeV3Async(
            identity.IdempotencyKey,
            terminal,
            evidence,
            error: false);
        long version = (await store.GetOutcomeV3Async(
            identity.IdempotencyKey))!.RecordVersion;

        // Exact duplicate evidence is an idempotent no-op, not a new record.
        _ = await store.PersistInvocationOutcomeV3Async(
            identity.IdempotencyKey,
            terminal,
            evidence,
            error: false);
        Assert.Equal(
            version,
            (await store.GetOutcomeV3Async(identity.IdempotencyKey))!.RecordVersion);

        JsonElement changed = RbpJournalTestData.Json("{\"late\":false}");
        await Assert.ThrowsAsync<RbpJournalException>(
            () => store.PersistInvocationOutcomeV3Async(
                identity.IdempotencyKey,
                new RbpInvocationTerminal(
                    RbpInvocationState.Completed,
                    changed,
                    Rfc8785Json.Sha256Digest(changed)),
                evidence,
                error: false));
        await Assert.ThrowsAsync<RbpJournalException>(
            () => store.PersistInvocationOutcomeV3Async(
                identity.IdempotencyKey,
                terminal,
                RbpMutationOutcomeEvidence.NativeResponse(
                    RbpEffectState.Committed,
                    "late_terminal_changed"),
                error: false));
    }

    [Fact]
    public async Task
        IndependentLegacyUncertaintiesOnOneScopeQuarantineWithoutCutover()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        var first = new RbpInvocationIdentity(
            "rs-test",
            "0197a3c2-0000-7000-8000-000000000209",
            "set_element_parameter",
            Mutating: true,
            MutationScopeJcs:
                "{\"document_id\":\"doc-1\",\"kind\":\"document\"}",
            ParamsDigest: Digest,
            PolicyJcs: "{\"decision\":\"allow\"}",
            RecoveryClearancesJcs: "[]");
        RbpInvocationIdentity second = first with
        {
            InvocationId = "0197a3c2-0000-7000-8000-000000000210",
        };
        _ = await store.AdmitInvocationAsync(first);
        await store.MarkInvocationExecutingAsync(first.IdempotencyKey);
        _ = await store.AdmitInvocationAsync(second);
        await store.MarkInvocationExecutingAsync(second.IdempotencyKey);

        _ = await Assert.ThrowsAnyAsync<Exception>(
            () => store.EnsureOutcomeV3ForSessionAsync("rs-test"));

        Assert.Null(await store.GetOutcomeV3CutoverAsync("rs-test"));
        Assert.Equal(
            (Outcomes: 0L, Holds: 0L, Quarantine: 1L),
            await store.ReadAsync(
                connection =>
                {
                    static long Count(
                        SqliteConnection connection,
                        string table)
                    {
                        using SqliteCommand command = connection.CreateCommand();
                        command.CommandText =
                            $"SELECT COUNT(*) FROM {table} WHERE rsid='rs-test';";
                        return (long)command.ExecuteScalar()!;
                    }

                    return (
                        Outcomes: Count(
                            connection,
                            "rbp_outcome_dispatch_v3"),
                        Holds: Count(connection, "rbp_mutation_holds_v3"),
                        Quarantine: Count(
                            connection,
                            "rbp_outcome_quarantine_v3"));
                }));
    }

    [Fact]
    public void OutcomeV3CanonicalByteBudgetAcceptsExactAndRejectsPlusOne()
    {
        long bytes = 0;
        RbpJournalStore.ValidateOutcomeV3ImportByteAddition(
            ref bytes,
            8_000_000);
        RbpJournalStore.ValidateOutcomeV3ImportByteAddition(
            ref bytes,
            8_777_214);
        Assert.Equal(16_777_216, bytes);

        RbpOutcomeV3ImportException exception = Assert.Throws<
            RbpOutcomeV3ImportException>(
            () => RbpJournalStore.ValidateOutcomeV3ImportByteAddition(
                ref bytes,
                0));
        Assert.Equal("import_max_bytes", exception.ReasonCode);
        Assert.Equal(16_777_216, bytes);
    }

    [Fact]
    public async Task
        OutcomeV3CumulativeCanonicalByteBoundaryCommitsExactAndQuarantinesPlusOne()
    {
        using (var exactDirectory = new RbpJournalTestDirectory())
        {
            await using RbpJournalStore exact = RbpJournalStore.Open(
                exactDirectory.JournalPath,
                new TestResumeTokenProtector(),
                RbpJournalTestData.Options());
            _ = await exact.PersistRegisteredSessionAsync(
                RbpJournalTestData.Registration());
            await PrepareCumulativeCanonicalRowsAsync(exact, plusOne: false);

            RbpOutcomeV3Cutover marker =
                await exact.EnsureOutcomeV3ForSessionAsync("rs-test");
            Assert.Equal(16_777_216, marker.ImportedCanonicalBytes);
            Assert.Equal(3, marker.ImportedDispatchCount);
        }

        using var overflowDirectory = new RbpJournalTestDirectory();
        await using RbpJournalStore overflow = RbpJournalStore.Open(
            overflowDirectory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await overflow.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        await PrepareCumulativeCanonicalRowsAsync(overflow, plusOne: true);

        _ = await Assert.ThrowsAnyAsync<Exception>(
            () => overflow.EnsureOutcomeV3ForSessionAsync("rs-test"));
        Assert.Null(await overflow.GetOutcomeV3CutoverAsync("rs-test"));
        Assert.Equal(
            1,
            await overflow.ReadAsync(
                connection =>
                {
                    using SqliteCommand command = connection.CreateCommand();
                    command.CommandText =
                        "SELECT COUNT(*) FROM rbp_outcome_quarantine_v3 " +
                        "WHERE rsid='rs-test';";
                    return Convert.ToInt32(command.ExecuteScalar());
                }));
    }

    [Fact]
    public async Task OutcomeV3ImportAcceptsTheExactRowCap()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        await store.ExecuteImmediateAsync(
            context =>
            {
                InsertLegacyReads(context, 10_000);
                return true;
            });

        RbpOutcomeV3Cutover marker =
            await store.EnsureOutcomeV3ForSessionAsync("rs-test");

        Assert.Equal(10_000, marker.ImportedDispatchCount);
        Assert.InRange(marker.ImportedCanonicalBytes, 1, 16_777_216);
        Assert.Equal(
            10_000,
            await store.ReadAsync(
                connection =>
                {
                    using SqliteCommand command = connection.CreateCommand();
                    command.CommandText =
                        "SELECT COUNT(*) FROM rbp_outcome_dispatch_v3 " +
                        "WHERE rsid='rs-test';";
                    return Convert.ToInt32(command.ExecuteScalar());
                }));
    }

    [Fact]
    public async Task OutcomeV3ImportLimitPlusOneRollsBackAndQuarantines()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        await store.ExecuteImmediateAsync(
            context =>
            {
                InsertLegacyReads(context, 10_001);
                return true;
            });

        _ = await Assert.ThrowsAnyAsync<Exception>(
            () => store.EnsureOutcomeV3ForSessionAsync("rs-test"));

        (long Marker, long Outcomes, long Quarantine) counts =
            await store.ReadAsync(
                connection =>
                {
                    static long Count(
                        SqliteConnection connection,
                        string table)
                    {
                        using SqliteCommand command =
                            connection.CreateCommand();
                        command.CommandText =
                            $"SELECT COUNT(*) FROM {table} " +
                            "WHERE rsid='rs-test';";
                        return (long)command.ExecuteScalar()!;
                    }

                    return (
                        Count(connection, "rbp_hold_cutover_v3"),
                        Count(connection, "rbp_outcome_dispatch_v3"),
                        Count(connection, "rbp_outcome_quarantine_v3"));
                });
        Assert.Equal(0, counts.Marker);
        Assert.Equal(0, counts.Outcomes);
        Assert.Equal(1, counts.Quarantine);
    }

    [Fact]
    public async Task OutcomeV3ImportByteCapPlusOneRollsBackAndQuarantines()
    {
        using var directory = new RbpJournalTestDirectory();
        await using RbpJournalStore store = RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            RbpJournalTestData.Options());
        _ = await store.PersistRegisteredSessionAsync(
            RbpJournalTestData.Registration());
        await store.ExecuteImmediateAsync(
            context =>
            {
                InsertReceivedRead(
                    context,
                    "rs-test/0197a3c2-0000-7000-8000-000000000299",
                    "0197a3c2-0000-7000-8000-000000000299");
                using SqliteCommand expand = context.CreateCommand(
                    """
                    UPDATE rbp_invocations SET policy_jcs=$policy
                    WHERE invocation_id=
                      '0197a3c2-0000-7000-8000-000000000299';
                    """);
                expand.Parameters.AddWithValue(
                    "$policy",
                    new string('x', 16_777_217));
                Assert.Equal(1, expand.ExecuteNonQuery());
                return true;
            });

        _ = await Assert.ThrowsAnyAsync<Exception>(
            () => store.EnsureOutcomeV3ForSessionAsync("rs-test"));
        Assert.Null(await store.GetOutcomeV3CutoverAsync("rs-test"));
        Assert.Equal(
            1,
            await store.ReadAsync(
                connection =>
                {
                    using SqliteCommand command = connection.CreateCommand();
                    command.CommandText =
                        "SELECT COUNT(*) FROM rbp_outcome_quarantine_v3 " +
                        "WHERE rsid='rs-test';";
                    return Convert.ToInt32(command.ExecuteScalar());
                }));
    }

    private static void InsertLegacyReads(
        RbpJournalWriteContext context,
        int count)
    {
        using SqliteCommand insert = context.CreateCommand(
            """
            WITH RECURSIVE seq(i) AS (
              SELECT 1
              UNION ALL
              SELECT i+1 FROM seq WHERE i<$count
            )
            INSERT INTO rbp_invocations(
              idempotency_key,rsid,invocation_id,method,mutating,
              mutation_scope_jcs,params_digest,policy_jcs,
              recovery_clearances_jcs,state,created_at_ms
            )
            SELECT
              'rs-test/' || printf(
                '0197a3c2-0000-7000-8000-%012d',i),
              'rs-test',
              printf('0197a3c2-0000-7000-8000-%012d',i),
              'get_ui_state',0,NULL,$digest,'{}','[]','received',1
            FROM seq;
            """);
        insert.Parameters.AddWithValue("$count", count);
        insert.Parameters.AddWithValue("$digest", Digest);
        Assert.Equal(count, insert.ExecuteNonQuery());
    }

    private static async Task PrepareCumulativeCanonicalRowsAsync(
        RbpJournalStore store,
        bool plusOne)
    {
        string[] ids =
        [
            "0197a3c2-0000-7000-8000-000000000311",
            "0197a3c2-0000-7000-8000-000000000312",
            "0197a3c2-0000-7000-8000-000000000313",
        ];
        await store.ExecuteImmediateAsync(
            context =>
            {
                foreach (string id in ids)
                {
                    InsertReceivedRead(context, "rs-test/" + id, id);
                }

                return true;
            });
        long baseline = 0;
        foreach (string id in ids)
        {
            baseline += RbpJournalStore
                .OutcomeV3CanonicalInvocationImportBytes(
                    (await store.GetInvocationAsync("rs-test/" + id))!);
        }

        long padding = 16_777_216L - baseline + (plusOne ? 1L : 0L);
        int firstPadding = checked((int)(padding / 2L));
        int secondPadding = checked((int)(padding - firstPadding));
        Assert.InRange(firstPadding, 1, 16_000_000);
        Assert.InRange(secondPadding, 1, 16_000_000);
        await store.ExecuteImmediateAsync(
            context =>
            {
                using SqliteCommand expand = context.CreateCommand(
                    """
                    UPDATE rbp_invocations
                    SET policy_jcs=CASE invocation_id
                      WHEN $first THEN $first_policy
                      WHEN $second THEN $second_policy
                      ELSE policy_jcs END
                    WHERE invocation_id IN ($first,$second);
                    """);
                expand.Parameters.AddWithValue("$first", ids[0]);
                expand.Parameters.AddWithValue("$second", ids[1]);
                expand.Parameters.AddWithValue(
                    "$first_policy",
                    new string('x', 2 + firstPadding));
                expand.Parameters.AddWithValue(
                    "$second_policy",
                    new string('y', 2 + secondPadding));
                Assert.Equal(2, expand.ExecuteNonQuery());
                return true;
            });
    }

    private static void InsertReceivedRead(
        RbpJournalWriteContext context,
        string idempotencyKey,
        string invocationId)
    {
        using SqliteCommand insert = context.CreateCommand(
            """
            INSERT INTO rbp_invocations(
              idempotency_key,rsid,invocation_id,method,mutating,
              mutation_scope_jcs,params_digest,
              policy_jcs,recovery_clearances_jcs,state,created_at_ms
            ) VALUES(
              $key,'rs-test',$invocation,'get_ui_state',0,
              NULL,$digest,'{}','[]','received',1
            );
            """);
        insert.Parameters.AddWithValue("$key", idempotencyKey);
        insert.Parameters.AddWithValue("$invocation", invocationId);
        insert.Parameters.AddWithValue("$digest", Digest);
        _ = insert.ExecuteNonQuery();
    }

    private static void InsertActiveHold(
        RbpJournalWriteContext context,
        string holdId)
    {
        using SqliteCommand insert = context.CreateCommand(
            """
            INSERT INTO rbp_verification_holds(
              verification_hold_id,rsid,scope_kind,document_id,scope_jcs,
              ordered_origin_idempotency_keys_json,state,
              created_at_ms,updated_at_ms
            ) VALUES(
              $hold,'rs-test','document','doc-1',
              '{"document_id":"doc-1","kind":"document"}',
              '["rs-test/inv-origin"]','active',1,1
            );
            """);
        insert.Parameters.AddWithValue("$hold", holdId);
        _ = insert.ExecuteNonQuery();
    }
}
