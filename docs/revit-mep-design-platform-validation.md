# Revit MCP MEP Design Platform Validation Notes

## Static Runtime Checks

Executed from:

```text
C:\Users\BT\Projects\revit-mcp-skill-review
```

Commands:

```powershell
Get-ChildItem -Recurse kurulum\mcp-server\build -Filter *.js | ForEach-Object { node --check $_.FullName }
node kurulum\mcp-server\build\tools\send_code_to_revit_safe.guard-test.js
node kurulum\mcp-server\build\write-plan\write-plan.test.js
```

Result:

- JavaScript syntax check passed.
- Safe execution guard tests passed.
- Write-plan schema/state/risk tests passed.

## Plugin Build Check

Executed from:

```text
C:\Users\BT\Projects\revit-mcp-plugin
```

Command:

```powershell
dotnet msbuild SampleCommandSet\SampleCommandSet.csproj /p:Configuration="Debug 2022" /p:Platform=x64 /m:1
```

Result:

- Build passed.
- Output DLL:
  `revit-mcp-plugin\bin\x64\Debug\commands\SampleCommandset\2022\SampleCommandSet.dll`
- Warnings are Revit 2024 API deprecation warnings from the package reference and existing project code.

## Live Revit Validation Plan

Read-only checks:

- `get_revit_session_context`
- `get_active_view_context`
- `inspect_parameter_schema`
- `analyze_mep_system`

Live read-only results captured on the active session:

- Revit version: `2022`
- Build: `22.0.2.392`
- Culture: `tr-TR`
- Active document: `11374_VENT_ATP_R22_L04-L06_BT`
- Active view type: `DrawingSheet`
- Sheet viewports read successfully.
- MEP counts read successfully, including `8840` ducts, `6666` air terminals, `86` pipes, and `41` sprinklers.
- Exact parameter schema preflight for duct `Comments` succeeded; `ALL_MODEL_INSTANCE_COMMENTS` is writable string instance data on sampled ducts.
- Local updated runtime `analyze_mep_system` connected to live Revit read-only and returned HVAC foundation data:
  - duct length: `7996.625024664137 m`
  - connector count: `41735`
  - open connector count: `708`
  - missing office standard blocker: `hvac.ductEqualFrictionTargetPaPerM`

Write checks:

- Run only in a disposable/test model.
- Start with one `set_parameter` plan.
- Required sequence:
  `prepare_write_plan` -> `preview_write_plan` -> explicit approval/token -> `commit_write_plan` -> `verify_write_plan`.

## Known Validation Limits

- The installed MCP tool session currently exposes the previous six-tool runtime surface. The updated local runtime lists all 13 tools and was used for the new tool tests.
- A safe native availability probe returned: `Native execute_write_plan command unavailable; returned MCP runtime fallback preview only.` The active Revit session must reload the rebuilt command set that contains `execute_write_plan` before native preview/commit can be live-tested.
- Production-model writes were intentionally not run. The active document is a workshared project model, not a confirmed disposable/test model.
