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

`validate`, `preview`, and `verify` do not open a transaction. `commit` opens one transaction and rolls back on the first operation error.

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

Engineering calculation foundations:

- HVAC rectangular duct velocity, hydraulic diameter, Darcy-Weisbach friction loss, and equal-friction size proposal.
- Hydronic circular pipe velocity, Darcy-Weisbach pressure loss, and velocity/friction size proposal.
- Weighted network shortest-path traversal, rooted tree branch flow aggregation, least-loss flow direction inference, HVAC fan pressure basis, hydronic pump head basis, hydronic terminal balancing loss, and single-loop Hardy-Cross hydraulic balancing.
- Domestic water fixture-unit summation and recirculation continuity issue screening.
- Sanitary/storm gravity slope and reverse-slope validation.
- Fire/sprinkler rectangular room spacing/coverage screening with explicit fire-design assumptions.
- Clash AABB hard/clearance clash classification and multi-candidate orthogonal reroute solving with clearance validation.
- Fan/pump candidate screening from required flow and pressure/head.
- Fitting/accessory/equipment local losses are explicitly excluded from these first-pass calculations.
- Calculation outputs remain proposals with `canCommit: false`.

MEP graph foundation:

- HVAC and hydronic read-only analyses collect connector-owning elements as graph nodes.
- `Connector.AllRefs` is used to count unique element-to-element edges.
- Open connector samples are returned for issue/debug workflows.
- Optional `networkRootElementId` / `networkTerminalElementIds` inputs run targeted live BFS pathfinding over the Revit connector graph without mutating the model.
- Deterministic JS graph calculations cover weighted shortest-path traversal, rooted branch flow aggregation, least-loss flow direction inference, cycle warnings, and critical path/circuit selection.
- Hydronic balancing foundations calculate critical-circuit equalization loss for terminal branches and include a single-loop Hardy-Cross solver; coupled multi-loop production solving remains future work.

Reporting foundation:

- `analyze_mep_system` returns deterministic issue-list and design-log rows plus CSV text previews.
- `boqOnly` runs short live Revit BOQ collectors without connector graph traversal for count/length report population.
- `export_boq_report` and `export_clash_report` write-plans are handled by a runtime report executor for approved CSV/JSON file export.
- Report export writes files only and returns `mutateModel: false`; model schedule creation remains a future native operation.

## Safety Model

Risk levels:

- `low`: parameter text, reports, view overrides
- `medium`: type changes, resize, placement, movement
- `high`: routing and reroute proposals
- `critical`: delete, batch reroute, fire/sprinkler sizing commit, equipment replacement

Rules:

- Preview before commit.
- `commit_write_plan` rejects calls without `commitToken` or explicit approval.
- Fire/sprinkler/hydraulic outputs remain proposal/assumption-driven unless standards are configured.
- Clash/reroute work cannot auto-commit.
- Raw `send_code_to_revit` remains an expert fallback, not the normal production write path.
