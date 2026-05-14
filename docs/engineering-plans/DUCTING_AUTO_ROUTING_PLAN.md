# Ducting Auto-Routing Plan

## Goal

Create a production-safe duct auto-routing foundation that turns reviewed source and target points into obstacle-aware route candidates before any Revit duct creation is allowed.

## Phase 1 in This Branch

- Add `plan_ducting_auto_route` as a read-only MCP runtime tool.
- Accept source points, target points, routing elevation, optional bounds, grid spacing, and spatial foundation obstacle AABBs.
- Generate orthogonal dry-run route candidates with length, elbow count, score, segments, and obstacle-intersection evidence.
- Return route candidates in a shape that can be reviewed by `evaluate_ducting_design`.
- Keep `revitWriteAction=none`.

## Engineering Scope

- This is a planner, not a Revit writer.
- The first solver routes each target independently from the best source.
- The route is projected to a single plenum elevation.
- Obstacles are checked as expanded AABBs using clearance and duct half-height.
- Trunk sharing, fitting optimization, vertical riser/drop generation, native duct sizing, and actual `Duct.Create` commit remain later gates.

## Reference Basis

- `RevitAirflowDesigner`: route option workflow and duct creation concept.
- `OpenMEP`: duct/pipe creation and connector API patterns for the future write phase.
- Current spatial foundation snippets: obstacle AABB extraction and plenum validation.
- Current ducting evaluator: route candidate review and commit gate.

## Next Phase

- Add route-tree optimization so shared trunks are preferred over independent branches.
- Add preview visualization through safe Revit model lines or temporary detail elements.
- Add a separate gated Revit write tool that creates placeholder ducts first.
- Re-export connector graph after write and require connected-network plus native sizing validation before production commit.
