# revAgent User-Facing Branding Plan

## Goal

Make the workstation product consistently appear as `revAgent` wherever an
operator, technician, or LLM host user sees the application.

This phase is intentionally limited to the front layer. Deep implementation
identifiers such as repository name, source folder names, package ids,
PowerShell module names, DLL names, install roots, environment variables, and
legacy cleanup markers remain unchanged until the later repository/runtime
rename phase.

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
- Do not rename `C:\ProgramData\DPE\RevitMCP`, DLLs, namespaces, csproj files,
  npm package names, or bundled source tree folders.
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

## Phase 2 Backlog

- Rename local and remote repository from `revit-mcp-skill` to a revAgent name.
- Decide final install root migration away from `C:\ProgramData\DPE\RevitMCP`.
- Rename package ids, npm package names, source folders, and .NET namespaces.
- Decide compatibility aliases for existing tool ids and MCP server names.
- Plan migration for existing Codex skill paths under `.codex\skills`.
- Update NAS release root if the deployment share should also be renamed.
