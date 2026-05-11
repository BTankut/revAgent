import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { connectionOptionsFromArgs, connectionTargetSchema, formatJsonContent, normalizeRevitExecutionResponse, } from "../utils/revitToolHelpers.js";
export function registerGetRevitMcpStatusTool(server) {
    server.tool("get_revit_mcp_status", "Read the Revit MCP task status without waiting behind the active Revit command lock.", {
        ...connectionTargetSchema(z),
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
            return formatJsonContent(normalizeRevitExecutionResponse(response));
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
