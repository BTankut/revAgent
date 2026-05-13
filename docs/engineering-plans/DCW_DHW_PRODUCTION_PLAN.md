# DCW / DHW Piping Production Plan

Branch: `feature/mep-dcw-dhw-production`

## Mission

Build production-grade domestic cold water, domestic hot water and DHW recirculation support. The branch should combine Revit native sizing where useful with custom fixture-unit, flow conversion and recirculation critical path modules.

## Reference Sources

- `PlumbingFixtureFlowServer`: Revit fixture-unit-to-flow calculation server pattern.
- `Revit-DCW-DHW-Pipe-Sizer`: Dynamo/Excel fixture-unit workflow and sizing tables.
- `DhwCriticalThermalPath`: DHW recirculation graph traversal and heat-loss critical path.
- `OpenMEP`: pipe creation, connector and diameter helpers.
- `TraverseAllSystems` / `BuildingGraph-Client-Revit`: topology validation.

## Required Capabilities

- Consume shared MEP connector graph.
- Read fixture units and classify flush tank/flush valve behavior where applicable.
- Convert FU to flow using project/standard tables.
- Validate that domestic systems are connected and correctly classified.
- Prepare Revit native sizing inputs where possible.
- For DHW recirculation, calculate thermal critical path and return flow from segment heat loss.
- Report missing fixture data, wrong connector classification, open ends and zero-flow sections.

## Implementation Rules

- Treat native Revit sizing as a tool, not the only source of truth.
- The calculation server hook is future installed-addin work; do not hide that requirement.
- Do not use Excel as production runtime logic, but extract table/workflow lessons from Excel examples.
- Keep write-back limited to explicit diameter/parameter updates after preview approval.

## Tests

- Unit tests for FU-to-flow lookup/interpolation, fixture aggregation, no-flow detection and DHW heat-loss path.
- JSON fixtures for tank/valve fixtures, mixed DHW/DCW systems, disconnected branches and recirculation loops.
- Revit dry-run report for selected domestic systems.
- Existing repo tests and Revit 2022 build check when applicable.

## Acceptance Criteria

- Branch can produce a sizing/audit report without model writes.
- Every changed diameter or parameter is traceable to graph edge, FU/flow and table rule.
- DHW recirculation output lists critical path and return flow assumptions.
- PR includes tests, dry-run evidence and manual review checklist.

