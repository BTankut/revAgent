-- EU-12 canonical-retention repair.  Migration 007's JSONB hot plane is
-- retired here: events, tool_invocations, and llm_calls themselves become
-- tenant/month physical partitions.  Identity registries retain only global
-- uniqueness/replay keys; they never duplicate canonical event payloads.

DROP TRIGGER IF EXISTS events_capture_hot_retention ON events;
DROP TRIGGER IF EXISTS tool_invocations_capture_hot_retention ON tool_invocations;
DROP TRIGGER IF EXISTS llm_calls_capture_hot_retention ON llm_calls;
DROP TRIGGER IF EXISTS events_assign_retention ON events;
DROP TRIGGER IF EXISTS tool_invocations_assign_retention ON tool_invocations;
DROP TRIGGER IF EXISTS llm_calls_assign_retention ON llm_calls;

ALTER TABLE events RENAME TO events_legacy_008;
ALTER TABLE tool_invocations RENAME TO tool_invocations_legacy_008;
ALTER TABLE llm_calls RENAME TO llm_calls_legacy_008;

-- 007's tables contain a derived JSONB copy only.  Retention state and every
-- verified archive object remain durably represented by retention_runs.
DROP TABLE retention_hot_rows CASCADE;
DROP TABLE retention_hot_partition_ownership;
DROP TABLE retention_archive_rows CASCADE;
DROP TABLE retention_partition_ownership;

DROP FUNCTION IF EXISTS revagent_capture_event_hot_retention_row();
DROP FUNCTION IF EXISTS revagent_capture_tool_hot_retention_row();
DROP FUNCTION IF EXISTS revagent_capture_llm_hot_retention_row();
DROP FUNCTION IF EXISTS revagent_capture_hot_retention_row(uuid,text,date,uuid,jsonb);
DROP FUNCTION IF EXISTS revagent_prepare_hot_retention_partition(uuid,text,date,text,integer);
DROP FUNCTION IF EXISTS revagent_finalize_hot_retention_partition(uuid,text,date,text,integer);
DROP FUNCTION IF EXISTS revagent_precreate_retention_partition(uuid,text,date);
DROP FUNCTION IF EXISTS revagent_drop_retention_partition(uuid,text,date);

CREATE TABLE retention_partition_ownership (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  archive_kind text NOT NULL CHECK (archive_kind IN ('events','tool_invocations','llm_calls')),
  archive_month date NOT NULL CHECK (archive_month = date_trunc('month', archive_month)::date),
  partition_key text NOT NULL UNIQUE,
  partition_table text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('active','prepared','dropped')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  prepared_at timestamptz,
  dropped_at timestamptz,
  PRIMARY KEY (tenant_id, archive_kind, archive_month)
);

-- These registries preserve the pre-partition global PK/UNIQUE semantics and
-- idempotent replay fences without becoming a second data authority.
CREATE TABLE eu12_event_identity_registry (
  event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  retention_partition_key text NOT NULL,
  idempotency_key text,
  envelope_digest char(64) NOT NULL CHECK (envelope_digest ~ '^[0-9a-f]{64}$'),
  idempotency_digest char(64) NOT NULL CHECK (idempotency_digest ~ '^[0-9a-f]{64}$'),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE eu12_tool_invocation_identity_registry (
  invocation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  retention_partition_key text NOT NULL,
  idempotency_key text NOT NULL,
  event_id uuid UNIQUE,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE eu12_llm_call_identity_registry (
  event_id uuid PRIMARY KEY,
  call_id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  retention_partition_key text NOT NULL
);

CREATE TABLE events (
  id uuid NOT NULL,
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
  retention_class text NOT NULL DEFAULT 'standard_12m' CHECK (retention_class IN ('standard_12m','lifecycle_24m')),
  retention_partition_month date NOT NULL,
  retention_until timestamptz NOT NULL,
  retention_partition_key text NOT NULL,
  CONSTRAINT events_canonical_008_pkey PRIMARY KEY (id, retention_partition_key),
  CONSTRAINT events_canonical_008_idempotency_key UNIQUE (tenant_id, idempotency_key, retention_partition_key)
) PARTITION BY LIST (retention_partition_key);

CREATE TABLE tool_invocations (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  tool_name text NOT NULL,
  tool_version text NOT NULL,
  policy_class text NOT NULL CHECK (policy_class IN ('auto','confirm','gated')),
  executor text NOT NULL CHECK (executor IN ('bridge','internal_mcp','aps')),
  params_digest char(64) NOT NULL CHECK (params_digest ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('completed','guarded','failed','denied','cancelled','timeout')),
  idempotency_key text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  params_summary jsonb,
  code_summary jsonb,
  request_bytes integer CHECK (request_bytes IS NULL OR request_bytes >= 0),
  response_bytes integer CHECK (response_bytes IS NULL OR response_bytes >= 0),
  bridge_ms integer CHECK (bridge_ms IS NULL OR bridge_ms >= 0),
  audit_exempt boolean NOT NULL DEFAULT false,
  event_id uuid,
  turn_id uuid,
  invocation_seq bigint CHECK (invocation_seq IS NULL OR invocation_seq >= 0),
  actor_device_id uuid,
  namespace text CHECK (namespace IS NULL OR namespace IN ('core','mech','arch','struct','elec')),
  document_id text,
  model_guid text,
  error_class text CHECK (error_class IS NULL OR error_class IN ('retryable','terminal','parameter_fault','environment_fault')),
  error_message text CHECK (error_message IS NULL OR char_length(error_message) <= 4096),
  queue_ms integer CHECK (queue_ms IS NULL OR queue_ms >= 0),
  batch_id uuid,
  confirmation_id uuid,
  result_ref_id uuid,
  retention_partition_month date NOT NULL,
  retention_until timestamptz NOT NULL,
  retention_partition_key text NOT NULL,
  event_partition_key text,
  CONSTRAINT tool_invocations_canonical_008_pkey PRIMARY KEY (id, retention_partition_key),
  CONSTRAINT tool_invocations_canonical_008_idempotency_key UNIQUE (tenant_id, idempotency_key, retention_partition_key),
  CONSTRAINT tool_invocations_canonical_008_event_key UNIQUE (event_id, event_partition_key, retention_partition_key),
  CONSTRAINT tool_invocations_canonical_008_tenant_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT tool_invocations_canonical_008_session_fkey FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id),
  CONSTRAINT tool_invocations_canonical_008_actor_fkey FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id),
  CONSTRAINT tool_invocations_canonical_008_event_fkey FOREIGN KEY (event_id, event_partition_key) REFERENCES events(id, retention_partition_key)
) PARTITION BY LIST (retention_partition_key);

CREATE TABLE llm_calls (
  event_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL,
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens integer NOT NULL CHECK (cache_read_tokens >= 0),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  cost numeric(14,6) NOT NULL CHECK (cost >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  id uuid NOT NULL,
  turn_id uuid,
  provider text NOT NULL,
  model text NOT NULL,
  role text NOT NULL CHECK (role IN ('router','planner','main','subagent','summarizer','external_client')),
  engine_mode text NOT NULL CHECK (engine_mode IN ('tool_calling','code_exec','external_client')),
  cache_creation_input_tokens integer NOT NULL DEFAULT 0 CHECK (cache_creation_input_tokens >= 0),
  latency_ms integer NOT NULL,
  stop_reason text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('completed','failed','cancelled','timeout')),
  cost_microusd bigint NOT NULL,
  retention_partition_month date NOT NULL,
  retention_until timestamptz NOT NULL,
  retention_partition_key text NOT NULL,
  event_partition_key text NOT NULL,
  CONSTRAINT llm_calls_canonical_008_pkey PRIMARY KEY (event_id, retention_partition_key),
  CONSTRAINT llm_calls_canonical_008_id_key UNIQUE (id, retention_partition_key),
  CONSTRAINT llm_calls_canonical_008_event_fkey FOREIGN KEY (event_id, event_partition_key) REFERENCES events(id, retention_partition_key),
  CONSTRAINT llm_calls_canonical_008_session_fkey FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id)
) PARTITION BY LIST (retention_partition_key);

CREATE TABLE events_default_008 PARTITION OF events DEFAULT;
CREATE TABLE tool_invocations_default_008 PARTITION OF tool_invocations DEFAULT;
CREATE TABLE llm_calls_default_008 PARTITION OF llm_calls DEFAULT;

CREATE INDEX events_canonical_008_tenant_retention_partition_idx ON events(tenant_id, retention_partition_month, occurred_at);
CREATE INDEX events_canonical_008_tenant_retention_due_idx ON events(tenant_id, retention_until, occurred_at);
CREATE INDEX tool_invocations_canonical_008_tenant_retention_partition_idx ON tool_invocations(tenant_id, retention_partition_month, started_at);
CREATE INDEX tool_invocations_canonical_008_tenant_retention_due_idx ON tool_invocations(tenant_id, retention_until, started_at);
CREATE INDEX tool_invocations_canonical_008_tenant_session_sequence_idx ON tool_invocations(tenant_id, session_id, invocation_seq);
CREATE INDEX tool_invocations_canonical_008_tenant_tool_started_idx ON tool_invocations(tenant_id, tool_name, started_at DESC);
CREATE INDEX llm_calls_canonical_008_tenant_retention_partition_idx ON llm_calls(tenant_id, retention_partition_month, created_at);
CREATE INDEX llm_calls_canonical_008_tenant_retention_due_idx ON llm_calls(tenant_id, retention_until, created_at);
CREATE INDEX llm_calls_canonical_008_tenant_model_created_idx ON llm_calls(tenant_id, model, created_at DESC);

CREATE OR REPLACE FUNCTION revagent_assert_retention_tenant(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant text;
BEGIN
  v_tenant := NULLIF(current_setting('app.tenant_id', true), '');
  IF v_tenant IS NULL OR v_tenant <> p_tenant_id::text THEN
    RAISE EXCEPTION 'retention tenant scope does not match the transaction tenant';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION revagent_ensure_canonical_retention_partition(
  p_tenant_id uuid,
  p_archive_kind text,
  p_archive_month date
) RETURNS TABLE(partition_key text, partition_table text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_key text;
  v_parent text;
  v_table text;
  v_state text;
BEGIN
  PERFORM public.revagent_assert_retention_tenant(p_tenant_id);
  IF p_archive_kind NOT IN ('events','tool_invocations','llm_calls') THEN
    RAISE EXCEPTION 'invalid canonical retention archive kind';
  END IF;
  IF p_archive_month <> date_trunc('month', p_archive_month)::date THEN
    RAISE EXCEPTION 'canonical retention month must be month-start';
  END IF;
  v_parent := p_archive_kind;
  v_key := p_tenant_id::text || ':' || p_archive_kind || ':' || to_char(p_archive_month, 'YYYYMM');
  v_table := v_parent || '_p_' || substr(md5(v_key), 1, 24);
  SELECT ownership.state INTO v_state
  FROM public.retention_partition_ownership AS ownership
  WHERE ownership.tenant_id=p_tenant_id AND ownership.archive_kind=p_archive_kind AND ownership.archive_month=p_archive_month
  FOR UPDATE;
  IF NOT FOUND THEN
    EXECUTE format('CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.%I FOR VALUES IN (%L)', v_table, v_parent, v_key);
    INSERT INTO public.retention_partition_ownership(
      tenant_id,archive_kind,archive_month,partition_key,partition_table,state
    ) VALUES(p_tenant_id,p_archive_kind,p_archive_month,v_key,v_table,'active');
  ELSIF v_state <> 'active' THEN
    RAISE EXCEPTION 'canonical retention partition is not writable';
  ELSIF to_regclass('public.' || v_table) IS NULL THEN
    RAISE EXCEPTION 'canonical retention partition table is unavailable';
  END IF;
  RETURN QUERY SELECT v_key,v_table;
END;
$$;

-- Precreate exact leaves for every surviving legacy tenant/month before the
-- copy. Rows already represented by a dropped verified archive stay retired.
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT tenant_id,archive_kind,archive_month FROM (
      SELECT tenant_id,'events'::text AS archive_kind,retention_partition_month AS archive_month
      FROM events_legacy_008 AS source
      WHERE NOT EXISTS (SELECT 1 FROM retention_runs AS run WHERE run.tenant_id=source.tenant_id AND run.archive_kind='events' AND run.archive_month=source.retention_partition_month AND run.state='dropped')
      UNION
      SELECT tenant_id,'tool_invocations'::text,retention_partition_month
      FROM tool_invocations_legacy_008 AS source
      WHERE NOT EXISTS (SELECT 1 FROM retention_runs AS run WHERE run.tenant_id=source.tenant_id AND run.archive_kind='tool_invocations' AND run.archive_month=source.retention_partition_month AND run.state='dropped')
      UNION
      SELECT tenant_id,'llm_calls'::text,retention_partition_month
      FROM llm_calls_legacy_008 AS source
      WHERE NOT EXISTS (SELECT 1 FROM retention_runs AS run WHERE run.tenant_id=source.tenant_id AND run.archive_kind='llm_calls' AND run.archive_month=source.retention_partition_month AND run.state='dropped')
    ) AS distinct_partitions
  LOOP
    PERFORM set_config('app.tenant_id', item.tenant_id::text, true);
    PERFORM public.revagent_ensure_canonical_retention_partition(item.tenant_id,item.archive_kind,item.archive_month);
  END LOOP;
END;
$$;

INSERT INTO eu12_event_identity_registry(event_id,tenant_id,retention_partition_key,idempotency_key,envelope_digest,idempotency_digest)
SELECT id,tenant_id,tenant_id::text || ':events:' || to_char(retention_partition_month,'YYYYMM'),idempotency_key,envelope_digest,idempotency_digest
FROM events_legacy_008;

INSERT INTO eu12_tool_invocation_identity_registry(invocation_id,tenant_id,retention_partition_key,idempotency_key,event_id)
SELECT id,tenant_id,tenant_id::text || ':tool_invocations:' || to_char(retention_partition_month,'YYYYMM'),idempotency_key,event_id
FROM tool_invocations_legacy_008;

INSERT INTO eu12_llm_call_identity_registry(event_id,call_id,tenant_id,retention_partition_key)
SELECT event_id,id,tenant_id,tenant_id::text || ':llm_calls:' || to_char(retention_partition_month,'YYYYMM')
FROM llm_calls_legacy_008;

INSERT INTO events(
  id,tenant_id,event_type,occurred_at,recorded_at,source,actor,session_id,turn_id,sequence,payload,
  envelope_digest,idempotency_digest,idempotency_key,created_at,retention_class,retention_partition_month,retention_until,retention_partition_key
)
SELECT id,tenant_id,event_type,occurred_at,recorded_at,source,actor,session_id,turn_id,sequence,payload,
  envelope_digest,idempotency_digest,idempotency_key,created_at,retention_class,retention_partition_month,retention_until,
  tenant_id::text || ':events:' || to_char(retention_partition_month,'YYYYMM')
FROM events_legacy_008 AS source
WHERE NOT EXISTS (
  SELECT 1 FROM retention_runs AS run
  WHERE run.tenant_id=source.tenant_id AND run.archive_kind='events' AND run.archive_month=source.retention_partition_month AND run.state='dropped'
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tool_invocations_legacy_008 AS source
    WHERE NOT EXISTS (SELECT 1 FROM retention_runs AS run WHERE run.tenant_id=source.tenant_id AND run.archive_kind='tool_invocations' AND run.archive_month=source.retention_partition_month AND run.state='dropped')
      AND source.event_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM events AS event WHERE event.tenant_id=source.tenant_id AND event.id=source.event_id)
  ) THEN RAISE EXCEPTION 'canonical tool migration found a live row without canonical event authority'; END IF;
  IF EXISTS (
    SELECT 1 FROM llm_calls_legacy_008 AS source
    WHERE NOT EXISTS (SELECT 1 FROM retention_runs AS run WHERE run.tenant_id=source.tenant_id AND run.archive_kind='llm_calls' AND run.archive_month=source.retention_partition_month AND run.state='dropped')
      AND NOT EXISTS (SELECT 1 FROM events AS event WHERE event.tenant_id=source.tenant_id AND event.id=source.event_id)
  ) THEN RAISE EXCEPTION 'canonical LLM migration found a live row without canonical event authority'; END IF;
END;
$$;

INSERT INTO tool_invocations(
  id,tenant_id,session_id,actor_user_id,tool_name,tool_version,policy_class,executor,params_digest,outcome,idempotency_key,
  started_at,finished_at,duration_ms,params_summary,code_summary,request_bytes,response_bytes,bridge_ms,audit_exempt,event_id,
  turn_id,invocation_seq,actor_device_id,namespace,document_id,model_guid,error_class,error_message,queue_ms,batch_id,
  confirmation_id,result_ref_id,retention_partition_month,retention_until,retention_partition_key,event_partition_key
)
SELECT source.id,source.tenant_id,source.session_id,source.actor_user_id,source.tool_name,source.tool_version,source.policy_class,source.executor,source.params_digest,source.outcome,source.idempotency_key,
  source.started_at,source.finished_at,source.duration_ms,source.params_summary,source.code_summary,source.request_bytes,source.response_bytes,source.bridge_ms,source.audit_exempt,source.event_id,
  source.turn_id,source.invocation_seq,source.actor_device_id,source.namespace,source.document_id,source.model_guid,source.error_class,source.error_message,source.queue_ms,source.batch_id,
  source.confirmation_id,source.result_ref_id,source.retention_partition_month,source.retention_until,
  source.tenant_id::text || ':tool_invocations:' || to_char(source.retention_partition_month,'YYYYMM'),event.retention_partition_key
FROM tool_invocations_legacy_008 AS source
LEFT JOIN events AS event ON event.tenant_id=source.tenant_id AND event.id=source.event_id
WHERE NOT EXISTS (
  SELECT 1 FROM retention_runs AS run
  WHERE run.tenant_id=source.tenant_id AND run.archive_kind='tool_invocations' AND run.archive_month=source.retention_partition_month AND run.state='dropped'
);

INSERT INTO llm_calls(
  event_id,tenant_id,session_id,input_tokens,output_tokens,cache_read_tokens,duration_ms,cost,created_at,id,turn_id,provider,model,role,
  engine_mode,cache_creation_input_tokens,latency_ms,stop_reason,outcome,cost_microusd,retention_partition_month,retention_until,
  retention_partition_key,event_partition_key
)
SELECT source.event_id,source.tenant_id,source.session_id,source.input_tokens,source.output_tokens,source.cache_read_tokens,source.duration_ms,source.cost,source.created_at,source.id,source.turn_id,source.provider,source.model,source.role,
  source.engine_mode,source.cache_creation_input_tokens,source.latency_ms,source.stop_reason,source.outcome,source.cost_microusd,source.retention_partition_month,source.retention_until,
  source.tenant_id::text || ':llm_calls:' || to_char(source.retention_partition_month,'YYYYMM'),event.retention_partition_key
FROM llm_calls_legacy_008 AS source
JOIN events AS event ON event.tenant_id=source.tenant_id AND event.id=source.event_id
WHERE NOT EXISTS (
  SELECT 1 FROM retention_runs AS run
  WHERE run.tenant_id=source.tenant_id AND run.archive_kind='llm_calls' AND run.archive_month=source.retention_partition_month AND run.state='dropped'
);

DO $$
DECLARE
  expected_count integer;
  actual_count integer;
BEGIN
  SELECT count(*)::int INTO expected_count FROM events_legacy_008 AS source
  WHERE NOT EXISTS (SELECT 1 FROM retention_runs AS run WHERE run.tenant_id=source.tenant_id AND run.archive_kind='events' AND run.archive_month=source.retention_partition_month AND run.state='dropped');
  SELECT count(*)::int INTO actual_count FROM events;
  IF expected_count <> actual_count THEN RAISE EXCEPTION 'canonical event copy count mismatch'; END IF;
  SELECT count(*)::int INTO expected_count FROM tool_invocations_legacy_008 AS source
  WHERE NOT EXISTS (SELECT 1 FROM retention_runs AS run WHERE run.tenant_id=source.tenant_id AND run.archive_kind='tool_invocations' AND run.archive_month=source.retention_partition_month AND run.state='dropped');
  SELECT count(*)::int INTO actual_count FROM tool_invocations;
  IF expected_count <> actual_count THEN RAISE EXCEPTION 'canonical tool copy count mismatch'; END IF;
  SELECT count(*)::int INTO expected_count FROM llm_calls_legacy_008 AS source
  WHERE NOT EXISTS (SELECT 1 FROM retention_runs AS run WHERE run.tenant_id=source.tenant_id AND run.archive_kind='llm_calls' AND run.archive_month=source.retention_partition_month AND run.state='dropped');
  SELECT count(*)::int INTO actual_count FROM llm_calls;
  IF expected_count <> actual_count THEN RAISE EXCEPTION 'canonical LLM copy count mismatch'; END IF;
END;
$$;

DROP TABLE llm_calls_legacy_008;
DROP TABLE tool_invocations_legacy_008;
DROP TABLE events_legacy_008;

CREATE OR REPLACE FUNCTION revagent_assign_event_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.retention_partition_month := date_trunc('month', NEW.occurred_at AT TIME ZONE 'UTC')::date;
  IF NEW.event_type IN ('auth.event','bridge.connected','bridge.disconnected','bridge.enrolled','bridge.revoked','bridge.update') THEN
    NEW.retention_class := 'lifecycle_24m';
    NEW.retention_until := NEW.occurred_at + interval '24 months';
  ELSE
    NEW.retention_class := 'standard_12m';
    NEW.retention_until := NEW.occurred_at + interval '12 months';
  END IF;
  NEW.retention_partition_key := NEW.tenant_id::text || ':events:' || to_char(NEW.retention_partition_month,'YYYYMM');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION revagent_assign_tool_invocation_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.retention_partition_month := date_trunc('month', NEW.started_at AT TIME ZONE 'UTC')::date;
  NEW.retention_until := NEW.started_at + interval '12 months';
  NEW.retention_partition_key := NEW.tenant_id::text || ':tool_invocations:' || to_char(NEW.retention_partition_month,'YYYYMM');
  IF NEW.event_id IS NULL THEN
    NEW.event_partition_key := NULL;
  ELSE
    SELECT retention_partition_key INTO NEW.event_partition_key FROM public.events
    WHERE tenant_id=NEW.tenant_id AND id=NEW.event_id;
    IF NEW.event_partition_key IS NULL THEN RAISE EXCEPTION 'tool invocation event authority is unavailable'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION revagent_assign_llm_call_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.retention_partition_month := date_trunc('month', NEW.created_at AT TIME ZONE 'UTC')::date;
  NEW.retention_until := NEW.created_at + interval '12 months';
  NEW.retention_partition_key := NEW.tenant_id::text || ':llm_calls:' || to_char(NEW.retention_partition_month,'YYYYMM');
  SELECT retention_partition_key INTO NEW.event_partition_key FROM public.events
  WHERE tenant_id=NEW.tenant_id AND id=NEW.event_id;
  IF NEW.event_partition_key IS NULL THEN RAISE EXCEPTION 'LLM event authority is unavailable'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION revagent_register_event_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO public.eu12_event_identity_registry(event_id,tenant_id,retention_partition_key,idempotency_key,envelope_digest,idempotency_digest)
  VALUES(NEW.id,NEW.tenant_id,NEW.retention_partition_key,NEW.idempotency_key,NEW.envelope_digest,NEW.idempotency_digest);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION revagent_register_tool_invocation_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO public.eu12_tool_invocation_identity_registry(invocation_id,tenant_id,retention_partition_key,idempotency_key,event_id)
  VALUES(NEW.id,NEW.tenant_id,NEW.retention_partition_key,NEW.idempotency_key,NEW.event_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION revagent_register_llm_call_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO public.eu12_llm_call_identity_registry(event_id,call_id,tenant_id,retention_partition_key)
  VALUES(NEW.event_id,NEW.id,NEW.tenant_id,NEW.retention_partition_key);
  RETURN NEW;
END;
$$;

CREATE TRIGGER events_assign_retention
BEFORE INSERT OR UPDATE OF event_type,occurred_at ON events
FOR EACH ROW EXECUTE FUNCTION revagent_assign_event_retention();
CREATE TRIGGER tool_invocations_assign_retention
BEFORE INSERT OR UPDATE OF started_at,event_id ON tool_invocations
FOR EACH ROW EXECUTE FUNCTION revagent_assign_tool_invocation_retention();
CREATE TRIGGER llm_calls_assign_retention
BEFORE INSERT OR UPDATE OF created_at,event_id ON llm_calls
FOR EACH ROW EXECUTE FUNCTION revagent_assign_llm_call_retention();
CREATE TRIGGER events_register_identity
AFTER INSERT ON events
FOR EACH ROW EXECUTE FUNCTION revagent_register_event_identity();
CREATE TRIGGER tool_invocations_register_identity
AFTER INSERT ON tool_invocations
FOR EACH ROW EXECUTE FUNCTION revagent_register_tool_invocation_identity();
CREATE TRIGGER llm_calls_register_identity
AFTER INSERT ON llm_calls
FOR EACH ROW EXECUTE FUNCTION revagent_register_llm_call_identity();

CREATE OR REPLACE FUNCTION revagent_prepare_canonical_retention_partition(
  p_tenant_id uuid,
  p_archive_kind text,
  p_archive_month date,
  p_owner text,
  p_lease_epoch integer
) RETURNS TABLE(partition_key text, partition_table text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_key text;
  v_table text;
  v_state text;
BEGIN
  PERFORM public.revagent_assert_retention_tenant(p_tenant_id);
  IF p_owner IS NULL OR char_length(p_owner)=0 OR p_lease_epoch < 1 THEN RAISE EXCEPTION 'retention lease authority is invalid'; END IF;
  PERFORM 1 FROM public.retention_runs
  WHERE tenant_id=p_tenant_id AND archive_kind=p_archive_kind AND archive_month=p_archive_month
    AND state='prepared' AND lease_owner=p_owner AND lease_epoch=p_lease_epoch AND lease_expires_at > clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention lease does not authorize canonical partition preparation'; END IF;
  SELECT ownership.partition_key,ownership.partition_table,ownership.state INTO v_key,v_table,v_state
  FROM public.retention_partition_ownership AS ownership
  WHERE ownership.tenant_id=p_tenant_id AND ownership.archive_kind=p_archive_kind AND ownership.archive_month=p_archive_month
  FOR UPDATE;
  IF NOT FOUND OR v_state='dropped' OR to_regclass('public.' || v_table) IS NULL THEN
    RAISE EXCEPTION 'canonical retention partition authority is unavailable';
  END IF;
  UPDATE public.retention_partition_ownership SET state='prepared',prepared_at=clock_timestamp()
  WHERE tenant_id=p_tenant_id AND archive_kind=p_archive_kind AND archive_month=p_archive_month;
  RETURN QUERY SELECT v_key,v_table;
END;
$$;

CREATE OR REPLACE FUNCTION revagent_finalize_canonical_retention_partition(
  p_tenant_id uuid,
  p_archive_kind text,
  p_archive_month date,
  p_owner text,
  p_lease_epoch integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_parent text;
  v_table text;
BEGIN
  PERFORM public.revagent_assert_retention_tenant(p_tenant_id);
  PERFORM 1 FROM public.retention_runs
  WHERE tenant_id=p_tenant_id AND archive_kind=p_archive_kind AND archive_month=p_archive_month
    AND state='uploaded' AND lease_owner=p_owner AND lease_epoch=p_lease_epoch AND lease_expires_at > clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention lease does not authorize canonical partition finalization'; END IF;
  SELECT partition_table INTO v_table FROM public.retention_partition_ownership
  WHERE tenant_id=p_tenant_id AND archive_kind=p_archive_kind AND archive_month=p_archive_month AND state='prepared'
  FOR UPDATE;
  IF v_table IS NULL THEN RAISE EXCEPTION 'canonical retention partition is not prepared for detach'; END IF;
  v_parent := p_archive_kind;
  EXECUTE format('ALTER TABLE public.%I DETACH PARTITION public.%I', v_parent, v_table);
  EXECUTE format('DROP TABLE public.%I', v_table);
  UPDATE public.retention_partition_ownership SET state='dropped',dropped_at=clock_timestamp()
  WHERE tenant_id=p_tenant_id AND archive_kind=p_archive_kind AND archive_month=p_archive_month;
  UPDATE public.retention_runs
  SET state='dropped',dropped_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
  WHERE tenant_id=p_tenant_id AND archive_kind=p_archive_kind AND archive_month=p_archive_month
    AND state='uploaded' AND lease_owner=p_owner AND lease_epoch=p_lease_epoch;
END;
$$;

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
ALTER TABLE tool_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_invocations FORCE ROW LEVEL SECURITY;
ALTER TABLE llm_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_calls FORCE ROW LEVEL SECURITY;
ALTER TABLE retention_partition_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_partition_ownership FORCE ROW LEVEL SECURITY;
ALTER TABLE eu12_event_identity_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE eu12_event_identity_registry FORCE ROW LEVEL SECURITY;
ALTER TABLE eu12_tool_invocation_identity_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE eu12_tool_invocation_identity_registry FORCE ROW LEVEL SECURITY;
ALTER TABLE eu12_llm_call_identity_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE eu12_llm_call_identity_registry FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_scope ON events USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_scope ON tool_invocations USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_scope ON llm_calls USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_scope ON retention_partition_ownership USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_scope ON eu12_event_identity_registry USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_scope ON eu12_tool_invocation_identity_registry USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_scope ON eu12_llm_call_identity_registry USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON events,llm_calls TO revagent_app;
GRANT SELECT, INSERT, UPDATE ON tool_invocations TO revagent_app;
GRANT SELECT ON retention_partition_ownership,eu12_event_identity_registry,eu12_tool_invocation_identity_registry,eu12_llm_call_identity_registry TO revagent_app;
REVOKE ALL ON FUNCTION revagent_ensure_canonical_retention_partition(uuid,text,date) FROM PUBLIC;
REVOKE ALL ON FUNCTION revagent_prepare_canonical_retention_partition(uuid,text,date,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION revagent_finalize_canonical_retention_partition(uuid,text,date,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revagent_ensure_canonical_retention_partition(uuid,text,date) TO revagent_app;
GRANT EXECUTE ON FUNCTION revagent_prepare_canonical_retention_partition(uuid,text,date,text,integer) TO revagent_app;
GRANT EXECUTE ON FUNCTION revagent_finalize_canonical_retention_partition(uuid,text,date,text,integer) TO revagent_app;
