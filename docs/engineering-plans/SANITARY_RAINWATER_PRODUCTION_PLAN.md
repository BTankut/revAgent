# Sanitary / Rain Water Piping Production Plan

Branch: `feature/mep-sanitary-rainwater-production`

## Mission

Build production-grade sanitary, vent, storm and rain water sizing support. The core challenge is graph-aware downstream accumulation; Z-sort alone is not acceptable for production.

## Reference Sources

- `IPCSanitaryPipeSizer`: DFU, slope, table lookup and no-reduction workflow.
- `RainLeaderPipeSizer`: storm/rain leader table lookup for vertical and horizontal drains.
- `Revit-SANITARY-Pipe-Sizer`: Dynamo/Excel sanitary workflow and IPC tables.
- `Revit-STORM-Pipe-Sizer`: roof area, vertical wall area, roof drain flow, fitting flow and Excel workflow.
- `TraverseAllSystems` / `BuildingGraph-Client-Revit`: graph direction and topology validation.
- `OpenMEP`: pipe/fitting/diameter API patterns.

## Required Capabilities

- Consume shared MEP connector graph.
- Identify fixtures, roof drains, stacks, branches, building drains, leaders and outfalls.
- Accumulate DFU or storm flow downstream through the actual graph.
- Use slope, horizontal/vertical classification and table lookup for required diameter.
- Enforce no downstream pipe size reduction.
- Report slope violations, missing fixture units, ambiguous direction, disconnected branches and bad system classification.
- Support dry-run report before diameter write-back.

## Implementation Rules

- Do not use elevation-only sorting as production flow direction.
- Keep code-standard tables isolated from graph traversal.
- Allow TS/EN/IPC table replacement by data configuration.
- Do not resize fittings blindly; report Revit reapply-type/fitting issues explicitly.

## Tests

- Unit tests for DFU accumulation, storm flow accumulation, table lookup, slope selection and no-reduction.
- Synthetic graph fixtures: branch-to-stack, horizontal branch, vertical stack, storm leader, secondary overflow, disconnected fixture, reversed edge.
- Revit dry-run/audit report before any write-back.
- Existing test suite and Revit 2022 build check if add-in code changes.

## Acceptance Criteria

- Every pipe diameter recommendation is traceable to upstream fixture/roof load, slope and table row.
- Ambiguous drainage direction blocks write-back.
- PR includes calculation fixtures, dry-run evidence, limitations and manual review checklist.
