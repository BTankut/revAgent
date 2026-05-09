# Changelog

All notable Revit MCP workstation deployment changes are tracked here.

## 2026-05-09

- Added automatic DPE office proxy configuration during installer/updater runs so terminal tools, WinHTTP, npm, Git, and Codex child processes can reach the internet behind the office proxy, with the configured proxy shown in the version command.
- Fixed first-install Revit payload detection so new workstation installs no longer say Revit can stay open while add-in files are being written.
- Suppressed manual next-step instructions and npm audit/funding noise from NAS installer logs.
- Changed the GUI installer to request admin rights immediately, start from launchers without a persistent terminal window, and use a thinner progress bar.
- Suppressed duplicate user notifications during manual and GUI-started updates while keeping notifications enabled for background update checks.
- Added automatic workstation dependency preparation: Node.js/npm is installed automatically, and Codex Desktop is prepared from the bundled NAS Desktop app without installing a separate npm Codex package.
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
