# EU-12 Final-Review Rework

The blocking review was limited to EU-12 durability and evidence gaps.

- H1: `revagent.event.v2` now uses one discriminated Zod payload schema for
  every event kind. Vectors cover every valid type, every required-field
  rejection, and 130 deterministic property samples across the full vocabulary.
- H2: `PostgresEu12DataStore` persists result references, retention-run state,
  archive progression, and release/channel reads across adapter restart. Memory
  stores remain conformance-only.
- H3: parity reports contain observed count, required minimum, and actual
  derived values; empty input cannot pass. Code fields use the canonical
  `lineCount`, `writePatterns`, and `hasManualTransaction` names.
- H4: append-only migration 004 adds R17/invocation linkage, metering
  dimensions, monthly retention basis/indexes, leases, and monotonic
  release-channel rollback guards.

Focused evidence before final broad gate:

- `rework-focused-reviewer-scale-cycle4.raw.log`: 10 tests passed, including
  1,000-event bounded/no-loss and 5 MiB result scope/expiry vectors.
- `rework-postgres-durable-cycle6.raw.log`: 3 PostgreSQL 16 tests passed after
  migrations 001–004, including migration replay, restart/resume, post-drop
  archive behavior, release anti-rollback, and RLS negatives.
- `rework-typecheck-final-candidate.raw.log` and
  `rework-lint-cycle2.raw.log`: passed.
