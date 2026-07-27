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
