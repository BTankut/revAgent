# RevAgent DP Decision Log

**Milestone:** M0
**Prepared:** 2026-07-22
**Normative coordinator:** `docs/implementation-plan/00-INDEX.md`
**Status rule:** `proposed`, `awaiting_confirmation`, `partially_confirmed`, and
`confirmed_pending_conformance` do not by themselves satisfy the associated executable milestone gate.

## Current decisions

| DP | Decision | Gate | Status | Recorded choice | Decision date | Evidence / next action |
|---|---|---|---|---|---|---|
| DP-1 | Bridge technology | M0 / build entry | confirmed | .NET 8 self-contained single-file Windows service | 2026-07-22 | Operator-confirmed; scaffold and Bridge implementation use this stack. |
| DP-2 | Gateway-to-bridge transport | M0 / build entry | confirmed | WSS primary; Streamable HTTP/SSE fallback | 2026-07-22 | Operator-confirmed. RES-25 records the R-F amendment to WP1 P-O1-1; the fallback binding and conformance evidence remain v1.0/pilot work. |
| DP-3 | Outbound tunnel | Pilot entry | confirmed | Cloudflare Tunnel object `revagent-gateway-prod`; UUID `bb68cbcb-eedf-474e-aaee-145d160ed004` | 2026-07-22 | Barış Tankut confirmed operator attribution. Connector credential/config and a bounded QUIC+HTTP/2 edge proof are staged on the Gateway host; the service remains deliberately disabled/inactive until the real origin exists. |
| DP-4 | Gateway domain | Pilot entry | confirmed | `gateway.revagent.app` | 2026-07-22 | Barış Tankut confirmed operator attribution. DNS/edge TLS and the staged `http://127.0.0.1:8081` ingress are evidenced; active-origin `/healthz` and restart proof remain pilot gates. |
| DP-5 | Phase-1 identity provider | Cutover entry | awaiting_confirmation | Recommended: Keycloak in Compose, through generic `OIDC_*` configuration | — | RES-22 governs. Entra ID remains conditional on an office M365 tenant and successful WP9 OAuth testing without DCR. |
| DP-6 | LLM provider, models, and region | Phase 1 | not_applicable_phase1 | The authorized ChatGPT/Codex Desktop client retains the Phase-1 agentic loop; the Gateway uses no LLM API key | 2026-07-22 | RES-23 removes DP-6 from the Phase-1 pilot gate. The long-term in-house-loop/provider choice remains a later D9 implementation decision. |
| DP-7 | Seat model | Cutover entry | awaiting_confirmation | Recommended: named-user seats per module | — | Confirm reassignment and procurement policy. |
| DP-8 | Gateway host | Pilot entry | confirmed | Dedicated office Ubuntu Server at `bt@192.168.90.154`; ED25519-key-only SSH; password and keyboard-interactive authentication disabled; dedicated to revAgent | 2026-07-22 | M0 live SSH/OS/resource evidence was retained in `DP-08-gateway-host.md` on 2026-07-22. Router dual-WAN/LTE is unavailable; Barış Tankut accepted the WAN-outage risk. Docker/Compose, power/UPS, and production tunnel readiness remain later operational gates. |
| DP-9 | Bridge update signing | Pilot entry | awaiting_confirmation | Recommended: reuse the detached RS256 pinned-key chain | — | Confirm existing production key custody and bridge-manifest signing use. |
| DP-10 | Phase-1 designer client | Pilot entry | confirmed_pending_conformance | Existing authorized ChatGPT/Codex Desktop client | 2026-07-22 | Barış Tankut confirmed operator attribution on 2026-07-22. Client installation, subscription, and user session are user responsibilities; revAgent owns remote MCP registration and end-to-end compatibility verification. WP9 conformance must pass before pilot/cutover. |
| DP-11 | Backup target | Cutover entry | awaiting_confirmation | Recommended: S3-compatible off-host bucket | — | Record provider, region, owner, and budget. |
| DP-12 | Pilot user/machine and cutover window | Pilot entry | partially_confirmed | Pilot machine: `NET01` (registered, dedicated to this work, waiting, and reachable by stored SSH access at the requested date/time) | 2026-07-22 | Barış Tankut confirmed operator attribution and the machine allocation. Live SSH/resource/installed-surface evidence is retained in `DP-12-NET01-readiness-2026-07-22.md`; the stale non-`AuditOnly` updater task and the named user/window/roles remain open. |
| DP-13 | Monorepo layout | M0 / build entry | confirmed | `packages/gateway`, `packages/bridge`, `packages/protocol`; legacy directories untouched | 2026-07-22 | Operator-confirmed; the W1 scaffold must preserve the frozen legacy paths and independent runtime lockfile. |
| DP-14 | Node MSI disposition | Cutover entry | awaiting_confirmation | Recommended: keep through insurance, remove only at Retire if no other owner needs it | — | Confirm shared-machine dependencies before removal. |
| DP-15 | Historical usage archive | Cutover entry | awaiting_confirmation | Recommended: read-only NAS archive through insurance, then cold storage; no Postgres migration | — | Record final archive location, retention, and access owner. |

## Confirmation-session record

### 2026-07-22 — M0 operator checkpoint

- Operator: Barış Tankut.
- Evidence source: operator-provided written checkpoints in the Week-1 review and merge-execution tasks.
- Confirmed decisions: DP-1, DP-2, DP-3, DP-4, DP-8 host selection, DP-10 client selection, and DP-13.
- Phase-1 non-applicability: DP-6; the client owns the loop and the Gateway has no LLM API key.
- Partially confirmed: DP-12 assigns the registered `NET01` machine exclusively to this work and makes it
  available over stored SSH access at the requested date/time; pilot user, concrete dates/window, fallback
  operator, and communications owner remain open.
- Network resilience disposition: the router has no dual-WAN/LTE support; Barış Tankut accepts WAN-outage
  risk as of 2026-07-22.
- Live host evidence: BatchMode SSH reached `bt@192.168.90.154`; Ubuntu 26.04 LTS, 8 CPUs, 30 GiB RAM,
  204 GiB free root storage, and 870 GiB free data storage were retained in `DP-08-gateway-host.md`.
- Staged operational evidence: `DP-03-04-cloudflare-staging.md` records `cloudflared` 2026.7.2,
  credential-hash parity, loopback ingress validation, QUIC/HTTP2 edge proof, Docker Engine 29.6.2,
  Compose v5.3.1, hash-matched PR #273 artifacts, configuration validation, and the deliberate stopped
  state. Active-origin `/healthz`, power-recovery/UPS, and later production-readiness proof remain open.
- Executable gates remain independent of decision acceptance: WP9 must prove the selected client's remote-MCP path; NET01 and the Gateway host must produce retained readiness evidence.

### 2026-07-22 — Operator attribution closure

Barış Tankut explicitly confirmed that RES-23 direction and the DP-3, DP-4, DP-10, and DP-12 decisions
are operator-owned. This dated confirmation closes the earlier `attribution asserted, not repo-provable`
evidence gap. It confirms authorship of the decisions; it does not substitute for the separately required
tunnel, reachability, client-conformance, or pilot-execution evidence.

### 2026-07-22 — DP-3/DP-4 connector staging evidence

Under R-G, the implementation assistant used the confirmed SSH path rather than assigning server work
to the operator. Cloudflared 2026.7.2, the existing tunnel credential, root-owned locally managed config,
and a disabled systemd unit were staged on `revagent`. Ingress validation bound
`gateway.revagent.app` to `http://127.0.0.1:8081`; bounded QUIC and HTTP/2 edge checks passed. The unit
was returned to `disabled`/`inactive` because no real Gateway/Caddy origin exists yet. Exact non-secret
evidence is retained in `DP-03-04-cloudflare-staging.md`; no new Cloudflare authorization was required.

The implementing assistant then installed Docker Engine 29.6.2 and Compose v5.3.1, staged the hash-matched
PR #273 origin artifacts root-owned under `/opt/revagent/deploy/phase1`, and passed configuration-only
Compose validation. No container or TCP 8081 listener was started. The stale Ookla Ubuntu 26.04 apt source
that blocked package-index refresh was moved to the reversible `.list.disabled` form and retained.

### 2026-07-22 — DP-12 NET01 live readiness evidence

Under R-G, the implementation assistant used the stored machine-specific SSH selector and proved that
`NET01` is reachable, idle, dedicated-capacity Windows 11 hardware with Revit 2022, the OpenAI Codex AppX,
the frozen revAgent stable package, and the protected rollback launcher present. Exact non-secret evidence is
retained in `DP-12-NET01-readiness-2026-07-22.md`.

The same read-only audit found that the installed `revAgent Auto Update` hidden launcher lacks `-AuditOnly`
and recorded task result `1`. The current source-side audit-only correction post-dates the installed frozen
package. No task, updater, installer, model, or direct repair was executed. GAP-13.2 scheduled-task proof and
DP-12 pilot readiness therefore remain open until a controlled technical-team neutralization/repair is
evidenced; this work is not assigned to the pilot user.

## Amendments

### 2026-07-23 — R-F: production conformance provenance must cover every application-controlled executable byte

The M1 freeze-identity audit found that the v1 build sidecar bound tracked
compile inputs and emitted component `dist` files but did not bind the selected
runtime Node executable, the controller in `packages/rbp-conformance/dist`,
installed runtime dependencies/native add-ons, optional-peer presence, the
complete TypeScript compiler package behind the `tsc.js` shim, or the npm
launcher/package that performed the build. Canonical commands were also
trusted from the plan without re-derivation, and inherited Node/module
resolution environment variables could change executable behavior after the
single run-entry verification. These were provenance gaps, so no run produced
under that contract could by itself close M1.

The replacement `rbp-production-build-provenance/v3` /
`rbp-production-typescript-build/v3` contract fails closed over the exact
build and runtime Node files plus version/platform/architecture/modules
ABI/N-API facts; complete npm and TypeScript package trees; the selected Git
binary/version; the canonical Windows PowerShell sampler binary/version;
component, protocol, and conformance-controller outputs; and
the physical installed package copies actually selected for Gateway, Bridge,
add-in fixture, runner, and protocol generation. The bound runtime Node now
performs real CommonJS, ESM, and package-manifest resolution probes; the
selected path must equal the captured physical package root. Workspace
targets, distinct nested copies, native `.node` files, installed optional
peers, and absent optional peers are explicit records instead of inferred
from a convenient root install.

Canonical preparation is a direct invocation of the reviewed Node executable,
not `npm run`, a lifecycle shell, or a bin shim. That Node rebuilds protocol
and the conformance controller, then the freshly built controller runs a real
in-memory `better-sqlite3` open/query/close smoke under the selected runtime
Node before component cleaning and again after the fixed non-recursive,
direct-Node TypeScript DAG. Every child is bracketed by toolchain
revalidation. After each DAG step, every previously completed upstream output
is rehashed and the controller/protocol harness must remain unchanged.
There is no outer native smoke under a possibly divergent incidental Node.

Production plans re-derive exact canonical command descriptors and sanitize
Node/module-resolution environment variables. Every run and plan-bound
validator/aggregator performs the full source, toolchain, sidecar, command,
controller, and current-Node gate. The cheaper runtime launch guard rechecks
the executable candidate closure immediately before each spawn, after
readiness, after supervised shutdown (including failed-start cleanup), and
after each soak churn cycle. Full compiler/npm provenance remains a
prepare/run/validation-boundary gate; the launch guard rechecks the bytes that
can execute in the candidate run. Windows system DLLs and kernel-level
hardlink races remain outside this application provenance boundary.

This dated R-F entry closes the identified contract/design gap only. It does
not declare the O1 spec frozen, does not validate a candidate run, and does not
satisfy O1-T6/O1-T8. M1 still requires a clean protected candidate, fresh
canonical preparation, three consecutive complete runs, the full one-hour
soak, validators, tree-identity proof, and the separately governed tag.

### 2026-07-23 — Operator checkpoint: M1 draft-only stop and assistant lane assignment

Source: operator instruction from Barış Tankut, 2026-07-23. When the M1
candidate is ready, its freeze PR is opened as **draft only**. It is not
readied, merged, or tagged. The assistant presents the M1 gate report with the
gate-demo evidence, final v0.9→v1.0 diff summary, and complete conformance
suite result, then stops. No later milestone starts until the operator-channel
closing review explicitly approves continuation.

This is also a persistent execution-lane boundary for the current assistant.
After that approval, the assistant may work only in WP2/M2 on
`codex/wp2-*` branches. It must not edit `packages/bridge/**` or
`src/revit-plugin/**`; a `packages/protocol/**` change requires the dated R-F
amendment procedure before implementation. M3 is handed to a separate
assistant. This assignment does **not** change the architecture or ownership
map: WP3 remains the authoritative owner of M3 bridge/add-in/installer work.

M2 planning that began before the checkpoint is retained in draft PR
[#288](https://github.com/BTankut/revAgent/pull/288) and remains on hold.
Its proposed M2 amendment reused `RES-26`, which is already the authoritative
nested-batch amendment on `main`; that identifier/content collision is
unresolved. It must not be repaired by silently replacing either decision.
After M1 closing approval, WP2 must reconcile it through a newly numbered,
dated R-F amendment before the draft can advance. M3 planning is frozen for
handoff in draft PR [#289](https://github.com/BTankut/revAgent/pull/289);
the current assistant will not continue, ready, or merge it.

### 2026-07-23 — R-F: M1 executable candidate and evidence-record identities are separate

An M1 freeze-identity audit found a circular requirement: the previous wording
required the evidence-closing documentation, three real conformance runs,
one-hour soak, protected squash merge, and annotated tag to resolve to one
tree. Retained evidence cannot be written before it exists, writing it changes
the tracked documentation tree, and a protected squash changes commit identity
even when it preserves every candidate byte.

For O1-T8, one clean executable source commit/tree now binds the fresh build,
all three consecutive real runs, the full one-hour soak, and their exact
component hashes. The tree already contains the intended final protocol
constant, version/freeze metadata, schemas, generated files, dependency
inputs, source, tests, fixtures, conformance harness, and build/runtime
configuration. Candidate metadata is under test and does not alone declare M1
passed.

The executable PR still follows the protected ready/gates/squash path; there is
no direct `main` push. The resulting protected candidate commit is acceptable
only when its complete Git tree is byte-identical to the tested source tree.
The source and protected commit SHAs may differ because of squash, but their
tree SHAs may not. A dirty source, executable-input change, generated-file
drift, changed component hash, or source/protected tree mismatch fails closed
and requires a new candidate, fresh build, three new consecutive runs, and a
new full one-hour soak.

After the retained evidence independently validates, the annotated
`rbp/v1.0.0` tag targets the exact protected candidate commit. A later
evidence-record-only protected PR may record immutable hashes, links, states,
and the tag in the ledger; that documentation commit is not the candidate or
tag target and may not change executable inputs, normative protocol content,
version metadata, or the tag target. This amendment supersedes the earlier
single-tree/evidence-closing-commit interpretation without weakening M1
evidence, freeze, protected-branch, or rerun requirements. The operational
identity checks are in `docs/plan/M1_O1_FREEZE_EVIDENCE.md`.

### 2026-07-22 — R-F: Phase-1 external client path (RES-23)

The operator selected the existing authorized ChatGPT/Codex Desktop client and made DP-6 inapplicable to
Phase 1. This supersedes WP3 P-CODEX-1, the INDEX's prior Claude-default candidate wording, and lower-plan
instructions that require the pilot to be fully off Codex or require a Gateway LLM key. Phase 1 removes the
legacy local stdio/NAS registrations, not the user-owned application, subscription, or session. revAgent
owns remote MCP registration and end-to-end conformance. The long-term D9 in-house-loop target is unchanged.
The normative amendment is RES-23 in `docs/implementation-plan/00-INDEX.md`.

### 2026-07-22 — R-F: bounded W1-4 `ci.yml` exception (RES-24)

WP5 P-CD-3 says Gateway CI/CD lands only in new workflow files, while the authoritative Week-1 task W1-4
requires one additive `gateway-gates` job in `.github/workflows/ci.yml`. RES-24 permits only that M0 addition
in PR #271. Existing jobs and the signed release workflow remain unchanged; subsequent Gateway CI/CD returns
to dedicated workflow files.

### 2026-07-22 — R-F: DP-2 fallback is a Phase-1 requirement (RES-25)

DP-2 confirms WSS primary with Streamable HTTP/SSE fallback. This supersedes WP1 P-O1-1's statement that
WSS is the sole Phase-1 transport and the fallback is not built. Both bindings share RBP semantics; the
fallback remains capability-gated and cannot enter the pilot until its binding and conformance evidence are
frozen. The normative amendment is RES-25 in `docs/implementation-plan/00-INDEX.md`.

### 2026-07-22 — R-F: nested batch delivery is inline-only and fail-closed (RES-26)

Executable W1 review showed that RBP/1 has no defined chunk/artifact carrier for a nested batch step. The
previous plan could therefore admit a command whose result could not be represented honestly in the batch
terminal. RES-26 requires pre-dispatch, session-local inline-only attestation and an 8 MiB per-step cap;
atomic dispatch also carries the connection-negotiated aggregate cap into `execute_batch` and validates it
before assimilation. A post-dispatch violation preserves the known effect as terminal protocol evidence
(`effect_state` for non-atomic fan-out), suppresses raw path/artifact bytes, and stops successors. Atomic
malformed/contradictory committed carriers fail closed as indeterminate. This amendment closes a carrier
contract hole; it does not weaken any batch, rollback, journal, or conformance assertion. The normative
amendment is RES-26 in `docs/implementation-plan/00-INDEX.md`.

### 2026-07-22 — R-G: mandatory operator task cards

Source: operator instruction from Barış Tankut, 2026-07-22. Every implementation report that leaves an
operator action MUST end with a separate `## OPERATÖR GÖREV KARTLARI` section. Every card carries exact
steps, gate rationale, deadline/blocking gate, evidence destination, and a one-message reply format.
Server-side work that is safely executable through the available `bt@192.168.90.154` SSH path belongs to
the implementing assistant, with retained command output. Only account authorization, physical/network
work, decisions, and user communications remain operator-owned. The permanent normative wording is R-G in
`docs/implementation-plan/00-INDEX.md` §8.
