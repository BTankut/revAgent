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

### 2026-07-29 — R-F: SDK v2 north MCP retains stateless legacy compatibility (RES-33)

Source: operator decision from Barış Tankut on 2026-07-28, recorded on 2026-07-29 before the M2 north
endpoint implementation advances.

The installed client fleet cannot yet consume a 2026-only MCP endpoint: Codex defaults to protocol
`2025-06-18` with its 2026 mode disabled by default, and Claude Code currently tops out at `2025-11-25`.
The MCP compatibility matrix classifies a legacy client talking directly to a modern-only server as a
failure. A `legacy: "reject"` cut would therefore make the Phase-1 product surface inaccessible.

The MCP TypeScript SDK v2 provides the bounded migration path. M2 moves only `packages/gateway/**` from the
monolithic v1 SDK to `@modelcontextprotocol/{server,client,core,node}@2.0.0` and Zod `^4.2`; frozen packages
under `installer/**` retain their v1 pins and support window. Because the workspace has no Gateway-local
lockfile, the repository-root `package-lock.json` is the sole non-Gateway generated artifact authorized for
this dependency resolution; no other workspace or `installer/**` manifest/lock may change. The production north endpoint keeps one
2026-style session-server factory and composes it through `createMcpHandler(factory)` and `toNodeHandler` with
`legacy: "stateless"`. The SDK owns the legacy shim, while `server/discover` remains mandatory. Phase 1 MUST
NOT use `legacy: "reject"` or expose a 2026-only endpoint.

Stateless compatibility removes the old assumption that an MCP session identifier is the security binding.
The existing `authBindingKey()` protection therefore moves, rather than disappears: request-carried state is
issued by `createRequestStateCodec({ key, ttlSeconds, bind })`, bound to the verified authorization context,
and accepted only through
`ServerOptions.requestState.verify`. Required-but-missing, malformed, expired, tampered, or
authorization-context-mismatched state fails closed. Separately, dispatcher correlation becomes a
Gateway-generated identity per logical invocation and MUST remain independent of MCP transport/session identity.

Gateway-owned pre-validation also MUST NOT shadow the SDK's `-32020` (`HeaderMismatch`) or `-32022`
(`UnsupportedProtocolVersion`) response bodies because clients use those bodies to understand the server era.
The operator-required evidence for this amendment is limited to bounded M2 unit/integration coverage for
dual-era serving, mandatory discovery, request-state tamper/hijack refusal, normalized correlation, and
preservation of those two error bodies.

This amendment changes only RES-29's north MCP delivery mechanics and the corresponding P-GW-1 transport
reference. It does not add a Gateway LLM, reopen the frozen RBP/1 contract, edit `packages/protocol/**`,
authorize changes under `installer/**`, start the deferred Mode-B engine, implement the deferred
`Mcp-Method`/`Mcp-Name` audit, or define capability-index caching. It does not change existing MRTR/GAP-2
ownership; those opportunity slices remain separate PRs after this decision chain. The normative resolution is
RES-33 in `docs/implementation-plan/00-INDEX.md`.

### 2026-07-29 — R-F: a shared red gate stops unrelated merges and repeated red is escalated (R-K)

Source: operator emergency directive from Barış Tankut on 2026-07-29 after PR #315 merged while the
Windows `Gateway gates` lane was red, plus the same-day coordinator amendments after review of the complete
same-tree run record and the runner-restart recovery.

Provider-outage amendment source: operator directive from Barış Tankut on 2026-07-29 after the official
Anthropic all-model incident overlapped both #321 Claude review attempts.

Branch-protection configuration is not the authority to proceed through a known red exact-head shared gate.
No executable-code PR may merge without a green `Gateway gates` result for that PR's exact head SHA. If
`Engineering gates`, `Gateway gates`, or `Gateway CI` has two consecutive red runs in the same lane, the
responsible assistant blocks unrelated executable-code merges in that lane and sends one operator
notification card. The card names the gate, shard/test, consecutive-red count, and current fix/location; it
also includes the exact error signature, every red run ID in the sequence, the oldest known occurrence of
that signature, any green run on the same tree SHA, and at least two candidate remedies with their costs.
Conformance reports use the canonical denominators — N of 373 tests and N of 60 files — and name every
shard that started or completed. A “known flaky” label is not a disposition and cannot waive the merge stop
or notification.

Provider-caused outages are not lane defects and do not advance the R-K consecutive-red counter or trigger
the R-K work stop when an official provider status-page incident names the affected dependency and the run
timestamps fall inside its active window. The evidence record retains the incident title and URL, affected
components, start timestamp, and eventual resolved timestamp. The required check remains red and merge
remains fail-closed; assistants do not spend retries while the incident is active. After the provider records
resolution, one exact-head retrigger may be made. Any uncovered or post-resolution red returns to ordinary
R-K handling.

The first application is the official Anthropic incident
[`Elevated errors across all models`](https://status.claude.com/incidents/q2kg8n613kr3), opened
2026-07-29 19:49 UTC and still unresolved at the 2026-07-29 20:57 UTC evidence read. The incident names
`claude.ai`, Claude API (`api.anthropic.com`), Claude Code, and Claude Cowork as affected. Immediately before
the incident, #320 review run `30479734170` / job `90670367809` completed green from 18:24–18:27 UTC with
`total_cost_usd=0.929517`, 12 turns, populated structured output, and `blocking=false`. #321 run
`30488398855` attempts 1 and 2 ran inside the active incident window and both ended with one turn,
`total_cost_usd=0`, and no structured output. Those two reds kept #321 merge-blocked until a later
exact-head green review, but are classified as provider-outage evidence rather than a
Gateway/runner/Claude-review lane defect; they do not constitute an R-K stop. Anthropic marked that incident
resolved at 2026-07-29 22:36 UTC.

Before the authorized retry on 2026-07-30, a separate official
[`Degraded performance on Claude Opus 4.8`](https://status.claude.com/incidents/kqjy03gs895j) incident
opened at 13:43 UTC and named Claude API and Claude Code among the affected components. No retry was spent
while it remained active. Anthropic marked it resolved at 14:24 UTC; only after resolution was #321 cycled
ready → draft → ready at exact head `808be5e356545278e329b8dd11c7393b8d45e3e1`. Review
[run 30552113415](https://github.com/BTankut/revAgent/actions/runs/30552113415), job
[90903133862](https://github.com/BTankut/revAgent/actions/runs/30552113415/job/90903133862), completed green
with `total_cost_usd=0.4578525`, eight turns, populated two-field structured output, and
`blocking=false`. R-I then verified PR #321 as `state=MERGED` with
`mergeCommit=255614623e4ace84f598b5db29834f8941410b2e`. This chronology demonstrates the rule without
waiving the required check or consuming repeated retries during an active provider incident.

R-K does not stop development, rebases, documentation-only governance/evidence records, or
operator-authorized changes whose purpose is to repair the named shared gate. The repair exemption is
limited to the approved fix, the diagnostic instrumentation necessary to localize and verify it, and directly
associated workflow reliability/cost controls. It does not admit unrelated product work or waive exact-head
checks: the repair PR itself still requires green `Gateway gates` on its exact head before merge. M3
development and rebases may continue, but no M3 PR may merge without that same exact-head proof.

The similarly named jobs have distinct scopes: `Gateway gates` is the Windows full
migration/RBP-conformance lane in `.github/workflows/ci.yml`; `Gateway CI` is the GitHub-hosted Linux
`packages/gateway/**` lint/typecheck/test/secret-scan/image-build lane in
`.github/workflows/gateway-ci.yml`. A result from one lane cannot substitute for the other.

The reviewed record on tree `c2d5bcbff65ad3ec9d89600a2c4e4e4201f771cc` is exactly one green and
three red attempts:

- Run `30427715792`, attempt 1, job `90497728312`, passed `Gateway gates` on PR head
  `030ea57deb77d6f1cad2299684bf5018ad37d96d`: 60/60 files, 373/373 tests, and 5/5 shards
  passed.
- Run `30431553446`, attempt 1, job `90509696884`, failed in shard 5/5 with
  `Error: [vitest-worker]: Timeout calling "onTaskUpdate"`: 52/60 files and 349/373 tests
  reported passed; shards 1/5 through 4/5 reached PASS and shard 5/5 started but did not.
- Run `30431553446`, attempt 2, job `90523145592`, failed in shard 2/5 with the same
  `Error: [vitest-worker]: Timeout calling "onTaskUpdate"` signature: 21/60 files and
  127/373 tests reported passed; shard 1/5 reached PASS and shard 2/5 started but did not.
- Run `30443548388`, attempt 1, job `90548277839`, failed on protected-main head
  `9251fe1e136e78d1ace675f8da57559ce0d067f3`. These were two independent failures in one job:
  `tests/peer.test.ts` reported `Error: Test timed out in 5000ms`, while conformance shard 1/5 reported
  `Error: o1-c32.resource-baseline-start driver failed: o1-c32.resource-baseline-start exceeded the
  parent-owned 30000 ms deadline`. The fail-fast harness exposed only 12/60 files and 71/373 tests;
  11/60 files and 70/373 tests passed, no shard reached PASS, and shards 2/5 through 5/5 never started.

The `onTaskUpdate` signature predates #308 and appears on freeze-base run `30171018647`; the same-tree
green run therefore forbids classifying the gate as deterministically broken. The later green run
`30443700946`, attempt 2, job `90581537208`, belongs to different head
`a685e4f668337bbe800f5de65c9b15502ebb6e16` and tree
`3c816681d074648c0e156b60bc11a0e7d708543a`; 60/60 files, 373/373 tests, and 5/5 shards
passed. After the interactive runner listener restart, job assignment improved from 68 minutes to 2 seconds
on runner 21;
Engineering gates completed in 12m46s, Gateway gates in 42m10s, and the CI-safe step took 500 seconds
versus 633 seconds in the red run and 562 seconds in the prior green run. That proves queue recovery and a
healthy machine baseline, but it does not erase the two explicit budget defects on the protected-main tree.

The C32 defect is a missing budget argument: `casePrograms.ts` resource-baseline-start inherits the
30,000 ms default while sibling `restart_case_stack` operations use the 90,000 ms
`C32_STACK_LIFECYCLE_TIMEOUT_MS`; its three child readiness budgets can total 45,000 ms inside that
30,000 ms parent envelope. The Bridge-simulator package likewise inherited Vitest's 5,000 ms default for a
test observed close to that ceiling. The approved gate-repair lane corrects those budgets, adds elapsed-phase
instrumentation and complete shard collection, carries the separately approved concurrency/cache controls,
and leaves Vitest version, `poolOptions.forks.singleFork`, `fileParallelism: false`, and soak constants
unchanged.

The permanent normative wording is R-K in `docs/implementation-plan/00-INDEX.md` section 8.

### 2026-07-29 — R-F: resolve the RES-28 evidence anchor dynamically from protected main (RES-34)

Source: amended operator approval from Barış Tankut on 2026-07-29 after the #308 protected merge and
coordinator review of the freeze/tag provenance.

The semantic-freeze base remains `b3cca906ec90d0068df489407d3e0ce7254a308e` (tree
`e2cf3849e24c1c5b7e5061d35af74ea48a5f77f7`), and no harness-only cherry-pick is required. The
normative surface is byte-identical at the freeze base and protected
`main@9251fe1e136e78d1ace675f8da57559ce0d067f3` (tree
`c2d5bcbff65ad3ec9d89600a2c4e4e4201f771cc`): `docs/specs` resolves to
`614b8bc2273ce4fe4b970e090d2b2c2d89486935` and `packages/protocol` resolves to
`bbc6ebb687118c30d29508771734df754a735b35` at both commits. The reviewed latter tree contains 25
intervening commits and 267 changed files, including 234 in-flight Gateway/Bridge files. The operator
accepts that this delta would not disqualify that tree if it is later resolved and confirmed as the
evidence anchor; `9251fe1e...`/`c2d5bcbf...` remains historical #308 inspection evidence and is not
selected, confirmed, or authorized as the tag target by this amendment.

The RES-28 anchor is the protected main commit on which the complete tag-evidence set is actually produced
green. Before any tag-evidence run is counted, the implementing assistant reports the resolved
protected-main 40-character commit SHA and tree SHA for operator confirmation. A separately generated
harness-only commit is neither required nor preferred. This dynamic-anchor rule supersedes the
2026-07-23 exact-protected-candidate tag-target clause while preserving that earlier record as historical
decision context.

RES-28's retained three-run aggregate, real one-hour reconnect/proxy-churn soak, WSS/Streamable HTTP/SSE
proxy-interoperability evidence, and protected-tag identity validation all remain in force. As an acceptance
predicate of the retained-three-run aggregate class — not a fifth RES-28 evidence class — a mechanically
separate full-Vitest qualification parses all five shard summaries and asserts exactly 60 test files, 373
tests, and 5/5 serial shards; process exit code zero alone does not satisfy that predicate. The prior
`59 files / 365 tests` ledger figure is corrected wherever recorded.

Protected-main push [run 30480038477](https://github.com/BTankut/revAgent/actions/runs/30480038477),
Gateway job [90671414231](https://github.com/BTankut/revAgent/actions/runs/30480038477/job/90671414231),
measured the predicate on `main@9558fc0b1a60757f43f4813b973cc9e589d45a9a` (tree
`b8856d788a961a0557384c7666609fd8fe112ccc`): shards 1/5 through 5/5 each emitted `PASS`, followed by
`[rbp-conformance] cardinality 60 files / 373 tests / 5 shards`. Independently, the `git ls-tree`
inventory under `packages/rbp-conformance/tests` contained 67 tracked paths; filtering it with
`rg -c '\.test\.ts$'` returned `60`. Together these bind the corrected cardinality to protected-main
execution as pre-tag calibration only. They are not a counted RES-28 tag-evidence run, do not select or
confirm the dynamic anchor, and do not expand the R-H evidence set.

This amendment does not authorize a tag-evidence run or creation of `rbp/v1.0.0`. Tag execution and tag
creation each require their own separate operator authorization under
`docs/implementation-plan/00-INDEX.md` section 8.2. The normative resolution is RES-34 in that index.


### 2026-07-31 — RES-28 tag-evidence set completed at the confirmed dynamic anchor (RES-35)

The operator confirmed the RES-34 resolved anchor on 2026-07-30: protected-main commit
`a99f6051da20a7a28469a44be49c9e9e394be0fd`, tree `149c5af8dd7d84e7167ef372955d8fb287dff0d5`. Both
normative subtrees are byte-identical to the semantic-freeze base: `docs/specs` resolves to
`614b8bc2273ce4fe4b970e090d2b2c2d89486935` and `packages/protocol` to
`bbc6ebb687118c30d29508771734df754a735b35`. The full-Vitest acceptance predicate was already measured
at the anchor by protected-main push
[run 30561677613](https://github.com/BTankut/revAgent/actions/runs/30561677613), Gateway job
[90936010823](https://github.com/BTankut/revAgent/actions/runs/30561677613/job/90936010823): shards
1/5 through 5/5 each PASS with `cardinality 60 files / 373 tests / 5 shards`.

Execution was authorized by the operator line "ONAY — RES-28 kanıt yürütme; tag yok" (2026-07-30),
with the mechanical promotion and execution acts delegated by the operator to the coordinator session
the same day. Candidates were rendered by the frozen worktree renderer
(`production-launch-bootstrap.mjs __render-production-launch-review-candidate`); the approval delta per
vector was strictly `schemaVersion` review-candidate/v1 → authority-vector/v2 and `authoritative`
false → true; the authority sets are retained off-repo with manifests, lock records, and read/execute
ACL locks, and the runner wrapper pins the s04 template by SHA-256.

Attempt one (set `rbp-v1.0-a99f6051da20-s14`) aborted 2026-07-30T20:49Z in run 3 at case O1-C37:
"unable to start 3 additional fixtures in the bounded adjacent port range". Root cause was verified on
the evidence host: WinNAT/Hyper-V dynamic TCP port exclusions covering roughly ten blocks of 100–500
ports inside the ephemeral range; runs 1–2 had already passed all 40 cases, so the collision is
probabilistic, and it is also the most plausible mechanism behind the historical EACCES bind
flakiness recorded in #308. Per the harness contract a failed or partial attempt burns the
evidence set, so set `rbp-v1.0-a99f6051da20-s15` was freshly rendered and promoted. The operator
cleared the exclusions with an elevated `winnat` restart on 2026-07-31; the post-restart table
retained only the administered range and four service ports. Environment provisioning on the
vector-source worktree preserved git cleanliness and changed no tracked bytes: `npm ci
--ignore-scripts`, `npm rebuild better-sqlite3 --ignore-scripts=false --foreground-scripts`, and a
passing `verify:native-dependencies`.

The s15 canonical final-evidence chain ran 2026-07-31T01:02:50Z → 02:29:10Z, exit 0, and printed the
literal verdict `RBP FINAL EVIDENCE: PASS`. Retained runs `rbp-v1.0-a99f6051da20-s15-r1/-r2/-r3`:
status passed, consecutive true, 3 of 3 required runs passing, 40 terminal cases per run across both
bindings, aggregate JUnit 120 testcases with 0 failures, suite bodies totalling 1,300,010 ms. Soak
`rbp-v1.0-a99f6051da20-s15-soak`: requested 3,600,000 ms, actual 3,600,015 ms, 720 alternating
cycles, 720 resource samples, status passed, no failure. WSS / Streamable HTTP/SSE
proxy-interoperability evidence was produced inside the retained runs and soak per RES-34. The
evidence root and authority sets are retained off-repo on the evidence host
(`revAgent-freeze-evidence/rbp-v1.0-a99f6051da20-s15` and the sibling authority/plan roots).

Pre-tag identity checks passed at completion: `origin/main` equaled the anchor and no `rbp/*` tag
existed locally or on origin. This record does NOT create or authorize `rbp/v1.0.0`. Tag execution
and tag creation each require their own separate operator authorization under
`docs/implementation-plan/00-INDEX.md` section 8.2, and the annotated tag, when authorized, MUST
resolve to exactly `a99f6051da20a7a28469a44be49c9e9e394be0fd`. The normative resolution is RES-35 in
that index.


### 2026-07-31 — `rbp/v1.0.0` created and identity-validated (RES-36)

The operator created the signed annotated tag directly: tag object
`77ac4190b165cdda775ac30774e7f2886638065d`, message `Freeze O1/RBP v1.0`, SSH-signed with the
operator's ED25519 key, GitHub verification `verified=true, reason=valid`. The coordinator then
independently validated every RES-28 protected-tag identity requirement against the live repository:
the annotated tag resolves to exactly the confirmed anchor `a99f6051da20a7a28469a44be49c9e9e394be0fd`
(not to any later evidence-record commit), the target tree is
`149c5af8dd7d84e7167ef372955d8fb287dff0d5`, the normative subtrees at the tag equal the
semantic-freeze base identities (`docs/specs` `614b8bc2273ce4fe4b970e090d2b2c2d89486935`,
`packages/protocol` `bbc6ebb687118c30d29508771734df754a735b35`), the anchor is an ancestor of
protected `main`, and `refs/tags/rbp/v1.0.0` on origin points at the same tag object.

With this validation the fourth and final RES-28 evidence class closes. Together with RES-35's
completed three-run aggregate, one-hour soak, and proxy-interoperability evidence, **M1 is fully
closed: RBP/1 v1.0 is semantically frozen, evidenced, and tagged.** The tag is immutable: it must
never be deleted, moved, or recreated; any future protocol change is a new version under the O1
versioning rules, never a rewrite of `rbp/v1.0.0`. The normative resolution is RES-36 in
`docs/implementation-plan/00-INDEX.md`.


### 2026-08-01 — Migration-freeze exception: add-in `execute_batch` (RES-5 / P3-T6)

Scope of the exception: `src/revit-plugin/**` gains the `execute_batch` command surface and nothing else.
The seven batchable commands receive a mechanical `ParseRequest`/`ApplyRequest` seam extraction (no behaviour
change), `SocketService` learns one new exception catch, `McpTaskStatusService` advertises the
`batch_atomic` capability descriptor, and the installer payload/manifest are regenerated because the
manifest-freshness gate hard-fails otherwise. No concurrency refactor, no unrelated cleanup, no other
capability. This mirrors the bounded shape of the merged loopback-bind exception (#300).

Authority: RES-28 records that Barış Tankut is the add-in implementation owner and accepts the
batchable-command restrictions and the atomic rollback evidence; RES-5 requires add-in adaptations to land
before pilot entry and assigns the adaptation lane to M3. The operator delegated execution of the M3 lane
to the coordinator session on 2026-07-31.

Frozen-contract basis: O1 §11 (~900-916) atomic:true is a single framed `execute_batch` pass-through
executed as one Revit transaction group, capability-gated on `batch_atomic`; Appendix A.2 (~1674-1727) the
descriptor and the hard eligible/non-batchable command sets; Appendix A.4 (~1758-1835) the request/response
contract, reserved-name set and terminal matrix. `packages/protocol` is untouched (tagged `rbp/v1.0.0`).

Atomic rollback evidence accepted by the owner: all steps execute inside one `TransactionGroup`, assimilated
only on full success and rolled back in full on any step failure, guard or exception, with
`rollback_failure`/`batch_indeterminate` carriers for the degenerate cases. Unit evidence covers the state
machine through the `IAddinBatchTransactionGroup` seam (Contracts 206 -> 255). Real `TransactionGroup`
Start/Assimilate/RollBack against a live `Document`, the single `ExternalEvent` raise and the
no-active-document pre-group path remain live-Revit evidence for the M3 gate's 21-command run.

Delivery note: this changes manifest-bound add-in payload bytes. It does not authorize a NAS publish or a
fleet rollout; the migration release freeze remains in force.


### 2026-08-01 — Migration-freeze exception: add-in cached `get_document_context` (RES-3 / P3-T7)

Scope of the exception: `src/revit-plugin/**` gains the cached `get_document_context` command surface and
nothing else. `Application.cs` subscribes/unsubscribes the document and view lifecycle events that maintain
the snapshot; `SocketService` serves the cached read ahead of the data-plane intake gate exactly as
`mcp_status` already is; `McpTaskStatusService` advertises the `doc_context_cached_v1` descriptor, failing
closed to no advertisement when the capability is out of contract; the installer payload and manifest are
regenerated because the freshness gate hard-fails otherwise. No concurrency refactor, no unrelated cleanup,
no second capability. Same bounded shape as the loopback-bind (#300) and execute_batch (#328) exceptions.

Authority: RES-5 requires add-in adaptations to land before pilot entry and assigns the adaptation lane to
M3; RES-3 makes the add-in's app-event-maintained cached `get_document_context` the document-context source
of record. The operator delegated execution of the M3 lane to the coordinator session on 2026-07-31.

Frozen-contract basis: O1 Appendix A.3 (~1729-1756) result contract, revision monotonicity, cross-field
rules and the substitution PROHIBITION; A.2 (~1669-1672) the exact `doc_context_cached_v1` descriptor.
`packages/protocol` is untouched (tagged `rbp/v1.0.0`). The `doc_context_update` wire shape and the 15 s
poll remain bridge-side and are not part of this exception.

Deliberate serving-path decision: the A.2 descriptor promises `uiThreadRoundTrip:false` at a 15 s poll
cadence, so the command is served before the data-plane intake gate (like `mcp_status`) via the same tracker
read the registered command uses. Routing it through the gated registry path would queue polls behind long
commands and spam the task-status window on every poll. The command.json/commandRegistry entry, installer
payload and installer-smoke command list were still updated exactly as the execute_batch exception did.

Unit evidence: Contracts 255 -> 308. Every produced envelope round-trips through the frozen bridge-side
parser. Real Revit event delivery/ordering, closing-to-closed pairing against native documents, `View`
discipline/level reads and end-to-end socket serving under a busy data plane remain live-Revit evidence for
the M3 gate's 21-command run.

Delivery note: this changes manifest-bound add-in payload bytes. It does not authorize a NAS publish or a
fleet rollout; the migration release freeze remains in force.


### 2026-08-02 — Migration-freeze exception: add-in `mcp_status` Appendix A.2 discovery fields (RES-5 / P3 discovery)

Scope of the exception: `src/revit-plugin/**` gains the Appendix A.2 REQUIRED discovery fields in the
`mcp_status` result and nothing else. `McpTaskStatusService.GetSnapshot` now emits
`addinLoopbackContractVersion`, `addinVersion`, `revit{version,build,processId}`, and
`service{binding,boundAddresses,framing}` alongside the existing task-state fields; `SocketService` captures
the listener's bound address at `Start()` and passes the live Revit version/build/pid; the installer
payload and manifest are regenerated because the freshness gate hard-fails otherwise. No behaviour change to
any command, no concurrency refactor, no other capability. Same bounded shape as the loopback-bind (#300),
execute_batch (#328), and get_document_context (#329) exceptions.

Authority: RES-5 requires add-in adaptations to land before pilot entry and assigns the adaptation lane to
M3; RES-28 records that Barış Tankut is the add-in implementation owner. The operator delegated execution of
the M3 lane to the coordinator session on 2026-07-31.

Frozen-contract basis: O1 Appendix A.2 (~1638-1666) makes these discovery fields REQUIRED — the bridge
confirms the real listener addresses from `service.boundAddresses` with the OS loopback predicate and matches
`revit.processId`/`version` against its own process attestation before it will register a session. The live
add-in previously answered with only `{service:{isRunning,port}}` plus task state, so every discovery probe
failed status validation and no session was ever registered. `packages/protocol` is untouched (tagged
`rbp/v1.0.0`); the field set is copied from the normative `mcp-status.schema.json`, and the live response now
validates against it in strict mode with formats enforced.

Live evidence (PETRUCCI, Revit 2022): the emitted result validates against the frozen `mcp-status` schema;
`revit=2022/22.1.80.32`, `boundAddresses=[127.0.0.1]`; with the fields present the bridge registered a
session (`session_register -> allowed`) and the full Gateway->bridge->add-in data plane executed
`dispatch_invoke` and atomic `invoke_batch` end to end. This was the missing half that kept the chain from
ever running against the real add-in — the loopback fixture implements the contract correctly, which is why
every suite stayed green.

Delivery note: this changes manifest-bound add-in payload bytes. It does not authorize a NAS publish or a
fleet rollout; the migration release freeze remains in force.
