import { z } from "zod";
import { connectionTargetSchema, executionOptionsFromArgs, formatJsonContent, sendRevitCommand, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
const elementIdSchema = z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/),
]);
export function registerSectionBoxElementsTool(server) {
    server.tool("section_box_elements", "Apply a 3D section box around Revit elements, optionally select them, and zoom to them. Requires a 3D view; if viewId/viewName is supplied, that view is activated first.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        elementIds: z.array(elementIdSchema).min(1).describe("ElementId values to include in the section box."),
        viewId: z.number().int().positive().optional().describe("Optional ElementId of the 3D Revit view to activate and modify."),
        viewName: z.string().optional().describe("Optional name of the 3D Revit view to activate and modify."),
        viewType: z.string().optional().describe("Optional Revit ViewType filter. For this tool the resolved view must be ThreeD."),
        exactName: z.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),
        paddingMm: z.number().min(0).max(100000).optional().describe("Extra space around the element bounding box in millimeters. Defaults 500."),
        select: z.boolean().optional().describe("Select the supplied elements after applying the section box. Defaults true."),
        zoom: z.boolean().optional().describe("Zoom/show the supplied elements after applying the section box. Defaults true."),
        allowPartial: z.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Timeout for asynchronous 3D view activation and section box application. Defaults 15000."),
    }, async (args) => {
        try {
            const response = await sendRevitCommand("section_box_elements", {
                elementIds: args.elementIds,
                viewId: args.viewId,
                viewName: args.viewName,
                viewType: args.viewType,
                exactName: args.exactName,
                paddingMm: args.paddingMm,
                select: args.select,
                zoom: args.zoom,
                allowPartial: args.allowPartial,
                timeoutMs: args.timeoutMs,
            }, {
                ...executionOptionsFromArgs(args, "Section box Revit elements"),
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
