# EU-12 Second Final-Review Rework

This bounded repair closes the second review only.

- H1: one `PostgresEu12EventPersistence` now owns typed O7 routing for both
  `PostgresTenantStore` and the durable lifecycle composition. A restarted
  `Eu12InvocationRecorder` reads both its event and its result page.
- H2: every governed hot surface (`events`, `tool_invocations`, `llm_calls`)
  has a monthly retention basis and durable tenant/surface/month lease.
  Archiving is typed, write-before-drop, ordered for the LLM FK, restart-safe,
  and rejects a competing owner until the lease holder resumes.
- H3: parity receives actual persisted active-task, tool/user, and model/user
  attribution; its report exposes nonempty cardinality and values.
- H4: the canonical signed durable release payload includes release sequence,
  release/channel rollback floors, channel revision, and rollout tenants.
- M1: the 004 historical upgrade ranks legacy refs deterministically as R17,
  R18, … before adding the per-session uniqueness constraint.

Evidence before final broad gate:

- `second-review-focused-final.raw.log`: 10 focused tests passed.
- `second-review-postgres-cycle5.raw.log`: 5 disposable PostgreSQL 16 tests
  passed, including legacy upgrade replay, multi-surface archive, lease race,
  restart, Tenant-B negatives, persisted attribution, and signed authority.
- `second-review-typecheck-final.raw.log` and
  `second-review-lint-cycle1.raw.log`: passed.
