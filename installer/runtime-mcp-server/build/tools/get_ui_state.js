import { z } from "zod";
import { connectionTargetSchema, executionOptionsFromArgs, formatJsonContent, sendRevitCommand, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
export function registerGetUiStateTool(server) {
    server.tool("get_ui_state", "Read the current Revit UI state: active view, open views, selected element ids/summaries, and document modifiable/read-only status.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        selectionLimit: z.number().int().min(0).max(1000).optional().describe("Maximum selected elements to summarize. Defaults 100."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Socket timeout in milliseconds. Defaults 120000."),
    }, async (args) => {
        try {
            const response = await sendRevitCommand("get_ui_state", {
                selectionLimit: args.selectionLimit,
            }, {
                ...executionOptionsFromArgs(args, "Read Revit UI state"),
            });
            return formatJsonContent(response && response.result ? response.result : response);
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
