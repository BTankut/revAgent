# MEP Production Packages

The merged system packages are runtime MCP tools. They are not independent
Revit ribbon buttons and they do not replace engineering approval. They consume
model-derived JSON, mainly the shared connector graph contract
`mep.connector-graph.v1`, then return deterministic findings, recommendations,
and gated write-back plans where applicable.

Use these tools as production foundations:

```text
model data -> connector graph / spatial data -> package audit -> human review
-> controlled write-back where implemented -> Revit re-inspection
```

## Runtime vs add-in

The Revit add-in still supplies the live execution bridge used by
`send_code_to_revit`, view/focus helpers, and approved write-back tools. The
new packages are registered in the Node runtime MCP server:

- `evaluate_ducting_design`
- `analyze_hydronic_piping_graph`
- `audit_dcw_dhw_piping`
- `apply_dcw_dhw_writeback`
- `calculate_sanitary_rainwater_from_graph`
- `apply_sanitary_rainwater_pipe_sizes`
- `audit_fire_piping_topology`

They do not add new Revit external commands or ribbon UI. When a package needs
Revit data, first export or pass a connector graph JSON from the model. When a
package writes, it does so through the existing Revit MCP execution channel
after explicit approval gates.

## Ducting production evaluator

Tool: `evaluate_ducting_design`

What it does:

- maps air balance rows to rooms/spaces
- evaluates diffuser catalog/count inputs
- checks plenum volume and obstacle relation inputs
- scores route candidates
- validates duct connector graph continuity
- checks Revit native sizing evidence when supplied
- reports whether commit is blocked or ready

How to use:

```text
1. Prepare spaces, air balance rows, diffuser catalog, plenum volumes,
   route candidates, connector graph, and native sizing evidence as JSON.
2. Run evaluate_ducting_design with workflowStage=dry-run, preview, validate,
   or commit.
3. Treat commitReady=true as a gate signal only; it does not create ducts.
```

Write behavior: read-only. It never writes Revit elements.

Engineering limit: it is not a full HVAC design engine. It checks readiness and
consistency before a reviewed route/sizing/commit workflow.

## Hydronic piping analysis

Tool: `analyze_hydronic_piping_graph`

What it does:

- consumes a connector graph object, JSON string, or local graph file
- classifies pumps, coils, valves, fittings, accessories, and pipe segments
- calculates velocity and pressure drop by Darcy-Weisbach or Hazen-Williams
- reports critical path, required pump head, and balancing valve delta-P
- flags missing flow, diameter, direction, length, or local-loss data

How to use:

```text
1. Export a heating-water, chilled-water, or similar closed-loop connector graph.
2. Run analyze_hydronic_piping_graph.
3. If status is needs_review, inspect missing data and role/direction findings.
4. Use results as dry-run engineering evidence, not as automatic model commit.
```

Write behavior: read-only. It never writes Revit elements.

Engineering limit: pressure results depend on graph direction, terminal flow,
pipe inside diameter, fluid properties, roughness, equivalent lengths, and K
values.

## DCW/DHW/DHWR sizing

Tools:

- `audit_dcw_dhw_piping`
- `apply_dcw_dhw_writeback`

What it does:

- reads DCW/DHW fixture units from common aliases and graph properties
- classifies flush tank / flush valve / unknown fixture behavior
- converts fixture units to design flow using supplied or default tables
- checks pipe diameter against velocity and catalog limits
- evaluates DHW recirculation heat-loss critical path
- emits traceable write-back actions for diameter and optional parameters

How to use:

```text
1. Export a domestic water connector graph.
2. Run audit_dcw_dhw_piping.
3. Review missing fixture units, zero-flow sections, table assumptions, and
   DHWR warnings.
4. For model writes, copy only the selected actions from writeBackPlan.
5. Run apply_dcw_dhw_writeback with the exact approvalToken,
   confirmWriteBack=APPLY_DCW_DHW_WRITEBACK, and dryRun=false.
6. Re-inspect changed pipes.
```

Write behavior: audit is read-only. Apply can write approved pipe diameters and
parameters, but only after exact token/confirm/status gates.

Engineering limit: bundled fixture-unit and flow tables are placeholders for
repeatable tests. Production work must supply project/code-approved tables.

## Sanitary/rainwater sizing

Tools:

- `calculate_sanitary_rainwater_from_graph`
- `apply_sanitary_rainwater_pipe_sizes`

What it does:

- accumulates downstream sanitary DFU or rainwater flow from graph direction
- separates sanitary/rainwater modes or infers them from graph data
- applies table-driven horizontal/vertical pipe size recommendations
- reports disconnected loads, ambiguous direction, missing fixture units,
  missing slopes, and mixed drainage loads
- emits a write-back plan with approval metadata

How to use:

```text
1. Export a drainage connector graph.
2. Run calculate_sanitary_rainwater_from_graph with includeWriteBackPlan=true
   when a plan is needed.
3. Review report status, blockers, warning summary, and table profile.
4. For model writes, run apply_sanitary_rainwater_pipe_sizes in dryRun first.
5. Commit only with the static commit token, exact plan approvalToken, exact
   confirm text, and allowWarnings=true when the plan requires warning review.
6. Re-inspect changed pipes.
```

Write behavior: calculation is read-only. Apply can write approved pipe
diameters only when the report is not blocked and all manual gates pass.

Engineering limit: bundled drainage tables are generic metric placeholders.
Vent sizing is detected but not fully implemented.

## Fire piping topology audit

Tool: `audit_fire_piping_topology`

What it does:

- orients source/riser to sprinkler/fire hose cabinet topology
- counts downstream sprinklers and cabinets
- checks schematic count-based pipe sizing
- detects reducer issues, open ends, disconnected networks, loops, isolated
  terminals, and missing valves
- reports missing hydraulic inputs
- returns a solver-adapter placeholder for EPANET/WNTR/SprayHydraulic style
  future workflows

How to use:

```text
1. Export a sprinkler/fire hose cabinet connector graph.
2. Run audit_fire_piping_topology.
3. Review topology, source/riser classification, downstream counts, open ends,
   missing valves, and missing hydraulic inputs.
4. Treat hydraulicApproval=false as intentional.
```

Write behavior: read-only. It never writes Revit elements.

Engineering limit: it is a topology/schematic audit, not NFPA/EN hydraulic
approval. Final design needs reviewed K-factor, density/area, hose allowance,
C-factor, elevation, equivalent length, remote area, and applicable code basis.

## Minimum safety rules

- Always call `get_revit_mcp_status` before a non-status Revit MCP command.
- Do not run Revit MCP runtime tools in parallel.
- Treat missing graph direction or missing design data as a blocker for model
  writes.
- Prefer small write-back batches and re-inspect changed elements.
- Keep table/profile assumptions visible in reports.
