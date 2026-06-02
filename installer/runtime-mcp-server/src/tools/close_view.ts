import type { ToolServer } from "./types.js";
import { z } from "zod";
import {
    connectionTargetSchema,
    executionOptionsFromArgs,
    formatJsonContent,
    sendRevitCommand,
    taskMetadataSchema,
} from "../utils/revitToolHelpers.js";

export function registerCloseViewTool(server: ToolServer) {
    server.tool("close_view", "Close an open Revit UI view tab by id or unique name without opening a transaction. If the target is active, another open view is activated first.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        viewId: z.number().int().positive().optional().describe("ElementId of the Revit view to close."),
        viewName: z.string().optional().describe("Name of the Revit view to close. Must match one view unless viewType is also supplied."),
        viewType: z.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, DrawingSheet, Schedule, Section, or Elevation."),
        exactName: z.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Timeout for asynchronous UI close verification. Defaults 15000."),
    }, async (args) => {
        try {
            const response = await sendRevitCommand("close_view", {
                viewId: args.viewId,
                viewName: args.viewName,
                viewType: args.viewType,
                exactName: args.exactName,
                timeoutMs: args.timeoutMs,
            }, {
                ...executionOptionsFromArgs(args, "Close Revit view"),
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
