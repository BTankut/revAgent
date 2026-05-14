# Ducting Production Plan

Branch: `feature/mep-ducting-production`

## Mission

Promote the current diffuser/duct prototypes into production-grade duct engineering modules. The goal is not just to draw ducts; the branch must support air balance data, room airflow, diffuser selection/count, placement validation, connected duct network creation and Revit native sizing validation.

## Current Context

The spatial/plenum foundation is valid. Existing diffuser/duct commands are proof-of-flow prototypes and must be clearly treated as prototype inputs until rebuilt with production engineering rules.

## Reference Sources

- `AdnRme`: space airflow to air terminal flow and diffuser type sizing.
- `RevitAirflowDesigner`: corridor graph, route options, route scoring and duct/fitting creation.
- `OpenMEP`: duct, connector, fitting and placeholder API patterns.
- `BuildingGraph-Client-Revit`: topology validation after commit.
- `RevitExtensions`: duct placeholder elbow/tee/cross/convert API behavior.

## Required Capabilities

- Import or read air balance schedule data and map it to rooms/spaces.
- Determine room supply/return/exhaust airflow.
- Select diffuser type/model by flow band and project rules.
- Calculate diffuser count per room with min/max flow and noise/throw placeholders.
- Place diffuser candidates using spatial/plenum rules.
- Validate plenum access, ceiling/space containment and clearance.
- Build route preview options from shaft/main/branch concepts.
- Commit a connected duct network only after validation.
- Run or prepare Revit native sizing validation on connected networks.

## Implementation Rules

- Keep preview and commit separate.
- Never create production ducts from unchecked candidate geometry.
- Keep engineering calculation code independent from Revit write code.
- Every Revit write path must support dry-run/report mode first.
- Preserve existing spatial foundation behavior.

## Tests

- Unit tests for airflow distribution, diffuser count/type selection and route scoring.
- JSON fixture tests for rooms with no airflow, too much airflow, no valid diffuser type, blocked plenum and disconnected duct graph.
- Existing non-Revit test suite where applicable.
- Revit 2022 source build check if add-in code changes.
- Live Revit dry-run report with selected sample rooms before any commit path is approved.

## Acceptance Criteria

- A reviewer can trace room airflow to diffuser count/type and final duct segment flow.
- Duct network commit produces connected elements or blocks the commit with explicit reasons.
- PR includes dry-run output, test output, limitations and manual Revit verification steps.
