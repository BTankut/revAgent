# EU-10 Local Candidate Evidence

## Orchestration deviation

Configured `revagent_security_sol` launch failed with exact error `gpt-5.6 not supported`. The controller assigned one sole security-sensitive fallback executor. Scope was not broadened.

## Candidate scope

- Postgres 16 blank migration for tenants, OIDC users, MCP sessions, devices, and idempotent tool invocations.
- A separate non-owner `revagent_runtime` LOGIN with an out-of-repo credential, `NOINHERIT`, and explicit `SET LOCAL ROLE revagent_app`; the migration owner is not reused by the Gateway.
- Forced RLS plus tenant-composite user/session/audit foreign keys; two-tenant read/write and cross-tenant binding negatives.
- Provider-neutral RS256 OIDC bearer validation with issuer, audience, expiry, scope, tenant, subject, and role mapping.
- Tracked Keycloak-in-Compose realm-as-code with real discovery/authorization-code+PKCE evidence, tenant/subject/role/scope/audience claims, and no tracked credential value.
- Existing Gateway-owned `core.bridge.list` semantics only: one 32-row-bounded authenticated tenant read through the north MCP endpoint.
- Tenant-bound user/session/tool-invocation persistence and an idempotency upsert that rejects immutable-field drift.
- Invalid signature, expired token, and unknown foreign tenant return north-MCP HTTP 401 before dispatch.
- No O1/wire, Bridge/Revit, installer, production host/DNS/secret/deployment, LLM loop, or M6+ change.

## Focused evidence

- `focused-security-final.json`: 20/20 passed on a freshly recreated `postgres:16` database and real local Keycloak started through the tracked Compose secret wiring.
- Gateway typecheck and lint: passed with bundled Node 24.19.0.
- Compose base+test override config, Keycloak realm JSON, and launcher shell parse: passed.
- `FINAL_REWORK_CLASSIFICATION.json` records exact product head/tree, scope-exclusion proof, artifact hash, Node identities, terminal broad attempts, and GitGuardian remediation.

## Broad local gate classification

- The final machine-readable broad record is `broad-rework-final.json`; raw bytes and their SHA-256 are in `broad-rework-final.raw.log`.
- EU-10 and other ordinary suites passed. The terminal rerun recorded 2238 passed, 4 failed, and 9 skipped.
- All four failures are unchanged global RBP precondition guards: the cached production plan binds runtime Node 24.19.0 while the protected bootstrap independently and unconditionally resolves Program Files Node 22.22.2.
- The candidate changes no `packages/rbp-conformance/**`, `packages/protocol/**`, O1, plan-anchor, or conformance-policy path. Controller triage classified this as an environment/base mismatch with no EU-10-scope repair.
- A prior terminal run recorded the same four identity guards plus one C28 timeout; C28 passed on rerun. Both terminal summaries and raw-log hashes are retained in `FINAL_REWORK_CLASSIFICATION.json`.

## Ordinary repair record

- Missing workspace dev dependencies (`tsc` unavailable): repaired once by installing the root workspace.
- Migration replay initially attempted table recreation (`42P07`): repaired once by checking the version/digest before SQL.
- Stale pre-EU-10 config assertions: updated once to the provider-neutral OIDC contract.
- Shell Node 22 failed one existing Node-24 assertion after 938 tests passed: rerun with the bundled Node 24 runtime passed; no code repair was made.
- One TypeScript narrowing error after digest normalization: repaired once; did not repeat.
- The repeated Keycloak `no_code` result was a test-oracle defect; bounded same-origin redirect traversal plus cookie accumulation now proves the real PKCE callback/token path.
- GitGuardian's two deterministic test-literal findings were removed from the current candidate: CI inputs are generated at run time and Compose uses a host-only Docker secret file.

## Security observations

- Candidate-introduced open Critical/High after rework: none locally; remote GitGuardian must rescan the new head.
- `npm audit --omit=dev` reports one High in `fast-uri`; the same `fast-uri@3.1.2` and related Hono versions are pinned on the exact base and were not introduced or changed by EU-10.

Local EU-10 acceptance: **YES WITH EXTERNAL BASE MISMATCH**. Reviewer re-check and protected checks remain pending; PR stays draft and unmerged.
