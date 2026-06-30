# Revit Plugin Source

This folder contains the Revit add-in source that used to live in a separate
upstream repository before the revAgent monorepo migration.

Product-facing UI and docs should use `revAgent`. The installed package and
source projects use revAgent-named add-in and command DLL identities; remaining
legacy names in this area should be limited to external SDK/package identities
or explicit compatibility cleanup.

Production source projects:

- `revAgentPlugin/`: main Revit add-in host, socket service, command registry,
  and revAgent status window.
- `revAgentCommandSet/`: the shared Revit bridge command set used by
  `send_code_to_revit`, low-level context commands, UI state, selection, focus,
  and view navigation workflows. This project owns `transactionMode`, guarded
  manual-transaction behavior, dynamic compile reference selection, and the
  reusable native bridge commands that runtime MCP tools call. Keep this source
  limited to the registered production bridge commands; old unregistered
  create/edit/filter/data-extraction command code was intentionally removed.

The Settings window displays this C# command set as the installed shared
**bridge**. It is not the same thing as the 21 Codex-facing MCP tools.
Runtime MCP tools live in `installer/runtime-mcp-server`; some call a bridge
command directly, while others wrap dynamic C# execution, socket status, image
export, or multi-step workflows. Keep future discipline modules separated at
the MCP tool layer and reuse the shared Revit bridge for common execution,
context, selection, view, and navigation commands.

The canonical production host payload is kept under:

```text
installer\revit-plugin\revAgentPlugin\revAgentPlugin.dll
```

The shared bridge command payload is kept under:

```text
installer\command-payload
installer\revit-plugin\revAgentPlugin\Commands\revAgentCommandSet
```

Do not edit those binaries by hand. Change the source here, then refresh the
host/shared-bridge payload when needed:

```powershell
powershell -ExecutionPolicy Bypass -File ..\..\scripts\build-revit-plugin.ps1 -RevitVersion 2022
```

The script builds the main add-in host, the shared bridge command set, and the
matching install payload. Validate the command source separately when it
changes:

```powershell
dotnet build .\revAgentCommandSet\revAgentCommandSet.csproj -c "Release R22" /p:RevAgentDeployCommandSet=false
```

The shared bridge payload under `installer\command-payload` is refreshed by the
build script and must stay aligned with the installed Revit command payload copy
when command-set behavior changes.

For commandset behavior changes, run the optional live Revit gate after the
payload is installed into the active Revit session:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ..\..\scripts\test-commandset-live.ps1
```

Commit the source changes and the refreshed payload binaries in the same commit.

Historical branches in the old plugin repository are not part of the production
release flow. Work on `main` in the monorepo unless a temporary branch is
explicitly agreed first.
