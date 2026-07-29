# RevAgent Implementation Plan — Index, Resolutions & Coordinator Layer

**Status:** Master implementation plan for `docs/TARGET_ARCHITECTURE.md` (2026-07-20), produced from a
full codebase exploration (5 mapping reports, appendix/) and 8 per-package plans (sections 01–08),
cross-reviewed by independent consistency and completeness critics (sections 09–10).
**Audience:** the coding assistant executing the migration, and the operator (Barış).

## How to read this plan — normativity order

1. `docs/TARGET_ARCHITECTURE.md` — closed decisions D1–D12, constraints, open items O1–O11. Never overridden.
2. **This index** — package map, cross-package RESOLUTIONS (RES-*) and GAP assignments. Where a numbered
   section conflicts with a RES-* entry here, **this index wins** (the critics found the conflicts; the
   resolutions below settle them).
3. Sections `01`–`08` — the detailed per-package plans (scope, P-decisions, tasks, estimates, tests, risks).
4. Sections `09`–`10` — the critic reports (rationale for the resolutions; read before disputing one).
5. `appendix/E1..E5` — codebase maps with file:line evidence (grounding for every plan claim).

Plan-level decisions are labeled `P-*` inside sections (proposals; confirmed via the DP checklist in
section 08(g)). Line numbers cite `11020d1`; re-verify before editing code.

---

## 1. Work packages and O1–O11 ownership (corrected, final)

| Pkg | File | Scope | Owns |
|---|---|---|---|
| WP1 | `01-protocol-O1.md` | Bridge↔Gateway RPC protocol spec (RBP/1) | **O1** |
| WP2 | `02-gateway-core.md` | Phase-1 Gateway: north MCP, registry/policy, capability index + deferred schemas (`tool_search`/`tool_schema`), executor dispatch, production RBP ingress, immutable handler-module packaging, **docs-MCP internalization (GAP-3)**, **module packaging seam (O6)**, and Mode-B interface stubs; post-Phase-1: in-house orchestration/provider/context and O2 implementation | **O6**; O2 interfaces now, internals on later activation |
| WP3 | `03-bridge-addin-installer.md` | .NET bridge, add-in adaptation, workstation installer/uninstaller, **bridge self-update incl. its CD lane (GAP-12)** | **O9** |
| WP4 | `04-data-auth-schemas.md` | Postgres schema, OIDC/device auth, licensing, event schema | **O3, O5, O7** |
| WP5 | `05-phase1-infra-cicd.md` | Office host, Compose, tunnel, warm standby, gateway CD, backup/restore | **O10** |
| WP6 | `06-aps-phase2.md` | APS reviewer plane (Phase 2) + Phase-1 seam reservation | **O4** |
| WP7 | `07-admin-plane-migration.md` | Dashboard + usage-intelligence migration, **normative metric-parity table** | **O11** |
| WP8 | `08-sequencing-risks-decisions.md` | Phases, milestones, risks, DP checklist, cutover/rollback runbooks, freeze enforcement, **interim regime (GAP-13)**, **O8 decision + comms** | O8 (decision), O2 (scheduling) |
| **WP9** | §4 below (new) | **Phase-1 designer client: evaluate, deliver, verify (O8 execution)** | O8 (delivery) |

O2 (code-exec sandbox) is a **named deferred package**: owner-on-activation = WP2 team, trigger = post-cutover,
before any local-LLM commitment. Per RES-29, M2 ships only the four non-executable Mode-B interface stubs from
the WP2 plan; runtime, egress, resource-limit, and filesystem decisions remain deferred until O2 activation.

> **Label remap warning:** section 08 uses its own internal package labels that do NOT match the section
> numbering (its "P6" is installer/CI/O9, while file 06 is APS). Read section 08's labels by area name and
> use the table above as the single source of truth (RES-9).

---

## 2. Cross-package RESOLUTIONS (normative; override the sections they amend)

Numbered against the consistency findings (section 09, F1–F21) and cross-plan contradictions (section 10 (f)).

- **RES-1 (F1) — Phase-1 object store = filesystem driver.** `OBJECT_STORE_DRIVER=fs|s3` interface per WP5
  P-HOST-3; no MinIO service in Phase 1. WP4's P-DATA-5 is amended to consume the WP5 driver interface.
- **RES-2 (F2) — Bridge stack = .NET 8 self-contained single-file Windows service** (WP3 P-BRIDGE-1 is the
  decision of record, confirmed at DP-1). WP1 is de-implementation-ized: its journal clause states protocol
  semantics only (durable SQLite-class store, answer-from-journal on redelivery); drop the better-sqlite3/Node
  rationale from WP1.
- **RES-3 (F3) — Doc context = WP3's cached `get_document_context` add-in command** (app-event maintained
  snapshot, 15 s poll). WP1 keeps only the `doc_context_update` wire shape. The poll-existing-commands variant
  is deleted (superseded by RES-5).
- **RES-4 (F4) — Batch command name = `execute_batch`.** Bridge batch behavior is capability-gated per WP1
  P-O1-7: sequential fan-out (`atomic:false` only) until the add-in advertises `batch_atomic`, then single
  framed pass-through executed as one Revit transaction group. Framing-shim (`DetectMessageFraming`) retires
  one release after cutover per WP3's schedule.
- **RES-5 (IRON-3) — Add-in adaptations land BEFORE pilot entry.** The pilot runs the cutover artifact
  (loopback bind, `execute_batch`, `get_document_context`, concurrency fixes included). WP1's "pilot ships
  with the add-in unchanged" is retracted; the iron rule requires the pilot to validate what cutover ships.
  M3 absorbs the add-in adaptation lane.
- **RES-6 (F5) — One normative wipe list, with rollback exclusions.** WP3's uninstaller spec is the wipe list
  of record and MUST embed WP8 P-SEQ-2's trust-anchor exclusions (`bootstrap\`, `prestage\install-revagent-local-bootstrap.ps1`,
  `updater\config\release-trusted-keys.json` preserved until Retire). New WP3 acceptance criterion:
  uninstaller dry-run leaves those paths intact; verified in the P8-T4 VM rehearsal.
- **RES-7 (F6) — WP7 owns the normative metric-parity table** (the O11 pre-cutover gate artifact). WP4's
  scope item is rewritten to: implement in the event schema every field the WP7 table requires.
- **RES-8 (F7) — No `bridge.heartbeat` event type exists.** Heartbeats are state (`devices.last_seen_at` +
  authoritative WSS connection state); only `bridge.connected`/`bridge.disconnected` transitions are events.
  WP7 parity rows 2 and 7 re-target accordingly.
- **RES-9 (F8/F21) — Ownership remap:** O9 (incl. the Windows CD lane that compiles, signs with the existing
  RS256 pinned-key chain, publishes bridge releases, and writes WP4's `bridge_releases` rows) = WP3, adopting
  WP5's CD conventions. Docs-MCP (`installer/revit-api-docs-mcp/`) internalization = WP2. Section 08's
  milestone/gate references are read through the §1 table.
- **RES-10 (F9) — No per-invocation `mcp_status` preflight on the invoke hot path.** The bridge consults
  local `mcp_status` only (a) to feed the heartbeat `revit_status` block and (b) on failure paths to enrich
  the structured `revit_busy` fault. Stated identically in WP1 and WP3.
- **RES-11 (F10/GAP-6) — O2 explicitly deferred with owner and trigger** (see §1). Silence is not deferral.
- **RES-12 (F11/GAP-4) — O6 = WP2.** Module manifest format, registry `executor: internal_mcp` attachment
  seam, versioning/registration lifecycle; sign-off that the CSI module's `gated` class and the docs server
  fit it. WP4 provides storage (`modules`/`tenant_modules`/`instruction_docs`).
- **RES-13 (F12/GAP-1) — O8 split:** WP8 owns the DP-10 decision + rollout comms; WP2 owns the north MCP
  surface; **WP9 (new, §4) owns evaluation/delivery/verification of the actual designer client.** The minimal
  web chat client is a named post-insurance package.
- **RES-14 (F13) — WP6's five seam requirements are binding on WP2/WP4:** registry gains `variants[]` and the
  `dynamic_code`-never-`aps` constraint; schema gains the `aps` executor enum value, variants storage, and
  URN-capable document-id columns. WP6-T1 review is a blocking gate before the WP4 schema freeze.
- **RES-15 (F14) — WP8 owns the cutover and rollback runbooks and the signed rollback criterion.** WP5
  contributes only the infra-side checklist (host, tunnel, standby, DNS checks) as input.
- **RES-16 (F15) — Serial execution is authoritatively enforced at the Gateway dispatcher** (window=1 per
  session). Bridge per-session queue and retained add-in defenses are defense-in-depth.
- **RES-17 (F16) — Drop the `%TMP%\revAgent-instances.json` read** (verified: nothing writes it). Discovery =
  port scan 8080–8085 + `mcp_status` probe + env override.
- **RES-18 (F17) — The §6 `admin` role is realized as `tenant_admin` in Phase 1**; WP7 references `tenant_admin`.
- **RES-19 (F18) — One name:** table `promotion_registry` holding `tool_candidate` rows (WP2 and WP4 identical).
- **RES-20 (F19) — Dashboard liveness renders the Gateway's protocol FSM** (degraded 35 s / disconnected 65 s);
  the legacy 60/300 s thresholds are dropped.
- **RES-21 (F20) — Canonical idempotency key defined once in O1:** the composite string `rsid + "/" + invocation_id`.
  WP3's journal PK and WP4's audit uniqueness constraint reference that exact definition.
- **RES-22 (Codex review, PR #266) — Phase-1 IdP coherence: DP-5 decides; recommended default flips to
  Keycloak-in-Compose.** WP4 chose Keycloak with grounded rationale (MCP OAuth needs dynamic client
  registration, which Entra ID lacks — this directly gates WP9's third-party clients; the office has no
  central IdP today; the on-prem/air-gapped variant needs a local IdP anyway), while WP8's DP-5 default said
  Entra ID and WP5's Compose stack provisioned no Keycloak. Resolution: the Gateway implements generic OIDC
  only (`OIDC_*` config) so both paths stay open; the DP-5 recommended default becomes Keycloak-in-Compose
  (WP5 adds the `keycloak` service + heap-tuned config to the Phase-1 Compose stack when DP-5 confirms);
  Entra ID remains the alternative if the operator confirms an office M365 tenant AND the WP9 client
  evaluation proves OAuth works against it without DCR. WP8's W1-7 operator task "Entra ID app registration"
  is amended to "confirm IdP direction (DP-5)". Section 07's parity rows 2/7 were also amended inline per
  RES-8/RES-20 (same review).
- **RES-23 (2026-07-22 operator checkpoint) — Phase-1 uses the existing authorized ChatGPT/Codex Desktop
  as an external MCP client.** The client owns the Phase-1 agentic loop; the Gateway does not hold an LLM
  API key and does not implement the in-house loop during Phase 1. This is a bounded use of the external
  client path already permitted by D9, not a change to the long-term in-house-loop target. It supersedes
  WP3 P-CODEX-1 and every Phase-1 instruction that says the pilot must be fully off Codex: cutover removes
  the legacy local stdio/NAS registrations, then revAgent registers the selected client's remote MCP path
  and proves end-to-end compatibility. Client installation, subscription, and user session remain the
  user's responsibility. DP-10 selection is closed; WP9 conformance remains a pilot/cutover gate, and a
  failed conformance run blocks the pilot rather than silently selecting another client. DP-6 is not
  applicable to Phase 1 and is removed from the pilot-entry decision gate.
- **RES-24 (2026-07-22 R-F review) — W1-4 has one bounded `ci.yml` exception to P-CD-3.** The Week-1
  authoritative task explicitly requires an additive `gateway-gates` job in `.github/workflows/ci.yml`.
  PR #271 may add that job without changing any existing job or the signed release workflow. This exception
  ends with the M0 skeleton; later Gateway CI/CD follows P-CD-3 through dedicated workflow files.
- **RES-25 (2026-07-22 operator checkpoint) — DP-2 requires WSS primary plus a Streamable HTTP/SSE
  fallback in Phase 1.** This supersedes WP1 P-O1-1's "WSS sole / fallback not built" wording. Both bindings
  carry identical RBP semantics; the fallback remains capability-gated and must have a frozen binding plus
  proxy/interoperability conformance evidence before v1.0/pilot use.
- **RES-26 (2026-07-22 R-F review) — Nested batch delivery is inline-only and fail-closed.** RBP/1 defines
  chunk and artifact carriers only for a top-level invocation, not for a nested batch step. Every method
  admitted to either atomic or non-atomic `invoke_batch` therefore requires a session-local add-in
  descriptor with `resultDelivery:"inline_only"` and `maxInlineResultBytes:8388608`. Atomic
  `execute_batch` also receives the connection-negotiated `maxAggregateResultBytes`, validates each nested
  result and the tentative aggregate before `TransactionGroup.Assimilate()`, and rolls back on a delivery
  contract violation. A non-atomic post-dispatch violation stops successors and reports terminal
  `protocol` with explicit `effect_state`; it never fabricates success, creates an unreachable carrier, or
  leaks an add-in-local path. A malformed atomic committed carrier is indeterminate, not repaired by
  inference. This is a protocol clarification required by executable W1 evidence, not a relaxation of the
  batch or conformance gates.
- **RES-27 (2026-07-25 R-F review) — Windows CI rematerializes the protected HEAD bytes after checkout.**
  The M1 source-identity gate raw-hashes every tracked file and intentionally ignores Git clean filters.
  A reused self-hosted Windows worktree can therefore remain physically CRLF even after a new
  `eol=lf` rule makes Git's normalized status clean. Both existing Windows jobs in `.github/workflows/ci.yml`
  stream `git archive --format=tar HEAD` directly into `tar -xf -` under `cmd` immediately after checkout,
  refresh tracked index stat data with `git add --update`, and fail unless both the staged index and
  worktree remain equal to HEAD. This overwrites all tracked paths with the exact protected blob bytes
  before any test executes. This is a bounded M1
  source-integrity correction to RES-24; it does not add a job, alter a release workflow, or weaken the
  exact-byte gate.
- **RES-28 (2026-07-25 R-F/operator closing review) — M1 semantic freeze and the `rbp/v1.0.0` tag
  closure are separate gates.** One complete green Section 21 suite on the exact current PR candidate,
  its protected check rollup, the remaining Section 22 M1 evidence, and protected tree-equal
  squash merge are sufficient to freeze RBP/1 and close M1. Barış Tankut is the add-in implementation
  owner and accepts the batchable-command restrictions and atomic rollback evidence. The tag MUST NOT
  be created by the M1 merge. It requires a separate retained three-run aggregate, a real one-hour
  reconnect/proxy-churn soak, WSS/Streamable HTTP/SSE proxy-interoperability evidence, and protected-tag
  identity validation. Tag-evidence work may run in parallel with M2/M3; its
  absence or incompleteness does not block their start. A substantive semantic
  or safety finding still follows R-F and the affected gate remains red.
  M2/M3 execution still requires its separately authorized operator kickoff.
- **RES-29 (2026-07-25 R-F/operator kickoff) — M2 keeps the external-client boundary and the
  registry-driven Mode A discovery surface.** The authorized ChatGPT/Codex Desktop client owns Phase-1
  conversation state, model calls, planning, retries, and the agentic loop; the Gateway has no LLM key,
  provider adapter, prompt projection, planner/router, or sub-agent loop. M2 still delivers the north MCP
  Streamable HTTP + OAuth seam, Tool Registry, a byte-stable capability index, deferred schemas through
  `tool_search`/`tool_schema`, a small pinned callable set, registry/policy/confirmation middleware, executor
  dispatch to bridge/internal executors, production RBP ingress, docs-MCP internalization, and immutable
  content-hashed handler packaging from unchanged frozen sources. Mode B is interface stubs only; O2 remains
  explicitly deferred under RES-11. M2 imports the frozen RBP/1 package and MUST NOT edit
  `packages/protocol/**` without a new dated R-F amendment plus operator approval. M2 code merges require the
  dedicated Gateway CI lane; the bounded RES-24 `ci.yml` exception ended at M0. M4 is a separate
  external-client vertical slice and cannot begin before operator-channel M2 closure approval. This is a
  bounded Phase-1 use of D9's external-client path and does not reopen D1-D12 or remove the eventual in-house
  loop target. RES-33 governs the north MCP SDK generation and dual-era delivery mechanics without changing
  this scope.
- **RES-30 (2026-07-28 R-F/operator decision) — the M3 gate's `enrollment` item is split by evidence
  boundary.** The M3 row in section 08 names `enrollment` without distinguishing bridge-side protocol
  completeness from end-to-end proof, but end-to-end enrollment evidence requires a real Gateway issuing and
  revoking device tokens, and the Gateway is M2 work on a parallel lane. M3 therefore requires only the
  **bridge side**: protocol-complete enrollment (single-use enrollment-token intake, device-token exchange
  message flow, DPAPI-machine persistence, re-enrollment path, fail-closed refusal when credentials are
  absent or rejected), demonstrated green against the M1 Gateway stub. **Deferred to M4**: token exchange
  against a real Gateway, revoked-device refusal at handshake, and device-token persistence across reboot,
  because M4 is already the first milestone that stands up a Gateway on the office host. This splits where
  the evidence can be produced; it does not weaken any enrollment requirement, and every deferred item stays
  a named M4 entry criterion. M3's other gate items — persistent WSS, invocation → add-in TCP framing,
  idempotency journal, and batch-as-transaction-group — are unchanged and remain M3-blocking.
- **RES-31 (2026-07-28 R-F/operator decision) — the dedicated M2 Gateway CI lane uses GitHub-hosted
  Linux; the self-hosted deploy runner remains deferred to M6.** `.github/workflows/gateway-ci.yml` runs on
  `ubuntu-latest` with Node 24 and is path-filtered to `packages/gateway/**` plus its own workflow file to
  protect the private-repository Actions minute budget. It verifies the triggering PR/push exact head, runs
  install, Gateway lint/typecheck/tests, a secret scan, and a Gateway image build. Existing Windows
  `Engineering gates` and `Gateway gates` in `ci.yml` remain byte-for-byte unchanged because the conformance
  and production-launcher identity gates are Windows-specific. P5-T5 is not cancelled: the Linux
  self-hosted runner and `gateway-cd.yml` deploy execution move to M6. When activated on this personal
  repository, the operator-approved compensating control is a root-owned `GITHUB_WORKFLOW_REF` pre-job
  allowlist for only `gateway-ci.yml`/`gateway-cd.yml`, an unprivileged no-sudo account, rootless Docker, and
  denied `/opt/revagent/env` access. No runner is installed or registered during M2; organization transfer
  remains a post-cutover/SaaS option.
- **RES-32 (2026-07-28 R-F/operator correction) — the required `Gateway CI` context runs on every pull
  request; only `push: main` remains path-filtered.** A required workflow skipped by a `pull_request.paths`
  filter leaves non-Gateway PRs waiting indefinitely for an expected context, which would block the M3
  `packages/bridge/**` and `src/revit-plugin/**` lanes. Therefore `gateway-ci.yml` has no pull-request path
  filter and always reports `Gateway CI` for PR heads. The `push` trigger remains limited to
  `packages/gateway/**` plus the workflow file itself. Measured successful runs are approximately 54–63
  seconds, so the bounded private-repository minute cost is accepted in exchange for eliminating the
  repository-wide merge deadlock. RES-31's runner, exact-head, Node 24, install, lint, typecheck, test,
  secret-scan, image-build, Windows-workflow freeze, and M6 deferral decisions are otherwise unchanged.
- **RES-33 (2026-07-28 operator decision; 2026-07-29 R-F record) — M2 adopts MCP TypeScript SDK v2
  without a flag-day client cut.** The Gateway-owned north surface uses
  `@modelcontextprotocol/{server,client,core,node}@2.0.0` with Zod `^4.2` and composes its single
  2026-style session-server factory through `createMcpHandler(factory)` and `toNodeHandler` with
  `legacy: "stateless"`. The surface MUST implement `server/discover`; `legacy: "reject"` and any
  2026-only Phase-1 serve mode are forbidden. When a flow carries server state, that state is accepted only after
  `createRequestStateCodec({ key, ttlSeconds, bind })` HMAC verification through
  `ServerOptions.requestState.verify`; required-but-missing, malformed, expired, tampered, or
  authorization-context-mismatched state fails closed. Gateway invocation correlation is generated by the
  Gateway and is independent of MCP transport/session identity. Local HTTP validation MUST preserve the SDK's
  `-32020` (`HeaderMismatch`) and `-32022` (`UnsupportedProtocolVersion`) response bodies. This amends only
  RES-29's north MCP delivery mechanics; the external-client ownership boundary, no-Gateway-LLM rule, frozen
  RBP/1 contract, and M2-to-M4 stop boundary remain unchanged.

---

## 3. Completeness-gap assignments (binding scope additions)

From section 10; each owner folds these into its package before starting it.

| Gap | Pri | Owner | Binding content |
|---|---|---|---|
| GAP-2 confirm round-trip | P0 | WP2 + WP9 | Normative confirm flow over plain MCP: preview result + expiring single-use `confirm_token` re-invocation, journal-linked to the originating preview `invocation_id`; approval and commit audit rows retain that preview id plus `confirmation_id`; conformance test against the chosen client. |
| GAP-3 docs-MCP relocation | P0 | WP2 | Register `revit-api-docs` tools as `internal_mcp`; include them in the Phase-1 capability index and deferred-schema/search surface, and include pilot scenarios. Capability must NOT be silently lost at cutover. |
| GAP-13 interim regime | P0 | WP8 (+WP5) | See §5 — execute the first two items THIS WEEK, before build starts. |
| GAP-5 instruction-layer rewrite | P1 | WP2, WP8 gates | Rewrite AGENTS/SKILL content for remote names, external-client loop ownership, server confirmation, and file resources; version in registry and pass the applicable `evals/evals.json` cases before pilot. The later in-house-loop instruction variant activates only with its milestone. |
| GAP-7 packaged-handler local deps | P1 | WP2 + WP1/WP9 | Inventory + per-tool disposition: spatial SQLite/PowerShell behavior is re-keyed tenant+device+document gateway-side or disabled-at-cutover with operator sign-off; Excel/CSV uses authenticated client upload; exported images use authorized multi-file MCP resources. There is no generic RBP `file_fetch`. Package enabled handlers as hash-bound build artifacts without moving frozen source, and stress-test WP2's packaging estimate. |
| GAP-12 bridge CD lane | P1 | WP3 | Windows-runner lane: build .NET bridge → sign manifest (RS256 pinned chain) → publish artifacts → write `bridge_releases`/channel rows; pilot→stable promotion discipline mirrors today's CD. Blocks Build-exit criterion 5. |
| GAP-9 assistant-down UX | P2 | WP3 + WP8-T6 | Bridge tray/status behavior when gateway unreachable; "assistant-down ≠ Revit-down" comms text. |
| GAP-10 D6 Phase-1 posture | P2 | WP2 + WP8 | One paragraph: single-namespace Phase 1 satisfies D6 trivially; milestone for planner/router + sub-agents activation. |
| GAP-11 runner trust boundary | P2 | WP5 | Runner user isolation, runner-group restricted to the deploy workflow, statement that repo-write ⇒ prod-adjacent access. |
| GAP-8 Extended Properties | P2 | WP6 | Scope line or explicit deferral in the Phase-2 package. |
| GAP-14 Codex app drift | P1 | WP8-T7 | Risk-register entry: Codex desktop self-updates during freeze; trigger = fleet-wide Codex MCP failures; mitigation = emergency-patch path (§5.3). |
| GAP-15 dev coexistence | P2 | WP3 | "One driver at a time" rule for dev machines (old runtime's tmpdir lock vs bridge queue don't interlock), or bridge honors the lock dir during coexistence. |
| GAP-16 parity baseline | P2 | WP7 + WP8 log | Pilot-entry precondition: old telemetry chain stays alive through the pilot; operator signs the Phase-1 prompt-level-data loss explicitly. |
| EST-1 estimates | P1 | WP8 | P8-T1 re-estimated to ~2 d; re-run estimate sanity on all full tables; the critic saw only truncated inputs. |

**Iron-rule watch items** (section 10 (e)) are binding: (1) after WP2's repo-side refactor, an emergency NAS
hotfix must remain rebuildable — CI installer-contract suite green post-move + one archived behavioral diff of
the rebuilt `build/index.js`; (2) the pilot must run on the SAME client stack cutover ships (WP9); (3) add-in
adaptations sequenced before pilot (RES-5).

---

## 4. WP9 — Phase-1 designer client (O8 execution) — NEW package

**Why:** the critics' #1 practical finding — as originally drafted, no package owned registering and proving
the client a designer uses after the legacy local MCP path is removed. ~11 of 12 fleet users are
Turkish-speaking designers, not CLI users.

**Scope:** (1) DP-10 selected the existing authorized ChatGPT/Codex Desktop client on 2026-07-22. WP9 now
verifies it against the written matrix: Streamable HTTP + OAuth (with DCR per WP4's IdP), the GAP-2 confirm
round-trip, streaming, local-file workflows (Excel reconciliation, exported-image viewing — GAP-7),
Turkish-friendly non-developer UX, and supportability. Claude and other compliant MCP clients remain
comparison/fallback candidates only; changing the selection requires a dated DP-10 amendment.
(2) Client installation, subscription, and user session are user-owned prerequisites. revAgent owns remote
MCP registration instructions and end-to-end conformance evidence.
(3) Delivery: remote-MCP registration and smoke steps, contributed to the WP8-T4 cutover runbook;
conformance test (login → read query → confirm-class write → result visible in Revit).
(4) Pilot binding: the pilot user works ≥5 real workdays fully off the legacy local stdio/NAS path on the
selected client before pilot exit. (5) The WP8-T6 quickstart/retraining pack is written for that remote path.

**Estimate:** 4–6 dev-days; client subscription remains user-owned. **Dependencies:** WP2 north surface
(M2), WP4 OIDC (M5). **Gates:** DP-10 selection is closed; conformance must be green before M8 entry.

---

## 5. Interim regime until cutover (GAP-13 — operational, starts NOW)

The fleet keeps working on the frozen NAS stack (stable `2026.07.20.574-11020d1a`) for the entire Build.
Binding rules:

1. **Publish freeze, mechanized this week:** lock the `revagent-production-publish` environment (or add a
   freeze-flag guard step) in `signed-source-free-cd.yml` so an accidental dispatch cannot reach the fleet.
   Unlock procedure documented as part of item 3.
2. **Updater abstinence:** comms to all users — do not run the STABLE updater/GUI until cutover (it exits 84
   by design). Verify the workstation scheduled update tasks are no-ops with the channel frozen — verify,
   not assume.
3. **Emergency security-patch exception:** one sanctioned path — logged, operator-approved NAS hotfix publish,
   gated by the CI installer-contract suite; requires the iron-rule rebuildability evidence (§3) to stay valid.
4. **Pilot machine:** disable the NAS updater scheduled task (do NOT delete the bootstrap — it is the pilot
   rollback path); inverse step recorded in the rollback runbook.
5. **No publishes touching the 8 release-bound bootstrap components** (K0, PR #260 record) — subsumed by
   rule 1 but stated for the emergency path.

---

## 6. Milestones & calendar (summary — full detail in section 08)

M0 decisions/scaffold/spike → **M1 O1 spec frozen** → M2 north MCP + registry/capability index/deferred
schemas + policy/dispatch + RBP ingress + Mode-B stubs ∥
M3 bridge + add-in adaptations (RES-5) → M4 pre-production-auth vertical slice (external client → gateway →
bridge → live Revit, incl. confirm flow) →
M5 auth/data → M6 installer/uninstaller/self-update + bridge CD lane (GAP-12) → M7 ops readiness (O10 drill,
O11 parity) → M8 pilot (≥5 real workdays, on the WP9 client, self-update proven) → M9 fleet cutover
(~12 machines, one window) → M10 insurance (2 wks) → Retire.

Critical path ≈ 108 dev-days; program total ≈ 138–153 dev-days; **cutover at ~23–24 working weeks, NAS
retirement at ~6.5–7 months** (20% Build contingency included). Backfill lanes during pilot/insurance:
WP7 dashboards and WP2 external-client/registry/dispatcher hardening; then post-Retire or a separately approved
activation milestone: in-house router/sub-agents/projection, APS (WP6 Phase 2), web chat client, and O2.

**Additional pilot-entry gates from this index:** WP9 client chosen + conformance green; GAP-5 instruction
rewrite evaluated; GAP-16 old telemetry alive; GAP-13.4 pilot updater task disabled.

---

## 7. Operator decision checklist (confirm before build — full one-pagers per DP in section 08(g))

DP-1 bridge tech (.NET 8, confirmed) · DP-2 transport (WSS primary + Streamable-HTTP/SSE fallback,
confirmed) · DP-3 tunnel (Cloudflare, `revagent-gateway-prod`, confirmed) · DP-4 domain
(`gateway.revagent.app`, confirmed) · DP-5 IdP (recommended: Keycloak-in-Compose per RES-22;
Entra ID alternative gated on M365 tenant + WP9 OAuth verification) · DP-6 not applicable to Phase 1
(external-loop client; no Gateway LLM key) ·
DP-7 seats (named) · DP-8 host confirmed and live SSH/resource proof retained; router has no dual-WAN/LTE
and the operator accepted WAN-outage risk on 2026-07-22 · DP-9 update signing (reuse RS256 chain) ·
**DP-10 existing ChatGPT/Codex Desktop remote-MCP conformance (selection confirmed; WP9 gate)** · DP-11
backup target · DP-12 dedicated/SSH-ready `NET01` confirmed, with pilot user/window still pending · DP-13 monorepo layout
(`packages/gateway|bridge|protocol`, confirmed) · DP-14 Node MSI disposition · DP-15 historical-data archive
location. Gate mapping: DP-1/2/13 before build; DP-3/4/8/9/10-conformance/12 before pilot; rest before
cutover.

---

## 8. Rules for the implementing assistant

- **R-A Per-package, per-milestone PRs.** No omnibus squashes (the #258 lesson: architectural consequences
  hide in big merges). Each PR names its WP + milestone and checks the relevant RES/GAP items.
- **R-B Spec-first.** No bridge/gateway transport code before O1 v0.9 exists; M1 freeze before M2/M3 merge.
- **R-C Demo-based gates.** A milestone is exited by its scripted demo, not by a document.
- **R-D Freeze discipline.** Feature freeze (P-SEQ-4 mechanized) + release freeze (§5). Legacy CI suites stay
  green through Retire; a red legacy suite during Build is a freeze-violation signal.
- **R-E Iron rule.** The old path is never removed before the new path has carried real traffic — see §3
  watch items for the three places this is at risk.
- **R-F Amendment protocol.** If implementation reveals a RES-* or section decision to be wrong, do not
  silently diverge: record a dated amendment in `docs/decisions/DP-log.md` and update this index.
- **R-G Operator task cards.** Whenever an operator action remains, every implementation report MUST end
  with a separate, non-optional `## OPERATÖR GÖREV KARTLARI` section. Each card MUST state: (1) **NE** —
  exact numbered steps, commands, and screens; (2) **NEDEN** — the gate or milestone it opens; (3) **NE
  ZAMANA KADAR** — the blocked gate and latest required point; (4) **KANIT** — the exact evidence location;
  and (5) **CEVAP FORMATI** — the single-message reply that is sufficient to continue. Operator work MUST
  never remain only embedded in a plan or runbook. The implementing assistant MUST use its available SSH
  access to `bt@192.168.90.154` and execute every server-side action it can safely perform, retaining command
  output as evidence. Only account authorization, physical/network work, decisions, and user communications
  remain operator-owned.
- **R-H Evidence ceiling.** For every milestone, the required evidence is exactly the evidence named by its
  authoritative plan/gate definition. The implementing assistant MUST NOT unilaterally add, strengthen,
  multiply, or make blocking any evidence run or repetition beyond what that
  authoritative gate requires, including commit-by-commit three-run aggregates
  or soak tests. Required current-head CI and other runs already named by the
  gate remain required. If additional gate evidence appears necessary, the assistant MUST first present
  the proposed evidence, rationale, cost, and affected gate in an R-G operator task card and wait for explicit
  operator authorization. Routine diagnostics and already-produced supplementary evidence may be retained
  and reported, but remain non-blocking and MUST NOT redefine the gate.
- **R-I Merge verification.** A PR MAY be reported as merged only after `origin` actually shows it merged:
  PR `state=MERGED` plus a merge commit SHA on the target branch. The merge command's empty or silent
  output is NOT success — protected-branch rules (for example a `BEHIND`/`blocked` head, or a required
  check missing for the current head SHA) can reject a merge without an error message. After every merge
  attempt the assistant MUST verify with `gh pr view <n> --json state,mergeCommit` (or an equivalent API
  read) before reporting, and MUST correct any earlier report proven wrong by that check.

### 8.1 2026-07-23 operator execution checkpoint

This checkpoint controls the current implementation assistant without
rewriting the work-package architecture:

1. When M1 is ready, open the freeze PR as **draft** and stop after presenting
   the gate-demo evidence, final v0.9→v1.0 diff summary, and complete
   conformance result. Do not ready or merge the PR and do not create
   `rbp/v1.0.0`. No later milestone begins before explicit operator-channel
   closing approval.
2. After that approval, this assistant works only in WP2/M2 on
   `codex/wp2-*` branches. It does not edit `packages/bridge/**` or
   `src/revit-plugin/**`. Any `packages/protocol/**` change first requires the
   dated R-F amendment procedure.
3. WP3 remains the architectural owner of M3 bridge/add-in/installer work, but
   M3 execution belongs to a separate assistant. The current assistant does
   not continue, ready, or merge M3 work.
4. Pre-checkpoint M2 planning is retained on hold in draft PR
   [#288](https://github.com/BTankut/revAgent/pull/288). Its proposed M2
   amendment collides with the already authoritative nested-batch `RES-26`;
   after M1 approval WP2 must resolve that collision through a newly numbered,
   dated R-F amendment, never by silently replacing either record.
5. Pre-checkpoint M3 planning is retained as the frozen handoff draft PR
   [#289](https://github.com/BTankut/revAgent/pull/289). It is evidence of
   handoff state, not permission to advance M3.

### 8.2 2026-07-25 M1 closing approval

This checkpoint supersedes §8.1 only for M1 closing and the next-lane start:

1. `M1 KAPANIŞ: ONAY`. Barış Tankut is the add-in implementation owner and
   accepts the batchable-command restrictions and atomic rollback evidence.
2. Draft PR [#290](https://github.com/BTankut/revAgent/pull/290) is authorized
   to become ready, pass the protected required gates, and squash merge to
   `main`. That protected merge freezes the RBP/1 contract and closes M1.
3. Do not create `rbp/v1.0.0` during this close. RES-28's separate,
   non-blocking tag-evidence lane may proceed in parallel with M2/M3 only after
   its own authorized task.
4. The current assistant stops after the protected merge and closeout report.
   Neither M2 nor M3 starts from this approval; each requires a separate,
   authorized kickoff. The §8.1 package/assistant lane boundaries remain in
   force.

### 8.3 2026-07-25 WP2/M2 kickoff

This checkpoint authorizes only the WP2/M2 lane:

1. Rebase draft PR [#288](https://github.com/BTankut/revAgent/pull/288) onto
   the protected M1-close `main`, preserve RES-26/27/28, renumber its
   colliding amendment to RES-29, pass the normal docs-only protected gates,
   and merge it before M2 implementation starts.
2. M2 work uses `codex/wp2-*` branches and task-sized `[WP2][M2]` draft PRs.
   It may edit `packages/gateway/**` and Gateway-owned documentation only.
   `packages/bridge/**` and `src/revit-plugin/**` are closed to this lane.
3. `packages/protocol/**` is frozen RBP/1 input. M2 imports it without edits.
   Any discovered contract defect requires a new dated R-F amendment and
   explicit operator approval before that path changes.
4. Phase 1 uses ChatGPT/Codex Desktop as the external MCP client. M2 builds
   the north MCP Streamable HTTP + OAuth seam, registry/capability index,
   deferred schemas via `tool_search`/`tool_schema`, bridge/internal executor
   dispatch, Mode-B interface stubs, and docs-MCP internalization. It does not
   build an in-house agentic loop or introduce a Gateway LLM key/provider.
5. The first implementation PR proves the north endpoint skeleton,
   registry-derived capability index, and one executor-dispatched tool against
   the M1 bridge simulator. M2 exits only through its authoritative gate demo
   and report. The assistant then stops; M4 requires a separate
   operator-channel closing approval.

## 9. Week 1 (starts tomorrow)

Section 08(h) is the authoritative list: DP checkpoint session; monorepo scaffold (`packages/*`, existing dirs
untouched); O1 spec v0.9 draft; CI skeleton (`gateway-gates` job + freeze clause); transport spike (35-tool
catalog served over Streamable HTTP — swap point `installer/runtime-mcp-server/src/index.ts:19-20`); Phase-1
Compose skeleton; parallel operational work split by R-G (the implementing assistant owns SSH-executable
host reachability, tunnel connector/origin preparation, and DNS/TLS proof; the operator owns IdP/account
authorization, physical/network changes, decisions, and user communications). The router has no dual-WAN/LTE
and the operator accepted WAN-outage risk; there is no Phase-1 Gateway LLM key per RES-23. Include the
plan/rollback/comms artifact skeletons. **Plus from this index:** GAP-13 items 1–2 (publish-freeze
lock + updater-abstinence comms) and the WP9 evaluation matrix draft.
