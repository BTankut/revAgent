# EU-20 B1 production bootstrap correction

Hedef | Plan satırı | Kabul | Kapsam | Forecast
EU-20 genuine install-to-read prerequisite | M6/P3-T9, P-ENROLL-1; M5 production-auth integration; P-DATA-2 | Actual image startup, migrated Postgres, real C# identity/enrollment and authenticated entitled read; negative fingerprint/tenant/token/seat checks | Gateway image/main/PostgreSQL protocol-store and lifecycle wiring; minimal C# first-install artifact consumption and installer integration; focused tests and evidence | 10-14 active engineering hours, excluding CI/review waiting

## Anchor and problem

Base: `4787171ad0849efe4055907d4279b71072796083`, tree `d9f8f95ead3b47a32c81391ab19f4ad47fe757db` (PR #409). EU-20 remains incomplete; B1 is partial and B2 has not started. This is a prerequisite correction within the existing MASTER_PLAN, not a new programme or acceptance decision.

The runtime image omits migrations; production main replaces only identity while leaving ingress and dispatch unavailable; the installer leaves an enrollment artifact that the normal C# worker does not consume. Mint already binds a fingerprint, but a fresh genuine C# identity creates that fingerprint locally from fresh randomness. A healthy image or test-only composition does not prove this path.

## Scope and invariants

- Ship migrations and implement the existing GatewayProtocolStore contract using PostgreSQL with tenant RLS and existing transaction/startup fencing. Preserve separate migration and runtime credentials.
- Compose the actual product main entrypoint with real identity, shared WSS/HTTP session authority, entitlement/seat checks and read dispatch. Do not install test, conformance or shadow authorities as production adapters.
- Use genuine C# identity creation and public fingerprint output before mint; consume first-install enrollment artifact through the real worker path. Keep existing missing-identity re-enrollment refusal. No secret seed inspection, preseed, forgery or weakened binding.
- Preserve one fresh installer invocation as the acceptance predicate. Do not silently count manual bootstrap followed by doctor re-enroll. Resolve the compatible in-installer fingerprint/token handoff and test it explicitly.
- Preserve O1/wire semantics and existing auth, tenant, TLS, fingerprint, rollback and lifecycle guarantees. No broad refactor, workflow change, production operation or milestone promotion.

## Acceptance evidence to collect

1. Actual shipped migration CLI initializes blank Postgres and reruns idempotently. Runtime-role cross-tenant negatives remain enforced.
2. Actual image main startup provides operational production ingress while refusing fixture/conformance adapters and incomplete required configuration.
3. Genuine C# identity is stable across subsequent invocations, created only by the protected C# store; corrupt/orphaned identity fails closed and secret values never enter output.
4. First-install artifact is safely consumed and cleaned up; real exchange, persistence and restart work; existing re-enrollment behavior is preserved.
5. Real C# Bridge traverses authenticated WSS and capability-gated HTTP against the product image; a licensed/entitled read traverses the actual production dispatch entry to the add-in fixture. This remains repository proof, not PETRUCCI live acceptance.
6. Wrong fingerprint/tenant, reused code, revoked device, missing seat/license refuse before executor invocation.
7. Locally green exact candidate, independent review, required CI/review checks and guarded squash merge; merged SHA/tree and post-merge checks read back. Assess merge-triggered signing/CD scope before merge.

## Execution boundary

One isolated writer, followed by one independent read-only reviewer. Scope-record commit and draft PR precede implementation. No live-lab mutation is authorized by this code slice. Existing lab assets, private TLS/key material, R-D rollback and archives stay preserved. Network/TLS/B2/live read/uninstall/restoration evidence belongs to the recorded EU-20 laboratory sequence.

## Completion record (2026-09-05)

The complete repository fixture passed on product candidate
`86e9b16379bcf2fd0dc6de1e88fbf40a76d51656`, tree
`7eb317150e0109567d2d3e848e541d1dde1b25af`. Evidence root:
`.orchestration/autopilot-v2/artifacts/EU-20/astra-b1/exact-86e9b163-genuine-admin-20260905T090914Z`.
The actual production image was
`sha256:d5e78bb40f2ae3865a5cfa32e2569cad79555c3a4bd6e024e89fd95d3118d007`.
Its ten migrations applied to blank PostgreSQL and reran idempotently. Genuine
C# identity preparation, OIDC/M5 mint/exchange, protected artifact consumption,
LocalMachine DPAPI persistence, WSS entitled read and HTTP/SSE persisted restart
read passed. Both reads reached the add-in fixture once and refused a subsequent
revoked-license request without another execution. The private evidence ACL and
absence of all four owned transient Docker resources were verified; read,
cleanup and overall outcomes are separate passed fields in `candidate.json`.

Two real-path defects were corrected before that pass: the identity writer now
uses canonical unescaped Base64, and confirmed unregister cleanup defers while
known retention-owned child evidence still references the retired session.
The latter preserves the seven-day floor/fourteen-day default, never reactivates
the tombstoned session, and does not suppress unknown FK or delete failures.
The exact lifecycle candidate passed 207 focused SQLite/coordinator cases.

`test-all.ps1` passed on the same clean product candidate from 09:14:56 to
09:29:38 UTC, including payload freshness. Its Bridge suites reported 1305
passed/one elevated fixture skip, Contracts 312 passed and real-worker host
31 passed. The skipped unit case is distinct from the actual elevated complete
fixture above. An earlier attempt failed because the executor selected an
oversized TEMP path; the short isolated TEMP rerun passed without product edits.
The logs and exact start/end/head/tree manifests are under
`.orchestration/autopilot-v2/artifacts/EU-20/astra-b1/final-86e9b163-gates/`.
Final delivery relies on the recorded gate manifests and exact-head CI/review;
this record does not claim a future `test-ci.ps1` outcome.

A subsequent fixture-only correction confines added diagnostic snapshot fields
to genuine EU-20 mode. The original C39 three-field IPC shape and strict reader
remain unchanged. Together with this documentation update, it changes no
production source, migration or image configuration. Exact product-tree equality
and any fresh final-candidate proof are recorded separately; the successful
86e9b163 run is not relabeled as evidence from a later head.

Historical evidence remains anchored: `ae36529f` carried the earlier full local
gates, 956 Gateway tests and 32 affected DB cases/one externally configured
Keycloak skip; `870dc6e6` added nine PostgreSQL cases, real private-ACL checks,
eight explicitly simulated cleanup cases and transport-only image evidence.
Those transport runs explicitly did not exercise protected first installation.
The F1 installer ordering was separately tested in PowerShell 7 and 5.1: artifact
completion precedes the host install command that starts SCM.

The controller reviewed the final product correction after the separate native
reviewer could not be reopened because of an agent thread limit. The executor
independently reviewed only the controller-authored operator wrapper. Neither is
represented as the mandatory protected independent final PR review.

Forecast remains 10-14 active engineering hours, excluding CI/review waits.
Active-time actual and variance have not been reconstructed from wall-clock
duration; gate start/end times are recorded. The 00:33-05:04 pending-init pause
is excluded from active effort. Park List: none.

Acceptance remains pending. Repository fixture success does not prove the signed
installer/SCM/live Revit/PETRUCCI/uninstall/R-D restoration sequence. Network
policy configuration does not prove effective peer isolation. Programme and
milestone promotion, protected final review, merge and production signing/CD
scope decisions remain separate.
