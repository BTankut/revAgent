-- EU-12 second-review repair: every governed hot surface gets the same
-- explicit monthly retention partition basis and durable lease semantics.

ALTER TABLE tool_invocations
  ADD COLUMN retention_partition_month date,
  ADD COLUMN retention_until timestamptz;

CREATE OR REPLACE FUNCTION revagent_assign_tool_invocation_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.retention_partition_month := date_trunc('month', NEW.started_at AT TIME ZONE 'UTC')::date;
  NEW.retention_until := NEW.started_at + interval '12 months';
  RETURN NEW;
END;
$$;

CREATE TRIGGER tool_invocations_assign_retention
BEFORE INSERT OR UPDATE OF started_at ON tool_invocations
FOR EACH ROW EXECUTE FUNCTION revagent_assign_tool_invocation_retention();

UPDATE tool_invocations
SET retention_partition_month = date_trunc('month', started_at AT TIME ZONE 'UTC')::date,
    retention_until = started_at + interval '12 months'
WHERE retention_partition_month IS NULL OR retention_until IS NULL;

ALTER TABLE tool_invocations
  ALTER COLUMN retention_partition_month SET NOT NULL,
  ALTER COLUMN retention_until SET NOT NULL;
CREATE INDEX tool_invocations_retention_partition_idx
  ON tool_invocations(tenant_id, retention_partition_month, started_at);
CREATE INDEX tool_invocations_retention_due_idx
  ON tool_invocations(tenant_id, retention_until, started_at);

ALTER TABLE llm_calls
  ADD COLUMN retention_partition_month date,
  ADD COLUMN retention_until timestamptz;

CREATE OR REPLACE FUNCTION revagent_assign_llm_call_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.retention_partition_month := date_trunc('month', NEW.created_at AT TIME ZONE 'UTC')::date;
  NEW.retention_until := NEW.created_at + interval '12 months';
  RETURN NEW;
END;
$$;

CREATE TRIGGER llm_calls_assign_retention
BEFORE INSERT OR UPDATE OF created_at ON llm_calls
FOR EACH ROW EXECUTE FUNCTION revagent_assign_llm_call_retention();

UPDATE llm_calls
SET retention_partition_month = date_trunc('month', created_at AT TIME ZONE 'UTC')::date,
    retention_until = created_at + interval '12 months'
WHERE retention_partition_month IS NULL OR retention_until IS NULL;

ALTER TABLE llm_calls
  ALTER COLUMN retention_partition_month SET NOT NULL,
  ALTER COLUMN retention_until SET NOT NULL;
CREATE INDEX llm_calls_retention_partition_idx
  ON llm_calls(tenant_id, retention_partition_month, created_at);
CREATE INDEX llm_calls_retention_due_idx
  ON llm_calls(tenant_id, retention_until, created_at);

ALTER TABLE retention_runs
  ADD COLUMN IF NOT EXISTS lease_epoch integer NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  ADD CONSTRAINT retention_runs_lease_pair_check CHECK (
    (lease_owner IS NULL) = (lease_expires_at IS NULL)
  );

-- A row represents one real retention partition: tenant + governed surface +
-- month. The lease CAS is enforced by the runner's UPDATE predicate and the
-- epoch is recorded in the durable archive transition.
CREATE INDEX retention_runs_lease_idx
  ON retention_runs(tenant_id, archive_kind, archive_month, lease_expires_at);

GRANT DELETE ON tool_invocations, llm_calls TO revagent_app;
