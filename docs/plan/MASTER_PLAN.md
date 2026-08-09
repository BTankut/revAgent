# revAgent Target-Architecture Migration Master Plan

**Document state:** living migration tracker

**Current milestone:** M2 — implementation in progress; GW-1 [#342], GW-2
[#344], GW-3 [#345], and the coordinator north integration slice [#355] are
merged; #355 landed as `dd6c579c89dc8cf0d11a20763d81382231774849`

**Phase-0 exit:** passed on 2026-07-22; milestone-owner acceptance is not yet recorded

**Last updated:** 2026-08-09

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

## 2026-08-09 M2 delivery checkpoint

GW-1 through GW-3 and the coordinator north integration slice are on `main`,
alongside earlier M2 groundwork including the first north skeleton proof in
[#291]. Their merge state is delivery evidence, not an M2 gate decision: M2
remains `in_progress` until its remaining acceptance criteria and executable
exit demonstration are green.

| Slice | Delivered evidence | GitHub state | Remaining milestone impact |
|---|---|---|---|
| GW-1 | Registry/executor collection and immutable legacy-handler packaging behind `ExecutorPort` | [#342](https://github.com/BTankut/revAgent/pull/342) merged | Inputs to the production north/dispatch composition; does not close M2 alone |
| GW-2 | Gateway service shell, frozen ports, deterministic auth seam, and non-executable Mode-B stubs | [#344](https://github.com/BTankut/revAgent/pull/344) merged | Service shell still requires the coordinator north-endpoint composition |
| GW-3 | E5 executor/policy map, entitled registry view, and byte-stable capability index | [#345](https://github.com/BTankut/revAgent/pull/345) merged | Registry/index output still requires the coordinator north-endpoint composition and one executor-dispatched tool proof |
| Coordinator north vertical slice | Bind the GW-3 entitled capability index to the dual-era north skeleton and its one executor-dispatched tool | [#355](https://github.com/BTankut/revAgent/pull/355) merged as [`dd6c579c89dc8cf0d11a20763d81382231774849`](https://github.com/BTankut/revAgent/commit/dd6c579c89dc8cf0d11a20763d81382231774849) | Integration evidence is on `main`; it does not redefine the already merged §8.3.5 first proof or complete GW-10/M2 |

## 2026-08-02 M3 gate evidence — awaiting operator acceptance

The M3 bridge + add-in chain was proven end to end on a clean Windows 11
workstation (PETRUCCI, Revit 2022): an external control caller drove
Gateway → Bridge (the real `revAgentBridge` Windows service, LocalSystem) →
add-in → live Revit for `dispatch_invoke` (real model data) and a
capability-gated atomic `invoke_batch` (terminal batch carrier, session window
released). All 23 add-in commands, service lifecycle (P3-T2), bridge-side
enrollment (RES-30 stub-proven), the idempotency journal, and
batch-as-transaction-group are recorded in
`docs/plan/M3_BRIDGE_GATE_EVIDENCE.md` with a retained live-evidence bundle.

Seven defects that blocked the chain — none catchable by the green suites,
because the loopback fixture implements the frozen contracts while the product
did not — were fixed across #336 and PR #337 (add-in `mcp_status` discovery
fields under a migration-freeze exception, LocalSystem service account,
journal-sidecar ACL, `invoke_batch` dispatch wiring, `effect_state` outbound
validation), with the durability harness in PR #338. Per R-C and the tracker
rule, the M3 row is set to `passed`; only the milestone decision owner may move
it to `accepted`. Deferred to M4 per RES-30: real-Gateway token exchange,
revoked-device refusal at handshake, and device-token persistence across reboot.

## 2026-07-25 M1 closing and operator lane checkpoint

Barış Tankut recorded `M1 KAPANIŞ: ONAY`, identified himself as add-in
implementation owner, and accepted the batchable-command restrictions and
atomic rollback evidence. PR #290 may become ready and, after the protected
required checks are green, squash merge to `main`. Inclusion of the accepted
candidate through that protected merge freezes RBP/1 and closes M1.

The 2026-07-24 pre-lock candidate gate passed `scripts/test-ci.ps1`, the
Windows PowerShell 5.1 `scripts/test-all.ps1` gate, all 11 named protected PS5
installer/updater/security scripts, generated-type clean diff, protocol
303/303, add-in fixture 55/55, Gateway stub 78/78, Bridge simulator 214/214,
three deterministic Bridge runs of 211/211 each, and the complete conformance
harness gate (60 files, 373/373 tests, 5/5 serial shards). These results are
supplemented by one complete green current-candidate PR suite, the retained M1
gate report, and the 2026-07-25 owner acceptance. The exact final PR head must
remain green and tree-equal through protected merge.

`rbp/v1.0.0` MUST NOT be created by the M1 merge. Under RES-28, the retained
three-run aggregate, real one-hour soak, WSS/Streamable HTTP/SSE
proxy-interoperability evidence, and tag identity form a separate,
non-blocking closure that may run in parallel with M2/M3. It does not block
their start. The evidence ceiling in R-H prohibits adding or promoting
assistant-created evidence requirements. Per RES-34, the evidence anchor is
the protected main commit on which that complete evidence set is actually
produced green; its full commit/tree identity requires operator confirmation
before a run is counted. As an acceptance predicate of the retained-three-run
aggregate class — not a fifth RES-28 evidence class — a mechanically separate
full-Vitest qualification parses all five shard summaries and asserts 60
files, 373/373 tests, and 5/5 serial shards rather than trusting exit code
zero. RES-34 retains the protected-main pre-tag calibration that independently
enumerated 60 tracked test files and measured 373/373 tests across 5/5 shards;
it is not counted tag evidence or anchor selection. Neither this record nor
RES-34 authorizes tag-evidence execution or creation of `rbp/v1.0.0`.

After the M1 closeout, this assistant is assigned only to WP2/M2 on
`codex/wp2-*`. It may not edit `packages/bridge/**` or
`src/revit-plugin/**`; any `packages/protocol/**` change requires a prior dated
R-F amendment. This is an assistant execution assignment, not an architecture
change: WP3 remains the M3 bridge/add-in/installer owner and a separate
assistant receives that lane. Neither M2 nor M3 starts from this closing
approval; each requires a separate authorized kickoff. The current assistant
stops after PR #290 merge and closeout reporting.

Draft PR [#288](https://github.com/BTankut/revAgent/pull/288) carries the
authorized M2 planning alignment. Its former `RES-26` collision with the
authoritative nested-batch resolution is closed as dated `RES-29`, which keeps
the external-client loop boundary while retaining capability-index/deferred
schema discovery and Mode-B interface stubs in M2. Draft PR
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

> **Binding estimate/pacing rule:** `Xd` değerleri başlangıç efor/risk tahminidir; minimum takvim süresi veya pacing talimatı değildir. Bağımlılıklar sağlanmış, acceptance kriterleri ve gerekli evidence yeşilse görev derhal tamamlanır. Asistan tahmini tüketmek için beklemez, işi uzatmaz, yapay biçimde bölmez; gerçek süreyi kaydeder ve kalan işi yeniden tahmin eder. Yalnız açıkça 'minimum elapsed' yazan pilot/soak/insurance kapıları takvim süresidir.

`Planning effort forecast` values come from the current package plan. `Variance`
is actual effort minus forecast; it remains `not calculable` until actual effort
is recorded. Calendar-gated pilot/soak/insurance elapsed time is tracked
separately from engineering effort.

| Milestone | Outcome and executable exit demonstration | Depends on | Primary owner(s) | Planning effort forecast | Actual effort | Variance | State |
|---|---|---|---|---|---|---|---|
| M0 | Decisions + scaffolds; 35-tool HTTP demo; new-package CI green; Ubuntu host reachable | — | WP8 with WP1/WP2/WP5/WP9 | 5d | not recorded | not calculable | `passed` |
| M1 | O1/RBP v1.0 frozen after conformance review of handshake, auth, resume, invoke/batch, journal, streaming, heartbeat, versioning, and faults; protected merge of PR #290 is the recorded mechanical close and `rbp/v1.0.0` remains a separate non-blocking closure under RES-28 | M0 | WP1 | 3d | not recorded | not calculable | `accepted` |
| M2 | External-client Gateway core serves a capability index and deferred schemas through `tool_search`/`tool_schema`, exposes a small pinned callable set over north MCP, loads immutable hash-bound runtime/docs handlers without frozen-source relocation, and proves registry/policy/confirmation plus bridge/internal executor dispatch and production RBP ingress; Mode B remains interface stubs only | M1 | WP2 with WP5 P5-T4 and WP6 P6-T1 | 38d | in progress; not recorded | not calculable | `in_progress` |
| M3 | Bridge + pre-pilot add-in adaptations connect, journal redelivery, and demonstrate sequential then capability-gated atomic batch behavior | M1 | WP3 | 15d | not recorded | not calculable | `passed` |
| M4 | **Pre-production-auth vertical slice:** an external MCP client (WP9 candidate) → Gateway → Bridge → live Revit executes one read and one confirm-class write with originating-preview/approval/commit audit evidence; this slice does not pass DP-10 OAuth or hands-on conformance | M2, M3 | WP1/WP2/WP3/WP5/WP9 | 5d | not recorded | not calculable | `not_started` |
| M5 | OIDC, device enrollment, seats, tenant isolation, audit, event schema, and Postgres migrations pass two-tenant tests | M2 | WP4 | 8d | not recorded | not calculable | `not_started` |
| M6 | Installer/uninstaller and signed bridge/add-in self-update lane pass lab install, update, crash-loop rollback, and signature checks | M3, M5 | WP3 with WP5 conventions | 12d | not recorded | not calculable | `not_started` |
| M7 | Production Compose/tunnel, warm standby, blank-VM O10 restore drill, and O11 metric-parity gate pass with measured evidence | M4, M5 | WP5/WP7 | 6d | not recorded | not calculable | `not_started` |
| M8 | Pilot uses the same client/add-in stack intended for cutover for at least five real working days; forced failures and one signed update pass | M4, M6, M7 | WP8/WP9 with pilot user | 8d | not recorded | not calculable | `not_started` |
| M9 | Rehearsed runbook, signed rollback criterion, retraining, and per-machine read/confirm-write smoke complete for the entire fleet | M8 | WP8 with WP3/WP5/WP9 | 5d | not recorded | not calculable | `not_started` |
| M10 | Two-week insurance window closes, NAS archive/retire checklist passes, residual trust anchors are removed, and freeze is formally lifted | M9 | WP8/WP5/WP7 | 3d | not recorded | not calculable | `not_started` |

RES-29 applies RES-23 to the operational tracker: M2/M4 exercise D9's permitted external-client path and do
not implement the in-house agentic loop, Gateway LLM provider, prompt/context engine, or frozen-source
relocation. M2 does retain the registry-driven capability-index/deferred-schema surface and Mode-B interface
stubs. M4 deliberately uses a deterministic/pre-production identity seam because M5 owns real OIDC, device
enrollment, seats, and two-tenant negatives. The long-term D1-D12 architecture remains unchanged.

## Work-package map

This Week-1 skeleton maps package lanes to milestone ranges. RES-28 and the
2026-07-25 owner acceptance supersede P8-T2's former M1-blocking
classification; task-level schedule expansion remains open planning
maintenance and is not additional M1 gate evidence.

| Work package | Milestone lane |
|---|---|
| WP1 — O1 protocol | M0 draft → M1 freeze → M4 conformance |
| WP2 — Gateway/tool registry/north MCP | M0 scaffold/spike → M2 external-client north MCP/registry/policy/dispatch/RBP + packaged handlers → M4 pre-production slice → M5 production-auth integration |
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
