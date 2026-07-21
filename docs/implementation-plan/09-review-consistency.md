> Independent review report over sections 01-08. Its findings are resolved normatively in `00-INDEX.md`
> (RES-* and GAP-* entries); this report is retained as the rationale record.

# CONSISTENCY CRITIC REPORT — 8 plan sections vs docs/TARGET_ARCHITECTURE.md and each other

Baseline: /home/user/revAgent @ 11020d1 + uncommitted docs/TARGET_ARCHITECTURE.md (read in full). Repo claims cited by planners were spot-verified where findings depend on them (verified: 21 add-in commands in src/revit-plugin/revAgentCommandSet/command.json; 35 tools at installer/runtime-mcp-server/src/tools/register.ts:39-76; better-sqlite3@12.9.0 / ws / @modelcontextprotocol/sdk ^1.29.0 at installer/runtime-mcp-server/package.json:77-93; mcp_status registry bypass at src/revit-plugin/revAgentPlugin/Core/SocketService.cs:522-526; IPAddress.Any listener at SocketService.cs:157; port auto-increment loop at SocketService.cs:149-185; runner labels + budget stance at .github/workflows/ci.yml:13-20; NO writer of %TMP%/revAgent-instances.json anywhere in the repo — only readers at installer/runtime-mcp-server/src/utils/ConnectionManager.ts:39 and a test fixture at scripts/env-alias.test.mjs:73).

No section violates the hard constraints (in-process Revit API, serial-per-session, outbound-only, no MCP on the Gateway↔Bridge hop) and no section substantively reopens D1–D12. All findings below are cross-section contradictions, ownership defects, or reconciliations the coordinator must impose.

## FINDINGS (ordered by severity)

### F1 — CRITICAL — P4 vs P5: Phase-1 object store is decided twice, oppositely
- P4 P-DATA-5: "MinIO as the Phase-1 object store (one more Compose service on a filesystem volume)". P5 P-HOST-3: "plain bind-mounted volume (/opt/revagent/data/objects) behind an in-code storage-driver interface (OBJECT_STORE_DRIVER=fs|s3); no MinIO" — with explicit anti-MinIO rationale.
- Why it conflicts: same Compose stack, mutually exclusive services. Downstream coupling: P5 P-BCK-3 (rclone sync of /opt/revagent/data/objects) and the O10 restore drill assume the fs driver; MinIO would change the backup surface, secrets set, and runbook. Both are compatible with arch §7's "object-storage volume" (docs/TARGET_ARCHITECTURE.md:194), so neither is an arch violation — it is a pure P4/P5 contradiction.
- Fix: infra owner (P5) decides. Recommend adopting P5 P-HOST-3 (fs driver now, s3 driver at SaaS); P4 rewrites P-DATA-5 to "object storage accessed only through the storage-driver interface defined by P5; fs in Phase 1, S3-compatible later" and drops the MinIO service. If the coordinator instead keeps MinIO, P5 must add it to the Compose stack, secrets plan, monitoring, and O10 runbook. One sentence, one owner, referenced by both sections.

### F2 — CRITICAL — P1 vs P3: two different bridge implementation stacks are assumed
- P1 P-O1-4: idempotency journal is "bridge-local SQLite (better-sqlite3, already an exact-pinned runtime dependency, installer/runtime-mcp-server/package.json:75-84)... Reuses the shipped native store" — this presumes a Node bridge reusing the runtime's npm stack. P3 P-BRIDGE-1/-3: bridge is a .NET 8 self-contained single-file Windows service; journal via Microsoft.Data.Sqlite + bundled e_sqlite3 (with a decision table explicitly rejecting the Node-packaged option).
- Why it conflicts: the two packages would produce incompatible work breakdowns (npm-native module vs .NET publish); P1's stated rationale is false under P3's decision; P1 P-O1-12's "scan mirrors ConnectionManager.ts" becomes a port, not reuse.
- Fix: P3 P-BRIDGE-1 is the implementation decision of record (it did the evaluation and it owns the bridge). P1 must be de-implementation-ized: P-O1-4 states only protocol-level journal semantics (durable SQLite-class store, keyed by the idempotency key, answer-from-journal on redelivery per arch §5.4:131); delete the better-sqlite3 rationale and any Node assumption from P1.

### F3 — HIGH — P1 vs P3: doc-context mechanism contradicts on source, cadence, and add-in change
- P1 P-O1-11: `doc_context_update` derived by polling existing commands `get_current_view_info`/`list_open_views` (snapshot at register, refresh after each invocation + 30 s idle poll), explicitly "without touching the add-in". P3 P-BRIDGE-5: NEW add-in command `get_document_context` served from a cached snapshot maintained via DocumentOpened/DocumentClosed/ViewActivated app events, polled every 15 s, and explicitly rejecting P1's mechanism ("polling the existing list_open_views/get_current_view_info commands would burn ExternalEvent slots on the Revit UI thread").
- Why it conflicts: same wire message, two incompatible data sources, two cadences (30 s vs 15 s), and opposite positions on whether the add-in changes.
- Fix: P3's cached-snapshot command is the target mechanism (it matches the proven registry-bypass pattern at SocketService.cs:522-526 and costs no ExternalEvent). P1 keeps only the `doc_context_update` message shape and may note the poll-existing-commands variant strictly as a pilot-era fallback IF the pilot must run an unchanged add-in (see F4). Pick one cadence (15 s, P3's) and state it in both.

### F4 — HIGH — P1 vs P3: pilot-time add-in mutability, batch command name, and bridge batch behavior all disagree
- P1 non-goals: "RBP/1 is designed so the pilot ships with the add-in unchanged"; P-O1-7: command named `execute_batch`; until it exists the Bridge executes batches sequentially (atomic:false accepted, atomic:true rejected `unsupported` behind capability `batch_atomic`). P3: in-scope "minimal add-in adaptation" includes `batch_execute` (different name), loopback bind (P-ADDIN-1), framing config gate (P-ADDIN-2), `get_document_context` (P-BRIDGE-5), two concurrency fixes (P-ADDIN-4) — with no statement of when these land relative to the pilot — and P-ADDIN-3 says "The bridge passes Gateway batch messages through as ONE framed request" (presumes the command exists).
- Why it conflicts: (i) command name `execute_batch` vs `batch_execute`; (ii) P1 promises an unchanged-add-in pilot while P3's package is precisely add-in changes with no phasing; (iii) bridge batch behavior: sequential fan-out (P1) vs single pass-through (P3). Related timing nuance: P1 P-O1-10 says DetectMessageFraming (SocketService.cs:416-439) "stays for back-compat but is never exercised" while P3 P-ADDIN-2 schedules its removal one release after cutover.
- Fix: (1) one command name — pick `execute_batch` (P1 is the protocol owner; P3 renames). (2) P3 adds an explicit staging statement: pilot runs the unchanged add-in (P1 stands); the five add-in adaptations land between pilot exit and cutover (or as a pilot-week update proving self-update, aligning with P8 P-SEQ-1). (3) Bridge batch behavior is capability-gated exactly per P1 P-O1-7; P3's pass-through is the post-adaptation path when `batch_atomic` is advertised. (4) Adopt P3's framing-shim retirement schedule in P1.

### F5 — HIGH — P3 vs P8: cutover uninstaller wipe list would destroy the rollback trust anchor
- P3 scope item 3: uninstaller "implementing E4's wipe list (old NAS/updater/Codex stack removal)" — no exclusions stated. P8 P-SEQ-2: the cutover wipe must PRESERVE C:\ProgramData\DPE\revAgent\bootstrap\, prestage\install-revagent-local-bootstrap.ps1, and updater\config\release-trusted-keys.json until Retire, because NAS Refresh exits 84 pre-UAC without them (installer/INSTALLATION.md:40-49; installer/nas/Refresh-revAgent-LocalBootstrap-STABLE.ps1:180) — i.e., wiping them voids D11 step 4's rollback insurance (docs/TARGET_ARCHITECTURE.md:207).
- Why it conflicts: if P3 builds the uninstaller literally to its own text, P8's rollback runbook (P8-T5) and the 2-week insurance window are non-functional; P8-T4 assumes exclusions P3 never committed to.
- Fix: the normative wipe list lives in exactly one artifact — P3's uninstaller spec — and MUST incorporate P8 P-SEQ-2's exclusion list verbatim, with the residual wipe of the preserved items moved to P8-T9 (Retire checklist). Add to P3's acceptance criteria: "uninstaller dry-run leaves the P-SEQ-2 trust-anchor paths intact; verified in the P8-T4 VM rehearsal."

### F6 — HIGH — P4 vs P7: O11 metric-parity deliverable is dual-owned
- P4 scope item (4): "the O11 metric-parity mapping — which currently tracked metrics map to which event fields, and which workstation-era metrics die". P7: "The normative metric-parity check table (below)... is the O11 pre-cutover gate artifact and the field-requirements handoff to the O7 telemetry-schema task."
- Why it conflicts: two sections each claim the same normative artifact; divergent tables would make the O11 pre-cutover gate (docs/TARGET_ARCHITECTURE.md:234, P8 P-SEQ-10) ambiguous.
- Fix: P7 owns the normative parity table (it produced it, rows 1–11+). P4's scope item (4) is rewritten to: "implement in revagent.event.v2 every 'O7:' field the P7 parity table requires" — consumer of requirements, not owner of the mapping. This also matches P7 P-ADMIN-3 (gaps closed only by adding O7 fields).

### F7 — MEDIUM-HIGH — P4 vs P7: heartbeat persistence model contradicts the parity table's own target sources
- P4 P-EVT-2: "Heartbeats are state, not history... never persisted as events. Only transitions (bridge.connected/bridge.disconnected) are events." P7 parity rows 2 and 7 name their target source as "O7: `bridge.heartbeat`" (an event).
- Why it conflicts: under P4's rule the event type `bridge.heartbeat` does not exist, so two KEEP/TRANSFORM rows in the normative gate table have no source; the gate diff (P-ADMIN-9) would fail structurally.
- Fix: re-target P7 rows 2 and 7 to "PG: devices.last_seen_at + authoritative WSS connection state (P4 P-EVT-2), transitions from bridge.connected/disconnected events" — row 2's own prose already declares socket state authoritative. No bridge.heartbeat event type anywhere.

### F8 — MEDIUM-HIGH — P8's package-area labels misassign O8 and O9 ownership
- P8 defines its own P1–P7 labels which do not match the actual sections: P8's "P2"=Bridge+O1+add-in (actually split P1-protocol / P3-bridge); "P3"=runtime relocation + docs MCP server (actually P2-gateway-core P-GW-2); "P6"=installer/uninstaller/cutover + CI/CD + "bridge self-update signing (O9)" (actually installer/uninstaller AND O9 are P3-bridge; CI/CD is P5, which explicitly disclaims O9 signing); "P7"=admin + O8 (actual P7-admin never mentions O8).
- Why it conflicts: P8 hedges ("map to your P-numbering by area name"), but two assignments are substantive, not clerical: O9 bundled into a CI/CD package that two real sections say does not own it, and O8 handed to a package that does not accept it. Since P8's milestones/gates reference these labels, verbatim-adjacent synthesis would produce a plan whose gates point at the wrong packages.
- Fix: coordinator rewrites P8's label key to the real mapping (P1 protocol; P2 gateway core incl. runtime relocation + docs-MCP internalization; P3 bridge + add-in + installer/uninstaller + O9; P4 data/auth/O7; P5 infra/CI-CD/O10; P6 APS/O4; P7 admin/O11) and re-points every milestone/gate reference. O8 per F12.

### F9 — MEDIUM — P1 vs P3: mcp_status preflight retired vs kept
- P1 P-O1-6: "Retire the per-command mcp_status preflight (2 TCP round-trips per tool call today, SocketClient.ts:279-304)"; busy state rides heartbeat `revit_status` + `revit_busy` retryable fault. P3 P-BRIDGE-4: "the mcp_status preflight... is kept as defense-in-depth and as the source of 'busy with task X' errors".
- Why it conflicts: direct decision contradiction (retire vs keep); P1's rationale is eliminating the fixed per-invocation RTT which P3 reinstates (loopback-cheap, but the plan must say one thing).
- Fix: single rule stated identically in both: no per-invocation preflight is part of the invoke path; the bridge consults local mcp_status (a) to feed the heartbeat `revit_status` block and (b) on failure paths to enrich the structured `revit_busy` fault. P3 drops the word "preflight".

### F10 — MEDIUM — O2 (code-execution sandbox design) has NO owner
- P2 P-GW-8 ships Mode B interfaces only and states "Everything else... is O2, deferred"; P2 non-goals: "Mode B sandbox internals (O2)"; P4 and P6 also non-goal it. No section claims O2, yet arch §10 lists it as an item the implementation plan must cover (docs/TARGET_ARCHITECTURE.md:225) and Mode B is the designated local-LLM path (D5, §5.2.3).
- Fix: coordinator must record O2 as an explicitly deferred work package with a named owner-on-activation (natural home: P2/gateway-core team) and a trigger milestone (post-cutover, before any local-LLM commitment). Silence is not deferral.

### F11 — MEDIUM — O6 (module packaging) has NO owner
- P2 covers registry, versioned SKILL/AGENTS serving, per-module registry-seed.json, and P4 has `modules`/`tenant_modules`/`instruction_docs` tables — but neither claims O6 (how a discipline module: tools + SKILL/AGENTS + policies is packaged, versioned, registered; docs/TARGET_ARCHITECTURE.md:229). P6-T1's phrase "Registry (O3/O6)... packages" implies a registry package owns it, unclaimed.
- Fix: assign O6 explicitly to P2 (registry owns the packaging/versioning format; P4 provides storage). Add one scope line to P2 and note the P4 dependency.

### F12 — MEDIUM — O8 (Phase-1 client scope) ownership is ambiguous across P2 and P8
- P2 wires the north MCP surface "so Phase-1 interim clients (O8, e.g. Claude Code) can drive the Gateway"; P8 P-SEQ-3 makes the O8 scope decision ("Phase 1 uses existing MCP clients against the north MCP surface per O8/§5.5") and P8-T6/DP-10 owns client comms; P8's label map assigns O8 to "P7" (admin), which never mentions it. Nobody owns the eventual minimal web chat client.
- Fix: split explicitly: P8 owns the O8 decision + rollout comms (P-SEQ-3, DP-10, P8-T6); P2 owns the north-surface implementation the decision relies on; web chat client is recorded as a named post-insurance package. Remove O8 from any admin-package association.

### F13 — MEDIUM — P6's five Phase-1 seam requirements are absent from P2's registry model and P4's schema
- P6-T1 requires: executor enum `bridge|aps|internal`; logical-tool `variants[]` (P-APS-1); `dynamic_code`→`aps` binding prohibition (P-APS-6); URN-capable document-id fields; structured `executor_unavailable`. P2 P-GW-4/P-GW-5 model executor binding but no `variants[]` and no dynamic-code prohibition; P4's `tools`/`tool_versions` catalog tables show none of the five. P6 also correctly flags (verified) that no `aps` executor value exists anywhere in the codebase today.
- Why it conflicts: if P2/P4 build to their own text, P6-T1's signoff gate fails and the seams get retrofitted post-freeze — exactly what seam reservation was meant to avoid.
- Fix: P2 adds `variants[]` + the `dynamic_code`-never-`aps` constraint to the registry record definition; P4 adds the executor enum value, variants storage, and URN-capable document-id columns to the schema sketch; P8 schedules P6-T1 as a blocking review before the P4 schema freeze milestone.

### F14 — MEDIUM — P5 vs P8: cutover runbook and rollback criterion claimed twice
- P5 scope: "cutover-night runbook skeleton for ~12 machines... with a rollback criterion template". P8-T4: cutover-night runbook (VM-rehearsed); P8-T5: rollback runbook + pre-written criterion signed by operator.
- Fix: P8 owns both runbooks and the signed criterion (it owns sequencing/gates); P5 contributes only the infra-side checklist section (host, tunnel, standby, DNS/tunnel-replica checks) as input to P8-T4. Delete "rollback criterion template" from P5's scope.

### F15 — LOW-MEDIUM — P1/P2/P3: serial-execution "ownership" asserted in three places
- P1 P-O1-5: window=1 per rsid "enforced at the Gateway dispatcher and asserted by the Bridge". P3 P-BRIDGE-4: "Serial-execution ownership moves... into the bridge" (SemaphoreSlim(1) per session). P2's dispatcher middleware implies gateway-side enforcement too. The serial constraint itself is preserved everywhere (no violation), but "owner" is claimed twice.
- Fix: one normative sentence in all three sections: the Gateway dispatcher is the authoritative enforcement point (P1 P-O1-5); the bridge per-session queue and retained add-in defenses (P-ADDIN-4) are defense-in-depth.

### F16 — LOW-MEDIUM — P1 vs P3: %TMP%\revAgent-instances.json reliance
- P1 P-O1-12: the registry file "is not relied on — nothing in the repo writes it" (VERIFIED: only readers, ConnectionManager.ts:39 and test fixture env-alias.test.mjs:73; no writer exists). P3 P-ADDIN-5: "the bridge ports the runtime's candidate scan [8080..8085] + %TMP%\revAgent-instances.json registry read".
- Fix: drop the registry-file read from P3; discovery = port scan 8080-8085 + mcp_status probe only (P1 P-O1-12), plus env override. P1's factual claim stands.

### F17 — LOW — P7 vs P4: role name `admin` does not exist in P4's enum
- P7 gates admin surfaces "with the `admin` role delivered by P4"; P4 P-AUTH-3 defines `user | tenant_admin | vendor_admin` (no `admin`). Arch §6/§5.10 says `user`/`admin` from day one, later split — P4 implements the split early (acceptable, not a reopen), but the cross-reference dangles.
- Fix: P7 references `tenant_admin`; P4 adds one line: "the §6 `admin` role is realized as `tenant_admin` in Phase 1."

### F18 — LOW — P2 vs P4: promotion-registry naming mismatch
- P2 P-GW-4: config/dynamic-tool-promotion-registry.json "folds in later as `tool_candidate` records"; P4 catalog table list names it `promotion_registry`. Same data, two names.
- Fix: one name — table `promotion_registry` holding `tool_candidate` rows, stated identically in both.

### F19 — LOW — P7 vs P1: two liveness-staleness vocabularies for the same connection
- P7 row 2 retains today's 60 s/300 s thresholds "for heartbeat-gap degradation" (server.mjs:13-14); P1's protocol FSM defines degraded=35 s / disconnected=65 s at the Gateway.
- Fix: the dashboard renders the Gateway's authoritative FSM states (P1's 35/65); the legacy 60/300 thresholds are dropped, per P7's own "socket state is authoritative" clause.

### F20 — LOW — Idempotency key expressed three ways
- P1 P-O1-4: key = `rsid/invocation_id`. P3 P-BRIDGE-3: journal PK = `invocation_id` with separate `session_id` column. P4 P-AUD-1: audit unique on `(tenant_id, idempotency_key)`.
- Fix: P1 (protocol owner) defines the canonical key once; P3's journal and P4's audit uniqueness constraint both reference that exact definition (composite `rsid`+`invocation_id` or a single canonical string — pick one).

### F21 — LOW — P6-T1 mislabels the registry package as "(O3/O6)" and docs-MCP relocation has no explicit owner
- O3 is the tenant/data-model schema (P4); the registry is P2. Cosmetic but coordinator synthesizes verbatim — fix the reference to "Tool Registry package (P2) and data-layer package (P4)". Separately: P3 states installer/revit-api-docs-mcp/ "becomes a gateway-internal executor" but only owns wiping it from workstations; P2's relocation scope names only runtime-mcp-server; P8's label map puts it under "runtime relocation". Assign docs-MCP internalization explicitly to P2.

## O1–O11 OWNERSHIP MAP (requirement: exactly one owner each)

| Item | Owner | Status |
|---|---|---|
| O1 Bridge↔Gateway protocol spec | P1 (P3 implements bridge side as consumer) | OK — single owner |
| O2 Code-exec sandbox design | NONE (P2 stubs interfaces only, explicitly defers) | DEFECT — unowned (F10) |
| O3 Tenant & data model schema | P4 | OK (P1/P3 consume; P6-T1 mislabel, F21) |
| O4 APS integration details | P6 | OK |
| O5 Licensing/entitlement model | P4 (P-LIC-1/2) | OK |
| O6 Module packaging | NONE (P2 adjacent, unclaimed) | DEFECT — unowned (F11) |
| O7 Telemetry/event schema | P4 (P-EVT-1..5; P7 supplies field requirements) | OK |
| O8 Phase-1 client scope | AMBIGUOUS (P2 implements north surface; P8 P-SEQ-3 decides; P8 label map says "P7") | DEFECT (F12) |
| O9 Bridge self-update | P3 (scope item 4; P5 explicitly disclaims; P1 defines wire touchpoint only) | OK, but P8 label map misassigns to CI/CD package (F8) |
| O10 Backup/restore runbook | P5 (P8 P-SEQ-11 gates on it — consistent) | OK |
| O11 Admin-plane migration / metric parity | DUAL: P4 scope item (4) AND P7 normative table | DEFECT — dual-owned; resolve to P7 (F6) |

## VERIFIED CLEAN (no action)
- D3/D4 respected in all 8 sections: internal hop is RBP/1 (not MCP); MCP only at the north boundary; every client link outbound-only (P1 WSS dial-out, P3 outbound WSS, P5 Cloudflare Tunnel).
- In-process constraint respected: live execution stays in the add-in everywhere; P6's DA4R is published-plane only (D7) and P-APS-6 bans dynamic code on APS (consistent with D12).
- Feature freeze: P3's add-in changes are architecture-mandated adaptations (batch primitive §5.2.4, doc context §5.2.1, loopback per §6) or bugfixes; P6 defers ALL APS runtime code to Phase 2 with only 2 dev-days of schema seam reservation; P8 P-SEQ-4 mechanizes enforcement. No feature-freeze violations found.
- No silent reopen of D1–D12: P1's WSS-only choice is within D3's "WSS / Streamable HTTP"; P2's 4 pinned core tools within D5's 3–5; P4's early role-split implements (not contradicts) §6's later-split note; P5's tunnel-replica failover refines §7's DNS-switch and retains it as documented fallback; P6 and P8 independently agree APS is post-cutover (P-SEQ-3 ≡ P6 phase determination).
- §9 "what does not change" honored: tool implementations relocated not rewritten (P2 P-GW-2/3), TCP framing kept on the add-in hop (P1/P3), CI/CD pattern extended additively (P5 P-CD-3 never edits frozen workflows), duct engine untouched, AGENTS/SKILL served from registry (P2).