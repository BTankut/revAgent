# Ducting Auto-Routing Plan

## Goal

Create a production-safe duct auto-routing foundation that turns reviewed source and target points into obstacle-aware route candidates before any Revit duct creation is allowed.

## Phase 1 in This Branch

- Add `plan_ducting_auto_route` as a read-only MCP runtime tool.
- Accept source points, target points, routing elevation, optional bounds, grid spacing, and spatial foundation obstacle AABBs.
- Generate orthogonal dry-run route candidates with length, elbow count, score, segments, and obstacle-intersection evidence.
- Support `routingMode=trunkAndBranch` for a shared main duct line plus terminal branches, with optional routing-zone/corridor AABBs and trunk axis overrides.
- Return route candidates in a shape that can be reviewed by `evaluate_ducting_design`.
- Keep `revitWriteAction=none`.

## Engineering Scope

- This is a planner, not a Revit writer.
- `pointToPoint` routes each target independently from the best source.
- `trunkAndBranch` generates a reviewable shared route tree: source feed, main trunk, and target branches.
- The route is projected to a single plenum elevation.
- Obstacles are checked as expanded AABBs using clearance and duct half-height.
- Fitting optimization, vertical riser/drop generation, native duct sizing, connected-network validation, and actual `Duct.Create` commit remain later gates.
- Routing zones/corridors are only used as corridor evidence for planner review in this branch; full spatial-zone/plenum validation is a separate production gate.

## Reference Basis

- `RevitAirflowDesigner`: route option workflow and duct creation concept.
- `OpenMEP`: duct/pipe creation and connector API patterns for the future write phase.
- Current spatial foundation snippets: obstacle AABB extraction and plenum validation.
- Current ducting evaluator: route candidate review and commit gate.

## Live Revit Preview

- A temporary Revit preview can draw the route tree as view detail elements.
- The preview is intentionally non-production: it creates no ducts, fittings, systems, connectors, or sizing changes.
- In the current color convention, the main trunk is magenta, branches are cyan, source/target markers are yellow, obstacle boxes are orange, and the routing boundary is blue.

## Next Phase

- Convert reviewed route trees into placeholder ducts behind an explicit write gate.
- Add a separate gated Revit write tool that creates placeholder ducts first.
- Re-export connector graph after write and require connected-network plus native sizing validation before production commit.
