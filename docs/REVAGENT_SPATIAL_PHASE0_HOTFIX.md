# revAgent Spatial Context Engine — Phase 0 Hot-fix

Status: implementation and review record for the post-Phase 0 real-model audit.

This package stays inside Phase 0. It improves read-only extraction, level
discovery, scope clarity, and coverage reporting. It does not start durable
capture, liveness tracking, query/diff, clash, clearance, or model-write work.

## Real-model evidence

The post-release audit exercised six ordinary operator workflows against the
open Revit 2022 sample model:

1. host ducts, pipes, and mechanical equipment on one explicit level;
2. linked Rooms on a host level band;
3. linked wall, floor, column, and ceiling obstruction evidence;
4. one known host duct compared through spatial extraction and targeted element
   inspection;
5. every classified omission on host level `1F`; and
6. two consecutive captures of the same `1F` scope.

Positive evidence:

- host/link element identity and full link-placement identity were preserved;
- geometry used `host_internal_mm` consistently;
- the extraction-page contract validated;
- opaque cursor behavior was correct;
- two consecutive `1F` captures had the same total node count, node-id set,
  category counts, and omission set;
- runtime status, UI protection, review-view cleanup, and parameter
  write/readback guards behaved as expected; and
- Phase 0 continued to report `atomic=false` and `liveness=unknown`.

The `1F` omission audit returned 1,992 nodes and 20 classified omissions. A
separate read-only Revit API check confirmed that the omitted Room had no
level, location, bounding box, area, or boundary and that the 19 omitted Spaces
were level-assigned but had zero area, no bounding box, and no readable boundary
loops. No normal boundary-readable element was found among those omissions.
The resulting coverage was 1,992 / 2,012 = 0.99006, so that model scope did not
meet the Phase 0 0.995 acceptance threshold even though omission reporting was
correct.

## Hot-fix changes

### Source level identity

Spatial level resolution now keeps `Element.LevelId` as its first choice, then
uses `MEPCurve.ReferenceLevel` and stable built-in level parameters. This fixes
host duct/pipe nodes whose targeted inspection resolves a Reference Level while
the previous spatial `levelRef` was null.

Every resolved node or element omission also carries
`levelRef.sourceLevelUniqueId`. Numeric Level ids are document-local and must
not be used across linked documents without link-placement identity.

### Canonical level elevations

Host-Z level bands use `Level.ProjectElevation`, with `Level.Elevation` retained
only as a compatibility fallback. `ProjectElevation` is tied to the project
origin and therefore matches the `host_internal_mm` contract independently of a
Level type's displayed Elevation Base.

Spatial geometry coordinates are absolute host-internal coordinates. Revit
parameters such as duct middle elevation may be level-relative. A parameter
value and a geometry Z value therefore must not be substituted for one another
without adding the resolved level's project elevation and checking the
parameter definition.

### Level inventory and linked Room/Space scope

`inspect_levels` supplies deterministic host and loaded-link level inventory,
including document/link identity, Level id/UniqueId/name, source project
elevation, transformed host elevation, and a copy-ready placement-qualified
selector.

`capture_spatial_snapshot` still requires an explicit host level. That host
scope is a host-Z vertical band, not exact linked-level membership. Callers that
need exact linked Room/Space membership can additionally pass:

```json
{
  "linkedSourceLevels": [
    {
      "linkInstanceUniqueId": "<RevitLinkInstance UniqueId>",
      "levelUniqueId": "<linked Level UniqueId>"
    }
  ]
}
```

`linkedSourceLevelNames` remains a case-insensitive convenience filter across
the selected links. Placement-qualified selectors are the auditable path.
Every requested selector must resolve; otherwise the call is guarded with
`needs_scope`. The exact filter applies only to linked Room/Space rows. Linked
obstructions remain selected by transformed physical host-band overlap so a
column, wall, or slab crossing the level is not lost because of its source host
level.

Every emitted host MEP, linked Room/Space, and linked obstruction node must
have a readable bounding box whose transformed host-Z extent overlaps that
band. Source Level name/elevation is identity and fallback scope evidence; it
never bypasses physical overlap. If bounds are unreadable, an in-band source
Level produces a classified `scope_unresolved` omission rather than a node.

### Pagination versus extraction coverage

`page.hasMore` answers only whether another page must be requested.
`coverageStatus` independently reports extraction coverage:

- `complete`: no eligible element/source omission and no extraction budget stop;
- `incomplete_omissions`: all candidates were evaluated but classified
  element/source omissions remain; or
- `incomplete_budget`: `max_elapsed` or `max_items` stopped extraction work.

The existing `partial` and canonical `scanStoppedReason` meanings remain
unchanged for consumers. The wrapper also accepts older native pages without
`coverageStatus` and derives it from stop/omission evidence. However, strict
older v0.1 schema consumers use `additionalProperties=false`, so the new field
requires a matched runtime/schema/native bundle rather than a mixed-version
wire contract. Therefore Test 5 is represented as:

```json
{
  "page": { "hasMore": false },
  "coverageStatus": "incomplete_omissions",
  "partial": true,
  "scanStoppedReason": "read_failed"
}
```

Here `read_failed` is the existing aggregate coverage-gap code; it does not mean
that pagination stopped or that every omission threw a Revit API exception.
Legacy `coverage.complete` remains page-sensitive and can be false while more
pages exist even when `coverageStatus="complete"`; consumers must use
`page.hasMore` for pagination and `coverageStatus` for extraction coverage.

## Follow-up finding outside the spatial PR

The `set_schedule_cells` dry-run result can report `changed=true` and
`wouldChangeCount=1` while leaving `after` equal to the old value. That is a
schedule write-preview contract defect, but it is unrelated to the spatial
Phase 0 truth layer. The separate follow-up keeps those legacy fields for
compatibility and adds explicit `actualAfter`, `projectedAfter`, `wouldChange`,
and basis metadata so consumers do not confuse observed model state with the
dry-run projection.

Clearing a non-shared string parameter to a visibly empty string while
`HasValue=true` is expected Revit behavior and remains correctly reported as
`visible_empty_has_value`.

## Validation boundary

This PR may run deterministic contract tests, runtime smoke tests, installer
gates, and Revit 2022–2025 compile checks without opening Revit. A live Revit
smoke is intentionally not run until the operator explicitly approves it.
