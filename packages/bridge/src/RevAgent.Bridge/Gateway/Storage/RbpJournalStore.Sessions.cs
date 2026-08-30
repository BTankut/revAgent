using System.Text.Json;
using Microsoft.Data.Sqlite;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Storage;

internal enum RbpRegistrationSafetyDisposition
{
    Eligible,
    Deferred,
}

internal enum RbpLocalRegistrationDisposition
{
    CleanupPending,
    Registered,
}

internal sealed record RbpRegistrationSafetyAssessment(
    RbpRegistrationSafetyDisposition Disposition,
    string LocalSessionKey,
    string RegistrationDigest,
    string SafetyDecisionDigest,
    string? Reason);

internal sealed record RbpCleanupRegistrationReceipt(
    RbpStoredSession Session,
    RbpUnregisterTombstone Tombstone,
    string SafetyDecisionDigest);

internal sealed record RbpRegistrationCommitResult(
    RbpLocalRegistrationDisposition Disposition,
    RbpStoredSession Session,
    string SafetyDecisionDigest,
    RbpCleanupRegistrationReceipt? CleanupReceipt);

internal sealed partial class RbpJournalStore
{
    internal Task<RbpRegistrationSafetyAssessment>
        AssessRegistrationSafetyAsync(
            string localSessionKey,
            string registrationDigest,
            CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(
            localSessionKey,
            nameof(localSessionKey),
            maximumLength: 512);
        if (!RbpJournalSerialization.IsSha256Digest(registrationDigest))
        {
            throw new ArgumentException(
                "Registration digest must be a lowercase SHA-256 digest.",
                nameof(registrationDigest));
        }

        return ReadAsync(
            connection =>
            {
                using SqliteTransaction transaction =
                    connection.BeginTransaction(deferred: true);
                var context = new RbpJournalWriteContext(
                    connection,
                    transaction,
                    _commandTimeoutSeconds);
                RbpLegacySafetyPlan plan = ClassifyLegacySafety(
                    context,
                    RbpLegacySafetyQuery.ForRegistration(
                        localSessionKey,
                        registrationDigest),
                    RbpProjectedHoldView.Empty,
                    RbpLegacySafetyBudget.Registration);
                return ToRegistrationAssessment(
                    localSessionKey,
                    registrationDigest,
                    plan);
            },
            cancellationToken);
    }

    internal async Task<RbpRegistrationCommitResult>
        PersistRegistrationAfterAcknowledgementAsync(
            RbpSessionRegistration registration,
            RbpRegistrationSafetyAssessment preflight,
            CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(registration);
        ArgumentNullException.ThrowIfNull(preflight);
        ValidateIdentifier(registration.Rsid, nameof(registration.Rsid), 256);
        ValidateIdentifier(
            registration.LocalSessionKey,
            nameof(registration.LocalSessionKey),
            512);
        if (string.IsNullOrEmpty(registration.ResumeToken))
        {
            throw new ArgumentException(
                "The resume token must not be empty.",
                nameof(registration));
        }

        long expiresAtMilliseconds =
            registration.ResumeExpiresAt.ToUnixTimeMilliseconds();
        if (expiresAtMilliseconds < 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(registration),
                "Resume expiry must not precede the Unix epoch.");
        }

        (string registrationJson, string registrationDigest) =
            RbpJournalSerialization.CanonicalRegistration(
                registration.RegistrationPayload);
        IReadOnlyList<string> capabilities =
            RbpJournalSerialization.NormalizeCapabilities(
                registration.GrantedCapabilities);
        string capabilitiesJson =
            RbpJournalSerialization.SerializeCapabilities(capabilities);
        RequireExactPreflight(
            preflight,
            registration.LocalSessionKey,
            registrationDigest);
        long now = NowMilliseconds();
        RbpRegistrationCommitResult? attempted = null;
        try
        {
            return await ExecuteImmediateAsync(
                    context =>
                    {
                        RbpLegacySafetyPlan plan = ClassifyLegacySafety(
                            context,
                            RbpLegacySafetyQuery.ForRegistration(
                                registration.LocalSessionKey,
                                registrationDigest),
                            RbpProjectedHoldView.Empty,
                            RbpLegacySafetyBudget.Registration);
                        RbpRegistrationSafetyAssessment fresh =
                            ToRegistrationAssessment(
                                registration.LocalSessionKey,
                                registrationDigest,
                                plan);
                        bool register =
                            fresh.Disposition ==
                                RbpRegistrationSafetyDisposition.Eligible &&
                            string.Equals(
                                fresh.SafetyDecisionDigest,
                                preflight.SafetyDecisionDigest,
                                StringComparison.Ordinal);

                        RbpStoredSession? existing =
                            ReadStoredSession(context, registration.Rsid);
                        if (existing is not null)
                        {
                            RequireExactRegistration(
                                existing,
                                registration,
                                registrationDigest,
                                capabilities);
                            RbpUnregisterTombstone? tombstone =
                                ReadTombstone(context, registration.Rsid);
                            if (tombstone is not null)
                            {
                                attempted = ExactCleanupRegistrationReceipt(
                                    context,
                                    existing,
                                    tombstone);
                                return attempted;
                            }

                            if (register)
                            {
                                attempted = new RbpRegistrationCommitResult(
                                    RbpLocalRegistrationDisposition.Registered,
                                    existing,
                                    fresh.SafetyDecisionDigest,
                                    CleanupReceipt: null);
                                return attempted;
                            }

                            InsertCleanupTombstone(
                                context,
                                registration.Rsid,
                                now);
                            RbpUnregisterTombstone replayCleanup =
                                ReadTombstone(context, registration.Rsid) ??
                                throw RbpJournalSerialization.Corrupt(
                                    "The cleanup-only unregister tombstone " +
                                    "could not be re-read.");
                            attempted = ExactCleanupRegistrationReceipt(
                                context,
                                existing,
                                replayCleanup);
                            return attempted;
                        }

                        RbpProtectedResumeToken protectedToken =
                            ProtectResumeToken(registration.ResumeToken);
                        InsertRegisteredSessionRows(
                            context,
                            registration,
                            registrationJson,
                            registrationDigest,
                            protectedToken,
                            expiresAtMilliseconds,
                            capabilitiesJson,
                            now);
                        RbpStoredSession stored =
                            ReadStoredSession(context, registration.Rsid) ??
                            throw RbpJournalSerialization.Corrupt(
                                "The newly registered RBP session could not " +
                                "be re-read.");
                        if (register)
                        {
                            attempted = new RbpRegistrationCommitResult(
                                RbpLocalRegistrationDisposition.Registered,
                                stored,
                                fresh.SafetyDecisionDigest,
                                CleanupReceipt: null);
                            return attempted;
                        }

                        InsertCleanupTombstone(
                            context,
                            registration.Rsid,
                            now);

                        RbpUnregisterTombstone cleanup =
                            ReadTombstone(context, registration.Rsid) ??
                            throw RbpJournalSerialization.Corrupt(
                                "The cleanup-only unregister tombstone could " +
                                "not be re-read.");
                        attempted = ExactCleanupRegistrationReceipt(
                            context,
                            stored,
                            cleanup);
                        return attempted;
                    },
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (RbpJournalException exception)
            when (exception.ErrorCode ==
                  RbpJournalErrorCode.PostCommitFailure &&
                  attempted is not null)
        {
            return await RecoverRegistrationCommitAsync(
                    registration,
                    registrationDigest,
                    capabilities,
                    attempted,
                    exception)
                .ConfigureAwait(false);
        }
    }

    internal async Task<RbpStoredSession> PersistRegisteredSessionAsync(
        RbpSessionRegistration registration,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(registration);
        ValidateIdentifier(
            registration.Rsid,
            nameof(registration.Rsid),
            maximumLength: 256);
        ValidateIdentifier(
            registration.LocalSessionKey,
            nameof(registration.LocalSessionKey),
            maximumLength: 512);
        if (string.IsNullOrEmpty(registration.ResumeToken))
        {
            throw new ArgumentException(
                "The resume token must not be empty.",
                nameof(registration));
        }

        long expiresAtMilliseconds =
            registration.ResumeExpiresAt.ToUnixTimeMilliseconds();
        if (expiresAtMilliseconds < 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(registration),
                "Resume expiry must not precede the Unix epoch.");
        }

        (string registrationJson, string registrationDigest) =
            RbpJournalSerialization.CanonicalRegistration(
                registration.RegistrationPayload);
        IReadOnlyList<string> capabilities =
            RbpJournalSerialization.NormalizeCapabilities(
                registration.GrantedCapabilities);
        string capabilitiesJson =
            RbpJournalSerialization.SerializeCapabilities(capabilities);
        long now = NowMilliseconds();

        try
        {
            return await ExecuteImmediateAsync(
                    context =>
                    {
                        RbpStoredSession? existing =
                            ReadStoredSession(context, registration.Rsid);
                        if (existing is not null)
                        {
                            RequireExactRegistration(
                                existing,
                                registration,
                                registrationDigest,
                                capabilities);
                            return existing;
                        }

                        RbpRegistrationSafetyAssessment safety =
                            ToRegistrationAssessment(
                                registration.LocalSessionKey,
                                registrationDigest,
                                ClassifyLegacySafety(
                                    context,
                                    RbpLegacySafetyQuery.ForRegistration(
                                        registration.LocalSessionKey,
                                        registrationDigest),
                                    RbpProjectedHoldView.Empty,
                                    RbpLegacySafetyBudget.Registration));
                        if (safety.Disposition !=
                            RbpRegistrationSafetyDisposition.Eligible)
                        {
                            throw new RbpJournalException(
                                RbpJournalErrorCode.SessionConflict,
                                "The new RBP registration is deferred by " +
                                "unresolved predecessor safety state.");
                        }

                        RbpProtectedResumeToken protectedToken =
                            ProtectResumeToken(registration.ResumeToken);
                        using (SqliteCommand insert = context.CreateCommand(
                                   """
                                   INSERT INTO rbp_sessions(
                                     rsid,local_session_key,registration_json,
                                     registration_digest,
                                     resume_token_protected,
                                     resume_token_protection,
                                     resume_expires_at_ms,
                                     granted_capabilities_json,
                                     created_at_ms,updated_at_ms
                                   ) VALUES(
                                     $rsid,$local_session_key,
                                     $registration_json,$registration_digest,
                                     $resume_token_protected,
                                     $resume_token_protection,
                                     $resume_expires_at_ms,
                                     $granted_capabilities_json,$now,$now
                                   );
                                   """))
                        {
                            insert.Parameters.AddWithValue(
                                "$rsid",
                                registration.Rsid);
                            insert.Parameters.AddWithValue(
                                "$local_session_key",
                                registration.LocalSessionKey);
                            insert.Parameters.AddWithValue(
                                "$registration_json",
                                registrationJson);
                            insert.Parameters.AddWithValue(
                                "$registration_digest",
                                registrationDigest);
                            insert.Parameters.AddWithValue(
                                "$resume_token_protected",
                                protectedToken.CopyCiphertext());
                            insert.Parameters.AddWithValue(
                                "$resume_token_protection",
                                protectedToken.ProtectionScheme);
                            insert.Parameters.AddWithValue(
                                "$resume_expires_at_ms",
                                expiresAtMilliseconds);
                            insert.Parameters.AddWithValue(
                                "$granted_capabilities_json",
                                capabilitiesJson);
                            insert.Parameters.AddWithValue("$now", now);
                            _ = insert.ExecuteNonQuery();
                        }

                        using (SqliteCommand sequence =
                               context.CreateCommand(
                                   """
                                   INSERT INTO rbp_session_sequence(
                                     rsid,next_tx_seq,highest_tx_seq,
                                     last_rx_seq,last_journaled_rx_seq,
                                     last_peer_ack,updated_at_ms
                                   ) VALUES($rsid,1,0,0,0,0,$now);
                                   """))
                        {
                            sequence.Parameters.AddWithValue(
                                "$rsid",
                                registration.Rsid);
                            sequence.Parameters.AddWithValue("$now", now);
                            _ = sequence.ExecuteNonQuery();
                        }

                        return ReadStoredSession(
                                   context,
                                   registration.Rsid) ??
                            throw RbpJournalSerialization.Corrupt(
                                "The newly registered RBP session could not " +
                                "be re-read.");
                    },
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (RbpJournalException exception)
            when (exception.ErrorCode ==
                  RbpJournalErrorCode.PostCommitFailure)
        {
            RbpStoredSession? recovered =
                await ReadAsync(
                        connection =>
                        {
                            RequireActiveSession(
                                connection,
                                registration.Rsid);
                            return ReadStoredSession(
                                connection,
                                registration.Rsid);
                        },
                        CancellationToken.None)
                    .ConfigureAwait(false);
            if (recovered is null)
            {
                throw;
            }

            RequireExactRegistration(
                recovered,
                registration,
                registrationDigest,
                capabilities);
            return recovered;
        }
    }

    internal Task<RbpStoredSession?> GetStoredSessionAsync(
        string rsid,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentifier(rsid, nameof(rsid), maximumLength: 256);
        return ReadAsync(
            connection => ReadStoredSession(connection, rsid),
            cancellationToken);
    }

    private static void RequireExactPreflight(
        RbpRegistrationSafetyAssessment preflight,
        string localSessionKey,
        string registrationDigest)
    {
        bool exact =
            preflight.Disposition ==
                RbpRegistrationSafetyDisposition.Eligible &&
            preflight.Reason is null &&
            string.Equals(
                preflight.LocalSessionKey,
                localSessionKey,
                StringComparison.Ordinal) &&
            string.Equals(
                preflight.RegistrationDigest,
                registrationDigest,
                StringComparison.Ordinal) &&
            RbpJournalSerialization.IsSha256Digest(
                preflight.SafetyDecisionDigest);
        if (!exact)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The post-acknowledgement registration does not carry the " +
                "exact eligible preflight assessment.");
        }
    }

    private void InsertRegisteredSessionRows(
        RbpJournalWriteContext context,
        RbpSessionRegistration registration,
        string registrationJson,
        string registrationDigest,
        RbpProtectedResumeToken protectedToken,
        long expiresAtMilliseconds,
        string capabilitiesJson,
        long now)
    {
        using (SqliteCommand insert = context.CreateCommand(
                   """
                   INSERT INTO rbp_sessions(
                     rsid,local_session_key,registration_json,
                     registration_digest,resume_token_protected,
                     resume_token_protection,resume_expires_at_ms,
                     granted_capabilities_json,created_at_ms,updated_at_ms
                   ) VALUES(
                     $rsid,$local_session_key,$registration_json,
                     $registration_digest,$resume_token_protected,
                     $resume_token_protection,$resume_expires_at_ms,
                     $granted_capabilities_json,$now,$now
                   );
                   """))
        {
            insert.Parameters.AddWithValue("$rsid", registration.Rsid);
            insert.Parameters.AddWithValue(
                "$local_session_key",
                registration.LocalSessionKey);
            insert.Parameters.AddWithValue(
                "$registration_json",
                registrationJson);
            insert.Parameters.AddWithValue(
                "$registration_digest",
                registrationDigest);
            insert.Parameters.AddWithValue(
                "$resume_token_protected",
                protectedToken.CopyCiphertext());
            insert.Parameters.AddWithValue(
                "$resume_token_protection",
                protectedToken.ProtectionScheme);
            insert.Parameters.AddWithValue(
                "$resume_expires_at_ms",
                expiresAtMilliseconds);
            insert.Parameters.AddWithValue(
                "$granted_capabilities_json",
                capabilitiesJson);
            insert.Parameters.AddWithValue("$now", now);
            if (insert.ExecuteNonQuery() != 1)
            {
                throw RbpJournalSerialization.Corrupt(
                    "The registered RBP session could not be inserted.");
            }
        }

        using SqliteCommand sequence = context.CreateCommand(
            """
            INSERT INTO rbp_session_sequence(
              rsid,next_tx_seq,highest_tx_seq,last_rx_seq,
              last_journaled_rx_seq,last_peer_ack,updated_at_ms
            ) VALUES($rsid,1,0,0,0,0,$now);
            """);
        sequence.Parameters.AddWithValue("$rsid", registration.Rsid);
        sequence.Parameters.AddWithValue("$now", now);
        if (sequence.ExecuteNonQuery() != 1)
        {
            throw RbpJournalSerialization.Corrupt(
                "The pristine RBP session sequence could not be inserted.");
        }
    }

    private static void InsertCleanupTombstone(
        RbpJournalWriteContext context,
        string rsid,
        long now)
    {
        using SqliteCommand insert = context.CreateCommand(
            """
            INSERT INTO rbp_unregister_tombstones(
              rsid,reason,phase,created_at_ms,updated_at_ms
            ) VALUES(
              $rsid,'operator_requested','pending',$now,$now
            );
            """);
        insert.Parameters.AddWithValue("$rsid", rsid);
        insert.Parameters.AddWithValue("$now", now);
        if (insert.ExecuteNonQuery() != 1)
        {
            throw RbpJournalSerialization.Corrupt(
                "The cleanup-only unregister tombstone could not be inserted.");
        }
    }

    private RbpRegistrationCommitResult ExactCleanupRegistrationReceipt(
        RbpJournalWriteContext context,
        RbpStoredSession session,
        RbpUnregisterTombstone tombstone)
    {
        bool exactTombstone =
            string.Equals(
                tombstone.Rsid,
                session.Rsid,
                StringComparison.Ordinal) &&
            tombstone.Reason ==
                RbpSessionUnregisterReason.OperatorRequested &&
            tombstone.Phase == RbpUnregisterPhase.Pending;
        using SqliteCommand baseline = context.CreateCommand(
            """
            SELECT next_tx_seq,highest_tx_seq,last_rx_seq,
                   last_journaled_rx_seq,last_peer_ack,
                   (SELECT COUNT(*) FROM rbp_inbound_receipts
                    WHERE rsid=$rsid),
                   (SELECT COUNT(*) FROM rbp_outbox WHERE rsid=$rsid),
                   (SELECT COUNT(*) FROM rbp_invocations WHERE rsid=$rsid),
                   (SELECT COUNT(*) FROM rbp_batches WHERE rsid=$rsid),
                   (SELECT COUNT(*) FROM rbp_recovery_payloads
                    WHERE rsid=$rsid),
                   (SELECT COUNT(*) FROM rbp_recovery_carrier_reservations
                    WHERE rsid=$rsid),
                   (SELECT COUNT(*) FROM rbp_recovery_terminal_plans
                    WHERE rsid=$rsid),
                   (SELECT COUNT(*) FROM rbp_recovery_sequence_tombstones
                    WHERE rsid=$rsid)
            FROM rbp_session_sequence
            WHERE rsid=$rsid;
            """);
        baseline.Parameters.AddWithValue("$rsid", session.Rsid);
        using SqliteDataReader reader = baseline.ExecuteReader();
        bool pristine = reader.Read() &&
            reader.GetInt64(0) == 1 &&
            Enumerable.Range(1, 12).All(index => reader.GetInt64(index) == 0);
        if (!exactTombstone || !pristine)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.IntegrityCheckFailed,
                "The cleanup-only registration receipt is not exact and " +
                "pristine.");
        }

        string cleanupSuppressionDigest =
            RegistrationCleanupSuppressionDigest(session, tombstone);
        var receipt = new RbpCleanupRegistrationReceipt(
            session,
            tombstone,
            cleanupSuppressionDigest);
        return new RbpRegistrationCommitResult(
            RbpLocalRegistrationDisposition.CleanupPending,
            session,
            cleanupSuppressionDigest,
            receipt);
    }

    private static string RegistrationCleanupSuppressionDigest(
        RbpStoredSession session,
        RbpUnregisterTombstone tombstone) =>
        Rfc8785Json.Sha256Digest(
            JsonSerializer.SerializeToElement(
                new
                {
                    schema = "bridge.registration-cleanup-suppression/v1",
                    session.Rsid,
                    session.LocalSessionKey,
                    session.RegistrationDigest,
                    Reason = tombstone.Reason.ToString(),
                    Phase = tombstone.Phase.ToString(),
                }));

    private async Task<RbpRegistrationCommitResult>
        RecoverRegistrationCommitAsync(
            RbpSessionRegistration registration,
            string registrationDigest,
            IReadOnlyList<string> capabilities,
            RbpRegistrationCommitResult attempted,
            RbpJournalException original)
    {
        return await ReadAsync(
                connection =>
                {
                    using SqliteTransaction transaction =
                        connection.BeginTransaction(deferred: true);
                    var context = new RbpJournalWriteContext(
                        connection,
                        transaction,
                        _commandTimeoutSeconds);
                    RbpStoredSession? stored =
                        ReadStoredSession(context, registration.Rsid);
                    if (stored is null)
                    {
                        throw original;
                    }

                    RequireExactRegistration(
                        stored,
                        registration,
                        registrationDigest,
                        capabilities);
                    RbpUnregisterTombstone? tombstone =
                        ReadTombstone(context, registration.Rsid);
                    if (attempted.Disposition ==
                        RbpLocalRegistrationDisposition.Registered)
                    {
                        if (tombstone is not null)
                        {
                            throw original;
                        }

                        return attempted with { Session = stored };
                    }

                    if (tombstone is null)
                    {
                        throw original;
                    }

                    RbpRegistrationCommitResult recovered =
                        ExactCleanupRegistrationReceipt(
                        context,
                        stored,
                        tombstone);
                    if (!string.Equals(
                            attempted.SafetyDecisionDigest,
                            recovered.SafetyDecisionDigest,
                            StringComparison.Ordinal) ||
                        attempted.CleanupReceipt is null ||
                        !string.Equals(
                            attempted.CleanupReceipt.SafetyDecisionDigest,
                            recovered.CleanupReceipt?.SafetyDecisionDigest,
                            StringComparison.Ordinal))
                    {
                        throw original;
                    }

                    return recovered;
                },
                CancellationToken.None)
            .ConfigureAwait(false);
    }

    private RbpStoredSession? ReadStoredSession(
        RbpJournalWriteContext context,
        string rsid)
    {
        using SqliteCommand command = context.CreateCommand(
            """
            SELECT rsid,local_session_key,registration_json,
                   registration_digest,resume_token_protected,
                   resume_token_protection,resume_expires_at_ms,
                   granted_capabilities_json,created_at_ms,updated_at_ms
            FROM rbp_sessions
            WHERE rsid=$rsid;
            """);
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        return reader.Read() ? MaterializeSession(reader) : null;
    }

    private RbpStoredSession? ReadStoredSession(
        SqliteConnection connection,
        string rsid)
    {
        using SqliteCommand command = CreateCommand(
            connection,
            """
            SELECT rsid,local_session_key,registration_json,
                   registration_digest,resume_token_protected,
                   resume_token_protection,resume_expires_at_ms,
                   granted_capabilities_json,created_at_ms,updated_at_ms
            FROM rbp_sessions
            WHERE rsid=$rsid;
            """);
        command.CommandTimeout = _commandTimeoutSeconds;
        command.Parameters.AddWithValue("$rsid", rsid);
        using SqliteDataReader reader = command.ExecuteReader();
        return reader.Read() ? MaterializeSession(reader) : null;
    }

    private RbpStoredSession MaterializeSession(SqliteDataReader reader)
    {
        string registrationJson = reader.GetString(2);
        string registrationDigest = reader.GetString(3);
        long expiresAtMilliseconds = reader.GetInt64(6);
        long createdAtMilliseconds = reader.GetInt64(8);
        long updatedAtMilliseconds = reader.GetInt64(9);
        try
        {
            var protectedToken = new RbpProtectedResumeToken(
                reader.GetString(5),
                (byte[])reader.GetValue(4));
            string resumeToken =
                UnprotectResumeToken(protectedToken);
            JsonElement registration =
                RbpJournalSerialization.ParseRegistration(
                    registrationJson,
                    registrationDigest);
            IReadOnlyList<string> capabilities =
                RbpJournalSerialization.ParseCapabilities(
                    reader.GetString(7));
            if (!string.Equals(
                    RbpJournalSerialization.SerializeCapabilities(
                        capabilities),
                    reader.GetString(7),
                    StringComparison.Ordinal))
            {
                throw RbpJournalSerialization.Corrupt(
                    "Granted capabilities are not stored canonically.");
            }

            return new RbpStoredSession(
                reader.GetString(0),
                reader.GetString(1),
                registration,
                registrationDigest,
                new RbpSecretString(resumeToken),
                DateTimeOffset.FromUnixTimeMilliseconds(
                    expiresAtMilliseconds),
                capabilities,
                createdAtMilliseconds,
                updatedAtMilliseconds);
        }
        catch (RbpJournalException)
        {
            throw;
        }
        catch (ArgumentOutOfRangeException exception)
        {
            throw RbpJournalSerialization.Corrupt(
                "The stored session timestamp is invalid.",
                exception);
        }
        catch (Exception exception)
            when (exception is ArgumentException or InvalidCastException)
        {
            throw RbpJournalSerialization.Corrupt(
                "The stored protected resume-token record is malformed.",
                exception);
        }
    }

    private RbpProtectedResumeToken ProtectResumeToken(string plaintext)
    {
        try
        {
            RbpProtectedResumeToken protectedToken =
                _resumeTokenProtector.Protect(plaintext);
            return protectedToken?.Snapshot() ??
                throw new InvalidOperationException(
                    "Resume-token protector returned null.");
        }
        catch (Exception exception)
            when (exception is not RbpJournalException)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.SecretProtectionFailed,
                "The resume token could not be protected for durable storage.",
                exception);
        }
    }

    private string UnprotectResumeToken(
        RbpProtectedResumeToken protectedToken)
    {
        try
        {
            string plaintext =
                _resumeTokenProtector.Unprotect(protectedToken.Snapshot());
            if (string.IsNullOrEmpty(plaintext))
            {
                throw new InvalidOperationException(
                    "Resume-token protector returned an empty value.");
            }

            return plaintext;
        }
        catch (Exception exception)
            when (exception is not RbpJournalException)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.SecretProtectionFailed,
                "The durable resume token could not be unprotected. Session " +
                "resume is blocked fail-closed.",
                exception);
        }
    }

    private static void RequireExactRegistration(
        RbpStoredSession existing,
        RbpSessionRegistration requested,
        string requestedDigest,
        IReadOnlyList<string> requestedCapabilities)
    {
        bool exact =
            string.Equals(
                existing.LocalSessionKey,
                requested.LocalSessionKey,
                StringComparison.Ordinal) &&
            string.Equals(
                existing.RegistrationDigest,
                requestedDigest,
                StringComparison.Ordinal) &&
            string.Equals(
                existing.ResumeToken.Reveal(),
                requested.ResumeToken,
                StringComparison.Ordinal) &&
            existing.ResumeExpiresAt.ToUnixTimeMilliseconds() ==
            requested.ResumeExpiresAt.ToUnixTimeMilliseconds() &&
            existing.GrantedCapabilities.SequenceEqual(
                requestedCapabilities,
                StringComparer.Ordinal);
        if (!exact)
        {
            throw new RbpJournalException(
                RbpJournalErrorCode.SessionConflict,
                "The rsid is already registered with different durable " +
                "authority.");
        }
    }

    private static RbpRegistrationSafetyAssessment
        ToRegistrationAssessment(
            string localSessionKey,
            string registrationDigest,
            RbpLegacySafetyPlan plan)
    {
        if (!RbpJournalSerialization.IsSha256Digest(
                plan.SafetyDecisionDigest))
        {
            throw RbpJournalSerialization.Corrupt(
                "The registration safety decision digest is malformed.");
        }

        return new RbpRegistrationSafetyAssessment(
            plan.Outcome == RbpLegacySafetyOutcome.Safe
                ? RbpRegistrationSafetyDisposition.Eligible
                : RbpRegistrationSafetyDisposition.Deferred,
            localSessionKey,
            registrationDigest,
            plan.SafetyDecisionDigest,
            plan.Outcome switch
            {
                RbpLegacySafetyOutcome.Safe => null,
                RbpLegacySafetyOutcome.Unsafe =>
                    "unresolved_predecessor",
                RbpLegacySafetyOutcome.InventoryLimit =>
                    "inventory_limit",
                _ => throw RbpJournalSerialization.Corrupt(
                    "The registration safety outcome is unknown."),
            });
    }

    private static void ValidateIdentifier(
        string value,
        string parameterName,
        int maximumLength)
    {
        if (string.IsNullOrWhiteSpace(value) ||
            value.Length > maximumLength)
        {
            throw new ArgumentException(
                "Identifier must be bounded and non-empty.",
                parameterName);
        }
    }
}
