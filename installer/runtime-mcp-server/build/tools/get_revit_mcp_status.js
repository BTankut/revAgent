import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { connectionOptionsFromArgs, connectionTargetSchema, compactMcpStatusPayload, formatJsonContent, normalizeRevitExecutionResponse, } from "../utils/revitToolHelpers.js";
export function registerGetRevitMcpStatusTool(server) {
    server.tool("get_revit_mcp_status", "Read the Revit MCP task status without waiting behind the active Revit command lock.", {
        ...connectionTargetSchema(z),
        includeRecentTasks: z.boolean().optional().describe("Include recent completed task records. Defaults true, with a compact limit."),
        recentLimit: z.number().int().min(0).max(20).optional().describe("Maximum recent task records to return when includeRecentTasks is true. Defaults 3."),
        includeDiagnostics: z.boolean().optional().describe("Include transport timing/byte diagnostics on task records. Defaults false."),
        timeoutMs: z.number().int().positive().max(10000).optional().describe("Connection timeout in milliseconds. Defaults 3000."),
    }, async (args) => {
        try {
            const timeoutMs = args.timeoutMs || 3000;
            const response = await withRevitConnection(async (revitClient) => {
                return await revitClient.sendCommand("mcp_status", {}, { timeoutMs });
            }, {
                ...connectionOptionsFromArgs(args),
                skipLock: true,
                connectTimeoutMs: timeoutMs,
            });
            return formatJsonContent(compactMcpStatusPayload(normalizeRevitExecutionResponse(response), {
                includeRecentTasks: args.includeRecentTasks,
                recentLimit: args.recentLimit,
                includeDiagnostics: args.includeDiagnostics,
            }));
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
