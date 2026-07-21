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
| WP2 | `02-gateway-core.md` | Gateway core: orchestration, provider layer, tool registry, north MCP surface, context projection, runtime relocation, **docs-MCP internalization (GAP-3)**, **module packaging seam (O6)**, Mode-B stubs | **O6**; O2 interfaces (stub only) |
| WP3 | `03-bridge-addin-installer.md` | .NET bridge, add-in adaptation, workstation installer/uninstaller, **bridge self-update incl. its CD lane (GAP-12)** | **O9** |
| WP4 | `04-data-auth-schemas.md` | Postgres schema, OIDC/device auth, licensing, event schema | **O3, O5, O7** |
| WP5 | `05-phase1-infra-cicd.md` | Office host, Compose, tunnel, warm standby, gateway CD, backup/restore | **O10** |
| WP6 | `06-aps-phase2.md` | APS reviewer plane (Phase 2) + Phase-1 seam reservation | **O4** |
| WP7 | `07-admin-plane-migration.md` | Dashboard + usage-intelligence migration, **normative metric-parity table** | **O11** |
| WP8 | `08-sequencing-risks-decisions.md` | Phases, milestones, risks, DP checklist, cutover/rollback runbooks, freeze enforcement, **interim regime (GAP-13)**, **O8 decision + comms** | O8 (decision), O2 (scheduling) |
| **WP9** | §4 below (new) | **Phase-1 designer client: evaluate, deliver, verify (O8 execution)** | O8 (delivery) |

O2 (code-exec sandbox) is a **named deferred package**: owner-on-activation = WP2 team, trigger = post-cutover,
before any local-LLM commitment; WP2's four stub interfaces are its frozen contract (RES-11).

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

---

## 3. Completeness-gap assignments (binding scope additions)

From section 10; each owner folds these into its package before starting it.

| Gap | Pri | Owner | Binding content |
|---|---|---|---|
| GAP-2 confirm round-trip | P0 | WP2 + WP9 | Normative confirm flow over plain MCP: preview result + expiring single-use `confirm_token` re-invocation, journal-linked to `invocation_id`; approval itself is an audit event (who/when); conformance test against the chosen client. |
| GAP-3 docs-MCP relocation | P0 | WP2 | Register `revit-api-docs` tools as gateway-internal executor; capability index; pilot scenario list. Capability must NOT be silently lost at cutover. |
| GAP-13 interim regime | P0 | WP8 (+WP5) | See §5 — execute the first two items THIS WEEK, before build starts. |
| GAP-5 instruction-layer rewrite | P1 | WP2, WP8 gates | Rewrite AGENTS/SKILL content for new tool names, in-house loop, confirm flow (today's content is Codex-desktop-specific); version in registry; eval pass (`evals/evals.json`) before pilot. |
| GAP-7 relocated-tool local deps | P1 | WP2 + WP1/WP9 | Inventory + per-tool disposition: spatial SQLite store is workstation-local (`spatialStore.ts:776-780`) and spawns PowerShell (`:708-721`) → re-key tenant+device gateway-side or disable-at-cutover with operator sign-off; Excel reconciliation needs a file-ingress path (RBP/1 `file_fetch` message or client-side upload — decide in DP-10 context); exported-image paths must surface usably in the new client. Stress-test WP2's relocation estimate against this. |
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

**Why:** the critics' #1 practical finding — as originally drafted, no package delivered the thing a designer
opens and types into after Codex desktop is removed at cutover. ~11 of 12 fleet users are Turkish-speaking
designers, not CLI users.

**Scope:** (1) Candidate evaluation against a written matrix: Streamable HTTP + OAuth (with DCR per WP4's
IdP), the GAP-2 confirm round-trip, streaming, local-file workflows (Excel reconciliation, exported-image
viewing — GAP-7), Turkish-friendly non-developer UX, per-seat cost, manageability. Candidates: Claude
Desktop (default for designers), Claude Code (developers/power users), other compliant MCP clients.
(2) DP-10 becomes a Build-phase decision with a licensing/cost line, recorded before pilot entry.
(3) Delivery: per-machine install/config/login/MCP-registration steps, contributed to the WP8-T4 cutover
runbook; conformance test (login → read query → confirm-class write → result visible in Revit).
(4) Pilot binding: the pilot user works ≥5 real workdays fully off Codex on the chosen client before pilot
exit. (5) The WP8-T6 quickstart/retraining pack is written against the chosen client.

**Estimate:** 4–6 dev-days + license procurement (operator). **Dependencies:** WP2 north surface (M2), WP4
OIDC (M5). **Gates:** DP-10 closed before M8 entry; conformance test green on the chosen client.

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

M0 decisions/scaffold/spike → **M1 O1 spec frozen** → M2 gateway minimal loop ∥ M3 bridge + add-in
adaptations (RES-5) → M4 vertical slice (client → gateway → bridge → live Revit, incl. confirm flow) →
M5 auth/data → M6 installer/uninstaller/self-update + bridge CD lane (GAP-12) → M7 ops readiness (O10 drill,
O11 parity) → M8 pilot (≥5 real workdays, on the WP9 client, self-update proven) → M9 fleet cutover
(~12 machines, one window) → M10 insurance (2 wks) → Retire.

Critical path ≈ 90 dev-days; program total ≈ 120–135 dev-days; **cutover at ~19–20 working weeks, NAS
retirement at ~5.5–6 months** (20% Build contingency included). Backfill lanes during pilot/insurance:
WP7 dashboards, WP2 hardening (router, sub-agents, projection), then post-Retire: APS (WP6 Phase 2), web
chat client, O2.

**Additional pilot-entry gates from this index:** WP9 client chosen + conformance green; GAP-5 instruction
rewrite evaluated; GAP-16 old telemetry alive; GAP-13.4 pilot updater task disabled.

---

## 7. Operator decision checklist (confirm before build — full one-pagers per DP in section 08(g))

DP-1 bridge tech (.NET 8, default) · DP-2 transport (WSS primary + Streamable-HTTP fallback) · DP-3 tunnel
(Cloudflare) · DP-4 domain (`gateway.<domain>`) · DP-5 IdP (recommended: Keycloak-in-Compose per RES-22;
Entra ID alternative gated on M365 tenant + WP9 OAuth verification) · DP-6 LLM provider/models/region ·
DP-7 seats (named) · DP-8 host hardware + LTE failover · DP-9 update signing (reuse RS256 chain) ·
**DP-10 designer client + licensing (WP9 — now a Build-phase gate)** · DP-11 backup target · DP-12 pilot
machine/user + cutover date · DP-13 monorepo layout (`packages/gateway|bridge|protocol`) · DP-14 Node MSI
disposition · DP-15 historical-data archive location. Gate mapping: DP-1/2/13 before build; DP-3/4/6/8/9/10/12
before pilot; rest before cutover.

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

## 9. Week 1 (starts tomorrow)

Section 08(h) is the authoritative list: DP checkpoint session; monorepo scaffold (`packages/*`, existing dirs
untouched); O1 spec v0.9 draft; CI skeleton (`gateway-gates` job + freeze clause); transport spike (35-tool
catalog served over Streamable HTTP — swap point `installer/runtime-mcp-server/src/index.ts:19-20`); Phase-1
Compose skeleton; operator parallel tasks (domain, tunnel account, Entra app, host prep, LLM key/region);
plan/rollback/comms artifact skeletons. **Plus from this index:** GAP-13 items 1–2 (publish-freeze lock +
updater-abstinence comms) and the WP9 evaluation matrix draft.
