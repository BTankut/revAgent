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
node kurulum\mcp-server\build\domains\engineering-calculations.test.js
node kurulum\mcp-server\build\domains\domain-foundation-calculations.test.js
```

Result:

- JavaScript syntax check passed.
- Safe execution guard tests passed.
- Write-plan schema/state/risk tests passed.
  - runtime report export executor wrote an approved CSV test file with `mutateModel: false` and `writesFiles: true`
- Engineering calculation tests passed:
  - duct area, hydraulic diameter, velocity, and friction loss against hand-check values
  - equal-friction duct sizing proposal gate
  - pipe area, velocity, and friction loss against hand-check values
  - hydronic pipe sizing proposal gate
  - missing office standard blockers for HVAC and hydronic sizing
  - rooted-tree branch flow aggregation for airside and hydronic sample networks
  - weighted shortest-path traversal for cyclic network foundations
  - least-loss flow direction inference for airside and hydronic sample networks
  - accumulated-loss critical path / critical circuit selection
  - HVAC fan pressure basis and hydronic pump head basis
  - hydronic critical-circuit balancing loss and pump-head adequacy
  - single-loop Hardy-Cross hydraulic balancing convergence and residual check
  - coupled two-loop Hardy-Cross hydraulic balancing convergence and residual check
  - cyclic network warning path for branch aggregation assumptions
- Domain foundation calculation tests passed:
  - domestic water fixture-unit summation and recirculation continuity
  - sanitary/storm slope and reverse-slope checks
  - sprinkler coverage/spacing standard gating
  - clash AABB hard/clearance classification
  - orthogonal clash reroute preview with added-length calculation
  - multi-candidate orthogonal reroute solver with clearance validation
  - fan and pump candidate screening
  - equipment schedule/report proposal rows and low-risk note update write-plan step
  - report issue-list/design-log rows and CSV text generation

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
- After the live direct-load test locked the normal build output DLL in Revit, the expanded verifier build was checked with an alternate output path:
  `dotnet msbuild SampleCommandSet\SampleCommandSet.csproj /p:Configuration="Debug 2022" /p:Platform=x64 /p:OutputPath=C:\Users\BT\Projects\revit-mcp-plugin\build-check\SampleCommandset\2022\ /m:1`
- Expanded native verifier coverage now includes real readback checks for:
  - `set_parameter`
  - `clear_parameter`
  - `change_type`
  - `resize_duct`
  - `resize_pipe`
  - `view_hide_elements`
  - `view_unhide_elements`
  - basic target existence for other starter operations
- A later compatibility build fixed the write-plan command interface to implement the active add-in's `RevitMCPSDK.API.Interfaces.IRevitCommand` rather than the older lowercase `revit_mcp_sdk` interface:
  `dotnet msbuild SampleCommandSet\SampleCommandSet.csproj /p:Configuration="Debug 2022" /p:Platform=x64 /p:OutputPath=C:\Users\BT\Projects\revit-mcp-plugin\bld\compat-verify\SampleCommandset\2022\ /m:1`
- The compatibility build passed with the same Revit 2024 deprecation warnings.

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
- Native plugin executor direct-load read-only probe succeeded against the open Revit session:
  - Loaded `SampleCommandSet.dll` from the plugin build output by reflection.
  - Called `WritePlanExecutor.Execute(document, "preview", plan, "")`.
  - Returned `success: true`, `mode: preview`, one `set_parameter` preview row for duct `1749785`, and `willMutateModel: false`.
  - Re-read duct `1749785` after preview; `Comments` remained empty, confirming preview did not mutate the model.
- Runtime native executor fallback test succeeded through the registered runtime path:
  - Updated `C:\Users\BT\Projects\revit-mcp-runtime\build` from this repo.
  - `preview_write_plan` attempted normal `execute_write_plan`, received `Method 'execute_write_plan' not found`, then invoked `WritePlanExecutor` by direct assembly fallback.
  - Returned `success: true`, `directAssemblyFallback: true`, one preview row for duct `1749785`, and `mutateModel: false`.
  - Re-read duct `1749785`; `Comments` remained empty.
- Runtime verify failure test succeeded read-only:
  - `verify_write_plan` used direct assembly fallback against the same uncommitted `set_parameter` plan.
  - Returned `success: false`, `mutateModel: false`, and error `parameter value does not match expected value`.
  - Verification row reported expected `preview-only`, actual empty string.
- The active Revit socket registry was inspected by reflection:
  - Loaded socket service: `%APPDATA%\Autodesk\Revit\Addins\2022\revit_mcp_plugin\RevitMCPPlugin.dll`.
  - In-memory registry originally exposed only `get_current_view_elements`, `get_current_view_info`, `get_selected_elements`, and `send_code_to_revit`.
  - A first hot-register attempt against the old `SampleCommandSet.dll` failed because the command implemented `revit_mcp_sdk.API.Interfaces.IRevitCommand`, not the active `RevitMCPSDK.API.Interfaces.IRevitCommand`.
  - The compat command assembly `SampleCommandSetCompat.dll` was then loaded and registered in memory; the registry reported `execute_write_plan` present.
- Normal socket native preview then succeeded without direct assembly fallback:
  - `preview_write_plan` called normal `execute_write_plan`.
  - Returned one preview row for duct `1749785`, `warnings: []`, no `audit.directAssemblyFallback`, and `mutateModel: false`.
  - Re-read duct `1749785`; `Comments` remained empty.
- Normal socket native verify also succeeded as a read-only failure case:
  - `verify_write_plan` called normal `execute_write_plan`.
  - Returned `success: false`, no fallback marker, and error `parameter value does not match expected value`.
  - Verification row reported expected `normal-socket-verify`, actual empty string, with `mutateModel: false`.
- The installed add-in registry was updated to point `execute_write_plan` to `SampleCommandsetCompat\2022\SampleCommandSetCompat.dll` so the corrected command can load on the next Revit restart/reload without relying on the temporary hot-register path.
- Engineering method live runtime probe succeeded without Revit mutation:
  - HVAC analysis reports connector/open connector summary, Darcy-Weisbach duct friction loss, and equal-friction rectangular duct sizing proposal methods.
  - Hydronic analysis reports pipe system summary, Darcy-Weisbach pipe pressure loss, and velocity/friction pipe sizing proposal methods.
  - Missing office standards correctly block sizing examples for HVAC and hydronic.
- Workflow eId hydration live preview succeeded:
  - A temporary workflow state file stored a plan targeting only `eId: duct-preview-001`.
  - Runtime mapping resolved that eId to duct `1749785` / UniqueId `7e61ea08-330a-47b5-8b95-36e4bdc5bdf9-001ab319`.
  - `preview_write_plan` returned one native fallback preview row with the resolved element id and `mutateModel: false`.
- Domain foundation runtime probe succeeded:
  - `analyze_mep_system` with `discipline: all` and `includeRevitRead: false` returned calculation examples for HVAC, hydronic, domestic water, sanitary/storm, fire/sprinkler, clash, and equipment.
  - Every domain foundation returned `canCommit: false`.
- HVAC/hydronic network foundation runtime probe succeeded:
  - HVAC methods include rooted tree branch airflow aggregation and critical path by accumulated edge loss.
  - HVAC example returned total demand `400`, critical path `fan -> main -> branch-b -> term-b`, and total loss `112 Pa`.
  - Hydronic methods include rooted tree branch flow aggregation and critical circuit by accumulated edge loss.
  - Hydronic example returned total demand `0.77`, critical path `pump -> riser -> coil-b`, and total loss `4300 Pa`.
  - Both examples explicitly state the tree assumption and keep `canCommit: false`.
- Weighted path/hydraulic/report foundation runtime probe succeeded:
  - HVAC weighted graph example selected `fan -> main -> branch-b -> term-b` with `112 Pa`.
  - HVAC flow direction inference returned `400` total demand and `400` flow through `fan -> main`.
  - HVAC fan basis example returned `400 m3/h` and `255.2 Pa` required pressure after allowances/safety factor.
  - Hydronic weighted graph example selected `pump -> riser -> coil-b` with `4300 Pa`.
  - Hydronic flow direction inference returned `0.77 L/s` total flow and `0.42 L/s` through `riser -> coil-b`.
  - Hydronic pump basis example returned `0.77 L/s` and `26.73 kPa` required head after allowances/safety factor.
  - Hydronic balancing example returned `12.3 kPa` required pump head, adequate `30 kPa` available head, and `0.7 kPa` balancing loss for `coil-a`.
  - Hardy-Cross loop example converged in `3` iterations with final residual `0.000004 Pa`.
  - Coupled Hardy-Cross network example converged in `5` iterations across `2` loops / `5` edges with max residual `0.000465 Pa`.
  - Reporting foundation returned issue-list/design-log rows and CSV text previews without file writes.
  - Runtime write-plan report executor supports approved CSV/JSON export for `export_boq_report` and `export_clash_report` without Revit model mutation.
- Live BOQ-only report population probe succeeded:
  - Hydronic read-only BOQ collector returned `488` pipes, `489` pipe fittings, `47` mechanical equipment, and `930.684 m` pipe length from the active test model.
  - `buildAnalysisReport` converted the live read into `12` BOQ rows with `canCommit: false`.
- Connector graph live probe succeeded:
  - Revit 2022 API docs resolved `Connector.AllRefs`, `Connector.Owner`, `Connector.IsConnected`, `MEPCurve.ConnectorManager`, and `FamilyInstance.MEPModel`.
  - HVAC graph summary: `27237` connector-owning element nodes, `41735` connectors, `708` open connectors, `20341` unique element edges, `25` open connector samples, `0` AllRefs errors.
  - Hydronic graph summary: `1373` connector-owning element nodes, `1598` connectors, `24` open connectors, `216` unique element edges, `24` open connector samples, `0` AllRefs errors.
- Targeted live connector pathfinding probe succeeded in the user-approved test model:
  - Document: `rme_advanced_sample_project - Kopya`.
  - Root/terminal duct: `392168`.
  - Mode: read-only HVAC `networkPathfindingOnly` with full connector summary disabled.
  - Result: `reachableTerminalCount: 1`, `hopCount: 0`, path `[392168]`, `canCommit: false`.
- Clash reroute foundation runtime probe succeeded:
  - `analyze_mep_system` with `discipline: clash` returned an orthogonal reroute preview around a rectangular obstacle envelope.
  - Example original length: `5 m`; reroute length: `6 m`; added length: `1 m`.
  - Multi-candidate solver returned `4` candidates, selected a valid clearance route with `0` violations and `1.025 m` added length.
  - The result is explicitly preview/foundation only with `riskLevel: high` and `canCommit: false`.
- Equipment schedule proposal runtime probe succeeded:
  - Fan selection chose `fan-b`.
  - Schedule proposal produced one report row and one low-risk `set_parameter` write-plan step targeting `eId: supply-fan-001`.
  - The result is proposal-only with `canCommit: false` and performs no equipment replacement.

Write checks:

- Production-model writes were not run.
- Disposable/test model opened by the user:
  - Document: `rme_advanced_sample_project - Kopya`
  - Workshared: `false`
  - Active view: `Level 1 HVAC Plan`
- Target parameter preflight:
  - Element `392168`
  - Category `Ducts`
  - Class `Autodesk.Revit.DB.Mechanical.Duct`
  - Parameter `Comments`
  - Built-in parameter `ALL_MODEL_INSTANCE_COMMENTS`
  - Storage type `String`
  - Read-only: `false`
- Required sequence passed:
  `prepare_write_plan` -> `preview_write_plan` -> explicit approval -> `commit_write_plan` -> `verify_write_plan`.
- Plan id: `test-model-commit-1777956608565`.
- Preview result:
  - `success: true`
  - `mutateModel: false`
  - old `Comments`: empty
  - new preview value: `Codex write-plan commit test 2026-05-05T00:00:00Z`
  - readback after preview still empty, proving preview did not mutate the model.
- Commit result:
  - `success: true`
  - `mutateModel: true`
  - mapping returned for `eId: test-duct-comments-001` to element `392168`
  - no direct assembly fallback marker; normal socket executor path was used.
- Verify result:
  - `success: true`
  - expected and actual `Comments` both matched `Codex write-plan commit test 2026-05-05T00:00:00Z`
  - `mutateModel: false`
- Final readback matched the committed value.

## Known Validation Limits

- The installed MCP tool session currently exposes the previous six-tool runtime surface. The updated local runtime lists all 13 tools and was used for the new tool tests.
- The registered Codex runtime path is `C:\Users\BT\Projects\revit-mcp-runtime\build\index.js`; its `build` folder was updated from this repo and a fresh handshake against that path listed all 13 tools. The already-running MCP process still needs restart/reconnect before this chat exposes the new tool namespace.
- The public Revit socket command registry can now call `execute_write_plan` in the current session after in-memory hot registration of the compat assembly. A normal Revit restart/reload is still recommended for operational confidence that the on-disk `commandRegistry.json` path loads the compat assembly from a clean AppDomain.
- Runtime keeps a direct-assembly fallback for `validate`, `preview`, and `verify` so read-only/native validation can continue if a future session has an unavailable command registry. Direct fallback for `commit` is disabled unless `REVIT_MCP_ALLOW_DIRECT_EXECUTOR_COMMIT=true` is set.
- Production-model writes were intentionally not run; the live write acceptance test was limited to the user-approved disposable/test model.
