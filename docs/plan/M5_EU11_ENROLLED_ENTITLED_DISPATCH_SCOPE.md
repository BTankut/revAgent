# EU-11 / M5-V2 scope record

Hedef | M5-V2 enrolled and entitled Bridge dispatch | Plan satiri | M5; P4-T4; P4-T5 | Kabul | One-time enrollment, hashed and rotating device credential, atomic named-user module seat, entitlement-filtered capability index, one entitled Bridge dispatch, fail-closed tenant/principal/device negatives, simulated active revoke and audit evidence | Kapsam | Gateway/Postgres vertical and focused tests only; the existing Bridge `POST /bridge/v1/enroll` request/response contract is unchanged | Forecast | 1.50 active engineering days

## Anchor and ownership

- Base commit: `f6764059a2aa4b181c1aed34a0443dca9150581f`
- Base tree: `cfb869c447e5755d6f9ffafeaaa70e112f438f32`
- Branch: `codex/eu-11-enrolled-entitled-dispatch`
- Unit owner: EU-11 security executor
- Planned product ownership: `packages/gateway/migrations/002_eu11_*` and
  `packages/gateway/src/m5EnrollmentEntitlement*`, with only the minimum
  package export or `GatewayServerOptions` composition touch proven necessary
  by focused tests.

## Acceptance map

1. A tenant admin mints one bounded enrollment code; only its digest is stored,
   exchange is bound to tenant, device, principal and machine fingerprint, and
   reuse is denied and audited.
2. The issued device credential is stored only by digest. Rotation admits the
   previous credential only until the configured grace deadline, then rejects
   it; raw secrets never enter events or snapshots.
3. Named-user module seats are assigned under one atomic seat-cap transaction.
   Cross-tenant device, seat and principal combinations fail closed.
4. The capability index omits unlicensed capabilities. Dispatch rechecks the
   same entitlement, performs one Bridge-bound call when entitled, and audits a
   forged direct invocation as `entitlement_denied`.
5. A simulated active connection is closed within the existing five-second
   bound on revoke, and subsequent handshake is denied. No real workstation,
   Gateway host, Bridge service, Revit session, credential, DNS or deployment
   is touched.

## Explicit exclusions

- No RBP/O1 wire or Bridge execution redesign.
- No live device revoke or reboot.
- No production secret, DNS, deployment, signing, NAS, release, PETRUCCI,
  Gateway-host or live-Revit action.
- No adjacent M5/M6 work, broad schema completion, or historical milestone
  re-audit.

## Local candidate evidence

- Focused EU-11 PostgreSQL 16 integration: `2 passed / 0 failed`. The suite
  proves exact Bridge enrollment exchange, one-time-code reuse refusal,
  digest-only credential persistence, rotation grace and post-grace death,
  atomic seat cap under concurrency, filtered capability index, idempotent
  entitled Bridge dispatch, audited forged invocation refusal, cross-tenant
  device/seat/principal negatives, and simulated active revoke inside the
  existing five-second bound.
- Gateway typecheck and focused ESLint: passed.
- Broad Gateway gate: `63 files passed`; `947 passed / 8 skipped / 0 failed`.
  The skips are pre-existing platform/optional-live cases and no EU-11 test was
  skipped.
- Repository `scripts/test-all.ps1`: passed on the single unchanged rerun with
  `All local non-Revit tests passed`. The first run had one unrelated Bridge
  normal-stop timing failure (`1295/1296`); its exact unchanged rerun passed
  `1/1` in `222ms`, and both Bridge aggregates in the final broad run passed
  `1296/1296`. No product change was made for the one-occurrence flake.
- Raw local logs:
  `.orchestration/autopilot-v2/artifacts/EU-11/20260902T045821Z-eu11-local/`.
- Local acceptance: passed. Actual live device revoke and reboot remain the
  card's true operator gate and were not performed.

### Independent-review rework

- The exact Postgres control-plane class is mounted by the production Gateway
  server composition; a structural fake is rejected before listen. The focused
  test reaches `/bridge/v1/enroll` through a real started product server.
- Runtime audit authority is append-only (`SELECT, INSERT`); `UPDATE`, `DELETE`
  and `TRUNCATE` are explicitly revoked and mechanically denied.
- Seat rows bind `(tenant, license, module)` through one composite foreign key;
  a mismatched/unlicensed module insert fails with PostgreSQL `23503`.
- Enrollment ingress drains declared oversized bodies, retains the parser's
  8KiB hard cap for undeclared/chunked bodies, returns fixed no-store refusals,
  and refuses server-drain races before code consumption.
- Active revoke first aborts and detaches every matching in-flight dispatch,
  then isolates every close callback. A test with one throwing close proves a
  later close is still attempted inside the bound and the failure is audited.
- Focused independent-review rework gate: `3 passed / 0 failed`; Gateway
  typecheck and focused ESLint passed.
- The two PostgreSQL integration files run serially inside the Gateway package
  gate so their cluster-wide role DDL cannot race. The first combined run
  exposed `tuple concurrently updated`; the isolated rerun passed with the
  existing suite at `944 passed / 8 skipped` and EU-11 at `3 passed`.
- Exact rework candidate `scripts/test-all.ps1`: passed on its first run with
  `All local non-Revit tests passed`; both Bridge aggregates passed `1296/1296`.

Forecast: `1.50 active engineering days` (`12.00h`). Actual active effort:
`1.25h`. Variance: `-10.75h` (`-89.6%`). Park List: empty.
