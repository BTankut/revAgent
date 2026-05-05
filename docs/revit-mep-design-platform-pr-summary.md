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
- Implemented initial operation catalog for parameter writes, pin/unpin, delete, tag, copy, rotate, align, view operations, movement, placement, duct/pipe creation, duct/pipe resize, and native schedule create/update.
- Added native `commit_reroute` source delete/replacement support: validation requires a `sourceElementId`, commit deletes the source after creating replacement route segments, and verify confirms the source no longer exists.
- Added native `commit_reroute` reconnection support: source connector references are captured before deletion, replacement route segments are connected to each other, source neighbors are reconnected to route endpoints, and verify re-reads physical external connections while filtering system proxy references.
- Added native reroute fitting reference readback: reconnect verify now reports `routeFittingRefCount` and `routeFittingRefs` for duct/pipe fittings connected to replacement route segments.
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
- Expanded native verifier readback coverage for parameter set/clear/copy, type changes, duct/pipe resize, view hide/unhide, and target existence.
- Added calculation/issue foundations for domestic water, sanitary/storm, fire/sprinkler, clash, and equipment selection, with tests and runtime probe coverage.
- Added live-tested HVAC/hydronic connector graph summaries using `Connector.AllRefs`.
- Completed the live write acceptance test in user-approved disposable model `rme_advanced_sample_project - Kopya`: `prepare_write_plan -> preview_write_plan -> commit_write_plan -> verify_write_plan` set duct `392168` `Comments`, preview did not mutate, commit succeeded, verify succeeded, and final readback matched.
- Added deterministic rooted-tree network calculations for HVAC/hydronic branch flow aggregation and critical path/circuit selection, with tests and runtime examples.
- Added deterministic clash reroute preview foundation around rectangular obstacle envelopes, with added-length calculation, tests, and runtime example.
- Added weighted network shortest-path traversal, HVAC fan pressure basis, hydronic pump head basis, and reporting row/CSV foundations, with tests and runtime probes.
- Added targeted live connector pathfinding inputs for `analyze_mep_system`; read-only HVAC pathfinding was live-tested in the disposable model on duct `392168`.
- Added runtime report export handling for `export_boq_report` and `export_clash_report` write-plans; approved commits write CSV/JSON files with `mutateModel: false`, and report verification now re-checks file existence/content through the runtime executor instead of the native Revit executor.
- Added least-loss flow direction inference and hydronic critical-circuit balancing loss foundations, with tests and runtime examples.
- Added BOQ-only live Revit collectors and report row population; hydronic live probe returned pipe/fitting/equipment counts and total pipe length from the active test model.
- Added multi-candidate orthogonal reroute solver with clearance validation; runtime example selects a valid no-violation candidate.
- Added single-loop Hardy-Cross hydraulic balancing foundation with convergence/residual tests and runtime example.
- Added equipment schedule/report update proposal foundation that emits report rows and low-risk note update write-plan steps without replacing equipment.
- Added coupled multi-loop Hardy-Cross hydraulic balancing foundation with convergence/residual tests and runtime example.
- Added live hydronic pipe resistance sampling/calibration and hydraulic resistance report rows from Revit pipe length/diameter data.
- Added live HVAC/hydronic fitting/accessory/equipment local-loss parameter extraction and `local_loss` report rows; live probe returned HVAC `15` rows and hydronic `30` rows from the active test model.
- Added local-loss pressure summary rows and explicit fan/pump basis contribution from numeric local-loss pressure drops; live probe carried HVAC `0.903 Pa` into fan pressure basis and hydronic `8.926 kPa` into pump head basis.
- Added hydronic pipe resize proposal output that combines live pipe length/diameter samples, supplied design flows, office velocity/friction limits, and critical-circuit local-loss pressure context into auditable `hydronic_pipe_sizing_proposal` rows plus proposal-only `resize_pipe` write-plan steps.
- Live-tested the hydronic pipe resize proposal path read-only in the disposable model: collector returned pipe samples `513756`, `513770`, and `513840`; with test design flows and `4560 Pa` complete critical-circuit local-loss context, the first row proposed element `513756` from `150 mm` to `80 mm`, emitted `resize-pipe-513756`, kept `canCommit: false`, and final model counts stayed `488` pipes / `744` ducts.
- Connected the `localLossFromNetworkPath` hydronic branch to optional pipe resistance sampling, resistance calibration, and pipe resize proposal output; fake-executor coverage verifies the four read-only stages: pathfinding read, candidate local-loss ranking read, selected-path local-loss read, and pipe resistance read.
- Live-tested a smaller explicit critical-circuit micro-probe without mutation: pipe `513756` is connected to fitting `513769`, the targeted read returned `Pressure Drop = 193.936 Pa`, the proposal used path ids `[513756, 513769, 513637]`, emitted `resize-pipe-513756`, and kept `canCommit: false`.
- Added HVAC duct resize proposal output that combines live duct length/size samples, supplied design airflows, office equal-friction/velocity limits, and critical-path local-loss pressure context into `hvac_duct_sizing_proposal` rows plus proposal-only `resize_duct` write-plan steps.
- Live-tested the HVAC duct resize proposal micro-probe without mutation: path ids `[392199, 392203, 392200]` returned duct samples `392199` / `392200` and fitting `392203` `Pressure Drop = 0.903 Pa`; with test design flow `900 m3/h`, the first proposal emitted `resize-duct-392199`, kept `canCommit: false`, and final model counts stayed `744` ducts / `488` pipes.
- Added live Revit `Flow` parameter extraction into HVAC duct and hydronic pipe sizing samples. Duct flow converts internal ft3/s to m3/h and pipe flow converts internal ft3/s to L/s; collectors retain display text for audit.
- Live-tested model-flow-driven sizing without supplied design-flow maps: HVAC `ductSizingOnly` read 5 duct samples including duct `392168` `Flow = 350.0 L/s` / `1260 m3/h` and produced 5 proposal-only `resize_duct` rows; hydronic `hydraulicResistanceOnly` read 12 pipe samples including `513840` `Flow = 30.6 L/s` and produced 10 proposal-only `resize_pipe` rows. Both remained `canCommit: false`.
- Added `localLossElementIds` targeted extraction input for known critical-path/circuit element sets; direct live targeted probe confirmed HVAC fitting `392203` and hydronic fitting `513769` pressure-drop values.
- Added `localLossFromNetworkPath` critical-path targeting foundation: the runtime reads all reachable connector path candidates, ranks by explicit local-loss pressure drop when numeric loss samples are available, falls back to maximum hop count otherwise, then re-runs local-loss extraction only against the selected path's element ids. Live Revit evidence used path `392199 -> 392203 -> 392200`, selected terminal `392200`, skipped the two duct targets, sampled fitting `392203`, and carried `0.903187266396887 Pa` from `Pressure Drop`.
- Consolidated the path-targeted local-loss workflow into a shared two-stage helper and added fake-executor test coverage for pathfinding read, candidate ranking read, and selected-path final read.
- Hardened targeted local-loss collection for longer critical paths: explicit target reads now scale the sample limit to cover the requested target id set up to a guarded cap and return `uninspectedTargetCount`, `truncatedBySampleLimit`, and `targetedReadComplete` for audit.
- Propagated targeted local-loss truncation into analysis-level warnings so incomplete candidate ranking or selected-path reads are visible without digging into raw Revit readback.
- Added selected-path local-loss pressure consistency checks: summaries now compare the pressure used to rank the selected path against the final selected-path extraction total and warn on mismatch.
- Added `local_loss_selected_path_pressure_check` report rows/CSV output so selected-path pressure consistency is exported with other local-loss pressure audit rows.
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
- Added reroute fitting-reference verify readback in the plugin patch series; plugin `Debug 2022|x64` build passed and live read-only probe on L-shaped replacement ducts `1020965`, `1020967`, `1020969` returned `routeFittingRefCount: 0`, making the no-separate-fitting behavior explicit.
- Added native `pin_elements` / `unpin_elements`, runtime validation/risk coverage, native preview/commit/verify support, and live-tested reversible commit on duct `392168`: preview did not mutate, commit pinned, verify reported `actualPinned: true`, restore unpinned, and final pinned state returned to the original `false`.
- Strengthened native validator parity for parameter/type/view/move/place/resize operations and added operation-specific `copy_parameter_value` verifier readback.
- Live-tested native `clear_parameter` with approved plan `clear-parameter-live-1777980200006`: disposable duct `1021017` started with a `Comments` value, preview left it unchanged, commit cleared the value, native verify succeeded, cleanup deleted it, and final duct count returned to `744`.
- Live-tested native `copy_parameter_value` with approved plan `copy-parameter-live-1777980200007`: disposable source `1021019` and target `1021021` ducts started with different `Comments`, preview left the target unchanged, commit copied the source value, the new verifier matched expected/actual values, cleanup deleted both ducts, and final duct count returned to `744`.
- Live-tested native `change_type` on a disposable copy of duct `392168` with approved plan `change-type-live-1777975200001`: copied element `1020985` started at type `142427`, preview left it unchanged, commit changed it to valid alternate type `142426`, native verify matched expected/actual type id, cleanup deleted the copy, and final read-only check confirmed source duct `392168` stayed at type `142427`.
- Added native `delete_elements`, runtime validation/risk coverage, native preview/commit/verify support, and live-tested approved critical commit on disposable duct `1020971`: preview did not delete, commit returned `deletedElementCount: 1`, verify succeeded, and final readback returned `Element not found`.
- Added native `tag_elements`, runtime validation/risk coverage, native preview/commit/verify support, and live-tested approved commit plan `tag-elements-live-1777973200002`: preview did not mutate tag count, commit created duct tag `1020984` on source duct `392168` using duct tag type `102763`, verifier matched the tagged target and tag head point, cleanup deleted the tag, and final read-only check returned no recent `1020980+` tags.
- Added native `copy_elements`, runtime validation/risk coverage, native preview/commit/verify support, and live-tested approved commit plan `copy-elements-live-1777970200001`: source duct `392168` stayed in place, copy `1020974` was created, verifier confirmed the requested `2 m` translation, and cleanup deleted the copy.
- Added native `move_elements` operation-specific verifier readback for expected `LocationCurve` / `LocationPoint` geometry and live-tested approved plan `move-elements-live-1777981200001`: disposable duct `1021027` stayed fixed during preview, commit moved it `2 ft`, verifier matched the expected curve, cleanup deleted it, and duct count returned to `744`.
- Live-tested native `view_hide_elements` / `view_unhide_elements` with approved plan `view-hide-unhide-live-1777981200002`: disposable duct `1021029` stayed visible during hide preview, hide commit made `IsHidden(view 378466)` true, hide verify succeeded, unhide preview did not mutate, unhide commit restored hidden state to false, unhide verify succeeded, cleanup deleted it, and duct count returned to `744`.
- Added level-aware native `place_family_instance` execution with runtime reflection fallback for Revit 2022 method compatibility, post-create location correction, and symbol/level/location verifier readback. Live-tested approved plan `place-family-instance-live-1777981200005`: preview left mechanical equipment count at `47`, commit placed mechanical equipment `1021031` with family symbol `386027` on level `378117` at `82,168,10.668449717049469 ft`, verifier matched symbol/level/location, cleanup deleted it, and count returned to `47`.
- Strengthened direct `create_duct_run` / `create_pipe_run` preflight validation for required system/type/level ids and added native `typeId` alias support for direct run creation.
- Live-tested native `create_duct_run` with approved plan `create-duct-run-live-1777976200002`: preview left duct count at `744`, commit created duct `1020989` with type `142427`, length `5 ft`, width/height `0.984251968503937 ft`, native verify succeeded, cleanup deleted it, and final read-only check confirmed duct count restored to `744`.
- Live-tested native `resize_duct` with approved plan `resize-duct-live-1777977200001`: disposable duct `1020991` started at `0.984251968503937 x 0.984251968503937 ft`, preview left size unchanged, commit changed it to `1.31233595800525 x 0.820209973753281 ft`, verifier matched Width/Height internal values, cleanup deleted it, and final read-only check confirmed duct count restored to `744`.
- Live-tested native `create_pipe_run` with approved plan `create-pipe-run-live-1777979200001`: direct `Pipe.Create` probe created/deleted `1020995`, native preview left pipe count at `488`, commit created pipe `1021001` using `typeId` alias `142438`, readback matched length `5 ft` and diameter `0.492125984251969 ft`, native verify succeeded, cleanup deleted it, and final read-only check confirmed pipe count restored to `488`.
- Live-tested native `resize_pipe` with approved plan `resize-pipe-live-1777979200002`: disposable pipe `1021004` started at diameter `0.492125984251969 ft`, preview left diameter unchanged, commit changed it to `0.328083989501312 ft`, native verify matched the Diameter internal value, cleanup deleted it, and final read-only check confirmed pipe count restored to `488`.
- Live-tested native verification failure and rollback behavior: verify plan `verification-failure-live-1777978200001` intentionally expected wrong duct Width/Height, returned `success:false` with mismatch errors, and left source duct `392168` unchanged; rollback plan `rollback-live-1777978200002` created a duct then failed on a missing target, returned `success:false` / `Target element not found.`, and transaction rollback left duct count at `744` with no `1020990+` duct ids.
- Added native `rotate_elements`, runtime validation/risk coverage, native preview/commit/verify support, and live-tested approved commit plan `rotate-elements-live-1777971200002`: disposable duct `1020976` remained after preview, commit rotated it `90` degrees around the requested vertical axis, verifier matched expected `LocationCurve` endpoints, and cleanup deleted the duct.
- Added native `align_elements`, runtime validation/risk coverage, native preview/commit/verify support, and live-tested approved commit plan `align-elements-live-1777972200003`: disposable duct `1020981` remained fixed during preview, commit aligned it by the requested constrained x-axis translation, verifier matched expected `LocationCurve` endpoints with `0` internal start-point error, cleanup deleted the duct, and a final read-only check returned `exists: false`.
- Strengthened native `view_apply_overrides` validation and verifier readback for projection line color/weight, and live-tested approved commit plan `view-override-live-1777974200002` on duct `392168` in view `378466`: preview left overrides at `invalid;w=-1`, commit applied `255,0,0;w=5`, verifier matched color and line weight, restore returned the view override to `invalid;w=-1`, and final read-only check reported `restored: true`.
- Re-generated plugin patch artifact as `19/19` and verified it applies cleanly with `git am --3way` on a temporary plugin `main` worktree.

## Remaining Work

- Restart/reload Revit once to prove the on-disk compat command registry path loads `execute_write_plan` from a clean AppDomain.
- Continue expanding engineering engines from hydronic resize proposal foundations to production-calibrated final sizing from complete critical-path local-loss datasets and broader production reroute fitting behavior.
