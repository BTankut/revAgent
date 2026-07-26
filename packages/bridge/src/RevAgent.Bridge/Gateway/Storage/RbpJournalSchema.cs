using System.Security.Cryptography;
using System.Text;

namespace RevAgent.Bridge.Gateway.Storage;

internal static class RbpJournalSchema
{
    internal const int CurrentVersion = 1;
    internal const string StoreFormat = "revagent-rbp-journal";

    private const string TransportLifecycleSchema = """
        CREATE TABLE rbp_sessions(
          rsid TEXT PRIMARY KEY,
          local_session_key TEXT NOT NULL,
          registration_json TEXT NOT NULL,
          registration_digest TEXT NOT NULL,
          resume_token_protected BLOB NOT NULL,
          resume_token_protection TEXT NOT NULL,
          resume_expires_at_ms INTEGER NOT NULL CHECK(resume_expires_at_ms >= 0),
          granted_capabilities_json TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
          updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
          CHECK(length(rsid) BETWEEN 1 AND 256),
          CHECK(length(local_session_key) BETWEEN 1 AND 512),
          CHECK(length(registration_digest) = 71),
          CHECK(length(resume_token_protected) > 0),
          CHECK(length(resume_token_protection) BETWEEN 1 AND 128)
        ) STRICT;

        CREATE INDEX ix_rbp_sessions_local_session_key
          ON rbp_sessions(local_session_key,rsid);

        CREATE TABLE rbp_session_sequence(
          rsid TEXT PRIMARY KEY REFERENCES rbp_sessions(rsid) ON DELETE RESTRICT,
          next_tx_seq INTEGER,
          highest_tx_seq INTEGER NOT NULL,
          last_rx_seq INTEGER NOT NULL,
          last_journaled_rx_seq INTEGER NOT NULL,
          last_peer_ack INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
          CHECK(next_tx_seq IS NULL OR
                (next_tx_seq >= 1 AND next_tx_seq <= 9007199254740991)),
          CHECK(highest_tx_seq >= 0 AND highest_tx_seq <= 9007199254740991),
          CHECK(last_rx_seq >= 0 AND last_rx_seq <= 9007199254740991),
          CHECK(last_journaled_rx_seq >= 0 AND
                last_journaled_rx_seq <= last_rx_seq),
          CHECK(last_peer_ack >= 0 AND last_peer_ack <= highest_tx_seq),
          CHECK((next_tx_seq IS NULL AND highest_tx_seq = 9007199254740991) OR
                (next_tx_seq IS NOT NULL AND next_tx_seq = highest_tx_seq + 1))
        ) STRICT;

        CREATE TABLE rbp_outbox(
          rsid TEXT NOT NULL REFERENCES rbp_sessions(rsid) ON DELETE RESTRICT,
          seq INTEGER NOT NULL CHECK(seq >= 1 AND seq <= 9007199254740991),
          envelope_id TEXT NOT NULL,
          message_type TEXT NOT NULL,
          immutable_digest TEXT NOT NULL,
          envelope_json TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
          PRIMARY KEY(rsid,seq),
          UNIQUE(rsid,envelope_id),
          CHECK(length(envelope_id) BETWEEN 1 AND 128),
          CHECK(length(message_type) BETWEEN 1 AND 128),
          CHECK(length(immutable_digest) = 71),
          CHECK(length(envelope_json) > 0)
        ) STRICT;

        CREATE TABLE rbp_inbound_receipts(
          rsid TEXT NOT NULL REFERENCES rbp_sessions(rsid) ON DELETE RESTRICT,
          seq INTEGER NOT NULL CHECK(seq >= 1 AND seq <= 9007199254740991),
          envelope_id TEXT NOT NULL,
          message_type TEXT NOT NULL,
          immutable_digest TEXT NOT NULL,
          envelope_json TEXT NOT NULL,
          handoff_state TEXT NOT NULL CHECK(handoff_state IN ('pending','journaled')),
          correlation_id TEXT,
          context_json TEXT,
          accepted_at_ms INTEGER NOT NULL CHECK(accepted_at_ms >= 0),
          journaled_at_ms INTEGER,
          PRIMARY KEY(rsid,seq),
          UNIQUE(rsid,envelope_id),
          CHECK(length(envelope_id) BETWEEN 1 AND 128),
          CHECK(length(message_type) BETWEEN 1 AND 128),
          CHECK(length(immutable_digest) = 71),
          CHECK(length(envelope_json) > 0),
          CHECK((handoff_state='pending' AND correlation_id IS NULL AND
                 context_json IS NULL AND journaled_at_ms IS NULL) OR
                (handoff_state='journaled' AND correlation_id IS NOT NULL AND
                 context_json IS NOT NULL AND journaled_at_ms IS NOT NULL))
        ) STRICT;

        CREATE INDEX ix_rbp_inbound_pending
          ON rbp_inbound_receipts(rsid,seq)
          WHERE handoff_state='pending';

        CREATE TABLE rbp_unregister_tombstones(
          rsid TEXT PRIMARY KEY REFERENCES rbp_sessions(rsid) ON DELETE CASCADE,
          reason TEXT NOT NULL CHECK(reason IN (
            'revit_exited','bridge_shutdown','session_replaced','operator_requested'
          )),
          phase TEXT NOT NULL CHECK(phase IN ('pending','confirmed')),
          created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
          updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
        ) STRICT;
        """;

    internal static RbpJournalMigration BaseMigration { get; } = new(
        CurrentVersion,
        "P3-T4",
        "rbp_transport_state_v1",
        TransportLifecycleSchema);

    internal static IReadOnlyList<RbpJournalMigration> BuildMigrationChain(
        IReadOnlyList<RbpJournalMigration>? additional)
    {
        var migrations = new List<RbpJournalMigration> { BaseMigration };
        if (additional is not null)
        {
            migrations.AddRange(additional);
        }

        migrations.Sort((left, right) => left.Version.CompareTo(right.Version));
        for (int index = 0; index < migrations.Count; index++)
        {
            RbpJournalMigration migration = migrations[index];
            int expected = index + 1;
            if (migration.Version != expected ||
                string.IsNullOrWhiteSpace(migration.Owner) ||
                string.IsNullOrWhiteSpace(migration.Name) ||
                string.IsNullOrWhiteSpace(migration.Sql))
            {
                throw new RbpJournalException(
                    RbpJournalErrorCode.MigrationMismatch,
                    "RBP journal migrations must be contiguous, named, " +
                    "owned, and non-empty.");
            }
        }

        return migrations.AsReadOnly();
    }

    internal static string Digest(RbpJournalMigration migration)
    {
        string normalized = migration.Sql
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);
        byte[] bytes = Encoding.UTF8.GetBytes(normalized);
        return "sha256:" +
               Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }
}
