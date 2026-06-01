import { z } from "zod";
import {
    connectionTargetSchema,
    executionOptionsFromArgs,
    formatJsonContent,
    sendRevitCommand,
    taskMetadataSchema,
} from "../utils/revitToolHelpers.js";

export function registerListOpenViewsTool(server) {
    server.tool("list_open_views", "List Revit UI view tabs currently open in the active document.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
    }, async (args) => {
        try {
            const response = await sendRevitCommand("list_open_views", {}, {
                ...executionOptionsFromArgs(args, "List open Revit views"),
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
