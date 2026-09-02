# EU-12 Local Acceptance Evidence

## Identity and boundary

- Unit: EU-12 / M5-V3 Event, Result, Retention, Release Data, and Parity
- Base: `8d530d0cf65b2865cf92fbbe5b98151250f1f142` /
  `41dd5b795c5bb7053bf4f32d7683c0431331fd3c`
- Branch: `codex/eu-12-event-result-retention-parity`
- Draft PR: #405
- Boundary: P4-T2, T6–T11 and O11 only. The external client remains the
  Phase-1 agentic-loop owner under RES-23/29; this vertical adds passive usage
  records only, not a Gateway provider, credential, prompt, planner, retry, or
  sub-agent loop.

## Acceptance mapping

| Predicate | Evidence |
|---|---|
| Valid and invalid `revagent.event.v2` vectors; bounded, idempotent persistence | `eu12DataPlane.test.ts`, 8 focused tests |
| Summary and params-digest parity | exact runtime-compatible summary fixture in the same focused suite |
| Tenant/session result scope, stable paging, safe expiry | result-reference vectors, including cross-tenant and cross-session negatives |
| Resumable archive and retention | interrupted write-before-drop replay plus zstd NDJSON parse vector |
| Release/channel contract | pinned-key verifier contract and staged tenant rollout denial |
| Surviving O11 metrics derivable; dying metrics classified | mechanical parity report fixture |
| Two-tenant SQL isolation | disposable loopback PostgreSQL 16 integration, migrations 001–003 |

## Local checks

- `focused-eu12-cycle4.raw.log`: 8/8 focused tests passed.
- `focused-eu12-postgres-cycle2.raw.log`: 2/2 PostgreSQL 16 integration tests
  passed after migrations 001–003, including tool/metering persistence,
  idempotent redelivery, and RLS negatives for `events`, `result_refs`, and
  `retention_runs`. The disposable container was stopped and auto-removed.
- `focused-eu12-typecheck-final.raw.log`: Gateway typecheck passed with Node
  24.19.0.
- `focused-eu12-lint-final.raw.log`: Gateway ESLint passed.
- The final broad root gate is intentionally run only after this candidate is
  committed clean, because RBP conformance mechanically refuses a dirty tree.

## Forecast / actual / variance

- Forecast: 2.00 dev-days.
- Actual: 0.05 elapsed 8-hour-equivalent dev-days through local candidate
  preparation.
- Variance: -1.95 dev-days.

## Park List

None. No adjacent milestone, O1/wire, production, deployment, signing, NAS,
or live-Revit work was started.

## Delivery boundary

PR #405 remains draft and unmerged. Ready/review/merge and protected-check
actions belong to the controller after independent review.

## Fourth-review closure

- `007_eu12_hot_retention_authority.sql` makes physically detachable hot
  partitions authoritative for product reads and archive membership. Source
  relation rows remain operational projections; no archive path deletes them.
- `fourth-review-postgres-final.raw.log`: local disposable PostgreSQL 16,
  7/7 tests. It covers every crash boundary before final detach/drop, restart
  resume, legacy migration replay, nonempty typed hot rows, hardened definer
  privilege/GUC negatives, real lifecycle active-to-terminal and stale restart,
  signed release authority, and nonempty Tenant-B RLS negatives.
- `fourth-review-focused-final.raw.log`: 10/10 focused vectors passed;
  `fourth-review-typecheck-final2.raw.log` and
  `fourth-review-lint-final2.raw.log`: passed.
