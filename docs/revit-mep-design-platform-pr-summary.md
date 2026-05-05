# PR Summary: Revit MCP MEP Design Platform Foundation

## Runtime

- Added seven public write-plan/platform tools:
  - `analyze_mep_system`
  - `prepare_write_plan`
  - `preview_write_plan`
  - `commit_write_plan`
  - `verify_write_plan`
  - `get_workflow_state`
  - `clear_workflow_state`
- Added typed write-plan schema, validators, risk classifier, preview formatter, native executor client, and JSON-backed workflow state.
- Added office standards defaults and missing-standard gating.
- Added initial domain foundations for HVAC, hydronic, domestic water, sanitary/storm, fire/sprinkler, clash, and equipment.

## Plugin

- Added native `execute_write_plan` command in the plugin repo.
- Added ExternalEvent handler and deterministic executor.
- Implemented validate/preview/commit/verify modes.
- Implemented initial operation catalog for parameter writes, view operations, movement, placement, duct/pipe creation, duct/pipe resize, and native schedule create/update.
- Added native `commit_reroute` source delete/replacement support: validation requires a `sourceElementId`, commit deletes the source after creating replacement route segments, and verify confirms the source no longer exists.
- Added native `commit_reroute` reconnection support: source connector references are captured before deletion, replacement route segments are connected to each other, source neighbors are reconnected to route endpoints, and verify re-reads physical external connections while filtering system proxy references.
- Commit mode uses a transaction and rolls back on error; dynamic-host direct execution can use `SubTransaction` when the document is already modifiable.
- Plugin remote is archived/read-only, so plugin branch changes are exported in `docs/revit-mcp-plugin-native-write-plan-executor.patch`.

## Documentation

- Updated `SKILL.md` to version `0.5.0`.
- Updated README tool surface and write-plan direction.
- Added architecture and validation notes.

## Tests

- Runtime JS syntax check passed.
- Existing safe guard test passed.
- New write-plan schema/state/risk test passed.
- Plugin `Debug 2022|x64` build passed.
- Live Revit read-only connection passed on Revit `2022` build `22.0.2.392`.
- Updated local runtime `analyze_mep_system` read the active model without mutation.
- Native write-plan preview was live-tested through the registered runtime using direct assembly fallback because the open Revit process had not reloaded `execute_write_plan`; preview succeeded and did not mutate the sampled duct.
- Fixed the native write-plan command SDK/interface mismatch against the active add-in's `RevitMCPSDK` interface, packaged a compat command assembly, hot-registered it in the open Revit session, and live-tested normal socket `execute_write_plan` preview without direct assembly fallback.
- Added deterministic HVAC and hydronic calculation foundations with hand-check tests and missing office standard blockers.
- Added workflow eId hydration from stored mappings into preview/commit/verify plans, with a live read-only preview test resolving an eId to a real duct.
- Expanded native verifier readback coverage for parameter clear/set, type changes, duct/pipe resize, view hide/unhide, and target existence.
- Added calculation/issue foundations for domestic water, sanitary/storm, fire/sprinkler, clash, and equipment selection, with tests and runtime probe coverage.
- Added live-tested HVAC/hydronic connector graph summaries using `Connector.AllRefs`.
- Completed the live write acceptance test in user-approved disposable model `rme_advanced_sample_project - Kopya`: `prepare_write_plan -> preview_write_plan -> commit_write_plan -> verify_write_plan` set duct `392168` `Comments`, preview did not mutate, commit succeeded, verify succeeded, and final readback matched.
- Added deterministic rooted-tree network calculations for HVAC/hydronic branch flow aggregation and critical path/circuit selection, with tests and runtime examples.
- Added deterministic clash reroute preview foundation around rectangular obstacle envelopes, with added-length calculation, tests, and runtime example.
- Added weighted network shortest-path traversal, HVAC fan pressure basis, hydronic pump head basis, and reporting row/CSV foundations, with tests and runtime probes.
- Added targeted live connector pathfinding inputs for `analyze_mep_system`; read-only HVAC pathfinding was live-tested in the disposable model on duct `392168`.
- Added runtime report export handling for `export_boq_report` and `export_clash_report` write-plans; approved commits write CSV/JSON files with `mutateModel: false`.
- Added least-loss flow direction inference and hydronic critical-circuit balancing loss foundations, with tests and runtime examples.
- Added BOQ-only live Revit collectors and report row population; hydronic live probe returned pipe/fitting/equipment counts and total pipe length from the active test model.
- Added multi-candidate orthogonal reroute solver with clearance validation; runtime example selects a valid no-violation candidate.
- Added single-loop Hardy-Cross hydraulic balancing foundation with convergence/residual tests and runtime example.
- Added equipment schedule/report update proposal foundation that emits report rows and low-risk note update write-plan steps without replacing equipment.
- Added coupled multi-loop Hardy-Cross hydraulic balancing foundation with convergence/residual tests and runtime example.
- Added live hydronic pipe resistance sampling/calibration and hydraulic resistance report rows from Revit pipe length/diameter data.
- Added live HVAC/hydronic fitting/accessory/equipment local-loss parameter extraction and `local_loss` report rows; live probe returned HVAC `15` rows and hydronic `30` rows from the active test model.
- Added local-loss pressure summary rows and explicit fan/pump basis contribution from numeric local-loss pressure drops; live probe carried HVAC `0.903 Pa` into fan pressure basis and hydronic `8.926 kPa` into pump head basis.
- Added `localLossElementIds` targeted extraction input for known critical-path/circuit element sets; direct live targeted probe confirmed HVAC fitting `392203` and hydronic fitting `513769` pressure-drop values.
- Added `localLossFromNetworkPath` critical-path targeting foundation: the runtime reads all reachable connector path candidates, ranks by explicit local-loss pressure drop when numeric loss samples are available, falls back to maximum hop count otherwise, then re-runs local-loss extraction only against the selected path's element ids. Live Revit evidence used path `392199 -> 392203 -> 392200`, selected terminal `392200`, skipped the two duct targets, sampled fitting `392203`, and carried `0.903187266396887 Pa` from `Pressure Drop`.
- Consolidated the path-targeted local-loss workflow into a shared two-stage helper and added fake-executor test coverage for pathfinding read, candidate ranking read, and selected-path final read.
- Hardened targeted local-loss collection for longer critical paths: explicit target reads now scale the sample limit to cover the requested target id set up to a guarded cap and return `uninspectedTargetCount`, `truncatedBySampleLimit`, and `targetedReadComplete` for audit.
- Propagated targeted local-loss truncation into analysis-level warnings so incomplete candidate ranking or selected-path reads are visible without digging into raw Revit readback.
- Live-tested approved equipment schedule note execution on Mechanical Equipment `386031` through native preview/commit/verify/readback.
- Added native `create_schedule_or_update_schedule`, runtime validation/risk coverage, and live-tested approved schedule creation in the disposable model:
  - Schedule `Codex MEP Equipment Schedule 2026-05-05`
  - Element `1020916`
  - Fields `Family and Type`, `Mark`, `Level`
  - Native preview, commit, verify, and final readback all succeeded.
- Added native `commit_reroute`, runtime validation/risk coverage, and live-tested approved reroute geometry creation in the disposable model:
  - Created duct segments `1020923`, `1020925`, and `1020927`
  - Verifier matched `3` actual segments to `3` expected segments
  - Expected and actual total route length both `15.292563747898 ft`
  - Final readback confirmed all three ducts at `300 x 300 mm`.
- Added native reroute clearance verification against supplied `obstacleBoxes`, with approved live test:
  - Created duct segments `1020932` and `1020934`
  - Verifier matched `2` actual segments to `2` expected segments
  - Expected and actual total route length both `6.56167979002624 ft`
  - Clearance checks returned `clearanceViolationCount: 0` against the expanded obstacle box.
- Added native reroute source replacement/delete verification, with approved live test:
  - Disposable source duct `1020938` was created at `300 x 300 mm`
  - Commit plan `reroute-source-replace-1777962600000` deleted source `1020938` and created duct segments `1020941` and `1020943`
  - Verify matched `2` actual segments to `2` expected segments with total length `6.5616797899999995 ft`
  - Verify returned `clearanceViolationCount: 0` and `sourceReplacementCheck.exists: false`
  - Final readback confirmed both new ducts at `300 x 300 mm` and source `1020938` not found.
- Added native reroute reconnection verification, with approved live test:
  - Disposable connected duct chain created left neighbor `1020947`, source `1020949`, and right neighbor `1020951`
  - Commit plan `reroute-reconnect-1777965200000` deleted source `1020949`, created replacement ducts `1020954` and `1020956`, connected the route segments, and reconnected both source neighbors
  - Commit report returned `segmentConnectionCount: 1`, `sourceConnectionCount: 2`, and no reconnect failures
  - Verify returned `segmentConnectionCount: 1`, `externalConnectionCount: 2`, external refs to physical ducts `1020947` and `1020951`, `sourceReplacementCheck.exists: false`, and `success: true`
  - Final readback confirmed the two replacement ducts at `300 x 300 mm` with `openConnectorCount: 0`.
- Live-tested an orthogonal L-shaped reconnect route without adding a separate elbow fallback:
  - Connected chain left `1020958`, source `1020960`, right `1020962`
  - Commit plan `reroute-l-reconnect-1777967000000` deleted source `1020960` and created replacement ducts `1020965`, `1020967`, and `1020969`
  - Commit and verify both returned `segmentConnectionCount: 2`, `externalConnectionCount: 2`, `sourceReplacementCheck.exists: false`, and `success: true`
  - Final readback confirmed all three replacement ducts at `300 x 300 mm` with `openConnectorCount: 0`.

## Remaining Work

- Restart/reload Revit once to prove the on-disk compat command registry path loads `execute_write_plan` from a clean AppDomain.
- Expand engineering engines from path-targeted local-loss extraction/reporting/basis-contribution foundations to production-calibrated final sizing from complete critical-path local-loss datasets and broader production reroute fitting behavior.
