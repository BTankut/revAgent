import { z } from "zod";
import { formatJsonContent, truncateText } from "../utils/revitToolHelpers.js";
import { auditDcwDhwGraph } from "../engineering/dcw-dhw/sizingAudit.js";
export function registerAuditDcwDhwPipingTool(server) {
    server.tool("audit_dcw_dhw_piping", "Audit a mep.connector-graph.v1 JSON document for DCW/DHW sizing readiness, fixture-unit flow conversion, DHW recirculation heat loss, and dry-run write-back actions. This tool never writes to Revit.", {
        graph: z.any().describe("Connector graph JSON using schemaVersion 'mep.connector-graph.v1'."),
        options: z.object({
            flowTable: z.any().optional().describe("Optional fixture-unit to L/s table used for mixed fixtures. Points may be [fixtureUnits, flowLps] or objects."),
            flowTables: z.object({
                mixed: z.any().optional(),
                flushTank: z.any().optional(),
                flushValve: z.any().optional(),
            }).optional().describe("Optional project/code flow tables by fixture behavior."),
            diameterCatalogMm: z.array(z.number()).optional().describe("Allowed pipe diameters in mm."),
            maxVelocityMps: z.union([
                z.number(),
                z.object({
                    dcw: z.number().optional(),
                    dhw: z.number().optional(),
                    dhwr: z.number().optional(),
                }),
            ]).optional().describe("Velocity limit in m/s, either a single number or per-system object."),
            dhwrDeltaTC: z.number().positive().optional().describe("DHW recirculation design delta-T in C. Defaults 5."),
            defaultDhwrHeatLossWPerM: z.number().positive().optional().describe("Fallback W/m when DHWR segment heat-loss data is missing. Defaults 10 and reports a warning."),
            preferGraphFlow: z.boolean().optional().describe("Use graph engineering.flowLps instead of calculated fixture-unit flow when positive."),
            minPipeFlowLps: z.number().nonnegative().optional().describe("Threshold for zero-flow domestic pipe reporting."),
            diameterToleranceMm: z.number().nonnegative().optional().describe("Existing/proposed diameter tolerance before a write-back action is emitted."),
            parameterWriteBack: z.object({
                includeDesignFlowParameter: z.boolean().optional(),
                designFlowParameterName: z.string().optional(),
                includeFixtureUnitsParameter: z.boolean().optional(),
                fixtureUnitsParameterName: z.string().optional(),
            }).optional().describe("Optional parameter write-back preview actions in addition to diameter actions."),
            maxReturnedChars: z.number().int().positive().optional().describe("Maximum returned JSON characters."),
        }).optional(),
    }, async (args) => {
        try {
            const report = auditDcwDhwGraph(args.graph, args.options || {});
            const text = JSON.stringify(report, null, 2);
            const trimmed = truncateText(text, args.options?.maxReturnedChars);
            if (trimmed.truncated) {
                return {
                    content: [
                        {
                            type: "text",
                            text: trimmed.text,
                        },
                    ],
                };
            }
            return formatJsonContent(report);
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                schemaVersion: "dcw-dhw-sizing-audit.v1",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
