# EU-12 Fourth Final-Review Rework

- H1: migration 007 makes `retention_hot_rows` the authoritative, physically
  partitioned hot plane. Source relations remain operational projections; the
  archive flow verifies its object then atomically transitions `uploaded`,
  detaches/drops the hot child, and records `dropped` with no source DELETE.
- H2: migration 006 staging functions are retired and revoked from `PUBLIC`.
  New security-definer helpers use a `pg_catalog` search path, are executable
  only by `revagent_app`, and require matching tenant GUC plus active lease
  owner/epoch before partition work.
- H3: `PostgresEu12DataStore.createInvocationRecorder` composes the bounded
  writer with durable start/terminal hooks. The recorder finalizes failures and
  stale rows become explicit timeouts after restart.
- H4: release manifests sign the exact trigger-derived release/channel floors,
  channel revision, and sorted tenant targets; the store reads back and returns
  the same persisted authority.
- M1: PostgreSQL evidence uses real nonempty Tenant-B LLM, hot partition,
  retention lease/archive, active invocation, and rollout-target rows before
  proving Tenant-A negatives.

Fourth-review focused evidence before candidate broad gate:

- `fourth-review-focused-cycle1.raw.log`: 10 tests passed.
- `fourth-review-postgres-final.raw.log`: 7 PostgreSQL 16 tests passed,
  including all four crash boundaries, migration replay, legacy upgrade,
  physical detach/drop, privilege/RLS negatives, lifecycle restart, and
  release authority concurrency.
- `fourth-review-typecheck-final2.raw.log` and
  `fourth-review-lint-final2.raw.log`: Gateway checks passed.
