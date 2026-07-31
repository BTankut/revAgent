using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Storage;

/// <summary>
/// Frozen O1 Section 12 invocation-journal authority.
///
/// Durability ordering (Section 12.1) is enforced by the call shape, not by
/// convention: <see cref="AdmitInvocationAsync"/> commits <c>received</c>
/// before the caller may write the first add-in byte,
/// <see cref="MarkInvocationExecutingAsync"/> commits <c>executing</c> before
/// dispatch ownership, and <see cref="PersistInvocationTerminalAsync"/>
/// commits the terminal outcome before any <c>result</c>/<c>error</c> reaches
/// the Gateway. A crash after add-in completion but before terminal
/// persistence deliberately leaves <c>executing</c>, which is indeterminate
/// by design.
/// </summary>
internal sealed partial class RbpJournalStore
{
    /// <summary>
    /// Admits an invocation under its canonical idempotency key and applies
    /// the frozen Section 12.2 redelivery rules. On first delivery this
    /// durably persists <c>received</c> plus <c>params_digest</c> before
    /// returning, so the caller may not have written an add-in byte yet.
    /// </summary>
    internal Task<RbpInvocationAdmissionResult> AdmitInvocationAsync(
        RbpInvocationIdentity identity,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(identity);
        ValidateInvocationIdentity(identity);
        long now = NowMilliseconds();
        return ExecuteImmediateAsync(
            context =>
            {
                RequireActiveSession(context, identity.Rsid);
                RbpStoredInvocation? existing =
                    ReadInvocation(context, identity.IdempotencyKey);
                if (existing is null)
                {
                    InsertReceivedInvocation(context, identity, now);
                    RbpStoredInvocation stored =
                        ReadInvocation(context, identity.IdempotencyKey) ??
                        throw new RbpJournalException(
                            RbpJournalErrorCode.IntegrityCheckFailed,
                            "The admitted invocation row disappeared inside " +
                            "its own transaction.");
                    return new RbpInvocationAdmissionResult(
                        RbpInvocationAdmission.Accepted,
                        stored);
                }

                // Section 12.2 rule 5: any identity drift under the same
                // canonical key is a terminal protocol fault, never a replay.
                RequireIdenticalIdentity(existing.Identity, identity);

                // Rule 1: a known terminal row replays its stored outcome.
                // Rule 2 takes precedence for indeterminate rows that later
                // acquired a durable terminal outcome.
                if (existing.State == RbpInvocationState.Indeterminate &&
                    existing.LateTerminalOutcomeJson is not null)
                {
                    return new RbpInvocationAdmissionResult(
                        RbpInvocationAdmission.ReplayLateAfterIndeterminate,
                        existing,
                        existing.VerificationHoldId);
                }

                if (existing.IsTerminal)
                {
                    return new RbpInvocationAdmissionResult(
                        RbpInvocationAdmission.ReplayTerminal,
                        existing,
                        existing.VerificationHoldId);
                }

                // Rules 3 and 4 split on mutability, not on state: both
                // `received` and `executing` are non-terminal here.
                if (!existing.Identity.Mutating)
                {
                    return new RbpInvocationAdmissionResult(
                        RbpInvocationAdmission.RetryNonMutating,
                        existing);
                }

                // Rule 4: never re-execute a possibly dispatched mutation.
                // The scope hold is installed before any fresh id may be
                // considered, in this same transaction.
                string holdId = InstallOrExtendHold(
                    context,
                    existing.Identity,
                    now);
                MarkInvocationIndeterminate(
                    context,
                    existing.Identity,
                    holdId,
                    now);
                RbpStoredInvocation refused =
                    ReadInvocation(context, existing.Identity.IdempotencyKey) ??
                    throw new RbpJournalException(
                        RbpJournalErrorCode.IntegrityCheckFailed,
                        "The refused invocation row disappeared inside its " +
                        "own transaction.");
                return new RbpInvocationAdmissionResult(
                    RbpInvocationAdmission.RefuseIndeterminate,
                    refused,
                    holdId);
            },
            cancellationToken);
    }

    /// <summary>
    /// Persists <c>executing</c> before or atomically with dispatch ownership
    /// (Section 12.1 durability ordering, step 2).
    /// </summary>
    internal Task MarkInvocationExecutingAsync(
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(idempotencyKey, nameof(idempotencyKey), 293);
        long now = NowMilliseconds();
        return ExecuteImmediateAsync(
            context =>
            {
                using SqliteCommand update = context.CreateCommand(
                    """
                    UPDATE rbp_invocations
                    SET state='executing',
                        started_at_ms=COALESCE(started_at_ms,$now)
                    WHERE idempotency_key=$key AND state='received';
                    """);
                update.Parameters.AddWithValue("$key", idempotencyKey);
                update.Parameters.AddWithValue("$now", now);
                if (update.ExecuteNonQuery() != 1)
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "Only a durably received invocation may take " +
                        "dispatch ownership.");
                }

                return true;
            },
            cancellationToken);
    }

    /// <summary>
    /// Persists the terminal outcome before the caller sends <c>result</c> or
    /// <c>error</c> (Section 12.1 durability ordering, step 3). An
    /// indeterminate terminal installs its Section 6.2.1 scope hold in the
    /// same transaction when the invocation is mutating.
    /// </summary>
    internal Task<string?> PersistInvocationTerminalAsync(
        string idempotencyKey,
        RbpInvocationTerminal terminal,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(idempotencyKey, nameof(idempotencyKey), 293);
        ArgumentNullException.ThrowIfNull(terminal);
        if (terminal.State is RbpInvocationState.Received or
            RbpInvocationState.Executing)
        {
            throw new ArgumentException(
                "A terminal transition requires a terminal state.",
                nameof(terminal));
        }

        if (terminal.ResultDigest is not null)
        {
            RequireSha256(terminal.ResultDigest, nameof(terminal));
        }

        // An indeterminate mutation carries no caller-supplied body: the store
        // mints it below, together with the hold it must reference.
        bool storeMintsOutcome =
            terminal.State == RbpInvocationState.Indeterminate &&
            terminal.Outcome.ValueKind == JsonValueKind.Undefined;
        string outcomeJson = storeMintsOutcome
            ? string.Empty
            : Rfc8785Json.Canonicalize(terminal.Outcome);
        string? resultDigest = terminal.ResultDigest;
        long now = NowMilliseconds();
        return ExecuteImmediateAsync<string?>(
            context =>
            {
                RbpStoredInvocation existing =
                    ReadInvocation(context, idempotencyKey) ??
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "An unknown invocation cannot be terminalized.");

                // Late evidence after an indeterminate terminal is retained
                // separately and never overwrites the indeterminate state,
                // and never auto-clears the hold (Section 12.2 rule 2).
                if (existing.State == RbpInvocationState.Indeterminate)
                {
                    RecordLateTerminal(
                        context,
                        idempotencyKey,
                        outcomeJson,
                        terminal.ResultDigest,
                        now);
                    return existing.VerificationHoldId;
                }

                if (existing.IsTerminal)
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "A terminal invocation outcome is immutable.");
                }

                string? holdId = null;
                if (terminal.State == RbpInvocationState.Indeterminate &&
                    existing.Identity.Mutating)
                {
                    holdId = InstallOrExtendHold(
                        context,
                        existing.Identity,
                        now);

                    // The hold id is minted here, so the Section 12.2 rule 4
                    // body — which MUST carry that id — can only be built here
                    // too. This is the same body the rule 4 admission path
                    // writes, so an indeterminate row looks identical whether
                    // it was classified on redelivery or on a dispatch whose
                    // outcome could not be disproved.
                    (outcomeJson, resultDigest) =
                        BuildJournalIndeterminateOutcome(
                            existing.Identity,
                            holdId);
                }

                using SqliteCommand update = context.CreateCommand(
                    """
                    UPDATE rbp_invocations
                    SET state=$state,
                        terminal_outcome_json=$outcome,
                        result_digest=$digest,
                        verification_hold_id=
                          COALESCE($hold,verification_hold_id),
                        finished_at_ms=$now
                    WHERE idempotency_key=$key
                      AND state IN ('received','executing');
                    """);
                update.Parameters.AddWithValue(
                    "$state",
                    ToStorageState(terminal.State));
                update.Parameters.AddWithValue("$outcome", outcomeJson);
                update.Parameters.AddWithValue(
                    "$digest",
                    (object?)resultDigest ?? DBNull.Value);
                update.Parameters.AddWithValue(
                    "$hold",
                    (object?)holdId ?? DBNull.Value);
                update.Parameters.AddWithValue("$now", now);
                update.Parameters.AddWithValue("$key", idempotencyKey);
                if (update.ExecuteNonQuery() != 1)
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "The invocation left its non-terminal state before " +
                        "the terminal outcome could be persisted.");
                }

                return holdId;
            },
            cancellationToken);
    }

    /// <summary>
    /// Reads a durable invocation row by canonical key, for answer-from-journal
    /// paths that do not admit a delivery.
    /// </summary>
    internal Task<RbpStoredInvocation?> GetInvocationAsync(
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(idempotencyKey, nameof(idempotencyKey), 293);
        return ReadAsync(
            connection => ReadInvocation(connection, idempotencyKey),
            cancellationToken);
    }

    /// <summary>
    /// Returns the uncleared hold that conflicts with the supplied mutation
    /// scope, or null. The frozen conflict query makes the session-scope row
    /// conflict with every document row under the same <c>rsid</c>.
    /// </summary>
    internal Task<RbpVerificationHold?> FindConflictingHoldAsync(
        string rsid,
        string scopeJcs,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), 256);
        ArgumentException.ThrowIfNullOrWhiteSpace(scopeJcs);
        return ReadAsync(
            connection => FindConflictingHold(connection, rsid, scopeJcs),
            cancellationToken);
    }

    private static void InsertReceivedInvocation(
        RbpJournalWriteContext context,
        RbpInvocationIdentity identity,
        long now)
    {
        using SqliteCommand insert = context.CreateCommand(
            """
            INSERT INTO rbp_invocations(
              idempotency_key,rsid,invocation_id,batch_id,batch_index,
              method,mutating,mutation_scope_jcs,params_digest,policy_jcs,
              recovery_clearances_jcs,state,created_at_ms)
            VALUES(
              $key,$rsid,$invocation_id,$batch_id,$batch_index,
              $method,$mutating,$scope,$params_digest,$policy,
              $clearances,'received',$now);
            """);
        insert.Parameters.AddWithValue("$key", identity.IdempotencyKey);
        insert.Parameters.AddWithValue("$rsid", identity.Rsid);
        insert.Parameters.AddWithValue(
            "$invocation_id",
            identity.InvocationId);
        insert.Parameters.AddWithValue(
            "$batch_id",
            (object?)identity.BatchId ?? DBNull.Value);
        insert.Parameters.AddWithValue(
            "$batch_index",
            (object?)identity.BatchIndex ?? DBNull.Value);
        insert.Parameters.AddWithValue("$method", identity.Method);
        insert.Parameters.AddWithValue(
            "$mutating",
            identity.Mutating ? 1 : 0);
        insert.Parameters.AddWithValue(
            "$scope",
            (object?)identity.MutationScopeJcs ?? DBNull.Value);
        insert.Parameters.AddWithValue(
            "$params_digest",
            identity.ParamsDigest);
        insert.Parameters.AddWithValue("$policy", identity.PolicyJcs);
        insert.Parameters.AddWithValue(
            "$clearances",
            identity.RecoveryClearancesJcs);
        insert.Parameters.AddWithValue("$now", now);
        if (insert.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The invocation journal did not accept the received row.");
        }
    }

    private static void RequireIdenticalIdentity(
        RbpInvocationIdentity stored,
        RbpInvocationIdentity incoming)
    {
        bool identical =
            string.Equals(
                stored.Method,
                incoming.Method,
                StringComparison.Ordinal) &&
            stored.Mutating == incoming.Mutating &&
            string.Equals(
                stored.MutationScopeJcs,
                incoming.MutationScopeJcs,
                StringComparison.Ordinal) &&
            string.Equals(
                stored.ParamsDigest,
                incoming.ParamsDigest,
                StringComparison.Ordinal) &&
            string.Equals(
                stored.PolicyJcs,
                incoming.PolicyJcs,
                StringComparison.Ordinal) &&
            string.Equals(
                stored.RecoveryClearancesJcs,
                incoming.RecoveryClearancesJcs,
                StringComparison.Ordinal) &&
            string.Equals(
                stored.BatchId,
                incoming.BatchId,
                StringComparison.Ordinal) &&
            stored.BatchIndex == incoming.BatchIndex;
        if (!identical)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "The canonical idempotency key was redelivered with a " +
                "different digest, method, scope, policy, clearance, or " +
                "batch binding.");
        }
    }

    private static string InstallOrExtendHold(
        RbpJournalWriteContext context,
        RbpInvocationIdentity identity,
        long now)
    {
        if (identity.MutationScopeJcs is not { } scopeJcs)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "A mutation-recovery hold requires a mutation scope.");
        }

        RbpVerificationHold? existing =
            FindHoldByExactScope(context, identity.Rsid, scopeJcs);
        if (existing is not null)
        {
            AppendHoldOrigin(
                context,
                existing,
                identity.IdempotencyKey,
                now);
            return existing.VerificationHoldId;
        }

        (string scopeKind, string? documentId) = ReadScopeShape(scopeJcs);

        // The frozen schema pins the hold id to "vh:" plus exactly 64
        // lowercase hex characters.
        Span<byte> holdEntropy = stackalloc byte[32];
        RandomNumberGenerator.Fill(holdEntropy);
        string holdId = "vh:" +
                        Convert.ToHexString(holdEntropy).ToLowerInvariant();
        using SqliteCommand insert = context.CreateCommand(
            """
            INSERT INTO rbp_verification_holds(
              verification_hold_id,rsid,scope_kind,document_id,scope_jcs,
              ordered_origin_idempotency_keys_json,state,
              created_at_ms,updated_at_ms)
            VALUES($id,$rsid,$kind,$document,$scope,$origins,'active',
                   $now,$now);
            """);
        insert.Parameters.AddWithValue("$id", holdId);
        insert.Parameters.AddWithValue("$rsid", identity.Rsid);
        insert.Parameters.AddWithValue("$kind", scopeKind);
        insert.Parameters.AddWithValue(
            "$document",
            (object?)documentId ?? DBNull.Value);
        insert.Parameters.AddWithValue("$scope", scopeJcs);
        insert.Parameters.AddWithValue(
            "$origins",
            JsonSerializer.Serialize(new[] { identity.IdempotencyKey }));
        insert.Parameters.AddWithValue("$now", now);
        if (insert.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The mutation-recovery hold could not be installed.");
        }

        return holdId;
    }

    private static void AppendHoldOrigin(
        RbpJournalWriteContext context,
        RbpVerificationHold hold,
        string idempotencyKey,
        long now)
    {
        if (hold.OrderedOriginIdempotencyKeys.Contains(
                idempotencyKey,
                StringComparer.Ordinal))
        {
            return;
        }

        var origins = new List<string>(hold.OrderedOriginIdempotencyKeys)
        {
            idempotencyKey,
        };
        using SqliteCommand update = context.CreateCommand(
            """
            UPDATE rbp_verification_holds
            SET ordered_origin_idempotency_keys_json=$origins,
                updated_at_ms=MAX(updated_at_ms,$now)
            WHERE verification_hold_id=$id;
            """);
        update.Parameters.AddWithValue(
            "$origins",
            JsonSerializer.Serialize(origins));
        update.Parameters.AddWithValue("$now", now);
        update.Parameters.AddWithValue("$id", hold.VerificationHoldId);
        _ = update.ExecuteNonQuery();
    }

    private static void MarkInvocationIndeterminate(
        RbpJournalWriteContext context,
        RbpInvocationIdentity identity,
        string holdId,
        long now)
    {
        // Frozen Section 12.2 rule 4 defines the durable terminal body for a
        // refused mutating redelivery. The schema also requires every terminal
        // row to carry an outcome and a digest, so the same JSON is both the
        // wire answer and the durable evidence.
        (string outcomeJson, string outcomeDigest) =
            BuildJournalIndeterminateOutcome(identity, holdId);
        using SqliteCommand update = context.CreateCommand(
            """
            UPDATE rbp_invocations
            SET state='indeterminate',
                verification_hold_id=$hold,
                terminal_outcome_json=
                  COALESCE(terminal_outcome_json,$outcome),
                result_digest=COALESCE(result_digest,$digest),
                finished_at_ms=COALESCE(finished_at_ms,$now)
            WHERE idempotency_key=$key
              AND state IN ('received','executing');
            """);
        update.Parameters.AddWithValue("$hold", holdId);
        update.Parameters.AddWithValue("$outcome", outcomeJson);
        update.Parameters.AddWithValue("$digest", outcomeDigest);
        update.Parameters.AddWithValue("$now", now);
        update.Parameters.AddWithValue("$key", identity.IdempotencyKey);
        _ = update.ExecuteNonQuery();
    }

    private static (string Json, string Digest)
        BuildJournalIndeterminateOutcome(
            RbpInvocationIdentity identity,
            string holdId)
    {
        using var scope = JsonDocument.Parse(
            identity.MutationScopeJcs ??
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "An indeterminate mutation requires a mutation scope."));
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WritePropertyName("mutation_scope");
            scope.RootElement.WriteTo(writer);
            writer.WriteString("outcome", "indeterminate");
            writer.WriteBoolean("retryable", false);
            writer.WriteString("verification_hold_id", holdId);
            writer.WriteBoolean("verification_required", true);
            writer.WriteEndObject();
        }

        using var built = JsonDocument.Parse(buffer.ToArray());
        return (
            Rfc8785Json.Canonicalize(built.RootElement),
            Rfc8785Json.Sha256Digest(built.RootElement));
    }

    private static void RecordLateTerminal(
        RbpJournalWriteContext context,
        string idempotencyKey,
        string outcomeJson,
        string? resultDigest,
        long now)
    {
        using SqliteCommand update = context.CreateCommand(
            """
            UPDATE rbp_invocations
            SET late_terminal_outcome_json=
                  COALESCE(late_terminal_outcome_json,$outcome),
                late_result_digest=COALESCE(late_result_digest,$digest),
                finished_at_ms=COALESCE(finished_at_ms,$now)
            WHERE idempotency_key=$key AND state='indeterminate';
            """);
        update.Parameters.AddWithValue("$outcome", outcomeJson);
        update.Parameters.AddWithValue(
            "$digest",
            (object?)resultDigest ?? DBNull.Value);
        update.Parameters.AddWithValue("$now", now);
        update.Parameters.AddWithValue("$key", idempotencyKey);
        _ = update.ExecuteNonQuery();
    }

    private static (string ScopeKind, string? DocumentId) ReadScopeShape(
        string scopeJcs)
    {
        using JsonDocument document = JsonDocument.Parse(scopeJcs);
        JsonElement root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("kind", out JsonElement kind) ||
            kind.ValueKind != JsonValueKind.String)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "A mutation scope requires a string kind.");
        }

        string scopeKind = kind.GetString() ?? string.Empty;
        if (string.Equals(scopeKind, "session", StringComparison.Ordinal))
        {
            return ("session", null);
        }

        if (!string.Equals(scopeKind, "document", StringComparison.Ordinal) ||
            !root.TryGetProperty("document_id", out JsonElement documentId) ||
            documentId.ValueKind != JsonValueKind.String)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "A document mutation scope requires a document_id.");
        }

        return ("document", documentId.GetString());
    }

    private static string ToStorageState(RbpInvocationState state) =>
        state switch
        {
            RbpInvocationState.Received => "received",
            RbpInvocationState.Executing => "executing",
            RbpInvocationState.Completed => "completed",
            RbpInvocationState.Failed => "failed",
            RbpInvocationState.Guarded => "guarded",
            RbpInvocationState.Cancelled => "cancelled",
            RbpInvocationState.Indeterminate => "indeterminate",
            _ => throw new ArgumentOutOfRangeException(nameof(state)),
        };

    private static RbpInvocationState FromStorageState(string state) =>
        state switch
        {
            "received" => RbpInvocationState.Received,
            "executing" => RbpInvocationState.Executing,
            "completed" => RbpInvocationState.Completed,
            "failed" => RbpInvocationState.Failed,
            "guarded" => RbpInvocationState.Guarded,
            "cancelled" => RbpInvocationState.Cancelled,
            "indeterminate" => RbpInvocationState.Indeterminate,
            _ => throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The invocation journal holds an unknown state."),
        };

    private static void ValidateInvocationIdentity(
        RbpInvocationIdentity identity)
    {
        ValidateIdentifier(identity.Rsid, nameof(identity), 256);
        ValidateIdentifier(identity.InvocationId, nameof(identity), 36);
        ArgumentException.ThrowIfNullOrWhiteSpace(identity.Method);
        ArgumentException.ThrowIfNullOrWhiteSpace(identity.PolicyJcs);
        ArgumentException.ThrowIfNullOrWhiteSpace(
            identity.RecoveryClearancesJcs);
        RequireSha256(identity.ParamsDigest, nameof(identity));
        if (identity.Mutating !=
            (identity.MutationScopeJcs is { Length: > 0 }))
        {
            throw new ArgumentException(
                "A mutating invocation requires exactly one mutation scope.",
                nameof(identity));
        }

        if ((identity.BatchId is null) != (identity.BatchIndex is null))
        {
            throw new ArgumentException(
                "Batch id and batch index are paired.",
                nameof(identity));
        }
    }

    private static void RequireSha256(string value, string parameterName)
    {
        if (!RbpJournalSerialization.IsSha256Digest(value))
        {
            throw new ArgumentException(
                "Value must be lowercase sha256:<64-hex>.",
                parameterName);
        }
    }
}
