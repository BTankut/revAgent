import { z } from "zod";
import { connectionTargetSchema, executionOptionsFromArgs, formatJsonContent, sendRevitCommand, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
const elementIdSchema = z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/),
]);
export function registerOpenExistingPlanForElementLevelTool(server) {
    server.tool("open_existing_plan_for_element_level", "Open the best existing non-template plan view for an element's level, then select and zoom to the element. This does not create a new view.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        elementId: elementIdSchema.describe("ElementId to locate in an existing plan view."),
        planNameContains: z.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level."),
        preferMechanical: z.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),
        select: z.boolean().optional().describe("Select the element after activating the plan. Defaults true."),
        zoom: z.boolean().optional().describe("Zoom/show the element after activating the plan. Defaults true."),
        fitToScreen: z.boolean().optional().describe("After opening/focusing the plan, run Revit UI ZoomToFit on the active view. Defaults false."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Timeout for asynchronous plan activation/focus. Defaults 20000."),
    }, async (args) => {
        try {
            const response = await sendRevitCommand("open_existing_plan_for_element_level", {
                elementId: args.elementId,
                planNameContains: args.planNameContains,
                preferMechanical: args.preferMechanical,
                select: args.select,
                zoom: args.zoom,
                fitToScreen: args.fitToScreen,
                timeoutMs: args.timeoutMs,
            }, {
                ...executionOptionsFromArgs(args, "Open existing plan for element level"),
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
