import { z } from "zod";
import { formatJsonContent, readRevitMcpStatus } from "../utils/revitToolHelpers.js";
import { readLockOwner } from "../utils/RevitCommandGate.js";

export function registerGetRevitMcpStatusTool(server) {
    server.tool("get_revit_mcp_status", "Read the Revit MCP runtime/add-in command gate status without queueing behind normal Revit commands.", {
        includeRuntimeGate: z.boolean().optional().describe("Include the local cross-process runtime lock owner. Defaults true."),
    }, async (args) => {
        try {
            const status = await readRevitMcpStatus({
                timeoutMs: 5000,
                connectTimeoutMs: 3000,
            });
            if (args.includeRuntimeGate !== false && status && typeof status === "object") {
                status.runtimeGate = {
                    lockOwner: readLockOwner(),
                };
            }
            return formatJsonContent(status);
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
