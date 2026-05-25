# Revit Plugin Source

This folder contains the Revit add-in source that used to live in the separate
`BTankut/revit-mcp-plugin` repository.

Product-facing UI and docs should use `revAgent`. The source folder,
assemblies, namespaces, manifests, and command-set names here intentionally keep
their `revit-mcp` / `RevitMCP*` implementation identities.

Production source projects:

- `revit-mcp-plugin/`: main Revit add-in host, socket service, command registry,
  and revAgent status window.
- `RevitMCPCommandSet/`: dynamic execution and read-only context commands used
  by `send_code_to_revit`, `get_current_view_elements`,
  `get_current_view_info`, and `get_selected_elements`. This project owns
  `transactionMode`, guarded manual-transaction behavior, and dynamic compile
  reference selection for snippets.
- `RevitMCPViewCommandSet/`: transactionless UI view commands exposed as
  `list_open_views`, `activate_view`, `close_view`, and element-focused view
  workflows.

The canonical production payload is still kept under:

```text
installer\revit-plugin\revit_mcp_plugin\RevitMCPPlugin.dll
```

The dynamic command payload is kept under:

```text
installer\command-payload
installer\revit-plugin\revit_mcp_plugin\Commands\RevitMCPCommandSet
```

The UI view command payload is kept under:

```text
installer\revit-plugin\revit_mcp_plugin\Commands\RevitMCPViewCommandSet
```

Do not edit those binaries by hand. Change the source here, then refresh the
host/view payload when needed:

```powershell
powershell -ExecutionPolicy Bypass -File ..\..\scripts\build-revit-plugin.ps1 -RevitVersion 2022
```

The script builds the main add-in host and the UI view command set. Validate the
dynamic command source separately when it changes:

```powershell
dotnet build .\RevitMCPCommandSet\RevitMCPCommandSet.csproj -c "Release R22" /p:RevitMcpDeployCommandSet=false
```

The stable dynamic command payload under `installer\command-payload` is not
refreshed by default. Replace it only as an explicit release task, and keep it
aligned with the installed Revit command payload copy when command-set behavior
changes.

Commit the source changes and the refreshed payload binaries in the same commit.

Historical branches in the old plugin repository are not part of the production
release flow. Work on `main` in the monorepo unless a temporary branch is
explicitly agreed first.
