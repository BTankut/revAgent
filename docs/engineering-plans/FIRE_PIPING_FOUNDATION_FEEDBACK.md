# Fire Piping Notes For Connector Graph Foundation

Do not change the shared graph schema in this branch. These are candidate
foundation branch follow-ups discovered while building the fire piping audit
consumer.

## Optional Hydraulic Fields

The current `mep.connector-graph.v1` schema can carry fire hydraulic inputs
through `metadata.properties` and `node.properties`, which is sufficient for the
first audit/schematic module. For production hydraulic solver handoff, consider
documenting optional standard property keys or first-class engineering fields:

- sprinkler K-factor
- design density
- hose allowance
- Hazen-Williams C-factor
- equivalent length
- remote area id/name
- explicit fire role tags for source, riser, sprinkler, cabinet, valve and reducer

## Direction Semantics

The audit can orient flow from source/riser by graph distance even when graph
edge direction is unknown or ambiguous. For looped fire grids, same-depth edges
are intentionally reported as orientation ties. A future foundation note could
clarify how branch consumers should record source-oriented direction overlays
without mutating the base connector graph.
