# Ducting Production Handoff

## Production Workflow

1. Extract spatial/plenum context from `spatial-zone-extract.cs`.
2. Import or provide air balance schedule rows.
3. Run `evaluate_ducting_design` in `dry-run`, `preview`, then `validate`.
4. Review diffuser candidates, plenum validation, route score, connected graph validation, and native sizing validation.
5. Only pass `commit=true` to `commit-duct-network.cs` after the production report returns:
   - `summary.status = pass`
   - `commitGate.canCommit = true`
   - `production_validation_status=pass`
   - `production_commit_ready=true`

The evaluator does not write Revit elements. Revit write paths remain in the reference snippets and must be driven through dry-run/report first.

## JSON Inputs

- `spaces`: room or MEP space rows from the spatial foundation.
- `airBalanceRows`: schedule rows with `supply_lps`, `return_lps`, or `exhaust_lps`; `*_m3h` fields are converted to L/s.
- `diffuserCatalog`: project diffuser rules by system with min/max flow and optional NC/throw data.
- `plenumVolumes` and `plenumObstacleIntersections`: spatial foundation data.
- `routeCandidates`: reviewed dry-run route options with points or segments.
- `connectorGraph`: foundation connector graph JSON. This branch consumes it without adding fields.
- `nativeSizing`: Revit native sizing report or segment results.

## Foundation Follow-up Notes

No ducting branch schema changes were made. If the foundation branch needs more detail, propose these there:

- Document how Revit native sizing report fields should be attached to connector graph reports.
- Document reviewed evidence for resolving connector flow direction ambiguity.

## Manual Revit Verification Checklist

- Confirm active model and target level before any Revit MCP runtime command.
- Run the evaluator from extracted room/space and air balance data and archive the JSON report with the PR.
- Inspect diffuser count/type per room against the air balance schedule.
- Inspect plenum warnings/errors in plan or 3D before route preview.
- Review the best route preview and confirm it is marked reviewed before commit.
- After a commit trial, export the connector graph and confirm one connected network with no unexpected open ends.
- Run or attach the Revit native sizing validation report and confirm flow/size/velocity tolerances.
