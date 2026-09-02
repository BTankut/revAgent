# EU-12 Third Final-Review Rework

- H1: the invocation recorder accepts only a bounded writer. The authoritative
  Postgres composition creates that writer and preserves existing default-TTL
  result expiry on a restarted idempotent replay.
- H2: migration 006 owns real child PostgreSQL archive partitions per
  tenant/surface/month. The runner precreates and stages a typed partition,
  verifies the compressed object before deletion, leases the run, then detaches
  and drops the child only after a verified source drop.
- H3: `active_invocations` persists a start-without-terminal state; the parity
  projection reads it along with typed tool/user and model/user attribution.
- H4: signed release payloads bind release and channel rollback floors, channel
  revision, and sorted rollout tenants. Target rows use the allocated revision.
- M1: legacy multi-ref migration evidence remains replayed through migration
  006 and proves deterministic labels before uniqueness.

Final focused evidence before broad gate:

- `third-review-focused-final.raw.log`: 10 tests passed.
- `third-review-postgres-final.raw.log`: 5 PostgreSQL 16 tests passed.
- `third-review-typecheck-cycle2.raw.log` and
  `third-review-lint-final.raw.log`: passed.
