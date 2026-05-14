import { z } from "zod";
import { calculateSanitaryRainwater, createWriteBackPlan, } from "../calculations/sanitary-rainwater/calculator.js";
import { formatJsonContent, truncateText } from "../utils/revitToolHelpers.js";
export function registerCalculateSanitaryRainwaterFromGraphTool(server) {
    server.tool("calculate_sanitary_rainwater_from_graph", "Dry-run sanitary and rainwater pipe sizing from the shared MEP connector graph JSON without modifying Revit.", {
        graph: z.union([z.string(), z.record(z.any())]).describe("Connector graph JSON object or JSON string using schemaVersion mep.connector-graph.v1."),
        systemMode: z.enum(["auto", "sanitary", "rainwater"]).optional().describe("Limit calculation to one drainage family, or infer from graph system data."),
        tableConfig: z.any().optional().describe("Optional project-approved table config. If omitted, the bundled generic metric profile is used and reported as review-required."),
        respectExistingUpstreamDiameters: z.boolean().optional().describe("When true, downstream recommendations are not allowed below upstream existing pipe diameters. Defaults true."),
        includeWriteBackPlan: z.boolean().optional().describe("When true, include a dry-run diameter write-back plan based on the recommendations."),
        maxReturnedChars: z.number().int().positive().optional().describe("Maximum JSON characters returned to the model."),
    }, async (args) => {
        try {
            const report = calculateSanitaryRainwater(args.graph, {
                systemMode: args.systemMode || "auto",
                tableConfig: args.tableConfig,
                respectExistingUpstreamDiameters: args.respectExistingUpstreamDiameters,
            });
            const payload = args.includeWriteBackPlan
                ? { ...report, writeBackPlan: createWriteBackPlan(report) }
                : report;
            const serialized = JSON.stringify(payload, null, 2);
            const trimmed = truncateText(serialized, args.maxReturnedChars);
            if (trimmed.truncated) {
                return { content: [{ type: "text", text: trimmed.text }] };
            }
            return formatJsonContent(payload);
        }
        catch (error) {
            return formatJsonContent({
                schemaVersion: "sanitary-rainwater-sizing.v1",
                status: "fail",
                summary: {},
                recommendations: [],
                findings: [
                    {
                        severity: "error",
                        code: "calculation_exception",
                        message: error instanceof Error ? error.message : String(error),
                        nodeIds: [],
                        edgeIds: [],
                        connectorIds: [],
                    },
                ],
            });
        }
    });
}
