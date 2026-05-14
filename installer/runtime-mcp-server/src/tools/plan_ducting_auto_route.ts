import { z } from "zod";
import { planDuctingAutoRoute } from "../engineering/ducting/index.js";
import { formatJsonContent } from "../utils/revitToolHelpers.js";

const passthroughObject = z.record(z.any());

export function registerPlanDuctingAutoRouteTool(server) {
    server.tool("plan_ducting_auto_route", "Plan dry-run duct routes from source points to target points using a 3D obstacle-aware grid (A*). Supports multi-elevation routing with vertical risers when allowedElevationsMm contains more than one value. Produces routeCandidates that can be reviewed by evaluate_ducting_design. This tool never writes Revit elements.", {
        sources: z.array(passthroughObject).describe("Source records such as shafts, AHUs, main duct starts, or risers. Each record needs pointMm/location with x/y/z in mm."),
        targets: z.array(passthroughObject).describe("Target records such as VAV boxes, diffuser groups, or terminal connection points. Each record needs pointMm/location with x/y/z in mm."),
        obstacles: z.array(passthroughObject).optional().describe("Obstacle AABBs from spatial extraction. Each obstacle may provide aabbMm/aabb/min/max values in mm. Accepted formats: {aabbMm:{minX,minY,minZ,maxX,maxY,maxZ}}, {aabb_mm:{min:[x,y,z], max:[x,y,z]}}, or flat [minX,minY,minZ,maxX,maxY,maxZ]. Merged with spatialZone.obstacles by id (user-provided wins)."),
        spatialZone: passthroughObject.optional().describe("Optional spatial-zone-extract.v1 payload from references/patterns/spatial-zone-extract.cs. When provided, obstacles, allowedElevationsMm (derived from plenum_volumes z_min/z_max), and shaft summaries are wired automatically into the planner; user-supplied obstacles and allowedElevationsMm still override."),
        routingBounds: passthroughObject.optional().describe("Optional allowed routing AABB in mm. If omitted, bounds are inferred from sources, targets, and obstacles with margin."),
        routingElevationMm: z.number().optional().describe("Optional plenum routing elevation in mm. Used as the single allowed elevation when allowedElevationsMm is not supplied; endpoints are then snapped to it (warning emitted)."),
        allowedElevationsMm: z.array(z.number()).optional().describe("Optional list of allowed routing elevations in mm (plenum levels, raised-floor heights, intermediate riser stops). When two or more values are provided the planner generates vertical riser/drop segments using the grid Z-axis."),
        gridStepMm: z.number().positive().optional().describe("Horizontal search grid spacing in mm. Defaults to 600."),
        verticalStepMm: z.number().nonnegative().optional().describe("Vertical refinement step in mm when allowedElevationsMm is provided. When >0, intermediate Z stops between min and max allowed elevations are added at this spacing. Defaults to 0 (no refinement; only the supplied allowedElevationsMm are used)."),
        clearanceMm: z.number().nonnegative().optional().describe("Obstacle clearance expansion in mm. Defaults to 150."),
        ductHalfHeightMm: z.number().nonnegative().optional().describe("Half-height used for vertical obstacle clearance filtering in mm. Defaults to 150."),
        boundaryMarginMm: z.number().nonnegative().optional().describe("Inferred-boundary margin in mm. Defaults to four grid steps."),
        maxNodeExpansions: z.number().int().positive().optional().describe("Search cap for each source-target route. Defaults to 25000."),
        routeElbowPenalty: z.number().nonnegative().optional().describe("Score penalty per elbow. Defaults to 4."),
        riserPenalty: z.number().nonnegative().optional().describe("Extra cost added to each vertical Z move during A* search and to the final score (per riser segment, mm). Defaults to 0 (preserves legacy 2D behavior)."),
        allowDiagonal: z.boolean().optional().describe("When true, enables 8-way XY diagonals (45° elbows). Vertical moves remain pure-Z. Defaults to false."),
    }, async (args) => {
        return formatJsonContent(planDuctingAutoRoute(args));
    });
}
