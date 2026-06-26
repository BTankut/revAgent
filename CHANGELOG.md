# Changelog

All notable revAgent workstation deployment changes are tracked here.

## Unreleased

- Added a rollout closure audit wrapper that persists a timestamped readiness
  snapshot and can fail handoff automation when machine or rollout actions
  remain open.
- Added current-stable live Revit smoke evidence to the rollout readiness audit:
  closure now reports a rollout-level action until a passing smoke record
  matches the active stable version or commit.
- Added config-driven rollout readiness scoping so the source-free closure
  audit can read a local/NAS machine list, record out-of-scope workstation
  reasons, and avoid embedding office-specific rollout state in Git.
- Added a read-only rollout readiness audit that summarizes NAS stable,
  machine install/update reports, source-free migration evidence, live
  heartbeat freshness, and per-machine next actions before final office
  rollout closure.
- Clarified developer workstation update behavior: machines with
  `codexInstructionPolicy=preserve-local` now keep local developer `AGENTS.md`
  and `SKILL.md` surfaces while still receiving signed package, runtime, Revit
  payload, reporting, and source-free cleanup updates.
- Clarified the GUI source-free migration path for older local updater
  toolchains: if migration is required but the installed local updater does not
  support `-SourceFreeMigration`, the GUI bootstraps the current updater tools
  with `-RunSourceFreeMigration` and runs the migration after the same operator
  confirmation.
- Updated the updater GUI package label so developer workstations explicitly
  show that local Codex instructions are preserved instead of only showing the
  generic workstation package text.
- Cleaned documentation ownership: retired audit/plan files stay under ignored
  `docs/_retired/`, and durable rollout decisions are carried by the active
  README, runbook, architecture, and rollout documents.
- Hardened signed source-free deployment after the PR #74-#97 audit: trusted
  release keys now make updater integrity enforcement the default, unsigned
  fallback is blocked after any signed release is accepted, stored signed
  release high-watermarks are never lowered by later runs, installed GUI updates
  use the local trusted updater instead of the NAS-side updater, and NAS stable
  publish now requires manual workflow dispatch plus publish-time release
  sequence checks, explicit rollback/legacy-bootstrap authorization, and
  rollback backups for channel metadata and replaced payload directories.
- Preserved pinned local updater config during fast source-free updates so
  `release-trusted-keys.json` is not deleted when the release ZIP only carries
  general config, and made the dashboard recover installed-version display from
  the latest successful install/repair report when a later failed update report
  has no version fields.
- Added signed source-free CD automation: a protected GitHub Actions workflow
  can build a signed source-free release root from `main`, preserve that exact
  release root in local runner staging, and publish it to NAS only when the
  operator manually dispatches the workflow with `publish_to_nas=true`. Signed
  release metadata now uses portable relative paths, public trusted release
  keys can be copied into `tools\config`, and readiness checks scan the release
  root and ZIP for source/developer/debug artifacts.
- Fixed remaining live-test friction: local `test-all` and standalone payload
  freshness now restore npm dependencies before TypeScript builds, empty
  sheet/schedule inventory scans no longer expose misleading legacy match
  fields, schedule reconciliation skips header-like body rows, and parameter
  clear attempts `Parameter.ClearValue` before reporting unsupported no-value
  restore. `Comments` / `ALL_MODEL_INSTANCE_COMMENTS` is a built-in,
  non-shared parameter, so true no-value restore is not supported by the Revit
  API. Expected product behavior: `operation="clear"` returns guarded and does
  not write an empty-string fallback; when visible cleanup is required,
  `operation="clearVisibleValue"` or an explicit empty-string set is used, and
  the result is reported as `visible_empty_has_value`.
- Fixed local gates and live-smoke coverage: installer smoke now checks the
  current double-encoded JSON parser path, MCP build freshness uses package-local
  `tsc`, and an optional junk-model smoke package covers safe-code guards,
  parameter visible-clear/restore where Revit permits it, schedule body write
  guards, focus/export/cleanup.
- Tightened discovery/reconciliation semantics: explicit `find_elements`
  categories no longer expand through inferred MEP categories, subtype queries
  such as pump/AHU/FCU keep residual text, empty sheet/schedule queries report
  inventory mode instead of evidence matches, and reconciliation column
  inference prefers Description/Açıklama headers for comparison text.
- Hid the `closed` field from `activate_view` runtime responses while keeping
  it on `close_view`, so navigation responses do not carry close-only state.
- Closed remaining compact audit leaks: native Revit `recentTasks` now carries
  wrapper/logical tool identity for dynamic wrapper calls such as
  `set_schedule_cells_by_text`, and navigation/view responses no longer expose
  delete-review cleanup-only fields.
- Backfilled documentation alignment for the completed usage-intelligence
  roadmap, including the plan completion record and operator-facing promotion
  guidance.
- Added runtime/live-feed guard history fields so MCP-side guarded operations
  surface `guardSource` and appear in `get_revit_mcp_status.runtimeActivity`
  without being misrepresented as Revit-side `mcp_status.recentTasks`, and
  preserved wrapper action plus parent task id/name across nested Revit
  sub-operations.
- Polished compact audit output: Revit status history now exposes wrapper tool
  names as `method`/`toolName` while keeping the bridge command as
  `commandName`, `runtimeActivity` defaults to a summary mode without
  started/completed duplication, compact `find_elements` element rows keep only
  plan candidate refs, and `delete_review_view` groups cleanup diagnostics
  under `cleanup`.
- Normalized dynamic-code JSON result handling so `parseJsonResult=true`
  parses JSON-looking nested `result` strings, including double-encoded result
  strings, while disabled or failed parsing preserves the raw text.
- Separated `inspect_sheet_text` inventory-only placed schedules from evidence
  matches, made sheet-scan stop diagnostics explicit, and extended
  `count_annotations` to include viewport text-note sources.
- Normalized Codex `service_tier` to the current CLI-supported `fast` value
  during install/update config hygiene so MCP registration does not fail on
  stale `priority` profiles.
- Aligned `delete_review_view` review-view recognition with
  `create_3d_view_for_elements` QA naming so explicit `revAgent_QA_*` review
  views can be dry-run and cleaned up without raw cleanup fallback.
- Trimmed compact runtime responses for `reconcile_schedule_excel` and
  `find_elements`: compact reconciliation now returns summary/review table
  evidence instead of raw review rows, and element discovery deduplicates plan
  candidates into a shared compact summary.

## 2026.06.07.318-4ca1c36e

- Published stable deploy at 2026-06-07T17:49:50.2070328Z from commit
  `4ca1c36e`.
- Released the completed Step 0 plus Workstreams 1-5 usage-intelligence
  roadmap, including native sheet/schedule hardening, annotation inventory,
  schedule-to-Excel reconciliation, and deterministic promotion tracking.
- Added a shared broad-scan result contract for `inspect_sheet_text` and
  `inspect_schedules`, including canonical stop reasons, `summary`,
  `evidenceRows`, `suggestedNextScopes`, and `lastRead*` continuation fields.
- Hardened broad-scan normalization against native result casing and failure
  paths so `Matches` evidence is preserved and failed schedule reads report
  `scanStoppedReason=read_failed`.
- Hardened `find_elements` verified plan visibility so broad verified requests
  require exact element ids or explicit expensive-search approval, with Revit
  bridge fallback to metadata ranking when direct calls bypass the runtime
  guard.
- Extended Revit-side elapsed-budget handling into plan visibility verification
  while keeping level filtering in the existing in-memory post-filter path for
  MEP correctness.
- Fixed the no-match `selectionHint` so zero-result searches no longer claim
  there is a top match.
- Rebuilt `inspect_sheet_text` as a native Revit commandset workflow for sheet
  text notes, placed schedule instances/cells, and viewport-linked text notes,
  with Revit-side elapsed budgets, scan caps, partial results, and response-size
  stops before socket timeout.
- Added bounded native viewport tag evidence for `inspect_sheet_text` when
  `includeViewportTags=true`, returning readable `IndependentTag.TagText` rows
  as `viewportTag` evidence while reporting tag API limitations through
  warnings or notices.
- Added native partial-result handling for `inspect_schedules`, with
  Revit-side `maxElapsedMs`, `maxCells`, and `maxResponseBytes` budgets plus
  `lastReadSection`/`lastReadRow`/`lastReadColumn` continuation state.
- Added `count_annotations` as the read-only native annotation inventory/count
  tool for DrawingSheet text notes, placed schedule cells, and viewport tags,
  with profile-based matching, bounded regex execution, grouping, and explicit
  `occurrence`, `uniqueText`, `uniqueTag`, and `uniqueTaggedElement` semantics.
- Added placed schedule-cell continuation and cap reporting to
  `count_annotations`, including canonical `max_rows`, `max_columns`, and
  `max_cells` partial stop reasons.
- Added `reconcile_schedule_excel` as a runtime-only, review-first,
  write-free schedule-to-Excel reconciliation tool that ingests explicit
  Excel/CSV/rows data plus normalized `inspect_schedules` evidence, then
  returns deterministic match buckets, `reviewRows`, and `reviewTable`.
- Added deterministic usage-intelligence promotion tracking for native-tool,
  hotfix, schedule-spreadsheet reconciliation, annotation inventory, and
  general manual-transaction/write-guard candidates, with evidence snippets,
  session/tool context, weak-evidence marking, and human-review-required
  output.
- Bumped the runtime tool surface version to
  `revit-mcp-runtime-tools.37` for verified plan visibility, native sheet
  annotation inspection, native schedule partial-result behavior, annotation
  counts, and schedule-to-Excel reconciliation.

## 2026.06.03.267-ee433485

- Published stable deploy at 2026-06-03T19:46:41.6417971Z from commit
  `ee43348`.
- Documentation-only deploy that reorganized `CHANGELOG.md` into stable deploy
  headings and backfilled NAS stable release entries through
  `2026.06.03.265-fef8b178`.

## 2026.06.03.265-fef8b178

- Published stable deploy at 2026-06-03T19:30:38.2110216Z from commit `fef8b17`.
- Documentation-only deploy that added large-model search release notes to the
  shipped package.
- Follow-up changelog structure fixes are tracked under `Unreleased` until the
  next deploy.

## 2026.06.03.263-ecab65ab

- Published stable deploy at 2026-06-03T19:16:26.6694716Z from commit `ecab65a`.
- Released large-model progressive search hardening for revAgent element,
  sheet, and schedule discovery.
- Added MEP-aware category inference, search budgets, `allowExpensiveSearch`,
  API-level filters, partial results, and guarded `needs_scope` fallbacks.
- Changed `get_revit_session_context` to default to lightweight minimal context
  and bumped the runtime tool surface to `revit-mcp-runtime-tools.33`.

## 2026.06.02.255-33c6ad2f

- Published stable deploy at 2026-06-02T20:23:44.1561052Z from commit `33c6ad2`.
- Published the Revit payload refresh tied to the manifest-based payload
  freshness flow.
- Kept the deploy package aligned with the committed Revit payload DLLs and
  `installer/revit-payload-manifest.json`.

## 2026.06.02.246-d8844884

- Published stable deploy at 2026-06-02T13:34:54.0828258Z from commit `d884488`.
- Align docs with tool-first runtime guidance.

## 2026.06.02.245-54284b98

- Published stable deploy at 2026-06-02T13:11:51.4499356Z from commit `54284b9`.
- Fix open plan compact result field handling.

## 2026.06.02.244-0fa24741

- Published stable deploy at 2026-06-02T12:58:00.0763516Z from commit `0fa2474`.
- Fix navigation wrapper normalized result handling.

## 2026.06.02.243-88624f63

- Published stable deploy at 2026-06-02T12:33:03.2294985Z from commit `88624f6`.
- Retire completed planning docs.

## 2026.06.02.238-40c7c2c3

- Published stable deploy at 2026-06-02T11:13:03.6985563Z from commit `40c7c2c`.
- Remove nocheck from telemetry.

## 2026.06.02.233-4bd17e48

- Published stable deploy at 2026-06-02T08:14:27.9414612Z from commit `4bd17e4`.
- Normalize bridge result contract.

## 2026.06.01.232-ef9f20ab

- Published stable deploy at 2026-06-01T20:21:04.5456507Z from commit `ef9f20a`.
- Strengthen Revit MCP tool selection rules.

## 2026.06.01.231-311268a8

- Published stable deploy at 2026-06-01T20:10:27.3917137Z from commit `311268a`.
- Add schedule text write workflow and usage summary fixes.

## 2026.06.01.230-d15bfc05

- Published stable deploy at 2026-06-01T18:24:36.3879686Z from commit `d15bfc0`.
- Align docs with runtime hardening plan.

## 2026.06.01.229-06069401

- Published stable deploy at 2026-06-01T18:12:11.1524274Z from commit `0606940`.
- Harden revAgent runtime architecture guardrails.

## 2026.06.01.228-52a0bf80

- Published stable deploy at 2026-06-01T13:25:41.1730974Z from commit `52a0bf8`.
- Add sheet text inspection hotfix.

## 2026.06.01.227-912914ec

- Published stable deploy at 2026-06-01T12:43:45.3082136Z from commit `912914e`.
- Stabilize dashboard live status metrics.

## 2026.06.01.226-cafa78b3

- Published stable deploy at 2026-06-01T12:22:18.7655954Z from commit `cafa78b`.
- Fix dashboard tool names for nested Revit commands.

## 2026.06.01.225-c03dce0a

- Published stable deploy at 2026-06-01T08:52:57.5427932Z from commit `c03dce0`.
- Add schedule inspection and cell write tools.

## 2026.05.31.223-f51a58f7

- Published stable deploy at 2026-05-31T20:11:59.6514319Z from commit `f51a58f`.
- Expire stale dashboard heartbeats offline.

## 2026.05.31.222-a2bf41c6

- Published stable deploy at 2026-05-31T19:18:45.8402033Z from commit `a2bf41c`.
- Split dashboard machine status badges.

## 2026.05.31.221-e5d06394

- Published stable deploy at 2026-05-31T18:22:00.9455312Z from commit `e5d0639`.
- Improve dashboard mobile layout.

## 2026.05.31.220-a09fa3fc

- Published stable deploy at 2026-05-31T18:07:09.9984225Z from commit `a09fa3f`.
- Keep dashboard activity scroll position.

## 2026.05.31.219-cda927c7

- Published stable deploy at 2026-05-31T17:47:29.1957709Z from commit `cda927c`.
- Remove dashboard machine task summary.

## 2026.05.31.218-748a9f7c

- Published stable deploy at 2026-05-31T17:42:34.4069517Z from commit `748a9f7`.
- Simplify dashboard machine cards.

## 2026.05.31.217-d19b4b37

- Published stable deploy at 2026-05-31T17:16:05.0434341Z from commit `d19b4b3`.
- Warn on empty string parameter dry runs.

## 2026.05.31.216-3b57bf6d

- Published stable deploy at 2026-05-31T17:02:37.8122003Z from commit `3b57bf6`.
- Fix parameter clear fallback message escaping.

## 2026.05.31.215-27c4a2fd

- Published stable deploy at 2026-05-31T16:39:09.0048780Z from commit `27c4a2f`.
- Add parameter clear mode and simplify live dashboard.

## 2026.05.31.214-da910a1b

- Published stable deploy at 2026-05-31T16:03:01.3334767Z from commit `da910a1`.
- Add safe element parameter write tool.

## 2026.05.31.213-dad396b2

- Published stable deploy at 2026-05-31T14:27:26.8598363Z from commit `dad396b`.
- Align dashboard with Revit status history.

## 2026.05.31.212-96b51f0c

- Published stable deploy at 2026-05-31T14:12:08.2676061Z from commit `96b51f0`.
- Support temporary schedule export cleanup.

## 2026.05.31.211-31b43244

- Published stable deploy at 2026-05-31T13:52:46.2943591Z from commit `31b4324`.
- Align dashboard activity with status window.

## 2026.05.31.210-185a1983

- Published stable deploy at 2026-05-31T13:40:42.8916717Z from commit `185a198`.
- Support sheet evidence exports.

## 2026.05.31.209-6b4e19f1

- Published stable deploy at 2026-05-31T13:26:30.2423093Z from commit `6b4e19f`.
- Use live activity for dashboard metrics.

## 2026.05.31.208-9107df2c

- Published stable deploy at 2026-05-31T13:14:09.6147941Z from commit `9107df2`.
- Compare dashboard machines to stable version.

## 2026.05.31.207-431a22c4

- Published stable deploy at 2026-05-31T13:07:02.4455684Z from commit `431a22c`.
- Harden live dashboard for production polling.

## 2026.05.31.205-243764d2

- Published stable deploy at 2026-05-31T12:52:12.2871257Z from commit `243764d`.
- Stack dashboard summary panels.

## 2026.05.31.204-3ac358c1

- Published stable deploy at 2026-05-31T12:48:04.0858985Z from commit `3ac358c`.
- Constrain dashboard activity stream.

## 2026.05.31.203-145253a4

- Published stable deploy at 2026-05-31T12:37:33.1478421Z from commit `145253a`.
- Adjust dashboard activity layout.

## 2026.05.31.202-846d760b

- Published stable deploy at 2026-05-31T12:26:33.9900089Z from commit `846d760`.
- Align dashboard with revAgent status window style.

## 2026.05.31.201-25147d0d

- Published stable deploy at 2026-05-31T12:14:47.8848451Z from commit `25147d0`.
- Improve live dashboard operations board.

## 2026.05.31.200-762b6483

- Published stable deploy at 2026-05-31T11:45:54.0281580Z from commit `762b648`.
- Fix dashboard recent activity fallback.

## 2026.05.31.199-628640b0

- Published stable deploy at 2026-05-31T11:26:20.4677992Z from commit `628640b`.
- Add read-only live dashboard.

## 2026.05.31.198-3c28b632

- Published stable deploy at 2026-05-31T10:56:51.9250603Z from commit `3c28b63`.
- Add live dashboard feed.

## 2026.05.27.197-d5b0f301

- Published stable deploy at 2026-05-27T13:53:21.2763984Z from commit `d5b0f30`.
- Fix usage summary friction samples.

## 2026.05.27.196-a9e94ac1

- Published stable deploy at 2026-05-27T11:41:18.6127966Z from commit `a9e94ac`.
- Fix usage summary latest selection.

## 2026.05.27.195-b9d10945

- Published stable deploy at 2026-05-27T11:38:52.1352056Z from commit `b9d1094`.
- Fix usage summary task run-now.

## 2026.05.27.194-0df56417

- Published stable deploy at 2026-05-27T11:36:58.1740034Z from commit `0df5641`.
- Schedule usage summary publishing.

## 2026.05.27.193-110d735c

- Published stable deploy at 2026-05-27T09:00:26.0224787Z from commit `110d735`.
- Publish usage summaries.

## 2026.05.27.192-4ddc4bc9

- Published stable deploy at 2026-05-27T08:21:05.6906462Z from commit `4ddc4bc`.
- Add usage intelligence summary.

## 2026.05.27.191-fa60b140

- Published stable deploy at 2026-05-27T08:11:00.8657514Z from commit `fa60b14`.
- Fix telemetry event ordering and install reports.

## 2026.05.27.190-1a217c1f

- Published stable deploy at 2026-05-27T07:49:54.4391026Z from commit `1a217c1`.
- Add production context telemetry.

## 2026.05.27.189-f7c6fd97

- Published stable deploy at 2026-05-26T23:04:07.9610526Z from commit `f7c6fd9`.
- Improve telemetry and debug reporting.

## 2026.05.27.188-91f7c563

- Published stable deploy at 2026-05-26T22:21:38.1319342Z from commit `91f7c56`.
- Add runtime usage telemetry foundation.

## 2026.05.27.187-e97896c4

- Published stable deploy at 2026-05-26T21:16:29.0010301Z from commit `e97896c`.
- Fix report machine folder names.

## 2026.05.26.186-fcc6621d

- Published stable deploy at 2026-05-25T21:33:08.8275674Z from commit `fcc6621`.
- Harden Revit view diagnostics.

## 2026.05.25.185-3c9b8459

- Published stable deploy at 2026-05-25T15:50:58.2223032Z from commit `3c9b845`.
- Fix activate view change flag.

## 2026.05.25.184-6712c4ae

- Published stable deploy at 2026-05-25T15:38:16.1793095Z from commit `6712c4a`.
- Complete machine report schema.

## 2026.05.25.183-092ff5fb

- Published stable deploy at 2026-05-25T15:33:12.0506769Z from commit `092ff5f`.
- Add NAS machine install reports.

## 2026.05.25.182-a6b68e52

- Published stable deploy at 2026-05-25T14:52:49.6742210Z from commit `a6b68e5`.
- Unify Revit bridge command set.

## 2026.05.25.180-bbc6b4bd

- Published stable deploy at 2026-05-25T13:38:25.6199677Z from commit `bbc6b4b`.
- Remove dead runtime tool wrappers.

## 2026.05.25.179-86988fb9

- Published stable deploy at 2026-05-25T10:12:21.2571300Z from commit `86988fb`.
- Clean localized Revit plugin source.

## 2026.05.25.178-a153f01f

- Published stable deploy at 2026-05-25T09:32:11.4985099Z from commit `a153f01`.
- Use warning symbol for guarded tasks.

## 2026.05.25.175-71319629

- Added command-payload `transactionMode` handling in the Revit C# execution
  bridge: `auto` uses a wrapper-managed transaction, while `none` runs without
  an outer transaction for read-only probes and explicitly controlled snippets.
- Guarded manual Revit `Transaction` snippets submitted under `auto` before
  execution, returning `guarded` instead of treating the expected safety block
  as a failed model operation in revAgent status.
- De-duplicated dynamic compile metadata references by assembly name, fixing
  intermittent duplicate-reference failures such as direct
  `Newtonsoft.Json.JsonConvert` use when Revit has multiple Newtonsoft versions
  loaded.
- Validated the hotfix with command-payload build checks, installer smoke tests,
  full repo tests, and live Revit 2022 probes for `auto`, `none`, guarded manual
  transactions, and Newtonsoft compilation.

## 2026-05-22 - main, next release candidate

- Rewrote `main` back to the deployed `75128349` baseline and reapplied only
  the Revit image export feature line, leaving the bundled runtime at 21 tools.
- Added `export_revit_view_image` for read-only active/requested view image
  export and `export_revit_coordination_image` for focused visual QA exports
  through a reusable review view.
- Tuned image export guidance for LLM review: full-plan exports should use
  6000-8000 px / 300 DPI, while technical text/detail review should use a
  zoomed `visible_region`.
- Updated `README.md`, `SKILL.md`, and `AGENTS.md` to describe the current
  reusable runtime surface only: live Revit execution, context/view/focus,
  parameter inspection, and image export.
- Restored the real `src/revit-plugin/RevitMCPCommandSet` source layout and
  removed the unused `SampleCommandSet` source tree to keep add-in source
  aligned with the installed command payload.
- Removed stale deployment-facing references from the experimental MEP
  engineering branch work so production docs describe the current reusable
  runtime surface only.
- Changed revAgent status metadata to a production version model: the visible
  status now shows installed `Version` with the git build in parentheses plus
  an `Up to date`/update state, while local install time is kept in support
  details only.
- Changed the default NAS release identifier from wall-clock minutes to a
  sortable CalVer + git build number + commit stamp format.
- Fixed the workstation updater installer initial check so `ConfigPath` is
  passed as a real named PowerShell parameter instead of a positional string,
  preventing first-install failures immediately after task registration.
- Tightened Revit plan/focus view selection so same-level callouts are not
  selected unless the target element is actually present in the view-specific
  collector; focus results now warn when Revit changes the active view after
  a UI focus operation.
- Added updater log retention so workstation install/update log folders are
  pruned automatically to the latest 10 `.log` files, including the current
  active log.
- Changed workstation automatic update checks to run once daily at 12:00 local
  time, and made the updater repair older logon/repeated scheduled-task
  triggers during the next update run.
- Changed workstation update reminder surfaces to use the `revAgent` product
  name by default and migrate/remove legacy `Revit MCP Auto Update` scheduled
  task and Startup fallback names during install/update repair.
- Translated `AGENTS.md` to English and updated README, skill, installer, and
  deployment docs to match the current updater schedule and log-retention
  behavior.
- Added full-test hotfixes for routine office use: compact Revit task status
  output, safer `find_elements` plan-candidate defaults, trimmed plan candidate
  blocks in focus workflows, actual image dimensions in view exports, clearer
  Revit `isModifiable` probe wording, and parameter schema alias diagnostics.
- Added runtime identity metadata to `get_revit_mcp_status` so agents can see
  the active runtime version, schema/tool surface version, process start time,
  build timestamp, and git build hash.
- Restored live installer terminal output in the GUI so install/update progress
  streams into the window again instead of being replaced by a generic running
  message.
- Added `planCandidateMode` (`none`/`metadata`/`verified`) so broad element
  searches stay fast while verified view visibility remains available for
  focused presentation workflows.
- Made successful plan/focus responses compact by default for
  `open_existing_plan_for_element_level` and `show_element_in_plan_and_3d`,
  moved read-only probe modifiable state under `apiProbeState`, and made
  parameter schema output prioritize user-facing built-in parameter labels over
  raw Revit enum aliases.
- Locked `export_revit_coordination_image` auto styling to report-friendly
  defaults: raw evidence stays raw, coordination overlays use outline-only
  styling, system focus and clash clearance use technical-report styling, and
  high-contrast QA styling is explicit-only.
- Added direct runtime smoke assertions for those auto-style mappings so the
  behavior is tested as executable runtime logic, not only as installer-side
  source text inspection.
- Added workstation updater npm dependency fingerprint checks and a managed
  local npm dependency cache so runtime/docs `npm install` is skipped when
  installed or cached `node_modules` already matches the current lockfile.
- Optimized `open_existing_plan_for_element_level` so direct calls return early
  when the active plan already matches the element level and requested plan
  name, avoiding the expensive verified plan-candidate scan.
- Removed `StartWhenAvailable` from the scheduled updater task and from task
  repair so GUI-triggered `RunNow` installs cannot race a missed daily task run.
- Added `metadataFirst` plan selection for `open_existing_plan_for_element_level`
  so first-time plan opens verify a bounded set of ranked metadata candidates
  before using the slower full verified fallback.
- Changed updater status reporting so Revit-close deferrals are displayed as
  pending updates rather than completed version transitions.
- Shortened normal GUI update checks: already-current updates now return before
  proxy, scheduled-task, Node/Codex, and npm checks, while the GUI update button
  runs the updater directly instead of reinstalling the updater wrapper.
- Made version-change updates less invasive when only updater/docs metadata
  changed: unchanged Revit add-in/command payloads are skipped even when Revit
  is closed, release manifests now include runtime directory fingerprints, and
  unchanged runtime payloads are left in place instead of being removed and
  recopied. The same incremental path now skips unchanged docs index refresh,
  unchanged Codex skill refresh, and redundant MCP registration.
- Added a guarded fallback for metadata-only fast updates: if the fast updater
  refresh step fails, the updater warns the user, records the fallback in the
  report, and continues through the full repair/install path instead of leaving
  the workstation half-updated.
- Documented and test-locked the update scope matrix so updater-only, runtime,
  Revit payload, Codex skill/AGENTS, and docs-server changes route through the
  intended install path.
- Added idempotent Codex memory configuration during install/update, removed
  normal `.codex` backup creation, cleaned legacy `.codex` backup artifacts,
  and capped managed package backups to the latest 3 replacement folders.
- Fixed fast/package-only updates so `revit-api-docs-mcp` gets its
  `node_modules` junction and dependency marker restored after the managed
  package folder is replaced, even when the docs payload and API index are
  unchanged.
- Tightened image export response contracts: `visible_region` and coordination
  exports now normalize PNG/JPEG/BMP/TIFF output to the requested fit-direction
  `pixelSize`, coordination exports include per-file `width`/`height`, and
  single-element coordination framing uses a tighter default margin, an
  explicit 3D camera orientation centered on the target section box, and a
  target-highlight post-crop when Revit still exports a wide 3D canvas.
- Tightened coordination-image framing again by adding `targetMinFillRatio`
  and reducing default highlight-crop padding, so a single highlighted target
  must occupy a meaningful share of the cropped image instead of remaining a
  tiny feature in a wide canvas.
- Added deterministic live-view-vs-export tool intent guidance: live
  show/open/zoom/select requests route to `create_3d_view_for_elements`,
  `show_element_in_plan_and_3d`, or focus tools, while PNG/JPEG/report
  evidence requests route to image export tools.
- Hardened coordination-image crop detection: target overrides now include
  green surface fill where Revit supports it, the pixel detector accepts
  anti-aliased green variants, and single-target exports fall back to a
  bounding-box-centered crop when no green target pixels are detected.
- Fixed coordination-image crop execution regressions found in live Revit:
  generated C# fallback variables no longer collide at compile time, and WPF
  image loading bypasses URI caching so the final resize uses the cropped
  image instead of re-reading the original wide export.
- Moved coordination-image crop authority from raster color detection to Revit
  model geometry: single-target exports now use model bbox/camera projection as
  the primary crop basis, raster highlight pixels are QA-only, and
  `estimatedTargetFillRatio` is reported separately from real
  `actualHighlightFillRatio` measurements.
- Split coordination-image source and final resolution: `pixelSize` is now the
  final downsampled artifact size, while automatic or explicit
  `preExportPixelSize` controls the high-resolution Revit source used before
  model-bbox crop, preventing tiny crops from being enlarged into pixelated
  review images.
- Tightened the Revit 3D view crop box from the projected target model bbox
  before raster export, so single-target coordination images render the target
  larger at source instead of depending on post-export magnification.
- Reduced coordination-image technical debt by making raster/highlight
  post-crop a fallback-only path. The default single-target path now frames in
  Revit view space first, then performs raster analysis only for QA metrics.
- Added `targetVisualStyle` for coordination exports so debug/LLM evidence can
  keep high-contrast highlighting while report-style output can use soft,
  outline-only, or raw native target appearance. Each export clears stale
  target-element overrides before applying the requested style.
- Made coordination export `auto` style report-friendly by default:
  `coordination_overlay` resolves to `outline_only`, `raw_evidence` resolves
  to `raw`, and strong `qa_high_contrast` highlighting now requires an
  explicit style request. Missing target highlight pixels in `raw` mode are
  returned as notices instead of trust-affecting warnings.
- Added `allowFinalUpscale=false` as the coordination-image default so the
  tool widens an under-resolved model crop and reports
  `target_fill_limited_by_source_resolution` instead of silently upscaling a
  tiny source crop.
- Normalized runtime response casing to canonical lowercase `success` without
  duplicate `Success` fields, and renamed probe-time modifiable-state fields so
  `apiProbeState.isModifiable` no longer looks like the idle UI editability
  state.
- Cleaned local and remote branch/worktree state so office development resumes
  from a single `main` history.

Status: prepared on `main`; the exact NAS package version is generated during
the separate managed release publish step after local release validation.

## 2026.05.13.1635-75128349

- Quoted the bundled Node.js MSI path in the updater's `msiexec` fallback so NAS deployment paths containing spaces, such as user/share folders, do not fail with MSI exit code 1639.
- Clarified `show-installed-version.ps1` output when the NAS channel has advanced after the last updater run, so stale "Already up to date" report messages are marked as previous-run context and the manual update path is shown as the next step.
- Applied the same modal-search guard to `open_existing_plan_for_element_level(planMode=activePlan)`, so cross-level active-plan focus returns `FocusBlocked` with a same-level plan suggestion instead of calling Revit `ShowElements`.
- Tightened `focus_elements` modal prevention for plan views by blocking `ShowElements` when the element level does not match the active/requested plan level, returning plan-level diagnostics and same-level plan suggestions instead.
- Changed `focus_elements` to preflight element visibility in the active/requested view before calling Revit `ShowElements`, preventing Revit's modal closed-view search dialog by default, and added `smart_focus_elements` as an explicit active-view-then-same-level-plan fallback workflow.
- Added large-project safety improvements for Revit view workflows: `find_elements` now reports match score/confidence/reasons and ambiguity hints, `open_existing_plan_for_element_level` has explicit `elementLevel` vs `activePlan` modes, `create_3d_view_for_elements` supports simple camera orientation/framing padding, and `show_element_in_plan_and_3d` composes safe search + existing-plan focus + optional 3D focus while rejecting ambiguous searches by default.
- Refined Revit view/focus tool outputs: plan opening now reports active-view change intent, 3D view creation reports section-box-off confirmation and view-name conflict resolution, and focus tools can optionally call Revit `UIView.ZoomToFit` through `fitToScreen`.
- Added length-prefixed Revit MCP socket framing with legacy JSON fallback, raising large request handling beyond the old single-read buffer failure mode while keeping a configurable 16 MB default request limit.
- Added Revit task transport metrics for request size, framing, receive, parse, execute, response size, and total duration; detailed metrics are logged while the Revit status window stays concise with state, task name, total duration, and request size.
- Added reusable Revit UI focus tools: `focus_elements` selects/zooms elements in the active or requested view, and `section_box_elements` applies a 3D section box around elements before optional select/zoom while making the section box boundary category visible in the target view when possible.
- Added transactionless UI view runtime tools: `list_open_views`, `activate_view`, and `close_view`, backed by a separate Revit view command set so `send_code_to_revit` remains unchanged.
- Added TypeScript-first canonical source trees, `tsconfig.json`, and build/smoke scripts for both bundled MCP servers while keeping `build/` as the installer/runtime contract.
- Split reusable installer/updater helper behavior into `installer/lib` modules for hidden launchers, scheduled task repair, permissions, package layout/extraction, Revit version metadata, update policy, proxy normalization, Codex config registration, and reporting.
- Added `config/revit-versions.json` as the central Revit version matrix. Revit 2022 remains the only bundled install payload; Revit 2023/2024/2025 are modeled but blocked from fake payload deployment until artifacts exist.
- Added local non-admin smoke tests for launcher exit-code propagation, WScript scheduled task actions, targeted permission repair, Revit-open update defer behavior, stable package path/layout resolution, public installer parameters, and helper modules.
- Added platform architecture documentation and an ADR deferring a .NET updater helper for now.

## 2026-05-11

- Kept the Revit MCP status window at the user's moved position for the current Revit session, with off-screen positions clamped back to the active work area.
- Changed scheduled background update checks to start through a hidden WScript launcher instead of launching PowerShell directly, removing the console flash and focus steal during automatic checks.
- Added managed install permission repair during elevated installs so per-user background checks can update the local package, runtime files, Revit MCP add-in payload, reports, cache files, and the hidden launcher.
- Narrowed permission repair to targeted managed folders and files so GUI installs do not appear stuck while scanning old package backups or `node_modules` trees.

## 2026-05-10

- Made `list_revit_instances` classify a target as reachable with lightweight `mcp_status` before attempting the heavier document-info probe, avoiding false empty discovery results when the first dynamic probe is slow.
- Optimized repeated update checks by skipping proxy setup commands when Windows, npm, and Git proxy settings already match the office proxy, with per-step proxy status logging.
- Changed scheduled auto update checks to run PowerShell hidden, added self-repair for older visible scheduled task actions, and refreshes the local updater tool copy during package install.
- Added a direct Codex `config.toml` MCP registration fallback when Codex Desktop is installed but its local command helper has not been created yet.

## 2026-05-09

- Added automatic DPE office proxy configuration during installer/updater runs so terminal tools, WinHTTP, npm, Git, and Codex child processes can reach the internet behind the office proxy, with the configured proxy shown in the version command.
- Changed Codex Desktop setup to a manual user step: the installer prepares proxy settings and `C:\Projects`, waits for the user to install/sign in to Codex Desktop, then registers MCP servers through Codex Desktop's own command.
- Removed managed Codex payload dependencies; updates now clean old `codex_app` and `codex_command_payload` folders from workstation installs.
- Fixed first-install Revit payload detection so new workstation installs no longer say Revit can stay open while add-in files are being written.
- Suppressed manual next-step instructions and npm audit/funding noise from NAS installer logs.
- Changed the GUI installer to request admin rights immediately, start from launchers without a persistent terminal window, and use a thinner progress bar.
- Suppressed duplicate user notifications during manual and GUI-started updates while keeping notifications enabled for background update checks.
- Added automatic workstation dependency preparation for Node.js/npm without installing a separate npm Codex package.
- Simplified NAS deployment to a single stable release channel and removed alternate-channel tooling.
- Added periodic workstation update checks every 30 minutes, with a startup-loop fallback when Scheduled Task registration is blocked.
- Added user notifications for pending Revit-close-required updates and successful background updates.

## 2026-05-08

- Changed the Revit MCP status window to show without stealing foreground focus from other applications.
- Updated the NAS updater to apply non-Revit payload updates while Revit is open, and to defer only when Revit add-in or command files changed.
- Made the updater compare the actual installed Revit add-in and command DLL hashes, so stale Revit payloads are repaired even when the package version already matches.
- Replaced updater ZIP extraction with a custom .NET ZipArchive extraction path to avoid intermittent PowerShell archive cleanup errors.
- Renamed the canonical install payload folder from `kurulum/` to `installer/`.
- Renamed deployment helpers to `installer/nas/`, runtime payload to `installer/runtime-mcp-server/`, and command payload to `installer/command-payload/`.
- Added release-package compatibility that still generates a legacy `kurulum/` alias for older workstation updaters.
- Updated GitHub repository description to describe MCP/skill-capable LLM hosts instead of Claude Code only.
- Consolidated the Revit add-in source into this repository under `src/revit-plugin`.
- Added `scripts/build-revit-plugin.ps1` to rebuild the add-in and refresh the installer payload.
- Added monorepo structure and migration documentation under `docs/`.
- Replaced public add-in vendor URLs in manifests with internal DPE metadata.
- Marked the skill and bundled local MCP packages as unlicensed/private for internal deployment.
- Added installer/update log files under `C:\ProgramData\DPE\RevitMCP\updater\logs`.
- Added a simple GUI installer/updater that shows live log output and opens the log folder.
- Updated install/update failure output to include the relevant log path.
- Added short workstation version visibility to the Revit MCP status window.
- Made the Revit MCP status window resizable, with the recent task history resizing with the window.
- Made recent task history text selectable for copy/paste.
- Increased visible task history retained by the status window.
- Added workstation version reporting files and a double-click version check command.
