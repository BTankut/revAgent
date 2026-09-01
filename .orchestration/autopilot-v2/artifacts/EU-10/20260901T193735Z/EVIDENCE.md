# EU-10 Local Candidate Evidence

## Orchestration deviation

Configured `revagent_security_sol` launch failed with exact error `gpt-5.6 not supported`. The controller assigned one sole security-sensitive fallback executor. Scope was not broadened.

## Candidate scope

- Postgres 16 blank migration for tenants, OIDC users, MCP sessions, devices, and idempotent tool invocations.
- Forced RLS with an application role and tenant GUC; two-tenant read and write negatives.
- Provider-neutral RS256 OIDC bearer validation with issuer, audience, expiry, scope, tenant, subject, and role mapping.
- Tracked Keycloak-in-Compose realm-as-code with PKCE public client, tenant claim, MCP read scope, and explicit audience; no users, credentials, or client secrets are tracked.
- Existing Gateway-owned `core.bridge.list` semantics only: one 32-row-bounded authenticated tenant read through the north MCP endpoint.
- Tenant-bound user/session/tool-invocation persistence and `(tenant_id,idempotency_key)` upsert.
- Invalid signature, expired token, and unknown foreign tenant return north-MCP HTTP 401 before dispatch.
- No O1/wire, Bridge/Revit, installer, production host/DNS/secret/deployment, LLM loop, or M6+ change.

## Focused evidence

- `focused-final.json`: 17/17 passed, including a freshly recreated blank `postgres:16` database.
- Gateway typecheck: passed with bundled Node 24.19.0.
- Gateway lint: passed.
- Full Gateway package: 60 files, 939 passed, 7 skipped under Node 24.19.0; EU-10 integration included.
- Compose config and Keycloak realm JSON parse: passed.

## Broad local gate

- Exactly one repo-wide `npm test` run was started under Node 24.19.0 with the Postgres 16 integration database.
- Outcome: passed. The PowerShell process ran to its normal transcript end; all 11 npm lifecycle debug records created during the run report `verbose exit 0` / `info ok`.
- Raw process transcript: `broad-local-gate.log`.

## Ordinary repair record

- Missing workspace dev dependencies (`tsc` unavailable): repaired once by installing the root workspace.
- Migration replay initially attempted table recreation (`42P07`): repaired once by checking the version/digest before SQL.
- Stale pre-EU-10 config assertions: updated once to the provider-neutral OIDC contract.
- Shell Node 22 failed one existing Node-24 assertion after 938 tests passed: rerun with the bundled Node 24 runtime passed; no code repair was made.
- One TypeScript narrowing error after digest normalization: repaired once; did not repeat.

## Security observations

- Candidate-introduced open Critical/High: none.
- `npm audit --omit=dev` reports one High in `fast-uri`; the same `fast-uri@3.1.2` and related Hono versions are pinned on the exact base and were not introduced or changed by EU-10.

Local EU-10 acceptance: **YES**. Independent final review and protected checks remain pending; PR stays draft and unmerged.
