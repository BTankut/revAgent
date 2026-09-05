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

## Completion record

Implementation: pending. Acceptance: pending. Actual effort and variance: pending. Park List: none at slice start; active prerequisites may not be parked to claim completion. Programme remains 4/11; M6 remains 0/2.
