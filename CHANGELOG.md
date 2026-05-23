# Changelog

All notable Revit MCP workstation deployment changes are tracked here.

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
- Translated `AGENTS.md` to English and updated README, skill, installer, and
  deployment docs to match the current updater schedule and log-retention
  behavior.
- Added full-test hotfixes for routine office use: compact Revit task status
  output, safer `find_elements` plan-candidate defaults, trimmed plan candidate
  blocks in focus workflows, actual image dimensions in view exports, clearer
  Revit `isModifiable` probe wording, and parameter schema alias diagnostics.
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
