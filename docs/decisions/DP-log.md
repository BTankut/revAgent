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
can execute in the candidate run. Windows system DLLs, kernel-level hardlink
races, and an already-running same-user process that can actively mutate and
restore writable build/dependency files during a guarded generator/compiler
subprocess remain outside this application provenance boundary; canonical
evidence requires those other writers to be quiesced.

This dated R-F entry closes the identified contract/design gap only. It does
not declare the O1 spec frozen, does not validate a candidate run, and does not
satisfy O1-T6/O1-T8. M1 still requires a clean protected candidate, fresh
canonical preparation, three consecutive complete runs, the full one-hour
soak, validators, tree-identity proof, and the separately governed tag.

### 2026-07-23 — R-F: canonical evidence launch begins before Node loads JavaScript

The M1 closing audit found two remaining bootstrap gaps in the v3 provenance
path. An in-process environment guard runs only after Node has already applied
`NODE_OPTIONS`; it therefore cannot prove that injected preload code did not
execute. The outer protocol/controller bootstrap also used the installed
TypeScript and `json-schema-to-typescript` generator stack before the freshly
built controller could capture or verify those bytes. Finally, the outer
wrapper selected Git but did not pass that exact resolved executable to the
inner preparation command.

Implementation clarification from the same closing audit: canonical Windows
evidence begins with one fixed, compressed `-EncodedCommand` under the exact
SystemRoot Windows PowerShell with `-NoProfile` and `-NonInteractive`; it does
not execute the mutable worktree `invoke-production.ps1`. Canonical
`-EncodedArguments` bind the explicit clean candidate commit/tree, role, root,
and child arguments. Production entry also does not execute the mutable
worktree renderer or run Node/Git to derive that command or the candidate
identity. An independently protected authority supplies the exact eight host
arguments and retains their whole `EncodedArguments`, `EncodedCommand`,
bootstrap-template, and payload SHA-256 values, expected commit/tree,
generation timestamp, and authority label outside the checkout and evidence
artifact root. Before launch, the authority executor requires strict UTF-16LE
round-trip and ordinal equality to the one canonical single-string CLIXML
document; arbitrary serialized object graphs are not deserialized or searched
for a decoy payload. The expected commit/tree are approved literals at this
boundary, not the output of a pre-bootstrap Git probe. The tracked renderer
produces review-only candidates and cannot confer authority.

The same R-F clarification also makes the payload-bound repository root the
only permitted Node child working directory. The launcher does not inherit the
authority executor's ambient directory, the retained authority record exposes
that bound working directory, and the child attestation rejects a working
directory other than the approved repository root before controller import.

The fixed bootstrap authenticates and locks the exact
Program Files Git binary, reads the constant launcher path as raw bytes from
the expected commit with `git cat-file`, recomputes the Git blob object id and
SHA-256, strict-decodes it, and executes that blob as a scriptblock in the same
PowerShell process. Caller-provided commit/tree identities prove consistency,
not publisher approval; candidate approval remains a separate protected
release-policy input.

The launcher removes the exact Node and `ws` resolution-control variables
before starting the authenticated Program Files Node and is required for every
production prepare and the sole PASS-capable final invocation. Standalone run,
aggregate, and validator invocations remain launcher-bound diagnostics;
standalone aggregate is write-free and non-authoritative. The launcher verifies
and holds read locks on the complete initial JavaScript import closure plus the
bootstrap pin, then sends those captured bytes over a separate
current-user/PID-bound pipe. A static `node -e` loader installs synchronous
hooks over that in-memory map before the CLI bootstrap or prepare wrapper is
imported. The child re-renders and verifies both encoded PowerShell arguments,
the fixed outer command, compressed template, launcher blob identity, initial
loader, exact argv, and full source anchor in the receipt. The existing
in-process environment guards remain defense in depth; direct Node or direct
`-File` invocation is not canonical evidence.

Before any protocol generator, clean, or TypeScript child runs, the outer
preparation wrapper captures the complete physical TypeScript package and the
actual installed transitive package closure rooted at the protocol package's
`json-schema-to-typescript` dependency. It rehashes that identity immediately
before and after every generator/clean/compiler child and before entering the
inner CLI. The wrapper rejects caller-provided `--git-executable`; the
launcher and source anchor independently authenticate the fixed Program Files
Git path and append that exact absolute path to the inner CLI exactly once. A changed bootstrap
dependency, compiler implementation, resolution path, injected preloader, or
Git substitution fails closed.

This amendment closes the launch/bootstrap contract gap only. No canonical
three-run or soak evidence was produced by this change, and it does not declare
O1 v1.0 frozen, M1 passed, the freeze PR ready, or a tag authorized.

### 2026-07-23 — R-F: authoritative runtime integrity is bounded by a run-scoped epoch

The M1 closing run exposed that repeating the complete static source,
provenance, toolchain, output, and installed-dependency byte walk at every
component lifecycle boundary consumed most of each case runtime. The measured
full suite could not satisfy the O1-T6 ten-minute non-soak gate, and the same
multi-second check after each of 720 soak cycles could not preserve the
canonical five-second cadence.

Each authoritative conformance run and reconnect soak therefore owns one
non-nestable runtime-integrity epoch. The runner performs the complete existing
byte/provenance verification immediately before opening the epoch and again
only after every supervised component has stopped. Every component launch,
readiness, failed-start cleanup, shutdown, and soak-cycle boundary still checks
that it is operating under the exact epoch plan bytes and physical repository
root; a different plan/root or a concurrent/nested epoch fails closed. Closing
verification failure changes the retained run/soak verdict to error/failed and
can never produce the sole authoritative PASS.

Any supervised case-execution exception is promoted to the run's
infrastructure failure before representative component binding or run-level
artifact retention. The error report retains the case's
`supervised_case_error` and the thrown diagnostic includes the exact case id
and original message; a secondary missing-lifecycle/component-log error may
not mask it.

The same fail-closed run isolated an intermittent C27 setup race: session
registration became visible before the Bridge's initial outbound window was
acknowledged, so opening-fault injection and disconnect could overlap that
delivery. C27 now explicitly invokes its existing Bridge `flush_outbound`
path through the already canonical `drive_bridge_outbound` parent decorator:
the parent advances the virtual clock, observes heartbeat acknowledgement,
flushes outbound work, and then waits for an empty durable outbox before fault
injection. The raw-case runner shares that narrowly extracted decorator with
the middle-case runner; it does not inherit the middle runner's dispatch or
raw-frame behavior. This adds no new test-only action and does not alter the
reconnect/backoff oracle.

This is an amortization amendment, not a reduction of the declared application
provenance anchor. Persistent input or dependency mutation remains detected by
the closing full check. The already documented exclusion for an active
same-user writer capable of mutating and restoring anchored bytes entirely
inside a subprocess/run window remains unchanged and requires operator
quiescence during canonical evidence production. No protocol wire rule,
component contract, accepted threat boundary, or freeze/tag authorization is
changed by this amendment.

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

### 2026-07-25 — R-F: Windows CI rematerializes protected source bytes (RES-27)

M1 gate evidence on the reused self-hosted Windows runner showed that
`.gitattributes` alone does not rewrite tracked files whose blob ids did not
change. Git reported the checkout as clean through LF normalization while the
raw worktree bytes remained CRLF, so the fail-closed source-identity check
correctly rejected the candidate.

RES-27 requires both existing Windows jobs in `.github/workflows/ci.yml` to
stream `git archive --format=tar HEAD` directly into `tar -xf -` under `cmd`
immediately after checkout. Unlike `checkout-index --force`, which still
treated the normalized CRLF worktree as unchanged in the reproduced reuse
case, the archive contains the exact protected blobs and overwrites every
tracked path byte for byte. `git add --update` then refreshes tracked index stat
data, and separate cached/worktree `git diff --quiet` checks fail unless the
index and worktree still equal HEAD. The amendment is limited to deterministic
checkout bytes: no job, release path, source-identity exception, or PASS
condition is added or relaxed.

### 2026-07-25 — R-F: M1 semantic freeze and tag closure are decoupled (RES-28)

Source: operator closing instruction from Barış Tankut, 2026-07-25.

- `M1 KAPANIŞ: ONAY`.
- Add-in implementation owner: Barış Tankut.
- Owner acceptance: the batchable-command restrictions and atomic rollback
  evidence are accepted.
- Draft PR [#290](https://github.com/BTankut/revAgent/pull/290) is authorized
  to become ready and, after the protected required gates are green, squash
  merge to `main`. The protected tree-equal merge freezes RBP/1 and closes M1.
- `rbp/v1.0.0` is not authorized by that merge and MUST NOT be created now.
  Tag creation requires a separately validated retained three-run aggregate,
  a real one-hour reconnect/proxy-churn soak, WSS/Streamable HTTP/SSE
  proxy-interoperability evidence, and protected-tag identity.
- Missing or incomplete tag evidence is non-blocking for M1 and may be produced
  in parallel with M2/M3. It does not block M2/M3 start. A substantive
  semantic or safety finding still follows R-F/versioning and leaves the gate
  it affects red. M2/M3 kickoff remains subject to a separate authorized
  operator instruction.

This amendment supersedes the 2026-07-23 entries only where they classify the
three-run aggregate, one-hour soak, proxy-interoperability evidence, or tag as
prerequisites for M1 protected merge or M2/M3 build entry. Their fail-closed
provenance, exact-byte identity, report-validation, protected-branch, and
versioning controls remain in force. The normative resolution is RES-28 in
`docs/implementation-plan/00-INDEX.md`.

### 2026-07-25 — R-F: M2 external-client discovery and dispatch alignment (RES-29)

Source: authorized WP2/M2 kickoff from Barış Tankut, 2026-07-25.

RES-23 removes the Phase-1 Gateway-owned agentic loop and Gateway LLM/provider
credential path, but it does not remove the M2 discovery contract. M2 therefore
keeps the north MCP Streamable HTTP + OAuth seam, Tool Registry, byte-stable
capability index, deferred schemas through `tool_search`/`tool_schema`, a small
pinned callable set, registry-governed executor dispatch to bridge/internal
executors, and docs-MCP internalization. The existing ChatGPT/Codex Desktop
client owns conversation state, model calls, planning, and the loop. Mode B is
limited to non-executable interface stubs; O2 remains deferred.

Implementation review also showed that deleting the M0 legacy bundle without a
replacement would leave no production loading path for the 35 runtime and five
docs handlers. M2 packages immutable, content-hashed handler modules from exact
frozen sources without moving or editing them, and consumes the frozen RBP/1
contract without changing `packages/protocol/**`. The dedicated Gateway CI
lane is the M2 code gate; the bounded RES-24 `ci.yml` exception is not
extended. M4 remains a separate external-client vertical slice and is not
entered without operator-channel M2 closure approval.

This amendment corrects the parked PR #288 wording that had deferred all Mode A
behavior and omitted the required Phase-1 Mode B stubs. It does not reintroduce
the in-house loop, Gateway provider/context code, or a Gateway LLM key, and it
does not reopen D1-D12. The normative amendment is RES-29 in
`docs/implementation-plan/00-INDEX.md`.

### 2026-07-25 — R-H: milestone evidence is bounded by the authoritative gate

Source: operator instruction from Barış Tankut, 2026-07-25. For every
milestone, required evidence is limited to the evidence explicitly named by
the authoritative plan/gate definition. The implementing assistant may not
promote extra runs, soak tests, demonstrations, repetitions, or other
diagnostics beyond the governing gate into a blocking requirement or delay a
milestone on that basis. Required current-head CI and other runs already named
by the gate remain required. Any proposed
additional gate evidence must first be submitted for explicit operator
authorization through an R-G operator task card, including rationale, cost,
and affected gate. Until approved, supplementary evidence remains
non-blocking. This rule does not weaken evidence already named by a governing
gate; it prevents assistant-created escalation. The permanent normative
wording is R-H in `docs/implementation-plan/00-INDEX.md` §8.
### 2026-07-22 — R-G: mandatory operator task cards

Source: operator instruction from Barış Tankut, 2026-07-22. Every implementation report that leaves an
operator action MUST end with a separate `## OPERATÖR GÖREV KARTLARI` section. Every card carries exact
steps, gate rationale, deadline/blocking gate, evidence destination, and a one-message reply format.
Server-side work that is safely executable through the available `bt@192.168.90.154` SSH path belongs to
the implementing assistant, with retained command output. Only account authorization, physical/network
work, decisions, and user communications remain operator-owned. The permanent normative wording is R-G in
`docs/implementation-plan/00-INDEX.md` §8.

### 2026-07-26 — P3-T6 migration-freeze exception: add-in loopback intake hardening

Source: WP3/M3 implementation handoff and RES-5. This dated R-F record authorizes
only the first bounded P3-T6 adaptation: bind the existing add-in TCP listener to
numeric loopback, consume the frozen shared add-in framing constants/header codec,
serialize process-wide data-plane command intake, and remove the late
`ExecuteCodeEventHandler.WaitForCompletion` reset that could erase an already
signaled completion. Because a timed-out `ExternalEvent` is not cancelled, a
timeout found anywhere in the command exception chain now quarantines all later
non-status intake for the rest of the Revit process before the serialization gate
is released. Quarantined requests receive deterministic JSON-RPC internal errors;
only a Revit restart clears the quarantine. The cached `mcp_status` path remains
outside the intake gate, and the pilot-era legacy framing detector remains present.

The frozen-source exception is limited to `SocketService.cs`, the named
dynamic-code event handler, and the add-in project reference to
`RevAgent.Contracts`. Non-frozen delivery plumbing in
`scripts/build-revit-plugin.ps1`, `scripts/RevitPayloadManifest.psm1`, the
installer-side Contracts DLL/manifest, and static smoke coverage may change only
to make that shared runtime dependency installable and freshness-checked. This
slice does not change the 21 existing command contracts, the duct-routing engine,
RevitMCPSDK types, port allocation, or the functional TCP framing. The remaining
cached document-context and exact atomic `execute_batch` adaptations require their
own bounded freeze-exception PRs and dated records.

### 2026-07-27 — R-I: merge verification is mandatory before reporting a PR merged

Source: operator instruction from Barış Tankut, 2026-07-27.

During the M3 PR sequence, PR [#297](https://github.com/BTankut/revAgent/pull/297) was reported as merged
after a `gh pr merge` invocation returned empty output. The merge had in fact been rejected by protected-branch
rules because the head was `BEHIND` current `main`; the PR remained open and its six commits stayed unmerged.
The mistake was caught only later, when the open-PR list was re-enumerated after another merge.

R-I therefore requires that a PR be reported as merged only after `origin` confirms it: PR `state=MERGED`
plus a merge commit SHA on the target branch, read back with `gh pr view <n> --json state,mergeCommit` or an
equivalent API call. An empty or silent merge-command result is not evidence of success. Two protected-branch
conditions are known to reject merges silently in this repository: a `BEHIND`/`blocked` head, and a required
check (notably `Claude review gate`, whose workflow triggers only on `[opened, reopened, ready_for_review]`)
being absent for the current head SHA after a force-push.

This rule adds a verification duty only; it does not change any gate, required check, or merge authority.
The permanent normative wording is R-I in `docs/implementation-plan/00-INDEX.md` §8.

### 2026-07-28 — R-F: the M3 gate's enrollment item is split by evidence boundary (RES-30)

Source: operator decision from Barış Tankut, 2026-07-28, on the M3 gate report.

The M3 row in `docs/implementation-plan/08-sequencing-risks-decisions.md` names `enrollment` as a gate item
without distinguishing bridge-side protocol completeness from end-to-end proof. End-to-end enrollment evidence
requires a real Gateway that can issue a single-use enrollment token, exchange it for a device token, and
revoke a device — and that Gateway is M2 work proceeding on a parallel lane. Holding M3 for it would block a
milestone on another lane's deliverable rather than on WP3's own work.

RES-30 therefore scopes the M3 enrollment item to the **bridge side**: single-use enrollment-token intake,
the device-token exchange message flow, DPAPI-machine persistence, the re-enrollment path, and fail-closed
refusal when credentials are absent or rejected — all demonstrated green against the M1 Gateway stub.
Token exchange against a real Gateway, revoked-device refusal at handshake, and device-token persistence
across reboot move to **M4**, which is the first milestone that stands up a Gateway on the office host, and
they remain named M4 entry criteria.

The operator also reassigned the M3 gate's operator task cards on the same date: NET01 is allocated to this
work with SSH access, so service installation, SCM start/stop, reboot survival, Event Log verification, log
rotation, and the attestation helper's positive/negative paths are executed by the implementing assistant
over SSH under R-G. Only genuinely interactive work (live Revit GUI, UAC, licensing) remains operator-owned,
and must be delivered as a fully scripted single-action package with a one-line statement of why SSH cannot
cover it.

This amendment changes where enrollment evidence is produced, not what enrollment must do. No other M3 gate
item is relaxed: persistent WSS, invocation → add-in TCP framing, idempotency journal, and
batch-as-transaction-group remain M3-blocking. The normative resolution is RES-30 in
`docs/implementation-plan/00-INDEX.md`.

### 2026-07-28 — R-F: Gateway CI moves to GitHub-hosted Linux; deploy runner stays deferred (RES-31)

Source: operator decision from Barış Tankut, 2026-07-28, after the live P5-T4/GAP-11 readiness check.

The repository is owned by a personal GitHub account, so organization/enterprise runner groups and their
selected-workflow policy are unavailable. M2 does not need a self-hosted host trust boundary merely to prove a
Linux-container target. RES-31 therefore moves only P5-T4's dedicated `.github/workflows/gateway-ci.yml` to
GitHub-hosted `ubuntu-latest`. The lane uses Node 24, verifies the triggering PR/push exact head, installs the
migration workspace, runs Gateway lint/typecheck/tests, scans for secrets, and builds the Gateway image. Its
trigger is restricted to `packages/gateway/**` and the workflow file itself because this private repository has
a finite Actions minute budget. The existing Windows `Engineering gates` and `Gateway gates` jobs remain
unchanged: their conformance package and protected production-launcher Node identity are Windows-specific.

This does not cancel P5-T5. The self-hosted Linux runner remains the M6 `gateway-cd.yml` deploy executor because
that host is the LAN-only deployment target. No runner is installed, registered, or started during M2. At M6,
the operator approves a personal-repository compensating control: a root-owned pre-job hook fail-closes on
`GITHUB_WORKFLOW_REF` unless the job is from `gateway-ci.yml` or `gateway-cd.yml`; the dedicated runner account
is unprivileged and has no sudo, uses rootless Docker, and cannot access `/opt/revagent/env`. Moving the
repository into an organization for native runner-group enforcement is deferred until after migration cutover
and remains an expected SaaS-commercialization step.

This amendment changes P5-T4/T5 sequencing and runner ownership only. It does not weaken the RES-29 exact-head,
Node-24, install, lint, typecheck, test, secret-scan, or image-build gate, does not authorize deployment, and
does not edit `.github/workflows/ci.yml`. The normative resolution is RES-31 in
`docs/implementation-plan/00-INDEX.md`.

### 2026-07-28 — R-F: Required Gateway CI runs on every pull request (RES-32)

Source: operator correction from Barış Tankut, 2026-07-28, before adding `Gateway CI` to main branch
protection.

RES-31 initially applied the private-repository Actions-minute path filter to both pull requests and pushes.
That is unsafe once `Gateway CI` becomes a required context: when a pull request changes only another package,
GitHub skips the workflow and leaves the required check expected indefinitely. In particular, M3 changes under
`packages/bridge/**` or `src/revit-plugin/**` would become unmergeable.

RES-32 removes only the `pull_request.paths` filter so every pull-request head receives an exact-head
`Gateway CI` result. The `push: main` filter remains limited to `packages/gateway/**` and the workflow file,
preserving the post-merge minute-budget control. The observed successful runtime is approximately 54–63
seconds per pull request, which the operator accepts against the materially larger merge-deadlock risk. A
dummy-success job is unnecessary because the simple always-run pull-request lane provides the required context
directly.

All other RES-31 controls remain unchanged: GitHub-hosted `ubuntu-latest`, Node 24, exact-head verification,
install, lint, typecheck, test, secret scan, image build, minimal permissions, concurrency, the unchanged
Windows jobs in `ci.yml`, no M2 self-hosted runner, and M6 deferral of the deploy runner. The normative
resolution is RES-32 in `docs/implementation-plan/00-INDEX.md`.
