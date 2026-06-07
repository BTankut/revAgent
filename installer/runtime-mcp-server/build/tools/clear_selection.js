import { z } from "zod";
import { connectionTargetSchema, executionOptionsFromArgs, formatJsonContent, sendRevitCommand, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
export function registerClearSelectionTool(server) {
    server.tool("clear_selection", "[LIVE_UI_SELECTION_CLEANUP] Clear the current Revit UI selection. This does not open a transaction and does not modify model elements or view data. Use after focus/testing workflows when the operator wants Revit left with no selected elements.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        timeoutMs: z.number().int().positive().max(30000).optional().describe("Timeout for the selection clear command. Defaults 10000."),
    }, async (args) => {
        try {
            const response = await sendRevitCommand("clear_selection", {
                timeoutMs: args.timeoutMs,
            }, {
                ...executionOptionsFromArgs(args, "Clear Revit selection"),
            });
            return formatJsonContent(response && response.result ? response.result : response);
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                action: "clear_selection",
                state: "failed",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
