import { readFile } from "node:fs/promises";
import { z } from "zod";
import { analyzeHydronicPipingGraph } from "../engineering/hydronic/hydronicAnalysis.js";
import { formatJsonContent } from "../utils/revitToolHelpers.js";
function parseGraphInput(args) {
    if (args.graph) {
        return typeof args.graph === "string" ? JSON.parse(args.graph) : args.graph;
    }
    if (args.graphJson) {
        return JSON.parse(args.graphJson);
    }
    return null;
}
export function registerAnalyzeHydronicPipingGraphTool(server) {
    server.tool("analyze_hydronic_piping_graph", "Dry-run hydronic piping analysis from a shared connector graph JSON object or file. Calculates segment flow, velocity, pressure drop, critical path, pump head, and balancing valve delta-P without writing to Revit.", {
        graph: z.any().optional().describe("Connector graph object following the foundation graph contract. The analyzer consumes it without changing the schema."),
        graphJson: z.string().optional().describe("Connector graph JSON text. Use this when passing raw JSON instead of an object."),
        graphFilePath: z.string().optional().describe("Local path to connector graph JSON. The file is read only; no Revit write-back is performed."),
        calculationMethod: z.enum(["darcy_weisbach", "hazen_williams"]).optional().describe("Pressure loss method. Defaults to darcy_weisbach."),
        defaultFluidDensityKgM3: z.number().positive().optional().describe("Fluid density used for head and Darcy/local losses. Defaults to 998.2 kg/m3."),
        defaultDynamicViscosityPaS: z.number().positive().optional().describe("Dynamic viscosity for Darcy-Weisbach Reynolds/friction calculation. Defaults to 0.001002 Pa.s."),
        defaultRoughnessMm: z.number().nonnegative().optional().describe("Default pipe roughness for Darcy-Weisbach when segment roughness is missing. Defaults to 0.0015 mm."),
        defaultHazenWilliamsC: z.number().positive().optional().describe("Default Hazen-Williams C value. Defaults to 140."),
        designPressureReservePa: z.number().nonnegative().optional().describe("Optional reserve added to critical path pressure before pump head reporting. Defaults to 0 Pa."),
        pumpHeadSafetyFactor: z.number().positive().optional().describe("Optional multiplier for pump head reporting. Defaults to 1.0."),
        maxPaths: z.number().int().positive().max(50000).optional().describe("Maximum candidate paths to evaluate. Defaults to 5000."),
        startNodeIds: z.array(z.string()).optional().describe("Optional explicit pump/source node ids for critical path search."),
        endNodeIds: z.array(z.string()).optional().describe("Optional explicit coil/terminal node ids for critical path search."),
        roleOverrides: z.record(z.string()).optional().describe("Optional node-id to role override map, e.g. {\"123\":\"balancing_valve\"}. Does not change the input graph."),
    }, async (args) => {
        try {
            let graph = parseGraphInput(args);
            if (!graph && args.graphFilePath) {
                graph = JSON.parse(await readFile(args.graphFilePath, "utf8"));
            }
            if (!graph) {
                return formatJsonContent({
                    success: false,
                    error: "Provide graph, graphJson, or graphFilePath.",
                });
            }
            return formatJsonContent(analyzeHydronicPipingGraph(graph, {
                calculationMethod: args.calculationMethod,
                defaultFluidDensityKgM3: args.defaultFluidDensityKgM3,
                defaultDynamicViscosityPaS: args.defaultDynamicViscosityPaS,
                defaultRoughnessMm: args.defaultRoughnessMm,
                defaultHazenWilliamsC: args.defaultHazenWilliamsC,
                designPressureReservePa: args.designPressureReservePa,
                pumpHeadSafetyFactor: args.pumpHeadSafetyFactor,
                maxPaths: args.maxPaths,
                startNodeIds: args.startNodeIds,
                endNodeIds: args.endNodeIds,
                roleOverrides: args.roleOverrides,
            }));
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                dry_run: true,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
