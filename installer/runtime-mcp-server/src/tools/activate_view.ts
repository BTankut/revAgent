import { z } from "zod";
import {
    connectionTargetSchema,
    executionOptionsFromArgs,
    formatJsonContent,
    sendRevitCommand,
    taskMetadataSchema,
} from "../utils/revitToolHelpers.js";

export function registerActivateViewTool(server) {
    server.tool("activate_view", "Activate an existing Revit view tab by id or unique name without opening a transaction. Supports plans, 3D views, sheets, schedules, legends, drafting views, sections, and elevations.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        viewId: z.number().int().positive().optional().describe("ElementId of the Revit view to activate."),
        viewName: z.string().optional().describe("Name of the Revit view to activate. Must match one view unless viewType is also supplied."),
        viewType: z.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, DrawingSheet, Schedule, Section, or Elevation."),
        exactName: z.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Timeout for asynchronous UI activation verification. Defaults 15000."),
    }, async (args) => {
        try {
            const response = await sendRevitCommand("activate_view", {
                viewId: args.viewId,
                viewName: args.viewName,
                viewType: args.viewType,
                exactName: args.exactName,
                timeoutMs: args.timeoutMs,
            }, {
                ...executionOptionsFromArgs(args, "Activate Revit view"),
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
