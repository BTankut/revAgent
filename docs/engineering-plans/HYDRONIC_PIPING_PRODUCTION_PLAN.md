# Heating / Cooling Piping Production Plan

Branch: `feature/mep-hydronic-piping-production`

## Mission

Build production-grade hydronic piping analysis for heating water, chilled water and similar closed-loop systems: pipe graph extraction, flow/pressure loss calculation, critical path, pump head and balancing valve reporting.

## Reference Sources

- `OpenMEP`: Revit pipe/connector/fitting API patterns.
- `DhwCriticalThermalPath`: connector graph traversal and critical path idea.
- `MEP_Plugin`: Hazen-Williams, Darcy-Weisbach and head loss formulas as calculation references.
- `SprayHydraulic`: pipe network hydraulic solver structure.
- `EPANET` / `WNTR`: optional external solver research path, not first production dependency.

## Required Capabilities

- Consume shared MEP connector graph from the foundation branch.
- Identify pumps, coils, valves, pipe accessories and branch loops.
- Attach length, diameter, material, roughness, fittings/accessory K or equivalent length.
- Read or infer system flow at terminal/coil/equipment points.
- Calculate segment pressure loss using project-selected method.
- Find critical path across supply/return where applicable.
- Produce pump head and balancing valve delta-P report.
- Write calculated parameters or visual overrides only after preview approval.

## Implementation Rules

- Start with audit/report before automatic resizing.
- Do not attempt full clash-aware hydronic routing in the first production PR.
- Keep hydraulic calculations as pure tested code.
- All formulas must declare units and assumptions.
- Do not trust Revit system direction blindly; validate against graph and equipment roles.

## Tests

- Unit tests for Darcy-Weisbach/Hazen-Williams helpers, equivalent length, velocity, pressure drop and critical path.
- Synthetic graph fixtures: single loop, branch loop, missing flow, missing diameter, reversed direction, disconnected network.
- Revit dry-run graph report from a real selected system before write-back.
- Existing repo test suite and Revit 2022 build check if add-in code changes.

## Acceptance Criteria

- Report lists every critical assumption and missing data item.
- Critical path result is reproducible from JSON fixtures.
- No geometry modification is performed by default.
- PR contains calculation tests, dry-run evidence and manual engineering review checklist.

