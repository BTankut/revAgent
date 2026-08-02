# M3 Bridge + Add-in Gate Evidence

**Document state:** M3 gate evidence produced; awaiting operator acceptance.
Only the milestone decision owner may move this gate from `passed` to
`accepted` (MASTER_PLAN R). R-C: a milestone is exited by its scripted demo,
not by this document; this ledger records the demo's retained evidence.

**Milestone:** M3 — Bridge + pre-pilot add-in adaptations connect, journal
redelivery, and demonstrate sequential then capability-gated atomic batch
behavior (MASTER_PLAN:113; section-08:81).

**Live demo host:** clean Windows 11 Pro workstation PETRUCCI, Revit 2022,
model `RME_basic_sample_project`. No prior revAgent install. Bridge ran as the
real `revAgentBridge` Windows service (LocalSystem) against a conforming
Gateway peer (the frozen `@revagent/gateway-stub`, TLS on loopback) and a live
add-in listener on 127.0.0.1:8080.

## Section-08 M3 gate items

| Gate item (section-08:81) | Evidence | State |
|---|---|---|
| Enrollment (bridge side, stub-proven — RES-30) | `doctor --re-enroll` against the stub: `enrolled` false→true, DPAPI device credential + machine fingerprint written; single-use token, fail-closed when absent. Real-Gateway exchange/revoke/reboot stays an M4 entry criterion per RES-30. | `passed` |
| Persistent WSS | Bridge service holds one steady wss connection to the Gateway peer across restarts; `hello` accepted (`enrollment_bound`), `session_register` accepted, session `liveness=steady`. | `passed` |
| Invocation → add-in TCP framing | `dispatch_invoke get_current_view_info` and `get_ui_state` over the full chain return `classification=result` with real model data (view `{3D}`, document `RME_basic_sample_project`); length-prefixed JSON-RPC v1 framing, execute_ms≈168. | `passed` |
| Idempotency journal | Section 12 invocation/batch journal admits, terminalizes, and arbitrates redelivery on the invocation key; P3-T13 abrupt-death durability harness green (PR #338). | `passed` |
| Batch-as-transaction-group (P2) | Atomic `invoke_batch` over the full chain reaches its terminal Section 11.1 batch carrier with the session window released (`inFlight=null`); direct `execute_batch` on the live add-in commits inside one Revit `TransactionGroup` and rolls back on a guarded step (rollback leaves no undo entry — operator-confirmed screenshot). | `passed` |

## Add-in command surface (live, all 23 commands)

`mcp_status` + `get_document_context` (bypass the data-plane gate) and 21
registry commands, all exercised against live Revit 2022:

- Read-only (12): `get_current_view_info`, `get_current_view_elements`,
  `get_selected_elements`, `list_open_views`, `get_ui_state`, `inspect_levels`,
  `inspect_sheet_text`, `inspect_schedules`, `count_annotations`,
  `extract_spatial_snapshot`, `get_spatial_change_state`, `find_elements` — all
  return real data or a correct `guarded/needs_scope` when unscoped.
- UI/navigation (6): `activate_view`, `close_view`, `clear_selection`,
  `focus_elements`, `section_box_elements`,
  `open_existing_plan_for_element_level` — all `success=true` on a disposable
  review view.
- Mutating/guarded (3): `create_3d_view_for_elements` (creates),
  `delete_review_view` (dry-run guard, confirmation guard, commit deletes;
  non-review view correctly refused), `send_code_to_revit` (dynamic C# compiled
  and executed: returned `belge=RME_basic_sample_project seviyeSayisi=4`).
- Batch: `execute_batch` atomic commit + guarded rollback.

`get_document_context` served from the application-event cache: median 1.69 ms,
`uiThreadRoundTrip:false`.

## Service lifecycle (P3-T2)

Measured on PETRUCCI: SCM stop 0.29 s, start 0.42 s (< 10 s threshold);
delayed-auto-start; Event Log source writes structured JSON; host/worker logs
rotate on the real `%ProgramData%` path; reboot survival confirmed (service
self-started ~133 s after boot).

## Defects found and fixed by the live run

Seven defects blocked the chain, none catchable by the green suites because the
loopback fixture implements the frozen contracts correctly while the product
did not. #336 (merged): enrollment env-var allow-list, control-connection
dispose race. PR #337: add-in `mcp_status` Appendix A.2 discovery fields,
LocalSystem service account, journal-sidecar ACL, `invoke_batch` dispatch
wiring, `effect_state` outbound-validation violation. Plus the stub harness fix
binding the enrollment-presented fingerprint. Observability added
(`worker.addin_discovery`, `worker.dispatch_trace`) located defects 3-7.

Lesson recorded: a PR ladder tracks what PRs did, not what the system can do —
run an evidence inventory and a real cross-implementation deployment before any
gate report.

## Suite status

Bridge 780/780, gateway-stub 84/84, protocol green. Chain fixes in PR #337;
durability harness in PR #338.

## Explicitly deferred (not M3-blocking)

- RES-30: real-Gateway token exchange, revoked-device refusal at handshake,
  device-token persistence across reboot → **M4 entry criteria**.
- Recorded residual (frozen text, raise at M4): the conflict index knows holds,
  not in-flight uncertainty — a mutation left `executing` by a crash installs
  no hold until redelivery/terminalization.
- `find_elements` silently drops an unmappable `categoryNames` value (guarded
  diagnostics are correct; the MEP-only alias table is by design) — M4 review.
