-- EU-12 reviewer rework: durable retention, complete metering, R17 linkage,
-- and monotonically advancing release channels. This migration is append-only:
-- 003 remains immutable once a database has recorded its digest.

ALTER TABLE events
  ADD COLUMN retention_class text NOT NULL DEFAULT 'standard_12m'
    CHECK (retention_class IN ('standard_12m', 'lifecycle_24m')),
  ADD COLUMN retention_partition_month date,
  ADD COLUMN retention_until timestamptz;

CREATE OR REPLACE FUNCTION revagent_assign_event_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.retention_partition_month := date_trunc('month', NEW.occurred_at AT TIME ZONE 'UTC')::date;
  IF NEW.event_type IN (
    'auth.event', 'bridge.connected', 'bridge.disconnected', 'bridge.enrolled',
    'bridge.revoked', 'bridge.update'
  ) THEN
    NEW.retention_class := 'lifecycle_24m';
    NEW.retention_until := NEW.occurred_at + interval '24 months';
  ELSE
    NEW.retention_class := 'standard_12m';
    NEW.retention_until := NEW.occurred_at + interval '12 months';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER events_assign_retention
BEFORE INSERT OR UPDATE OF event_type, occurred_at ON events
FOR EACH ROW EXECUTE FUNCTION revagent_assign_event_retention();

UPDATE events
SET retention_partition_month = date_trunc('month', occurred_at AT TIME ZONE 'UTC')::date,
    retention_class = CASE WHEN event_type IN (
      'auth.event', 'bridge.connected', 'bridge.disconnected', 'bridge.enrolled',
      'bridge.revoked', 'bridge.update'
    ) THEN 'lifecycle_24m' ELSE 'standard_12m' END,
    retention_until = occurred_at + CASE WHEN event_type IN (
      'auth.event', 'bridge.connected', 'bridge.disconnected', 'bridge.enrolled',
      'bridge.revoked', 'bridge.update'
    ) THEN interval '24 months' ELSE interval '12 months' END
WHERE retention_partition_month IS NULL OR retention_until IS NULL;

ALTER TABLE events
  ALTER COLUMN retention_partition_month SET NOT NULL,
  ALTER COLUMN retention_until SET NOT NULL;

CREATE INDEX events_tenant_retention_partition_idx
  ON events(tenant_id, retention_partition_month, occurred_at);
CREATE INDEX events_tenant_retention_due_idx
  ON events(tenant_id, retention_until, occurred_at);

ALTER TABLE tool_invocations
  ADD COLUMN IF NOT EXISTS turn_id uuid,
  ADD COLUMN IF NOT EXISTS invocation_seq bigint CHECK (invocation_seq IS NULL OR invocation_seq >= 0),
  ADD COLUMN IF NOT EXISTS actor_device_id uuid,
  ADD COLUMN IF NOT EXISTS namespace text CHECK (namespace IS NULL OR namespace IN ('core', 'mech', 'arch', 'struct', 'elec')),
  ADD COLUMN IF NOT EXISTS document_id text,
  ADD COLUMN IF NOT EXISTS model_guid text,
  ADD COLUMN IF NOT EXISTS error_class text CHECK (error_class IS NULL OR error_class IN ('retryable', 'terminal', 'parameter_fault', 'environment_fault')),
  ADD COLUMN IF NOT EXISTS error_message text CHECK (error_message IS NULL OR char_length(error_message) <= 4096),
  ADD COLUMN IF NOT EXISTS queue_ms integer CHECK (queue_ms IS NULL OR queue_ms >= 0),
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS confirmation_id uuid,
  ADD COLUMN IF NOT EXISTS result_ref_id uuid;
CREATE INDEX tool_invocations_tenant_session_sequence_idx
  ON tool_invocations(tenant_id, session_id, invocation_seq);
CREATE INDEX tool_invocations_tenant_tool_started_idx
  ON tool_invocations(tenant_id, tool_name, started_at DESC);

ALTER TABLE llm_calls
  ADD COLUMN IF NOT EXISTS id uuid,
  ADD COLUMN IF NOT EXISTS turn_id uuid,
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS role text,
  ADD COLUMN IF NOT EXISTS engine_mode text,
  ADD COLUMN IF NOT EXISTS cache_creation_input_tokens integer NOT NULL DEFAULT 0 CHECK (cache_creation_input_tokens >= 0),
  ADD COLUMN IF NOT EXISTS latency_ms integer,
  ADD COLUMN IF NOT EXISTS stop_reason text,
  ADD COLUMN IF NOT EXISTS outcome text,
  ADD COLUMN IF NOT EXISTS cost_microusd bigint;

UPDATE llm_calls
SET id = event_id,
    provider = COALESCE(provider, 'external_client'),
    model = COALESCE(model, 'observed'),
    role = COALESCE(role, 'external_client'),
    engine_mode = COALESCE(engine_mode, 'external_client'),
    latency_ms = COALESCE(latency_ms, duration_ms),
    stop_reason = COALESCE(stop_reason, 'unknown'),
    outcome = COALESCE(outcome, 'completed'),
    cost_microusd = COALESCE(cost_microusd, round(cost * 1000000)::bigint)
WHERE id IS NULL OR provider IS NULL OR model IS NULL OR role IS NULL OR engine_mode IS NULL
  OR latency_ms IS NULL OR stop_reason IS NULL OR outcome IS NULL OR cost_microusd IS NULL;

ALTER TABLE llm_calls
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN provider SET NOT NULL,
  ALTER COLUMN model SET NOT NULL,
  ALTER COLUMN role SET NOT NULL,
  ALTER COLUMN engine_mode SET NOT NULL,
  ALTER COLUMN latency_ms SET NOT NULL,
  ALTER COLUMN stop_reason SET NOT NULL,
  ALTER COLUMN outcome SET NOT NULL,
  ALTER COLUMN cost_microusd SET NOT NULL,
  ADD CONSTRAINT llm_calls_id_key UNIQUE (id),
  ADD CONSTRAINT llm_calls_role_check CHECK (role IN ('router', 'planner', 'main', 'subagent', 'summarizer', 'external_client')),
  ADD CONSTRAINT llm_calls_engine_mode_check CHECK (engine_mode IN ('tool_calling', 'code_exec', 'external_client')),
  ADD CONSTRAINT llm_calls_outcome_check CHECK (outcome IN ('completed', 'failed', 'cancelled', 'timeout'));
CREATE INDEX llm_calls_tenant_model_created_idx
  ON llm_calls(tenant_id, model, created_at DESC);

ALTER TABLE result_refs
  ADD COLUMN IF NOT EXISTS invocation_id uuid,
  ADD COLUMN IF NOT EXISTS ref_label text,
  ADD COLUMN IF NOT EXISTS content_type text NOT NULL DEFAULT 'application/json',
  ADD COLUMN IF NOT EXISTS row_count integer CHECK (row_count IS NULL OR row_count >= 0),
  ADD COLUMN IF NOT EXISTS lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'deleting', 'expired'));

WITH ranked_legacy_refs AS (
  SELECT id,
         'R' || (16 + row_number() OVER (
           PARTITION BY tenant_id, session_id
           ORDER BY created_at, id
         ))::text AS deterministic_label
  FROM result_refs
  WHERE ref_label IS NULL
)
UPDATE result_refs AS ref
SET ref_label = ranked_legacy_refs.deterministic_label
FROM ranked_legacy_refs
WHERE ref.id = ranked_legacy_refs.id;
ALTER TABLE result_refs
  ALTER COLUMN ref_label SET NOT NULL,
  ADD CONSTRAINT result_refs_ref_label_check CHECK (ref_label ~ '^R[1-9][0-9]{0,5}$'),
  ADD CONSTRAINT result_refs_session_label_key UNIQUE (tenant_id, session_id, ref_label);
CREATE INDEX result_refs_tenant_expiry_idx ON result_refs(tenant_id, expires_at, id);
CREATE INDEX result_refs_tenant_invocation_idx ON result_refs(tenant_id, invocation_id);

ALTER TABLE retention_runs
  ADD COLUMN IF NOT EXISTS archive_kind text NOT NULL DEFAULT 'events'
    CHECK (archive_kind IN ('events', 'tool_invocations', 'llm_calls')),
  ADD COLUMN IF NOT EXISTS row_digest char(64),
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS dropped_at timestamptz;
ALTER TABLE retention_runs DROP CONSTRAINT retention_runs_pkey;
ALTER TABLE retention_runs
  ADD PRIMARY KEY (tenant_id, archive_month, archive_kind),
  ADD CONSTRAINT retention_runs_row_digest_check CHECK (row_digest IS NULL OR row_digest ~ '^[0-9a-f]{64}$');
CREATE INDEX retention_runs_due_idx ON retention_runs(state, archive_month, updated_at);

ALTER TABLE bridge_releases
  ADD COLUMN IF NOT EXISTS release_sequence bigint,
  ADD COLUMN IF NOT EXISTS manifest_digest char(64),
  ADD COLUMN IF NOT EXISTS rollback_floor_sequence bigint NOT NULL DEFAULT 0 CHECK (rollback_floor_sequence >= 0);
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY released_at, id) AS sequence
  FROM bridge_releases
)
UPDATE bridge_releases AS release
SET release_sequence = ordered.sequence,
    manifest_digest = COALESCE(release.manifest_digest, release.artifact_sha256)
FROM ordered
WHERE release.id = ordered.id
  AND (release.release_sequence IS NULL OR release.manifest_digest IS NULL);
ALTER TABLE bridge_releases
  ALTER COLUMN release_sequence SET NOT NULL,
  ALTER COLUMN manifest_digest SET NOT NULL,
  ADD CONSTRAINT bridge_releases_sequence_key UNIQUE (release_sequence),
  ADD CONSTRAINT bridge_releases_manifest_digest_check CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT bridge_releases_floor_check CHECK (rollback_floor_sequence <= release_sequence);

ALTER TABLE release_channels
  ADD COLUMN IF NOT EXISTS channel_revision integer NOT NULL DEFAULT 1 CHECK (channel_revision > 0),
  ADD COLUMN IF NOT EXISTS rollback_floor_sequence bigint NOT NULL DEFAULT 0 CHECK (rollback_floor_sequence >= 0);

CREATE OR REPLACE FUNCTION revagent_prevent_release_channel_rollback()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_sequence bigint;
  prior_sequence bigint;
BEGIN
  SELECT release_sequence INTO candidate_sequence FROM bridge_releases WHERE id = NEW.current_release_id;
  IF candidate_sequence IS NULL THEN RAISE EXCEPTION 'unknown release channel target'; END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT release_sequence INTO prior_sequence FROM bridge_releases WHERE id = OLD.current_release_id;
    IF candidate_sequence < GREATEST(OLD.rollback_floor_sequence, COALESCE(prior_sequence, 0)) THEN
      RAISE EXCEPTION 'release channel rollback is forbidden';
    END IF;
    NEW.channel_revision := OLD.channel_revision + 1;
    NEW.rollback_floor_sequence := GREATEST(OLD.rollback_floor_sequence, candidate_sequence);
  ELSE
    IF candidate_sequence < NEW.rollback_floor_sequence THEN RAISE EXCEPTION 'release is below rollback floor'; END IF;
    NEW.rollback_floor_sequence := GREATEST(NEW.rollback_floor_sequence, candidate_sequence);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER release_channels_prevent_rollback
BEFORE INSERT OR UPDATE OF current_release_id ON release_channels
FOR EACH ROW EXECUTE FUNCTION revagent_prevent_release_channel_rollback();

CREATE INDEX release_channel_targets_tenant_idx ON release_channel_targets(tenant_id, channel);

-- The retention runner deletes only rows already represented by a durable
-- archive run. RLS still restricts it to the transaction's tenant GUC.
GRANT DELETE ON events, result_refs TO revagent_app;
