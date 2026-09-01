# EU-10 Scope Map

- Unit: EU-10 / M5-V1 Authenticated Tenant Read
- Base commit: `14b1a7b0a2ec5ecf90068d16a3867d19dacc95ea`
- Base tree: `86620557a005dfe64789dd4ca505858e4e831f54`
- Branch: `codex/eu-10-authenticated-tenant-read`
- Worktree: `C:\Users\BT\Projects\revAgent-worktrees\eu10-authenticated-tenant-read`
- Orchestration deviation: configured `revagent_security_sol` launch failed with exact error `gpt-5.6 not supported`; the controller assigned one sole security-sensitive fallback executor for this unit.

## Selected vertical

Blank Postgres 16 migration -> two tenant fixtures and RLS -> tracked Keycloak-in-Compose selection with a generic `OIDC_*` contract -> JWT bearer validation and role mapping on north MCP -> bounded `core.bridge.list` Gateway-owned read -> idempotent tenant-bound `tool_invocations` audit row -> invalid/expired/foreign-tenant denial.

## Approved implementation paths

- `packages/gateway/migrations/**`: blank-DB schema, roles, RLS, and deterministic seed/migration runner inputs.
- `packages/gateway/src/oidcIdentity.ts` and focused tests: provider-neutral OIDC discovery/JWKS bearer validation, tenant/user/role/session mapping, and fail-closed token handling.
- `packages/gateway/src/postgresTenantStore.ts` and focused tests: tenant-scoped transactions, bounded read, user/session evidence, and idempotent audit persistence.
- `packages/gateway/src/authenticatedTenantRead.ts` and focused tests: one north-MCP `core.bridge.list` composition using existing registry/dispatcher contracts; no Bridge/Revit execution and no new tool semantics.
- `packages/gateway/src/config.ts`, `packages/gateway/src/config.test.ts`, `packages/gateway/src/index.ts`: generic OIDC and database configuration/export wiring without credential logging.
- `packages/gateway/package.json`, repository `package-lock.json`: only dependencies/scripts required by this vertical.
- `deploy/phase1/docker-compose.yml`, `deploy/phase1/.env.example`, `deploy/phase1/keycloak/**`, `deploy/phase1/README.md`: tracked Keycloak service/realm-as-code and secret-free generic OIDC configuration.
- `.github/workflows/gateway-ci.yml`: Postgres 16 service and the bounded migration/auth integration gate if required for reproducible protected checks.
- `.orchestration/autopilot-v2/artifacts/EU-10/20260901T193735Z/**`: scope, raw focused/broad logs, and final local evidence.

## Hard exclusions

No `packages/protocol/**`, O1/wire semantics, Bridge/add-in execution redesign, installer, production DNS/secrets/deployment, Gateway-host mutation, live Revit/PETRUCCI, LLM/provider loop, M6+, ready/merge actions.
