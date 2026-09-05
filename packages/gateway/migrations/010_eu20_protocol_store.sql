-- The protocol store is tenant-scoped even though its record payloads are opaque.
CREATE TABLE protocol_records (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  namespace text NOT NULL CHECK (octet_length(namespace) BETWEEN 1 AND 512),
  key text NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 512),
  value_json jsonb NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  updated_at_ms bigint NOT NULL,
  PRIMARY KEY (tenant_id, namespace, key)
);
ALTER TABLE protocol_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE protocol_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON protocol_records USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
GRANT SELECT, INSERT, UPDATE, DELETE ON protocol_records TO revagent_app;

-- One renewable serving fence, shared by every process using this database.
CREATE TABLE protocol_serving_owner (
  id integer PRIMARY KEY CHECK (id = 1),
  owner_token uuid,
  epoch bigint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO protocol_serving_owner(id) VALUES (1);
GRANT SELECT, UPDATE ON protocol_serving_owner TO revagent_app;

-- Startup inventory exposes identifiers only, never record payloads. Request
-- paths continue to use RLS. Keep this bounded and unavailable to PUBLIC.
CREATE FUNCTION protocol_inventory_tenants(requested_limit integer)
RETURNS TABLE(tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT r.tenant_id FROM public.protocol_records r
  ORDER BY r.tenant_id LIMIT LEAST(GREATEST(requested_limit, 0), 10001)
$$;
REVOKE ALL ON FUNCTION protocol_inventory_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION protocol_inventory_tenants(integer) TO revagent_app;
