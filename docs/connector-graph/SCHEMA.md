# MEP Connector Graph JSON Schema

Schema version: `mep.connector-graph.v1`

This contract is the shared handoff format between Revit extraction branches and
calculation/reporting modules. It is intentionally plain JSON so fixtures can be
reviewed in PRs and replayed without Revit.

## Design Rules

- Coordinates and engineering dimensions are exported in metric report units.
- Revit internal numeric values must be converted before writing JSON.
- Edges represent connector-to-connector relationships, not approximate element
  adjacency.
- Physical connector references are preferred. Proximity edges are allowed only
  when the exporter marks `kind` as `proximity`.
- Ambiguous direction is explicit. Exporters must write `direction:
  "ambiguous"` or `"unknown"` instead of guessing.
- JSON output must be deterministic: nodes, connectors, edges, topology
  components, findings, and dictionary keys are sorted by id/key.

## Root Object

| Field | Required | Description |
| --- | --- | --- |
| `schemaVersion` | yes | Must be `mep.connector-graph.v1`. |
| `metadata` | yes | Export source, mode, Revit version, document/view labels, optional properties. |
| `units` | yes | Report unit labels. Default is mm, m2, m3, L/s, slope ratio. |
| `nodes` | yes | MEP elements and their connector ports. |
| `edges` | yes | Connector-to-connector graph edges. |
| `topology` | no | Validator report. Fixtures may omit it and compute it during tests. |

## Node

Each node represents one Revit owner element such as pipe, duct, fitting,
accessory, fixture, equipment, terminal, sprinkler, valve, or cabinet.

Required identity fields:

- `id`: deterministic graph id, usually derived from element id plus role.
- `elementId`: Revit element id when available.
- `uniqueId`: Revit stable unique id when available.
- `category`, `familyName`, `typeName`
- `systemClassification`, `systemName`, `systemType` when Revit exposes them.
- `connectors`: list of connector ports owned by the element.

Engineering fields live under `engineering`:

- `lengthMm`
- `diameterMm`
- `widthMm`
- `heightMm`
- `slope`
- `flowLps`
- `fixtureUnits`
- `material`
- `insulation`

## Connector

Connectors carry the data needed to rebuild topology without Revit:

- `id`: deterministic connector id unique in the graph.
- `ownerNodeId`, `ownerElementId`, `ownerUniqueId`
- `connectorIndex`: exporter-local connector index when available.
- `domain`: `piping`, `hvac`, `electrical`, `cableTray`, `conduit`, `unknown`.
- `origin`: `{ "x": number, "y": number, "z": number }` in graph units.
- `direction`: unit direction vector when available.
- `flowDirection`: `in`, `out`, `bidirectional`, or `unknown`.
- `isConnectionExpected`: defaults to `true`; set `false` for intentionally
  unused spare ports so the validator does not flag them as open ends.

## Edge

Edges are the physical or declared relationship between two connector ports:

- `id`
- `fromNodeId`, `fromConnectorId`
- `toNodeId`, `toConnectorId`
- `direction`: `fromTo`, `toFrom`, `bidirectional`, `ambiguous`, `unknown`.
- `kind`: `physical`, `logical`, `proximity`, `synthetic`.
- `domain`
- `systemClassification`

The validator infers `fromNodeId` and `toNodeId` from connector ownership when
they are omitted, but a mismatch is a structural error.

## Topology Report

`TopologyValidator` produces:

- counts for nodes, connectors, edges, networks, open ends, cycles, ambiguous
  directions, and missing system data.
- `isStructurallyValid`: false when ids or endpoints are invalid.
- `isValidForDirectionalCalculation`: true only for one structurally valid,
  directed network with system data.
- findings with `severity`, `code`, `message`, and related node/connector/edge
  ids.

Initial finding codes:

- `schema_version_unsupported`
- `node_id_missing`, `node_id_duplicate`
- `connector_id_missing`, `connector_id_duplicate`, `connector_owner_mismatch`
- `edge_id_missing`, `edge_id_duplicate`
- `edge_endpoint_missing`, `edge_endpoint_unknown`,
  `edge_endpoint_owner_mismatch`
- `open_end`
- `missing_system_data`
- `direction_ambiguous`, `direction_conflict`
- `cycle_detected`
- `disconnected_island`
- `multiple_networks`

## Fixtures

Canonical fixtures live under `tests/fixtures/connector-graph/`:

- `tree.json`: one directed calculation-ready network.
- `loop.json`: one connected network with a cycle.
- `disconnected.json`: multiple networks plus an island/open end.
- `ambiguous.json`: ambiguous direction and missing system data.
