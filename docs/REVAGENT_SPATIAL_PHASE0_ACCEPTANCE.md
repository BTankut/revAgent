# revAgent Spatial Context Engine — Phase 0 Acceptance

Status: implementation and evidence guide for Phase 0 only.

Normative plan: `docs/REVAGENT_SPATIAL_CONTEXT_ENGINE_PLAN.md` v2.3.
This document does not authorize or begin Phase 1a.

## Delivered surface

- JSON Schema draft 2020-12 contracts live under
  `installer/runtime-mcp-server/schemas/spatial/v0.1/` for `ElementRef`,
  `NodeRef`, `SourceRevision`, the opaque cursor envelope, and
  `SpatialSnapshot` schema version `0.1`.
- `extract_spatial_snapshot` is the dedicated read-only Revit bridge command.
- `capture_spatial_snapshot` is the runtime wrapper. One MCP call returns one
  native page. The runtime neither decodes the cursor nor combines pages.
- The default page target is 4 MiB and the hard Phase 0 page cap is 8 MiB,
  below the existing 32 MiB bridge response ceiling.
- Native page byte counts and hash chains use
  `canonical_ieee754_rows_utf8_v1`: typed strings plus normalized IEEE-754
  number bits make verification stable across JSON/.NET numeric formatting.
- The wrapper suppresses only the read-only extractor's per-page Revit status
  window so a cursor continuation cannot be blocked; normal Revit task history
  and runtime activity remain recorded.
- Native work defaults to 4.5 seconds per page and is explicitly bounded at
  25 seconds; the wrapper keeps transport headroom and caps timeout at 60
  seconds for scoped reference-model audits.
- The double-placed-link golden fixture and deterministic bounded-operation
  probes live under `installer/runtime-mcp-server/scripts/fixtures/spatial/`.
- `inspect_levels` is the read-only discovery surface for the required host
  Level scope and optional exact linked Room/Space Level selectors.
- `page.hasMore` reports pagination only. Additive `coverageStatus` reports
  `complete`, `incomplete_omissions`, or `incomplete_budget` independently.
- The runtime derives `coverageStatus` from older native pages that omit it.
  Because v0.1 schemas are strict, a new native page containing this field must
  ship with the matching runtime/schema bundle; it is not accepted by an old
  strict-schema consumer.
- Legacy `coverage.complete` is page-sensitive. It can be false on a paginated
  page while `coverageStatus` is `complete`; use `page.hasMore` and
  `coverageStatus` for their separate meanings.

## Phase 0 support boundary

The spike requires an explicit level scope and is read-only. Supported evidence
is deliberately narrow:

- host ducts, pipes, fittings, accessories, air terminals, and mechanical
  equipment;
- architectural Room/Space evidence in the selected host/link scope; and
- linked structural/architectural obstruction evidence for the selected level
  elevation band.

All coordinates are host internal coordinates expressed in millimetres.
Linked rows carry their link-instance placement identity and source-to-host
transform. Unsupported or unreadable eligible rows are reported as classified
omissions.

The explicit host Level creates a host-Z vertical band; it is not exact linked
Level membership. Optional placement-qualified `linkedSourceLevels` (or the
less-specific `linkedSourceLevelNames` convenience filter) narrows linked
Room/Space rows after the host band check. Linked obstruction rows deliberately
remain physical band-overlap evidence. Effective band bounds, filter mode, and
resolved linked Level refs are returned in `scope` and bound into the scope
fingerprint.

Every emitted supported node must have readable bounds that physically overlap
the transformed host-Z band. Source Level name/elevation never bypasses this
test; when bounds are unavailable, Level evidence can only reject a clearly
different band or produce a classified `scope_unresolved` omission.

Geometry Z values are absolute host-internal coordinates. Level-associated
Revit parameters may be relative to their resolved source Level and must not be
reported as interchangeable with absolute geometry Z.

Phase 0 is not a durable or current-state snapshot service. It has no
`DocumentChanged` journal, atomic staging store, R-tree, migration lifecycle,
query/diff service, or clash verdict. Successful pages therefore report the
Phase 0 non-atomic limitation and must not be used for a current-state or
clearance claim. Those guarantees belong to Phases 1a–1c.

## Deterministic gate

From `installer/runtime-mcp-server`:

```powershell
npm run build
node .\scripts\spatial-phase0-contract.test.mjs
```

The gate checks the published schemas, double-placement identity separation,
canonical ordering, page-chain integrity, duplicate/omission detection,
coverage accounting, transform round-trip tolerance, and bounded deterministic
operation evidence. It never sends a whole graph to an LLM.

## Live reference-level gate

Revit must be open with the refreshed Phase 0 commandset and a reference model
that contains host MEP, a loaded architectural Room/Space link, and linked
structural/architectural obstruction evidence. Choose one explicit level.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-spatial-phase0-live.ps1 `
  -LevelIds 1522955 `
  -PageTargetBytes 4194304 `
  -MaxElements 25000 `
  -MaxElapsedMs 25000 `
  -TimeoutMs 60000 `
  -ConfirmGeometryAudit `
  -ConfirmRoomSpaceAudit `
  -AuditObserver "<reviewer>"
```

Do not set the audit confirmation switches until an independent manual review
has compared sampled model geometry and Room/Space evidence against Revit.
The script:

1. calls `mcp_status` before every extraction page;
2. captures all pages twice and compares the stable node-id set;
3. writes the local-only raw audit, then independently recomputes every
   canonical page hash and byte count from the exact returned rows through
   `scripts/verify-spatial-phase0-pages.mjs`;
4. verifies page continuity, duplicate-free identity, classified omissions,
   at least 99.5% extraction coverage, and at most 0.5 mm transform round-trip
   error;
5. requires non-zero host-MEP, linked Room/Space, and linked-obstruction
   evidence; and
6. writes a compact acceptance record plus a separate local raw audit file.

The raw file is model-sensitive and defaults to
`%LOCALAPPDATA%\revAgent\spatial\phase0`. It must not be committed, packaged,
published, or sent to usage intelligence. The compact evidence contains only
coarse counts, hashes, durations, guard/state codes, and audit sign-off.

## Frozen reference-level baseline

This is the pre-hotfix `.40` Phase 0 baseline. It remains evidence for the
original extractor, but it does not requalify the `.41` hot-fix contract. The
`.41` live Revit smoke remains pending explicit operator approval; deterministic
contract, compile, and installer gates are the only checks authorized in this
PR until then.

The Phase 0 exit run was completed on 2026-07-11 against Autodesk's local
Revit 2022 sample `BIM_Projekt_Golden_Nugget-Gebaeudetechnik.rvt`, with its
architectural link loaded, at host level `HG_EG_FBOK` (Revit element id
`1522955`). The command above records the exact bounded settings used for this
larger reference scope. The acceptance gate captured the complete level twice;
its 92.8-second wall time includes both captures plus independent page-chain
verification and is not a single-capture production SLO.

| Baseline measure | Frozen result |
|------------------|---------------|
| Result | `passed` |
| Snapshot schema / coordinate frame | `0.1` / `host_internal_mm` |
| Pages per capture | 2 |
| Stable audited node identities | 3,162 (100%) |
| Classified omissions | 4 |
| Extraction coverage | 0.998737 (99.8737%) |
| Duplicate / cross-page omitted nodes | 0 / 0 |
| Canonical payload bytes | 7,685,052 |
| Source revisions / max transform round-trip error | 2 / 0.0 mm |
| Host MEP / linked Room-Space / linked obstruction evidence | 2,398 / 41 / 695 |
| Manual geometry / Room-Space audit | complete / complete |

The compact record is stored locally at
`%LOCALAPPDATA%\revAgent\spatial\phase0\phase0-live-evidence-latest.json`;
the model-sensitive raw pages remain in the adjacent local audit file and are
intentionally excluded from source control and release packages.

The built `.40` release-bundle runtime was also exercised against the same
open model through the public `capture_spatial_snapshot` MCP tool. Both pages
passed the runtime contract validator: page 0 returned 1,797 nodes and page 1
returned 1,365 nodes plus 4 classified omissions. The wrapper preserved the
same 3,162-node identity set, 7,685,052 canonical bytes, capture/scope/revision
identity, and exact prior-page hash chain, then finished with no active Revit
task. This was a local live qualification; it does not claim that `.40` was
installed or published.

## Phase 0 exit decision

Phase 0 is `go` only when all of these are true on the frozen reference level:

- audited supported node identities are 100% stable;
- extraction coverage is at least 99.5% and every omission is classified;
- host/link transform round-trip error is no more than 0.5 mm;
- pagination has zero duplicates and zero unaccounted cross-page missing rows;
- manual geometry and Room/Space audit is complete; and
- bounded deterministic operation probes are recorded.

LLM prose quality is not a truth-layer gate. Weak prose must lead to more
explicit deterministic operation outputs, not relaxed extraction criteria.
