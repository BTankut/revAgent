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
| DP-1, DP-2, and DP-13 recorded | Operator confirmed .NET 8 self-contained Bridge, WSS primary + Streamable HTTP/SSE fallback, and the proposed monorepo layout on 2026-07-22; recorded in draft PR [#268](https://github.com/BTankut/revAgent/pull/268) | `accepted` | Merge #268 first; implementation/demonstration gates remain separate |
| O1 v0.9 in review | Full RBP/1 draft in PR [#269](https://github.com/BTankut/revAgent/pull/269) | `in_progress` | Complete one review pass; v1.0 freeze is M1 |
| Monorepo scaffold | Gateway/protocol/bridge boundary in PR [#270](https://github.com/BTankut/revAgent/pull/270) | `in_progress` | Review and merge through protected flow |
| CI green, including `gateway-gates` | Both jobs passed in [run 29874789704](https://github.com/BTankut/revAgent/actions/runs/29874789704) for PR [#271](https://github.com/BTankut/revAgent/pull/271) | `passed` | Review and merge through protected flow |
| Existing 35-tool catalog served over Streamable HTTP; latency recorded | External client 35/35; p95 `tools/list` 13.946 ms in PR [#272](https://github.com/BTankut/revAgent/pull/272) | `passed` | Review transport-spike limits; do not treat as production SLA |
| Phase-1 Compose skeleton | Gateway + Postgres 16 + Caddy + filesystem object store in PR [#273](https://github.com/BTankut/revAgent/pull/273) | `in_progress` | Review; DP-5 separately decides whether Keycloak is added |
| GAP-13.1 publish freeze | Release-freeze guard is on `main` via PR [#267](https://github.com/BTankut/revAgent/pull/267) | `passed` | Keep locked; emergency exception remains operator-gated |
| GAP-13.2 updater-abstinence communication | Barış Tankut approved the notice and reported sending it to users through WhatsApp on 2026-07-22; recorded in `docs/plan/GAP13_2_UPDATER_ABSTINENCE_NOTICE.md` | `in_progress` | Record exact group/recipient list, timestamp/message evidence, expected/acknowledged counts, and missing-recipient follow-up; separately verify scheduled tasks exit without changes |
| WP9 designer-client matrix | ChatGPT/Codex Desktop selected by DP-10; hands-on remote-MCP gates remain in draft PR [#275](https://github.com/BTankut/revAgent/pull/275) | `in_progress` | Prove registration, auth, confirm, files, Turkish UX, and live-Revit compatibility; selection alone is not conformance |
| DP-8 host selection and live reachability evidence | BatchMode SSH evidence retained in PR [#268](https://github.com/BTankut/revAgent/pull/268): Ubuntu 26.04 LTS, 8 CPUs, 30 GiB RAM, 204 GiB free root storage, and 870 GiB free data storage; router has no dual-WAN/LTE and Barış Tankut accepted WAN-outage risk on 2026-07-22 | `passed` | M0 reachability is closed. Under R-G, the implementation assistant owns later Docker/Compose and tunnel/origin work; retain power/UPS and production-readiness evidence for M7 |
| DP-3/DP-4 connector and domain staging | `cloudflared` 2026.7.2, matching tunnel credential hash, `gateway.revagent.app` → `http://127.0.0.1:8081` ingress validation, bounded QUIC/HTTP2 proof, Docker Engine 29.6.2/Compose v5.3.1, hash-matched PR #273 artifacts, and configuration validation are retained in `docs/decisions/DP-03-04-cloudflare-staging.md`; zero containers/listeners and connector disabled/inactive | `passed` | After the immutable Gateway image and root-owned environment exist, start the real origin, enable the connector, and retain public `/healthz`, TLS, restart, and reconnect evidence for pilot entry |

M0 remains open until the updated O1 review is accepted and all current-head protected checks are green.
Live Ubuntu-host reachability is retained in #268; DP-1/DP-2/DP-13 are no longer operator-decision blockers.

## Milestones

| Milestone | Outcome and executable exit demonstration | Depends on | Primary owner(s) | State |
|---|---|---|---|---|
| M0 | Decisions + scaffolds; 35-tool HTTP demo; new-package CI green; Ubuntu host reachable | — | WP8 with WP1/WP2/WP5/WP9 | `in_progress` |
| M1 | O1/RBP v1.0 frozen after conformance review of handshake, auth, resume, invoke/batch, journal, streaming, heartbeat, versioning, and faults | M0 | WP1 | `not_started` |
| M2 | North MCP endpoint serves capability index/deferred schemas and dispatches the relocated catalog through executor abstractions | M1 | WP2 | `not_started` |
| M3 | Bridge + pre-pilot add-in adaptations connect, journal redelivery, and demonstrate sequential then capability-gated atomic batch behavior | M1 | WP3 | `not_started` |
| M4 | **Vertical slice:** an external MCP client (WP9 candidate) → Gateway → Bridge → live Revit executes one read and one confirm-class write with audit evidence | M2, M3 | WP1/WP2/WP3/WP5/WP9 | `not_started` |
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
