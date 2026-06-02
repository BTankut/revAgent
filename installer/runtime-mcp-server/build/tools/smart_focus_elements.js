import { z } from "zod";
import { connectionTargetSchema, executionOptionsFromArgs, formatJsonContent, readCasedField as readField, sendRevitCommand, taskMetadataSchema, trimPlanCandidatesInPayload, } from "../utils/revitToolHelpers.js";
const elementIdSchema = z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/),
]);
function unwrapResponse(response) {
    return response && response.result ? response.result : response;
}
function isSuccess(payload) {
    if (!payload || typeof payload !== "object") {
        return false;
    }
    const success = readField(payload, "Success", "success");
    return success !== false;
}
function compactView(view) {
    if (!view || typeof view !== "object") {
        return view || null;
    }
    return {
        id: view.Id ?? view.id,
        name: view.Name ?? view.name,
        viewType: view.ViewType ?? view.viewType,
        isActive: view.IsActive ?? view.isActive,
        isOpen: view.IsOpen ?? view.isOpen,
        isSectionBoxActive: view.IsSectionBoxActive ?? view.isSectionBoxActive,
    };
}
function compactFocusResult(result) {
    if (!result || typeof result !== "object") {
        return result || null;
    }
    const planCandidates = result.PlanCandidates ?? result.planCandidates;
    return {
        success: readField(result, "Success", "success"),
        message: readField(result, "Message", "message"),
        error: readField(result, "Error", "error"),
        focusBlocked: result.FocusBlocked ?? result.focusBlocked,
        focusBlockReason: result.FocusBlockReason ?? result.focusBlockReason,
        focusSuggestion: result.FocusSuggestion ?? result.focusSuggestion,
        changed: result.Changed ?? result.changed,
        selected: result.Selected ?? result.selected,
        zoomed: result.Zoomed ?? result.zoomed,
        activeViewChanged: result.ActiveViewChanged ?? result.activeViewChanged,
        planOpenMode: result.PlanOpenMode ?? result.planOpenMode,
        levelName: result.LevelName ?? result.levelName,
        activeView: compactView(result.ActiveView ?? result.activeView),
        targetView: compactView(result.TargetView ?? result.targetView),
        selectedPlan: compactView(result.SelectedPlan ?? result.selectedPlan),
        suggestedView: compactView(result.SuggestedView ?? result.suggestedView),
        planCandidatesTotal: Array.isArray(planCandidates)
            ? planCandidates.length
            : (result.PlanCandidatesTotal ?? result.planCandidatesTotal),
        planCandidatesTruncated: result.PlanCandidatesTruncated ?? result.planCandidatesTruncated,
        createdView: result.CreatedView ?? result.createdView,
        reusedView: result.ReusedView ?? result.reusedView,
        sectionBoxApplied: result.SectionBoxApplied ?? result.sectionBoxApplied,
        cameraOrientation: result.CameraOrientation ?? result.cameraOrientation,
        cameraApplied: result.CameraApplied ?? result.cameraApplied,
    };
}
function compactSmartFocusPayload(payload) {
    return {
        success: readField(payload, "Success", "success"),
        guarded: readField(payload, "Guarded", "guarded") === true,
        state: readField(payload, "State", "state"),
        action: readField(payload, "Action", "action"),
        message: readField(payload, "Message", "message"),
        error: readField(payload, "Error", "error"),
        resultContractVersion: readField(payload, "ResultContractVersion", "resultContractVersion"),
        responseMode: "compact",
        mode: payload.mode ?? payload.Mode,
        usedStep: payload.usedStep ?? payload.UsedStep,
        focusSummary: compactFocusResult(payload.focus ?? payload.Focus),
        planSummary: compactFocusResult(payload.plan ?? payload.Plan),
        threeDSummary: compactFocusResult(payload.threeD ?? payload.ThreeD),
    };
}
function firstResultContractVersion(...payloads) {
    for (const payload of payloads) {
        const raw = readField(payload, "ResultContractVersion", "resultContractVersion");
        const parsed = Number.parseInt(String(raw ?? ""), 10);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return null;
}
function workflowPayload(args) {
    const guarded = args.guarded === true;
    return {
        success: args.success,
        guarded,
        state: guarded ? "guarded" : args.success ? "completed" : "failed",
        action: "smart_focus_elements",
        message: args.message,
        error: args.error,
        resultContractVersion: firstResultContractVersion(args.focus, args.plan, args.threeD),
        mode: args.mode,
        usedStep: args.usedStep,
        focus: args.focus,
        plan: args.plan,
        threeD: args.threeD,
    };
}
export function registerSmartFocusElementsTool(server) {
    server.tool("smart_focus_elements", "[LIVE_VIEW_WORKFLOW_WRAPPER] Focus Revit elements without triggering Revit's modal closed-view search. It can try the active/requested view first, then open the best existing same-level plan, and optionally create/reuse a 3D view. When create3d=true, the 3D step runs after whichever live focus step succeeds. Use this for live Revit focus/navigation, not image artifact export.", {
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
        create3d: z.boolean().optional().describe("After the successful active/requested-view or plan focus step, create/reuse a focused 3D view for all supplied elements. Defaults false."),
        viewName3d: z.string().optional().describe("Desired 3D view name when create3d=true."),
        reuseExisting3d: z.boolean().optional().describe("Reuse an existing 3D view with the same name when create3d=true. Defaults true."),
        sectionBox: z.boolean().optional().describe("Apply a section box in the 3D view when create3d=true. Defaults false."),
        cameraOrientation: z.enum(["unchanged", "isometric", "top", "front", "back", "left", "right"]).optional().describe("Optional 3D camera direction when create3d=true. Defaults unchanged."),
        framingPaddingMm: z.number().min(0).max(100000).optional().describe("Padding in millimeters for 3D camera framing. Defaults to paddingMm or 500."),
        paddingMm: z.number().min(0).max(100000).optional().describe("Section box padding in millimeters when sectionBox=true. Defaults 500."),
        allowPartial: z.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),
        verboseCandidates: z.boolean().optional().describe("Return full PlanCandidates arrays from nested steps. Defaults false."),
        maxPlanCandidates: z.number().int().min(0).max(50).optional().describe("Maximum nested PlanCandidates returned when verboseCandidates=false. Defaults 3."),
        responseMode: z.enum(["compact", "full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns nested raw tool results."),
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
                if (activeFocus && isSuccess(activeFocus)) {
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
                            taskName: "Smart focus optional 3D view after active/requested focus",
                        }, options));
                    }
                    const success = args.create3d === true ? Boolean(threeD && isSuccess(threeD)) : true;
                    const fullPayload = trimPlanCandidatesInPayload(workflowPayload({
                        success,
                        message: args.create3d === true
                            ? success
                                ? "Elements were focused in the active/requested view and focused in 3D."
                                : "Elements were focused in the active/requested view, but the 3D step failed."
                            : "Elements were focused in the active/requested view.",
                        mode,
                        usedStep: args.create3d === true ? "activeOrRequestedViewThen3D" : "activeOrRequestedView",
                        focus: activeFocus,
                        threeD,
                    }), {
                        verboseCandidates: args.verboseCandidates,
                        maxPlanCandidates: args.maxPlanCandidates ?? 3,
                    });
                    return formatJsonContent(args.responseMode === "full" || !success
                        ? fullPayload
                        : compactSmartFocusPayload(fullPayload));
                }
                const activeFocusBlocked = Boolean(activeFocus &&
                    (activeFocus.FocusBlocked === true || activeFocus.focusBlocked === true));
                if (mode === "activeOnly" || !activeFocus || !activeFocusBlocked) {
                    return formatJsonContent(workflowPayload({
                        success: false,
                        guarded: activeFocusBlocked,
                        mode,
                        error: readField(activeFocus, "Error", "error") || "Active/requested view focus failed.",
                        focus: activeFocus,
                    }));
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
            if (!planFocus || !isSuccess(planFocus)) {
                return formatJsonContent(workflowPayload({
                    success: false,
                    mode,
                    error: readField(planFocus, "Error", "error") || "Same-level existing plan focus failed.",
                    focus: activeFocus,
                    plan: planFocus,
                }));
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
            const success = args.create3d === true ? Boolean(threeD && isSuccess(threeD)) : true;
            const fullPayload = trimPlanCandidatesInPayload(workflowPayload({
                success,
                message: args.create3d === true
                    ? success
                        ? "Elements were focused in a same-level plan and focused in 3D."
                        : "Elements were focused in a same-level plan, but the 3D step failed."
                    : "Elements were focused in a same-level plan.",
                mode,
                usedStep: args.create3d === true ? "elementLevelPlanThen3D" : "elementLevelPlan",
                focus: activeFocus,
                plan: planFocus,
                threeD,
            }), {
                verboseCandidates: args.verboseCandidates,
                maxPlanCandidates: args.maxPlanCandidates ?? 3,
            });
            return formatJsonContent(args.responseMode === "full" || !success
                ? fullPayload
                : compactSmartFocusPayload(fullPayload));
        }
        catch (error) {
            return formatJsonContent(workflowPayload({
                success: false,
                mode: "unknown",
                error: error instanceof Error ? error.message : String(error),
            }));
        }
    });
}
