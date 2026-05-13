# Fire Hose Cabinet / Sprinkler Piping Production Plan

Branch: `feature/mep-fire-piping-production`

## Mission

Build production-grade fire piping support for sprinkler and fire hose cabinet systems. First target is topology, count-based audit and controlled pipe modeling. Full hydraulic compliance is a later layer that must be validated separately.

## Reference Sources

- `TraverseAllSystems`: Revit MEP topology export.
- `Fire_sprinkler`: source/sink graph orientation, downstream sprinkler count, pipe size assignment and reducer marking.
- `SprayHydraulic`: fire spray/sprinkler-oriented Hazen-Williams network solver.
- `EPANET` / `WNTR`: mature pressurized network solver path.
- `OpenMEP`, `RevitExtensions`, `pyRevitMEP`: Revit pipe/connect/fitting behavior references.

## Required Capabilities

- Consume shared MEP connector graph.
- Identify risers, sprinkler heads, cabinets, valves, branch mains and open ends.
- Orient fire flow from source/riser to sprinklers/cabinets.
- Count downstream sprinklers/cabinets and produce count-based sizing/audit report.
- Detect missing K-factor, design density, hose allowance, C-factor, elevation and equivalent length data.
- Prepare a solver adapter schema for later EPANET/WNTR/SprayHydraulic integration.
- Support controlled pipe creation only after topology and engineering preview.

## Implementation Rules

- Do not claim NFPA/EN compliance until hydraulic solver, remote area, hose allowance and report format are implemented and reviewed.
- First production PR should focus on topology, completeness and count-based audit.
- Keep hydraulic solver adapters isolated from Revit API code.
- Never auto-route fire piping without explicit preview and human approval.

## Tests

- Unit tests for source/sink orientation, downstream counts, reducer detection and missing-data reporting.
- Synthetic graph fixtures: single riser tree, looped grid, isolated sprinkler, cabinet branch, missing valve, disconnected network.
- Optional solver fixture using a tiny EPANET/WNTR/SprayHydraulic-compatible network.
- Existing repo tests and Revit 2022 build check when applicable.

## Acceptance Criteria

- Branch can produce a fire topology/audit report without modifying the model.
- Count-based recommendations are clearly labeled as audit/schematic, not final hydraulic approval.
- PR includes tests, dry-run report and manual fire-engineering review checklist.

