# Changelog

All notable Revit MCP workstation deployment changes are tracked here.

## Unreleased

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
