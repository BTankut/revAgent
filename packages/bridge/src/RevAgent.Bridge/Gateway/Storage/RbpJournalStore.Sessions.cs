using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace RevAgent.Bridge.Gateway.Storage;

internal sealed partial class RbpJournalStore
{
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
