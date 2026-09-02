# EU-12 Retention-Class Due Rework

- H1: migration 009 re-partitions canonical event rows by tenant, surface,
  retention class, and UTC month. `standard_12m` and `lifecycle_24m` are
  different physical children even when their tenant and month match.
- Every leaf records its maximum authoritative `retention_until`. Archive
  ownership, run lease, object key, prepare, finalization, and archive read all
  carry the retention class and explicit trusted `asOf`.
- Due checks execute before object preparation and again before detach/drop.
  Interrupted standard archival resumes the same class leaf; it cannot cross
  into lifecycle evidence. Current and future leaves fail closed.
- Existing 008 canonical data is copied into class leaves in an append-only
  migration, including the 001–006 legacy upgrade route and replay identities.

Final local evidence:

- `retention-class-postgres-final2.raw.log`: 8 PostgreSQL 16 tests passed,
  including mixed-class due, crash/resume/replay, Tenant-B isolation, blank and
  008 upgrade coverage.
- `retention-class-focused-final.raw.log`: 10 tests passed;
  `retention-class-typecheck-final2.raw.log` and
  `retention-class-lint-final2.raw.log`: passed.
