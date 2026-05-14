import { z } from "zod";
import { planDuctingAutoRoute } from "../engineering/ducting/index.js";
import { formatJsonContent } from "../utils/revitToolHelpers.js";

const passthroughObject = z.record(z.any());

export function registerPlanDuctingAutoRouteTool(server) {
    server.tool("plan_ducting_auto_route", "Plan dry-run duct routes from source points to target points using an orthogonal obstacle-aware grid. Produces routeCandidates that can be reviewed by evaluate_ducting_design. This tool never writes Revit elements.", {
        sources: z.array(passthroughObject).describe("Source records such as shafts, AHUs, main duct starts, or risers. Each record needs pointMm/location with x/y/z in mm."),
        targets: z.array(passthroughObject).describe("Target records such as VAV boxes, diffuser groups, or terminal connection points. Each record needs pointMm/location with x/y/z in mm."),
        obstacles: z.array(passthroughObject).optional().describe("Obstacle AABBs from spatial extraction. Each obstacle may provide aabbMm/aabb/min/max values in mm."),
        routingMode: z.enum(["pointToPoint", "trunkAndBranch"]).optional().describe("pointToPoint keeps independent A* routes. trunkAndBranch creates a shared main trunk with terminal branches for review."),
        routingZones: z.array(passthroughObject).optional().describe("Optional spatial-zone/plenum AABBs used to pick the shared trunk corridor in trunkAndBranch mode."),
        routingCorridors: z.array(passthroughObject).optional().describe("Alias for routingZones; passable corridor/plenum AABBs from spatial extraction."),
        routingBounds: passthroughObject.optional().describe("Optional allowed routing AABB in mm. If omitted, bounds are inferred from sources, targets, and obstacles with margin."),
        routingElevationMm: z.number().optional().describe("Optional plenum routing elevation in mm. Endpoints are projected to this elevation in dry-run mode."),
        gridStepMm: z.number().positive().optional().describe("Search grid spacing in mm. Defaults to 600."),
        clearanceMm: z.number().nonnegative().optional().describe("Obstacle clearance expansion in mm. Defaults to 150."),
        ductHalfHeightMm: z.number().nonnegative().optional().describe("Half-height used for vertical obstacle clearance filtering in mm. Defaults to 150."),
        boundaryMarginMm: z.number().nonnegative().optional().describe("Inferred-boundary margin in mm. Defaults to four grid steps."),
        maxNodeExpansions: z.number().int().positive().optional().describe("Search cap for each source-target route. Defaults to 25000."),
        routeElbowPenalty: z.number().nonnegative().optional().describe("Score penalty per elbow. Defaults to 4."),
        trunkAxis: z.enum(["x", "y", "auto"]).optional().describe("Preferred shared trunk axis in trunkAndBranch mode. auto chooses the dominant routing extent."),
        trunkPositionMm: z.number().optional().describe("Optional fixed X/Y cross-axis coordinate for the shared trunk, depending on trunkAxis."),
    }, async (args) => {
        return formatJsonContent(planDuctingAutoRoute(args));
    });
}
