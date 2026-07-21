> Independent review report over sections 01-08. Its findings are resolved normatively in `00-INDEX.md`
> (RES-* and GAP-* entries); this report is retained as the rationale record.

# COMPLETENESS CRITIC REPORT — vs docs/TARGET_ARCHITECTURE.md (read in full, §1–§10, D1–D12, O1–O11)

Note on inputs: the plan sections as delivered to me are TRUNCATED mid-document (P1 cut in envelope spec §2; P2 cut inside P-GW-11; P3 cut inside P-ENROLL-1; P4 cut inside schema list at `seat_assignments`; P5 cut inside P-MON-1; P6 cut inside P6-T2; P7 cut at parity row 11; P8 cut inside Phase 2). Findings below are based on visible content; where a gap could plausibly live in a truncated tail I say so. Estimate review (b) is limited to the only visible estimate tables (P6 Phase-1, P8).

---

## (a) ARCHITECTURE REQUIREMENTS NOT COVERED, OR COVERED HAND-WAVILY

### GAP-1 [P0] — O8 / §5.5 Phase-1 client is ORPHANED: no package delivers the designers' daily driver
- Evidence of orphaning: P2 non-goals list "web chat client (O8)"; P3 non-goals list "web client (O8)"; P4 non-goals list it; P5 non-goals list it; P8 P-SEQ-3 defers the web client past the insurance window and says "Phase 1 uses existing MCP clients against the north MCP surface per O8/§5.5" — but no package owns selecting, installing, configuring, authenticating, or verifying that client. P8's own area-label map assigns "Phase-1 client scope (O8)" to its "P7", but the actual P7 section (admin migration) contains zero O8 content. P8-T6 produces a quickstart "per DP-10", but no package produces the DP-10 evaluation itself.
- **Owner: NEW work package (or explicit adoption by P2), sequenced by P8 as a pilot-entry gate.** Minimum content: (1) candidate evaluation (Claude Code, Claude Desktop, other Streamable-HTTP+OAuth MCP clients) against a written requirements checklist: Streamable HTTP transport, OAuth with dynamic client registration (P4 P-AUTH-1 provides Keycloak+DCR — verify client-side support), the D12 `confirm` round-trip (see GAP-2), streaming, non-developer usability for Turkish-speaking mechanical designers (AGENTS.md and evals/evals.json:6 are Turkish-language production prompts), and local-file workflows (see GAP-8); (2) per-machine client install+login+MCP-registration steps added to the P8-T4 cutover-night runbook (currently only "install of self-updating bridge"); (3) pilot exit criterion: pilot user does N real workdays on the chosen client, not on Codex. See section (d).

### GAP-2 [P0] — D12 `confirm` policy round-trip has no specified user-approval channel for Phase-1 clients
- Arch §5.2 cross-cutting: "`confirm` = generate preview → explicit user approval → execute." P2 P-GW-11 specifies dispatcher-side behavior (does not execute; runs preview) but the visible text never says HOW approval travels back through a third-party MCP client (MCP elicitation? a second tool call carrying a confirmation token? out-of-band web page?). Different MCP clients have wildly different elicitation support; if the chosen O8 client can't render it, every write tool (`set_element_parameter`, `set_schedule_cells*` — the tools designers use daily) is unusable or silently degraded at cutover.
- **Owner: P2 (mechanism spec) + GAP-1 package (client verification).** Minimum content: normative confirm-flow spec over plain MCP (recommend: preview result + single-use `confirm_token` arg on re-invocation, expiring, journal-linked to the P1 `invocation_id`), an audit event for the approval itself (who approved, when — §5.1.4 liability chain), and a conformance test against the chosen client.

### GAP-3 [P0] — `installer/revit-api-docs-mcp/` relocation is unowned; capability silently lost at cutover
- Today it is a separate MCP server registered into every user's Codex config (installer/lib/RevAgent.CodexRegistration.psm1:3352, :4466 — `expectedServer='revit-api-docs'`, `expectedTool='resolve_api_symbols_bulk'`; CI builds it, .github/workflows/ci.yml:33). P3 non-goals: "does not move into the bridge; it becomes a gateway-internal executor (registry `executor: internal`)" — i.e., P3 assigns it away. P2's in-scope list relocates only the 35-tool runtime (`installer/runtime-mcp-server/`) and never mentions revit-api-docs-mcp. Nobody performs the move; at cutover it is wiped from workstations (E4 wipe) and the assistant loses its Revit API documentation lookup, which the daily `send_code_to_revit` workflow leans on (AGENTS.md mandates SKILL-routed workflows with raw code as fallback).
- **Owner: P2.** Minimum content: register its tools as gateway-internal executor entries (or as the first §5.1.3 internal-MCP-server attachment, see GAP-4), include in capability index, add to the pilot scenario list (P8-T3).

### GAP-4 [P1] — O6 (module packaging) and §5.1.3 internal-MCP-server attachment have no owning package
- Arch §5.1.3: "Future discipline modules (including the CSI/ETABS server) attach behind the Gateway as internal MCP servers registered here"; O6: how a module (tools + SKILL/AGENTS + policies) is packaged, versioned, registered. P2 has registry seed artifacts "per module" and P4 has `modules`/`tenant_modules` catalog tables, but no package specifies the module package format, the version/registration lifecycle, or the mechanism by which an out-of-process internal MCP server is attached/proxied. P2's scope covers only the in-process 35-tool module.
- **Owner: P2.** Minimum content: a seam-reservation task mirroring P6-T1 (which does exactly this for APS): module manifest format draft, registry `executor: internal_mcp` binding, and a sign-off that the CSI module's `gated` policy class and the docs server (GAP-3) fit it. Does not need Phase-1 code beyond the docs-server case.

### GAP-5 [P1] — §9 instruction layer: AGENTS.md/SKILL.md CONTENT migration is unowned (serving ≠ rewriting)
- Arch §9: "AGENTS.md / SKILL.md as the instruction layer (served/versioned from the Tool Registry; the capability index is derived from it)." P2 scope says "versioned SKILL/AGENTS serving" — infrastructure only. The current AGENTS.md is written for the Codex desktop loop ("Codex should act…", "Codex uses Revit… through the revAgent runtime", mandatory-routing rules naming today's tool names like `send_code_to_revit`); P2's E5 renames all 35 tools to `core.*` names and P2 P-GW-6 strips 7 params per tool. Without a rewritten instruction set (S1 static prefix + per-discipline SKILL content referencing new names, new confirm flow, no Codex assumptions), the in-house loop pilots with stale or contradictory instructions.
- **Owner: P2 (task) with pilot-entry gating by P8.** Minimum content: instruction-doc inventory, rewrite mapped to the S1/S2 projection segments, registry versioning, and an eval pass (evals/evals.json) against the rewritten instructions before pilot.

### GAP-6 [P1] — O2 is stubbed by P2 but never scheduled anywhere
- P2 P-GW-8 stubs Mode B interfaces and says "O2 design is a later work package" — but no package (including P8's phase plan, which never mentions O2) schedules that later package. Mode B is the designated local-LLM path (D5, D8, driver 6 — "a market differentiator"); leaving it with no calendar slot means the plan silently drops an arch-listed open item.
- **Owner: P8.** Minimum content: a named post-cutover package with an entry milestone (e.g., alongside P6 Phase 2), plus a statement that P2's four stub interfaces are its frozen contract.

### GAP-7 [P1] — Relocated tool layer has workstation-local dependencies no plan adapts (spatial store, PowerShell spawn, local file I/O)
- The 4 spatial tools persist to a per-machine SQLite store resolved from `LOCALAPPDATA` (installer/runtime-mcp-server/src/spatial/spatialStore.ts:776-780) and spawn PowerShell with `REVAGENT_SPATIAL_DRIVE_ROOT` for drive-root checks (spatialStore.ts:708-721). P2 P-GW-2 `git mv`s `src/spatial` into the shared package with zero adaptation noted — on a Linux gateway container this either breaks or writes tenant-unaware state into the container FS. Similarly `reconcile_excel_ingestion.ts` reads the user's Excel from a local path (only tool file with `readFile`/`existsSync`), which resolves on the GATEWAY, not the workstation, after relocation — the Excel↔schedule reconciliation workflow (a real production use, cf. P6-APS-8) regresses at cutover unless a file-upload path exists in the O8 client or a bridge file-fetch message exists in RBP/1. Image-export tools are safe (the add-in writes the PNG workstation-side) but the returned local path must still be surfaced usably in the new client.
- **Owner: P2 (spatial store re-keying: tenant+device-scoped, gateway-resident or declared out-of-scope-with-tool-disable at cutover) + P1/GAP-1 package (file ingress: either an RBP/1 `file_fetch` message or client-side upload).** Minimum content: an explicit inventory of tools with local-FS/env coupling and a per-tool disposition. This is also an estimate risk on P2 (see (b)).

### GAP-8 [P2] — §5.6 Extended Properties writes absent from P6
- Arch §5.6 lists "Extended Properties for API-side data writes (e.g., fabrication IDs) outside the model" as part of the reviewer plane. P6 covers AEC DM reads and DA4R writes but never mentions Extended Properties.
- **Owner: P6.** Minimum: one line in scope or an explicit non-goal deferral.

### GAP-9 [P2] — §6 graceful degradation ("assistant-down ≠ Revit-down") has no owner for workstation-side UX
- No plan states what the designer sees when the gateway/tunnel/WAN is down (bridge tray state? add-in unaffected — should be asserted; queued vs rejected requests). P5 P-NET-3 honestly notes WAN outage halts the assistant, but the user-facing behavior and the cutover-era comms text ("if the assistant is down, Revit still works, here's the status page") are unowned.
- **Owner: P3 (bridge/tray behavior) + P8-T6 (comms).**

### GAP-10 [P2] — D6 Phase-1 posture unstated; planner/router and sub-agents deferred without a D6 statement
- P2 defers sub-agents and planner/router post-pilot (acceptable — Phase 1 is mech-only), but no section states that D6's "four disciplines never co-resident" holds trivially in Phase 1 (single namespace) and which milestone re-activates the deferred stages. **Owner: P2 one paragraph + P8 milestone.**

### GAP-11 [P2] — P5 CI runner on the production gateway host: trust boundary unstated
- P-CD-2 puts a self-hosted runner on the gateway host. Any workflow that targets that runner can reach the Docker daemon and therefore `/opt/revagent/env` secrets — P-SEC-1's "never in GitHub Actions secrets" is undermined if runner scoping is not stated. **Owner: P5.** Minimum: runner user isolation, runner-group restriction to `gateway-cd.yml`, and a note that repo-write implies prod-adjacent access (relevant to §6 zero-trust).

### GAP-12 [P1] — Bridge release build/sign/publish CD lane is unowned (O9 pipeline seam between P3 and P5)
- P3 owns self-update mechanics + signed manifest (reusing installer/lib/RevAgent.DistributionIntegrity.psm1 RS256); P5 explicitly excludes "O9 bridge self-update signing" from its CI/CD scope; P8's area-label map assumed an installer+CI/CD+O9 package that doesn't match the actual P6 (APS). Nobody owns: the Windows workflow lane that compiles the .NET bridge, signs the release manifest with the existing pinned key on the `revagent-cd` runner, uploads artifacts to the gateway object store, and writes P4's `bridge_releases`/`release_channels` rows (including pilot→stable channel promotion mirroring today's `publish_to_pilot`/`publish_to_nas` discipline, .github/workflows/signed-source-free-cd.yml:33,86,300-302).
- **Owner: P3, adopting P5's conventions (GHCR-analog artifact-of-record, environment-gated dispatch).** This is on the critical path: P8 Phase-1 exit criterion (5) "one signed bridge self-update applied" is impossible without it.

### Coverage confirmations (no gap): §5.1 subsystems 1–4 → P2/P4; §5.2 five stages incl. context invariant as CI gate (P2 P-GW-9), result hygiene (P-GW-10), failure semantics, idempotency (P1/P3); §5.4 all bullets → P3; §5.7 boundaries → P1/P2; §5.9 → P4; §5.10 + O11 → P7 incl. normative parity table and the no-side-files rule (P-ADMIN-3); §6 security/availability → P4/P5; §7 → P5 incl. mandatory restore drill; §8 sequence → P8; O1→P1, O3/O5/O7→P4, O4→P6, O9(mechanism)→P3, O10→P5. D12 registry/policy enforcement → P2 P-GW-11 (modulo GAP-2).

---

## (b) ESTIMATE SANITY (only P6/P8 tables visible; all other packages' estimates were truncated out of my input — coordinator must re-run this check on full tables)

1. **P8-T1 (1.0 d) — flag, ~2x low.** Fifteen DP one-pagers with defensible defaults drawn from seven sibling packages, plus an operator session, plus recorded outcomes in `docs/decisions/`. Even AI-assisted, the cross-package reconciliation (see section (f) contradictions, which DP-level decisions must resolve) makes 2 d realistic.
2. **P8-T4 (2.0 d) — conditionally OK, flag the dependency.** Feasible ONLY because P3's uninstaller does the heavy lifting. The E4 wipe surface is large: per-user `%USERPROFILE%\.codex\config.toml` MCP-section surgery and managed AGENTS/skills (RevAgent.CodexRegistration.psm1 is a >4,400-line module), updater scheduled tasks (installer/nas/README.md:32,409), dashboard addon + tunnel, updater tree with ACL'd bootstrap preservation (P-SEQ-2). If the P3 uninstaller slips or misses cases, T4 blows past 2 d; state it as a risk with trigger.
3. **P8-T3 (1.0 d) — borderline low, not >2x.** Scripted scenarios seeded from evals/evals.json plus four forced-failure drills with measurable thresholds; acceptable as a checklist-writing task.
4. **P6-T1 (1 d), P6 Phase-1 total ~2 d — plausible** (review/sign-off + one dispatch unit test + grep check).
5. **Hidden-work estimate risk on P2 (no numbers visible): the "relocation without rewriting tool code" framing conceals GAP-7 adaptation work** (spatial store re-keying, PowerShell spawn removal, file-ingress path) plus `AsyncLocalStorage` plumbing across ~12.6k LOC of tool code (verified: 75 TS files; tools dir alone 12,625 lines). Whatever P2's relocation estimate is, coordinator should stress-test it against GAP-7 explicitly.
6. **P8 total ~11 d is credible** given everything technical lives in P1–P7; the "spread across the program" caveat is honest.

---

## (c) MISSING MIGRATION-ERA INTERIM CONCERNS (fleet on frozen NAS stack during Build/Pilot)

### GAP-13 [P0] — PR #260 interim rules are not operationalized by any package
No section owns, mechanizes, or even restates the interim regime (no NAS publishes; users must not run the STABLE updater). Needed, owner **P8 (new task, with P5 assist)**:
1. **Publish freeze mechanism:** `signed-source-free-cd.yml` is manual-dispatch gated by the `revagent-production-publish` environment (line 302) with `publish_to_nas`/`publish_to_pilot` inputs (lines 33, 86). Minimum: disable/lock that environment (or add a freeze-flag guard step) so an accidental dispatch cannot push to the fleet mid-migration; document the unlock procedure as part of the emergency path (item 3).
2. **Updater abstinence, fleet-wide:** users must not run `Start-revAgent-Update.cmd` / the STABLE updater GUI (installer/nas/Start-revAgent-Update.cmd, Install-revAgent-Updater-GUI.cmd) — a comms artifact + ideally a technical belt (e.g., a frozen-channel marker the updater surfaces). Note: workstations also have **scheduled-task** update runs (installer/nas/README.md:32, 409, 719) — with the channel frozen these are no-ops, but that must be verified and stated, not assumed.
3. **Emergency security-patch exception path:** the fleet runs a frozen Node runtime + Node MSI + Codex integration for the multi-month Build. Define the one sanctioned exception: a logged, operator-approved NAS hotfix publish (this is where P2's P-GW-2 thin-shell bit-compatibility claim gets load-bearing — see (e) watch item), with the CI installer-contract suite (ci.yml:38-52) as its gate. P-SEQ-4's exception log covers feature freeze only, not release freeze.
4. **Pilot-machine updater neutralization:** P8 Phase 2 keeps the pilot machine's protected bootstrap for rollback — but the NAS updater **scheduled task** on that machine could reinstall the old stack over the bridge mid-pilot. Add an explicit "disable updater scheduled task (do not delete bootstrap)" step to pilot prep, and its inverse to the rollback runbook.

### GAP-14 [P1] — Codex desktop app drift risk during the freeze
The old daily driver (ChatGPT/Codex desktop app) self-updates outside our control; its MCP/config behavior changing mid-Build would break the frozen fleet with the publish freeze in force. No risk-register entry exists. **Owner: P8-T7 register**: trigger = fleet-wide Codex MCP failures in dashboard activity; mitigation = the GAP-13 emergency path; secondary mitigation = accelerate cutover.

### GAP-15 [P2] — Dev-machine coexistence during Build
P8 Phase-1 exit criterion (2) installs the bridge on a dev workstation that still runs the old stack. Old runtime serialization uses tmpdir lock dirs + `mcp_status` preflight (ConnectionManager.ts:43-46,276-321); the bridge uses its own in-process queue (P3 P-BRIDGE-4). The two clients do NOT share a serialization mechanism, so concurrent Codex-driven and bridge-driven requests can interleave into one Revit session during dev/testing. Cheap fix, owner **P3**: document "one driver at a time" for dev machines, or have the bridge honor the lock dir during coexistence only.

### GAP-16 [P2] — Parity baseline capture depends on the old pipeline staying alive
P7's P-ADMIN-9 side-by-side diff needs the NAS telemetry chain + Windows admin workstation summarizers running through the pilot. Fine today, but state it as a pilot-entry precondition (no one may decommission/repoint the admin workstation early). **Owner: P7.** Also record as an accepted-regression decision (P8 decision log): P-ADMIN-6's admission that north-surface MCP sessions expose tool calls but not free-text prompts means Usage Intelligence loses prompt-level data for the whole Phase-1 interim (the Codex transcript exporter dies at cutover, its replacement — gateway-owned loop with the web client — comes later). The operator should sign that trade explicitly.

---

## (d) THE PILOT USER'S / DESIGNERS' DAILY WORKFLOW AFTER CUTOVER — the #1 practical completeness question

**Verdict: as written, the plans do NOT deliver a verified usable daily driver at cutover.** Reconstruction of what the plans actually provide on cutover night, per designer workstation: bridge service + adapted add-in (P3), gateway with all 35 tools behind the north MCP surface (P2), OAuth login via Keycloak (P4), and REMOVAL of the entire Codex integration (P3 scope 5; E4 wipe: `%USERPROFILE%\.codex\config.toml` sections, managed AGENTS.md, skills). What is NOT provided by any package: the thing the designer opens and types into.

Specific unmet needs:
1. **No client selection or delivery** (GAP-1). "Existing MCP clients (e.g., Claude Code)" is a developer CLI; the fleet is Turkish-speaking mechanical designers/technicians (AGENTS.md "Workstation Role"; evals/evals.json prompts in Turkish). Claude Desktop or equivalent chat-shaped client is the plausible pick — but nobody evaluates, licenses (paid seats for a third-party client are an unbudgeted cost line item), installs, or configures it, and P8-T4's runbook has no client step.
2. **Confirm-flow usability unverified** (GAP-2). Daily work includes model writes; if the chosen client can't carry the approval round-trip, designers lose `set_element_parameter`/`set_schedule_cells*` on day 1.
3. **Cross-app workflows shrink silently.** Today's driver (Codex desktop) also does the Excel/Word/PDF/file side-work AGENTS.md promises ("Codex is not limited to Revit… Excel, Word, PDF, image exports, quantity takeoff…") using local-machine access. A north-surface MCP client only has the Gateway's Revit tools; local-file abilities depend entirely on which client is chosen (Claude Desktop/Code have local capabilities; a minimal web client has none). The Excel-reconciliation ingestion regression (GAP-7) is the sharpest instance. The retraining pack (P8-T6) must state what is lost/changed, which requires GAP-1's evaluation to have happened.
4. **Docs lookup lost** (GAP-3) unless relocated.
5. **What works well:** the pilot-exit and cutover verification criteria that DO exist (P8 Phase-1 exit 2: read tool + one confirm-class write end-to-end from an external MCP client) are the right shape — they just lack the "on the chosen fleet client, by the pilot designer, for 5 real workdays (P-SEQ-8)" binding.

**Proposed minimum content (owner: new O8 package + P8 gates):** DP-10 becomes a Build-phase decision with an evaluation matrix (auth, confirm, streaming, local files, language/UX, cost/seat, manageability); pilot entry requires the pilot user fully off Codex; cutover-night runbook gains per-machine client install/login/smoke ("open client → login → run one read query → run one confirm write → see result in Revit"); P8-T6 quickstart is written against the actually chosen client.

---

## (e) IRON-RULE CHECK ("old path never removed before new path carried real traffic")

**No hard violations found in visible content.** The plans are notably disciplined: P2 P-GW-2 keeps the stdio shell building the same `build/index.js` (installer/runtime-mcp-server/src/index.ts:13-20 confirmed, 29 lines); P1 P-O1-10/P3 P-ADDIN-2 keep `DetectMessageFraming` through cutover and remove it one release after; P7 P-ADMIN-8 keeps the old dashboard readable against frozen NAS through insurance; P8-T9 removes the NAS CD job only at Retire; P-SEQ-2 preserves the rollback trust anchor.

**Watch items (conditional violations):**
1. **P2 P-GW-2's repo-side refactor of the frozen stack's source** (git mv of `src/{tools,utils,spatial}` + deletion of `db.ts`/`service.ts`/`ws` dep) doesn't touch deployed artifacts, BUT it silently changes what an emergency NAS hotfix (GAP-13.3) would rebuild and ship. Require: CI installer-contract suite + runtime tests green post-move, plus a one-time behavioral diff of the rebuilt `build/index.js` archived as evidence. Otherwise the "old path" is unrebuildable-as-was during the very window it's the fleet's only path.
2. **Cutover-night removal of the Codex integration with no verified replacement client** (GAP-1) is the one place the iron rule's spirit is at risk: the old UX is removed fleet-wide the same night the new UX first exists on 11 of 12 machines. The rule is satisfied only if the pilot (real traffic) ran on the SAME client stack cutover ships — currently unguaranteed because no package owns the client.
3. **Pilot validity vs add-in changes:** P1 asserts "the pilot ships with the add-in unchanged" while P3 ships four add-in adaptations (loopback bind, `batch_execute`, `get_document_context`, concurrency fixes) that will be in the cutover artifact. If the pilot validates an unchanged add-in but cutover installs the adapted one, the cutover artifact never carried real traffic. **Owner P8:** sequence add-in adaptation BEFORE pilot entry, or explicitly re-pilot after adaptation.

---

## (f) CROSS-PLAN CONTRADICTIONS the coordinator must reconcile (completeness of a *coherent* plan)

1. **`mcp_status` preflight:** P1 P-O1-6 retires it (busy state rides heartbeats + `revit_busy` fault); P3 P-BRIDGE-4 keeps it as defense-in-depth per invocation. Pick one (recommend P3's, amended: keep the probe but off the per-invocation hot path, matching P1's latency goal).
2. **Doc-context mechanism:** P1 P-O1-11 polls `get_current_view_info`/`list_open_views` (30 s idle, no add-in change); P3 P-BRIDGE-5 adds a new cached `get_document_context` add-in command with app-event subscription and explicitly rejects P1's polling as ExternalEvent-burning. Mutually exclusive; also interacts with watch-item 3 (add-in changed vs unchanged at pilot). Recommend P3's design with P1's message shape.
3. **Instance registry file:** P1 P-O1-12 says `%TMP%/revAgent-instances.json` is written by nothing (verified: no writer in C# or installer sources; ConnectionManager.ts:37-42 only reads) and relies on port-scan; P3 P-ADDIN-5 ports the registry read. Drop the dead read (P1 is right).
4. **P8's package-area labels do not match the actual P1–P7 numbering** (P8 "P6" = installer/CI-CD/O9-signing; actual P6 = APS). P8 flags this itself, but the mismatch is exactly where GAP-12 (bridge release CD lane) fell through — renumber and re-check every P8 dependency edge after mapping.
5. **Heartbeat cadence:** P1 fixes 15 s (Gateway degraded at 35 s/disconnected at 65 s); P7 parity row 2 retains 60 s/300 s thresholds "for heartbeat-gap degradation". Harmonize the dashboard's staleness semantics with P1's state machine so the fleet page and the connection registry can't disagree.

---

## (g) CONSOLIDATED PRIORITIZED GAP LIST (id / priority / owner / one-line proposed content)

| ID | Pri | Owner | Proposed content |
|----|-----|-------|------------------|
| GAP-1 | P0 | NEW O8 package + P8 gates | Select/deliver/verify the Phase-1 designer client; client steps into cutover runbook; pilot runs on it |
| GAP-2 | P0 | P2 + O8 pkg | Normative confirm-round-trip mechanism over plain MCP + approval audit event + client conformance test |
| GAP-13 | P0 | P8 (+P5) | Operationalize PR #260 interim rules: lock publish environment, updater-abstinence comms + scheduled-task verification, emergency-patch exception path, pilot-machine updater disable |
| GAP-3 | P0 | P2 | Relocate revit-api-docs-mcp as gateway-internal executor; include in capability index + pilot scenarios |
| GAP-12 | P1 | P3 (P5 conventions) | Bridge release build/sign/publish CD lane on the Windows runner; feeds P4 `bridge_releases`; blocks P8 exit criterion 5 |
| GAP-5 | P1 | P2 (+P8 gate) | Rewrite AGENTS/SKILL content for new tool names, in-house loop, confirm flow; version in registry; eval before pilot |
| GAP-7 | P1 | P2 + P1/O8 pkg | Local-dependency inventory of relocated tools: spatial store re-keying (spatialStore.ts:708-721,776-780), Excel file-ingress path, export-path UX |
| GAP-4 | P1 | P2 | O6 module-packaging + internal-MCP-server attachment seam spec (CSI-ready), P6-T1-style sign-off task |
| GAP-6 | P1 | P8 | Schedule O2 as a named post-cutover package pinned to P2's stub interfaces |
| GAP-14 | P1 | P8-T7 | Risk-register entry: Codex app drift during freeze, trigger + mitigation via GAP-13.3 |
| EST-1 | P1 | P8 | Re-estimate P8-T1 to ~2 d; re-run estimate review on all truncated P1–P7 tables; stress-test P2 relocation estimate vs GAP-7 |
| CONTRA-1..5 | P1 | Coordinator | Resolve the five cross-plan contradictions in (f); feed into DP checkpoint (P8-T1) |
| IRON-1..3 | P1 | P8/P2 | Enforce (e) watch items: post-refactor rebuildability evidence; pilot-client identity with cutover client; add-in adaptation sequenced before pilot |
| GAP-15 | P2 | P3 | Dev-machine coexistence rule (bridge vs old runtime serialization) |
| GAP-16 | P2 | P7 (+P8 log) | Pilot-entry precondition: old telemetry chain alive for parity capture; operator sign-off on Phase-1 prompt-data loss |
| GAP-9 | P2 | P3 + P8-T6 | Gateway-unreachable UX (tray/status) + "assistant-down ≠ Revit-down" comms text |
| GAP-11 | P2 | P5 | Runner-on-prod-host trust boundary: runner-group scoping, secrets reachability statement |
| GAP-8 | P2 | P6 | Extended Properties: scope line or explicit deferral |
| GAP-10 | P2 | P2/P8 | One-paragraph D6 Phase-1 posture; milestone for deferred planner/sub-agents |

Key file evidence base: docs/TARGET_ARCHITECTURE.md (all); installer/runtime-mcp-server/src/tools/register.ts:39-77 (35 tools confirmed); installer/runtime-mcp-server/src/index.ts:13-20; installer/runtime-mcp-server/src/utils/ConnectionManager.ts:37-46; src/revit-plugin/revAgentPlugin/Core/SocketService.cs:522-526 (mcp_status bypass confirmed); installer/lib/RevAgent.CodexRegistration.psm1:3352,4466 (docs-MCP in daily driver); .github/workflows/ci.yml:30-52; .github/workflows/signed-source-free-cd.yml:33,86,300-302; installer/nas/README.md:32,409,719 (scheduled-task updater); installer/runtime-mcp-server/src/spatial/spatialStore.ts:708-721,776-780 (workstation-local spatial store + PowerShell spawn); AGENTS.md (Codex-specific instruction layer); evals/evals.json:1-40 (Turkish production prompts).