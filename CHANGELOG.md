# Changelog

All notable Revit MCP workstation deployment changes are tracked here.

## 2026.05.22.1038-1b2d44f - main, next stable candidate

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
- Removed deployment-facing references to the experimental MEP engineering
  packages. This release candidate does not include bundled duct/pipe sizing,
  auto-routing, hydronic, sanitary/rainwater, or fire-piping production tools.
- Cleaned local and remote branch/worktree state so office development resumes
  from a single `main` history.

Status: prepared on `main`; publish to NAS `stable` separately after local
release validation.

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
