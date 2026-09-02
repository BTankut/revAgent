# EU-12 Canonical Partition Rework

- H1: migration 008 safely renames the 001–007 canonical relations, creates
  partitioned replacements, copies and validates surviving data, rebuilds RLS,
  indexes and foreign relationships, then removes the 007 JSONB mirror and
  legacy relations in the same migration transaction.
- Canonical leaf keys are tenant + governed surface + UTC month. The routing
  writer obtains the exact leaf before insert. The archive runner lease-locks
  that leaf before enumeration, verifies its typed object, and atomically
  detaches/drops the real child with the `dropped` state transition.
- Small identity registries preserve pre-partition global event/tool/LLM replay
  and uniqueness constraints without storing payloads or becoming a second
  audit/metering authority.
- The PostgreSQL 16 integration covers blank migration, 001–006 multi-row
  upgrade equality (four events, two tools, two LLM calls), replay, nonempty
  A/B RLS, concurrent leases, all four crash boundaries, canonical absence
  after drop, and archive reread.

Candidate-focused evidence before broad gate:

- `canonical-review-postgres-final2.raw.log`: 7 PostgreSQL 16 tests passed.
- `canonical-review-focused-final2.raw.log`: 10 tests passed.
- `canonical-review-typecheck-final2.raw.log` and
  `canonical-review-lint-final2.raw.log`: passed.
