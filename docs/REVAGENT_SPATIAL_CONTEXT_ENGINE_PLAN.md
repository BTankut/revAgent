# revAgent Spatial Context Engine Plan

Status: codex_final; execution completed through Phase 1a.
Revision: v2.7 — Phase 1a accepted after protected delivery and rollout
closure (2026-07-12).
Supersedes draft v2.1, v2, and the draft previously named
`REVAGENT_SPATIAL_DESIGN_ENGINE_PLAN.md`.

Program structure:

- **Layer 1 — Spatial Context Engine (v1 deliverable, read-only).** The agent
  "sees" the live Revit model through structured data: capture, query, diff,
  clash screening, and live clash verification. No Revit writes of any kind.
- **Layer 2 — Spatial Design Engine (north star, gated on Layer 1).** Duct
  routing and terminal/equipment placement through a propose-verify-repair
  loop, with operator-gated materialization behind native bridge commands.

Layer 1 ships standalone production value (spatial Q&A, coordination review,
coverage-qualified clash verification). Layer 2 is specified here so Layer 1 data contracts are
designed once, but nothing in Layer 2 is scheduled until Layer 1 passes its
production gate.

## 1. Purpose

Give the revAgent mechanical module a grounded spatial reasoning capability:
the LLM reasons over geometry extracted from Revit, never over an imagined
model. On that foundation, enable design generation as a second layer.

Non-goals for Layer 1:

- Any Revit model write. All Layer 1 tools are write-action `none`.
- Design generation of any kind.
- Authoritative engineering calculations.

Additional non-goals for Layer 2 v1: pipe routing (sloped systems; router
keeps a slope-constraint extension point), LOD 400 detailing, hangers,
seismic bracing, autonomous commits.

## 2. Design Thesis

Three hard rules:

1. **See first, design second.** No design tool may run against a scope the
   agent has not captured and queried in-session. Grounding in retrieved
   data is the direct countermeasure to mirage reasoning (E8).
2. **The LLM is the orchestrator, never the geometry engine.** The LLM
   interprets intent, emits bounded constraints, ranks candidates, and
   diagnoses failures. Deterministic components compute all geometry —
   including spatial *relations*: the LLM consumes computed relations
   (`above_below`, `clearance_between`, ...) and never derives them from raw
   coordinates (Section 6.2).
3. **Approximate analysis can only raise suspicion, never grant clearance.**
   Snapshot-based screening returns clash *candidates*; the words
   "clash-free" / "no clashes" may only quote a live, complete
   `detect_clashes` report that satisfies the coverage-completeness contract
   (Section 6.4).

## 3. Evidence Base

Verification column states how each claim was checked for this document.

| # | Finding | Source | Verification | Design consequence |
|---|---------|--------|--------------|--------------------|
| E1 | Frontier LLMs handle metric lookups over structured layouts well on clean synthetic data (75-95%) but degrade to 35-60% on realistic layouts; free-space identification drops to <=5.8%; proposed paths violate clearance and Frechet-optimality constraints. Tool ablation (+Python) improves arithmetic (+30-43 pts) but *hurts* shortest-path (-12.5): "the bottleneck... is algorithmic reasoning about spatial constraints, not numerical precision." | FloorplanQA, arXiv 2507.07644 v4, ICML 2026 (formerly PlanQA) | Full text read (v1 and v4 compared); numbers are v4 | LLM must not compute paths, relations, or final coordinates; deterministic query/relation engine mandatory (Section 6.2). Caveat: benchmark domain is 2D room layouts — direction corroborated by E9. |
| E2 | Free-form numeric CAD emission by GPT-4 was 64-77% invalid; discretized coordinate lattice + sequential parametric JSON DSL cut invalidity 4-9x in ablation. | CAD-GPT, arXiv 2412.19663, AAAI 2025 | Full text read | Applies to **Layer 2 generation only**: the design-intent DSL uses snapped lattice/anchor coordinates. It is *not* evidence for discretizing Layer 1 perception, which stays at real millimeter fidelity (Section 5.5). |
| E3 | Text re-rendering of spatial state before each decision improves LLM spatial reasoning and beats GPT-4V given real images; but absolute performance stays low (14.7% route success), renderings ~75% inaccurate, validated only on small 2D grids. | VoT, arXiv 2404.03622, NeurIPS 2024 | Full text read | VoT-style compact state re-rendering only for local, bounded decisions; advisory only; verification stays deterministic. |
| E4 | Component-level BIM graph with typed nodes/edges carrying computed relational features lets reasoning operate on arithmetic instead of coordinate geometry. | arXiv 2505.22670, ISARC 2025 | Full text read | SCG pushes computed relations onto edges; clearance features use explicit unambiguous fields (Section 5.4). |
| E5 | Propose-verify is the converging pattern: LLM proposes topology/constraints, deterministic checker/solver validates, structured failure feedback drives repair. | Text2BIM arXiv 2408.08054; MASSE 2510.11004; Co-Layout 2511.12474; AutoLayout 2507.04293 | Text2BIM read in summary; others abstract-level — directional precedent | Layer 2 loop is bounded propose-verify-repair with structured `VerificationReport` feedback. |
| E6 | Rule-based HVAC duct network generation beat manual designs on six layouts. | Kukkonen et al., Automation in Construction 2022/2023 | Abstract-level (paywalled) — directional | Duct tree topology stage is rule-based/deterministic, LLM-parameterized. |
| E7 | Deterministic, rule-driven, clash-aware routing at building scale is productized. | Augmenta ACP 2.0, 2026 | Vendor/press material — feasibility signal only | Feasibility proof for the deterministic router core. |
| E8 | LLM systems confidently fabricate spatial content when input data is absent ("mirage reasoning"); dropped inputs in agentic pipelines cause silent confident failure. | MIRAGE, arXiv 2603.21687 | Full text read | Grounding rules + ablation evals (Section 11). |
| E8b | An agentic orchestrator with counterfactual/cross-modality verification confers resistance to mirage reasoning. MIRAGE reports the companion protocol reduced composite mirage rate to zero; the MARCUS abstract itself claims "resistance", not a zero rate. | MARCUS, arXiv 2603.22179 | Abstract read; zero-rate figure secondhand via MIRAGE — flagged | Verification lives in the architecture (tool-computed reports), not in model behavior. |
| E9 | Unconstrained LLM authoring of BIM is fragile end-to-end (32% task success for GUI-driving agents). | BIMgent, arXiv 2506.07217 | Abstract-level — directional | Design capabilities ship as narrow typed MCP tools. |

## 4. Architecture Overview

No change to the platform technology set (C# add-in + local Node MCP servers
+ skill layer). Layer boundaries:

```text
+------------------------------ Codex / LLM host ------------------------------+
| SKILL.md: Spatial Grounding Protocol (Layer 1)                               |
|           Design Orchestration Protocol (Layer 2, future)                   |
+-------------------------------------------------------------------------------+
        | MCP tools (runtime layer, TypeScript)
+-------------------------------------------------------------------------------+
| Runtime MCP server                                                            |
|  LAYER 1 (read-only)                    LAYER 2 (future)                      |
|   capture_spatial_snapshot               plan_terminal_layout                 |
|   query_spatial_context (+operations)    plan_duct_route                      |
|   compare_spatial_snapshots              materialize_mep_design (gated)       |
|   screen_clash_candidates                verify_mep_design                    |
|   detect_clashes (live, coverage-qualified)                                   |
|   summarize_spatial_state                                                     |
|  [persistent spatial store + R-tree index + chunked transport]                |
+-------------------------------------------------------------------------------+
        | shared Revit bridge (socket, existing; 32 MB runtime response ceiling)
+-------------------------------------------------------------------------------+
| Revit add-in (C#): revAgentCommandSet                                         |
|   extract_spatial_snapshot (new, read-only, paged)                            |
|   run_interference_check (new, read-only, exact within declared coverage)     |
|   document change tracker (new, DocumentChanged -> changeSequence)            |
|   create_mep_elements (future, Layer 2 materialization, transactional)        |
+-------------------------------------------------------------------------------+
```

Placement rationale:

- **Geometry extraction, live interference checks, and change tracking run
  Revit-side** as dedicated native components: only Revit has the source
  geometry needed for coverage-qualified verification, and per `AGENTS.md`
  (Skill Compliance), dedicated tools take
  precedence — raw `send_code_to_revit` is a fallback for unsupported cases
  only. Dynamic snippets are permitted solely inside the Phase 0 spike.
- **Graph assembly, persistence, indexing, queries, diffs, screening, and
  (later) solvers run Node-side** in the runtime server.
- **Materialization (Layer 2) is a native transactional bridge command**
  (`create_mep_elements`), never a raw-snippet product path.

## 5. Spatial Context Graph (SCG)

The SCG is the single structured representation the LLM reasons over,
extracted directly through the Revit API (no IFC round-trip).

### 5.1 Identity and coordinate model

Numeric `ElementId` is meaningful only within its own document (the existing
`find_elements` bridge already guards this: "Numeric elementIds are scoped
to the host document"). Linked models can be placed multiple times with
distinct transforms. Revit `Connector` objects and derived SCG nodes are not
Revit `Element` objects, so a Revit-element identity cannot be mandatory for
every node.

Every node has a generic identity:

```text
nodeId                 globally unique within the spatial store
nodeKind               revit_element | connector | derived
sourceRefs[]           zero or more provenance references
```

Revit-element nodes additionally carry an `ElementRef`:

```text
documentKey            stable owning-model key
documentSessionId      current open-document/session disambiguator
linkInstanceUniqueId?  placement identity when sourced through a link
elementUniqueId        Revit UniqueId
elementId              numeric id, valid only with documentKey + session
sourceKind             host | link
```

A Revit-element `nodeId` is derived from `(documentKey,
linkInstanceUniqueId | host, elementUniqueId)`, so two placements of the same
linked document remain distinct while a transform change preserves node
identity and appears in diff.

`documentKey` resolution is deterministic and versioned. Precedence is:
cloud project/model identity when available; workshared central-model
identity; saved standalone model identity (project-information identity plus
normalized path); and finally an explicitly session-only key for unsaved
documents. Session-only documents cannot participate in cross-session diffs.
`documentSessionId` is process-local to one native open-document session. Revit
may surface multiple managed `Document` wrappers for that same session, notably
when one linked document has multiple placements; those wrappers must resolve
to one session id and one change journal. A successful document close retires
all wrapper aliases, so the id changes after close/reopen or add-in restart.
Save As refreshes the stable identity aliases without resetting the open
session, so reopening the original path cannot inherit the Save As journal.
The exact resolver and its fallback reason are returned in
snapshot metadata and covered by Phase 0/1a fixtures (cloud, central/local,
standalone, link, and unsaved).

Connector identity is owner-based: `connector:{ownerNodeId}:{connectorKey}`.
The connector-key provider is versioned and category-aware: use a proven
stable API connector id where available; use endpoint order for `MEPCurve`
ends; otherwise use a canonical owner-local connector signature plus a
collision ordinal. Ambiguous remapping is reported and diffed as remove/add,
never silently matched. Derived node ids are deterministic hashes of node
type, derivation-rule version, scope anchor, and sorted `derivedFrom` node
ids; they are not assigned fake `elementUniqueId` values.

All computation uses one canonical coordinate system:

```text
coordinateFrame        host_internal_mm (fixed within a snapshot)
sourceToHostTransform  source-document internal -> host internal
displayTransforms      optional project/shared-coordinate metadata only
lengthUnit             mm
```

Mixed internal/shared node coordinates are invalid. Shared coordinates are a
presentation/export concern, not a relation-engine input. Snapshot scope
metadata records active phase, design options in effect, workset visibility
policy, link-inclusion policy, and category/rule-set selection. Loaded source
versions belong to revision metadata, not to scope identity (Section 5.6).

### 5.2 Liveness: change tracking, not age

Snapshot age is not a liveness measure — a model can change one second
after capture. Liveness is tracked by sequence, not by clock:

- The add-in subscribes to `DocumentChanged` and maintains a monotonic
  `changeSequence` per open document, recording changed/added/deleted
  element ids in a bounded change journal. The journal exposes
  `oldestRetainedSequence`; a snapshot older than the retained history has
  `liveness=unknown`, never an assumed `current` state.
- Wrapper aliases for the same native open document share that sequence and
  journal. Successful close/reopen retires the prior binding; a cancelled or
  failed close does not manufacture a new session.
- Every snapshot binds to the `changeSequence` value of each in-scope
  document at capture time. Multi-page captures are atomic with respect to
  it: pages write to a staging capture and become visible only after the
  final sequence check commits the snapshot. If the sequence advances,
  staging rows are discarded; capture retries at most twice, then returns
  `guarded=true` (`capture_interrupted_by_change`).
- Tool responses report `liveness: current | stale | unknown` by comparing
  snapshot and live sequences. Invalidation is conservative: deleted ids are
  checked against prior snapshot membership; added/modified ids are evaluated
  against current scope selectors and geometry; if an element may have moved
  into a bounded scope or impact cannot be proven irrelevant, the scope is
  marked `stale`. A changed id being absent from the old snapshot is never by
  itself evidence that the change is out of scope.
- `stale` snapshots require re-capture before current-state or clearance claims,
  but remain valid immutable historical inputs to
  `compare_spatial_snapshots`. A historical diff explicitly cites both
  snapshot/revision ids and never presents its base as current.
- Add-in restart or document reopen invalidates session liveness for existing
  snapshots; they remain historical/diffable when document identity is
  stable, but must be recaptured before current-state claims.
- Link caveat: `DocumentChanged` covers host edits and link reload/unload
  events, but not external edits inside a link between reloads. The currently
  loaded Revit link is the geometry truth. A newer external source timestamp
  is reported separately as `externalLinkUpdateAvailable`; it does not
  silently replace or invalidate the geometry Revit is currently displaying.

### 5.3 Node types

MEP elements are first-class, not generic obstacles:

| Node | Notes |
|------|-------|
| `Level` | elevation, height to level above |
| `Room` (architectural) and `Space` (MEP) | separate node types, joined by a `represents` mapping edge; function, area, boundary loops/footprint, vertical extent, ceiling height, plenum depth, boundary confidence |
| `PlenumZone` (derived) | usable elevation band; carries `confidence` + `derivedFrom` |
| `RoutingChannel` (derived) | spine polyline, usable cross-section; carries `confidence` + `derivedFrom`; primarily a Layer 2 input |
| `MepElement` subtype: `Duct`, `Pipe`, `DuctFitting`, `PipeFitting`, `Accessory`, `Terminal`, `EquipmentUnit` | size/profile, system, centerline where linear, insulation thickness |
| `StructuralElement` (beam, column, framing, slab) / `ArchElement` (wall, ceiling, shaft, opening) | AABB/OBB + centerline/footprint/profile where applicable; openings are explicit so wall/shaft envelopes do not invent blocked passages; typically from links |
| `Connector` | position, direction, shape/size, system classification, owner element |

"Obstacle" is a query-time *role* (anything intersecting a search volume),
not a node type. Derived nodes must be reported as inferences.

### 5.4 Edge types

| Edge | Meaning |
|------|---------|
| `located_in` | element-in-space/room, space-on-level |
| `adjacent` / `passage` | space adjacency, routable openings |
| `plenum_continuous` | plenum zones connectable above ceilings |
| `owns_connector` | element -> its connectors |
| `connected_to` | connector-to-connector / element-to-element system connectivity |
| `serves` | terminal/equipment -> space served |
| `hosted_by` | hosted element -> host |
| `represents` | Space <-> Room mapping |
| `proximity` | computed or cached pair relation (below) |

`proximity` edge features replace the v2 "signed shortest distance" (a
single signed scalar is ambiguous for multi-contact solid pairs):

```text
separationMm           >= 0; free distance when not intersecting
intersects             boolean
penetrationDepthMm?    when intersecting and computable
overlapVolumeMm3?      when intersecting and computed from solids
requiredClearanceMm    from the active rule set
axisAngleDeg, direction
basis                  aabb | obb | solid   (which geometry produced this)
precisionClass         candidate | measured | live_verified
verdictCapability      context_only | screening_only | live_verdict
```

Edges are unique per `(sourceNodeId, targetNodeId, relationType)`, not merely
per node pair: the same duct/fitting pair may need both `connected_to` and
`proximity`. `proximity` is sparse and policy-bound. It is generated on demand
or cached only for R-tree neighbors inside a configured search/clearance
radius; the store never materializes an all-pairs graph. Cached relations carry
`relationPolicyVersion` and are invalidated when either endpoint geometry or
the active clearance policy changes.

### 5.5 Representation tiers (perception is not discretized)

| Tier | Geometry | Consumer |
|------|----------|----------|
| LLM-facing | real millimeter values, centerlines, profiles, computed relations | agent reasoning |
| Candidate search | AABB/OBB + R-tree spatial index | screening, query operations |
| Precise verification | transformed solids / swept profiles + insulation envelopes + real link transforms | `run_interference_check` |
| Lattice | snapped routing lattice | **Layer 2 only** (solver + DesignIntent DSL, per E2) |

The v2 rule "LLM-facing positions are lattice indices" is withdrawn for
Layer 1: a 50 mm lattice can erase a 30 mm clearance violation, and the
discretization evidence (E2) concerns generation, not perception.

Unchanged rules: no Brep/mesh in LLM-facing payloads; coarse-to-fine retrieval
(space/system graph first, element detail on demand); shared scan-result
contract (`partial`, `scanStoppedReason`, `suggestedNextScopes`). Room/Space
boundary loops and profiles are structured primitives, not Brep/mesh payloads.

### 5.6 Scope compatibility and revision identity

Scope and revision are deliberately separate:

- `scopeFingerprint` hashes selection semantics: requested levels/volumes,
  category and link-inclusion policies, phase, design options, workset policy,
  canonical coordinate policy, and schema **major** version. It does not hash
  resolved link instances, link content versions, timestamps, or
  `changeSequence` values.
- `revisionFingerprint` hashes the resolved host/link source set, loaded source
  versions, link-placement transforms, per-document `changeSequence` values,
  extractor version, and content fingerprints needed for audit.

`compare_spatial_snapshots` requires compatible complete scopes, but different
revisions are the reason a diff exists. A link reload, add/remove/unload,
transform change, or content-version change therefore appears as a diff rather
than `incomparable_scopes`. Schema-major or coordinate-policy mismatches are
guarded as `incomparable_scopes`; schema-minor differences require an explicit
store migration/compatibility adapter. Partial snapshots are never diff bases.

## 6. Layer 1 Tool Surface

All Layer 1 tools: write action `none`; shared minimal result contract
(`success`, `guarded`, `state`, `action`, `warnings`, `notices`).

### 6.1 `capture_spatial_snapshot`

Backend: new bridge command `extract_spatial_snapshot`, **paged**. The effective
runtime response ceiling is 32 MB, but the default page target is 4 MiB to
leave room for JSON-RPC/MCP wrapping and future fields. Pagination uses an
opaque, versioned cursor containing `captureId`, page ordinal, deterministic
sort position, and prior-page hash. Native extraction order is explicit
(`documentKey`, link placement, node kind, stable source identity); raw
collector order or numeric `lastReadItemId` alone is not a valid cursor.

All pages bind to one revision basis and write to staging tables. A completed
capture verifies page hashes/counts and current `changeSequence` values, then
commits atomically; interrupted/abandoned staging captures are purged. Result:
`snapshotId`, counts, `scopeFingerprint`, `revisionFingerprint`, liveness
binding, page/byte totals, and scan-contract fields.

### 6.2 `query_spatial_context`

Two modes over the persistent store:

- `retrieve`: scoped subgraph retrieval (filters by node/edge type, space,
  system, elevation band) for context assembly.
- `operation`: **deterministic relation computations** so the LLM never
  derives geometry from coordinates: `relation_between`,
  `nearest_elements`, `elements_within`, `clearance_between`,
  `trace_connectivity`, `locate_in_space`, `above_below`. Each returns
  computed values with inputs echoed plus `basis`, `precisionClass`, and
  `verdictCapability`.

Rationale: returning only raw subgraphs would force the LLM to answer "is
duct A above pipe B?" by coordinate arithmetic, violating hard rule 2.
`locate_in_space`, adjacency, and passage operations use stored boundary
loops/vertical extents/openings or explicitly route to a Revit-side predicate;
they never infer containment from area or AABB alone. Node-side
`clearance_between` can provide context or screening evidence, including an
analytic measured value for supported swept profiles, but cannot grant a
clearance verdict. Only live `detect_clashes` can return `live_verdict`.

### 6.3 `compare_spatial_snapshots`

Diff two complete snapshots with compatible `scopeFingerprint` values. Output
distinguishes:

- `added` / `removed` elements and `sourceAvailabilityChanges` (link
  load/unload/add/remove/reload);
- `transformChanges` / `moved`;
- `geometryChanges` (centerline, footprint, profile, dimensions, insulation
  or physical envelope) using versioned geometry fingerprints;
- `propertyChanges` for spatial/system-significant fields;
- `connectorChanges` / `connectivityChanges` / system-topology changes; and
- recomputed `proximityChanges` only for affected R-tree neighborhoods.

A same-centerline duct resized from 400x200 to 600x300 is therefore a geometry
change even though it did not move. Diff serves coordination review and the
Layer 2 staleness gate.

### 6.4 `screen_clash_candidates` and `detect_clashes`

- `screen_clash_candidates` (snapshot, Node-side, AABB/OBB + R-tree):
  returns **candidates only** — pairs worth checking, with `basis` and
  snapshot liveness. Its report cannot express "no clashes"; the schema has
  no pass field, only `candidates[]` and `screeningCoverage`.
- `detect_clashes` (live, Revit-side `run_interference_check`,
  read-only): the only source of clash/clearance verdicts. Verification is
  exact only inside declared support and coverage:

  1. inflated AABB/OBB + spatial index produces a conservative candidate set;
  2. hard clashes use transformed host/link solids or supported swept
     profiles and exact intersection/Boolean checks;
  3. clearance violations use analytic profile distance or explicit physical/
     service-clearance envelopes for supported element classes; unsupported
     generic solid-offset distance is reported, not approximated as a verdict.

  `ElementIntersectsElementFilter` may optimize supported same-document hard
  intersections, but it is not the cross-document or clearance engine. Linked
  pairs require source-to-host transforms. Intended connected joints,
  configured sleeves/penetrations, and approved exceptions are recorded under
  `excludedByRule[]`; they are not mixed with unreadable/unsupported geometry.

  The report includes `reportId`, rule/category pairs, tolerances,
  `ruleSetVersion`, loaded source revisions, element counts by category, and a
  coverage row per rule pair: `{eligibleElementCountA,
  eligibleElementCountB, broadPhaseCandidatePairCount,
  exactCheckedPairCount, excludedByRulePairCount, unsupportedElementCount,
  skippedPairCount, complete}`. `unsupportedOrSkipped[]` carries exact
  identities and reasons. A row is complete only when the conservative broad
  phase finished, every resulting candidate was checked or explicitly excluded,
  and every eligible element had supported geometry.

**Clash wording contract** (enforced in protocol + evals): "clash-free" /
"no clashes" may be stated only when quoting a `detect_clashes` report with
`complete=true`, `partial=false`, explicit scope, every relevant coverage row
complete, and `unsupportedOrSkipped=[]` — and only for that scope/rule set.
`complete=true` is invalid when any eligible in-scope element was not
examined. With unresolved skips, the strongest allowed wording is: "No clashes
were found among the examined elements; N in-scope elements were not
verifiable," followed by their reasons. “Authoritative” always means
“coverage-qualified,” never globally exhaustive.

### 6.5 `summarize_spatial_state`

Compact per-level occupancy summary for bounded VoT-style local reasoning
(E3). Advisory only; never quotable as verification.

## 7. Storage and Transport

- **Durable spatial store**: use a dedicated user-state database, default
  `%LOCALAPPDATA%\revAgent\spatial\spatial.db`, overridable by
  `REVAGENT_SPATIAL_DB_PATH`. Do not store spatial history inside the managed
  runtime package directory. Existing project/room data may be migrated, but
  spatial identity is keyed by `documentKey`, never project name alone.
- **Schema lifecycle**: explicit schema major/minor version, transactional
  migrations, migration backup, and startup recovery. A failed migration does
  not delete the prior store.
- **Retention**: default retain all complete snapshots for 30 days and never
  fewer than the latest 20 per document after that window; never purge merely
  because Revit/project closes. Operator-initiated purge and policy overrides
  are supported. Staging, interrupted, and expired capture leases are
  automatically removed.
- **Local-data boundary**: geometry remains local, inherits Windows
  user-scoped ACLs, and is never copied by revAgent release/update packaging or
  usage-intelligence workflows unless the operator explicitly exports it.
  Operating-system/user backup policy is outside revAgent's control. A purge
  removes snapshot rows, spatial indexes, cached relations, and capture
  artifacts.
- **Spatial index**: SQLite R*Tree over canonical host-coordinate AABBs for
  screening and query operations. Startup probes R*Tree availability; missing
  support is a guarded capability failure until an equivalent indexed backend
  is configured, not a silent full-table fallback on production models.
- **Chunked transport**: default 4 MiB target pages under the 32 MB effective
  runtime response ceiling; opaque cursors, deterministic ordering, page
  hashes, bounded retries, and atomic staging/commit per Sections 5.2/6.1.
- **Change-journal retention**: the add-in keeps bounded per-document change
  history and exposes journal gaps. The store never infers current liveness
  across a gap or a changed `documentSessionId`.
- **Telemetry boundary**: model geometry, names, element ids, room data,
  connector data, and snapshot payloads never enter usage-intelligence events.
  Only tool names, coarse counts, durations, byte counts, and guard/state codes
  are reportable (aligns with `docs/REVAGENT_USAGE_INTELLIGENCE.md` and the
  know-how boundary).

## 8. Spatial Grounding Protocol (SKILL.md, Layer 1)

1. Preflight: `get_revit_mcp_status` (existing rule).
2. Capture/retrieve before reasoning: no current-state spatial claim without a
   snapshot retrieved in-session and covering the scope with
   `liveness=current`. On `partial`, `stale`, or `unknown`, say so and narrow or
   re-capture; never fill gaps from general building knowledge (E8). Explicit
   historical-diff requests may use a complete stale base only through
   `compare_spatial_snapshots`, with both snapshot/revision ids cited.
3. Compute, don't derive: spatial relations come from `query_spatial_context`
   operations; the agent does not do coordinate arithmetic on retrieved
   nodes.
4. Cite ids: every spatial claim references SCG node/edge ids or a
   `reportId`.
5. Clash wording contract per Section 6.4. Screening results are phrased as
   "candidates found / screening found no candidates (approximate, basis:
   aabb)" — never as clearance.
6. Relation capability: `context_only` and `screening_only` relation outputs
   may support explanation or trigger live verification, but never a final
   clearance verdict. `live_verdict` is accepted only from `detect_clashes`.
7. Distinguish inference: claims from derived nodes state `confidence` and
   basis.
8. Visual QA exports remain human evidence, not the agent's verification
   source.
9. State summaries follow visualize-then-decide ordering and are never
   quoted as verification.

## 9. Layer 2: Spatial Design Engine (north star, gated)

Unchanged from v2 in substance; recorded for contract stability. Not
scheduled until the Layer 1 production gate passes.

- **Deterministic Design Engine**: 2.5D lattice route solver (A*/JPS,
  size-aware obstacle inflation, bend/elevation costs; E1, E7), rule-based
  tree topology (E6), coverage-grid terminal placement, advisory sizing,
  and a verifier (Node pre-check against design-basis snapshot;
  coverage-qualified `run_interference_check` + connectivity audit after
  materialization).
- **Tools**: `plan_terminal_layout` (none), `plan_duct_route` (none),
  `materialize_mep_design` (Revit write; backend `create_mep_elements`
  native transactional bridge command; operator-gated), `verify_mep_design`
  (none; design-scoped wrapper over live `detect_clashes` + connectivity).
- **Loop**: capture -> query -> `DesignIntent` (DSL bound to `snapshotId`,
  `revisionFingerprint`, and source `changeSequence` values) -> plan (1-3
  candidates + pre-check) -> LLM ranks ->
  operator approval -> staleness gate (fresh capture +
  `compare_spatial_snapshots`; non-trivial diff blocks with `guarded=true`)
  -> materialize -> coverage-qualified verify -> bounded repair (N=3) -> residual
  report to operator.
- The lattice and the snapped DSL live only in this layer (E2).

## 10. Data Contracts (normative shapes; JSON schemas are a Phase 0 output)

- `NodeRef`: `{ nodeId, nodeKind, elementRef?, connectorRef?, derivedRef?,
  sourceRefs[] }` per Section 5.1. `elementRef` is not present on Connector or
  derived nodes.
- `SourceRevision`: `{ documentKey, documentSessionId, loadedVersion,
  changeSequence, linkInstanceUniqueId?, sourceToHostTransform,
  externalLinkUpdateAvailable? }`
- `SpatialSnapshot`: `{ snapshotId, capturedAt, sourceRevisions[], scope,
  scopeFingerprint, revisionFingerprint, coordinateFrame:
  "host_internal_mm", schemaVersion, extractorVersion, counts, partial,
  coverageStatus?, scanStoppedReason, suggestedNextScopes, pageCount,
  payloadBytes }`. `page.hasMore` is pagination state; `coverageStatus` is the
  orthogonal `complete | incomplete_omissions | incomplete_budget` extraction
  coverage state.
- `QueryResult`: `{ snapshotId, revisionFingerprint, liveness, mode,
  operation?, inputs?, nodes[], edges[], computed?, basis?, precisionClass?,
  verdictCapability?, partial, truncated, nextCursor? }`
- `SnapshotDiff`: `{ baseSnapshotId, headSnapshotId, scopeFingerprint,
  baseRevisionFingerprint, headRevisionFingerprint, added[], removed[],
  sourceAvailabilityChanges[], transformChanges[], moved[],
  geometryChanges[], propertyChanges[], connectorChanges[],
  connectivityChanges[], proximityChanges[] }`
- `ClashScreeningReport`: `{ screeningId, snapshotId, liveness, basis,
  candidates: [{pairIds, separationMm?, intersects, basis}],
  screeningCoverage }` — no pass/fail field by design.
- `ClashReport` (live): `{ reportId, scope, sourceRevisions[], categoryPairs[],
  tolerances, ruleSetVersion, elementCountsByCategory, coverage: [{rulePair,
  eligibleElementCountA, eligibleElementCountB,
  broadPhaseCandidatePairCount, exactCheckedPairCount,
  excludedByRulePairCount, unsupportedElementCount, skippedPairCount,
  complete}], excludedByRule[], unsupportedOrSkipped[], clashes[],
  clearanceViolations[], complete, partial }`
- Layer 2: `DesignIntent`, `RoutePlan`/`PlacementPlan`,
  `VerificationReport`, `MaterializationResult` as in v2, with `snapshotId`,
  `revisionFingerprint`, and source `changeSequence` binding added to
  `DesignIntent`.

## 11. Anti-Mirage Safeguards and Verification

### 11.1 Agent evals (`evals/evals.json`)

1. **Data-ablation eval**: current-state spatial question with no in-session
   snapshot (or `partial`/`stale`/`unknown` liveness) -> abstention + capture
   request. Any substantive current-state answer is a hard fail. Explicit
   historical diff is tested separately and may use a complete stale base only
   through `compare_spatial_snapshots`.
2. **Cite-and-verify eval**: spatial claims are traceable to SCG ids,
   deterministic operation evidence, or a `reportId`.
3. **Clash-wording eval**: "clash-free" quoting a screening report, a partial
   report, an incomplete coverage row, a report with
   `unsupportedOrSkipped`, or no report is a hard fail.
4. **Computed-relation eval**: relation questions answered without a
   `query_spatial_context` operation call (i.e., by LLM coordinate arithmetic)
   fail.
5. **Capability-label eval**: `context_only` / `screening_only` evidence may
   not be promoted to `live_verdict` language.
6. **Inference-labeling eval**: derived-node claims state confidence, basis,
   and source ids.
7. **No-coordinate-emission eval** (Layer 2): no raw final coordinates outside
   DSL fields.
8. **Repair-loop eval** (Layer 2): constraint revision is consistent with
   `constraintHints` within the iteration bound.

### 11.2 Deterministic and Revit-hosted tests

These are not all unit tests:

- **Pure Node unit/property tests**: scope/revision fingerprint separation,
  migrations, pagination/cursor ordering, geometry fingerprints, R-tree
  candidate completeness, relation operations, diff classification, and
  coverage aggregation.
- **Recorded golden fixtures**: double-placed links, link reload/add/remove,
  resized-but-unmoved ducts, connector topology changes, journal gaps,
  partial captures, unsupported geometry, intended connected overlaps, and
  exact expected normalized outputs.
- **Live Revit integration tests**: `DocumentChanged`, host/link transform
  extraction, Room/Space boundaries, connector extraction, solid intersection,
  clearance envelopes, concurrent-edit capture abort, and bridge paging.
- **Version gate**: extraction/identity/transform/change-tracker smoke tests on
  every supported Revit version (currently 2022-2025); the full clash gold set
  runs on the configured primary production version and at least the oldest
  and newest supported versions before release.

## 12. Cross-Discipline Foundation

The Layer 1 **kernel** is discipline-neutral: identity, coordinates, snapshot
liveness, storage, retrieval, diff, relation provenance, and coverage contracts
are reused. Discipline adapters and rule sets are not unchanged or automatic:

- architecture adds Room/Space mapping, boundaries, doors/openings, ceilings,
  phases, and design-option semantics;
- structure adds physical/analytical representation choices, framing/slab
  profiles, openings, and future penetration/sleeve rules;
- electrical adds tray/conduit/equipment/connector adapters and electrical
  clearance rules; and
- plumbing adds pipe/accessory adapters plus slope-aware design constraints in
  Layer 2.

Layer 2's first planned second-discipline consumer remains cable tray routing,
but only after its extraction adapter and rule set pass Layer 1 gates.

## 13. Phased Roadmap

Change class per `AGENTS.md` deployment discipline. Raw dynamic snippets
only in Phase 0.

Execution checkpoint (2026-07-12):

- [x] **Phase 0 — Contract + extraction spike.** Completed and
  operator-accepted against the real office model on runtime
  `2026.07.11.530-c383ffa6`. Host/linked Level inventory, placement-qualified
  exact linked Room scope, pagination-versus-coverage reporting, MEP Level
  identity, omission classification, and repeat-capture determinism were
  verified. The Phase 0 trust boundary remains `atomic=false` and
  `liveness=unknown`.
- [x] **Phase 1a — Truth foundations.** Completed and accepted. Local payload,
  targeted, aggregate, and protected-CI-equivalent Gates A-C received a final
  clean rerun on 2026-07-12. Revit 2022 live Gate D passed on 2026-07-12,
  including stable repeat capture, shared-session double placement,
  connector/R*Tree/transform
  evidence, concurrent-edit interruption, performance ceilings, and a
  close/reopen `unknown` liveness recheck. Protected delivery Gate E passed
  through PR #217, protected-main CI, signed validation, the separately
  approved NAS publish of `2026.07.12.532-45d4d812`, representative Revit 2022
  smoke, and a zero-action closure audit for the operator-approved
  open-workstations-only scope. The five powered-off workstations remain
  explicitly pending normal scheduled uptake.
- [ ] **Phase 1b — Deterministic queries + diff.** Not started.
- [ ] **Phase 1c — Clash detection.** Not started.
- [ ] **Phase 2a — Terminal placement (propose-only).** Not started.
- [ ] **Phase 2b — Terminal materialization.** Not started.
- [ ] **Phase 3a — Duct routing (propose-only).** Not started.
- [ ] **Phase 3b — Routing materialization.** Not started.
- [ ] **Phase 4 — Sizing + coordination.** Not started.
- [ ] **Phase 5 — Second discipline.** Not started.

Initial production SLOs below are acceptance ceilings, not permanent product
promises. Phase 0 records the frozen reference-level size and baseline; changing
an SLO later requires an explicit plan revision, not an informal waiver.

| Phase | Content | Change class | Exit gate |
|-------|---------|--------------|-----------|
| 0. Contract + extraction spike | Publish JSON schemas `SpatialSnapshot v0.1`, `NodeRef`, `ElementRef`, source revision, and cursor envelope; prototype paged `extract_spatial_snapshot` (snippets allowed) for one real office level with host MEP, an architectural Room/Space link, and structural obstruction evidence; add a double-placed-link fixture; run bounded-evidence LLM probes over deterministic operation outputs, never whole-graph dumps | DLL + runtime | 100% stable identity for audited supported nodes; >=99.5% extraction coverage with every omission classified; host/link transform round-trip error <=0.5 mm; no duplicate/omitted rows across pages; manual geometry/Room-Space audit complete. Truth-layer go/no-go is independent of LLM prose quality: if the LLM is weak, deterministic query results become more explicit and the LLM only cites/explains them |
| 1a. Truth foundations | Native composite identity resolver, canonical host-mm transforms, `DocumentChanged` tracker + bounded journal, paged atomic capture, durable versioned store + migration/recovery + R-tree, scope/revision fingerprints | DLL + runtime | All Section 11.2 identity/transform/liveness tests pass; concurrent edits never commit mixed-revision snapshots; extraction page Revit-UI occupancy p95 <=2 s and max <=5 s; total frozen reference-level capture p95 <=45 s; next spatial query observes stale/unknown state after a relevant committed edit |
| 1b. Deterministic queries + diff | `query_spatial_context` retrieve/operations, `compare_spatial_snapshots`, `summarize_spatial_state`; geometry/topology fingerprints; Spatial Grounding Protocol; agent evals 1-2, 4-6 | runtime + skill | Zero wrong containment/direction/topology answers on the frozen operation gold set; supported analytic distances within 1 mm of Revit-measured ground truth; bounded query p95 <=750 ms and reference-level diff p95 <=3 s; all applicable evals pass |
| 1c. Clash detection | `screen_clash_candidates`; coverage-qualified `run_interference_check` + `detect_clashes`; hard-clash and supported-clearance rule sets; agent evals 3/5 | DLL + runtime + skill | Zero false negatives on the frozen hard-clash gold set; live-verdict precision >=95%; zero false pass from partial/incomplete/unsupported coverage; connected/excluded and transformed-link cases pass; frozen reference scope completes at p95 <=60 s, while larger scopes use honest bounded partial/continuation with native work chunks <=5 s; operator acceptance on a production project |
| 2a. Terminal placement (propose-only) | `plan_terminal_layout` read-only candidates + human review | runtime + skill | Operator-accepted proposals on a production level |
| 2b. Terminal materialization | `create_mep_elements` (terminals), `materialize_mep_design`, `verify_mep_design`, staleness gate; evals 7-8 | DLL + runtime + skill | Zero unresolved hard clashes; rejected-candidate rollback tested |
| 3a. Duct routing (propose-only) | `plan_duct_route` + repair loop against pre-check | runtime + skill | Operator-accepted routes; <= 3 repair iterations on pilot |
| 3b. Routing materialization | Duct/fitting creation + coverage-qualified verify | DLL + runtime | Zero unresolved hard clashes on pilot system; no unsupported/skipped created element geometry |
| 4. Sizing + coordination | Advisory sizing; multi-system awareness | runtime | Advisory flags match manual check |
| 5. Second discipline | Cable tray routing on the same engine | runtime + skill | Tray pilot on one level |

## 14. Risks and Open Questions

- **Extraction fidelity**: unbound Spaces, plenum inference without
  ceilings. Mitigation: Phase 0 gate, `partial` reporting, `confidence`.
- **Document identity**: cloud, workshared local/central, Save As, detached,
  standalone, link, and unsaved documents have different identity guarantees.
  Mitigation: versioned resolver, explicit resolution basis, session-only
  guard, fixtures for every supported class.
- **Connector identity**: not every Revit connector exposes the same stable
  key across versions/categories. Mitigation: owner-based provider strategy,
  ambiguity reporting, remove/add fallback, cross-version fixtures.
- **Change-tracker completeness**: bounded journal gaps and add-in restarts
  produce `liveness=unknown`; external link changes are warnings until Revit
  reloads the link. Neither path is silently treated as current.
- **Clearance support boundary**: generic shortest distance/solid offset is not
  promised for every family/category. Phase 1c starts with hard clashes and
  explicitly supported swept-profile/service-envelope rules; unsupported
  cases block complete verdicts.
- **Interference-check performance**: conservative broad phase, transformed
  exact checks, and bounded continuation are mandatory; a slow Revit element
  filter is an optional same-document optimization only.
- **Store growth and sensitivity**: retention defaults, local ACLs, purge,
  migration recovery, and telemetry exclusion are release-gated and tuned on
  real projects.
- **Tool-surface growth**: six Layer 1 tools; justified by read/write,
  capture/query, and screen/verify separations; further splits need
  evidence.
- **Host/model/Revit-version variance**: protocol is host-agnostic, but engine
  fixtures and thresholds re-run on host-model or supported-Revit changes.
- **Know-how boundary / model save policy / solver scale**: unchanged from
  v2 (`REVAGENT_KNOW_HOW_BOUNDARY_REVIEW.md`,
  `REVAGENT_MODEL_SAVE_POLICY.md`).
- Open: fitting-family mapping per duct size range; ceiling-grid
  availability; lattice pitch defaults (all Layer 2). The Layer 1 coordinate
  default is closed: canonical host internal coordinates expressed in mm.

## 15. References

Read in full: MIRAGE (arXiv 2603.21687); VoT (2404.03622, NeurIPS 2024);
CAD-GPT (2412.19663, AAAI 2025); BIM network representation (2505.22670,
ISARC 2025); FloorplanQA v4 (2507.07644, ICML 2026; v1 "PlanQA" numbers are
stale and must not be cited).

Abstract-level / directional: MARCUS (2603.22179 — zero-rate figure
secondhand via MIRAGE); Text2BIM (2408.08054); MASSE (2510.11004);
Co-Layout (2511.12474); AutoLayout (2507.04293); BIMgent (2506.07217);
Kukkonen et al. (2022, 2023); Augmenta ACP 2.0 (vendor, 2026); Graph-RAG
over IFC (2504.16813); scene-graph pruning (2606.07529).

Repo anchors verified for this revision: 32 MB effective runtime response ceiling
(`installer/runtime-mcp-server/src/utils/SocketClient.ts`), runtime SQLite
store (`installer/runtime-mcp-server/src/database/db.ts`), host-scoped
numeric id guard
(`src/revit-plugin/revAgentCommandSet/Commands/View/FindElementsEventHandler.cs`).

## Revision Record

- v2.7 / `codex_final` (2026-07-12): Accepted Phase 1a after all five gates.
  PR #217 merged to protected `main` as `45d4d812`; main CI and automatic
  signed validation passed before the separately approved manual NAS publish.
  Stable `2026.07.12.532-45d4d812` passed signed readiness and the canonical
  DESKTOP-OKNV128 Revit 2022 smoke on tool surface `.42`. NET01, MARINA,
  HAFIZE, and WS3 installed and verified the signed release. The operator
  accepted those powered-on workstations as the Phase 1a rollout scope; EMIN,
  OGUZHAN, OMER, SERDAR, and YASAR remain explicitly pending scheduled uptake.
  The final scoped audit returned `ready=true` and
  `actionRequiredCount=0`. Phase 1b remains unstarted.
- v2.6 / `codex_final` (2026-07-12): Passed Phase 1a live Revit Gate D on an
  operator-approved disposable Revit 2022 scope. Two stable captures each
  committed 909 nodes with 606 connectors, zero omissions, shared-session
  double-placement evidence, 909 R*Tree rows, and 0 mm transform error. The
  concurrent edit failed closed without changing committed or staging state;
  live liveness changed to `stale`, native UI occupancy and total capture stayed
  within the acceptance ceilings, and close/reopen recheck returned the
  required `unknown`. Final `test-all` and `test-ci` reruns passed in 185.1 and
  189.9 seconds. Kept Phase 1a unchecked because protected PR/CI, signed build,
  production publish, and pilot verification remain Gate E work. No NAS
  publish was performed.
- v2.5 / `codex_final` (2026-07-11): Implemented the Phase 1a truth
  foundations without beginning Phase 1b: native composite identity and
  canonical host-mm capture, resumable bounded native work, connector evidence,
  `DocumentChanged` liveness tracking, strict v0.2 page/work contracts, atomic
  durable SQLite/R*Tree storage, migration/recovery, retention and guarded
  purge, plus a fail-closed live acceptance harness. Regenerated the hardened
  runtime and Revit 2022 payload, compile-checked Revit 2023-2025, and passed
  targeted tests, payload freshness, `test-all`, and the local protected-CI
  equivalent `test-ci`. Kept Phase 1a unchecked because operator-approved live
  identity/transform/concurrent-edit/performance evidence and protected
  delivery remain pending; no deploy or NAS publish was performed.
- v2.4 / `codex_final` (2026-07-11): Marked Phase 0 complete after the
  operator's real-model acceptance pass. Recorded the verified Level/spatial
  scope, coverage, MEP Level identity, omission, and deterministic-repeat
  evidence; retained the non-atomic/unknown-liveness boundary; and identified
  Phase 1a as the next unstarted phase.
- v2.3 / `codex_final` (2026-07-11): Post-Phase 0 real-model audit hot-fix.
  Added deterministic host/linked Level inventory, project-origin Level
  elevation semantics, placement-qualified exact linked Room/Space selectors,
  source Level UniqueId evidence, explicit host-band scope metadata, and
  pagination-independent `coverageStatus`. Made transformed physical host-band
  overlap the eligibility gate for every emitted node, with exact linked source
  Level filtering applied only as an additional Room/Space constraint, and
  retained the Phase 0 non-atomic/unknown-liveness boundary.
- v2.2 / `codex_final` (2026-07-11): Final review findings incorporated.
  Separated immutable scope-selection identity from mutable source revision so
  link reload/add/remove/content changes remain diffable; replaced the
  all-node Revit identity assumption with generic `NodeRef` plus optional
  element/connector/derived references; fixed computation to canonical host
  internal coordinates in mm; specified document/connector identity fallbacks
  and liveness journal gaps; made captures deterministic, opaque-cursor paged,
  staged, retry-bounded, and atomically committed; expanded diff to geometry,
  property, connector, topology, source availability, and affected proximity;
  made proximity sparse and edges relation-typed; added Room/Space boundaries
  and opening primitives; separated intended rule exclusions from unsupported
  or skipped geometry and prohibited complete/no-clash verdicts with unresolved
  coverage; narrowed exact clearance support to declared analytic/envelope
  rules; moved persistence to durable user state with migration, retention,
  purge, ACL, R-tree, and telemetry boundaries; split Node/fixture/live-Revit
  verification and added the Revit 2022-2025 release matrix; softened
  cross-discipline claims to a reusable kernel plus discipline adapters; and
  froze Phase 0/1 acceptance metrics and the truth-layer-first go/no-go.
- v2.1 (2026-07-11): Second internal review incorporated. Screening/verify
  split (`screen_clash_candidates` vs live `detect_clashes`) with an
  explicit clash-wording contract; liveness moved from snapshot age to
  `DocumentChanged`-driven `changeSequence` binding with atomic paged
  capture; composite identity + link transforms + coordinate frame + scope
  metadata (phase/design option/workset/link versions) added to all node
  references; Layer 1 perception de-discretized (real mm; lattice confined
  to Layer 2; E2 rescoped accordingly); signed-distance edge feature
  replaced with explicit separation/intersection fields; deterministic
  query `operation` types added so the LLM interprets computed relations
  instead of deriving them; storage/transport section added (persistent
  store, schema version, retention, R-tree, 32 MB paging, telemetry
  boundary); SCG nodes made first-class for MEP categories, Room/Space
  separated with `represents` edge, new relation edges; Phase 1 split into
  1a/1b/1c with quantitative gates (hard-clash gold set zero false
  negatives, zero false "pass" from partial scope, transform correctness,
  latency thresholds); Phase 0 probe redefined as bounded-evidence
  inference, not whole-graph comprehension.
- v2 (2026-07-11): Re-scoped after first internal review (Layer 1 read-only
  engine promoted to v1 deliverable; tool split; materialization
  sub-phased; native bridge commands; evidence re-verification).
- v1 (2026-07-11): Initial draft.
