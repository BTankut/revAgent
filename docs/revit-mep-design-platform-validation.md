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
node kurulum\mcp-server\build\tools\tool-registration.test.js
node kurulum\mcp-server\build\write-plan\write-plan.test.js
node kurulum\mcp-server\build\domains\engineering-calculations.test.js
node kurulum\mcp-server\build\domains\domain-foundation-calculations.test.js
node kurulum\mcp-server\build\tools\handoff-templates.test.js
```

Result:

- JavaScript syntax check passed.
- Safe execution guard tests passed.
- Tool registration tests passed and assert the existing six tools plus all seven write-plan/platform tools are registered.
- Write-plan schema/state/risk tests passed.
  - runtime report export executor wrote an approved CSV test file with `mutateModel: false` and `writesFiles: true`
- Engineering calculation tests passed:
  - duct area, hydraulic diameter, velocity, and friction loss against hand-check values
  - equal-friction duct sizing proposal gate
  - HVAC duct resize proposal rows and validator-approved `resize_duct` write-plan step generation
  - HVAC duct resize proposal data-completeness summary and production-review blockers
  - pipe area, velocity, and friction loss against hand-check values
  - pipe resistance coefficient calibration from length/diameter/reference flow samples
  - hydronic pipe sizing proposal gate
  - hydronic pipe resize proposal rows and validator-approved `resize_pipe` write-plan step generation
  - hydronic pipe resize proposal data-completeness summary and production-review blockers
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
  - domestic water fixture-unit demand interpolation, pressure-loss basis, and velocity/friction pipe sizing proposal
  - sanitary/storm slope and reverse-slope checks
  - sanitary/storm fixture-unit gravity pipe sizing, rational-method storm runoff and pipe sizing, branch-to-stack reachability, and vent continuity checks
  - sprinkler coverage/spacing standard gating
  - fire cabinet coverage, fire cabinet demand basis, and fire pump flow/pressure basis
  - stricter office-standard completeness gates for HVAC velocity limits, hydronic velocity limits, domestic water method/fixture standard, sanitary stack/vent node sets, and simultaneous fire cabinet count
  - clash AABB hard/clearance classification
  - orthogonal clash reroute preview with added-length calculation
  - multi-candidate orthogonal reroute solver with clearance validation
  - fan and pump candidate screening
  - equipment schedule/report proposal rows and low-risk note update write-plan step
  - report issue-list/design-log rows and CSV text generation
  - pipe sizing proposal rows and CSV text generation
  - duct sizing proposal rows and CSV text generation
  - model-read flow fields on duct/pipe samples feeding proposal sizing without external design-flow maps
  - top-level `writePlanProposal` aggregation from domain proposal `writePlanSteps`, with validator coverage for `resize_duct` and `resize_pipe` steps
  - domain placement proposal handoff for air-terminal/damper/valve/equipment-style requests, producing validator-approved `place_family_instance` steps
  - HVAC duct sizing analyzer branch with fake-executor coverage for read-only duct sample collection and proposal-only `resize_duct` output
  - hydronic path-targeted local-loss branch with fake-executor coverage for pathfinding, ranking, selected-path extraction, pipe resistance read, and proposal-only `resize_pipe` output
- Handoff template tests passed:
  - office standards handoff paths match the runtime missing-standard keys
  - every missing standard has a fillable `officeStandards` placeholder and field hint
  - project critical data handoff arguments match `analyze_mep_system` inputs and keep null numeric placeholders outside the directly passable argument object

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
- Native schedule operation build check passed:
  `dotnet build SampleCommandSet\SampleCommandSet.csproj -c "Debug 2022" -p:Platform=x64 -p:OutputPath=C:\Users\BT\Projects\revit-mcp-plugin\bld\schedule-final-2\`
- The build passed with the same Revit 2024 deprecation warnings.
- The schedule direct-load test DLL was built with unique assembly names because Revit locks loaded .NET assemblies for the session.
- Native reroute operation build check passed:
  `dotnet build SampleCommandSet\SampleCommandSet.csproj -c "Debug 2022" -p:Platform=x64 -p:OutputPath=C:\Users\BT\Projects\revit-mcp-plugin\bld\reroute-final\`
- Native reroute clearance verifier build check passed:
  `dotnet build SampleCommandSet\SampleCommandSet.csproj -c "Debug 2022" -p:Platform=x64 -p:OutputPath=C:\Users\BT\Projects\revit-mcp-plugin\bld\reroute-clearance\`

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
- Domestic water runtime probe succeeded without model mutation:
  - `analyze_mep_system` with `discipline: domestic_water`, `includeRevitRead: false`, and supplied fixture-unit demand/velocity/friction standards returned `requiresOfficeStandard: false`.
  - Fixture-unit demand conversion and domestic pipe sizing examples both returned `success: true`.
  - The analysis remained proposal-only with `canCommit: false` and top-level `mutateModel: false`.
- Sanitary runtime probe succeeded without model mutation:
  - `analyze_mep_system` with `discipline: sanitary`, `includeRevitRead: false`, and supplied slope/sizing standards returned pipe sizing, storm runoff/pipe sizing, stack reachability, and vent continuity examples.
  - The analysis remains issue/proposal-only with `canCommit: false`.
- Fire runtime probe succeeded without model mutation:
  - `analyze_mep_system` with `discipline: fire`, `includeRevitRead: false`, and supplied sprinkler/cabinet/fire-pump standards returned sprinkler coverage, cabinet coverage, cabinet demand, and pump basis examples.
  - The analysis remains assumption-heavy and proposal-only with `canCommit: false`.
- Workflow eId hydration live preview succeeded:
  - A temporary workflow state file stored a plan targeting only `eId: duct-preview-001`.
  - Runtime mapping resolved that eId to duct `1749785` / UniqueId `7e61ea08-330a-47b5-8b95-36e4bdc5bdf9-001ab319`.
  - `preview_write_plan` returned one native fallback preview row with the resolved element id and `mutateModel: false`.
- Domain foundation runtime probe succeeded:
  - `analyze_mep_system` with `discipline: all` and `includeRevitRead: false` returned calculation examples for HVAC, hydronic, domestic water, sanitary/storm, fire/sprinkler, clash, and equipment.
  - Every domain foundation returned `canCommit: false`.
- Office standards completeness runtime probe succeeded:
  - `analyze_mep_system` with `discipline: all` and `includeRevitRead: false` returned `mutateModel: false`.
  - HVAC missing standards included `hvac.ductEqualFrictionTargetPaPerM`, all three configured duct velocity limit slots (`main`, `branch`, `terminal`).
  - Hydronic missing standards included `hydronic.pipeFrictionLimitPaPerM` plus `main` and `branch` pipe velocity limits.
  - Domestic water missing standards included sizing method, pressure-loss method, fixture-unit standard, demand curve, velocity limit, and friction limit.
  - Sanitary/storm missing standards included slope, sanitary sizing, rainfall/runoff, storm sizing, stack nodes, and vent nodes.
  - Fire missing standards included hydraulic standard, sprinkler spacing, cabinet flow/pressure/reach, and simultaneous cabinet count.
- Sizing proposal data-completeness runtime probe succeeded:
  - `analyze_mep_system` with `discipline: all`, `includeRevitRead: false`, and complete HVAC/hydronic office standards returned `mutateModel: false`.
  - HVAC example `ductResizeProposal.dataCompleteness` reported `sampleCount: 1`, `proposalRowCount: 1`, `writePlanStepCount: 1`, `skippedNoFlowCount: 0`, `skippedNoSizeCount: 0`, `localLossDatasetComplete: true`, `completeForProductionReview: true`, and no blockers.
  - Hydronic example `pipeResizeProposal.dataCompleteness` reported the same complete/no-blocker shape.
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
- Live hydronic resistance calibration probe succeeded:
  - Read-only collector returned `5` pipe length/diameter samples from the active test model.
  - First sample: element `513756`, system `Hydronic Supply`, length `4.795 m`, diameter `150 mm`.
  - Calibration produced `5` hydraulic resistance rows; first coefficient was `1.683 Pa/(L/s)^2` at `1 L/s`.
- Live local-loss extraction probe succeeded:
  - HVAC `localLossOnly` read `5` duct fitting samples, produced `15` local-loss parameter rows and `5` numeric pressure-drop values; first numeric row was element `392203`, `Pressure Drop = 0.903 Pa`.
  - Hydronic `localLossOnly` read `5` pipe fitting samples, produced `30` local-loss parameter rows, `5` numeric pressure-drop values, and `5` loss-coefficient values; first numeric row was element `513769`, `Pressure Drop = 193.936 Pa`.
  - Report builder now emits `local_loss` and `local_loss_pressure` rows and CSV text with `canCommit: false`.
- Live local-loss pressure-basis probe succeeded:
  - HVAC `localLossOnly` carried `0.903 Pa` extracted pressure drop into `liveLocalLossFanPressureBasis.output.localLossPressurePa`; required fan pressure basis became `256.194 Pa`.
  - Hydronic `localLossOnly` carried `8925.566 Pa` extracted pressure drop into `liveLocalLossPumpHeadBasis.output.localLossContributionKPa`; required pump head basis became `36.548 kPa`.
  - Synced runtime build probe with `3` samples also succeeded: HVAC `0.903 Pa`, hydronic `4.560 kPa` local-loss contribution.
- Live hydronic pipe resize proposal probe succeeded without model mutation:
  - Read-only collector returned pipe samples `513756`, `513770`, and `513840`; live count stayed `488` pipes.
  - With test design flows, office limits `1.5 m/s` and `200 Pa/m`, and a complete `4560 Pa` critical-circuit local-loss context, `buildHydronicPipeResizeProposal` returned `3` proposal rows and `3` proposal-only `resize_pipe` steps.
  - First row: element `513756`, system `Hydronic Supply`, length `4.795 m`, current diameter `150 mm`, selected diameter `80 mm`, selected velocity `0.995 m/s`, selected friction `131.567 Pa/m`, `canCommit: false`.
  - Report builder emitted `pipe_sizing` CSV rows; final read-only check returned `488` pipes and `744` ducts.
- Live critical-circuit hydronic resize micro-probe succeeded without model mutation:
  - Connector readback confirmed pipe `513756` references fitting `513769`; fitting `513769` references pipe `513756` and pipe `513637`.
  - Targeted read of path ids `[513756, 513769, 513637]` returned pipe sample `513756` and fitting `513769` `Pressure Drop = 193.936 Pa`; counts stayed `488` pipes and `744` ducts.
  - Feeding that targeted dataset into `summarizeLocalLossSamples` and `buildHydronicPipeResizeProposal` returned `localLossContext.complete: true`, `status: proposal_ready_for_review`, one proposal row, one proposal-only `resize_pipe` step `resize-pipe-513756`, and `canCommit: false`.
- Live critical-path HVAC duct resize micro-probe succeeded without model mutation:
  - Targeted read of path ids `[392199, 392203, 392200]` returned duct samples `392199` / `392200` and fitting `392203` `Pressure Drop = 0.903 Pa`; counts stayed `744` ducts and `488` pipes.
  - Feeding that targeted dataset into `summarizeLocalLossSamples` and `buildHvacDuctResizeProposal` returned `localLossContext.complete: true`, `status: proposal_ready_for_review`, `2` proposal rows, `2` proposal-only `resize_duct` steps, and `canCommit: false`.
  - First row: duct `392199`, system `Mechanical Supply Air 1`, current size `450 x 200 mm`, test design flow `900 m3/h`, selected size `200 x 300 mm`, selected velocity `4.167 m/s`, selected friction `0.958 Pa/m`.
- Live model-flow extraction probes succeeded without model mutation:
  - Duct `392199` and `392200` `Flow` parameters returned raw `3.5314666721488583` internal ft3/s and display `100.0 L/s`, confirming the collector conversion to `360 m3/h`.
  - HVAC `ductSizingOnly` with no supplied design-flow map read 5 duct samples from live model `Flow`, including duct `392168` display `350.0 L/s` / `1260 m3/h`, and produced 5 proposal-only `resize_duct` rows with `canCommit: false`.
  - Hydronic pipe flow scan found nonzero pipe `Flow` samples, including pipe `513840` display `30.6 L/s`.
  - Hydronic `hydraulicResistanceOnly` with no supplied design-flow map read 12 pipe samples, used model `Flow` where nonzero, and produced 10 proposal-only `resize_pipe` rows with `canCommit: false`; first generated row used pipe `513840`, `30.57 L/s`, current diameter `100 mm`, selected diameter `200 mm`.
  - Final session count remained `744` ducts and `488` pipes.
- Targeted local-loss element probe succeeded:
  - Direct live read of HVAC fitting `392203` confirmed category `Duct Fittings`, loss parameters `Loss Method Settings`, `Loss Method`, `Pressure Drop`, and numeric pressure-drop sum `0.903 Pa`.
  - Direct live read of hydronic fitting `513769` confirmed category `Pipe Fittings`, the same three loss-like parameters, and numeric pressure-drop sum `193.936 Pa`.
  - `localLossElementIds` code generation is covered by the domain foundation test so a pathfinding/critical-path element list can drive the same extraction instead of first-sample category collection.
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
- Equipment/domain placement proposal runtime probe succeeded:
  - `analyze_mep_system` with `discipline: equipment`, `includeRevitRead: false`, `defaultPlacementLevelId: 378117`, and two `placementRequests` produced `place_family_instance` proposal steps for `air_terminal` and `valve`.
  - Fresh stdio runtime handshake listed `13` tools; `writePlanProposal.validation.valid` was `true`.
  - The first generated step used `operation: place_family_instance`, `eId: supply-air-terminal-001`, family/type `Supply Diffuser / 600x600`, point `{ x: 1, y: 2, z: 3 }`, level `378117`, risk `medium`, and preview-before-commit preconditions.
  - Follow-up routing probe with `discipline: hvac` accepted only the `air_terminal` request, ignored the `valve` request with a discipline mismatch warning, and produced one `place_family_instance` step. The same request set under `discipline: equipment` accepted both requests and produced two placement steps plus the equipment schedule note proposal.
  - The result is proposal-only; connector/system assignment remains an explicit post-placement precondition and no Revit mutation was performed.
- Approved equipment schedule update live write test succeeded in the disposable model:
  - Target: Mechanical Equipment element `386031`, type `14 kW`, UniqueId `ac8b9fc6-24ff-4c3b-a4c6-035f009e396e-0005e3ef`.
  - Plan `equipment-schedule-update-1777960000000` set `Comments` to `Codex equipment schedule proposal test 2026-05-05T00:00:00Z`.
  - Native preview returned one row; commit succeeded through `execute_write_plan`; verify succeeded; final readback matched.
- Approved native schedule creation live write test succeeded in the disposable model:
  - Plan `schedule-population-1777960000000`.
  - Schedule name: `Codex MEP Equipment Schedule 2026-05-05`.
  - New schedule element id: `1020916`.
  - Category: Mechanical Equipment / `OST_MechanicalEquipment`.
  - Fields requested by parameter id: `Family and Type` (`-1002052`), `Mark` (`-1001203`), and `Level` (`-1002062`).
  - Native preview reported `scheduleAction: create`, `canCommit: true`, and did not mutate the model.
  - First direct commit attempt against an older test DLL failed before mutation because nested `Transaction` was not permitted in the dynamic host context.
  - Native executor was updated to use `SubTransaction` when `document.IsModifiable`; rebuilt with unique assembly name `SampleCommandSetScheduleOpTest2`.
  - Commit then succeeded and returned mapping `codex-mech-equipment-schedule-001 -> 1020916`, `created: true`, and `addedFields: 3`.
  - Native verify succeeded; final readback confirmed the schedule name and all three fields/headings.
- Approved native reroute geometry live write test succeeded in the disposable model:
  - Plan `reroute-commit-1777960000001`.
  - Source basis duct: `392168`, system type `800822`, duct type `142427`, level `378117`, size `300 x 300 mm`.
  - Native preview returned one `commit_reroute` row, `requestedSegmentCount: 3`, `canCommit: true`, and no model mutation.
  - Commit created three new duct segments:
    `1020923`, `1020925`, and `1020927`.
  - Native verify re-read the target elements and returned `success: true`.
  - Expected and actual segment counts both `3`.
  - Expected and actual total route length both `15.292563747898 ft`.
  - Final `inspect_elements` readback confirmed all three elements are `Autodesk.Revit.DB.Mechanical.Duct`, category `Ducts`, level `Level 1`, with `Width` and `Height` raw values `0.984251968503937` / display `300`.
  - This first reroute test checked geometry/count/length only; it did not include obstacle envelope clearance or source reconnection.
- Approved native reroute clearance verification live write test succeeded in the disposable model:
  - Plan `reroute-clearance-1777962600000`.
  - Native preview returned `requestedSegmentCount: 2`, `canCommit: true`, and included one `obstacleBoxes` clearance envelope.
  - Commit created duct segments `1020932` and `1020934`.
  - Native verify re-read both ducts, matched `2` actual segments to `2` expected segments, and matched expected/actual total route length `6.56167979002624 ft`.
  - Clearance verifier checked both created segment curves against the expanded obstacle box and returned `clearanceViolationCount: 0`; both `clearanceChecks` rows had `intersectsExpandedObstacle: false`.
  - Final `inspect_elements` readback confirmed both ducts are `Autodesk.Revit.DB.Mechanical.Duct`, category `Ducts`, level `Level 1`, with `Width` and `Height` raw values `0.984251968503937` / display `300`.
  - This verifies committed reroute geometry against supplied obstacle envelopes; it still does not delete/reconnect the original source route.

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
- Additional user-approved disposable live commit sanity test after the `writePlanProposal` aggregation change:
  - Preview/read-only check reported source duct `392168`, duct count `744`, and no mutation.
  - Direct Revit API symbols for `ElementTransformUtils.CopyElement`, `Document.Delete`, `Parameter.Set`, `Element.LookupParameter`, and `XYZ` were resolved against Revit 2022 docs before writing.
  - Commit copied source duct `392168` to disposable duct `1021032` and set `Comments` to `Codex disposable live commit 2026-05-05T00:00:00Z`.
  - `inspect_elements` verified the copied duct's `Comments` value and confirmed source duct `392168` still retained `Codex write-plan commit test 2026-05-05T00:00:00Z`.
  - Cleanup deleted `1021032`; final session counts returned to `744` ducts and `488` pipes.
- Additional native socket preview audit after the latest runtime sync:
  - A fresh stdio runtime handshake listed all `13` tools from `C:\Users\BT\Projects\revit-mcp-runtime\build\index.js`.
  - `preview_write_plan` was called through that runtime with `useNativeExecutor: true` for a preview-only `set_parameter` step on duct `392168`.
  - The result used the normal `execute_write_plan` socket path (`directAssemblyFallback: false`), returned one preview row, and reported `mutateModel: false`.
  - Re-reading duct `392168` after preview confirmed `Comments` remained `Codex write-plan commit test 2026-05-05T00:00:00Z`.
- Clean Revit restart/reload native registry audit succeeded:
  - Revit was closed and restarted on a temporary copy of the sample model:
    `C:\Users\BT\AppData\Local\Temp\revit-mcp-live-test\rme_advanced_sample_project_codex_restart_test.rvt`.
  - The `Add-Ins` tab was opened and `Revit MCP Switch` was clicked through UI Automation.
  - `get_revit_session_context` confirmed the new Revit 2022 process, document `rme_advanced_sample_project_codex_restart_test`, active view `WSHP 2-3 System View`, and live MEP counts including `728` ducts and `488` pipes.
  - A fresh stdio runtime handshake against `C:\Users\BT\Projects\revit-mcp-runtime\build\index.js` listed all `13` tools.
  - Plan `restart-native-preview-1777980684540` called `preview_write_plan` with `useNativeExecutor: true` for duct `392168`.
  - The preview returned `success: true`, `warnings: []`, one normal native preview row, `mutateModel: false`, and no direct-assembly fallback warning/marker.
  - Re-reading duct `392168` after preview confirmed `Comments` remained empty, proving the clean-restart preview did not mutate the model.
- Runtime parameter allowlist validator audit:
  - A fresh stdio runtime handshake against `C:\Users\BT\Projects\revit-mcp-runtime\build\index.js` listed all `13` tools and confirmed `prepare_write_plan` is registered.
  - A `set_parameter` plan targeting `Unapproved Parameter` with `officeStandards.allowedParameterNames: ["Comments"]` returned `success: true`, `validation.valid: true`, and a warning that the parameter is not in `allowedParameterNames` or `exactSchemaMappings`.
  - The same plan with `officeStandards.enforceAllowedParameterNames: true` returned `success: false`, `validation.valid: false`, and the same condition as a validation error.
  - A follow-up exact-schema mapping probe used `exactSchemaMappings.approvedCustomNote.parameterName = "Approved Custom Note"`: targeting `Approved Custom Note` returned no warning, while targeting the logical alias `approvedCustomNote` returned an allowlist warning. This keeps mapping aliases from bypassing the parameter-name gate.
  - A runtime analyzer probe with `discipline: equipment`, `includeRevitRead: false`, and `officeStandards.enforceAllowedParameterNames: true` while only allowing `Mark` returned `writePlanProposal.validation.valid: false`; the generated equipment `set_parameter` step targeting `Comments` was blocked by the same allowlist gate.
  - `get_revit_session_context` still confirmed the clean-restart model `rme_advanced_sample_project_codex_restart_test`, Revit `2022` build `22.0.2.392`, active view `WSHP 2-3 System View`, and live MEP counts including `728` ducts and `488` pipes.
- Domestic/sanitary/storm pipe sizing proposal handoff audit:
  - A fresh stdio runtime handshake listed all `13` tools.
  - `analyze_mep_system` with `includeRevitRead: false`, one `domesticWaterPipeSizingRequests` item, two `sanitaryStormPipeSizingRequests` items, and complete test office standards returned `success: true`, `mutateModel: false`, and `writePlanProposal.validation.valid: true`.
  - The top-level proposal included three proposal-only `resize_pipe` steps: domestic water pipe `601 -> 25 mm`, sanitary pipe `701 -> 75 mm`, and storm pipe `702 -> 100 mm`; the same rows appeared in `reporting.pipeSizingRows`.
- Fire pipe sizing proposal handoff audit:
  - A fresh stdio runtime handshake listed all `13` tools.
  - `analyze_mep_system` with `discipline: fire`, `includeRevitRead: false`, one `firePipeSizingRequests` item, and complete test fire standards returned `success: true`, `mutateModel: false`, `writePlanProposal.validation.valid: true`, and plan risk `critical`.
  - The top-level proposal included one critical proposal-only `resize_pipe` step for fire pipe `801 -> 80 mm`; `reporting.pipeSizingRows` included `fire_pipe_sizing_proposal`, `designFlowLpm: 500`, and `demandType: cabinet_plus_sprinkler`.
- Office standards completeness summary audit:
  - A fresh stdio runtime handshake listed all `13` tools.
  - `analyze_mep_system` with `discipline: all` and `includeRevitRead: false` returned `success: true`, `mutateModel: false`, and top-level `officeStandardsCompleteness`.
  - The summary returned `completeForProductionReview: false`, `requiresOfficeStandard: true`, `28` unique missing standards, `7` per-engine rows, and blocked rows for `hvac`, `hydronic`, `domestic_water`, `sanitary`, and `fire`.
  - Follow-up runtime probe confirmed `officeStandardsCompleteness.officeStandardsInputTemplate` returned `28` required paths, `mergeTarget: analyze_mep_system.officeStandards`, and fillable `hvac`, `domesticWater`, and `fire` placeholders without mutating Revit.
- Production readiness summary audit:
  - A fresh stdio runtime handshake listed all `13` tools.
  - `analyze_mep_system` with `discipline: all`, `includeRevitRead: false`, and enforced parameter allowlist allowing only `Mark` returned `success: true`, `mutateModel: false`, and top-level `productionReadiness`.
  - The summary returned `completeForProductionReview: false`, `officeStandardsComplete: false`, `proposalDataComplete: true`, `writePlanProposalValid: false`, and two blockers: missing office standards plus generated write-plan proposal invalid because the equipment note proposal targeted `Comments`.
  - Follow-up runtime probe confirmed `productionReadiness.nextRequiredInputs` returned `office_standards` and `write_plan_proposal_validation`, including `docs/revit-mep-office-standards-input-template.json` as the office standards handoff source artefact, without mutating Revit.
- Current clean-restart normal socket commit smoke:
  - A fresh stdio runtime handshake against `C:\Users\BT\Projects\revit-mcp-runtime\build\index.js` listed all `13` tools.
  - `inspect_parameter_schema` confirmed duct `392168` has writable instance `Comments` / `ALL_MODEL_INSTANCE_COMMENTS`.
  - Plan `codex-live-param-smoke-2026-05-05T12-33-54-621Z` ran `prepare_write_plan -> preview_write_plan -> commit_write_plan -> verify_write_plan` through the normal native socket path.
  - `commit_write_plan` without token/approval was rejected first; explicit user-approved commit then returned `success: true`, `mutateModel: true`, `directAssemblyFallback: false`, and verify returned `success: true`, `mutateModel: false`.
  - Final `inspect_elements` readback confirmed `Comments = Codex live write-plan smoke 2026-05-05T12-33-54-621Z` on duct `392168`.
- Live project-critical data sample:
  - `inspect_elements` re-read HVAC path elements `392199 -> 392203 -> 392200` and hydronic sample elements `513756 -> 513769 -> 513637` from the open test model.
  - The observed values were captured in `docs/revit-mep-project-critical-data-live-sample.json` as sample-only data with `requiresEngineerReview: true` and `canCommit: false`.

## Known Validation Limits

- The installed MCP tool session currently exposes the previous six-tool runtime surface. The updated local runtime lists all 13 tools and was used for the new tool tests.
- The registered Codex runtime path is `C:\Users\BT\Projects\revit-mcp-runtime\build\index.js`; its `build` folder was updated from this repo and a fresh handshake against that path listed all 13 tools. The already-running MCP process still needs restart/reconnect before this chat exposes the new tool namespace.
- The public Revit socket command registry can call `execute_write_plan` after clean Revit restart/reload through the installed compat command assembly path. The restart audit above proves the on-disk registry path loads without the temporary in-memory hot-register step.
- Runtime keeps a direct-assembly fallback for `validate`, `preview`, and `verify` so read-only/native validation can continue if a future session has an unavailable command registry. Direct fallback for `commit` is disabled unless `REVIT_MCP_ALLOW_DIRECT_EXECUTOR_COMMIT=true` is set; the native executor itself can now run inside an already modifiable dynamic host context by using `SubTransaction`.
- Production-model writes were intentionally not run; the live write acceptance test was limited to the user-approved disposable/test model.
