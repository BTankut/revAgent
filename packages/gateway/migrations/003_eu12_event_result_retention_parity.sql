DO $$ BEGIN
  CREATE TYPE bridge_release_channel AS ENUM ('stable', 'pilot');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_type text NOT NULL CHECK (event_type IN (
    'session.started','session.ended','turn.completed','llm.call','tool.invocation',
    'tool.confirmation','bridge.connected','bridge.disconnected','bridge.enrolled',
    'bridge.revoked','bridge.update','auth.event','registry.published'
  )),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  source jsonb NOT NULL,
  actor jsonb NOT NULL,
  session_id uuid,
  turn_id uuid,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  payload jsonb NOT NULL,
  envelope_digest char(64) NOT NULL CHECK (envelope_digest ~ '^[0-9a-f]{64}$'),
  idempotency_digest char(64) NOT NULL CHECK (idempotency_digest ~ '^[0-9a-f]{64}$'),
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE llm_calls (
  event_id uuid PRIMARY KEY REFERENCES events(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL,
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens integer NOT NULL CHECK (cache_read_tokens >= 0),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  cost numeric(14,6) NOT NULL CHECK (cost >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id)
);

ALTER TABLE tool_invocations
  ADD COLUMN IF NOT EXISTS params_summary jsonb,
  ADD COLUMN IF NOT EXISTS code_summary jsonb,
  ADD COLUMN IF NOT EXISTS request_bytes integer CHECK (request_bytes IS NULL OR request_bytes >= 0),
  ADD COLUMN IF NOT EXISTS response_bytes integer CHECK (response_bytes IS NULL OR response_bytes >= 0),
  ADD COLUMN IF NOT EXISTS bridge_ms integer CHECK (bridge_ms IS NULL OR bridge_ms >= 0),
  ADD COLUMN IF NOT EXISTS audit_exempt boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS event_id uuid UNIQUE;

CREATE TABLE result_refs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL,
  storage_key text NOT NULL UNIQUE,
  content_digest char(64) NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size >= 0 AND byte_size <= 5242880),
  page_size_bytes integer NOT NULL CHECK (page_size_bytes > 0 AND page_size_bytes <= 5242880),
  page_count integer NOT NULL CHECK (page_count > 0),
  summary jsonb NOT NULL,
  idempotency_key text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, session_id, idempotency_key),
  FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id)
);

CREATE TABLE retention_runs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  archive_month date NOT NULL CHECK (archive_month = date_trunc('month', archive_month)::date),
  state text NOT NULL CHECK (state IN ('prepared','uploaded','dropped')),
  archive_key text NOT NULL,
  archive_digest char(64) NOT NULL CHECK (archive_digest ~ '^[0-9a-f]{64}$'),
  event_count integer NOT NULL CHECK (event_count >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, archive_month)
);

CREATE TABLE bridge_releases (
  id uuid PRIMARY KEY,
  version text NOT NULL UNIQUE,
  channel bridge_release_channel NOT NULL,
  artifact_storage_key text NOT NULL UNIQUE,
  artifact_sha256 char(64) NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  signature text NOT NULL,
  signing_key_id text NOT NULL,
  min_supported_version text NOT NULL,
  released_at timestamptz NOT NULL,
  released_by text NOT NULL
);

CREATE TABLE release_channels (
  channel bridge_release_channel PRIMARY KEY,
  current_release_id uuid NOT NULL REFERENCES bridge_releases(id),
  staged_rollout jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE release_channel_targets (
  channel bridge_release_channel NOT NULL REFERENCES release_channels(channel) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  rollout_revision integer NOT NULL CHECK (rollout_revision > 0),
  PRIMARY KEY (channel, tenant_id)
);

GRANT SELECT, INSERT ON events, llm_calls TO revagent_app;
GRANT SELECT, INSERT, UPDATE ON tool_invocations, result_refs, retention_runs TO revagent_app;
GRANT SELECT ON bridge_releases, release_channels TO revagent_app;
GRANT SELECT ON release_channel_targets TO revagent_app;

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
ALTER TABLE llm_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_calls FORCE ROW LEVEL SECURITY;
ALTER TABLE result_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE result_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE retention_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE release_channel_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_channel_targets FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_scope ON events USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON llm_calls USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON result_refs USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON retention_runs USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON release_channel_targets USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
