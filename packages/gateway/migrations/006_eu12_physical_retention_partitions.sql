-- EU-12 third-review repair: real, owner-scoped PostgreSQL archive partitions.
-- A child partition is precreated for one tenant/surface/month, staged before
-- object write, and detached/dropped only after verified write-before-drop.

CREATE TABLE retention_partition_ownership (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  archive_kind text NOT NULL CHECK (archive_kind IN ('events','tool_invocations','llm_calls')),
  archive_month date NOT NULL CHECK (archive_month = date_trunc('month', archive_month)::date),
  partition_key text NOT NULL UNIQUE,
  partition_table text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('prepared','archived','dropped')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  dropped_at timestamptz,
  PRIMARY KEY (tenant_id, archive_kind, archive_month)
);

CREATE TABLE retention_archive_rows (
  partition_key text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  archive_kind text NOT NULL CHECK (archive_kind IN ('events','tool_invocations','llm_calls')),
  archive_month date NOT NULL,
  row_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (partition_key, row_id)
) PARTITION BY LIST (partition_key);

ALTER TABLE retention_partition_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_partition_ownership FORCE ROW LEVEL SECURITY;
ALTER TABLE retention_archive_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_archive_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON retention_partition_ownership USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON retention_archive_rows USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
GRANT SELECT, INSERT, DELETE ON retention_partition_ownership, retention_archive_rows TO revagent_app;

CREATE TABLE active_invocations (
  invocation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  tool_name text NOT NULL,
  started_at timestamptz NOT NULL,
  terminal_at timestamptz,
  terminal_outcome text,
  CHECK ((terminal_at IS NULL) = (terminal_outcome IS NULL)),
  FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id)
);
ALTER TABLE active_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE active_invocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON active_invocations USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
GRANT SELECT, INSERT, UPDATE ON active_invocations TO revagent_app;
CREATE INDEX active_invocations_tenant_open_idx ON active_invocations(tenant_id, started_at) WHERE terminal_at IS NULL;

CREATE OR REPLACE FUNCTION revagent_precreate_retention_partition(
  p_tenant_id uuid,
  p_archive_kind text,
  p_archive_month date
) RETURNS TABLE(partition_key text, partition_table text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text;
  v_table text;
BEGIN
  IF p_archive_kind NOT IN ('events','tool_invocations','llm_calls') THEN
    RAISE EXCEPTION 'invalid archive kind';
  END IF;
  IF p_archive_month <> date_trunc('month', p_archive_month)::date THEN
    RAISE EXCEPTION 'archive month must be month-start';
  END IF;
  v_key := p_tenant_id::text || ':' || p_archive_kind || ':' || to_char(p_archive_month,'YYYYMM');
  v_table := 'retention_archive_p_' || substr(md5(v_key),1,24);
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF retention_archive_rows FOR VALUES IN (%L)', v_table, v_key);
  INSERT INTO retention_partition_ownership(tenant_id,archive_kind,archive_month,partition_key,partition_table,state)
  VALUES(p_tenant_id,p_archive_kind,p_archive_month,v_key,v_table,'prepared')
  ON CONFLICT (tenant_id,archive_kind,archive_month) DO UPDATE
    SET partition_key=EXCLUDED.partition_key,partition_table=EXCLUDED.partition_table,
        state=CASE WHEN retention_partition_ownership.state='dropped' THEN 'prepared' ELSE retention_partition_ownership.state END;
  RETURN QUERY SELECT v_key,v_table;
END;
$$;

CREATE OR REPLACE FUNCTION revagent_drop_retention_partition(
  p_tenant_id uuid,
  p_archive_kind text,
  p_archive_month date
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_table text;
BEGIN
  SELECT partition_table INTO v_table
  FROM retention_partition_ownership
  WHERE tenant_id=p_tenant_id AND archive_kind=p_archive_kind AND archive_month=p_archive_month AND state='archived'
  FOR UPDATE;
  IF v_table IS NULL THEN RAISE EXCEPTION 'retention partition is not verified for drop'; END IF;
  EXECUTE format('ALTER TABLE retention_archive_rows DETACH PARTITION %I', v_table);
  EXECUTE format('DROP TABLE IF EXISTS %I', v_table);
  UPDATE retention_partition_ownership
  SET state='dropped',dropped_at=clock_timestamp()
  WHERE tenant_id=p_tenant_id AND archive_kind=p_archive_kind AND archive_month=p_archive_month;
END;
$$;
