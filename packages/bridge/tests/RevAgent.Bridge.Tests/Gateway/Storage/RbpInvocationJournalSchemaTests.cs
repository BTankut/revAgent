using Microsoft.Data.Sqlite;
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
