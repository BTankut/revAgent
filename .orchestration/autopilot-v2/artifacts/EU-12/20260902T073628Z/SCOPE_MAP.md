# EU-12 Scope Map

- Unit: EU-12 / M5-V3 Event, Result, Retention, Release Data, and Parity
- Base commit: `8d530d0cf65b2865cf92fbbe5b98151250f1f142`
- Base tree: `41dd5b795c5bb7053bf4f32d7683c0431331fd3c`
- Branch: `codex/eu-12-event-result-retention-parity`
- Worktree: `C:\\Users\\BT\\Projects\\revAgent-worktrees\\eu12-event-result-retention-parity`

## Selected vertical

One tenant/session-scoped invocation emits a validated `revagent.event.v2`
envelope to a bounded durable writer, materializes a paged result reference,
survives an idempotent replay, expires safely, resumes archival retention, and
supplies release/channel and metric-parity data without creating a Gateway-owned
LLM orchestration loop.

## Approved implementation paths

- `packages/gateway/migrations/003_eu12_event_result_retention_parity.sql`:
  tenant-scoped durable records for unified events, typed audit/metering rows,
  result references, retention runs, archives, and release channels.
- `packages/gateway/src/events.ts`, `eventPersistence.ts`, and focused tests:
  `revagent.event.v2` validation, bounded writer/back-pressure, idempotent
  routing, and explicit instrumentation records only.
- `packages/gateway/src/postgresTenantStore.ts` and focused tests: tenant/RLS
  persistence integration required by the EU-12 writer.
- `packages/gateway/src/resultReferenceStore.ts`, `retentionArchive.ts`,
  `releaseChannelStore.ts`, `metricParity.ts`, and focused tests: result scope,
  paging/expiry, resumable archival, release-channel contract, and mechanical
  surviving/dying metric classification.
- `packages/gateway/src/index.ts`, `packages/gateway/package.json`, and only
  the existing Gateway CI wiring if required to exercise this vertical.
- `.orchestration/autopilot-v2/artifacts/EU-12/20260902T073628Z/**`: raw test
  output and final local evidence.

## Hard exclusions

No `packages/protocol/**`, O1/wire semantics, Bridge/add-in changes, installer,
Gateway-owned provider/LLM/prompt/planner/router/sub-agent loop, production
secrets/DNS/deployment/signing/NAS, live Revit/device actions, M6+, ready, or
merge actions.
