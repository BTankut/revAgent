# revAgent User-Facing Branding Plan

## Goal

Make the workstation product consistently appear as `revAgent` wherever an
operator, technician, or LLM host user sees the application.

This phase is intentionally limited to the front layer. Deep implementation
identifiers such as repository name, source folder names, package ids,
PowerShell module names, DLL names, environment variables, and legacy cleanup
markers remain unchanged until the later repository/runtime rename phase. The
workstation install root is part of Phase 1B and now migrates to the
`revAgent` product root.

## Phase 1 Scope

- Installer and updater UI text, console output, shortcut names, and operator
  instructions should say `revAgent`.
- Revit ribbon, status windows, settings windows, task dialogs, add-in display
  name, and operator-facing transaction/view names should say `revAgent`.
- Codex MCP registration should make `/mcp list` show `revAgent` names instead
  of `revit-mcp` names.
- User-pack `SKILL.md` and `AGENTS.md` should describe the product as
  `revAgent` while preserving exact tool names such as
  `get_revit_mcp_status`.
- README / installer docs should describe current user-visible names and mark
  old names as legacy removal aliases only.
- Tests should guard the user-facing layer against reintroducing `Revit MCP`
  wording.

## Phase 1 Non-Goals

- Do not rename the GitHub repository or local repository folder.
- Do not rename DLLs, namespaces, csproj files, npm package names, or bundled
  source tree folders.
- Do not rename PowerShell modules such as `RevitMcp.*`.
- Do not rename tool ids such as `get_revit_mcp_status`; these are API
  contracts and require a separate compatibility plan.
- Do not remove support for legacy Codex MCP entries; this phase should remove
  legacy entries during registration but remain tolerant of existing installs.

## Implementation Steps

1. Update user-pack instructions and developer-facing guidance where those
   instructions are installed into Codex.
2. Change Codex registration to remove legacy `revit-mcp` and
   `revit-api-docs` entries and register `revAgent` and `revAgent-api-docs`.
3. Update updater/installer visible text and add `revAgent Updater STABLE.cmd`
   while retaining old command files as compatibility launchers.
4. Update Revit UI strings and add-in display names to `revAgent`.
5. Rebuild bundled runtime and Revit payloads only where visible strings are
   compiled into shipped artifacts.
6. Extend smoke tests for `/mcp list` naming and front-layer branding.

## Phase 1B Root Migration

Goal: stop treating the old `RevitMCP` workstation root as the active product
layer. New installs and repairs should use `C:\ProgramData\DPE\revAgent`.
Existing `C:\ProgramData\DPE\RevitMCP` installs are legacy input only.

Implementation rules:

1. NAS GUI and non-GUI launchers default to `C:\ProgramData\DPE\revAgent`.
2. Updater helper files use `revAgent` names:
   `Run-revAgent-Update-Hidden.vbs`, `Update-revAgent-Now.cmd`, and
   `Show-revAgent-Version.cmd`.
3. Existing updater config under the legacy root may be read only to preserve
   `codexInstructionPolicy`, `machineRole`, trusted key paths, and other
   workstation policy. It must not force new runs back onto the legacy root.
4. Managed Codex skill installation uses `.codex\skills\revAgent` and
   `C:\ProgramData\DPE\revAgent\codex\skills\revAgent`. Legacy
   `revit-mcp` skill directories are cleanup targets except when
   `preserve-local` protects a developer workstation's local Codex
   instruction surface.
5. After the new root is installed and scheduled task registration succeeds,
   the installer removes the legacy `C:\ProgramData\DPE\RevitMCP` root when
   the current process is not executing from that root.
6. Legacy launchers remain as aliases only. They should invoke the new
   `revAgent` entrypoints and should not create old helper files.

Non-goals for this phase:

- Do not rename the GitHub repository or local repository folder.
- Do not rename DLLs, .NET namespaces, NuGet/SDK package names, or Revit bridge
  command-set identifiers.
- Do not rename tool ids such as `get_revit_mcp_status`; these are API
  contracts and require a separate compatibility plan.
- Do not remove support for legacy Codex MCP entries; registration continues to
  remove `revit-mcp` / `revit-api-docs` and add `revAgent` /
  `revAgent-api-docs`.

## Later Deep Rename Backlog

- Rename local and remote repository from `revit-mcp-skill` to a revAgent name.
- Rename package ids, npm package names, source folders, and .NET namespaces.
- Decide compatibility aliases for existing tool ids and MCP server names.
- Update NAS release root if the deployment share should also be renamed.
