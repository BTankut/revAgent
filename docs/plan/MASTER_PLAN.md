# revAgent Target-Architecture Migration Master Plan

**Document state:** living M0 skeleton

**Current milestone:** M0 — in progress

**Phase-0 exit:** not met

**Last updated:** 2026-07-22

This file is the operational milestone tracker for the migration described by `docs/TARGET_ARCHITECTURE.md` and `docs/implementation-plan/00-INDEX.md`. The index and its RES-* amendments are authoritative when package documents disagree. A draft PR or written artifact is evidence, but it does not close a demo gate by itself.

## Status vocabulary

| State | Meaning |
|---|---|
| `not_started` | No accepted evidence yet |
| `in_progress` | Work or review is active |
| `blocked_operator` | A named operator decision/action is required |
| `blocked_external` | An external system or dependency prevents the gate |
| `passed` | The executable gate passed and evidence is linked |
| `accepted` | The decision owner accepted the gate |

Only the milestone decision owner may move a gate from `passed` to `accepted`. M0–M10 remain open until every required row is accepted.

## M0 checkpoint

| Phase-0 exit evidence | Current evidence | State | Next owner/action |
|---|---|---|---|
| DP-1, DP-2, and DP-13 recorded | Decision pack and pending outcomes in draft PR [#268](https://github.com/BTankut/revAgent/pull/268) | `blocked_operator` | Operator records explicit choices and dates |
| O1 v0.9 in review | Full RBP/1 draft in PR [#269](https://github.com/BTankut/revAgent/pull/269) | `in_progress` | Complete one review pass; v1.0 freeze is M1 |
| Monorepo scaffold | Gateway/protocol/bridge boundary in PR [#270](https://github.com/BTankut/revAgent/pull/270) | `in_progress` | Review and merge through protected flow |
| CI green, including `gateway-gates` | Both jobs passed in [run 29874789704](https://github.com/BTankut/revAgent/actions/runs/29874789704) for PR [#271](https://github.com/BTankut/revAgent/pull/271) | `passed` | Review and merge through protected flow |
| Existing 35-tool catalog served over Streamable HTTP; latency recorded | External client 35/35; p95 `tools/list` 13.946 ms in PR [#272](https://github.com/BTankut/revAgent/pull/272) | `passed` | Review transport-spike limits; do not treat as production SLA |
| Phase-1 Compose skeleton | Gateway + Postgres 16 + Caddy + filesystem object store in PR [#273](https://github.com/BTankut/revAgent/pull/273) | `in_progress` | Review; DP-5 separately decides whether Keycloak is added |
| GAP-13.1 publish freeze | Release-freeze guard is on `main` via PR [#267](https://github.com/BTankut/revAgent/pull/267) | `passed` | Keep locked; emergency exception remains operator-gated |
| GAP-13.2 updater-abstinence communication | Draft in `docs/plan/COMMS_ANNOUNCEMENT_DRAFT.md` | `in_progress` | Approve, send to every fleet user, record acknowledgements; verify scheduled tasks are no-ops |
| WP9 designer-client matrix | Separate Week-1 artifact required | `not_started` | WP9 evaluates real clients, including confirm and file workflows |
| DP-8 Ubuntu host ready/reachable | Operator-confirmed dedicated host: `bt@192.168.90.154`, ED25519 key-only SSH, password and keyboard-interactive disabled; recorded in PR [#268](https://github.com/BTankut/revAgent/pull/268) | `accepted` | W1-7 retains operational reachability evidence and remaining host/tunnel actions; do not re-provision |

M0 must not be marked accepted while DP-1/DP-2/DP-13 remain unresolved.

## Milestones

| Milestone | Outcome and executable exit demonstration | Depends on | Primary owner(s) | State |
|---|---|---|---|---|
| M0 | Decisions + scaffolds; 35-tool HTTP demo; new-package CI green; Ubuntu host reachable | — | WP8 with WP1/WP2/WP5/WP9 | `in_progress` |
| M1 | O1/RBP v1.0 frozen after conformance review of handshake, auth, resume, invoke/batch, journal, streaming, heartbeat, versioning, and faults | M0 | WP1 | `not_started` |
| M2 | North MCP endpoint serves capability index/deferred schemas and dispatches the relocated catalog through executor abstractions | M1 | WP2 | `not_started` |
| M3 | Bridge + pre-pilot add-in adaptations connect, journal redelivery, and demonstrate sequential then capability-gated atomic batch behavior | M1 | WP3 | `not_started` |
| M4 | Chosen WP9 client → Gateway → Bridge → live Revit executes one read and one confirm-class write with audit evidence | M2, M3 | WP1/WP2/WP3/WP5/WP9 | `not_started` |
| M5 | OIDC, device enrollment, seats, tenant isolation, audit, event schema, and Postgres migrations pass two-tenant tests | M2 | WP4 | `not_started` |
| M6 | Installer/uninstaller and signed bridge/add-in self-update lane pass lab install, update, crash-loop rollback, and signature checks | M3, M5 | WP3 with WP5 conventions | `not_started` |
| M7 | Production Compose/tunnel, warm standby, blank-VM O10 restore drill, and O11 metric-parity gate pass with measured evidence | M4, M5 | WP5/WP7 | `not_started` |
| M8 | Pilot uses the same client/add-in stack intended for cutover for at least five real working days; forced failures and one signed update pass | M4, M6, M7 | WP8/WP9 with pilot user | `not_started` |
| M9 | Rehearsed runbook, signed rollback criterion, retraining, and per-machine read/confirm-write smoke complete for the entire fleet | M8 | WP8 with WP3/WP5/WP9 | `not_started` |
| M10 | Two-week insurance window closes, NAS archive/retire checklist passes, residual trust anchors are removed, and freeze is formally lifted | M9 | WP8/WP5/WP7 | `not_started` |

## Work-package map

This Week-1 skeleton maps package lanes to milestone ranges. P8-T2 must expand it to task-level rows before M1 is accepted.

| Work package | Milestone lane |
|---|---|
| WP1 — O1 protocol | M0 draft → M1 freeze → M4 conformance |
| WP2 — Gateway/tool registry/north MCP | M0 scaffold/spike → M2 minimal loop → M4/M5 hardening |
| WP3 — Bridge/add-in/installer/O9 | M3 bridge + pre-pilot adaptations → M6 installer/self-update → M8/M9 support |
| WP4 — Data/auth/licensing/events | M5 implementation → M7 restore/parity inputs |
| WP5 — Phase-1 infra/CD/O10 | M0 Compose → M4 host slice → M7 ops readiness → M9/M10 infra checks |
| WP6 — APS seams/Phase 2 | Binding seam review before WP4 schema freeze; APS runtime after M10 |
| WP7 — Admin plane/O11 | M5 event-field handoff → M7 metric parity → M10 retirement evidence |
| WP8 — sequencing/freeze/runbooks/comms | Every gate; owns cutover and rollback decision artifacts |
| WP9 — designer client/O8 delivery | M0 matrix → M4 conformance → M8 real-work pilot → M9 fleet client smoke |

## Weekly update ritual

1. Update evidence links, owner, and state; never infer `accepted` from a merged PR.
2. Review critical path M0 → M1 → M2/M3 → M4 → M6 → M8 → M9 → M10.
3. Review the risk register and GAP-13 interim controls while the old fleet remains active.
4. Record any changed DP or RES-* premise as a dated amendment in `docs/decisions/DP-log.md`; do not silently diverge.
5. Keep the NAS publish freeze and migration feature freeze distinct. An exception to either requires its own logged operator approval.

## Permanent gates

- The old path remains restorable until the new path has carried real traffic through M8 and the two-week insurance window closes.
- No mixed-estate rollback: if the signed criterion fires, restore the entire fleet.
- The pilot must run the same WP9 client and adapted add-in stack that M9 ships.
- No milestone closes on documentation alone; retain command output, CI run, rehearsal, or live-demo evidence.
- Merge, deployment, NAS publication, and operator workstation actions remain separately authorized operations.
