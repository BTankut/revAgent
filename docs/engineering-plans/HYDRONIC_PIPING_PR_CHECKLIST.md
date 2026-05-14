# Hydronic Piping PR Checklist

## Scope

- Dry-run hydronic connector graph analysis only.
- No automatic routing, geometry edits, parameter write-back, or visual overrides.
- Shared connector graph schema is consumed as input and is not changed in this branch.

## Manual Engineering Review

- Verify a real heating-water or chilled-water connector graph export can be passed to `analyze_hydronic_piping_graph`.
- Confirm pumps, coils, balancing valves, control valves, fittings, and pipe accessories are correctly identified in the report.
- Review every `graph_audit.missing_data` item before trusting pump head or balancing delta-P.
- Confirm selected calculation method and assumptions match project standards: Darcy-Weisbach by default, Hazen-Williams only where permitted.
- Spot-check at least one pipe segment velocity and pressure drop by hand from reported flow, diameter, length, roughness, K, and equivalent length.
- Confirm the reported critical path follows the intended supply/return route and does not rely on an ambiguous or reversed graph direction.
- Confirm balancing valve delta-P is reported for non-critical branches and that listed valve ids match model valves.
- Keep Revit write-back disabled unless a future PR adds explicit preview approval and parameter schema preflight.

## Foundation Branch Feedback

- Publish stable field names and units for length, diameter, flow, material roughness, K value, equivalent length, and direction confidence.
- Preserve the data source for flow values so calculation branches can distinguish Revit-provided values from inferred values.
- Add optional extractor-side role hints where available, while allowing discipline branches to apply stricter local classification rules.
