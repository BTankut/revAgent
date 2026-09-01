CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE ROLE revagent_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT revagent_app TO CURRENT_USER;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  digest char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  oidc_issuer text NOT NULL,
  oidc_subject text NOT NULL,
  email text,
  display_name text,
  role text NOT NULL CHECK (role IN ('user', 'tenant_admin', 'vendor_admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_login_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, oidc_issuer, oidc_subject)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  client_type text NOT NULL CHECK (client_type IN ('web', 'mcp', 'bridge')),
  state text NOT NULL DEFAULT 'active',
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  machine_name text NOT NULL,
  bridge_version text,
  addin_version text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, machine_name)
);

CREATE TABLE tool_invocations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL REFERENCES sessions(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  tool_name text NOT NULL,
  tool_version text NOT NULL,
  policy_class text NOT NULL CHECK (policy_class IN ('auto', 'confirm', 'gated')),
  executor text NOT NULL CHECK (executor IN ('bridge', 'internal_mcp', 'aps')),
  params_digest char(64) NOT NULL CHECK (params_digest ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('completed', 'guarded', 'failed', 'denied', 'cancelled', 'timeout')),
  idempotency_key text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  UNIQUE (tenant_id, idempotency_key)
);

GRANT SELECT, INSERT, UPDATE ON tenants, users, sessions, devices, tool_invocations TO revagent_app;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
ALTER TABLE tool_invocations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_scope ON tenants USING (
  id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON users USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON sessions USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON devices USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON tool_invocations USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
