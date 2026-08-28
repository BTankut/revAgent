using System.Security.Cryptography;
using System.Text;
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
///
/// The same call shape carries the frozen Section 6.2.1 conflict block: the
/// admission that commits <c>received</c> is also the one that consults the
/// durable local hold index, so a new mutating invocation cannot reach the
/// add-in past an uncleared conflicting hold no matter which caller admits it.
/// </summary>
internal sealed partial class RbpJournalStore
{
    /// <summary>
    /// Admits an invocation under its canonical idempotency key and applies
    /// the frozen Section 12.2 redelivery rules. On first delivery this
    /// durably persists <c>received</c> plus <c>params_digest</c> before
    /// returning, so the caller may not have written an add-in byte yet — and,
    /// for a new mutating invocation, only after the Section 6.2.1 conflict
    /// gate cleared it.
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
                return AdmitInvocation(context, identity, now);
            },
            cancellationToken);
    }

    private static RbpInvocationAdmissionResult AdmitInvocation(
        RbpJournalWriteContext context,
        RbpInvocationIdentity identity,
        long now)
    {
        RbpStoredInvocation? existing =
            ReadInvocation(context, identity.IdempotencyKey);
        if (existing is null)
        {
            // Spec ~480-482: "Before writing the first add-in byte, the
            // bridge MUST perform the same check against its durable local
            // index." This is that check, and it is unconditional for a new
            // mutating invocation: it runs in the same transaction that would
            // otherwise persist `received`, so no delivery can observe an
            // uncleared hold and still reserve a row.
            if (FindBlockingHold(context, identity) is { } blocking)
            {
                return BlockedByConflictingHold(context, blocking);
            }

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
        string holdId = InstallHold(
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
    }

    /// <summary>
    /// The frozen Section 6.2.1 conflict gate for one <em>new</em> invocation,
    /// against the same durable local index and the same conflict query the
    /// clearance-carrying and batch paths use. Returns the uncleared hold that
    /// blocks this delivery, or null when the delivery is exempt or free.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Spec ~484-485 names the complete exemption list: "Redelivery of an
    /// origin key and a correlated read-only verification are the only
    /// operations exempt from this block."
    /// </para>
    /// <list type="bullet">
    /// <item>Redelivery of an origin key is exempt structurally: this method is
    /// only reached when the canonical idempotency key has no durable row, so
    /// every redelivery keeps its untouched Section 12.2 rule 1-5
    /// arbitration.</item>
    /// <item>A correlated read-only verification is exempt because the block
    /// itself is scoped to "every new mutating invocation or batch" (spec
    /// ~480-481) and a verification read is "an ordinary <c>mutating:false</c>
    /// <c>invoke</c>" (spec ~487). The same sentence leaves every other
    /// non-mutating invocation unblocked; a mutating one carries no exemption
    /// at all.</item>
    /// </list>
    /// </remarks>
    private static RbpVerificationHold? FindBlockingHold(
        RbpJournalWriteContext context,
        RbpInvocationIdentity identity) =>
        identity.Mutating
            ? FindConflictingHold(
                context,
                identity.Rsid,
                identity.MutationScopeJcs!)
            : null;

    /// <summary>
    /// Builds the blocked admission for a new mutating invocation that
    /// conflicts with an uncleared hold.
    /// </summary>
    /// <remarks>
    /// Spec ~482-483: "An active conflict returns the original hold's
    /// <c>journal_indeterminate</c> error without add-in contact even when
    /// <c>invocation_id</c> or <c>batch_id</c> is fresh." Nothing is written:
    /// the fresh envelope gets no journal row, no hold is installed, and the
    /// existing hold is not touched, so the answer really is the original
    /// hold's. The durable row carried back is that hold's first origin
    /// invocation, which retention keeps for as long as the hold is uncleared.
    /// </remarks>
    private static RbpInvocationAdmissionResult BlockedByConflictingHold(
        RbpJournalWriteContext context,
        RbpVerificationHold hold)
    {
        RbpStoredInvocation origin =
            (hold.OrderedOriginIdempotencyKeys.Count > 0
                ? ReadInvocation(
                    context,
                    hold.OrderedOriginIdempotencyKeys[0])
                : null) ??
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "An uncleared Section 6.2.1 hold lost the origin invocation " +
                "row its journal_indeterminate answer is built from.");
        return new RbpInvocationAdmissionResult(
            RbpInvocationAdmission.BlockedByConflictingHold,
            origin,
            hold.VerificationHoldId,
            hold);
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
        CancellationToken cancellationToken = default,
        RbpInvocationIdentity? expectedIdentity = null)
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
        if (terminal.CarrierPlan is not null)
        {
            ValidateCarrierPlan(terminal.CarrierPlan);
        }
        if (terminal.RecoveryPayload is not null)
        {
            RequireSha256(terminal.RecoveryPayload.ResultDigest, nameof(terminal));
            if (!string.Equals(terminal.RecoveryPayload.ResultDigest, terminal.ResultDigest,
                    StringComparison.Ordinal) ||
                !string.Equals(
                    RawResponseDigest(terminal.RecoveryPayload.RawResponseBytes.Span),
                    terminal.ResultDigest,
                    StringComparison.Ordinal))
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.IntegrityCheckFailed,
                    "Recovery material must match the terminal raw-response digest.");
            }
        }

        // An indeterminate mutation carries no caller-supplied body: the store
        // mints it below, together with the hold it must reference.
        bool storeMintsOutcome =
            terminal.State == RbpInvocationState.Indeterminate &&
            terminal.Outcome.ValueKind == JsonValueKind.Undefined;
        string outcomeJson = storeMintsOutcome
            ? string.Empty
            : Rfc8785Json.Canonicalize(terminal.Outcome);
        if (terminal.CarrierPlan is { } suppliedPlan &&
            !string.Equals(
                Rfc8785Json.Canonicalize(suppliedPlan.TerminalPayload),
                outcomeJson,
                StringComparison.Ordinal))
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "Carrier plan terminal disagrees with its durable outcome.");
        }
        string? resultDigest = terminal.ResultDigest;
        long now = NowMilliseconds();
        return ExecuteProvenDecisionAsync<string?>(
            context =>
            {
                RbpStoredInvocation existing =
                    ReadInvocation(context, idempotencyKey) ??
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "An unknown invocation cannot be terminalized.");
                if (expectedIdentity is not null)
                    RequireIdenticalIdentity(existing.Identity, expectedIdentity);

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

                if (terminal.CarrierPlan is { } carrierPlan)
                {
                    InsertCarrierPlan(context, idempotencyKey, carrierPlan, now);
                }

                string? holdId = null;
                if (terminal.State == RbpInvocationState.Indeterminate &&
                    existing.Identity.Mutating)
                {
                    holdId = InstallHold(
                        context,
                        existing.Identity,
                        now);
                    RequireExactDecisionHold(context, existing.Identity.Rsid,
                        existing.Identity.MutationScopeJcs!, [idempotencyKey], holdId);

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
                        carrier_plan_id=$carrier_plan_id,
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
                update.Parameters.AddWithValue(
                    "$carrier_plan_id",
                    (object?)terminal.CarrierPlan?.PlanId ?? DBNull.Value);
                update.Parameters.AddWithValue("$now", now);
                update.Parameters.AddWithValue("$key", idempotencyKey);
                if (update.ExecuteNonQuery() != 1)
                {
                    throw new RbpJournalException(
                        RbpJournalErrorCode.ProtocolConflict,
                        "The invocation left its non-terminal state before " +
                        "the terminal outcome could be persisted.");
                }

                // Payload protection is intentionally best-effort *after* the
                // normal terminal update in the same transaction. A DPAPI or
                // capacity failure cannot strand a completed invocation;
                // recovery simply remains unavailable and no sensitive byte is
                // logged or retained in a fallback form.
                if (terminal.RecoveryPayload is not null &&
                    terminal.State is RbpInvocationState.Completed or RbpInvocationState.Guarded)
                {
                    TryInsertRecoveryPayload(
                        context,
                        existing.Identity,
                        terminal.RecoveryPayload,
                        now);
                }

                return holdId;
            },
            [idempotencyKey], batchKey: null, cancellationToken,
            allowRetry: expectedIdentity is not null && terminal.RecoveryPayload is null);
    }

    /// <summary>
    /// An exception is not proof of rollback or commit. Compare a single
    /// bounded snapshot of the exact decision with the pre/post transaction
    /// projections. Retry persistence once only after exact unchanged-state
    /// proof; never re-enter the add-in. The projection includes full identities,
    /// terminal bytes/digests, carrier plans and complete relevant hold records.
    /// </summary>
    private async Task<T> ExecuteProvenDecisionAsync<T>(
        Func<RbpJournalWriteContext, T> operation,
        IReadOnlyList<string> invocationKeys,
        string? batchKey,
        CancellationToken cancellationToken,
        bool allowRetry = true)
    {
        if (invocationKeys.Count is < 1 or > 1024)
            throw new ArgumentException("A durable decision requires bounded exact invocation keys.");
        string? before = null, intended = null;
        T projection = default!;
        bool produced = false;
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                return await ExecuteImmediateAsync(context =>
                {
                    string current = CaptureDecisionSnapshot(context, invocationKeys, batchKey);
                    if (before is not null && !string.Equals(before, current, StringComparison.Ordinal))
                        throw new RbpJournalException(RbpJournalErrorCode.IntegrityCheckFailed,
                            "The durable decision changed before its persistence-only retry.");
                    before = current;
                    projection = operation(context);
                    intended = CaptureDecisionSnapshot(context, invocationKeys, batchKey);
                    produced = true;
                    return projection;
                }, cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                // ReadAsync serializes the snapshot with local writers; the
                // explicit SQLite read transaction also excludes mixed external
                // generations. No write fault-injection hook runs on a read.
                string observed = await ReadAsync(connection =>
                {
                    using SqliteTransaction snapshot = connection.BeginTransaction(deferred: true);
                    var context = new RbpJournalWriteContext(connection, snapshot, _commandTimeoutSeconds);
                    return CaptureDecisionSnapshot(context, invocationKeys, batchKey);
                }, CancellationToken.None).ConfigureAwait(false);
                if (produced && string.Equals(intended, observed, StringComparison.Ordinal))
                    return projection;
                if (produced && allowRetry && attempt == 0 && string.Equals(before, observed, StringComparison.Ordinal))
                    continue;
                throw;
            }
        }
    }

    private static string CaptureDecisionSnapshot(
        RbpJournalWriteContext context, IReadOnlyList<string> invocationKeys, string? batchKey)
    {
        var rows = new List<RbpStoredInvocation?>(invocationKeys.Count);
        var holds = new SortedDictionary<string, RbpVerificationHold>(StringComparer.Ordinal);
        foreach (string key in invocationKeys)
        {
            RbpStoredInvocation? row = ReadInvocation(context, key);
            rows.Add(row);
            if (row is null) continue;
            void Include(RbpVerificationHold? hold)
            {
                if (hold is not null) holds[hold.VerificationHoldId] = hold;
            }
            if (row.VerificationHoldId is { } id)
                Include(FindHoldById(context, row.Identity.Rsid, id));
            if (row.Identity.MutationScopeJcs is { } scope)
                Include(FindHoldByExactScope(context, row.Identity.Rsid, scope));
            Include(FindHoldByExactScope(context, row.Identity.Rsid, "{\"kind\":\"session\"}"));
        }
        return JsonSerializer.Serialize(new
        {
            invocations = rows,
            batch = batchKey is null ? null : ReadBatch(context, batchKey),
            holds = holds.Values,
        });
    }

    private void TryInsertRecoveryPayload(
        RbpJournalWriteContext context,
        RbpInvocationIdentity identity,
        RbpRecoveryPayload payload,
        long now)
    {
        byte[]? envelope = null;
        RbpProtectedRecoveryPayload protectedPayload;
        try
        {
            envelope = RbpRecoveryPayloadEnvelope.Create(
                identity.Rsid,
                identity.InvocationId,
                identity.IdempotencyKey,
                payload.ResultDigest,
                now,
                checked(now + (long)DefaultRetentionPeriod.TotalMilliseconds),
                payload.RawResponseBytes.Span);
            protectedPayload = _recoveryPayloadProtector.Protect(envelope);
        }
        catch (Exception)
        {
            if (envelope is not null)
            {
                CryptographicOperations.ZeroMemory(envelope);
            }
            payload.Clear();
            return;
        }

        try
        {
            using SqliteCommand capacity = context.CreateCommand(
                "SELECT COALESCE(SUM(plaintext_length),0) FROM rbp_recovery_payloads WHERE rsid=$rsid;");
            capacity.Parameters.AddWithValue("$rsid", identity.Rsid);
            long used = Convert.ToInt64(capacity.ExecuteScalar() ?? 0L);
            if (used > RbpRecoveryPayloadEnvelope.MaxBytes - payload.RawResponseBytes.Length)
            {
                return; // no eviction: oldest recovery material is immutable.
            }

            using SqliteCommand insert = context.CreateCommand(
                """
                INSERT INTO rbp_recovery_payloads(
                  idempotency_key,rsid,invocation_id,result_digest,
                  protection_scheme,protected_envelope,plaintext_length,created_at_ms,
                  retention_expires_at_ms)
                VALUES($key,$rsid,$invocation,$digest,$scheme,$envelope,$length,$now,$retention);
                """);
            insert.Parameters.AddWithValue("$key", identity.IdempotencyKey);
            insert.Parameters.AddWithValue("$rsid", identity.Rsid);
            insert.Parameters.AddWithValue("$invocation", identity.InvocationId);
            insert.Parameters.AddWithValue("$digest", payload.ResultDigest);
            insert.Parameters.AddWithValue("$scheme", protectedPayload.ProtectionScheme);
            insert.Parameters.AddWithValue("$envelope", protectedPayload.CopyCiphertext());
            insert.Parameters.AddWithValue("$length", payload.RawResponseBytes.Length);
            insert.Parameters.AddWithValue("$now", now);
            insert.Parameters.AddWithValue(
                "$retention",
                checked(now + (long)DefaultRetentionPeriod.TotalMilliseconds));
            _ = insert.ExecuteNonQuery();
        }
        catch (SqliteException)
        {
            // Capacity/collision/constraint failure deliberately means no
            // recovery row. The terminal transition remains durable.
        }
        finally
        {
            if (envelope is not null)
            {
                CryptographicOperations.ZeroMemory(envelope);
            }
            payload.Clear();
        }
    }

    private static string RawResponseDigest(ReadOnlySpan<byte> bytes) =>
        "sha256:" + Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static void ValidateCarrierPlan(RbpCarrierPlan plan)
    {
        RequireSha256(plan.PlanId, nameof(plan));
        RequireSha256(plan.PrefixDigest, nameof(plan));
        RequireSha256(plan.TerminalDigest, nameof(plan));
        if (plan.CarrierKey.Length != 64 || plan.CarrierKey.Any(value =>
                !Uri.IsHexDigit(value) || char.IsUpper(value)))
        {
            throw new ArgumentException("Carrier plan key is malformed.", nameof(plan));
        }
        if (plan.OrderedPrefixes.Count == 0 ||
            plan.OrderedPrefixes.Any(frame =>
                !string.Equals(frame.Type, "partial", StringComparison.Ordinal) ||
                frame.Payload.ValueKind is JsonValueKind.Undefined))
        {
            throw new ArgumentException("Carrier plan frames are malformed.", nameof(plan));
        }
        if (plan.TerminalPayload.ValueKind is JsonValueKind.Undefined)
        {
            throw new ArgumentException("Carrier plan terminal is missing.", nameof(plan));
        }
    }

    private static void InsertCarrierPlan(
        RbpJournalWriteContext context,
        string idempotencyKey,
        RbpCarrierPlan plan,
        long now)
    {
        JsonElement prefixes = JsonSerializer.SerializeToElement(
            plan.OrderedPrefixes.Select(frame => new
            {
                type = frame.Type,
                payload = frame.Payload,
            }));
        string prefixesJcs = prefixes.GetRawText();
        string terminalJcs = plan.TerminalPayload.GetRawText();
        if (!string.Equals(RawJsonDigest(prefixesJcs), plan.PrefixDigest,
                StringComparison.Ordinal) ||
            !string.Equals(RawJsonDigest(terminalJcs),
                plan.TerminalDigest, StringComparison.Ordinal))
        {
            throw new RbpJournalException(RbpJournalErrorCode.IntegrityCheckFailed,
                "Carrier plan digest does not cover its durable material.");
        }
        using SqliteCommand insert = context.CreateCommand("""
            INSERT INTO rbp_carrier_plans(
              plan_id,idempotency_key,carrier_key,prefixes_jcs,prefix_digest,
              terminal_jcs,terminal_digest,created_at_ms
            ) VALUES($plan_id,$key,$carrier_key,$prefixes,$prefix_digest,
              $terminal,$terminal_digest,$now);
            """);
        insert.Parameters.AddWithValue("$plan_id", plan.PlanId);
        insert.Parameters.AddWithValue("$key", idempotencyKey);
        insert.Parameters.AddWithValue("$carrier_key", plan.CarrierKey);
        insert.Parameters.AddWithValue("$prefixes", prefixesJcs);
        insert.Parameters.AddWithValue("$prefix_digest", plan.PrefixDigest);
        insert.Parameters.AddWithValue("$terminal", terminalJcs);
        insert.Parameters.AddWithValue("$terminal_digest", plan.TerminalDigest);
        insert.Parameters.AddWithValue("$now", now);
        if (insert.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(RbpJournalErrorCode.IntegrityCheckFailed,
                "Carrier plan could not be persisted before its terminal.");
        }
    }

    private static string RawJsonDigest(string json) => "sha256:" +
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(json))).ToLowerInvariant();

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
    /// Narrow C39 capability: an exact owner-RSID, UUIDv7 origin and digest
    /// tuple can read the protected raw response bytes once the caller's own
    /// principal/session authority has passed. This is not a generic journal
    /// lookup and it never replays, parses, or mutates an invocation.
    /// </summary>
    internal Task<RbpRecoveredPayload?> GetCorrelatedRecoveryPayloadAsync(
        string rsid,
        string originInvocationId,
        string expectedResultDigest,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), 256);
        if (!RbpRecoveryClearance.IsUuidV7(originInvocationId))
        {
            throw new ArgumentException("Origin invocation id must be a UUIDv7.", nameof(originInvocationId));
        }
        RequireSha256(expectedResultDigest, nameof(expectedResultDigest));
        return ReadAsync(
            connection => ReadCorrelatedRecoveryPayload(
                connection,
                rsid,
                originInvocationId,
                expectedResultDigest),
            cancellationToken);
    }

    private RbpRecoveredPayload? ReadCorrelatedRecoveryPayload(
        SqliteConnection connection,
        string rsid,
        string originInvocationId,
        string expectedResultDigest)
    {
        try
        {
            using SqliteCommand command = CreateCommand(connection, """
                SELECT payload.protection_scheme,payload.protected_envelope,
                       payload.plaintext_length,payload.created_at_ms,
                       payload.retention_expires_at_ms,payload.idempotency_key
                FROM rbp_recovery_payloads AS payload
                JOIN rbp_invocations AS invocation
                  ON invocation.idempotency_key=payload.idempotency_key
                WHERE payload.rsid=$rsid
                  AND payload.invocation_id=$invocation
                  AND payload.result_digest=$digest
                  AND invocation.rsid=$rsid
                  AND invocation.invocation_id=$invocation
                  AND invocation.result_digest=$digest
                  AND invocation.state IN ('completed','guarded')
                LIMIT 1;
                """);
            command.CommandTimeout = _commandTimeoutSeconds;
            command.Parameters.AddWithValue("$rsid", rsid);
            command.Parameters.AddWithValue("$invocation", originInvocationId);
            command.Parameters.AddWithValue("$digest", expectedResultDigest);
            using SqliteDataReader reader = command.ExecuteReader();
            if (!reader.Read())
            {
                return null;
            }
            string scheme = reader.GetString(0);
            byte[] ciphertext = (byte[])reader.GetValue(1);
            int length = reader.GetInt32(2);
            long createdAt = reader.GetInt64(3);
            long retentionExpiresAt = reader.GetInt64(4);
            string idempotencyKey = reader.GetString(5);
            if (length is <= 0 or > RbpRecoveryPayloadEnvelope.MaxBytes ||
                retentionExpiresAt <= NowMilliseconds())
            {
                return null;
            }
            byte[] envelope = _recoveryPayloadProtector.Unprotect(
                new RbpProtectedRecoveryPayload(scheme, ciphertext));
            try
            {
                byte[] raw = RbpRecoveryPayloadEnvelope.Read(
                    rsid, originInvocationId, idempotencyKey,
                    expectedResultDigest, createdAt, retentionExpiresAt, envelope);
                if (raw.Length != length || !string.Equals(
                        RawResponseDigest(raw), expectedResultDigest,
                        StringComparison.Ordinal))
                {
                    CryptographicOperations.ZeroMemory(raw);
                    return null;
                }
                try
                {
                    return new RbpRecoveredPayload(expectedResultDigest, raw);
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(raw);
                }
            }
            finally
            {
                CryptographicOperations.ZeroMemory(envelope);
            }
        }
        catch (Exception exception) when (
            exception is CryptographicException or ArgumentException or
            FormatException or InvalidOperationException or SqliteException)
        {
            // Opaque denial preserves the absence/corruption/protection
            // boundary and contains no payload, JSON, path, or secret detail.
            return null;
        }
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
            string.Equals(stored.Rsid, incoming.Rsid, StringComparison.Ordinal) &&
            string.Equals(stored.InvocationId, incoming.InvocationId, StringComparison.Ordinal) &&
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

    /// <summary>
    /// Installs the Section 6.2.1 hold for one uncertain single invocation.
    /// </summary>
    /// <remarks>
    /// Spec ~477: "For one invocation the origin list has one key."
    /// </remarks>
    private static string InstallHold(
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

        return InstallHold(
            context,
            identity.Rsid,
            scopeJcs,
            new[] { identity.IdempotencyKey },
            now);
    }

    /// <summary>
    /// Installs the Section 6.2.1 hold for one uncertain mutation scope and
    /// returns its derived correlation id (spec ~469-480).
    /// </summary>
    /// <remarks>
    /// <para>
    /// The id is not minted: it is
    /// <c>"vh:" + lowercase_hex(SHA-256(UTF-8-without-BOM(RFC8785-JCS(hold_material))))</c>
    /// over
    /// <c>{"mutation_scope":&lt;scope&gt;,"origin_idempotency_keys":[&lt;ordered keys&gt;],"rsid":&lt;rsid&gt;}</c>,
    /// so a conforming peer derives the same value from the work it knows is
    /// uncertain. A randomly minted id has the right shape and is refused by
    /// a conforming Gateway, which closes the link.
    /// </para>
    /// <para>
    /// Because the id is a pure function of the material, the ordered origin
    /// list is fixed when the hold is installed and is never mutated
    /// afterwards. Spec ~470 makes the id a <em>stable</em> correlation value
    /// while the durable index stays <c>(rsid, mutation_scope)</c>; spec
    /// ~477-480 defines the origin list only for one invocation or one
    /// uncertain atomic batch; and spec ~482-485 answers every later
    /// conflicting mutation with <em>the original hold's</em>
    /// <c>journal_indeterminate</c> error rather than joining it to that
    /// hold. Re-deriving on a later origin would move a stable id, and
    /// appending without re-deriving would emit an id no peer can derive, so
    /// an existing uncleared hold on the exact scope is returned unchanged.
    /// </para>
    /// </remarks>
    private static string InstallHold(
        RbpJournalWriteContext context,
        string rsid,
        string scopeJcs,
        IReadOnlyList<string> orderedOriginIdempotencyKeys,
        long now)
    {
        RbpVerificationHold? existing =
            FindHoldByExactScope(context, rsid, scopeJcs);
        if (existing is not null)
        {
            return existing.VerificationHoldId;
        }

        (string scopeKind, string? documentId) = ReadScopeShape(scopeJcs);
        string holdId;
        using (JsonDocument scope = JsonDocument.Parse(scopeJcs))
        {
            holdId = Rfc8785Json.MakeVerificationHoldId(
                rsid,
                scope.RootElement,
                orderedOriginIdempotencyKeys);
        }

        if (FindHoldById(context, rsid, holdId) is not null)
        {
            // Identical hold material under a scope row that is already
            // cleared or already indexed elsewhere cannot be reused; a
            // resurrected correlation id is never inferred.
            throw new RbpJournalException(
                RbpJournalErrorCode.ProtocolConflict,
                "The derived Section 6.2.1 hold id already exists for this " +
                "session; the frozen hold material cannot be reused.");
        }

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
        insert.Parameters.AddWithValue("$rsid", rsid);
        insert.Parameters.AddWithValue("$kind", scopeKind);
        insert.Parameters.AddWithValue(
            "$document",
            (object?)documentId ?? DBNull.Value);
        insert.Parameters.AddWithValue("$scope", scopeJcs);
        insert.Parameters.AddWithValue(
            "$origins",
            JsonSerializer.Serialize(orderedOriginIdempotencyKeys));
        insert.Parameters.AddWithValue("$now", now);
        if (insert.ExecuteNonQuery() != 1)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The mutation-recovery hold could not be installed.");
        }

        return holdId;
    }

    private static void RequireExactDecisionHold(RbpJournalWriteContext context,
        string rsid, string scopeJcs, IReadOnlyList<string> origins, string holdId)
    {
        using JsonDocument scope = JsonDocument.Parse(scopeJcs);
        string expectedId = Rfc8785Json.MakeVerificationHoldId(rsid, scope.RootElement, origins);
        RbpVerificationHold? hold = FindHoldById(context, rsid, holdId);
        if (hold is null || hold.VerificationHoldId != expectedId || hold.ScopeJcs != scopeJcs ||
            hold.State != RbpHoldState.Active ||
            !hold.OrderedOriginIdempotencyKeys.SequenceEqual(origins, StringComparer.Ordinal))
            throw new RbpJournalException(RbpJournalErrorCode.IntegrityCheckFailed,
                "The current dispatch hold does not represent this exact ordered origin set.");
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
