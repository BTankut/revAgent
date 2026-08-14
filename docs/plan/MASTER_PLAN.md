# revAgent Target-Architecture Migration Master Plan

**Document state:** living migration tracker

**Current milestone state:** M2 and M3 were accepted by the milestone owner on
2026-08-11. M4 is `in_progress` under its separately planner-approved slices;
its evidence remains `not_submitted`, and no milestone acceptance is recorded.
The exact M2 code/evidence anchor remains
`011b17b0095e5190a4347fca81160cbb9138eae0`; the current protected M4 source
anchor is `239de8d3826f25a12f858374f495d5ecfbd67e02` on `main`.

**Phase-0 exit:** passed on 2026-07-22; milestone-owner acceptance is not yet recorded

**Last updated:** 2026-08-14

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

## 2026-08-10 M2 closing checkpoint — accepted 2026-08-11

The complete M2 code chain is on `main`: GW-1, GW-2, GW-3, GW-4, GW-8,
GW-9, GW-10, GW-12, GW-13, GW-16, GW-19, and GW-20. The coordinator's
original negative deviation — north endpoint + capability index + executor
dispatch not yet whole — closed when GW-10 merged in #359. The final exact-main
evidence anchor is
[`011b17b0095e5190a4347fca81160cbb9138eae0`](https://github.com/BTankut/revAgent/commit/011b17b0095e5190a4347fca81160cbb9138eae0).
The acceptance mapping and evidence ceilings are recorded in
[`M2_GATE_EVIDENCE.md`](M2_GATE_EVIDENCE.md). The milestone owner recorded
`M2 accepted` on 2026-08-11; that decision does not enlarge the evidence or
erase the ceilings recorded there.

| Slice | Planning effort forecast | Actual effort | Variance | PR / merge evidence |
|---|---:|---:|---:|---|
| GW-1 | 3d | not recorded | not calculable | [#342](https://github.com/BTankut/revAgent/pull/342) / [`99057ff4`](https://github.com/BTankut/revAgent/commit/99057ff49172e4fc561ccfc03407d05cc5ff6ea1) |
| GW-2 | 2d | not recorded | not calculable | [#344](https://github.com/BTankut/revAgent/pull/344) / [`42938b01`](https://github.com/BTankut/revAgent/commit/42938b019c3d075c939034fe94431eb12884abaa) |
| GW-3 | 5d | not recorded | not calculable | [#345](https://github.com/BTankut/revAgent/pull/345) / [`3052283a`](https://github.com/BTankut/revAgent/commit/3052283a7b8dfce9cf82278457cd36355c220895) |
| GW-3 north integration | not recorded | not recorded | not calculable | [#355](https://github.com/BTankut/revAgent/pull/355) / [`dd6c579c`](https://github.com/BTankut/revAgent/commit/dd6c579c89dc8cf0d11a20763d81382231774849) |
| GW-4 invocation authority | 5.00h | 1h33m | -3h27m | [#356](https://github.com/BTankut/revAgent/pull/356) / [`d4487e72`](https://github.com/BTankut/revAgent/commit/d4487e72e5fc82ad6d3a1c4b380b3ef649d983af) |
| GW-4 durable recovery | 8.00h | 3h28m | -4h32m | [#357](https://github.com/BTankut/revAgent/pull/357) / [`79674256`](https://github.com/BTankut/revAgent/commit/79674256f8853545615d4e4b237d09c10ad74a9c) |
| GW-8 | 8.00h | 1h29m | -6h31m | [#358](https://github.com/BTankut/revAgent/pull/358) / [`92a199e6`](https://github.com/BTankut/revAgent/commit/92a199e6ff58667698ab154cd27c5b08b19c1963) |
| GW-10 | 4.00h | 1.70h | -2.30h (-58%) | [#359](https://github.com/BTankut/revAgent/pull/359) / [`dd405ab3`](https://github.com/BTankut/revAgent/commit/dd405ab3461117b034689c578197532592b18710) |
| GW-9 | 4.00h | 1.00h | -3.00h (-75%) | [#360](https://github.com/BTankut/revAgent/pull/360) / [`32e84395`](https://github.com/BTankut/revAgent/commit/32e843951256270162d05b9810496e54dd988eb5) |
| GW-12 | 6.00h | 1.30h | -4.70h (-79%) | [#361](https://github.com/BTankut/revAgent/pull/361) / [`b9a2152b`](https://github.com/BTankut/revAgent/commit/b9a2152b0244a3ff1b1d461eefa76417a1d26434) |
| GW-13 | 3.00h | 0.35h | -2.65h (-88%) | [#362](https://github.com/BTankut/revAgent/pull/362) / [`71baa71d`](https://github.com/BTankut/revAgent/commit/71baa71db771ad08d768dba7e380f2749e526966) |
| GW-16 | 1.50h | 0.30h | -1.20h (-80%) | [#363](https://github.com/BTankut/revAgent/pull/363) / [`05eb44e3`](https://github.com/BTankut/revAgent/commit/05eb44e342144bb3ade96438896c4d785e6b8f7b) |
| GW-19 | 0.75h | 0.30h | -0.45h (-60%) | [#364](https://github.com/BTankut/revAgent/pull/364) / [`3b1d881d`](https://github.com/BTankut/revAgent/commit/3b1d881d46a937c0b97062ac4fa659786c227689) |
| GW-20 | 0.50h | 0.15h | -0.35h (-70%) | [#365](https://github.com/BTankut/revAgent/pull/365) / [`011b17b0`](https://github.com/BTankut/revAgent/commit/011b17b0095e5190a4347fca81160cbb9138eae0) |

For the ten slices whose execution effort was recorded (#356–#365), the
aggregate is 40.75h forecast, 11.60h actual, and -29.15h variance (-72%).
GW-1, GW-2, GW-3, and the coordinator north integration predate the enforced
actual-effort ledger; their missing actuals are left explicit rather than
reconstructed from PR wall-clock time.

## 2026-08-02 M3 gate evidence — accepted 2026-08-11

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
validation), with the durability harness in PR #338. The milestone owner
recorded `M3 accepted` on 2026-08-11. Deferred to M4 per RES-30: real-Gateway
token exchange, revoked-device refusal at handshake, and device-token
persistence across reboot.

Effort-field provenance correction (2026-08-11): the M3 row retains
`15d / not recorded / not calculable`. The operator designated those values as
"operatörün staged kaydından taşındı"; the subsequent A2 blob reconciliation
verified that the same three values were already present on `main`, so this
record preserves them and reconstructs no actual effort.

Operator branch disposition (2026-08-11): **DROP** local-only commit
`1603800e7fafffdca433ced5ce113ffd915a7123`; do not merge it. The SHA is not
origin-resolvable, so no remote commit link is claimed. Its stable patch is
identical to
[`05792273`](https://github.com/BTankut/revAgent/commit/0579227372387279c13d103146506fab984b5a96)
in [#327](https://github.com/BTankut/revAgent/pull/327), whose protected squash
[`1a88fb11`](https://github.com/BTankut/revAgent/commit/1a88fb1153ae006cdced1243c84ab85dbacb08df)
is on `main`. The old branch snapshot predates the later fail-closed ordinary
invocation conflict gate and deterministic verification-hold IDs in
[#334](https://github.com/BTankut/revAgent/pull/334) and
[#333](https://github.com/BTankut/revAgent/pull/333), so merging that snapshot
would risk a security regression. Branch deletion is a separate action and was
not performed.

## 2026-08-13 DP-12 workstation authority correction (DOCS-01)

The operator placed `NET01` outside the current program and corrected the
DP-12/M4 live Revit workstation to `PETRUCCI`. The accepted M3 chain already
proves PETRUCCI, Revit 2022, the real `revAgentBridge`, the installed add-in,
and a live model against the M3 Gateway stub. The retained authority is
`docs/plan/M3_BRIDGE_GATE_EVIDENCE.md`.

A 2026-08-13 read-only refresh from `DESKTOP-OKNV128` verified strict
public-key SSH to `ws2@192.168.90.122`, the protected-main-matching add-in,
Running/Auto/LocalSystem Bridge service, installed Codex Desktop, and the M3
sample-model candidate. The Bridge still points to
`wss://localhost:8443/bridge/v1`, and retained enrollment is stub-only. Exact
non-secret evidence and the no-mutation ceiling are recorded in
`docs/decisions/DP-12-PETRUCCI-readiness-2026-08-13.md`.

M4-04 fixes two endpoints: `revagent` Gateway (`192.168.90.154`) and
`PETRUCCI` Bridge/add-in/live Revit (`192.168.90.122`). WP9 client placement
remains operator-gated: PETRUCCI has Codex Desktop installed without a proven
active client session, while DESKTOP-OKNV128 is the evidence coordinator but
is not selected as the M4-04 client by this record. DOCS-01 opens no live gate.
`NETWORK/ACL`, `DNS/TLS-TRUST`, `BRIDGE-STAGE`, `CREDENTIAL/ENROLL`, and
`CLIENT/LIVE` remain separate operator decisions. NET01's 2026-07-22
readiness snapshot is retained only as superseded history. The code-pinned
DESKTOP-OKNV128/NET01 signed-CD cohort is a legacy delivery-channel identity,
not the current DP-12/M4 workstation assignment.

## 2026-08-13 M4-04 client and DNS/TLS binding (M4-04/A)

After the DOCS-01 discovery record, the operator resolved the remaining WP9
placement choice: Gateway is `revagent`, while the WP9 client, Bridge, add-in,
and live Revit are all on `PETRUCCI`. `DESKTOP-OKNV128` remains an evidence
coordinator and is not an M4 client. This placement does not establish an
active client session, a current Revit document, or live-path evidence.

The existing naming and connector authority is explicit. The canonical
production origin remains `gateway.revagent.app` under
[`DP-04`](../decisions/DP-04-domain.md), and the existing production tunnel plus
its stopped-state evidence remains recorded in
[`DP-03/DP-04`](../decisions/DP-03-04-cloudflare-staging.md). M4 does not use the
production name and does not start that connector.

The bound M4 approach is a separate same-zone test FQDN, with a DNS-only private
`A` record to `192.168.90.154` and a publicly trusted certificate to be
obtained by DNS-01. The name may resolve publicly, but its private target is not
publicly routable. The exact test label remains a candidate until its own
`DNS/TLS-TRUST` operator card binds it. The Cloudflare token is also separately
gated: it must be supplied out of band, limited to DNS edit for the relevant
zone, absent from git, PRs, CI, logs, and evidence, and given an explicit
post-use disposition. Failure under that narrow authority stops the operation
for operator/planner disposition; it does not authorize broader credentials or
an implicit local-trust fallback.

Pre-production's in-image listener bind and the later host publish are kept
separate: the process requires explicit `GATEWAY_BIND_HOST=0.0.0.0` because the
host LAN address does not exist in the container namespace, while the closed
`NETWORK/ACL` gate must bind Docker's host publish specifically to
`192.168.90.154`. Omitted or loopback pre-production process binds fail closed;
this repo-only seam starts neither surface.

M4-04/A is only the repo engineering seam. Its seven M4-04/B records/gates are
kept distinct: `CLIENT-PLACEMENT/FEASIBILITY`, `NETWORK/ACL`,
`DNS/TLS-TRUST`, `BRIDGE-STAGE`, `CREDENTIAL/ENROLL`, `CLIENT/LIVE`, and
`CLEANUP/RESIDUE-EQUALITY`. The placement choice is now bound to PETRUCCI, but
its active-session feasibility proof and the other six execution gates remain
open; none is executed by A. `M4-WRITE-CONFIRM` remains a later separate gate.
M4 stays `in_progress` / `not_submitted`; RES-30 remains open and the one-item
Park List is unchanged.

## 2026-08-14 M4-04 client-bearer route binding (M4-04/A4)

After the A3 value-free refusal observer merged in `PR #377` as
`50e6cd9d0028bd480a378fd1201859fbdcbc13f3`, the planner bound Route 1 for the
missing WP9 bearer sink: a CurrentUser-DPAPI numeric-loopback broker on
PETRUCCI. The repo-only A4 slice may add the protected store, exact caller
attestation, bounded local Streamable HTTP proxy, explicit A2 north-destination
disposition, and a Codex registration containing only the numeric-loopback URL.
The repo-only implementation closed in `PR #378`: focused
broker, coordinator, and Codex registration/security suites are green; both
canonical local gates passed on the final common tree (`test-all` exit `0`,
`777.50s`; `test-ci` exit `0`, `780.97s`); and the root lockfile remains byte-
identical. Forecast was `5.50h`; actual active effort was `1.75h`, variance
`-3.75h` (`-68%`). The first implementation head's protected Engineering job
failed deterministically on its in-diff PowerShell 7 fixture compiler and
exposed a missing destination abort-grace wiring; both defects are corrected
locally without a same-head rerun. Its Gateway and separate Gateway CI jobs
passed. Final PR head `17e8375d5683cdccb2f3c21cd2ed0c6140a0a197` passed
[CI 31781722442, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31781722442/attempts/1),
[Gateway CI 31781722487, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31781722487/attempts/1), and
[Claude review 31789332568, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31789332568/attempts/1),
without rerun. It squash-merged as the current protected source above;
merge-push CI and the expected installer-triggered Signed Source-Free CD both
passed, with NAS publish skipped.

The authorization ceiling is unchanged. A4 may not access or mutate PETRUCCI,
stage or run a broker, configure a real client, use a credential, or exercise
Gateway, Bridge, Revit, DNS/TLS, ACL, enrollment, OAuth, or write/confirm
surfaces. Broker stage and all M4-04/B operations remain separately operator-
gated. If a future live connection cannot bind the accepted TCP peer to
`PETRUCCI\ws2` plus one exact protected Codex image, package, hash, and signer,
Route 1 stops without widening its allowlist. The E4 listenerless stdio route
then requires a separate planner-bound fallback slice. A4 does not claim
isolation from a process that has already compromised the same Windows user,
administrator, or SYSTEM authority.

## 2026-08-14 M4-04 protected enrollment-file binding (M4-04/A5)

The post-A4 gate audit proved that A2 can transfer the Gateway's protected
`revagent.m4-enrollment-artifact/v1` file to PETRUCCI, but the current Bridge
can re-enroll only from `REVAGENT_BRIDGE_ENROLLMENT_TOKEN`. Moving that value
through environment would violate A2's accepted no-argv/no-env/no-log custody
contract. The planner therefore bound A5 as a `2.00h` repo-only hard blocker:
one listenerless protected-file consumer validates path, owner/DACL, link,
bounded schema, and expiry; calls the existing enrollment coordinator in
memory; emits only value-free results; and positively unlinks the artifact on
every owned terminal path. The repo implementation is now `passed_merged` in
`PR #379`: the focused A5 suite passed
`57/57`, formatting verification passed, and the final common tree passed
`test-all` (exit `0`, `745.8s`; Contracts `308/308`, Bridge `850/850`) and
`test-ci` (exit `0`, `752.1s`). Root `package-lock.json` remains byte-identical.
Forecast was `2.00h`; actual active effort was `1.75h`, variance `-0.25h`
(`-13%`). Scope-record and implementation heads passed CI and Gateway CI at
attempt `1`; implementation head `78bfd189113a7a3bc1d154e8b1100fcab7f7d1e8`
passed both CI jobs and the separate Gateway CI without rerun. Final head
`7be7ab3056e055b7b975881a5b6db63e1ed7fdf0` also passed both protected CI
runs, then
[Claude review 31814037252, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31814037252/attempts/1).
It squash-merged as `8dcb664ee721d706e69ed70a17620ded73bec292`;
merge-push [CI 31814356194, attempt 1](https://github.com/BTankut/revAgent/actions/runs/31814356194/attempts/1)
passed Engineering and Gateway/RBP jobs. No rerun or Signed Source-Free CD run
was used.

A5 may not alter Bridge auth/retry/observer behavior and opens no host or live
gate. PETRUCCI stage/service/config mutation, real enrollment, Gateway image
rebuild, DNS/TLS/ACL, broker/client/Revit execution, revoke evidence, reboot,
write/confirm, production deploy, and the separately bound A7 audit export
remain outside this slice. M4 remains `in_progress` / `not_submitted`; RES-30
and the one-item npm-audit Park List remain open.

## 2026-08-14 M4-04 bounded value-free audit-export binding (M4-04/A7)

The planner bound A7 as a `2.00h` repo-only hard blocker after A5. The
pre-production event sink already holds the invocation/confirmation audit, but
its raw `revagent.event.v2` envelope contains tenant/user/session and other
live values and has no retained-evidence boundary. A7 therefore owns one
listenerless, single-attempt downstream projector for a closed
`revagent.m4-value-free-audit-export/v1` bundle. It selects the exact configured
live principal/session internally, emits only validated correlation/digest,
registry-bound metadata, closed enum/timing, and boolean binding fields, and
fails without partial output on selector, schema, duplicate, count, byte,
deadline, or writer failure. It must not alter Gateway authorization, dispatch,
Bridge auth/retry/A3 observer behavior, or add an HTTP/MCP/RBP/admin listener.

A7's implementation allowlist is the minimum
`packages/gateway/src/preProductionAuditExport*` and `preProductionServing*`
surfaces plus their
tests and these tracker records. Root manifests/lockfiles, protocol, Bridge,
installer, workflows, runners, CD/signing, NAS, host, image, credential,
DNS/TLS/ACL, broker/client, Revit, enrollment/revoke execution, reboot,
write/confirm, and production deploy/tunnel surfaces are outside the slice.
Protected source is `8dcb664ee721d706e69ed70a17620ded73bec292`;
state is `scope_recorded`, with actual/variance open.

The manual DNS route is also final: A6 is permanently canceled and no
Cloudflare API token will be generated or requested. G2 will show the operator
`m4-gateway.revagent.app` A `192.168.90.154` as DNS-only/grey-cloud plus the
certificate order's generated `_acme-challenge` TXT value on one screen. G7
will delete both records and retain positive operator confirmation. A7 itself
authorizes no DNS mutation.

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
| DP-12 PETRUCCI live-workstation readiness | Accepted M3 evidence proves the live PETRUCCI/Revit 2022 chain; 2026-08-13 read-only SSH and installed-surface evidence is retained in `docs/decisions/DP-12-PETRUCCI-readiness-2026-08-13.md`. Bridge still targets the M3 loopback stub and real-Gateway enrollment is unproven; NET01 is outside the program | `in_progress` | Obtain separate M4-04 network/trust, Bridge-stage, credential/enrollment, and client/live approvals; operator names pilot user, dates, fallback, and communications owner |

The core M0 exit defined by the Week-1 objective is evidenced by merged PRs #268-#275: the decisions are
recorded, O1 v0.9 completed its closure review, the monorepo and Compose scaffolds exist, the 35-tool HTTP
spike passed, and the new-package CI is present. PR #276 adds the now-historical
NET01 inventory; the 2026-08-13 operator correction makes PETRUCCI the current
DP-12/M4 live workstation without rewriting that earlier evidence. Exact-main run
29929124082 completed green, so M0 is `passed`; only the milestone decision owner may promote it to
`accepted`.

GAP-13.2's exact WhatsApp distribution/acknowledgement proof and scheduled-task
neutrality, DP-12's named pilot roles/window plus PETRUCCI's separately gated
M4-04 live steps, WP9 hands-on conformance, and active-origin/tunnel proof are
pilot-entry carry-forwards. They remain open and are not silently converted
into M0 completion evidence.

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
| M2 | External-client Gateway core serves a capability index and deferred schemas through `tool_search`/`tool_schema`, exposes a small pinned callable set over north MCP, loads immutable hash-bound runtime/docs handlers without frozen-source relocation, and proves registry/policy/confirmation plus bridge/internal executor dispatch and production RBP ingress; Mode B remains interface stubs only | M1 | WP2 with WP5 P5-T4 and WP6 P6-T1 | 38d | 11.60h recorded for #356–#365; four earlier slices not recorded | not calculable for complete milestone | `accepted` |
| M3 | Bridge + pre-pilot add-in adaptations connect, journal redelivery, and demonstrate sequential then capability-gated atomic batch behavior | M1 | WP3 | 15d | not recorded | not calculable | `accepted` |
| M4 | **Pre-production-auth vertical slice:** an external MCP client (WP9 candidate) → Gateway → Bridge → live Revit executes one read and one confirm-class write with originating-preview/approval/commit audit evidence; this slice does not pass DP-10 OAuth or hands-on conformance | M2, M3 | WP1/WP2/WP3/WP5/WP9 | 5d | not recorded | not calculable | `in_progress` |
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
