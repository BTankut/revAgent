# Fire Piping Topology Audit

The runtime MCP server includes `audit_fire_piping_topology` for sprinkler and
fire hose cabinet graph review. It consumes the shared connector graph contract
`mep.connector-graph.v1` and does not call Revit or modify the model.

## Scope

- source/riser to sprinkler/cabinet orientation
- downstream sprinkler and cabinet counts
- count-based schematic pipe size audit
- reducer and direct pipe diameter transition checks
- open end, disconnected network, loop and missing valve reporting
- missing hydraulic input reporting
- solver adapter placeholder for EPANET, WNTR and SprayHydraulic

## Limits

Reports are labeled `audit/schematic`. They do not assert NFPA or EN hydraulic
compliance. Hydraulic approval needs reviewed K-factor, design density, hose
allowance, Hazen-Williams C-factor, elevations, equivalent lengths, remote area
selection and a validated solver/report workflow.

Model writes remain outside this module and must follow:

```text
dry-run -> preview -> validate -> commit -> report
```

## Test Fixtures

Synthetic connector graph fixtures live under `tests/fixtures/fire-piping/`:

- `single-riser-tree.json`
- `looped-grid.json`
- `isolated-sprinkler.json`
- `cabinet-branch.json`
- `missing-valve.json`
- `disconnected-network.json`

The runtime server test script runs these through the pure TypeScript audit
module before socket and MCP smoke tests.
