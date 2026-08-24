using System.Security.Cryptography;
using System.Text;

namespace RevAgent.Bridge.Gateway.Storage;

internal static class RbpJournalSchema
{
    internal const int CurrentVersion = 8;
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
            2,
            "P3-T5",
            "rbp_invocation_journal_v1",
            InvocationJournalSchema);

    private const string CarrierPlanSchema = """
        CREATE TABLE rbp_carrier_plans(
          plan_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE
            REFERENCES rbp_invocations(idempotency_key) ON DELETE RESTRICT,
          carrier_key TEXT NOT NULL,
          prefixes_jcs TEXT NOT NULL,
          prefix_digest TEXT NOT NULL,
          terminal_jcs TEXT NOT NULL,
          terminal_digest TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
          CHECK(length(plan_id)=71 AND substr(plan_id,1,7)='sha256:' AND
            substr(plan_id,8) NOT GLOB '*[^0-9a-f]*'),
          CHECK(length(carrier_key)=64 AND carrier_key NOT GLOB '*[^0-9a-f]*'),
          CHECK(length(prefixes_jcs)>0),
          CHECK(length(terminal_jcs)>0),
          CHECK(length(prefix_digest)=71 AND substr(prefix_digest,1,7)='sha256:' AND
            substr(prefix_digest,8) NOT GLOB '*[^0-9a-f]*'),
          CHECK(length(terminal_digest)=71 AND substr(terminal_digest,1,7)='sha256:' AND
            substr(terminal_digest,8) NOT GLOB '*[^0-9a-f]*')
        ) STRICT;

        ALTER TABLE rbp_invocations
          ADD COLUMN carrier_plan_id TEXT
            REFERENCES rbp_carrier_plans(plan_id) ON DELETE RESTRICT;

        CREATE UNIQUE INDEX ux_rbp_invocations_carrier_plan
          ON rbp_invocations(carrier_plan_id)
          WHERE carrier_plan_id IS NOT NULL;
        """;

    internal static RbpJournalMigration CarrierPlanMigration { get; } = new(
        3,
        "WP-12",
        "rbp_carrier_plan_v1",
        CarrierPlanSchema);

    private const string CarrierPlanFenceSchema = """
        ALTER TABLE rbp_carrier_plans
          ADD COLUMN terminal_rsid TEXT;
        ALTER TABLE rbp_carrier_plans
          ADD COLUMN terminal_sequence INTEGER;
        CREATE UNIQUE INDEX ux_rbp_carrier_plans_terminal_fence
          ON rbp_carrier_plans(terminal_rsid,terminal_sequence)
          WHERE terminal_rsid IS NOT NULL;
        """;

    internal static RbpJournalMigration CarrierPlanFenceMigration { get; } = new(
        4,
        "WP-12",
        "rbp_carrier_plan_terminal_fence_v1",
        CarrierPlanFenceSchema);

    private const string CarrierPlanAcknowledgementSchema = """
        ALTER TABLE rbp_carrier_plans
          ADD COLUMN acknowledged_at_ms INTEGER;
        CREATE INDEX ix_rbp_carrier_plans_releasable
          ON rbp_carrier_plans(terminal_rsid,terminal_sequence,acknowledged_at_ms);
        """;

    internal static RbpJournalMigration CarrierPlanAcknowledgementMigration { get; } = new(
        5,
        "WP-12",
        "rbp_carrier_plan_acknowledgement_v1",
        CarrierPlanAcknowledgementSchema);

    private const string CarrierPlanSpoolReleaseSchema = """
        ALTER TABLE rbp_carrier_plans
          ADD COLUMN spool_release_state TEXT NOT NULL DEFAULT 'none';
        ALTER TABLE rbp_carrier_plans
          ADD COLUMN spool_release_token TEXT;
        ALTER TABLE rbp_carrier_plans
          ADD COLUMN spool_released_at_ms INTEGER;
        UPDATE rbp_carrier_plans
        SET spool_release_state='pending',
            spool_release_token='v1:' || plan_id || ':' || carrier_key || ':' ||
              terminal_rsid || ':' || terminal_sequence || ':' || acknowledged_at_ms
        WHERE acknowledged_at_ms IS NOT NULL
          AND terminal_rsid IS NOT NULL
          AND terminal_sequence IS NOT NULL
          AND spool_release_state='none';
        CREATE INDEX ix_rbp_carrier_plans_spool_release
          ON rbp_carrier_plans(spool_release_state,terminal_rsid,terminal_sequence);
        """;

    internal static RbpJournalMigration CarrierPlanSpoolReleaseMigration { get; } = new(
        6,
        "WP-12",
        "rbp_carrier_plan_spool_release_v1",
        CarrierPlanSpoolReleaseSchema);

    // C39 deliberately keeps the frozen RBP wire schema unchanged. This is a
    // local, protected companion relation only: its FK makes a raw response
    // inseparable from the exact terminal invocation that produced it.
    private const string RecoveryPayloadSchema = """
        CREATE TABLE rbp_recovery_payloads(
          idempotency_key TEXT PRIMARY KEY
            REFERENCES rbp_invocations(idempotency_key) ON DELETE RESTRICT,
          rsid TEXT NOT NULL REFERENCES rbp_sessions(rsid) ON DELETE RESTRICT,
          invocation_id TEXT NOT NULL,
          result_digest TEXT NOT NULL,
          protection_scheme TEXT NOT NULL,
          protected_envelope BLOB NOT NULL,
          plaintext_length INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
          retention_expires_at_ms INTEGER NOT NULL CHECK(retention_expires_at_ms >= created_at_ms),
          CHECK(length(invocation_id) BETWEEN 1 AND 128),
          CHECK(length(result_digest)=71 AND substr(result_digest,1,7)='sha256:' AND
                substr(result_digest,8) NOT GLOB '*[^0-9a-f]*'),
          CHECK(length(protection_scheme) BETWEEN 1 AND 128),
          CHECK(length(protected_envelope)>0),
          CHECK(plaintext_length BETWEEN 1 AND 33554432)
        ) STRICT;
        CREATE UNIQUE INDEX ux_rbp_recovery_payload_origin_digest
          ON rbp_recovery_payloads(rsid,invocation_id,result_digest);
        CREATE INDEX ix_rbp_recovery_payload_rsid_bytes
          ON rbp_recovery_payloads(rsid,plaintext_length);
        """;

    internal static RbpJournalMigration RecoveryPayloadMigration { get; } = new(
        7,
        "WP-12",
        "rbp_correlated_recovery_payload_v7",
        RecoveryPayloadSchema);

    // C39-v8 is deliberately metadata-only.  It reserves the one current
    // sequence for a correlated recovery carrier without persisting any
    // frame, base64, plaintext, or envelope body in the transport outbox.
    private const string RecoveryCarrierReservationSchema = """
        CREATE TABLE rbp_recovery_carrier_reservations(
          recovery_invocation_id TEXT PRIMARY KEY,
          rsid TEXT NOT NULL REFERENCES rbp_sessions(rsid) ON DELETE RESTRICT,
          origin_invocation_id TEXT NOT NULL,
          result_digest TEXT NOT NULL,
          raw_idempotency_key TEXT NOT NULL,
          raw_payload_version INTEGER NOT NULL CHECK(raw_payload_version=7),
          header_jcs TEXT NOT NULL CHECK(length(header_jcs) BETWEEN 1 AND 4096),
          plaintext_length INTEGER NOT NULL CHECK(plaintext_length BETWEEN 1 AND 33554432),
          chunk_size INTEGER NOT NULL CHECK(chunk_size BETWEEN 1 AND 33554432),
          chunk_count INTEGER NOT NULL CHECK(chunk_count BETWEEN 1 AND 33554432),
          phase TEXT NOT NULL CHECK(phase IN ('reserved','send_started','awaiting_ack','completed','tombstoned')),
          chunk_index INTEGER NOT NULL CHECK(chunk_index>=0),
          current_reserved_seq INTEGER NOT NULL CHECK(current_reserved_seq BETWEEN 1 AND 9007199254740991),
          canonical_envelope_digest TEXT NOT NULL,
          send_started_at_ms INTEGER,
          highest_reserved_seq INTEGER NOT NULL CHECK(highest_reserved_seq>=current_reserved_seq),
          acknowledgement_cursor INTEGER NOT NULL CHECK(acknowledgement_cursor>=0),
          plan_version INTEGER NOT NULL CHECK(plan_version=1),
          created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
          expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=created_at_ms),
          updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms),
          completed_at_ms INTEGER,
          tombstoned_at_ms INTEGER,
          tombstone_reason TEXT,
          UNIQUE(rsid,origin_invocation_id,result_digest),
          CHECK(length(recovery_invocation_id)=36),
          CHECK(length(origin_invocation_id)=36),
          CHECK(length(result_digest)=71 AND substr(result_digest,1,7)='sha256:' AND substr(result_digest,8) NOT GLOB '*[^0-9a-f]*'),
          CHECK(length(canonical_envelope_digest)=71 AND substr(canonical_envelope_digest,1,7)='sha256:' AND substr(canonical_envelope_digest,8) NOT GLOB '*[^0-9a-f]*'),
          CHECK((phase='send_started' AND send_started_at_ms IS NOT NULL) OR
                (phase<>'send_started')),
          CHECK((phase='tombstoned' AND tombstone_reason IS NOT NULL) OR
                (phase<>'tombstoned' AND tombstone_reason IS NULL)),
          CHECK((phase='completed' AND completed_at_ms IS NOT NULL AND tombstoned_at_ms IS NULL) OR
                (phase='tombstoned' AND tombstoned_at_ms IS NOT NULL AND completed_at_ms IS NULL) OR
                (phase NOT IN ('completed','tombstoned') AND completed_at_ms IS NULL AND tombstoned_at_ms IS NULL))
        ) STRICT;
        CREATE UNIQUE INDEX ux_rbp_recovery_carrier_one_fence
          ON rbp_recovery_carrier_reservations(rsid)
          WHERE phase IN ('reserved','send_started','awaiting_ack','tombstoned');
        CREATE INDEX ix_rbp_recovery_carrier_recovery
          ON rbp_recovery_carrier_reservations(recovery_invocation_id,phase);
        CREATE TABLE rbp_recovery_sequence_tombstones(
          rsid TEXT PRIMARY KEY REFERENCES rbp_sessions(rsid) ON DELETE RESTRICT,
          format_version INTEGER NOT NULL CHECK(format_version=1),
          tombstoned_at_ms INTEGER NOT NULL CHECK(tombstoned_at_ms>=0),
          reason_code TEXT NOT NULL CHECK(reason_code IN ('recovery_fence_fault','session_closed')),
          sequence_high_water INTEGER NOT NULL CHECK(sequence_high_water>=1 AND sequence_high_water<=9007199254740991)
        ) STRICT;
        """;

    internal static RbpJournalMigration RecoveryCarrierReservationMigration { get; } = new(
        CurrentVersion,
        "WP-12",
        "rbp_correlated_recovery_carrier_reservation_v8",
        RecoveryCarrierReservationSchema);

    internal static IReadOnlyList<RbpJournalMigration> BuildMigrationChain(
        IReadOnlyList<RbpJournalMigration>? additional)
    {
        var migrations = new List<RbpJournalMigration>
        {
            BaseMigration,
            InvocationJournalMigration,
            CarrierPlanMigration,
            CarrierPlanFenceMigration,
            CarrierPlanAcknowledgementMigration,
            CarrierPlanSpoolReleaseMigration,
            RecoveryPayloadMigration,
            RecoveryCarrierReservationMigration,
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
