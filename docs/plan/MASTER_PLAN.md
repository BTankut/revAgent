# revAgent Target-Architecture Migration Master Plan

**Document state:** living migration tracker

**Current milestone:** M1 — in progress

**Phase-0 exit:** passed on 2026-07-22; milestone-owner acceptance is not yet recorded

**Last updated:** 2026-07-23

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

## 2026-07-23 operator lane checkpoint

M1 remains the only active milestone. When its candidate is ready, the
implementation assistant opens the freeze PR as draft, presents the gate demo,
final v0.9→v1.0 diff summary, and complete conformance result, then stops. The
PR is not readied or merged and `rbp/v1.0.0` is not created until the
operator-channel closing review explicitly approves continuation.

The 2026-07-24 pre-lock candidate gate passed `scripts/test-ci.ps1`, the
Windows PowerShell 5.1 `scripts/test-all.ps1` gate, all 11 named protected PS5
installer/updater/security scripts, generated-type clean diff, protocol
303/303, add-in fixture 55/55, Gateway stub 78/78, Bridge simulator 211/211,
three deterministic Bridge runs of 211/211 each, and the complete conformance
harness gate (57 files, 352/352 tests, 5/5 serial shards). These results are
implementation-readiness evidence only. M1 remains `in_progress` until the
documentation-complete candidate produces its authoritative three-run
aggregate, real one-hour soak, retained-artifact validation, and draft PR
checks; the assistant then reports and stops without ready/merge/tag.

After that approval, this assistant is assigned only to WP2/M2 on
`codex/wp2-*`. It may not edit `packages/bridge/**` or
`src/revit-plugin/**`; any `packages/protocol/**` change requires a prior dated
R-F amendment. This is an assistant execution assignment, not an architecture
change: WP3 remains the M3 bridge/add-in/installer owner and a separate
assistant receives that lane.

Draft PR [#288](https://github.com/BTankut/revAgent/pull/288) retains the M2
planning already performed and remains on hold. Its proposed M2 `RES-26`
collides with the authoritative nested-batch `RES-26` on `main`; after M1
approval, WP2 must use a newly numbered dated R-F amendment to reconcile the
proposal before the draft advances. Draft PR
[#289](https://github.com/BTankut/revAgent/pull/289) is the frozen M3 handoff
record; this assistant will not continue, ready, or merge it.

## M0 checkpoint

| Phase-0 exit evidence | Current evidence | State | Next owner/action |
|---|---|---|---|
| DP-1, DP-2, and DP-13 recorded | Operator confirmed .NET 8 self-contained Bridge, WSS primary + Streamable HTTP/SSE fallback, and the proposed monorepo layout on 2026-07-22; the record merged through [#268](https://github.com/BTankut/revAgent/pull/268) | `accepted` | Carry the decisions forward without reopening them; implementation/demonstration gates remain separate |
| O1 v0.9 review baseline | The full RBP/1 draft and W1 closure corrections merged through [#269](https://github.com/BTankut/revAgent/pull/269) after the operator-authorized closure review | `passed` | M1 owns semantic/schema hardening, executable T2-T6 conformance, and the conditional v1.0 freeze |
| Monorepo scaffold | The Gateway/protocol/bridge boundary merged through [#270](https://github.com/BTankut/revAgent/pull/270); root overrides and generated clean-diff enforcement are present | `passed` | Keep legacy/frozen paths outside ordinary migration PRs |
| CI green, including `gateway-gates` | PR [#271](https://github.com/BTankut/revAgent/pull/271) merged the additive jobs; Engineering and Gateway jobs passed for exact `main` commit `fdedd61` in [run 29929124082](https://github.com/BTankut/revAgent/actions/runs/29929124082) | `passed` | Keep both jobs green through M1; a legacy-suite regression is a freeze-violation signal |
| Existing 35-tool catalog served over Streamable HTTP; latency recorded | External client 35/35; p95 `tools/list` 13.946 ms in PR [#272](https://github.com/BTankut/revAgent/pull/272) | `passed` | Review transport-spike limits; do not treat as production SLA |
| Phase-1 Compose skeleton | Gateway + Postgres 16 + Caddy + filesystem object store merged through [#273](https://github.com/BTankut/revAgent/pull/273); hash-matched artifacts and `docker compose config --quiet` host proof are retained through [#274](https://github.com/BTankut/revAgent/pull/274) | `passed` | DP-5 separately decides whether Keycloak is added; no origin container or connector service is started yet |
| GAP-13.1 publish freeze | Release-freeze guard is on `main` via PR [#267](https://github.com/BTankut/revAgent/pull/267) | `passed` | Keep locked; emergency exception remains operator-gated |
| GAP-13.2 updater-abstinence communication | Barış Tankut approved the notice and reported sending it to users through WhatsApp on 2026-07-22; recorded in `docs/plan/GAP13_2_UPDATER_ABSTINENCE_NOTICE.md` | `in_progress` | Record exact group/recipient list, timestamp/message evidence, expected/acknowledged counts, and missing-recipient follow-up; separately verify scheduled tasks exit without changes |
| WP9 designer-client matrix | ChatGPT/Codex Desktop selected by DP-10; the M0 comparison matrix merged through [#275](https://github.com/BTankut/revAgent/pull/275) | `passed` | Prove registration, auth, confirm, files, Turkish UX, and live-Revit compatibility in the separate DP-10 hands-on gate; selection alone is not conformance |
| DP-8 host selection and live reachability evidence | BatchMode SSH evidence retained in PR [#268](https://github.com/BTankut/revAgent/pull/268): Ubuntu 26.04 LTS, 8 CPUs, 30 GiB RAM, 204 GiB free root storage, and 870 GiB free data storage; router has no dual-WAN/LTE and Barış Tankut accepted WAN-outage risk on 2026-07-22 | `passed` | M0 reachability is closed. Under R-G, the implementation assistant owns later Docker/Compose and tunnel/origin work; retain power/UPS and production-readiness evidence for M7 |
| DP-3/DP-4 connector and domain staging | `cloudflared` 2026.7.2, matching tunnel credential hash, `gateway.revagent.app` → `http://127.0.0.1:8081` ingress validation, bounded QUIC/HTTP2 proof, Docker Engine 29.6.2/Compose v5.3.1, hash-matched PR #273 artifacts, and configuration validation are retained in `docs/decisions/DP-03-04-cloudflare-staging.md`; zero containers/listeners and connector disabled/inactive | `passed` | After the immutable Gateway image and root-owned environment exist, start the real origin, enable the connector, and retain public `/healthz`, TLS, restart, and reconnect evidence for pilot entry |
| DP-12 NET01 live readiness | Public-key SSH, Windows/resources, Revit 2022, Codex AppX, revAgent stable, and protected bootstrap evidence retained in `docs/decisions/DP-12-NET01-readiness-2026-07-22.md`; stale updater launcher lacks `-AuditOnly` and last task result is `1` | `in_progress` | Technical team neutralizes or repairs the updater through the controlled pilot path without bypassing the release freeze; operator names pilot user, dates, fallback, and communications owner |

The core M0 exit defined by the Week-1 objective is evidenced by merged PRs #268-#275: the decisions are
recorded, O1 v0.9 completed its closure review, the monorepo and Compose scaffolds exist, the 35-tool HTTP
spike passed, and the new-package CI is present. PR #276 adds live NET01 evidence. Exact-main run
29929124082 completed green, so M0 is `passed`; only the milestone decision owner may promote it to
`accepted`.

GAP-13.2's exact WhatsApp distribution/acknowledgement proof and scheduled-task neutrality, DP-12 updater
neutralization and named pilot roles/window, WP9 hands-on conformance, and active-origin/tunnel proof are
pilot-entry carry-forwards. They remain open and are not silently converted into M0 completion evidence.

## Milestones

| Milestone | Outcome and executable exit demonstration | Depends on | Primary owner(s) | State |
|---|---|---|---|---|
| M0 | Decisions + scaffolds; 35-tool HTTP demo; new-package CI green; Ubuntu host reachable | — | WP8 with WP1/WP2/WP5/WP9 | `passed` |
| M1 | O1/RBP v1.0 frozen after conformance review of handshake, auth, resume, invoke/batch, journal, streaming, heartbeat, versioning, and faults | M0 | WP1 | `in_progress` |
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
