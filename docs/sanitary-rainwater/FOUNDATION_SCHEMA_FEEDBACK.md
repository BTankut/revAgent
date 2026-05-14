# Sanitary / Rainwater Foundation Schema Feedback

Source contract reviewed from:

- `C:\Users\BT\Projects\MEP-systems\foundation-connector-graph\docs\connector-graph\SCHEMA.md`
- `C:\Users\BT\Projects\MEP-systems\foundation-connector-graph\docs\engineering-plans\CONNECTOR_GRAPH_FOUNDATION_PLAN.md`

This branch does not change the shared connector graph schema. The notes below
are proposed items for the foundation branch if sanitary/rainwater production
calculation needs become common across feature branches.

## Proposed Foundation Items

- `explicit_drainage_role`: add an optional role/classification field for
  drainage-specific semantics such as fixture, roof drain, stack, leader,
  horizontal branch, building drain, vent, overflow, and outfall. The current
  calculation branch infers these from category/family/type/system text.
- `storm_load_inputs`: keep `engineering.flowLps` as the calculation-ready
  rainwater load, but consider optional source inputs for roof area, vertical
  wall area, rainfall intensity, runoff coefficient, primary/secondary overflow
  identity, and drain catchment id.
- `vent_sizing_inputs`: vent sizing needs explicit vent role and developed
  length/context. Segment `lengthMm` exists, but terminal/source semantics and
  vent network context are not explicit.
- `writeback_parameter_context`: write-back can use `elementId` and `uniqueId`,
  but a future foundation extractor could optionally report writable diameter
  parameter availability/type constraints so dry-run reports can distinguish
  calculation issues from Revit parameter write risks before a live preflight.
