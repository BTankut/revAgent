# Revit MEP Redesign Final Connector And Coordination Audit

Date: 2026-05-06

Document: `rme_advanced_sample_project_codex_restart_test.rvt`

Path: `C:\Users\BT\AppData\Local\Temp\revit-mcp-live-test\rme_advanced_sample_project_codex_restart_test.rvt`

## Current Saved State

```text
FINAL_SAVED_POST_ORPHAN_DELETE_AUDIT|modified=False|rooms=78|spaces=89|ceilings=43|ducts=205|ductConn=223/577|ductFittings=3|air=183/183|pipes=873|pipeConn=1205/1746|pipeFittings=439|spr=239/239|fireCabinets=6|deletedTargetStillExists=0
```

## Device Connector Result

| System endpoint | Result | Notes |
|---|---:|---|
| Air terminals | `183/183` connected | `MechanicalUtils.ConnectAirTerminalOnDuct` was used where stable. The last endpoint-aligned group was connected by direct terminal-to-duct-end connector `ConnectTo` after rollback tests. |
| Sprinklers | `239/239` connected | The remaining 14 heads were connected by direct sprinkler-to-pipe-end connector `ConnectTo` after rollback tests. |

## Coordination Result

```text
FINAL_COORDINATION_RECHECK|pipeDuctClashes=0|largePipeDuctClashes=0|ceilingHorizontalProblems=0|ceilingVerticalExpected=133|modified=False
COORD_LIGHT_AUDIT|modified=False|ducts=205|pipes=881|ceilings=43|pipeDuctBoxHits=0|pipeDuctLargeBoxHits=0|checkedPairs=180605|horizontalCurves=717|verticalCurves=368|horizontalCeilingBoxHits=0|verticalCeilingBoxHits=133
POST_DELETE_CEILING_AUDIT|modified=True|ceilings=43|curves=1085|horizontalCurves=716|verticalCurves=368|horizontalCeilingBoxHits=0|verticalCeilingBoxHits=133
POST_ORPHAN_DELETE_AUDIT|modified=True|ducts=205|supply=121|return=62|exhaust=22|ductConn=223/577|pipes=873|hydSup=132|hydRet=129|domCold=24|domHot=10|sanitary=18|vent=23|fireWet=537|pipeConn=1205/1746|air=183/183|spr=239/239|fireCabinets=6|pipeDuctBoxHits=0|largePipeDuctBoxHits=0|horizontalCeilingBoxHits=0|verticalCeilingBoxHits=133|horizontalCurves=709|verticalCurves=368|pipeOpen=541|pipeCoincidentPairs=49|pipeSameDir=49|pipeOpposite=0|pipeAngled=0|sameDirWithOpenOtherEnd=0
FINAL_PIPE_NORMALIZE_AUDIT|modified=True|ducts=205|ductFittings=3|pipes=870|pipeConn=1240/1740|pipeFittings=437|pipeOpen=500|air=183/183|spr=239/239|pipeCoincidentPairs=0|pipeSameDir=0|pipeOpposite=0|pipeAngled=0
FINAL_COORD_NORMALIZE_AUDIT|pipeDuctBoxHits=0|largePipeDuctBoxHits=0|horizontalCeilingBoxHits=0|verticalCeilingBoxHits=133|horizontalCurves=707|verticalCurves=368
FINAL_SAVED_STATE|modified=False|path=C:\Users\BT\AppData\Local\Temp\revit-mcp-live-test\rme_advanced_sample_project_codex_restart_test.rvt
```

After the orphan-stub, orphan-overlap, and native pipe-header normalization cleanups described below, the model was saved through Revit UI `Ctrl+S`; the final save audit returned `modified=False`.

## Preserved Architectural Basis

- Rooms: 78
- MEP spaces: 89
- Ceilings: 43
- Plumbing fixtures: 11
- Codex fire hose cabinets: 6 `DirectShape` elements in `Mechanical Equipment` named `Codex Fire Hose Cabinet 1..6`

## Remaining Engineering Limitation

The visible distribution geometry, outlet/device connector continuity, pipe-duct coordination, and suspended-ceiling horizontal coordination now pass the live audits. Full segment-to-segment connector/fitting continuity is still not complete:

- Duct connectors: `223/577` connected
- Pipe connectors: `1205/1746` connected
- Duct fittings: `3`
- Pipe fittings: `439`

An endpoint proximity audit found many unconnected duct and pipe segment ends at the same coordinate:

```text
OPEN_ENDPOINT_PROXIMITY|ductOpen=394|ductNearest01=45|ductNearest05=45|ductNearest20=45|ductNearest50=47|pipeOpen=1232|pipeNearest01=781|pipeNearest05=781|pipeNearest20=792|pipeNearest50=832
```

Further filtered endpoint work was applied after the initial report. Same-system, same-size, opposite-direction duct endpoints were connected directly; different-size opposite-direction duct endpoints were connected with transition fittings. Same-system, same-size, opposite-direction pipe endpoints were connected directly, and same-system, same-size angled pipe endpoints were connected with elbow fittings. The dynamic approach was only stable after excluding same-direction pairs; invalid same-direction pairs can still timeout during commit finalization.

The remaining single angled fire-pipe candidate was not a valid elbow target. Element `1024041` was a 23 mm long `Fire Protection Wet` pipe stub with `connectorCount=2` and `openConnectorCount=2`. It was removed through write-plan `c500f50e-c570-4554-8f79-229d871c1cd8` as a one-element critical `delete_elements` commit after preview. Revit also deleted dependent element `1024042`. Post-save verification:

```text
POST_DELETE_AUDIT|modified=True|ducts=205|supply=121|return=62|exhaust=22|ductConn=223/577|pipes=880|hydSup=133|hydRet=129|domCold=24|domHot=10|sanitary=18|vent=23|fireWet=543|pipeConn=1205/1760|air=183/183|spr=239/239|fireCabinets=6|pipeDuctBoxHits=0|largePipeDuctBoxHits=0|pipeOpen=555|pipeCoincidentPairs=54|pipeSameDir=54|pipeOpposite=0|pipeAngled=0
```

A second residual-overlap audit found five same-direction overlap pairs where at least one overlapping pipe had its opposite connector open. Seven fully orphan pipe elements were removed through write-plan `df2da867-38b2-4ddb-b23a-273978edea7f` after preview:

```text
deletedElementIds=1023005,1023006,1023068,1023069,1023306,1023307,1023334,1023335,1023824,1023825,1023852,1023853,1026824,1026825
```

The seven targeted pipe ids were `1023005`, `1023068`, `1023306`, `1023334`, `1023824`, `1023852`, and `1026824`; each target had `connectorCount=2` and `openConnectorCount=2`.

Residual endpoint/fitting limitation:

- No same-system coincident duct endpoint pairs remain in the final classification.
- Pipe residual coincident pairs are same-direction overlap/duplicate-like geometry, not valid direct fitting candidates.
- No opposite-direction or angled coincident pipe endpoint fitting candidates remain after the orphan cleanup.
- No remaining same-direction pipe overlap pair has an open opposite connector after orphan cleanup; the residual 49 pairs have connected opposite ends and require tee/header normalization, not deletion or simple endpoint stitching.

Rollback tee/header normalization probe:

```text
ROLLBACK_TEE_PROBE2|success=False|stage=tee|header=1022539|duplicate=1022601|newPipe=1029153|externalOwner=1027607|externalClass=Autodesk.Revit.DB.FamilyInstance|externalCategory=Pipe Fittings|mainConnectorCount=2|teeError=The owner should be (flex) duct or pipe. Parameter name: connector3
POST_ROLLBACK_TEE_PROBE_STATE|modified=False|pipe1022539=True|pipe1022601=True
```

The probe confirms that `PlumbingUtils.BreakCurve` can split the header in rollback, but `Document.Create.NewTeeFitting` cannot use a pipe-fitting connector as the branch connector. A production normalizer must therefore create or preserve a real branch pipe connector, replace/rewire the adjacent fitting when needed, and execute one tee/header normalization at a time with rollback preview and post-commit audits.

A follow-up rollback strategy tried to delete the duplicate pipe and existing elbow, then create the tee using the real downstream branch-pipe connector. That branch-pipe strategy timed out at the dynamic execution layer. The post-timeout audit confirmed the model was unchanged:

```text
POST_TIMEOUT_BRANCH_TEE_STATE|modified=False|1022539Exists=True|1022601Exists=True|1027607Exists=True|1022598Exists=True|air=183/183|spr=239/239
```

The remaining 49 connected overlap pairs were then resolved through the native typed `normalize_pipe_header_overlap` operation rather than raw dynamic commits. The command previews and commits one pair at a time, with rollback, for direct fitting-to-branch pipe tees, short pipe-offset branch tees, and orphan open fitting cleanup. Final audit after this native pass returned `pipeCoincidentPairs=0`, `pipeSameDir=0`, preserved `air=183/183` and `spr=239/239`, and preserved zero pipe/duct and horizontal-ceiling clashes.

## Objective Completion Audit

Objective restated as concrete deliverables:

1. Preserve/analyze the architectural basis: rooms, spaces, ceilings.
2. Draw/model ventilation, heating, cooling, sanitary, domestic water, sprinkler, and fire hose cabinet systems.
3. Keep terminal devices connected where applicable.
4. Run superposition/clash control and preserve minimum suspended-ceiling coordination.
5. Optimize residual overlapping/duplicate mechanical geometry enough for a real engineering model.

Live evidence after the native pipe-header normalization pass:

```text
BASIC_COMPLETION_AUDIT|modified=False|rooms=78|spaces=89|ceilings=43
SYSTEM_COMPLETION_AUDIT|ducts=205|ductConn=223/577|ductOpen=354|ductFittings=3|pipes=870|pipeConn=1240/1740|pipeOpen=500|pipeFittings=437
DEVICE_COMPLETION_AUDIT|air=183/183|sprinklers=239/239|plumbingFixtures=11|fireCabinets=6
DUCT_SYSTEM_GROUPS|Supply Air=121;Return Air=62;Exhaust Air=22
PIPE_SYSTEM_GROUPS|Hydronic Supply=132;Hydronic Return=129;Domestic Cold Water=24;Vent=23;Sanitary=16;Domestic Hot Water=10;Fire Protection Wet=536
COORD_COMPLETION_AUDIT|pipeDuctBoxHits=0|largePipeDuctBoxHits=0|horizontalCeilingBoxHits=0|verticalCeilingBoxHits=133|horizontalCurves=707|verticalCurves=368|minHorizontalMepToCeilingClearanceMm=176.7|clearanceSamples=913
RESIDUAL_COMPLETION_AUDIT|openPipeConnectors=500|openDuctConnectors=354|openPipeCoincidentPairs=2|openDuctCoincidentPairs=0|pipeOverlapAll=43|pipeOverlapConnected=0
```

Prompt-to-artifact checklist:

| Requirement | Evidence | Status |
|---|---|---|
| Architectural basis analyzed/preserved | `rooms=78`, `spaces=89`, `ceilings=43` | Pass |
| Ventilation modeled | `Supply Air=121`, `Return Air=62`, `Exhaust Air=22`, `air=183/183` | Pass for visual/device test; connector/fitting continuity still weak |
| Heating/cooling modeled | `Hydronic Supply=132`, `Hydronic Return=129` | Pass for routed hydronic distribution; 2 same-point different-size open end pairs remain |
| Sanitary and vent modeled | `Sanitary=16`, `Vent=23`, `plumbingFixtures=11` | Pass for routed plumbing basis |
| Domestic water modeled | `Domestic Cold Water=24`, `Domestic Hot Water=10` | Pass for routed domestic water basis |
| Sprinkler modeled | `Fire Protection Wet=536`, `sprinklers=239/239` | Pass for device connectivity; 43 residual same-line fire-pipe overlaps remain |
| Fire hose cabinets modeled | `fireCabinets=6` | Pass |
| Superposition/pipe-duct clash control | `pipeDuctBoxHits=0`, `largePipeDuctBoxHits=0` | Pass |
| Minimum suspended ceiling coordination | `horizontalCeilingBoxHits=0`, minimum horizontal MEP-to-ceiling clearance `176.7 mm`; vertical crossings counted as expected penetrations | Pass for horizontal ceiling coordination |
| Fully optimized real engineering geometry | `pipeOverlapConnected=0`, but `pipeOverlapAll=43`; `openPipeCoincidentPairs=2`; `ductConn=223/577`, `pipeConn=1240/1740` | Not complete |

Residual overlap clusters are all `Fire Protection Wet`, mostly same-line sprinkler branch manifolds. They are no longer the previously resolved connected same-direction open-end header overlaps; they are serial/collinear manifold overlaps where multiple sprinkler branch pipes share the same line and common node. This needs a separate native normalizer that converts star-like overlapping sprinkler branch manifolds into segmented headers with tee/fitting continuity, plus a reducing tee/transition normalizer for the two hydronic same-point different-size pairs:

```text
OPEN_PIPE_COINCIDENT|a=1021788|b=1021810|x=-11.777916|y=-18.000000|z=7.558962
OPEN_PIPE_COINCIDENT|a=1021794|b=1021816|x=-11.077916|y=-20.000000|z=7.308962
```

Completion status: not achieved for the full objective. The model is ready for realistic visual/coordination testing, but not yet a fully optimized engineering-grade connected/fitting-complete network.

## Application Lessons

1. Revit requests must be serialized behind a command gate with a visible busy state and heartbeat.
2. Long write batches should be split into small transactions with progress returned after each element or small group.
3. Dynamic execution should avoid blind connector/fitting batches; preflight should classify candidates as:
   - direct device-to-end connector,
   - device-to-duct/pipe curve,
   - endpoint-to-endpoint stitch,
   - fitting-required branch/takeoff.
4. Overlapping pipe-header normalization is a separate operation from endpoint stitching: it needs `PlumbingUtils.BreakCurve`, real pipe-owned tee branch connectors, fitting replacement/rewiring when the existing external connector belongs to `Pipe Fittings`, one-pair rollback preview before commit, and native timeout/failure recovery.
5. Any native executor should support rollback-tested preview, commit token, and clear failure recovery so Revit is not left in a modal or failure-processing state.
6. Device connector completion can be solved safely with direct connector `ConnectTo` when rollback confirms the exact candidate pair.

## Completion Decision

The model is ready for realistic visual and coordination testing of the current MEP design:

- air terminals connected,
- sprinklers connected,
- pipe-duct clash count zero,
- horizontal ceiling coordination clear,
- model saved and not modified.

The broader "fully engineered/fitting-complete network" goal remains open. The pipe same-direction header overlap blocker is resolved by native preview/commit workflow, but sprinkler branch manifold overlaps, two hydronic reducing-connection pairs, and broader duct/pipe segment fitting continuity still require follow-up native operations.
