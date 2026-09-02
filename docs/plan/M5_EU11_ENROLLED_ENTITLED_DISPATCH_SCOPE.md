# EU-11 / M5-V2 scope record

Hedef | M5-V2 enrolled and entitled Bridge dispatch | Plan satiri | M5; P4-T4; P4-T5 | Kabul | One-time enrollment, hashed and rotating device credential, atomic named-user module seat, entitlement-filtered capability index, one entitled Bridge dispatch, fail-closed tenant/principal/device negatives, simulated active revoke and audit evidence | Kapsam | Gateway/Postgres vertical and focused tests only; the existing Bridge `POST /bridge/v1/enroll` request/response contract is unchanged | Forecast | 1.50 active engineering days

## Anchor and ownership

- Base commit: `f6764059a2aa4b181c1aed34a0443dca9150581f`
- Base tree: `cfb869c447e5755d6f9ffafeaaa70e112f438f32`
- Branch: `codex/eu-11-enrolled-entitled-dispatch`
- Unit owner: EU-11 security executor
- Planned product ownership: `packages/gateway/migrations/002_eu11_*` and
  `packages/gateway/src/m5EnrollmentEntitlement*`, with only the minimum
  package export or composition touch proven necessary by focused tests.

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

