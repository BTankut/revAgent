DO $$ BEGIN
  CREATE ROLE revagent_credential_locator NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT revagent_credential_locator TO revagent_runtime;

ALTER TABLE devices
  ADD CONSTRAINT devices_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE enrollment_codes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  issued_by_user_id uuid NOT NULL,
  principal_user_id uuid NOT NULL,
  device_id uuid NOT NULL,
  machine_fingerprint char(71) NOT NULL
    CHECK (machine_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  code_digest char(64) NOT NULL UNIQUE
    CHECK (code_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'issued'
    CHECK (status IN ('issued', 'consumed', 'expired')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, issued_by_user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, principal_user_id) REFERENCES users(tenant_id, id),
  CHECK (expires_at > issued_at),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
);

CREATE TABLE device_credentials (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  principal_user_id uuid NOT NULL,
  machine_fingerprint char(71) NOT NULL
    CHECK (machine_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  current_token_digest char(64) NOT NULL UNIQUE
    CHECK (current_token_digest ~ '^[0-9a-f]{64}$'),
  previous_token_digest char(64) UNIQUE
    CHECK (previous_token_digest IS NULL OR previous_token_digest ~ '^[0-9a-f]{64}$'),
  previous_valid_until timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  rotated_at timestamptz,
  PRIMARY KEY (tenant_id, device_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id),
  FOREIGN KEY (tenant_id, principal_user_id) REFERENCES users(tenant_id, id),
  CHECK ((previous_token_digest IS NULL) = (previous_valid_until IS NULL))
);

CREATE TABLE module_licenses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  module_name text NOT NULL
    CHECK (module_name IN ('core', 'mech', 'arch', 'struct', 'elec')),
  seat_limit integer NOT NULL CHECK (seat_limit > 0 AND seat_limit <= 100000),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, module_name)
);

CREATE TABLE seat_assignments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  license_id uuid NOT NULL,
  module_name text NOT NULL
    CHECK (module_name IN ('core', 'mech', 'arch', 'struct', 'elec')),
  user_id uuid NOT NULL,
  device_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  assigned_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, license_id) REFERENCES module_licenses(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX seat_assignments_active_user_module
  ON seat_assignments(tenant_id, module_name, user_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX seat_assignments_active_device_module
  ON seat_assignments(tenant_id, module_name, device_id)
  WHERE status = 'active';

CREATE TABLE bridge_connections (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  device_id uuid NOT NULL,
  principal_user_id uuid NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'closed', 'revoked')),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  close_reason text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id),
  FOREIGN KEY (tenant_id, principal_user_id) REFERENCES users(tenant_id, id),
  CHECK ((status = 'active') = (closed_at IS NULL)),
  CHECK ((status = 'active') = (close_reason IS NULL))
);

CREATE TABLE bridge_dispatches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  invocation_id text NOT NULL,
  connection_id text NOT NULL,
  principal_user_id uuid NOT NULL,
  device_id uuid NOT NULL,
  module_name text NOT NULL
    CHECK (module_name IN ('core', 'mech', 'arch', 'struct', 'elec')),
  tool_name text NOT NULL,
  params_digest char(64) NOT NULL CHECK (params_digest ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL
    CHECK (outcome IN ('pending', 'completed', 'failed', 'denied')),
  result_digest char(64) CHECK (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$'),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (tenant_id, invocation_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES bridge_connections(tenant_id, id),
  FOREIGN KEY (tenant_id, principal_user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id),
  CHECK ((outcome = 'pending') = (finished_at IS NULL))
);

CREATE TABLE security_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_type text NOT NULL,
  actor_user_id uuid,
  actor_device_id uuid,
  target_user_id uuid,
  target_device_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('completed', 'denied', 'failed')),
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, target_user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_device_id) REFERENCES devices(tenant_id, id),
  FOREIGN KEY (tenant_id, target_device_id) REFERENCES devices(tenant_id, id),
  CHECK (jsonb_typeof(details) = 'object')
);

-- This table is deliberately outside tenant RLS. It contains only a keyed
-- digest locator and the minimum scope needed to enter a tenant transaction;
-- revagent_app has no privilege on it.
CREATE TABLE credential_scopes (
  token_digest char(64) PRIMARY KEY
    CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  credential_kind text NOT NULL CHECK (credential_kind IN ('enrollment', 'device')),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  device_id uuid NOT NULL,
  valid_until timestamptz
);

GRANT SELECT, INSERT, UPDATE ON
  enrollment_codes, device_credentials, module_licenses, seat_assignments,
  bridge_connections, bridge_dispatches, security_events TO revagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON credential_scopes
  TO revagent_credential_locator;

ALTER TABLE enrollment_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE seat_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridge_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridge_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE device_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE module_licenses FORCE ROW LEVEL SECURITY;
ALTER TABLE seat_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE bridge_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE bridge_dispatches FORCE ROW LEVEL SECURITY;
ALTER TABLE security_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_scope ON enrollment_codes USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON device_credentials USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON module_licenses USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON seat_assignments USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON bridge_connections USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON bridge_dispatches USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY tenant_scope ON security_events USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
