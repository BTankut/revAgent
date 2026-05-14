# Revit Plugin Source

This folder contains the Revit add-in source that used to live in the separate
`BTankut/revit-mcp-plugin` repository.

Production source projects:

- `revit-mcp-plugin/`: main Revit add-in host, socket service, command registry,
  and status window.
- `RevitMCPCommandSet/`: dynamic execution and read-only context commands used
  by `send_code_to_revit`, `get_current_view_elements`,
  `get_current_view_info`, and `get_selected_elements`.
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
payload:

```powershell
powershell -ExecutionPolicy Bypass -File ..\..\scripts\build-revit-plugin.ps1 -RevitVersion 2022
```

By default, the script builds `RevitMCPCommandSet` for validation but leaves the
stable dynamic command payload unchanged. Pass `-RefreshCommandSetPayload` only
when intentionally replacing `installer\command-payload\RevitMCPCommandSet.dll`.

Commit the source changes and the refreshed payload binaries in the same commit.

Historical branches in the old plugin repository are not part of the production
release flow. Work on `main` in the monorepo unless a temporary branch is
explicitly agreed first.
