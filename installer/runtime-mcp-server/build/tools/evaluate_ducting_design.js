import { z } from "zod";
import { evaluateDuctingProduction } from "../engineering/ducting/index.js";
import { formatJsonContent } from "../utils/revitToolHelpers.js";
const passthroughObject = z.record(z.any());
export function registerEvaluateDuctingDesignTool(server) {
    server.tool("evaluate_ducting_design", "Evaluate ducting production readiness from JSON inputs without writing to Revit. Covers air balance mapping, room airflow, diffuser selection/count, plenum validation, route scoring, connector graph validation, native sizing validation, and commit gating.", {
        workflowStage: z.enum(["dry-run", "preview", "validate", "commit", "report"]).optional().describe("Current workflow stage. This tool never writes Revit elements."),
        spaces: z.array(passthroughObject).optional().describe("Rooms or MEP spaces from spatial-zone extraction or schedules."),
        airBalanceRows: z.array(passthroughObject).optional().describe("Air balance schedule rows with supply/return/exhaust flow in L/s or m3/h."),
        diffuserCatalog: z.array(passthroughObject).optional().describe("Allowed diffuser types with system, min/max flow, and optional NC/throw data."),
        projectRules: passthroughObject.optional().describe("Project engineering rules such as maxDiffusersPerSpace, spacing, plenum height, route penalties, and sizing tolerances."),
        plenumVolumes: z.array(passthroughObject).optional().describe("Spatial foundation plenum volumes; graph/schema fields are consumed without mutation."),
        plenumObstacleIntersections: z.array(passthroughObject).optional().describe("Spatial foundation plenum obstacle intersections."),
        routeCandidates: z.array(passthroughObject).optional().describe("Dry-run route options with points/segments, review status, and clearance data."),
        connectorGraph: passthroughObject.optional().describe("Foundation connector graph JSON. The tool validates topology without changing the graph schema."),
        expectedNetworkNodeIds: z.array(z.string()).optional().describe("Expected graph node ids for the committed/reviewed duct network."),
        nativeSizing: z.union([passthroughObject, z.array(passthroughObject)]).optional().describe("Revit native sizing report or segment results."),
        commit: passthroughObject.optional().describe("Commit gate data; commit.approved=true is required only for workflowStage=commit."),
    }, async (args) => {
        return formatJsonContent(evaluateDuctingProduction(args));
    });
}
