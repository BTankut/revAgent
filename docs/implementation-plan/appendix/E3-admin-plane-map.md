> Codebase map produced during plan exploration (evidence layer for sections 01-08).
> Line numbers cite commit `11020d1`; re-verify before editing code.

# TASK E3 — Admin-Plane Inventory (O11): Dashboard + Usage Intelligence + Metric-Parity Checklist

## 1) Dashboard (addons/dashboard/)

### 1.1 Server tech
- Single-file, zero-dependency Node.js ESM HTTP server: `addons/dashboard/server/server.mjs` (1,142 lines) using only `node:http`/`node:fs`/`node:path` (server.mjs:1-5). One helper module `addons/dashboard/server/revitTaskMerge.js` (merges cached/current Revit task snapshots). No framework, no DB, no websockets — browser polls `/api/overview` every 3 s (public/app.js:505); the server re-reads NAS files on every request.
- Endpoints: `/api/overview` (full snapshot, schema `revagent.dashboard.snapshot.v1`, server.mjs:983,1115-1117), `/api/brief` (compact LLM/admin brief, schema `revagent.dashboard.brief.v1`, server.mjs:1023-1061,1119-1121), `/api/health` (server.mjs:1123-1130), plus static file serving of `public/` (server.mjs:1090-1110).
- In-memory 10-minute live-status cache to bridge machines that flap offline (`LIVE_STATUS_CACHE_TTL_MS`, server.mjs:15-16, 88-120).

### 1.2 Data sources (all NAS SMB file reads; nothing is pushed to the server)
Default roots: `reportsRoot = \\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports`, `releaseRoot = parent of reportsRoot` (server.mjs:10, 37-44). Per request it reads:
- `releaseRoot\channels\stable.json` — target/stable version (server.mjs:918); produced by the release CD pipeline (.github/workflows/signed-source-free-cd.yml:276,487).
- `reports\machines\<MACHINE>\latest.json` + `update-latest.json` / `reinstall-latest.json` / `install-latest.json` / `source-free-migration-latest.json` — per-machine updater run reports (server.mjs:935-944), produced on each workstation by `Publish-RevitMcpMachineRunReport` (installer/lib/RevAgent.Reporting.psm1:440-513; report fields from New-RevitMcpUpdateReport:354-377; diagnostics fields set in installer/nas/update-from-nas.ps1:4517-4528, 6514-6524).
- `reports\live\machines\<MACHINE>\status.json` — live heartbeat snapshot, schema `revagent.live.status.v1`, written by the workstation Node MCP runtime every tool event and on a 5 s heartbeat (installer/runtime-mcp-server/src/utils/telemetry.ts:1441-1470, 1513-1522, 1709-1726; interval env `REVAGENT_LIVE_STATUS_HEARTBEAT_MS`, default 5000, telemetry.ts:210-212).
- `reports\live\machines\<MACHINE>\activity\<YYYY-MM-DD>.ndjson` — live activity lifecycle events, schema `revagent.live.activity.v1` (telemetry.ts:1576-1587); dashboard tails up to 4 MB/file (server.mjs:12,136-165, 929-932).
- `reports\summaries\latest.json` and `reports\summaries\publish-latest.json` — usage-intelligence daily summary + publish report (server.mjs:919-920).
- Embedded in status.json: `revitStatus` — the C# add-in's own task board (active/recent tasks incl. `requestBytes`, `responseBytes`, `port`, `elapsedMs`, `error`), pulled from the add-in over the local TCP framing and recorded by the runtime (installer/runtime-mcp-server/src/utils/revitToolHelpers.ts:464 → telemetry.ts:1412-1422, publicRevitStatusTask 1312-1341, capped at 100 recent tasks:1406) — and `writeHealth` (`inFlight`, `dropped`, `maxInFlight`) from the NAS write queue (telemetryWriters.ts:76-83).

### 1.3 What it shows (every view/metric)
UI (public/index.html:29-49, app.js):
- Header: stable channel version, last refresh time, theme switch (app.js:233-236).
- **Machine Status Windows** grid — one card per machine: machine name, userName, connection pill (`online`/`stale`/`offline`; thresholds staleSeconds=60, offlineSeconds=300, server.mjs:13-14,274-283), version pill (`upToDate`/`outdated`/`unknown`, server.mjs:285-292), task pill (`running`/`idle`), update badge (`Update failed`/`Pending restart` i.e. deferredForRevitClose), installed version (shortened), last-seen timestamp; per-machine "Monitor" filter (app.js:261-304).
- **All Status Activity** stream — merged, deduplicated, lifecycle-collapsed feed across machines (server.mjs:425-719: collapses started/finished pairs, groups nested mcp.tool+revit.command events within 2 s, enriches add-in status rows with telemetry tool names, normalizes "guided unsupported" failures to completed:383-401). Each line: time, phase mark (started `...` / completed `✓` / guarded `!` / failed `X`), machine, task title, tool/scope, duration + request/response KB (app.js:165-179). Filter chips per machine; expand 50→200 records.
- API-only metrics (in `/api/overview.overview`, server.mjs:732-762): machineCount, currentVersionCount, liveMachineCount, activeMachineCount, failedMachineCount, staleMachineCount, offlineMachineCount, summaryDateUtc, eventCount, sessionCount, productionOperationCount, live completed/guarded/failed counts, summaryProductionOperationCount, summaryGuardedCount, summaryFailedCount, sendCodeCount.
- `/api/brief` additionally exposes (server.mjs:1023-1061): per-machine state + heartbeatAgeSeconds + activeTask + latestActivity + updateStatus, recentActivity (80), toolUsage top-20, full sendCode block, promotionCandidates / nativeToolCandidates / hotfixCandidates / reconciliationCandidates / annotationInventoryCandidates (20 each), evidenceStrength, humanReviewRequired, friction {failed, guarded, slow}.

### 1.4 Deployment / access / auth
- Admin-only add-on (`installRole: "admin"`, addons/dashboard/addon.json:5), installed on ONE coordinator workstation to `C:\ProgramData\DPE\revAgent\addons\dashboard` (addon.json:6), auto-started at logon via hidden VBS launcher + scheduled task with fallback chain Register-ScheduledTask → schtasks.exe → HKCU Run (installer/install-dashboard-addon.ps1:265-359,387-415). Binds `127.0.0.1:8765` by default (install-dashboard-addon.ps1:12-14).
- Remote access: a **Cloudflare named tunnel** (cloudflared.exe + config.yml + credentials file copied under the add-on `tunnel\` dir, own logon scheduled task) — installer/install-dashboard-tunnel.ps1 (whole file; health checks:485-534,612-621), start-dashboard-tunnel.ps1:36.
- **Auth: none in the application.** server.mjs contains zero authentication/authorization code; protection = loopback bind + whatever Cloudflare Access policy exists outside the repo. Confirms the O11/5.10 RBAC requirement is net-new work.
- Tests: `addons/dashboard/tests/smoke-test.mjs` (708 lines) builds a fake reports tree and asserts snapshot/brief shaping — reusable as a parity fixture against the future admin API.

## 2) Usage Intelligence (addons/usage-intelligence/)

### 2.1 Collection mechanism (three collectors, all workstation-era)
1. **Runtime telemetry (every workstation, passive)** — the Node MCP runtime wraps every MCP tool handler (`wrapServerWithTelemetry`, telemetry.ts:1820-1935) and every Revit bridge command (`recordRevitCommandTelemetry`:1771-1811). Writes NDJSON events (schema `revagent.telemetry.v1`) to BOTH a local mirror `C:\ProgramData\DPE\revAgent\state\telemetry\events\<ymd>.ndjson` and NAS `reports\events\YYYY\MM\DD\<MACHINE>\<sessionId>.ndjson` (resolveTelemetryTargets, telemetry.ts:1211-1231; local root: runtimeIdentity.ts:86-88). Event types: `runtime.session.start` (1764-1769), `mcp.tool` (1856-1868), `revit.command` (1777-1800), `production.context` (derived Revit-document context per operation, 1033-1184), plus live feed `live.activity` and `status.json` (§1.2). Kill switches: `REVAGENT_TELEMETRY_DISABLED`, `REVAGENT_TELEMETRY_LOCAL_ONLY`, `REVAGENT_LIVE_STATUS_DISABLED` (152-208). Privacy shaping: free-text params stored as hash+length+bounded text (1000 chars default), `code` stored as hash/length/lineCount/writePatterns/hasManualTransaction + 4000-char preview (summarizeTelemetryParams/summarizeCode, telemetry.ts:310-422); spatial-extraction tools get param/result summarization and taskName scrubbing (57-144, 1610-1619).
2. **Codex session context exporter (every production workstation, scheduled task daily 20:15)** — `scripts/install-codex-session-export-task.ps1` (DailyAt 20:15:15; backfill StartDateUtc default 2026-06-29:25) runs `publish-codex-session-context.ps1` → `export-codex-session-context.ps1`, which parses local Codex desktop JSONL transcripts (`%USERPROFILE%\.codex\sessions\*.jsonl` + `session_index.jsonl`, export:122-157) and writes BOUNDED context (no raw transcript; caps: 600 chars/text, 12 user requests, 8 assistant outcomes, 80 tool calls, export:20-24) to NAS `reports\codex-sessions\YYYY\MM\DD\<machine>\<sessionId>.context.json`, schema `revagent.codex.session.context.v1` (export:782-818). Captured: codexSessionId, threadId, threadTitle, machineName, userName, started/endedAtUtc, workspace paths/names (cwd), userRequests[{timestampUtc,text,localImagePaths}], assistantOutcomes, toolCalls[{name,type,timestamp}], toolUsage counts.
3. **Coordinator daily publisher (ONE admin workstation, scheduled task daily 20:30)** — `scripts/install-usage-summary-task.ps1` (DailyAt 20:30:14) runs `publish-usage-summary.ps1` with lock file + logging (lock `summaries\publish.lock`, logs keep-last-30, publish:241-346), which chains: `summarize-usage-intelligence.ps1` → `correlate-usage-sessions.ps1` → `prepare-llm-review-pack.ps1`.

### 2.2 Outputs / reports (storage: all under NAS `reports\`)
- **Daily usage summary** `summaries\daily\YYYY-MM-DD.json` (+`.md`), copied to `summaries\latest.json/.md`; schema `revagent.usage.summary.v1` (summarize-usage-intelligence.ps1:1961-2022). Contents: source counters (machineReportCount, eventFileCount, eventCount, badEventLineCount); machines[] (per-machine updater report echo:1455-1474); totals (byEventType, byMachine, byUser, sessionCount); toolUsage[] and commandUsage[] rows {name, count, successCount, guardedCount, failedCount, averageDurationMs, maxDurationMs} (163-263); production {operationCount, byMachineUser, byProject, byDiscipline, byLevel, byCategory, generatedFileCount, taskNameSamples, searchPolicySamples} (1988-1998; discipline/level inferred by regex from context text:710-761); friction {guarded[], failed[], slow[]} operation briefs incl. project/view/level/room/search-policy (878-939, 1589-1605); sendCode {count, rawCount, safeCount, manualTransactionCount, writePatterns, classificationCounts, classificationSubtypes, unclassifiedWriteReviewBuckets, classificationPolicy, candidateRepeatThreshold, promotionCandidates, samples with code preview} (2004-2021); candidate lists promotionCandidates / nativeToolCandidates / hotfixCandidates / reconciliationCandidates / annotationInventoryCandidates (1698-1912) with evidenceStrength (weak/medium/strong by repeat count vs `config/dynamic-tool-promotion-rules.json` repeatThreshold:265-282,941-955) and registry match against `config/dynamic-tool-promotion-registry.json` (284-346); top-level evidenceStrength + humanReviewRequired.
- **send_code classification engine** (duplicated in summarize:396-686 and correlate:291-463): classes `routing_miss` / `tool_tuning_gap` / `capability_gap` / `policy_gap` / `accepted_escape_hatch` + subtypes + review buckets (`revit_db_mutation_review`, `local_export_adapter_review`, `read_helper_or_geometry_review`, `ambiguous_write_review`) via regex heuristics over code previews/write patterns.
- **Session correlation** `summaries\daily\YYYY-MM-DD.session-correlations.json` (+ evidence .md), schema `revagent.usage.sessionCorrelation.v1` (correlate-usage-sessions.ps1:837-866): per Codex session ±45-min window match against telemetry by machine+user (641-715), yielding userIntent/assistantOutcome snippets, codex tool usage, revAgent operationCount/toolUsage/projects, outcome {successCount, guardedCount, failedCount, partialCount, dynamicCodeCount}, workspaceMatch, friction + productSignals (missing_telemetry_correlation, guarded/failed/partial_workflow_friction, dynamic_code_usage; 719-766), with an explicit counting policy that daily summaries are the factual totals (856-861).
- **LLM review pack** `llm-review-packs\<range>\review-pack.json` + `review-pack-prompt.md`, schema `revagent.usage.llmReviewPack.v1`, `packKind=llm_input_not_final_report` (prepare-llm-review-pack.ps1:511-580): overview roll-up (dailySummaryCount, codexSessionContextCount, sessionCorrelationCount, correlationsWithRevAgentEvents, revAgentEventCount, productionOperationCount, generatedFileCount, reviewSignalCount, dailySendCodeCount + classification roll-ups, machineCount/machineUserCount/projectCount), dailyEvidence, sessionEvidence, reviewSignals, sourceFiles, plus embedded LLM instructions/interpretation rules.
- **Publish report** `summaries\publish-latest.json`, schema `revagent.usage.publish.v1` (publish-usage-summary.ps1:478-497).
- **Analyst layer**: Codex skill `revagent-usage-analyst` installed to admin's `%USERPROFILE%\.codex\skills` (addon.json:18-25; installer Resolve-DefaultCodexSkillsRoot:38-51) — Turkish-first management reporting workflow over the pack (SKILL.md:200-293).
- Tests: `tests/test-usage-intelligence.ps1` (1,424 lines) — end-to-end fixtures asserting every schema above; prime parity-verification asset for O11.

### 2.3 Retention
- Raw telemetry NDJSON (`reports\events\...` and local mirror): **no retention/pruning anywhere in the repo** — grows unbounded (grep of addons/ + installer/ shows retention only for logs).
- Machine updater logs: keep-last-2 per machine (RevAgent.Reporting.psm1:422-438,449). Usage-summary publish logs: keep-last-30 (publish-usage-summary.ps1:27,241-265). Summaries/correlations/packs/codex contexts: retained indefinitely. O11 decision: historical data is NOT migrated; NAS stays as read-only archive until retirement.

## 3) THE METRIC-PARITY LIST (flat; check each against the O7 event schema before cutover)
Legend — **SURVIVE**: product metric, must be derivable from O7 gateway events. **BRIDGE**: survives only if the bridge supplies it (session registration/document-context or forwarded add-in status). **REPLACE**: concept survives, source becomes gateway-native (not file-derived). **DIES**: NAS/workstation-era concept, intentionally retired.

Identity & session envelope (today: telemetry event envelope, telemetry.ts:1728-1752)
1. eventId (uuid) — SURVIVE (O7 event id).
2. eventType (runtime.session.start | mcp.tool | revit.command | production.context | live.activity) — SURVIVE (O7 event taxonomy must cover invocation + lifecycle + context).
3. timestampUtc + monotonic sequence — SURVIVE.
4. sessionId (runtime process uuid) — REPLACE → gateway session id (D1/O3).
5. machineName (COMPUTERNAME) — BRIDGE → device/bridge id from enrollment (5.4).
6. userName (Windows USERNAME) — REPLACE → OIDC identity (5.1.4 `actor`).
7. runtime.version + buildHash — BRIDGE → bridge/add-in version in session registration; feeds fleet-version view.
8. process {pid, nodeVersion, startedAtUtc} — DIES (workstation runtime detail); bridge may report its own build info.

Tool invocation metrics (today: mcp.tool / revit.command events, telemetry.ts:1771-1811,1856-1868)
9. toolName / commandName / logicalToolName / executionKind — SURVIVE (O7 `tool` + executor binding).
10. taskName, taskIdPresent, parentTaskName, parentTaskIdPresent (client-supplied task labels) — BRIDGE/CLIENT: today injected as tool args by the MCP client; in target = orchestration-plan/sub-task linkage owned by the Gateway loop. Must exist in O7 or plan-step ids replace it.
11. durationMs — SURVIVE (O7 tool-latency).
12. result.success / result.state — SURVIVE (O7 `outcome`).
13. result.guarded + guardSource (runtime|client) — SURVIVE (maps to D12 policy-class enforcement events; guardSource distinguishes engine vs client guard).
14. result.action, result.errorMessage (truncated), errorType, result.messageHash, responseKind, responseKeys — SURVIVE (structured error taxonomy per 5.2 failure semantics; messageHash/responseKeys optional).
15. params summary: sorted key list; per-key {hash,length,text≤limit}; array/element-id counts; safe scalar whitelist (telemetry.ts:344-422) — SURVIVE as O7 `params digest` (5.1.4 already specifies params digest; keep the bounded-text hashing pattern).
16. transactionMode, connection {targetPresent, hostPresent, port} — DIES (local TCP detail) except transactionMode which maps to batch/transaction-group semantics (5.2.4) — SURVIVE as batch metadata.
17. requestBytes / responseBytes (from add-in task board) — SURVIVE (payload-size telemetry; gateway measures its own hop, bridge reports add-in hop).

send_code (dynamic code) intelligence (today: mcp.tool params.code, telemetry.ts:325-342; summarize:2004-2021)
18. send_code count, rawCount (send_code_to_revit), safeCount (send_code_to_revit_safe) — SURVIVE.
19. code.hash (sha256/16), code.length, code.lineCount — SURVIVE (hash is the promotion-grouping key).
20. code.writePatterns (from `findWritePatterns`, shared with safe-guards), writePatternCount — SURVIVE.
21. code.hasManualTransaction — SURVIVE.
22. code.preview (≤4000 chars) + previewTruncated — SURVIVE (needed by classification + human triage; privacy-sensitive → O7 should store as bounded field or result_ref).
23. classificationCounts {routing_miss, tool_tuning_gap, capability_gap, policy_gap, accepted_escape_hatch} + subtypes + unclassifiedWriteReviewBuckets — SURVIVE as derived analytics (recompute from 18-22; port heuristics, don't re-invent).
24. promotion/native-tool/hotfix/reconciliation/annotation-inventory candidates + evidenceStrength + humanReviewRequired + candidateRepeatThreshold (config/dynamic-tool-promotion-rules.json, -registry.json) — SURVIVE as derived analytics job; registry files become Tool-Registry-adjacent config.

Production context (today: production.context event, telemetry.ts:1033-1184)
25. project.documentTitle, documentPath, projectId (hash of path|title) — BRIDGE (target arch line 99 already plans bridge-supplied "open document" context; must include title+path/ids for byProject parity).
26. project.isFamilyDocument / isReadOnly / isModifiable — BRIDGE (document state flags).
27. view.active/before/after {name…}, activeViewChanged — BRIDGE (active-view context; today scraped from tool responses).
28. location.levelId/levelName (+ regex inference from text:1013-1031), roomName/roomNumber, spaceName/spaceNumber — BRIDGE or gateway-side derivation from tool results.
29. elements.targetElementIds, selectionIds, selectionCount, categories, samples (bounded), samplesTruncated — SURVIVE (extractable gateway-side from tool params/results since all traffic transits the Gateway).
30. elements.disciplineHint (+ regex inference:710-737) — SURVIVE; becomes the D6 discipline-namespace tag — should be first-class in O7, not regex-inferred.
31. outputs {outputDir, filePrefix, files[]} → generatedFileCount — BRIDGE (files are workstation-local; bridge/tool result must report them).
32. search policy block: riskLevel, recommendedFirstScope, requiresUserControl, searchBudget, linkScope, planCandidateMode, allowExpensiveSearch, scannedElementCount, partial, scanStoppedReason, needsScope — SURVIVE (tool-result fields; feeds hotfix/partial-friction analytics; O7 must carry partial+stop-reason).

Live/fleet state (today: status.json + activity ndjson, telemetry.ts:1441-1470,1576-1587; dashboard server.mjs:253-307)
33. lastHeartbeatUtc → heartbeatAgeSeconds → connectionState online/stale/offline (60 s/300 s) — REPLACE → gateway bridge-connection state (D3 persistent WSS makes this authoritative, not file-mtime-based).
34. activeTask / activeTasks (live task with phase started/completed/guarded/failed) — SURVIVE via invocation lifecycle events (started + finished), which O7 must emit as separate events for a live board.
35. recentActivity ring buffer (50, cap 200) — REPLACE → query of recent O7 events.
36. revitStatus task board (add-in-side active/recent tasks, elapsedMs, requestBytes/responseBytes, port, error; capacity 100) — BRIDGE: only the add-in sees this; either bridge forwards add-in status or gateway derives equivalent from invocation lifecycle. Decide in O1.
37. writeHealth {inFlight, dropped, maxInFlight} (NAS write queue health) — DIES (artifact of file-share telemetry). Replacement concern = bridge event-buffer/backpressure health, worth a bridge heartbeat field.
38. Dashboard overview counters (machineCount, liveMachineCount, activeMachineCount, staleMachineCount, offlineMachineCount, currentVersionCount, failedMachineCount) — REPLACE → SQL over gateway sessions/devices tables.

Version / update / deploy (today: machines\<M>\latest.json et al., RevAgent.Reporting.psm1:354-377,440-513; update-from-nas.ps1:4517-4528)
39. installedVersion, previousVersion, targetVersion, channel, installedState, localInstall.version/componentCount/manifestPath — DIES in current form; concept survives as **bridge version vs gateway version manifest** (O9) → fleet "versionCurrent/outdated" view (5.10 requires it).
40. update status (completed/current/installed/reinstalled/repaired/success/updated/failed; server.mjs:181-190), operation, operationMethod, atUtc/reportedAtUtc/publishedAtUtc — DIES; replaced by bridge self-update status events (O9).
41. diagnostics.deferredForRevitClose, revitPayloadChanged, fastPackageOnlyUpdate, revitPayloadChangedComponents — DIES (NAS updater concepts); "update deferred because Revit is open" remains a REAL product state the bridge self-updater must report (O9 should keep an equivalent flag).
42. machineReport.logPath + per-machine remote logs (keep-2) — DIES; replaced by gateway-side structured logs.
43. stable channel version (channels\stable.json) — REPLACE → gateway version manifest / release registry.
44. versionFallback logic (choosing last successful op report; server.mjs:221-251) — DIES.

Daily aggregates (today: revagent.usage.summary.v1)
45. source.eventCount / eventFileCount / badEventLineCount / machineReportCount — REPLACE (ingest health becomes gateway metrics; badEventLineCount dies).
46. totals.byEventType / byMachine / byUser; sessionCount — SURVIVE (group-bys over O7).
47. toolUsage & commandUsage rows {count, successCount, guardedCount, failedCount, averageDurationMs, maxDurationMs} — SURVIVE (the core 5.10 "usage per tool + failure rates + latency distributions").
48. production.operationCount; byMachineUser / byProject / byDiscipline / byLevel / byCategory — SURVIVE (needs items 25-30 present).
49. friction samples guarded/failed/slow (top-N operation briefs with project/view/level/search) — SURVIVE (query over O7).
50. taskNameSamples, searchPolicySamples — SURVIVE (optional analytics).

Intent correlation (today: codex-sessions + sessionCorrelation.v1)
51. Codex bounded user intent (userRequests text), assistantOutcomes, threadTitle, threadId, toolCalls/toolUsage (client-side names), workspace paths/names, localImagePaths — **DIES as a collector**: the Gateway owns the loop (D9), so user prompt/assistant outcome/tool linkage become native gateway session data. Residual gap: third-party MCP clients on the north surface (O8, e.g. Claude Code) — the Gateway sees their MCP requests but not client-local titles/transcripts; accept the loss or capture what MCP metadata offers.
52. Correlation outcome counts (success/guarded/failed/partial/dynamicCodeCount per session), workspaceMatch, ±45-min windowing, productSignals (missing_telemetry_correlation, guarded/failed/partial_workflow_friction, dynamic_code_usage) — REPLACE: time-window matching becomes exact session-id joins; "missing_telemetry_correlation" dies (no more split pipelines); friction signals recompute trivially per session.
53. LLM review pack (overview + dailyEvidence + sessionEvidence + reviewSignals + sourceFiles + instructions) — SURVIVE as a derived export re-pointed at Postgres; analyst skill (SKILL.md) ports with path changes.

Not tracked today but required by 5.10 (net-new in O7, no parity source): token spend per tenant/model/tool; licensing/seat status; model/provider used per turn; cost attribution.

## 4) Data collectors read that the Gateway will NOT naturally see (bridge-supplied context or dropped)
1. **Revit document metadata** — documentTitle/documentPath, isReadOnly/isModifiable/isFamilyDocument, active view name/change, level/room/space (items 25-28): today scraped from tool responses inside the workstation runtime (extractProductionContext, telemetry.ts:1033-1184). Tool responses will transit the Gateway, so parity requires either (a) porting production-context extraction gateway-side, or (b) the bridge emitting a document-context event on open/switch. Target line 99 ("bridge-supplied document context: open document, active discipline hint") must be widened to cover title+path+view+level or `byProject/byLevel/byCategory` analytics break.
2. **C# add-in task board** (`revitStatus`: per-request elapsedMs/requestBytes/responseBytes/port/error, item 36) — only visible on the add-in↔runtime TCP hop; needs bridge forwarding (O1) or is superseded by gateway invocation lifecycle events.
3. **Local Codex desktop transcripts** (`%USERPROFILE%\.codex\sessions`, thread titles from session_index.jsonl, local image paths; item 51) — unreachable from the Gateway by design; the exporter dies. Intent capture moves to the gateway-owned chat session; for external MCP clients this evidence is dropped.
4. **Workstation-local generated files** (outputs.files/outputDir, image/export/report paths; item 31) — Gateway sees them only if tool results report them; keep as tool-result contract fields.
5. **Windows identity** (COMPUTERNAME/USERNAME) — replaced by device-token enrollment + OIDC; must be mapped in the bridge session registration (items 5-6).
6. **Local infra health** — NAS write queue health (writeHealth), updater diagnostics, scheduled-task registration states, cloudflared tunnel process health, per-machine update logs (items 37,39-42): all die with the NAS era; replaced by bridge heartbeat/self-update status + gateway ops monitoring.
7. **Local telemetry mirror** (`C:\ProgramData\DPE\revAgent\state\telemetry`) — dies; bridge-side offline event buffering (if desired) is a new O1/O7 decision, not a port.

## 5) Effort assessment — reuse dashboard server as Phase-1 admin UI over Postgres?
**Verdict: rewrite the server; optionally salvage the frontend and the /api/brief contract. Rewrite the usage-intelligence aggregations as SQL/gateway jobs; PORT the classification heuristics and pack format.**
- Of server.mjs's 1,142 lines, roughly 700 exist to reconcile three overlapping legacy feeds (updater reports vs live status vs add-in task board): NDJSON tailing (136-165), version-report fallback (181-251), state derivation from file ages (253-307), lifecycle collapse/nested grouping/status-vs-telemetry enrichment (425-719), live-status caching (15-16,88-120), plus revitTaskMerge.js (178 lines). With one canonical O7 event stream in Postgres, ALL of that becomes `SELECT ... ORDER BY ts DESC` — porting it would import complexity the new architecture exists to delete.
- No auth exists (§1.4); Phase-1 admin UI must sit behind gateway OIDC/RBAC (`admin` role, 5.10) — that wrapper is new code regardless.
- Reusable as-is: `public/` UI (~560 lines vanilla HTML/CSS/JS; machine cards + activity stream + filters map 1:1 to "live sessions and connected bridges" in 5.10) can point at a new gateway admin endpoint returning the same snapshot shape; `/api/brief` is a good LLM-consumable admin contract worth preserving; smoke-test fixtures re-target as parity tests.
- Usage intelligence: all PowerShell (11 scripts, ~6,900 lines) is unusable on the Ubuntu gateway host and is mostly file plumbing + group-bys → replaced by SQL over O7 tables + a scheduled gateway job. The genuinely valuable IP to port faithfully: send_code classification heuristics + review-bucket triage (summarize:396-686 — note it is duplicated verbatim in correlate:291-463; consolidate once), promotion-candidate rules driven by `config/dynamic-tool-promotion-rules.json` / `-registry.json`, evidence-strength policy, the llmReviewPack.v1 shape with its counting/interpretation rules, and the `revagent-usage-analyst` skill (path/source updates only). The Codex-transcript exporter and time-window correlator are NOT ported (superseded by native session linkage).
- O11 pre-cutover checklist artifact: the flat list in §3 (items 1-50 = must-map; 51-53 = replaced-by-design; §4 = bridge-context decisions to close in O1/O7).

Key file references: docs/TARGET_ARCHITECTURE.md (O11:234, 5.10:172-179); addons/dashboard/server/server.mjs; addons/dashboard/public/app.js; addons/dashboard/installer/*.ps1; addons/usage-intelligence/scripts/{summarize-usage-intelligence,correlate-usage-sessions,publish-usage-summary,prepare-llm-review-pack,export-codex-session-context,publish-codex-session-context,install-usage-summary-task,install-codex-session-export-task}.ps1; addons/usage-intelligence/skills/revagent-usage-analyst/SKILL.md; installer/runtime-mcp-server/src/utils/{telemetry.ts,telemetryWriters.ts,revitToolHelpers.ts,runtimeIdentity.ts}; installer/lib/RevAgent.Reporting.psm1; installer/nas/update-from-nas.ps1; config/dynamic-tool-promotion-{rules,registry}.json.