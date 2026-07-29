using System.Data;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace RevAgent.Bridge.Gateway.Storage;

/// <summary>
/// Read paths for the frozen O1 Section 12 invocation journal. All SQL that
/// materializes invocation and hold rows lives here so the write path in
/// <c>RbpJournalStore.Invocations.cs</c> stays a statement of the frozen
/// rules rather than a mix of rules and queries.
/// </summary>
internal sealed partial class RbpJournalStore
{
    private const string InvocationColumns =
        """
        idempotency_key,rsid,invocation_id,batch_id,batch_index,method,
        mutating,mutation_scope_jcs,params_digest,policy_jcs,
        recovery_clearances_jcs,state,terminal_outcome_json,result_digest,
        verification_hold_id,verification_correlation_json,
        late_terminal_outcome_json,late_result_digest,created_at_ms,
        started_at_ms,finished_at_ms
        """;

    private const string HoldColumns =
        """
        verification_hold_id,rsid,scope_kind,document_id,scope_jcs,
        ordered_origin_idempotency_keys_json,state,verification_invocation_id,
        evidence_digest,resolution_id,resolution_basis,resolution_decision,
        audit_id,created_at_ms,updated_at_ms,cleared_at_ms
        """;

    private static RbpStoredInvocation? ReadInvocation(
        RbpJournalWriteContext context,
        string idempotencyKey)
    {
        using SqliteCommand command = context.CreateCommand(
            $"""
             SELECT {InvocationColumns}
             FROM rbp_invocations
             WHERE idempotency_key=$key;
             """);
        command.Parameters.AddWithValue("$key", idempotencyKey);
        return MaterializeInvocation(command);
    }

    private RbpStoredInvocation? ReadInvocation(
        SqliteConnection connection,
        string idempotencyKey)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            $"""
             SELECT {InvocationColumns}
             FROM rbp_invocations
             WHERE idempotency_key=$key;
             """);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$key", idempotencyKey);
        return MaterializeInvocation(command);
    }

    private static RbpStoredInvocation? MaterializeInvocation(
        SqliteCommand command)
    {
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        var identity = new RbpInvocationIdentity(
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(5),
            reader.GetInt64(6) == 1,
            reader.IsDBNull(7) ? null : reader.GetString(7),
            reader.GetString(8),
            reader.GetString(9),
            reader.GetString(10),
            reader.IsDBNull(3) ? null : reader.GetString(3),
            reader.IsDBNull(4) ? null : reader.GetInt64(4));
        return new RbpStoredInvocation(
            identity,
            FromStorageState(reader.GetString(11)),
            reader.IsDBNull(12) ? null : reader.GetString(12),
            reader.IsDBNull(13) ? null : reader.GetString(13),
            reader.IsDBNull(14) ? null : reader.GetString(14),
            reader.IsDBNull(15) ? null : reader.GetString(15),
            reader.IsDBNull(16) ? null : reader.GetString(16),
            reader.IsDBNull(17) ? null : reader.GetString(17),
            reader.GetInt64(18),
            reader.IsDBNull(19) ? null : reader.GetInt64(19),
            reader.IsDBNull(20) ? null : reader.GetInt64(20));
    }

    private static RbpVerificationHold? FindHoldByExactScope(
        RbpJournalWriteContext context,
        string rsid,
        string scopeJcs)
    {
        using SqliteCommand command = context.CreateCommand(
            $"""
             SELECT {HoldColumns}
             FROM rbp_verification_holds
             WHERE rsid=$rsid AND scope_jcs=$scope AND state<>'cleared';
             """);
        command.Parameters.AddWithValue("$rsid", rsid);
        command.Parameters.AddWithValue("$scope", scopeJcs);
        return MaterializeHold(command);
    }

    /// <summary>
    /// The frozen conflict query: an exact scope match conflicts, and a
    /// session-scope hold additionally conflicts with every document row under
    /// the same <c>rsid</c> (and vice versa).
    /// </summary>
    private RbpVerificationHold? FindConflictingHold(
        SqliteConnection connection,
        string rsid,
        string scopeJcs)
    {
        (string scopeKind, _) = ReadScopeShape(scopeJcs);
        using SqliteCommand command = CreateCommand(
            connection,
            $"""
             SELECT {HoldColumns}
             FROM rbp_verification_holds
             WHERE rsid=$rsid
               AND state<>'cleared'
               AND (
                 scope_jcs=$scope
                 OR scope_kind='session'
                 OR $kind='session'
               )
             ORDER BY created_at_ms ASC
             LIMIT 1;
             """);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$rsid", rsid);
        command.Parameters.AddWithValue("$scope", scopeJcs);
        command.Parameters.AddWithValue("$kind", scopeKind);
        return MaterializeHold(command);
    }

    private static RbpVerificationHold? MaterializeHold(SqliteCommand command)
    {
        using SqliteDataReader reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        string originsJson = reader.GetString(5);
        IReadOnlyList<string> origins =
            JsonSerializer.Deserialize<string[]>(originsJson) ??
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "A mutation-recovery hold has unreadable origin keys.");
        return new RbpVerificationHold(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.IsDBNull(3) ? null : reader.GetString(3),
            reader.GetString(4),
            origins,
            FromStorageHoldState(reader.GetString(6)),
            reader.IsDBNull(7) ? null : reader.GetString(7),
            reader.IsDBNull(8) ? null : reader.GetString(8),
            reader.IsDBNull(9) ? null : reader.GetString(9),
            reader.IsDBNull(10) ? null : reader.GetString(10),
            reader.IsDBNull(11) ? null : reader.GetString(11),
            reader.IsDBNull(12) ? null : reader.GetString(12),
            reader.GetInt64(13),
            reader.GetInt64(14),
            reader.IsDBNull(15) ? null : reader.GetInt64(15));
    }

    private static RbpHoldState FromStorageHoldState(string state) =>
        state switch
        {
            "active" => RbpHoldState.Active,
            "evidence_recorded" => RbpHoldState.EvidenceRecorded,
            "resolved_pending_bridge" => RbpHoldState.ResolvedPendingBridge,
            "cleared" => RbpHoldState.Cleared,
            _ => throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The hold store holds an unknown state."),
        };
}
