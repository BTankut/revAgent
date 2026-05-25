# RevitMCPCommandSet Source

This folder contains the source for the shared Revit bridge command set used by
production dynamic execution, low-level context, UI state, selection, focus, and
view navigation workflows.

The original dynamic execution source was imported from the MIT-licensed
`mcp-servers-for-revit/mcp-servers-for-revit` command set and adapted for this
monorepo's Revit 2022-2025 source matrix. The view/navigation bridge commands
now live in this same project so Revit Settings shows one shared bridge command
set instead of separate core and view command sets. The deployed command surface
remains limited by `command.json` and the installer command registry. Source in
this folder is intentionally kept to that production surface only.

Removed legacy source categories:

- unregistered creation/editing commands such as point, line, surface, grid,
  level, room, tag, delete, operate, annotation, structure, and data extraction
- unregistered filtering and family-type commands
- model DTOs and utilities used only by those removed commands

The removed source was not reachable through the production registry. Keeping it
compiled made command assembly scanning noisier and kept old localized strings
in the source tree.

The project is safe to build from this repo. It does not copy files into the
user Revit add-in folder unless `RevitMcpDeployCommandSet=true` is passed
explicitly.

The current production binary payload under `installer/command-payload` and the
add-in payload under `installer/revit-plugin/revit_mcp_plugin/Commands` are
refreshed by `scripts/build-revit-plugin.ps1`.
