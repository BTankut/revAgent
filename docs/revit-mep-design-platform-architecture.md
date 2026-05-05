# Revit MCP MEP Design Platform Architecture

## Goal

Build a production-oriented Revit 2022 MEP automation platform where natural language requests become audited, typed, previewed, committed, and verified Revit changes.

The platform does not expose one public MCP tool per domain action. Public tools stay small; domain complexity lives in typed write-plan operations and engineering engines.

## End-to-End Flow

```text
Natural language request
  -> Revit context read
  -> Revit API docs validation
  -> engineering/domain analysis
  -> typed write-plan
  -> preview and risk report
  -> explicit user commit approval
  -> native Revit executor
  -> verify by model re-read
  -> audit/report
```

## Runtime MCP Layer

Existing public tools remain:

- `send_code_to_revit`
- `send_code_to_revit_safe`
- `get_revit_session_context`
- `get_active_view_context`
- `inspect_elements`
- `inspect_parameter_schema`

New platform tools:

- `analyze_mep_system`
- `prepare_write_plan`
- `preview_write_plan`
- `commit_write_plan`
- `verify_write_plan`
- `get_workflow_state`
- `clear_workflow_state`

Runtime implementation added under:

```text
kurulum/mcp-server/build/
  tools/
  write-plan/
  domains/
  office-standards/
```

## Write-Plan Protocol

Plans use schema version `1.0` and carry:

- `planId`
- `title`
- `discipline`
- `riskLevel`
- `source`
- `context`
- `steps`
- `verification`
- `audit`

Step identity uses:

- `stepId`
- optional `eId`
- `operation`
- `targets`
- `arguments`
- `preconditions`
- `riskLevel`

Modes:

- `validate`: schema/precondition validation only
- `preview`: read-only preview rows
- `commit`: native Revit transaction, explicit approval/token required
- `verify`: read model state back after commit/proposal

## Native Executor

Plugin implementation is in:

```text
C:\Users\BT\Projects\revit-mcp-plugin\SampleCommandSet\Commands\WritePlan\
```

Native command:

```text
execute_write_plan
```

Initial committed operations:

- `set_parameter`
- `clear_parameter`
- `copy_parameter_value`
- `change_type`
- `view_hide_elements`
- `view_unhide_elements`
- `view_apply_overrides`
- `place_family_instance`
- `move_elements`
- `create_duct_run`
- `resize_duct`
- `create_pipe_run`
- `resize_pipe`
- `create_schedule_or_update_schedule`
- `commit_reroute`

`validate`, `preview`, and `verify` do not open a transaction. `commit` opens one transaction and rolls back on the first operation error; when invoked from an already modifiable dynamic host context, it uses a rollback-capable `SubTransaction` to avoid nested transaction failures.

## Workflow Identity

Runtime state is JSON-backed and tracks:

- plan records
- preview/commit/verify lifecycle data
- mappings by `planId`
- audit entries

State file default:

```text
kurulum/mcp-server/build/write-plan/.workflow-state.json
```

The path can be overridden with:

```text
REVIT_MCP_WORKFLOW_STATE_FILE
```

## Engineering Engines

Initial domain foundations:

- HVAC airside read-only collector/connector/length summary
- Hydronic pipe read-only collector/length/system summary
- Domestic water foundation with missing-standard gating
- Sanitary/storm foundation with slope/vent issue scaffolds
- Fire/sprinkler read-only count plus explicit assumptions
- Clash coordination foundation with no auto-commit
- Equipment selection foundation with no silent replacement

Office standards live in:

```text
kurulum/mcp-server/build/office-standards/defaults.js
```

Missing standards return `requiresOfficeStandard`, `missingStandards`, assumptions, and `canCommit: false` for engineering design decisions.
The completeness gate intentionally blocks production-final output when velocity limits, fixture-unit standards, stack/vent node sets, simultaneous fire-cabinet count, or other discipline-critical assumptions are absent, even if a narrow calculation example can still run as a proposal.

Engineering calculation foundations:

- HVAC rectangular duct velocity, hydraulic diameter, Darcy-Weisbach friction loss, equal-friction size proposal, and proposal-only `resize_duct` write-plan step generation from live duct samples plus supplied design airflows.
- Hydronic circular pipe velocity, Darcy-Weisbach pressure loss, velocity/friction size proposal, and proposal-only `resize_pipe` write-plan step generation from live pipe samples plus supplied design flows.
- Weighted network shortest-path traversal, rooted tree branch flow aggregation, least-loss flow direction inference, HVAC fan pressure basis, hydronic pump head basis, hydronic pipe resistance calibration, hydronic terminal balancing loss, and single/multi-loop Hardy-Cross hydraulic balancing.
- Domestic water fixture-unit summation, fixture-unit demand interpolation, pipe pressure-loss basis, velocity/friction pipe sizing proposal, and recirculation continuity issue screening.
- Sanitary/storm gravity slope and reverse-slope validation, fixture-unit gravity pipe sizing proposal, rational-method storm runoff and pipe sizing proposal, branch-to-stack reachability, and vent continuity checks.
- Fire/sprinkler rectangular room spacing/coverage screening, fire cabinet hose-reach coverage screening, fire cabinet demand basis, fire pump flow/pressure basis, and critical-risk fire pipe resize proposal handoff with explicit fire-design assumptions.
- Clash AABB hard/clearance clash classification and multi-candidate orthogonal reroute solving with clearance validation.
- Fan/pump candidate screening from required flow and pressure/head plus equipment schedule/report update proposals without replacement.
- Optional domain placement requests for air terminals, dampers, valves, pumps, fire cabinets, or equipment are normalized into proposal-only `place_family_instance` write-plan steps with explicit family/type or symbol identity, insertion point, optional level, and connector/system-assignment preconditions.
- HVAC/hydronic fitting/accessory/equipment local-loss parameters can be extracted from live Revit samples for calibration/reporting. Numeric pressure-drop parameters are aggregated by system/category and can be carried into fan pressure or pump head basis as explicit local-loss contribution. Hydronic pipe resize proposals can also consume a complete critical-circuit local-loss pressure context, but final production sizing still requires office/manufacturer standards, confirmed design flows, and critical-path validation.
- Domestic water, sanitary/storm, and fire sizing requests can generate proposal-only `resize_pipe` write-plan steps when the caller supplies exact pipe identity plus demand basis and the required office sizing standards. These handoffs stay `canCommit: false`; fire proposals are critical-risk and still require fire-engineer review, while drainage proposals require slope/invert/vent/code review before any commit.
- Calculation outputs remain proposals with `canCommit: false`.

MEP graph foundation:

- HVAC and hydronic read-only analyses collect connector-owning elements as graph nodes.
- `Connector.AllRefs` is used to count unique element-to-element edges.
- Open connector samples are returned for issue/debug workflows.
- Optional `networkRootElementId` / `networkTerminalElementIds` inputs run targeted live BFS pathfinding over the Revit connector graph without mutating the model.
- Deterministic JS graph calculations cover weighted shortest-path traversal, rooted branch flow aggregation, least-loss flow direction inference, cycle warnings, and critical path/circuit selection.
- Hydronic balancing foundations calculate critical-circuit equalization loss for terminal branches and include single-loop plus sequential coupled-loop Hardy-Cross solvers; production calibration against real model resistance data remains future work.

Reporting foundation:

- `analyze_mep_system` returns deterministic issue-list and design-log rows plus CSV text previews.
- It also returns `officeStandardsCompleteness`, a top-level production-review gate that aggregates per-engine missing office standards into one sorted list and per-discipline status rows without mutating Revit.
- `officeStandardsCompleteness.officeStandardsInputTemplate` turns the missing-standard paths into a fillable `officeStandards` override skeleton for `analyze_mep_system`, so the next review can use the same exact keys instead of a prose-only handoff.
- `productionReadiness` combines office-standard completeness, proposal data-completeness, project-critical handoff completeness, and generated write-plan validation into a single blocker list for final-design review.
- `productionReadiness.nextRequiredInputs` points to the exact handoff type and source artefact needed next: office standards, project-critical data, or proposal-validation fixes. Project-critical handoff errors/blockers are now carried into the same `project_critical_data` next input even when proposal data rows are otherwise complete.
- `handoff_input_validator.js` gives those handoff artefacts a local production-review guard: placeholder office standards stay invalid, project-critical data can be shape-valid but production-incomplete, and sample-only live captures stay non-committable.
- `analyze_mep_system.handoffValidation` surfaces that same guard without adding another public MCP tool, keeping the runtime surface at the targeted 13 tools.
- `boqOnly` runs short live Revit BOQ collectors without connector graph traversal for count/length report population.
- `hydraulicResistanceOnly` runs short live hydronic pipe length/diameter sampling and returns resistance calibration rows.
- Hydronic analysis can turn pipe resistance samples plus model-read `Flow`, `hydronicDesignFlowsByElementId`, optional `hydronicDefaultDesignFlowLs`, office velocity/friction limits, and critical-circuit local-loss pressure context into `pipe_sizing` report rows and proposal-only `resize_pipe` steps. When `localLossFromNetworkPath` is enabled, the hydronic branch can perform the selected-path local-loss reads first, then run a separate read-only pipe resistance sample for proposal output.
- HVAC analysis can turn duct length/size samples plus model-read `Flow`, `hvacDesignFlowsByElementId`, optional `hvacDefaultDesignFlowM3h`, office equal-friction/velocity limits, and critical-path local-loss pressure context into `duct_sizing` report rows and proposal-only `resize_duct` steps.
- `domesticWaterPipeSizingRequests`, `sanitaryStormPipeSizingRequests`, and `firePipeSizingRequests` let domestic, sanitary, storm, and fire foundations produce proposal-only `resize_pipe` steps from supplied demand requests without mutating Revit.
- `localLossOnly` runs short live HVAC/hydronic fitting/accessory/equipment parameter extraction and returns local-loss report rows plus local-loss pressure summary rows. `localLossElementIds` can restrict extraction to a known critical path/circuit element set from a prior graph/pathfinding step.
- `analyze_mep_system` also returns a top-level `writePlanProposal` object that aggregates nested proposal-only domain `writePlanSteps` into a normalized plan for `prepare_write_plan` / `preview_write_plan` review. It remains a handoff object with `canCommit: false`; it is not commit approval.
- The aggregated `writePlanProposal` validates generated steps with supplied `officeStandards`, so parameter allowlist enforcement can block unsafe analysis-generated note/update steps before preview or commit.
- `export_boq_report` and `export_clash_report` write-plans are handled by a runtime report executor for approved CSV/JSON file export.
- Report export writes files only and returns `mutateModel: false`.
- `create_schedule_or_update_schedule` creates or updates native Revit schedules by category/name/id and can add requested fields by parameter name, `parameterId`, or `BuiltInParameter`.
- `commit_reroute` creates explicit duct/pipe reroute geometry from approved points and verifies created segment count plus total length. When `obstacleBoxes` are supplied, native verify checks created segment curves against clearance-expanded obstacle boxes. Source replacement/reconnect options can delete the source route, reconnect replacement segments/source neighbors, and verify external references. If `createRouteFittings`, `preferRouteFittings`, `requireRouteFittings`, or a positive `expectedRouteFittingCount` is supplied, native commit attempts `Document.Create.NewElbowFitting` between adjacent route segment connectors before falling back to direct `Connector.ConnectTo`; commit/verify count unique duct/pipe fitting owners and treat required fitting references as an explicit success gate.

## Safety Model

Risk levels:

- `low`: parameter text, reports, view overrides
- `medium`: type changes, resize, placement, movement
- `high`: routing and reroute proposals
- `critical`: delete, batch reroute, fire/sprinkler sizing commit, equipment replacement

Rules:

- Preview before commit.
- `commit_write_plan` rejects calls without `commitToken` or explicit approval.
- Parameter write operations are checked against `officeStandards.allowedParameterNames` and `exactSchemaMappings`; unlisted names warn by default and become validation errors when `enforceAllowedParameterNames: true`.
- Fire/sprinkler/hydraulic outputs remain proposal/assumption-driven unless standards are configured.
- Clash/reroute work cannot auto-commit.
- Raw `send_code_to_revit` remains an expert fallback, not the normal production write path.
