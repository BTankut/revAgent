> Part of the RevAgent implementation plan (see `00-INDEX.md`).
> Normativity: `docs/TARGET_ARCHITECTURE.md` → `00-INDEX.md` resolutions (RES-*/GAP-*) → this section.
> Where this section conflicts with a resolution in `00-INDEX.md`, the index wins.

# P8 — Master Sequencing, Risk Register, Decision Log, Week-1 Kickoff

All file:line references are repo-relative at `/home/user/revAgent` (origin/main 11020d1 + uncommitted `docs/TARGET_ARCHITECTURE.md`). Architecture references (`§n`, D1–D12, O1–O11) are to `docs/TARGET_ARCHITECTURE.md`.

---

## (a) Scope & non-goals

**Scope.** This package owns the *when and in what order*: the phase plan mapping all work packages onto the D11 sequence (Build → Pilot → Cutover → Insurance → Retire), the milestone list and critical path, the calendar rollup, the project-level risk register, the operator decision checklist (pre-build confirmations), the cutover/rollback/comms artifacts that no single technical package owns, and the concrete week-1 task list. It also owns enforcement of the migration feature freeze (§8, "Freeze feature development for the duration").

**Non-goals.** No re-opening of D1–D12. No re-specification of package internals (P1–P7 own their designs; P8 only sequences and gates them). No historical usage-data migration (closed per O11 — new store starts fresh). No new product features during migration. No APS/reviewer-plane or web-chat-client delivery before cutover (explicitly deferred, see P-SEQ-3).

**Package-area labels used below** (coordinator: map to your P-numbering by area name if labels differ): **P1** Gateway core (orchestration engine, LLM provider layer, tool registry, north MCP surface, context projection); **P2** Bridge + O1 protocol + add-in adaptation; **P3** Runtime relocation (Node/TS runtime `installer/runtime-mcp-server/` moves to Gateway; stdio → internal dispatch; docs MCP server); **P4** Data layer + auth/licensing/audit (Postgres/O3, OIDC, device tokens, seats, O7 event schema); **P5** Phase-1 infra (office host, Compose, tunnel, warm standby, O10 drill); **P6** Installer/uninstaller/cutover tooling + CI/CD extension + bridge self-update signing (O9); **P7** Admin-plane migration (O11) + Phase-1 client scope (O8).

---

## (b) Plan-level design decisions (proposals)

- **P-SEQ-1 — Self-update proven live is a pilot exit criterion, not a post-cutover feature.** At least one signed bridge update must be pushed and applied on the pilot machine before cutover, because cutover is "the final fleet push ever" (§8 step 3); an unproven self-update path after NAS retirement means no management channel at all.
- **P-SEQ-2 — The cutover wipe PRESERVES the trust anchor until Retire.** `C:\ProgramData\DPE\revAgent\bootstrap\`, `prestage\install-revagent-local-bootstrap.ps1`, and `updater\config\release-trusted-keys.json` are excluded from the cutover-night wipe list and deleted only at Retire. Rationale: NAS Refresh returns **exit 84 before UAC** whenever the protected bootstrap is missing or stale (installer/INSTALLATION.md:40-49; installer/nas/README.md:337, 365; installer/nas/Refresh-revAgent-LocalBootstrap-STABLE.ps1:180), so wiping the bootstrap converts rollback from "run `Start-revAgent-Update.cmd` per machine" into a per-machine supervised manual high-assurance prestage (docs/BOOTSTRAP_PRESTAGE.md) — see risk R5.
- **P-SEQ-3 — APS reviewer plane (O4) and web chat client are off the cutover critical path.** Cutover concerns designer workstations only (§8 step 3 is a fleet wipe/reinstall); reviewers have no workstation component to cut over. O4 and the web client are scheduled after the insurance window; Phase 1 uses existing MCP clients against the north MCP surface per O8/§5.5.
- **P-SEQ-4 — Feature freeze is enforced mechanically, not by memory.** Freeze scope = no new tools and no behavior changes under `installer/runtime-mcp-server/src/tools/**` and `src/revit-plugin/**` except protocol/transport adaptation; enforced via a PR label + a freeze clause added to the Claude review gate (.github/workflows/claude-review.yml:26-29). Exceptions logged in the decision log.
- **P-SEQ-5 — One decision checkpoint (M0) before build starts.** Build does not start until DP-1, DP-2, DP-13 are confirmed; pilot is gated on DP-3, DP-4, DP-6, DP-8, DP-9, DP-12; remaining DPs may lag (checklist in section "Decision points" below). Prevents mid-build re-litigation, the main single-dev schedule killer.
- **P-SEQ-6 — Milestone gates are demo-based, not document-based.** Every milestone M1–M10 has an executable demonstration as its exit test; suits one senior dev + AI assistant and avoids paperwork drift.
- **P-SEQ-7 — Rollback is fleet-level only.** No mixed estates: the pre-written rollback criterion (§8 step 4) triggers restoring ALL machines to the NAS stack or none. During insurance, the NAS share is frozen read-only and release-tagged, not deleted.
- **P-SEQ-8 — Calendar carries 20% contingency on Build, and "pilot = 5 working days of real work" (not calendar days).** §8 step 2 says "a few days of real work"; we quantify it so the gate is checkable.
- **P-SEQ-9 — Codex-desktop retirement is a comms/retraining deliverable with a date, executed between pilot exit and cutover.** The installer today deeply manages the users' Codex environment (`%USERPROFILE%\.codex\config.toml` MCP sections, managed `AGENTS.md`, skills — installer/lib/RevAgent.CodexRegistration.psm1:3394-3402, 4050-4084); removing it changes every user's daily driver and must be trained, not just announced (risk R10).
- **P-SEQ-10 — O11 metric-parity verification is a cutover ENTRY criterion.** The architecture mandates verifying "before cutover that every currently tracked metric is derivable from the O7 event schema" (O11); the dashboard/usage-intelligence *reimplementation* may land later, but the parity check may not.
- **P-SEQ-11 — Rollback and restore paths are rehearsed once each before they can count as insurance.** Mirror of §7's "an untested backup is not a backup": one machine-restore from the frozen NAS tree is executed on a scratch VM/machine during insurance week 1, and the O10 Postgres restore drill is mandatory pre-go-live.

---

## (c) Work breakdown — P8 package tasks

Estimates: dev-days for one senior dev + AI coding assistant.

| ID | Description | Depends on | Acceptance criteria | Est. |
|---|---|---|---|---|
| P8-T1 | Decision checkpoint: one-pager per DP-1..DP-15 with recommended default; run confirmation session with operator; record outcomes in `docs/decisions/` | — | Every DP has a recorded choice + date; DP-1/DP-2/DP-13 closed before any build commit | 1.0 |
| P8-T2 | Master schedule as living doc (`docs/plan/MASTER_PLAN.md`) + GitHub milestones M0–M10; weekly update ritual | P8-T1 | Milestones exist in repo + GitHub; every P1–P7 task mapped to a milestone | 1.0 |
| P8-T3 | Pilot protocol: scripted scenario list (seeded from `evals/evals.json` — real office prompts with assertions, evals/evals.json:1-40), forced-failure drills (network cut, Revit crash mid-invocation, gateway restart mid-session, sleep/wake overnight), measurable exit thresholds per §8 step 2 | O1 spec frozen (M1) | Checklist covers all five §8-step-2 validation targets (bridge, session routing, idempotency/reconnect, installer, self-update) with pass/fail thresholds | 1.0 |
| P8-T4 | Cutover-night runbook: per-machine checklist integrating the E4 wipe list (preserving the P-SEQ-2 trust-anchor exclusions), install of self-updating bridge, per-machine smoke verification; rehearsed once on a clean VM | P6 installer/uninstaller done | VM rehearsal executes runbook end-to-end with zero undocumented manual steps; per-machine time measured and total window fits the chosen evening/weekend | 2.0 |
| P8-T5 | Rollback runbook + pre-written rollback criterion: exact criterion text ("if X not functional by time Y…"), per-machine steps, honest per-machine cost stated (see R5), bootstrap-preservation verification step added to cutover night | P8-T4 | Criterion signed by operator before cutover; one-machine rollback rehearsed on scratch hardware/VM during insurance week 1 (P-SEQ-11) | 1.0 |
| P8-T6 | Comms & retraining pack for Codex-desktop retirement: announcement, 1-page quickstart for the new client (per DP-10), 30-min hands-on session, office-hours coverage during insurance window | DP-10; pilot exit | Every fleet user attended session or acknowledged quickstart before their machine is cut over | 2.0 |
| P8-T7 | Risk register as living doc + weekly review; triggers wired to observable signals where possible (telemetry 429s, heartbeat failures) | P8-T2 | Register reviewed at every milestone gate; each risk has owner + trigger | 0.5 |
| P8-T8 | Feature-freeze enforcement: PR template freeze checkbox, `migration-freeze-exception` label, freeze clause added to the Claude review gate prompt (.github/workflows/claude-review.yml) | — | A test PR touching `src/tools/**` without the label is flagged by review gate | 0.5 |
| P8-T9 | Retire-phase checklist: NAS archive to read-only storage, residual wipe (bootstrap tree, Node MSI per DP-14), removal of `publish-to-nas` CD job (.github/workflows/signed-source-free-cd.yml:297) and NAS-path CI tests from ci.yml's installer contract list (ci.yml:38-52), signing-key disposition note (key tree stays for O9 — docs/DEVELOPER_RUNBOOK.md:1000-1011) | Insurance window closed | Checklist executed; CI green after job removal; freeze formally lifted | 1.0 |
| P8-T10 | Week-1 kickoff execution & coordination (scaffold + CI skeleton co-owned with P1/P6; see Week-1 list) | P8-T1 partially | All W1 tasks closed by end of week 1 | 1.0 |

**P8 total: ~11 dev-days** (spread across the whole program, not contiguous).

---

## (d) Phase plan, milestones, critical path, calendar

### Phase plan (D11 sequence) with entry/exit criteria

**Phase 0 — Pre-build (Week 1).** Entry: this plan approved. Contents: DP checkpoint (P8-T1), monorepo scaffold, O1 v0.9 draft, CI skeleton, transport spike (Week-1 list below). Exit: DP-1/DP-2/DP-13 confirmed; O1 v0.9 reviewed; CI green on the new packages; spike demonstrates the existing 35-tool registry served over Streamable HTTP (swap point: installer/runtime-mcp-server/src/index.ts:19-20).

**Phase 1 — Build (P1, P2, P3, P4, P5, P6; P7 parity work).** Entry: Phase 0 exit. The office keeps working on the untouched old system throughout (§8 step 1). Exit criteria: (1) gateway container runs on the office host behind Caddy/tunnel at `gateway.<domain>`; (2) bridge installs on a dev workstation and executes a read tool + one `confirm`-class write end-to-end from an external MCP client through the north surface; (3) idempotency journal + reconnect covered by automated tests; (4) installer AND uninstaller dry-run clean on a VM; (5) one signed bridge self-update applied successfully in a lab loop; (6) O10 restore drill passed on a blank VM (§7 — mandatory); (7) O11 metric-parity check complete (P-SEQ-10); (8) freeze in force since M0.

**Phase 2 — Pilot (one workstation, real work).** Entry: Build exit + DP-12 (pilot machine/user) + pilot machine retains its protected bootstrap (rollback for the pilot machine = run `C:\ProgramData\DPE\revAgent\bootstrap\Start-revAgent-Update.cmd`, installer/INSTALLATION.md:67-73). Exit criteria (§8 step 2, quantified per P8-T3): **bridge** survives ≥5 working days of real work without manual restart; **session routing** correct across Revit document open/close and multi-session; **idempotency/reconnect** validated by forced network drop + overnight sleep/wake with zero duplicate mutations (journal answers redelivery); **installer** validated by the pilot machine's own clean install; **self-update** validated by ≥1 signed update pushed during the pilot (P-SEQ-1). Plus: no open P0/P1 defects; tool round-trip latency within agreed budget vs. the old local path; pilot user sign-off.

**Phase 3 — Hard cutover (one evening/weekend, ~12 machines).** Entry: Pilot exit + P8-T4 runbook rehearsed + P8-T5 criterion signed + P8-T6 comms delivered + NAS share frozen read-only and release-tagged. Contents: per E4 wipe list (minus P-SEQ-2 exclusions), install self-updating bridge — the final fleet push ever — per-machine smoke (connect, enroll, execute read + confirm-write tool, journal write visible in audit log). Exit: all machines pass smoke; users have the new client configured; old `[mcp_servers.revAgent]`/`[mcp_servers.revAgent-api-docs]` sections removed from each user's `~/.codex/config.toml` (only those sections — E4).

**Phase 4 — Insurance (2 weeks).** Entry: cutover complete. Contents: NAS frozen-but-restorable; daily fleet health check from the dashboard/audit feed; office hours (P8-T6); one-machine rollback rehearsal on scratch hardware (P-SEQ-11); dev backfills non-critical lanes (P7 dashboards, P1 hardening). Exit: 2 weeks of real traffic; rollback criterion never triggered (or triggered, executed, and root-caused); no cutover-class defects open.

**Phase 5 — Retire.** Entry: Insurance exit. Contents: P8-T9 checklist (archive NAS, delete trust-anchor residue + Node MSI per DP-14, remove `publish-to-nas` job and NAS CI contracts, lift freeze). Exit: checklist done; CI green; freeze lifted; post-freeze backlog (APS/O4, web client, remaining O2 code-exec hardening) re-planned.

### Milestones M0–M10 (dependency-ordered)

| M | Deliverable (packages) | Depends | Effort (dev-days) |
|---|---|---|---|
| M0 | Decisions confirmed + repo scaffold + CI skeleton + transport spike (P8, P1, P6) | — | 5 |
| M1 | **O1 protocol spec v1.0 frozen** (P2) — handshake/auth, session register/resume, invoke, batch, idempotency journal semantics, streaming, heartbeat/timeouts, version negotiation, error taxonomy (retryable/terminal per §5.2.4) | M0 | 3 |
| M2 | Gateway minimal loop: north MCP endpoint (Streamable HTTP) serving capability index + deferred schemas; tool dispatch to executor abstraction; runtime tools registered in-gateway (P1 + P3 minimal) | M1 | 20 |
| M3 | Bridge skeleton: enrollment, persistent WSS, invocation → add-in TCP framing, idempotency journal, batch-as-transaction-group (P2) | M1 | 15 |
| M4 | **Vertical slice**: external MCP client → gateway on office host → bridge → live Revit → result, incl. `confirm` policy-class flow (P1+P2+P5 minimal) | M2, M3 | 5 |
| M5 | Auth/licensing/audit minimal + Postgres migrations: OIDC login, device-token enrollment, seat check at connect, audit event per invocation, O7 event schema v1 (P4) | M2 | 8 |
| M6 | Installer + uninstaller + signed bridge self-update + CD extension (gateway image job; Linux runner on gateway host per §9 "extended to Gateway CD") (P6) | M3, M5 | 12 |
| M7 | Ops readiness: Compose production config, tunnel, warm standby, O10 restore drill passed, O11 metric-parity verified (P5, P7) | M4, M5 | 6 |
| M8 | **Pilot complete** (exit criteria above) | M4, M6, M7 | 8 (over 2–3 cal. weeks) |
| M9 | **Fleet cutover complete** (runbook rehearsal + night) | M8 | 5 |
| M10 | Insurance window closed → NAS retired | M9 | 3 (over 2+ cal. weeks) |

**Critical path:** M0 → M1 (O1 spec) → M2 ∥ M3 (single dev: serial, M2 then M3) → M4 (minimal loop) → M6 (installer + self-update — pilot prerequisites) → M8 (pilot) → M9 → M10. **O1 is the first deliverable and the precondition for the pilot, exactly as the architecture states (O1: "First deliverable; precondition for the pilot").** M5 and M7 sit just off the critical path but gate M8 via entry criteria.

**Parallelizable lanes (single dev = backfill lanes during wait states, mainly pilot observation days and insurance window):** P7 dashboard/usage-intelligence reimplementation as event-stream consumers (~10 dd; only the parity *check* is pre-cutover); P1 hardening (full context projection, planner/router small-model, result hygiene/`result_ref` paging, ~12 dd); O2 code-exec sandbox (post-cutover); O4 APS + web client (post-Retire per P-SEQ-3).

### Calendar rollup

Critical-path effort ≈ **90 dev-days**; backfill lanes ≈ **25–35 dev-days**; program total to full P1–P7 completion ≈ **120–135 dev-days**. One senior dev + AI assistant, sustained: **cutover (M9) at ~19–20 working weeks (~4.5–5 months) from kickoff; with P-SEQ-8's 20% build contingency, plan 5.5–6 months to M10/NAS retirement.** The two calendar-elapsed phases (pilot ≥5 real working days; insurance = 2 fixed weeks) are absorbed as backfill-lane time, not idle time.

---

## (e) Test strategy (sequencing-level)

Package-level testing belongs to P1–P7; P8 tests the *transitions*:

1. **Gate demos (P-SEQ-6).** Each milestone exits via a scripted, repeatable demonstration; the M4 vertical-slice demo becomes the standing end-to-end smoke run in CI where feasible (gateway + mocked bridge executor) and manually against live Revit at each gate.
2. **Pilot as structured test (P8-T3).** Scenario set seeded from `evals/evals.json` (real Turkish office prompts with per-prompt assertions — evals/evals.json:1-40) so pilot coverage mirrors real usage; plus forced-failure drills: network cut mid-invocation (journal dedup on redelivery), Revit crash mid-transaction-group, gateway container restart mid-session (session resume from store, §5.2 "Statelessness"), overnight sleep/wake.
3. **Rehearsals count as tests (P-SEQ-11).** Cutover runbook: full VM rehearsal with timing. Rollback: one-machine restore from the frozen NAS tree on scratch hardware during insurance week 1 — this specifically re-validates that the preserved bootstrap (P-SEQ-2) actually bypasses the exit-84 Refresh guard (installer/INSTALLATION.md:46-49). Backup: O10 restore drill on a blank VM before go-live (§7, mandatory).
4. **Freeze regression net.** Existing CI gates keep running unmodified through the migration (`scripts/test-ci.ps1` + the 11 installer security-contract tests, .github/workflows/ci.yml:36-52) until Retire; any red on the legacy suite during Build is treated as a freeze violation signal.
5. **Cutover-night smoke.** Per-machine scripted check (connect, enroll, read tool, `confirm` write, audit event visible) executed on all ~12 machines before the window closes; results recorded in the runbook.

---

## (f) RISK REGISTER

Likelihood/Impact: L/M/H. Each risk: mitigation + trigger (early-warning signal).

| ID | Risk | L | I | Mitigation | Trigger |
|---|---|---|---|---|---|
| R1 | **Office WAN single line** — gateway unreachable for remote workers and (if DNS resolves via tunnel) even LAN bridges; §7 names this the known residual risk | M | H | Split-horizon DNS / local DNS override so in-office bridges reach the gateway over LAN when WAN is down; LTE failover router if remote access matters in Phase 1 (§7); warm-standby cloud VM + DNS switch covers extended outages | WAN outage >15 min during business hours; tunnel disconnect alerts |
| R2 | **LLM provider rate limits** — gateway concentrates all users onto one API key/quota, unlike today's per-machine keys | M | M | Per-tenant queue/quota management in gateway (§6 names this the real bottleneck); planner/router sends parameter-level lookups to a small model (§5.2 stage 2) cutting big-model TPM; provider abstraction (D8) enables a second provider/key as pressure valve | 429/`overloaded` rate in telemetry above threshold; queue latency p95 growth |
| R3 | **Revit API serial bottleneck under multi-user** — per-session serial calls (§2 hard constraint) mean one long-running tool blocks that user's session; poorly-scoped batches amplify it | M | M | Per-session serial queue with per-invocation timeout; batch primitive keeps N round-trips to 1 (§5.2 stage 4) but batches carry size caps; sessions are independent so gateway-level parallelism across users is unaffected; result hygiene keeps payloads small | Tool-latency p95 per session rising in O7 telemetry; user reports of "stuck" assistant |
| R4 | **WSS through corporate proxies** — TLS-inspecting/WebSocket-hostile proxies at customer sites break the persistent bridge connection (low risk for own office, high for SaaS sales) | M | M–H (SaaS) | O1 mandates a fallback transport (Streamable HTTP with SSE/long-poll) behind the same reconnect logic; document proxy allowlist requirements for sales; test matrix includes a MITM-proxy lab case | Bridge cannot hold a connection >N minutes at a given site; abnormal reconnect churn per device |
| R5 | **Rollback inherits the NAS exit-84 per-machine prestage constraint — rollback is NOT one click.** The NAS Refresh path returns exit 84 *before UAC* whenever the protected bootstrap is missing/stale, and direct `-ElevatedApply` is disabled by the same guard (installer/INSTALLATION.md:40-49; installer/nas/README.md:19, 286, 337, 365; installer/nas/Refresh-revAgent-LocalBootstrap-STABLE.ps1:180). **Honest cost:** if cutover wipes `C:\ProgramData\DPE\revAgent\bootstrap\`, rollback = supervised manual high-assurance prestage (docs/BOOTSTRAP_PRESTAGE.md) on each of ~12 machines, est. 30–60 min supervised each ≈ 1–1.5 operator-days serial, *before* the NAS updater will even run | L (criterion should not trigger) | H | P-SEQ-2: preserve `bootstrap\`, `prestage\`, and `updater\config\release-trusted-keys.json` through the insurance window → rollback becomes "run `Start-revAgent-Update.cmd` per machine" (installer/INSTALLATION.md:67-73), ~10–15 min each, ~half a day fleet-wide — still per-machine, never one-click, and the runbook says so; rollback rehearsed once (P-SEQ-11); rollback is fleet-level only (P-SEQ-7) | Pre-written rollback criterion (P8-T5) fires during insurance window |
| R6 | **Bridge self-update bricking** — after NAS retirement the self-update channel is the fleet's only management path (§5.4: "the last component ever delivered by fleet push"); a bad update severs it | M | H | O9: staged rollout (1 machine → canary group → fleet); A/B install slots with automatic revert to last-good on failed post-update health check; last-good signed package cached locally; watchdog restarts; O1 version negotiation so gateway and bridge never require lockstep updates; reuse the proven detached RS256 signing + pinned trusted-keys infra (docs/DEVELOPER_RUNBOOK.md:1000-1011; signing tree explicitly preserved by E4 for O9) | >1 machine missing heartbeat after an update wave; canary health check fails |
| R7 | **Scope creep vs feature freeze** — office users keep requesting tool tweaks; single dev is also the product owner | H | M | P-SEQ-4 mechanical enforcement (PR label + review-gate clause on `src/tools/**` and `src/revit-plugin/**`); freeze-exception log; backlog parking lot groomed for post-Retire | Any PR touching frozen paths without the exception label; build-phase weeks slipping with non-migration commits in history |
| R8 | **Single-dev bus factor** — one senior dev holds gateway, bridge, installer, and signing knowledge | M | H | Docs-as-code: O1–O11 specs, runbooks, and decision log live in-repo; cutover/rollback runbooks written to be operator-executable without the dev; AI-assistant-reproducible dev environment; signing-key custody documented (docs/DEVELOPER_RUNBOOK.md:1000-1011); weekly plan doc updates (P8-T2) keep state externalized | Standing risk — reviewed at every gate |
| R9 | **Postgres data loss** — all session/registry/audit/tenant state centralizes into one DB (§5.9) | L | H | O10: WAL archiving/frequent dumps to cloud object storage, RPO ≤ 5 min, RTO ≤ 30 min (§6); **mandatory restore drill on a blank VM before go-live** (§7); warm-standby VM holds same Compose file; backup-age alert | Backup age > RPO; failed drill; standby VM unreachable |
| R10 | **Codex-desktop dependency removal changes daily UX** — today the installer manages users' `~/.codex/config.toml` MCP sections, `AGENTS.md`, and skills (installer/lib/RevAgent.CodexRegistration.psm1:3394-3402, 4050-4084, 3863); users lose their current daily driver at cutover | H | M | P-SEQ-9 + P8-T6: interim client decided at DP-10 *before pilot*; pilot user feedback shapes the quickstart; hands-on retraining pre-cutover; office hours during insurance; cutover only removes the two managed `[mcp_servers.*]` sections, leaving personal Codex config intact (E4) | Pilot-user friction reports; post-cutover usage drop vs pre-cutover telemetry baseline |
| R11 | Tunnel-provider dependency (Cloudflare-style) for the public endpoint | L | M | DNS name is ours (never an IP, §5.4/§7) so provider swap = tunnel reconfig + DNS; standby path documented in O10 runbook | Tunnel outage advisories; connect failures with WAN healthy |
| R12 | CD runner mismatch — existing self-hosted runner is Windows (`["self-hosted","Windows","revagent-cd"]`, .github/workflows/ci.yml:14, 22) but gateway CD needs Linux image build + deploy on the gateway host (§9) | M | L | Add a second self-hosted runner (Linux) on the gateway host during M6; keep Windows runner for add-in/installer builds and bridge signing | Gateway image job queued with no eligible runner |

---

## (g) DECISION LOG SEEDS — operator (Baris) confirmations before build

Numbered checklist; each with recommended default. DP-1/DP-2/DP-13 gate build start; DP-3/4/6/8/9/12 gate pilot; the rest gate cutover.

1. **DP-1 Bridge technology.** *Default: .NET 8 self-contained single-file Windows service.* Shares language/skills with the add-in (`src/revit-plugin/`), native Windows service + signing story, and removes the machine-wide Node MSI dependency, making `C:\Program Files\nodejs` wipe-eligible at Retire (E4 recommendation). Alternative: Node pkg/SEA binary.
2. **DP-2 Gateway↔bridge transport instantiation for O1.** *Default: WSS (single persistent socket, JSON messages) with Streamable-HTTP/SSE fallback for proxy-hostile networks (R4).* D3/§5.7 allow either; O1 spec fixes one primary.
3. **DP-3 Tunnel choice.** *Default: Cloudflare Tunnel (named tunnel, own domain).* Matches §7 "Cloudflare-Tunnel-style"; the dashboard add-on already has a legacy cloudflared root, so the pattern is familiar (addons/dashboard/installer/install-dashboard-tunnel.ps1:9).
4. **DP-4 Domain name.** *Default: `gateway.<company-domain>` on a domain the firm controls.* Must exist before pilot — bridges connect to a DNS name, never an IP (§5.4, §7).
5. **DP-5 OIDC provider.** *Default: Microsoft Entra ID (office M365 tenant) via standard OIDC; Keycloak container as the on-prem-variant fallback later.* Gateway speaks generic OIDC either way (§5.1.4).
6. **DP-6 LLM provider + models.** *Default: current cloud provider via the D8 OpenAI-compatible adapter; pick the small router model (§5.2 stage 2) and confirm region for §5.8 latency placement.* Keys live only at the gateway (§6).
7. **DP-7 Seat model.** *Default: named seats, enforced at bridge/session connect time (§5.1.4).* Concurrent seats deferred to SaaS phase.
8. **DP-8 Gateway host hardware check.** *Default: confirm spare PC ≥ 4 cores/16 GB/500 GB SSD, Ubuntu Server 24.04 LTS, UPS-backed, NOT co-located with the 24/7 dev machine (§7); decide LTE failover now (R1).* 
9. **DP-9 Bridge update signing (O9).** *Default: reuse the existing detached RS256 signing + pinned trusted-keys chain (production key tree at `C:\ProgramData\DPE\revAgentReleaseSigning`, docs/DEVELOPER_RUNBOOK.md:1000-1011; pinned key config `updater\config\release-trusted-keys.json`).* Authenticode purchase deferred; revisit for SaaS installer UX.
10. **DP-10 Interim client (O8).** *Default: existing MCP clients (e.g., Claude Code) against the north MCP surface during Phase 1; minimal web chat client deferred.* This is the DP that fixes what users are retrained onto (R10) — includes per-user licensing/cost confirmation.
11. **DP-11 Postgres backup target.** *Default: S3-compatible cloud bucket for WAL/dumps (O10); name the provider and budget.* 
12. **DP-12 Pilot machine + pilot user + cutover window date.** *Default: a designer power-user willing to report friction; cutover on a weekend evening; both named at M0, revisited at M7.*
13. **DP-13 Monorepo layout.** *Default: as proposed in Week-1 list below (`packages/gateway`, `packages/bridge`, `packages/protocol`; existing dirs untouched).* 
14. **DP-14 Node MSI disposition.** *Default: if DP-1 = self-contained bridge, mark `C:\Program Files\nodejs` wipe-eligible but defer removal to Retire (low priority, per E4).* 
15. **DP-15 Historical usage-data archive location.** *Default: read-only copy of existing telemetry/state (`state\telemetry`, NAS logs) parked on the NAS archive until retirement, then cold storage; no migration into the new store (closed per O11).* 

---

## (h) WEEK-1 CONCRETE TASK LIST (coding assistant starts tomorrow)

**W1-1 — Decision checkpoint prep + session (0.5 d).** Produce DP-1..DP-15 one-pagers with defaults (from section g); hold the confirmation session; commit outcomes to `docs/decisions/DP-log.md`. Blocks W1-2 only on DP-1/DP-13 (defaults are safe to pre-scaffold).

**W1-2 — Monorepo scaffold (1 d).** Root `package.json` with npm workspaces limited to `packages/*`:
- `packages/gateway/` — TypeScript, ESM, strict, mirroring the runtime's proven config (ES2022/NodeNext/strict, installer/runtime-mcp-server/tsconfig.json:2-15); depends on `@modelcontextprotocol/sdk` (same major as runtime's `^1.29.0`, which already ships `StreamableHTTPServerTransport` — installer/runtime-mcp-server/package.json:75-84).
- `packages/bridge/` — per DP-1; if .NET 8, this directory holds the .NET solution (npm workspaces simply don't include it) so the layout survives either DP-1 outcome.
- `packages/protocol/` — the O1 contract as JSON Schemas + generated TS types (and C# types via codegen if DP-1 = .NET); validation with ajv, same pattern already proven in the runtime's spatial schemas (`schemas/spatial/*/…schema.json` + `src/spatial/spatialPageSchema.ts`).
- **Existing dirs untouched:** `installer/runtime-mcp-server/` stays in place with its own lockfile until P3 relocation (its lockfile path is wired into CI cache, .github/workflows/ci.yml:31-35); `src/revit-plugin/`, `installer/`, `addons/`, `evals/`, `config/`, root `AGENTS.md`/`SKILL.md` unchanged.

**W1-3 — O1 spec v0.9 (2 d).** `docs/specs/O1-bridge-gateway-protocol.md` covering, per O1: handshake + device-token auth, session registration/resume `(user, machine, open documents)`, invocation message, batch message (one Revit transaction group), idempotency-key + journal semantics (record `(invocation id → outcome)`, answer redelivery from journal — §5.4), result streaming/chunking, heartbeat + timeout values, protocol version negotiation (feeds R6 mitigation), error taxonomy (retryable vs terminal, parameter vs environment fault — §5.2 stage 4/Failure semantics). Freeze to v1.0 = M1 after one review pass.

**W1-4 — CI skeleton (0.5 d).** Add a `gateway-gates` job to `.github/workflows/ci.yml` (lint + `tsc --noEmit` + vitest for `packages/*`), defaulting to the existing runner labels to respect the GitHub-hosted budget constraint documented in the workflow itself (ci.yml:12-14, 22 — Node is already provisioned there, ci.yml:26-35). Stub `gateway-cd.yml` (build container image on main; deploy job lands at M6 with the Linux runner on the gateway host per §9 and R12). Add the P8-T8 freeze clause to `claude-review.yml`.

**W1-5 — Transport spike (1 d).** Minimal `packages/gateway` server that imports the existing runtime's `registerTools` (installer/runtime-mcp-server/src/tools/register.ts) and serves the 35-tool catalog over `StreamableHTTPServerTransport` instead of stdio — the one-file swap point is `src/index.ts:19-20`. Deliverable: an external MCP client lists tools over HTTP; latency baseline recorded. De-risks the M2 lane before it starts. (Side finding to log for P3: `ws` is a declared-but-unused runtime dependency — drop during relocation.)

**W1-6 — Phase-1 Compose skeleton (0.5 d).** `deploy/phase1/docker-compose.yml`: gateway, `postgres:16`, Caddy (auto-TLS), object-storage volume; `.env.example` with every environment-specific value externalized (12-factor per §7); no secrets in repo.

**W1-7 — Operator parallel tasks (0 dev-days; Baris, this week).** Register/confirm domain (DP-4); create tunnel account (DP-3); Entra ID app registration (DP-5); inventory the spare PC against DP-8 and install Ubuntu Server; confirm LLM key/region (DP-6).

**W1-8 — P8 artifacts started (0.5 d).** Skeletons for `docs/plan/MASTER_PLAN.md` (milestone tracker), rollback-criterion draft (P8-T5), and comms announcement draft (P8-T6) so the cutover-facing documents accrete from week 1 instead of being written under pressure at M8.

**Week-1 exit check (= Phase 0 exit):** DP-1/DP-2/DP-13 recorded; O1 v0.9 in review; CI green including the new `gateway-gates` job; spike demo shown; Ubuntu host reachable.