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

function unwrapResponse(response) {
    return response && response.result ? response.result : response;
}

export function registerSmartFocusElementsTool(server) {
    server.tool("smart_focus_elements", "[LIVE_VIEW_WORKFLOW_WRAPPER] Focus Revit elements without triggering Revit's modal closed-view search. It can try the active/requested view first, then open the best existing same-level plan, and optionally create/reuse a 3D view. Use this for live Revit focus/navigation, not image artifact export.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        elementIds: z.array(elementIdSchema).min(1).describe("ElementId values to select and show."),
        mode: z.enum(["activeOnly", "activeThenElementLevelPlan", "elementLevelPlan"]).optional().describe("activeOnly only tries the active/requested view. activeThenElementLevelPlan falls back to an existing same-level plan. elementLevelPlan skips the active view and opens the same-level plan. Defaults activeThenElementLevelPlan."),
        viewId: z.number().int().positive().optional().describe("Optional target view id for the first focus attempt."),
        viewName: z.string().optional().describe("Optional target view name for the first focus attempt."),
        viewType: z.string().optional().describe("Optional Revit ViewType filter for the first focus attempt."),
        exactName: z.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),
        planNameContains: z.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level for same-level fallback."),
        preferMechanical: z.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),
        select: z.boolean().optional().describe("Select the supplied elements. Defaults true."),
        zoom: z.boolean().optional().describe("Zoom/show the supplied elements. Defaults true."),
        fitToScreen: z.boolean().optional().describe("Run Revit UI ZoomToFit after focus. Defaults false."),
        create3d: z.boolean().optional().describe("After plan focus, create/reuse a focused 3D view for all supplied elements. Defaults false."),
        viewName3d: z.string().optional().describe("Desired 3D view name when create3d=true."),
        reuseExisting3d: z.boolean().optional().describe("Reuse an existing 3D view with the same name when create3d=true. Defaults true."),
        sectionBox: z.boolean().optional().describe("Apply a section box in the 3D view when create3d=true. Defaults false."),
        cameraOrientation: z.enum(["unchanged", "isometric", "top", "front", "back", "left", "right"]).optional().describe("Optional 3D camera direction when create3d=true. Defaults unchanged."),
        framingPaddingMm: z.number().min(0).max(100000).optional().describe("Padding in millimeters for 3D camera framing. Defaults to paddingMm or 500."),
        paddingMm: z.number().min(0).max(100000).optional().describe("Section box padding in millimeters when sectionBox=true. Defaults 500."),
        allowPartial: z.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Socket timeout in milliseconds. Defaults 120000."),
    }, async (args) => {
        try {
            const options = executionOptionsFromArgs(args, "Smart focus Revit elements");
            const mode = args.mode || "activeThenElementLevelPlan";
            let activeFocus = null;
            let planFocus = null;
            let threeD = null;

            if (mode !== "elementLevelPlan") {
                activeFocus = unwrapResponse(await sendRevitCommand("focus_elements", {
                    elementIds: args.elementIds,
                    viewId: args.viewId,
                    viewName: args.viewName,
                    viewType: args.viewType,
                    exactName: args.exactName,
                    select: args.select,
                    zoom: args.zoom,
                    fitToScreen: args.fitToScreen,
                    allowClosedViewSearch: false,
                    allowPartial: args.allowPartial,
                    timeoutMs: args.timeoutMs,
                    taskName: "Try focus elements in active/requested view",
                }, options));

                if (activeFocus && activeFocus.Success !== false) {
                    return formatJsonContent({
                        Success: true,
                        Action: "smart_focus_elements",
                        Mode: mode,
                        UsedStep: "activeOrRequestedView",
                        Focus: activeFocus,
                    });
                }

                if (mode === "activeOnly" || !activeFocus || activeFocus.FocusBlocked !== true) {
                    return formatJsonContent({
                        Success: false,
                        Action: "smart_focus_elements",
                        Mode: mode,
                        Error: activeFocus && activeFocus.Error ? activeFocus.Error : "Active/requested view focus failed.",
                        Focus: activeFocus,
                    });
                }
            }

            planFocus = unwrapResponse(await sendRevitCommand("open_existing_plan_for_element_level", {
                elementId: args.elementIds[0],
                planMode: "elementLevel",
                planNameContains: args.planNameContains,
                preferMechanical: args.preferMechanical,
                select: args.select,
                zoom: args.zoom,
                fitToScreen: args.fitToScreen,
                timeoutMs: args.timeoutMs,
                taskName: "Smart focus fallback to same-level existing plan",
            }, options));

            if (!planFocus || planFocus.Success === false) {
                return formatJsonContent({
                    Success: false,
                    Action: "smart_focus_elements",
                    Mode: mode,
                    Error: planFocus && planFocus.Error ? planFocus.Error : "Same-level existing plan focus failed.",
                    Focus: activeFocus,
                    Plan: planFocus,
                });
            }

            if (args.create3d === true) {
                threeD = unwrapResponse(await sendRevitCommand("create_3d_view_for_elements", {
                    elementIds: args.elementIds,
                    viewName: args.viewName3d,
                    reuseExisting: args.reuseExisting3d,
                    createIfMissing: true,
                    sectionBox: args.sectionBox,
                    paddingMm: args.paddingMm,
                    cameraOrientation: args.cameraOrientation,
                    framingPaddingMm: args.framingPaddingMm,
                    activate: true,
                    select: args.select,
                    zoom: args.zoom,
                    fitToScreen: args.fitToScreen,
                    allowPartial: args.allowPartial,
                    timeoutMs: args.timeoutMs,
                    taskName: "Smart focus optional 3D view",
                }, options));
            }

            const success = args.create3d === true ? threeD && threeD.Success !== false : true;
            return formatJsonContent({
                Success: success,
                Action: "smart_focus_elements",
                Mode: mode,
                UsedStep: args.create3d === true ? "elementLevelPlanThen3D" : "elementLevelPlan",
                Focus: activeFocus,
                Plan: planFocus,
                ThreeD: threeD,
            });
        }
        catch (error) {
            return formatJsonContent({
                Success: false,
                Action: "smart_focus_elements",
                Error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
