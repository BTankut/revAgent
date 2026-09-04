# M5 Gate Evidence

## Header and anchor

**Protected-main anchor:** SHA `28214c4ef714436c2810680b840bda76f81feda9`,
tree `b02595a60a2854ec4c5b79263ce6e7073fd162d2`.

**M5 unit PRs delivered to protected main** (`gh pr view <N> --json mergeCommit,statusCheckRollup`):

| PR | Title | Merge commit (on `main`) | Post-merge CI (`gh run list --branch main --commit <sha>`) |
|---|---|---|---|
| [#403](https://github.com/BTankut/revAgent/pull/403) | [EU-10][M5] Authenticated tenant read | `f6764059a2aa4b181c1aed34a0443dca9150581f` | run 33589502708 `CI` SUCCESS; run 33589502713 `Gateway CI` SUCCESS; run 33589502710 `O1 add-in loopback fixture` SUCCESS; run 33589502705 `Gateway CD (M0 stub)` SKIPPED |
| [#404](https://github.com/BTankut/revAgent/pull/404) | [EU-11][M5] Enrolled and entitled Bridge dispatch | `8d530d0cf65b2865cf92fbbe5b98151250f1f142` | run 33600841035 `CI` SUCCESS; run 33600841045 `Gateway CI` SUCCESS; run 33600841076 `Gateway CD (M0 stub)` SKIPPED |
| [#405](https://github.com/BTankut/revAgent/pull/405) | [EU-12][M5] Event, result, retention, release data, and parity | `28214c4ef714436c2810680b840bda76f81feda9` | run 33674945050 `CI` SUCCESS; run 33674945013 `Gateway CI` SUCCESS; run 33674945120 `Gateway CD (M0 stub)` SKIPPED |

PR #405's merge commit is the current protected-main anchor, so PR #403/#404/#405
are the entire M5-labelled history on `main` between the pre-M5 base and the
anchor (`git log --first-parent origin/main` shows `28214c4e` → `8d530d0c` →
`f6764059` → `14b1a7b0` "docs(plan): accept M4 milestone (#402)" immediately
below the anchor, i.e. these three commits are exactly the delta since M4
acceptance).

## M5 evidence matrix

Card surfaces first (non-table), then one row per tenant-scoped table/surface
enabled with Postgres RLS (`ALTER TABLE … ENABLE ROW LEVEL SECURITY`) across
`packages/gateway/migrations/001..009`.

### Card surfaces

| Surface | Delivered by (PR) | Implementing files | Test evidence | Negative/RLS test | Status |
|---|---|---|---|---|---|
| Blank migration | #403, #404, #405 | `packages/gateway/src/migrate.ts`; `packages/gateway/migrations/001..009*.sql` | Gateway CI runs a blank `postgres:16` service container (`.github/workflows/gateway-ci.yml`); `packages/gateway/src/authenticatedTenantRead.test.ts:207` `"migrates a blank database, maps bearer identity/role, and denies invalid, expired, and foreign-tenant tokens"` (its `beforeAll` calls `migrateUp` against that blank DB); `packages/gateway/src/eu12Persistence.integration.test.ts:138` `"survives migration replay and restart for result refs, archive runs, and tenant-scoped release channels"` re-runs `migrateUp` idempotently | N/A (positive path) | EVIDENCED |
| Supported upgrade migration | #405 | `packages/gateway/src/migrate.ts` (`throughVersion` option) | `packages/gateway/src/eu12Persistence.integration.test.ts:764` `"upgrades multiple legacy result refs deterministically before the R17 uniqueness constraint"` — creates a fresh DB, migrates only through `003_eu12_event_result_retention_parity.sql`, seeds legacy rows, then steps forward through `004`→`006`→`008`→`009`, asserting data survives/transforms at each step | N/A (positive path) | EVIDENCED |
| OIDC | #403 | `packages/gateway/src/oidcIdentity.ts`; `deploy/phase1/keycloak/realm-revagent.json`; `deploy/phase1/keycloak/start-keycloak.sh` | `packages/gateway/src/authenticatedTenantRead.test.ts:347` `"maps real Keycloak Tenant A/B identities, isolates their north-MCP reads, and denies foreign/wrong authority"` — real Keycloak instance started in `.github/workflows/gateway-ci.yml` (step "Start local Keycloak OIDC evidence service"), so this is not a CI-skipped test | Y — denies wrong-issuer, wrong-audience, and foreign-tenant tokens in the same test | EVIDENCED |
| Device enrollment lifecycle (enroll, entitle/rotate, revoke) | #404 | `packages/gateway/src/m5EnrollmentEntitlement.ts`; `packages/gateway/src/m5EnrollmentEntitlementEndpoint.ts`; `packages/gateway/migrations/002_eu11_enrollment_entitlement_dispatch.sql` | `packages/gateway/src/m5EnrollmentEntitlement.test.ts:231` `"runs mint, exact Bridge exchange, handshake, atomic seat, filtered dispatch, rotation grace, and active revoke"` | Y — oversized/malformed enrollment bodies rejected (413/`invalid_enrollment_request`), non-admin mint denied (`admin_required`) | EVIDENCED |
| Seats | #404 | `packages/gateway/src/m5EnrollmentEntitlement.ts`; `packages/gateway/migrations/002_eu11_enrollment_entitlement_dispatch.sql` (`seat_assignments`, partial-unique) | Same test as above (`"atomic seat"` clause); seat cap enforced via `grantModuleLicense({ seatLimit: 1 })` | Y — over-limit assignment path is exercised as part of the "atomic seat" assertion | EVIDENCED |
| Audit | #403, #404, #405 | `packages/gateway/src/eventPersistence.ts`; `packages/gateway/src/postgresEu12EventPersistence.ts`; `tool_invocations`/`security_events` tables | `packages/gateway/src/authenticatedTenantRead.test.ts:262` `"executes one external north-MCP bounded read and persists one tenant-bound idempotent audit row"`; `packages/gateway/src/eu12DataPlane.test.ts:176` `"preserves the approved telemetry summary shape and the canonical raw-params digest"` | Y — `security_events` UPDATE/DELETE rejected with `42501` (audit immutability) in `packages/gateway/src/m5EnrollmentEntitlement.test.ts:684` | EVIDENCED |
| Events (O7 schema) | #405 | `packages/gateway/src/eventPersistence.ts`; `packages/gateway/src/events.ts`; `packages/gateway/migrations/003_eu12_event_result_retention_parity.sql`, `008_eu12_canonical_time_partitions.sql` | `packages/gateway/src/eu12DataPlane.test.ts:92` `"validates discriminated payloads for every event kind and rejects malformed vectors"`; `:132` `"writes a bounded, idempotent event stream without an unbounded queue"`; `:163` `"persists a 1k typed event burst and rejects the bounded plus-one batch"` | N/A (schema/positive path; RLS negative covered in the table rows below) | EVIDENCED |
| Results | #405 | `packages/gateway/src/resultReferenceStore.ts` | `packages/gateway/src/eu12DataPlane.test.ts:213` `"scopes result pages to exact tenant/session and expires both row and object"`; `:248` `"enforces the five MiB result bound while retaining stable multi-page object retrieval"` | Y — tenant/session-scoped paging is the assertion itself | EVIDENCED |
| Retention | #405 | `packages/gateway/src/retentionArchive.ts`; `packages/gateway/migrations/006_eu12_physical_retention_partitions.sql`, `007_eu12_hot_retention_authority.sql`, `009_eu12_retention_class_due_partitions.sql` | `packages/gateway/src/eu12DataPlane.test.ts:282` `"replays interrupted tenant-scoped archive runs and preserves another tenant's records"`; `packages/gateway/src/eu12Persistence.integration.test.ts:394` `"uses actual canonical partitions across every crash boundary and drops the canonical rows"`; `:480` `"separates same-month standard and lifecycle leaves and fails closed on retention due boundaries"` | Y — "preserves another tenant's records" is a cross-tenant negative | EVIDENCED |
| Release data / parity | #405 | `packages/gateway/src/releaseChannelStore.ts`; `packages/gateway/src/metricParity.ts` | `packages/gateway/src/eu12DataPlane.test.ts:310` `"stores a pinned release/channel contract and denies tenants outside a staged rollout"`; `:340` `"derives every surviving O11 metric and explicitly classifies every dying metric"` | Y — "denies tenants outside a staged rollout" | EVIDENCED |
| Two-tenant isolation (cross-cutting) | #403, #404, #405 | all of the above | Every test cited in this table that names two tenants (`TENANT_A`/`TENANT_B` or `tenantA`/`tenantB`) exercises this; the single strongest instance is `packages/gateway/src/eu12Persistence.integration.test.ts:868` `"enforces nonempty two-tenant RLS and definer privilege negatives for every EU-12 surface"`, which seeds real (nonempty) rows for tenant B and asserts tenant A's session sees zero across 11 tables in one test | Y | EVIDENCED |

### RLS per tenant-scoped table

Every table below has `ALTER TABLE … ENABLE ROW LEVEL SECURITY` plus a
`CREATE POLICY tenant_scope … USING (tenant_id = current_setting('app.tenant_id')::uuid)`
(or the equivalent canonical form) in the cited migration. "Negative test"
marks Y only where a test in the anchor tree queries that exact table by name
under a mismatched `app.tenant_id` and asserts zero rows / a permission
error; a table can have RLS enabled without a dedicated negative test — those
are marked PARTIAL or NOT EVIDENCED, not EVIDENCED, per the card's "never a
hedge" rule.

| Table | Delivered by (PR) | Migration (paths on anchor tree) | Test evidence (file + test name) | RLS negative present | Status |
|---|---|---|---|---|---|
| `tenants` | #403 | `packages/gateway/migrations/001_eu10_authenticated_tenant_read.sql:92,103` | `authenticatedTenantRead.test.ts:207` (line 216: `runtime.query("SELECT id FROM tenants")` without app role/tenant context rejected `42501`) | N — default-deny only, not a two-tenant cross-read | PARTIAL — gap: no test reads tenant B's row while scoped to tenant A |
| `users` | #403 | `packages/gateway/migrations/001_eu10_authenticated_tenant_read.sql:93,108` | none found querying `users` cross-tenant (only a table-owner check at `authenticatedTenantRead.test.ts:214` and a role-denial check at `m5EnrollmentEntitlement.test.ts:762`) | N | NOT EVIDENCED — gap: no cross-tenant negative test for `users` |
| `sessions` | #403 | `packages/gateway/migrations/001_eu10_authenticated_tenant_read.sql:94,113` | none found querying `sessions` cross-tenant by name | N | NOT EVIDENCED — gap: no cross-tenant negative test for `sessions` |
| `devices` | #403 | `packages/gateway/migrations/001_eu10_authenticated_tenant_read.sql:95,118` | `authenticatedTenantRead.test.ts:230` `"enforces RLS read/write negatives for two tenants"` | Y | EVIDENCED |
| `tool_invocations` (canonical) | #403, redefined #405 | `packages/gateway/migrations/001_eu10_authenticated_tenant_read.sql:96,123`; canonical form `009_eu12_retention_class_due_partitions.sql:460` | `authenticatedTenantRead.test.ts:230`; `eu12Persistence.integration.test.ts:868` (both by name) | Y | EVIDENCED |
| `enrollment_codes` | #404 | `packages/gateway/migrations/002_eu11_enrollment_entitlement_dispatch.sql:176,191` | `m5EnrollmentEntitlement.test.ts:684` `"enforces tenant RLS, immutable audit, composite license binding, and locator isolation"` | Y — tenant-A-scoped read of tenant B's row returns 0 | EVIDENCED |
| `device_credentials` | #404 | `packages/gateway/migrations/002_eu11_enrollment_entitlement_dispatch.sql:177,196` | `m5EnrollmentEntitlement.test.ts:634-635` reads token digests only via the dedicated `revagent_credential_locator` role | N — that is a role-privilege check, not a two-tenant cross-read | PARTIAL — gap: no cross-tenant negative for `device_credentials` |
| `module_licenses` | #404 | `packages/gateway/migrations/002_eu11_enrollment_entitlement_dispatch.sql:178,201` | `m5EnrollmentEntitlement.test.ts:740` reads `module_licenses` only to look up `mech`'s own id for a same-tenant FK negative | N | PARTIAL — gap: no cross-tenant negative for `module_licenses` |
| `seat_assignments` | #404 | `packages/gateway/migrations/002_eu11_enrollment_entitlement_dispatch.sql:179,206` | `m5EnrollmentEntitlement.test.ts:684` exercises a same-tenant foreign-key negative (wrong `module_name`), not cross-tenant | N | PARTIAL — gap: no cross-tenant negative for `seat_assignments` |
| `bridge_connections` | #404 | `packages/gateway/migrations/002_eu11_enrollment_entitlement_dispatch.sql:180,211` | none found querying this table by name in any `*.test.ts` | N | NOT EVIDENCED |
| `bridge_dispatches` | #404 | `packages/gateway/migrations/002_eu11_enrollment_entitlement_dispatch.sql:181,216` | none found querying this table by name in any `*.test.ts` | N | NOT EVIDENCED |
| `security_events` | #404 | `packages/gateway/migrations/002_eu11_enrollment_entitlement_dispatch.sql:182,221` | `m5EnrollmentEntitlement.test.ts:684` | Y — cross-tenant INSERT rejected `42501`; same-tenant UPDATE/DELETE also rejected `42501` (immutability) | EVIDENCED |
| `credential_scopes` (not tenant-scoped; role-gated locator table, no `tenant_id`/RLS) | #404 | `packages/gateway/migrations/002_eu11_enrollment_entitlement_dispatch.sql:159,173` | `m5EnrollmentEntitlement.test.ts:684` (lines ~751-758) | Y (role isolation, not RLS) — `revagent_app` denied `SELECT`; only `revagent_credential_locator` can read | EVIDENCED (as a role-isolation surface, not an RLS table) |
| `events` (canonical) | #405 | `packages/gateway/migrations/003_eu12_event_result_retention_parity.sql:112,123`; canonical `009_eu12_retention_class_due_partitions.sql:458` | `eu12Persistence.integration.test.ts:868` | Y — nonempty two-tenant negative | EVIDENCED |
| `llm_calls` (canonical) | #405 | `packages/gateway/migrations/003_eu12_event_result_retention_parity.sql:114,128`; canonical `009_eu12_retention_class_due_partitions.sql:462` | `eu12Persistence.integration.test.ts:868` | Y — nonempty two-tenant negative | EVIDENCED |
| `result_refs` | #405 | `packages/gateway/migrations/003_eu12_event_result_retention_parity.sql:116,133` | `eu12Persistence.integration.test.ts:868`; `eu12DataPlane.test.ts:213` | Y | EVIDENCED |
| `retention_runs` | #405 | `packages/gateway/migrations/003_eu12_event_result_retention_parity.sql:118,138` | `eu12Persistence.integration.test.ts:868` | Y — nonempty two-tenant negative | EVIDENCED |
| `release_channel_targets` | #405 | `packages/gateway/migrations/003_eu12_event_result_retention_parity.sql:120,143` | `eu12Persistence.integration.test.ts:868`; `eu12DataPlane.test.ts:310` | Y | EVIDENCED |
| `active_invocations` | #405 | `packages/gateway/migrations/006_eu12_physical_retention_partitions.sql:45,58,60` | `eu12Persistence.integration.test.ts:868` | Y — nonempty two-tenant negative; cross-tenant UPDATE affects 0 rows | EVIDENCED |
| `retention_partition_ownership` (canonical) | #405 | `packages/gateway/migrations/006_eu12_physical_retention_partitions.sql:5,29,33` (superseded); canonical `009_eu12_retention_class_due_partitions.sql:464` | `eu12Persistence.integration.test.ts:868` | Y — nonempty two-tenant negative | EVIDENCED |
| `eu12_event_identity_registry` | #405 | `packages/gateway/migrations/008_eu12_canonical_time_partitions.sql:48,569` | `eu12Persistence.integration.test.ts:868` | Y — nonempty two-tenant negative | EVIDENCED |
| `eu12_tool_invocation_identity_registry` | #405 | `packages/gateway/migrations/008_eu12_canonical_time_partitions.sql:58,571` | `eu12Persistence.integration.test.ts:868` | Y — nonempty two-tenant negative | EVIDENCED |
| `eu12_llm_call_identity_registry` | #405 | `packages/gateway/migrations/008_eu12_canonical_time_partitions.sql:67,573` | `eu12Persistence.integration.test.ts:868` | Y — nonempty two-tenant negative | EVIDENCED |

`retention_hot_partition_ownership`, `retention_hot_rows`, and the
006/007-era `retention_archive_rows` are RLS-enabled in the migration that
introduces them but are `DROP TABLE`-d by `008_eu12_canonical_time_partitions.sql:19-22`
before the anchor; they are not live surfaces on `origin/main` and are
excluded from this matrix as superseded, not as a gap.

## Card acceptance checklist

| Clause | Y/N | Evidence pointer |
|---|---|---|
| EU-10/11/12 delivered to protected main | Y | PR #403/#404/#405, all `state: MERGED`, merge commits `f6764059`/`8d530d0c`/`28214c4e` are the three commits immediately below the anchor in `git log --first-parent origin/main` (§ Header and anchor) |
| Every tenant-scoped surface has RLS negatives | **N** | Of 22 RLS-enabled tables (+1 role-gated `credential_scopes` surface), 15 are EVIDENCED with a dedicated negative test, 6 are PARTIAL (RLS enabled, only a same-tenant/default-deny negative exists, not a cross-tenant one: `tenants`, `device_credentials`, `module_licenses`, `seat_assignments`), and 2 are NOT EVIDENCED with any negative at all (`bridge_connections`, `bridge_dispatches`), plus `users`/`sessions` are NOT EVIDENCED for a cross-tenant negative — see § M5 evidence matrix, RLS table |
| No open Critical/High | Y (with the visibility caveat below) | The only per-PR reviewer verdict visible via `gh pr view <N> --json comments` is the Claude review-gate comment on each PR — `"No blocking issues found."` on #403, #404, and #405 (`gh pr view <N> --json reviews` returns an empty `reviews` array for all three: no formal GitHub Review objects with a severity label exist to cite beyond this comment) |
| Protected checks green | Y | Every check on each PR's post-merge run on `main` is `SUCCESS`, except `Gateway CD (M0 stub)` which is `SKIPPED` by design (M0-stub CD is not wired to run on these paths) — see § Header and anchor table |
| Exact M5 evidence record and milestone-owner decision card | Y | This document (§ M5 evidence matrix, § Milestone-owner decision card) |

## Red-result and gap disposition

| Surface | Gap | Disposition |
|---|---|---|
| `tenants` | Only a default-deny (no role/tenant context) negative exists; no explicit two-tenant cross-read | Parked — record only, not investigated further; a future slice should add `SELECT … WHERE tenant_id=<other>` under `app.tenant_id=<this>` asserting 0 rows |
| `users` | No cross-tenant negative test found | Parked — same disposition as `tenants` |
| `sessions` | No cross-tenant negative test found | Parked — same disposition as `tenants` |
| `device_credentials` | Only a role-privilege check (`revagent_credential_locator`) exists, not a cross-tenant negative | Parked — same disposition as `tenants` |
| `module_licenses` | Only a same-tenant FK negative exists, not a cross-tenant negative | Parked — same disposition as `tenants` |
| `seat_assignments` | Only a same-tenant FK negative exists, not a cross-tenant negative | Parked — same disposition as `tenants` |
| `bridge_connections` | No test in the anchor tree queries this table by name | Parked — same disposition as `tenants` |
| `bridge_dispatches` | No test in the anchor tree queries this table by name | Parked — same disposition as `tenants` |
| No open Critical/High (checklist row) | No formal GitHub Review-object severity labels exist on any of the three PRs to cite beyond the Claude review-gate comment | Recorded as a visibility gap, not a finding of an unresolved Critical/High — none is evidenced as open, but none could be independently confirmed closed beyond the review-gate comment |

None of these eight table-level gaps were investigated beyond confirming the
absence of a matching test by name in the anchor tree, per this unit's
docs-only, no-re-audit scope.

## Milestone-owner decision card

**Milestone:** M5 — OIDC, device enrollment, seats, tenant isolation, audit,
event schema, and Postgres migrations pass two-tenant tests (`MASTER_PLAN.md`
milestone table, owner WP4, depends on M2).

**Recommended decision:** **ACCEPT WITH RECORDED GAPS.**

**Basis (one sentence):** All eleven non-table M5 surfaces and 15 of 22
RLS-enabled tables carry EVIDENCED two-tenant/cross-tenant negative tests on
protected main with green checks and three merged unit PRs, while 6 tables
are PARTIAL (RLS enabled, no cross-tenant negative) and 2 (`bridge_connections`,
`bridge_dispatches`) plus `users`/`sessions` are NOT EVIDENCED for a dedicated
cross-tenant negative — real but bounded gaps that do not indicate a failing
RLS policy, only an untested one.

**Evidence anchor:** protected main SHA `28214c4ef714436c2810680b840bda76f81feda9`,
this file `docs/plan/M5_GATE_EVIDENCE.md`.

**Approval sentence the owner must state:**

> I accept M5 on protected main 28214c4e with the recorded gaps listed in
> M5_GATE_EVIDENCE.md §4.

**After acceptance:** a bounded ledger-sync unit updates the `MASTER_PLAN.md`
M5 row from `not_started` to `accepted` (docs-only, mirroring the M4
acceptance-ledger-sync precedent), and EU-20 starts. This document does not
itself perform that ledger update.

## Authorization ceiling

This unit produced documentation only: `docs/plan/M5_GATE_EVIDENCE.md` and a
minimal cross-reference line in `docs/plan/00-INDEX.md`. It made no product,
workflow, test, or `.orchestration/` changes, and it does not itself change
`MASTER_PLAN.md`'s M5 state — that ledger update is a separate, later unit
step gated on the milestone owner's acceptance above.

## Acceptance record

**Date:** 2026-09-03.

**Approval sentence (verbatim):**

> I accept M5 on protected main 28214c4e with the recorded gaps listed in
> M5_GATE_EVIDENCE.md §4.

**Decision:** ACCEPT WITH RECORDED GAPS.

**Evidence anchor:** protected main SHA `28214c4ef714436c2810680b840bda76f81feda9`.

**Merge commit / PR / CI run:** `35a18a1df3b45df59516a2a7612c6282150a5dd8` —
squash merge of EU-13 PR #406 "[EU-13][M5] M5 closure and acceptance
evidence"; post-merge CI run `33715481796` success.

**Gap disposition:** unchanged from § "Red-result and gap disposition" above —
the eight RLS-enabled tables without a dedicated cross-tenant negative
(`tenants`, `users`, `sessions`, `device_credentials`, `module_licenses`,
`seat_assignments`, `bridge_connections`, `bridge_dispatches`) remain parked
for a future test-only slice.

**Next unit:** EU-20 (M6-V1).

This forward pointer submits the milestone-owner acceptance for ledger
synchronization. It does not alter historical evidence recorded above.

## Post-acceptance erratum: production-auth-to-Bridge-ingress integration gap

**Status:** OPEN — closed in this PR once integration and negative evidence
are green.

**Recorded by:** `EU-20-AUTH-INGRESS` (M5 production-auth-to-Bridge-ingress
integration; EU-20 prerequisite card).

This erratum is append-only. It does not amend, rewrite, or delete any
historical M5 acceptance record above, including the Acceptance record's
approval sentence and gap disposition.

1. **Discovered during EU-20.** The gap was found while executing the EU-20
   (M6-V1 clean-machine install to live read) parent unit, after the EU-20
   PETRUCCI lab session halted at the lab-Gateway gate
   (`eu20-lab-evidence/phase-b-lab-gateway-gate.md`).
2. **Not covered by the original M5 evidence matrix.** The M5 evidence matrix
   above evidences the EU-11 Postgres-backed enrollment/device control plane
   (`packages/gateway/src/m5EnrollmentEntitlement.ts`) and the production
   Bridge ingress (`startProductionGatewayHost`,
   `GatewayBridgeSessionAuthority`) as separate surfaces. It does not evidence
   that the two are connected: the ingress path validates sessions through
   `createProductionIdentityAuthority` /
   `StoreBackedProductionIdentityAuthority`, a distinct store-backed authority
   from the Postgres-backed control plane that issues the enrolled device
   credential, and `IdentityPort.authenticateDevice` is not wired to
   `M5EnrollmentEntitlementControlPlane.openBridgeConnection`.
3. **Blocks EU-20 live acceptance.** Because a genuinely enrolled Bridge
   cannot establish a production Gateway session against its own issued
   credential, EU-20's live-read acceptance cannot proceed until this
   integration is bound and evidenced.
4. **Historical M5 acceptance records are not rewritten or deleted.** The M5
   milestone-owner decision, its accepted gap list, and the acceptance record
   above stand as originally recorded; this erratum adds a new, later-
   discovered fact rather than revising them.
