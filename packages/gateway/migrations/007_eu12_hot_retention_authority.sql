-- EU-12 fourth-review repair: the retention archive owns real hot, time
-- partitioned rows.  The original event/tool/LLM relations remain operational
-- projections, while this relation is the authoritative retention plane used
-- by product reads and by detach/drop.  No archive flow DELETEs source rows.

CREATE TABLE retention_hot_partition_ownership (
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

CREATE TABLE retention_hot_rows (
  partition_key text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  archive_kind text NOT NULL CHECK (archive_kind IN ('events','tool_invocations','llm_calls')),
  archive_month date NOT NULL,
  row_id uuid NOT NULL,
  payload jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (partition_key, row_id)
) PARTITION BY LIST (partition_key);

ALTER TABLE retention_hot_partition_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_hot_partition_ownership FORCE ROW LEVEL SECURITY;
ALTER TABLE retention_hot_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_hot_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON retention_hot_partition_ownership USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON retention_hot_rows USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
GRANT SELECT ON retention_hot_partition_ownership, retention_hot_rows TO revagent_app;

-- These old staging helpers are deliberately retired.  Migration 006 is
-- immutable, so its public defaults are removed in this append-only repair.
CREATE OR REPLACE FUNCTION revagent_precreate_retention_partition(
  p_tenant_id uuid,
  p_archive_kind text,
  p_archive_month date
) RETURNS TABLE(partition_key text, partition_table text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'deprecated retention staging helper is not an authority';
END;
$$;

CREATE OR REPLACE FUNCTION revagent_drop_retention_partition(
  p_tenant_id uuid,
  p_archive_kind text,
  p_archive_month date
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'deprecated retention staging helper is not an authority';
END;
$$;
REVOKE ALL ON FUNCTION revagent_precreate_retention_partition(uuid,text,date) FROM PUBLIC;
REVOKE ALL ON FUNCTION revagent_drop_retention_partition(uuid,text,date) FROM PUBLIC;
REVOKE ALL ON FUNCTION revagent_precreate_retention_partition(uuid,text,date) FROM revagent_app;
REVOKE ALL ON FUNCTION revagent_drop_retention_partition(uuid,text,date) FROM revagent_app;
REVOKE INSERT, DELETE ON retention_partition_ownership, retention_archive_rows FROM revagent_app;

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

CREATE OR REPLACE FUNCTION revagent_capture_hot_retention_row(
  p_tenant_id uuid,
  p_archive_kind text,
  p_archive_month date,
  p_row_id uuid,
  p_payload jsonb
) RETURNS void
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
  IF p_archive_kind NOT IN ('events','tool_invocations','llm_calls') THEN
    RAISE EXCEPTION 'invalid retention archive kind';
  END IF;
  IF p_archive_month <> date_trunc('month', p_archive_month)::date THEN
    RAISE EXCEPTION 'retention archive month must be month-start';
  END IF;
  v_key := p_tenant_id::text || ':' || p_archive_kind || ':' || to_char(p_archive_month, 'YYYYMM');
  v_table := 'retention_hot_p_' || substr(md5(v_key), 1, 24);
  SELECT state INTO v_state
  FROM public.retention_hot_partition_ownership
  WHERE tenant_id=p_tenant_id AND archive_kind=p_archive_kind AND archive_month=p_archive_month
  FOR UPDATE;
  IF NOT FOUND THEN
    EXECUTE format('CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.retention_hot_rows FOR VALUES IN (%L)', v_table, v_key);
    INSERT INTO public.retention_hot_partition_ownership(
      tenant_id,archive_kind,archive_month,partition_key,partition_table,state
    ) VALUES (p_tenant_id,p_archive_kind,p_archive_month,v_key,v_table,'active');
  ELSIF v_state = 'dropped' THEN
    RAISE EXCEPTION 'retention hot partition is closed for archived month';
  END IF;
  INSERT INTO public.retention_hot_rows(partition_key,tenant_id,archive_kind,archive_month,row_id,payload)
  VALUES(v_key,p_tenant_id,p_archive_kind,p_archive_month,p_row_id,p_payload)
  ON CONFLICT (partition_key,row_id) DO UPDATE SET payload=EXCLUDED.payload,captured_at=clock_timestamp();
END;
$$;

CREATE OR REPLACE FUNCTION revagent_capture_event_hot_retention_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.revagent_capture_hot_retention_row(
    NEW.tenant_id, 'events', NEW.retention_partition_month, NEW.id, to_jsonb(NEW)
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION revagent_capture_tool_hot_retention_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.tenant_id <> OLD.tenant_id OR NEW.retention_partition_month <> OLD.retention_partition_month
  ) THEN
    RAISE EXCEPTION 'retention hot partition identity is immutable';
  END IF;
  PERFORM public.revagent_capture_hot_retention_row(
    NEW.tenant_id, 'tool_invocations', NEW.retention_partition_month, NEW.id, to_jsonb(NEW)
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION revagent_capture_llm_hot_retention_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.tenant_id <> OLD.tenant_id OR NEW.retention_partition_month <> OLD.retention_partition_month
  ) THEN
    RAISE EXCEPTION 'retention hot partition identity is immutable';
  END IF;
  PERFORM public.revagent_capture_hot_retention_row(
    NEW.tenant_id, 'llm_calls', NEW.retention_partition_month, NEW.id, to_jsonb(NEW)
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER events_capture_hot_retention
AFTER INSERT OR UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION revagent_capture_event_hot_retention_row();
CREATE TRIGGER tool_invocations_capture_hot_retention
AFTER INSERT OR UPDATE ON tool_invocations
FOR EACH ROW EXECUTE FUNCTION revagent_capture_tool_hot_retention_row();
CREATE TRIGGER llm_calls_capture_hot_retention
AFTER INSERT OR UPDATE ON llm_calls
FOR EACH ROW EXECUTE FUNCTION revagent_capture_llm_hot_retention_row();

-- Existing rows receive the exact same durable hot-plane representation before
-- any archive runner can detach a partition.
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN SELECT id,tenant_id,retention_partition_month,to_jsonb(events) AS payload FROM events LOOP
    PERFORM set_config('app.tenant_id', item.tenant_id::text, true);
    PERFORM public.revagent_capture_hot_retention_row(item.tenant_id,'events',item.retention_partition_month,item.id,item.payload);
  END LOOP;
  FOR item IN SELECT id,tenant_id,retention_partition_month,to_jsonb(tool_invocations) AS payload FROM tool_invocations LOOP
    PERFORM set_config('app.tenant_id', item.tenant_id::text, true);
    PERFORM public.revagent_capture_hot_retention_row(item.tenant_id,'tool_invocations',item.retention_partition_month,item.id,item.payload);
  END LOOP;
  FOR item IN SELECT id,tenant_id,retention_partition_month,to_jsonb(llm_calls) AS payload FROM llm_calls LOOP
    PERFORM set_config('app.tenant_id', item.tenant_id::text, true);
    PERFORM public.revagent_capture_hot_retention_row(item.tenant_id,'llm_calls',item.retention_partition_month,item.id,item.payload);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION revagent_prepare_hot_retention_partition(
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
  IF p_owner IS NULL OR char_length(p_owner) = 0 OR p_lease_epoch < 1 THEN
    RAISE EXCEPTION 'retention lease authority is invalid';
  END IF;
  PERFORM 1 FROM public.retention_runs
  WHERE tenant_id=p_tenant_id AND archive_kind=p_archive_kind AND archive_month=p_archive_month
    AND state='prepared' AND lease_owner=p_owner AND lease_epoch=p_lease_epoch
    AND lease_expires_at > clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention lease does not authorize partition preparation'; END IF;
  v_key := p_tenant_id::text || ':' || p_archive_kind || ':' || to_char(p_archive_month, 'YYYYMM');
  SELECT ownership.partition_table,ownership.state INTO v_table,v_state
  FROM public.retention_hot_partition_ownership AS ownership
  WHERE ownership.tenant_id=p_tenant_id AND ownership.archive_kind=p_archive_kind AND ownership.archive_month=p_archive_month
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention hot partition has no authoritative rows'; END IF;
  IF v_state = 'dropped' THEN RAISE EXCEPTION 'retention hot partition is already dropped'; END IF;
  IF to_regclass('public.' || v_table) IS NULL THEN RAISE EXCEPTION 'retention hot partition table is unavailable'; END IF;
  UPDATE public.retention_hot_partition_ownership
  SET state='prepared',prepared_at=clock_timestamp()
  WHERE tenant_id=p_tenant_id AND archive_kind=p_archive_kind AND archive_month=p_archive_month;
  RETURN QUERY SELECT v_key,v_table;
END;
$$;

CREATE OR REPLACE FUNCTION revagent_finalize_hot_retention_partition(
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
  v_table text;
BEGIN
  PERFORM public.revagent_assert_retention_tenant(p_tenant_id);
  PERFORM 1 FROM public.retention_runs
  WHERE tenant_id=p_tenant_id AND archive_kind=p_archive_kind AND archive_month=p_archive_month
    AND state='uploaded' AND lease_owner=p_owner AND lease_epoch=p_lease_epoch
    AND lease_expires_at > clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention lease does not authorize partition finalization'; END IF;
  SELECT partition_table INTO v_table
  FROM public.retention_hot_partition_ownership
  WHERE tenant_id=p_tenant_id AND archive_kind=p_archive_kind AND archive_month=p_archive_month AND state='prepared'
  FOR UPDATE;
  IF v_table IS NULL THEN RAISE EXCEPTION 'retention hot partition is not prepared for verified detach'; END IF;
  EXECUTE format('ALTER TABLE public.retention_hot_rows DETACH PARTITION public.%I', v_table);
  EXECUTE format('DROP TABLE public.%I', v_table);
  UPDATE public.retention_hot_partition_ownership
  SET state='dropped',dropped_at=clock_timestamp()
  WHERE tenant_id=p_tenant_id AND archive_kind=p_archive_kind AND archive_month=p_archive_month;
  UPDATE public.retention_runs
  SET state='dropped',dropped_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
  WHERE tenant_id=p_tenant_id AND archive_kind=p_archive_kind AND archive_month=p_archive_month
    AND state='uploaded' AND lease_owner=p_owner AND lease_epoch=p_lease_epoch;
END;
$$;

REVOKE ALL ON FUNCTION revagent_assert_retention_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION revagent_capture_hot_retention_row(uuid,text,date,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION revagent_capture_event_hot_retention_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION revagent_capture_tool_hot_retention_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION revagent_capture_llm_hot_retention_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION revagent_prepare_hot_retention_partition(uuid,text,date,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION revagent_finalize_hot_retention_partition(uuid,text,date,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revagent_prepare_hot_retention_partition(uuid,text,date,text,integer) TO revagent_app;
GRANT EXECUTE ON FUNCTION revagent_finalize_hot_retention_partition(uuid,text,date,text,integer) TO revagent_app;

-- Source tables are no longer the archive/drop mechanism.  Their data is an
-- operational projection while `retention_hot_rows` is physically detached.
REVOKE DELETE ON events, tool_invocations, llm_calls FROM revagent_app;
