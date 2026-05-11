import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { connectionOptionsFromArgs, connectionTargetSchema, } from "../utils/revitToolHelpers.js";
export function registerGetCurrentViewInfoTool(server) {
    server.tool("get_current_view_info", "Get detailed information about the active Revit view, including view type, name, and scale.", {
        ...connectionTargetSchema(z),
    }, async (args, extra) => {
        try {
            const response = await withRevitConnection(async (revitClient) => {
                return await revitClient.sendCommand("get_current_view_info", {});
            }, connectionOptionsFromArgs(args));
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `get current view info failed: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
            };
        }
    });
}
