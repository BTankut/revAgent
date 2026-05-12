// @ts-nocheck
import { z } from "zod";
import {
    connectionTargetSchema,
    executionOptionsFromArgs,
    formatJsonContent,
    sendRevitCommand,
    taskMetadataSchema,
} from "../utils/revitToolHelpers.js";

const elementIdSchema = z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/),
]);

export function registerCreate3DViewForElementsTool(server) {
    server.tool("create_3d_view_for_elements", "Create or reuse a 3D Revit view for elements, optionally apply or clear a section box, activate the view, and focus/select the elements. This can modify the document because views and section boxes are project data.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        elementIds: z.array(elementIdSchema).min(1).describe("ElementId values to show in the 3D view."),
        viewName: z.string().optional().describe("Desired 3D view name. If omitted, a name is generated from the first element id."),
        reuseExisting: z.boolean().optional().describe("Reuse an existing non-template 3D view with the same name when viewName is supplied. Defaults true."),
        createIfMissing: z.boolean().optional().describe("Create the 3D view when no reusable view is found. Defaults true."),
        sectionBox: z.boolean().optional().describe("When true, apply a section box around the elements. When false, any active section box on the target view is cleared. Defaults false."),
        paddingMm: z.number().min(0).max(100000).optional().describe("Extra section box padding in millimeters when sectionBox=true. Defaults 500."),
        activate: z.boolean().optional().describe("Activate the target 3D view. Defaults true."),
        select: z.boolean().optional().describe("Select the supplied elements after activation. Defaults true."),
        zoom: z.boolean().optional().describe("Zoom/show the supplied elements after activation. Defaults true."),
        fitToScreen: z.boolean().optional().describe("After activation/focus, run Revit UI ZoomToFit on the active 3D view. Defaults false."),
        allowPartial: z.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Timeout for asynchronous view creation/activation/focus. Defaults 20000."),
    }, async (args) => {
        try {
            const response = await sendRevitCommand("create_3d_view_for_elements", {
                elementIds: args.elementIds,
                viewName: args.viewName,
                reuseExisting: args.reuseExisting,
                createIfMissing: args.createIfMissing,
                sectionBox: args.sectionBox,
                paddingMm: args.paddingMm,
                activate: args.activate,
                select: args.select,
                zoom: args.zoom,
                fitToScreen: args.fitToScreen,
                allowPartial: args.allowPartial,
                timeoutMs: args.timeoutMs,
            }, {
                ...executionOptionsFromArgs(args, "Create 3D view for elements"),
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
