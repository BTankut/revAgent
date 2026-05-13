# DCW/DHW Sizing Audit

Runtime tools:

- `audit_dcw_dhw_piping`
- `apply_dcw_dhw_writeback`

## Input Contract

`audit_dcw_dhw_piping` consumes the shared connector graph JSON contract:

- `schemaVersion: "mep.connector-graph.v1"`
- `nodes[*].engineering.fixtureUnits`, `flowLps`, `lengthMm`, `diameterMm`
- `nodes[*].properties` for exporter/project-specific data such as DCW/DHW fixture units, flush type, and DHWR heat loss
- `edges[*]` for directed connector-to-connector topology
- optional `topology.findings` from the foundation validator

This branch does not change the graph schema. Missing data is reported in the
audit output. Schema improvements needed by downstream sizing are listed under
`foundationRecommendations` so they can be proposed back to the foundation
branch.

## Fixture Units And Flow

The audit reads common fixture-unit aliases from node properties, including:

- `dcwFixtureUnits`, `Cold Water Fixture Units`, `CWFU`, `DCW FU`
- `dhwFixtureUnits`, `Hot Water Fixture Units`, `HWFU`, `DHW FU`
- generic `fixtureUnits` / `WSFU` fallback

Flush behavior is classified from `flushType` style properties and family/type
names:

- `flushTank`
- `flushValve`
- `unknown`

Fixture units are converted to flow by linear interpolation. The bundled tables
are project placeholders for repeatable testing; production runs should pass the
approved project/code tables through `options.flowTable` or
`options.flowTables`.

## Revit Native Sizing Preparation

The report includes `nativeSizingPreparation` with readiness notes and required
fixture/pipe parameter checks. Revit native sizing is treated as a tool, not the
only source of truth.

The `PlumbingFixtureFlowServer` pattern is a native Revit hook. It requires an
installed Revit add-in that registers the calculation server. This runtime
module does not silently install, register, or assume that hook exists.

Excel and Dynamo examples are table/workflow references only. They are not
runtime dependencies.

## DHW Recirculation

The DHWR section calculates:

- segment heat loss from `heatLossW`, or `heatLossWPerM * lengthMm`
- fallback heat loss from `options.defaultDhwrHeatLossWPerM` when segment data
  is missing, with a warning
- heat-loss critical path through the directed return graph
- total return flow using:

```text
flow L/s = heatLossW / (density kg/L * cp J/kgK * deltaT K)
```

Default assumptions are 0.997 kg/L, 4186 J/kgK, and 5 C delta-T unless options
override them.

## Write-Back Control

`audit_dcw_dhw_piping` never writes to Revit. It emits a `writeBackPlan` with:

- action id
- graph node id and Revit element id
- current/proposed diameter or parameter value
- fixture-unit, flow, table-rule, and diameter-rule trace data
- `approvalToken`

`apply_dcw_dhw_writeback` commits only when all of these are true:

- actions are supplied from the audit output
- `approvalToken` matches the exact action payload
- `confirmWriteBack` is `APPLY_DCW_DHW_WRITEBACK`
- `dryRun` is explicitly `false`
- Revit MCP status preflight reports no active task

Diameter writes target `RBS_PIPE_DIAMETER_PARAM` on Revit pipe elements.
Parameter writes use `LookupParameter` and skip missing or read-only parameters.
