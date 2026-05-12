import { z } from "zod";
import { connectionTargetSchema, executionOptionsFromArgs, formatJsonContent, sendRevitCommand, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
const elementIdSchema = z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/),
]);
export function registerFocusElementsTool(server) {
    server.tool("focus_elements", "Select and zoom to Revit elements in the active view or in a requested view tab. This is a UI operation and does not open a Revit transaction.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        elementIds: z.array(elementIdSchema).min(1).describe("ElementId values to select and show."),
        viewId: z.number().int().positive().optional().describe("Optional ElementId of the Revit view to activate before focusing elements."),
        viewName: z.string().optional().describe("Optional name of the Revit view to activate before focusing elements."),
        viewType: z.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, Section, Elevation, DrawingSheet, or Schedule."),
        exactName: z.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),
        select: z.boolean().optional().describe("Select the supplied elements. Defaults true."),
        zoom: z.boolean().optional().describe("Zoom/show the supplied elements in the active UI view. Defaults true."),
        allowPartial: z.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Timeout for asynchronous UI activation/focus verification. Defaults 15000."),
    }, async (args) => {
        try {
            const response = await sendRevitCommand("focus_elements", {
                elementIds: args.elementIds,
                viewId: args.viewId,
                viewName: args.viewName,
                viewType: args.viewType,
                exactName: args.exactName,
                select: args.select,
                zoom: args.zoom,
                allowPartial: args.allowPartial,
                timeoutMs: args.timeoutMs,
            }, {
                ...executionOptionsFromArgs(args, "Focus Revit elements"),
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
