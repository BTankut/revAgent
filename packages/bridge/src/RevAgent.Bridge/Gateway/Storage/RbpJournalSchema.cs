using System.Security.Cryptography;
using System.Text;

namespace RevAgent.Bridge.Gateway.Storage;

internal static class RbpJournalSchema
{
    internal const int CurrentVersion = 2;
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
          CHECK(length(registration_digest) = 71 AND
                substr(registration_digest,1,7)='sha256:' AND
                substr(registration_digest,8) NOT GLOB '*[^0-9a-f]*'),
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
          CHECK(length(immutable_digest) = 71 AND
                substr(immutable_digest,1,7)='sha256:' AND
                substr(immutable_digest,8) NOT GLOB '*[^0-9a-f]*'),
          CHECK(length(envelope_json) > 0)
        ) STRICT;

        CREATE TABLE rbp_inbound_receipts(
          rsid TEXT NOT NULL REFERENCES rbp_sessions(rsid) ON DELETE RESTRICT,
          seq INTEGER NOT NULL CHECK(seq >= 1 AND seq <= 9007199254740991),
          envelope_id TEXT NOT NULL,
          message_type TEXT NOT NULL,
          immutable_digest TEXT NOT NULL,
          envelope_json TEXT,
          handoff_state TEXT NOT NULL CHECK(handoff_state IN ('pending','journaled')),
          correlation_id TEXT,
          journal_record_digest TEXT,
          accepted_at_ms INTEGER NOT NULL CHECK(accepted_at_ms >= 0),
          journaled_at_ms INTEGER,
          PRIMARY KEY(rsid,seq),
          UNIQUE(rsid,envelope_id),
          CHECK(length(envelope_id) BETWEEN 1 AND 128),
          CHECK(length(message_type) BETWEEN 1 AND 128),
          CHECK(length(immutable_digest) = 71 AND
                substr(immutable_digest,1,7)='sha256:' AND
                substr(immutable_digest,8) NOT GLOB '*[^0-9a-f]*'),
          CHECK((handoff_state='pending' AND
                 envelope_json IS NOT NULL AND
                 length(envelope_json) > 0 AND
                 correlation_id IS NULL AND
                 journal_record_digest IS NULL AND
                 journaled_at_ms IS NULL) OR
                (handoff_state='journaled' AND
                 correlation_id IS NOT NULL AND
                 length(correlation_id) BETWEEN 1 AND 256 AND
                 journal_record_digest IS NOT NULL AND
                 length(journal_record_digest) = 71 AND
                 substr(journal_record_digest,1,7)='sha256:' AND
                 substr(journal_record_digest,8)
                   NOT GLOB '*[^0-9a-f]*' AND
                 journaled_at_ms IS NOT NULL AND
                 envelope_json IS NULL))
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

    private const string InvocationJournalSchema = """
        CREATE TABLE rbp_verification_holds(
          verification_hold_id TEXT PRIMARY KEY,
          rsid TEXT NOT NULL REFERENCES rbp_sessions(rsid) ON DELETE RESTRICT,
          scope_kind TEXT NOT NULL CHECK(scope_kind IN ('session','document')),
          document_id TEXT,
          scope_jcs TEXT NOT NULL,
          ordered_origin_idempotency_keys_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN (
            'active','evidence_recorded','resolved_pending_bridge','cleared'
          )),
          verification_invocation_id TEXT,
          evidence_digest TEXT,
          resolution_id TEXT,
          resolution_basis TEXT CHECK(
            resolution_basis IS NULL OR
            resolution_basis IN ('verification_read','late_terminal')
          ),
          resolution_decision TEXT CHECK(
            resolution_decision IS NULL OR
            resolution_decision IN (
              'non_execution_proven','postcondition_verified'
            )
          ),
          audit_id TEXT,
          created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
          updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
          cleared_at_ms INTEGER,
          CHECK(
            length(verification_hold_id)=67 AND
            substr(verification_hold_id,1,3)='vh:' AND
            substr(verification_hold_id,4) NOT GLOB '*[^0-9a-f]*'
          ),
          CHECK(length(scope_jcs)>0),
          CHECK(length(ordered_origin_idempotency_keys_json)>0),
          CHECK(
            (scope_kind='session' AND document_id IS NULL) OR
            (scope_kind='document' AND
             document_id IS NOT NULL AND
             length(document_id) BETWEEN 1 AND 4096)
          ),
          CHECK(
            (evidence_digest IS NULL) OR
            (length(evidence_digest)=71 AND
             substr(evidence_digest,1,7)='sha256:' AND
             substr(evidence_digest,8) NOT GLOB '*[^0-9a-f]*')
          ),
          CHECK(
            (state='active' AND
             resolution_id IS NULL AND
             resolution_basis IS NULL AND
             resolution_decision IS NULL AND
             audit_id IS NULL AND
             cleared_at_ms IS NULL) OR
            (state='evidence_recorded' AND
             evidence_digest IS NOT NULL AND
             resolution_id IS NULL AND
             resolution_basis IS NULL AND
             resolution_decision IS NULL AND
             audit_id IS NULL AND
             cleared_at_ms IS NULL) OR
            (state='resolved_pending_bridge' AND
             evidence_digest IS NOT NULL AND
             resolution_id IS NOT NULL AND
             resolution_basis IS NOT NULL AND
             resolution_decision IS NOT NULL AND
             audit_id IS NOT NULL AND
             cleared_at_ms IS NULL) OR
            (state='cleared' AND
             evidence_digest IS NOT NULL AND
             resolution_id IS NOT NULL AND
             resolution_basis IS NOT NULL AND
             resolution_decision IS NOT NULL AND
             audit_id IS NOT NULL AND
             cleared_at_ms IS NOT NULL AND
             cleared_at_ms >= created_at_ms)
          )
        ) STRICT;

        CREATE UNIQUE INDEX ux_rbp_verification_holds_uncleared_scope
          ON rbp_verification_holds(rsid,scope_jcs)
          WHERE state<>'cleared';

        CREATE INDEX ix_rbp_verification_holds_conflict
          ON rbp_verification_holds(rsid,state,scope_kind,document_id);

        CREATE TABLE rbp_invocations(
          idempotency_key TEXT PRIMARY KEY,
          rsid TEXT NOT NULL REFERENCES rbp_sessions(rsid) ON DELETE RESTRICT,
          invocation_id TEXT NOT NULL,
          batch_id TEXT,
          batch_index INTEGER,
          method TEXT NOT NULL,
          mutating INTEGER NOT NULL CHECK(mutating IN (0,1)),
          mutation_scope_jcs TEXT,
          params_digest TEXT NOT NULL,
          policy_jcs TEXT NOT NULL,
          recovery_clearances_jcs TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN (
            'received','executing','completed','failed',
            'guarded','cancelled','indeterminate'
          )),
          terminal_outcome_json TEXT,
          result_digest TEXT,
          verification_hold_id TEXT
            REFERENCES rbp_verification_holds(verification_hold_id)
            ON DELETE RESTRICT,
          verification_correlation_json TEXT,
          late_terminal_outcome_json TEXT,
          late_result_digest TEXT,
          created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
          started_at_ms INTEGER,
          finished_at_ms INTEGER,
          UNIQUE(rsid,invocation_id),
          CHECK(length(idempotency_key) BETWEEN 38 AND 293),
          CHECK(idempotency_key=rsid || '/' || invocation_id),
          CHECK(length(invocation_id)=36),
          CHECK(
            (batch_id IS NULL AND batch_index IS NULL) OR
            (batch_id IS NOT NULL AND
             length(batch_id)=36 AND
             batch_index IS NOT NULL AND
             batch_index >= 0 AND
             batch_index <= 9007199254740991)
          ),
          CHECK(length(method) BETWEEN 1 AND 4096),
          CHECK(
            (mutating=0 AND mutation_scope_jcs IS NULL) OR
            (mutating=1 AND
             mutation_scope_jcs IS NOT NULL AND
             length(mutation_scope_jcs)>0)
          ),
          CHECK(
            length(params_digest)=71 AND
            substr(params_digest,1,7)='sha256:' AND
            substr(params_digest,8) NOT GLOB '*[^0-9a-f]*'
          ),
          CHECK(length(policy_jcs)>0),
          CHECK(length(recovery_clearances_jcs)>0),
          CHECK(
            (state='received' AND
             started_at_ms IS NULL AND
             finished_at_ms IS NULL AND
             terminal_outcome_json IS NULL AND
             result_digest IS NULL) OR
            (state='executing' AND
             started_at_ms IS NOT NULL AND
             started_at_ms >= created_at_ms AND
             finished_at_ms IS NULL AND
             terminal_outcome_json IS NULL AND
             result_digest IS NULL) OR
            (state IN (
               'completed','failed','guarded','cancelled','indeterminate'
             ) AND
             finished_at_ms IS NOT NULL AND
             finished_at_ms >= created_at_ms AND
             (started_at_ms IS NULL OR
              finished_at_ms >= started_at_ms) AND
             terminal_outcome_json IS NOT NULL AND
             result_digest IS NOT NULL AND
             length(terminal_outcome_json)>0 AND
             length(result_digest)=71 AND
             substr(result_digest,1,7)='sha256:' AND
             substr(result_digest,8) NOT GLOB '*[^0-9a-f]*')
          ),
          CHECK(
            (late_terminal_outcome_json IS NULL AND
             late_result_digest IS NULL) OR
            (state='indeterminate' AND
             late_terminal_outcome_json IS NOT NULL AND
             length(late_terminal_outcome_json)>0 AND
             late_result_digest IS NOT NULL AND
             length(late_result_digest)=71 AND
             substr(late_result_digest,1,7)='sha256:' AND
             substr(late_result_digest,8) NOT GLOB '*[^0-9a-f]*')
          ),
          CHECK(
            state<>'indeterminate' OR
            (mutating=1 AND verification_hold_id IS NOT NULL)
          )
        ) STRICT;

        CREATE INDEX ix_rbp_invocations_session_state
          ON rbp_invocations(rsid,state,created_at_ms);

        CREATE INDEX ix_rbp_invocations_batch
          ON rbp_invocations(rsid,batch_id,batch_index)
          WHERE batch_id IS NOT NULL;

        CREATE TABLE rbp_batches(
          batch_key TEXT PRIMARY KEY,
          rsid TEXT NOT NULL REFERENCES rbp_sessions(rsid) ON DELETE RESTRICT,
          batch_id TEXT NOT NULL,
          batch_digest TEXT NOT NULL,
          atomic INTEGER NOT NULL CHECK(atomic IN (0,1)),
          timeout_ms INTEGER NOT NULL
            CHECK(timeout_ms >= 1 AND timeout_ms <= 9007199254740991),
          recovery_clearances_jcs TEXT NOT NULL,
          steps_jcs TEXT NOT NULL,
          step_count INTEGER NOT NULL CHECK(step_count >= 1),
          state TEXT NOT NULL CHECK(state IN (
            'received','dispatched','terminal'
          )),
          terminal_outcome_json TEXT,
          result_digest TEXT,
          created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
          dispatched_at_ms INTEGER,
          finished_at_ms INTEGER,
          UNIQUE(rsid,batch_id),
          CHECK(length(batch_key) BETWEEN 38 AND 293),
          CHECK(batch_key=rsid || '/' || batch_id),
          CHECK(length(batch_id)=36),
          CHECK(
            length(batch_digest)=71 AND
            substr(batch_digest,1,7)='sha256:' AND
            substr(batch_digest,8) NOT GLOB '*[^0-9a-f]*'
          ),
          CHECK(length(recovery_clearances_jcs)>0),
          CHECK(length(steps_jcs)>0),
          CHECK(
            (state='received' AND
             dispatched_at_ms IS NULL AND
             finished_at_ms IS NULL AND
             terminal_outcome_json IS NULL AND
             result_digest IS NULL) OR
            (state='dispatched' AND
             dispatched_at_ms IS NOT NULL AND
             dispatched_at_ms >= created_at_ms AND
             finished_at_ms IS NULL AND
             terminal_outcome_json IS NULL AND
             result_digest IS NULL) OR
            (state='terminal' AND
             finished_at_ms IS NOT NULL AND
             finished_at_ms >= created_at_ms AND
             (dispatched_at_ms IS NULL OR
              finished_at_ms >= dispatched_at_ms) AND
             terminal_outcome_json IS NOT NULL AND
             length(terminal_outcome_json)>0 AND
             result_digest IS NOT NULL AND
             length(result_digest)=71 AND
             substr(result_digest,1,7)='sha256:' AND
             substr(result_digest,8) NOT GLOB '*[^0-9a-f]*')
          )
        ) STRICT;

        CREATE INDEX ix_rbp_batches_session_state
          ON rbp_batches(rsid,state,created_at_ms);
        """;

    internal static RbpJournalMigration BaseMigration { get; } = new(
        1,
        "P3-T4",
        "rbp_transport_state_v1",
        TransportLifecycleSchema);

    internal static RbpJournalMigration InvocationJournalMigration { get; } =
        new(
            CurrentVersion,
            "P3-T5",
            "rbp_invocation_journal_v1",
            InvocationJournalSchema);

    internal static IReadOnlyList<RbpJournalMigration> BuildMigrationChain(
        IReadOnlyList<RbpJournalMigration>? additional)
    {
        var migrations = new List<RbpJournalMigration>
        {
            BaseMigration,
            InvocationJournalMigration,
        };
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
