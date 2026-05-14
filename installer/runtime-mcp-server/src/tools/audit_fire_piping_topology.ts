// @ts-nocheck
import { z } from "zod";
import { createFirePipingTopologyAudit } from "../fire-piping/fireTopologyAudit.js";
import { formatJsonContent } from "../utils/revitToolHelpers.js";

export function registerAuditFirePipingTopologyTool(server) {
    server.tool("audit_fire_piping_topology", "Analyze a shared MEP connector graph JSON document for sprinkler and fire hose cabinet topology. Produces audit/schematic orientation, downstream counts, count-based sizing findings, reducer checks, missing hydraulic input reporting, and a solver adapter placeholder without modifying Revit.", {
        graph: z.any().optional().describe("Connector graph JSON object using schemaVersion mep.connector-graph.v1."),
        graphJson: z.string().optional().describe("Connector graph JSON string. Use this when passing the graph as serialized text."),
        sourceNodeIds: z.array(z.string()).optional().describe("Optional explicit source/riser node ids. When omitted, the audit classifies source/riser nodes from graph metadata and names."),
        includeSolverAdapter: z.boolean().optional().describe("Include the EPANET/WNTR/SprayHydraulic adapter placeholder. Defaults true."),
    }, async (args) => {
        try {
            let graph = args.graph;
            if (!graph && args.graphJson) {
                graph = JSON.parse(args.graphJson);
            }

            if (!graph || typeof graph !== "object") {
                return formatJsonContent({
                    success: false,
                    error: "Provide either graph or graphJson with a connector graph document.",
                });
            }

            const report = createFirePipingTopologyAudit(graph, {
                sourceNodeIds: args.sourceNodeIds,
                includeSolverAdapter: args.includeSolverAdapter,
            });

            return formatJsonContent({
                success: true,
                report,
            });
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
