import { z } from "zod";
import { connectionTargetSchema, executionOptionsFromArgs, formatJsonContent, sendRevitCommand, taskMetadataSchema, trimPlanCandidatesInPayload, } from "../utils/revitToolHelpers.js";
const elementIdSchema = z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/),
]);
function unwrapResponse(response) {
    return response && response.result ? response.result : response;
}
function buildDefault3DViewName(elementId, element) {
    const label = element && (element.FamilyName || element.TypeName || element.Name)
        ? String(element.FamilyName || element.TypeName || element.Name)
        : "Element";
    return `3D - ${label} ${elementId}`.replace(/[{}[\];<>?`~]/g, "").slice(0, 90);
}
function compactElement(element) {
    if (!element || typeof element !== "object")
        return element;
    return {
        Id: element.Id,
        Name: element.Name,
        Category: element.Category,
        FamilyName: element.FamilyName,
        TypeName: element.TypeName,
        LevelId: element.LevelId,
        LevelName: element.LevelName,
        Mark: element.Mark,
        MatchScore: element.MatchScore,
        MatchConfidence: element.MatchConfidence,
    };
}
function compactView(view) {
    if (!view || typeof view !== "object")
        return view;
    return {
        Id: view.Id ?? view.id,
        Name: view.Name ?? view.name,
        ViewType: view.ViewType ?? view.viewType,
        Scale: view.Scale ?? view.scale,
    };
}
function summarizeFind(findResult) {
    if (!findResult || typeof findResult !== "object")
        return findResult;
    return {
        Success: findResult.Success,
        Count: findResult.Count,
        Truncated: findResult.Truncated,
        Ambiguous: findResult.Ambiguous,
        TopScore: findResult.TopScore,
        TopConfidence: findResult.TopConfidence,
        TopScoreTiedCount: findResult.TopScoreTiedCount,
        PlanCandidateMode: findResult.PlanCandidateMode,
        SelectionHint: findResult.SelectionHint,
    };
}
function summarizePlan(planResult) {
    if (!planResult || typeof planResult !== "object")
        return planResult;
    return {
        Success: planResult.Success,
        Message: planResult.Message,
        PlanMode: planResult.PlanMode,
        PlanOpenMode: planResult.PlanOpenMode,
        PlanOpenNote: planResult.PlanOpenNote,
        SelectedPlan: compactView(planResult.SelectedPlan),
        TargetView: compactView(planResult.TargetView),
        ActiveView: compactView(planResult.ActiveView),
        ActiveViewChanged: planResult.ActiveViewChanged,
        ActivePlanMatchesElementLevel: planResult.ActivePlanMatchesElementLevel,
        PlanSelectionReason: planResult.PlanSelectionReason,
        ZoomMethod: planResult.ZoomMethod,
        Selected: planResult.Selected,
        Zoomed: planResult.Zoomed,
        FitToScreen: planResult.FitToScreen,
        FitToScreenWarning: planResult.FitToScreenWarning,
        PlanVisibilityWarning: planResult.PlanVisibilityWarning,
        FocusWarning: planResult.FocusWarning,
        PlanCandidatesTotal: planResult.PlanCandidatesTotal,
        PlanCandidatesTruncated: planResult.PlanCandidatesTruncated,
    };
}
function summarizeThreeD(threeDResult) {
    if (!threeDResult || typeof threeDResult !== "object")
        return threeDResult;
    return {
        Success: threeDResult.Success,
        Message: threeDResult.Message,
        TargetView: compactView(threeDResult.TargetView),
        ActiveView: compactView(threeDResult.ActiveView),
        CreatedView: threeDResult.CreatedView,
        ReusedView: threeDResult.ReusedView,
        SectionBoxApplied: threeDResult.SectionBoxApplied,
        SectionBoxState: threeDResult.SectionBoxState,
        CameraOrientation: threeDResult.CameraOrientation,
        CameraApplied: threeDResult.CameraApplied,
        CameraWarning: threeDResult.CameraWarning,
        ZoomMethod: threeDResult.ZoomMethod,
        Selected: threeDResult.Selected,
        Zoomed: threeDResult.Zoomed,
    };
}
export function registerShowElementInPlanAnd3DTool(server) {
    server.tool("show_element_in_plan_and_3d", "[LIVE_VIEW_WORKFLOW_WRAPPER] Safely find or use one Revit element, show it in an existing plan, then optionally call create_3d_view_for_elements to create/reuse a focused 3D view. Use this when the user wants a combined plan plus 3D live Revit view workflow. Ambiguous search results are rejected by default for large-project safety.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        elementId: elementIdSchema.optional().describe("Known ElementId. When supplied, search is skipped."),
        query: z.string().optional().describe("Text query used when elementId is not supplied."),
        categoryNames: z.array(z.string()).optional().describe("Category name filters for the search, e.g. Mechanical Equipment."),
        searchLimit: z.number().int().positive().max(200).optional().describe("Maximum search candidates to inspect. Defaults 20."),
        allowAmbiguous: z.boolean().optional().describe("Allow the top search result to be used even when multiple plausible matches exist. Defaults false."),
        planMode: z.enum(["elementLevel", "activePlan"]).optional().describe("elementLevel opens the best existing same-level plan. activePlan keeps the current active plan. Defaults elementLevel."),
        planNameContains: z.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level."),
        preferMechanical: z.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),
        includeSearchPlanCandidates: z.boolean().optional().describe("Include plan candidates during the initial search. Defaults false; the plan-open step computes focused candidates separately."),
        verboseCandidates: z.boolean().optional().describe("Return full PlanCandidates arrays from nested steps. Defaults false."),
        maxPlanCandidates: z.number().int().min(0).max(50).optional().describe("Maximum nested PlanCandidates returned when verboseCandidates=false. Defaults 3."),
        responseMode: z.enum(["compact", "full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns nested raw tool results."),
        select: z.boolean().optional().describe("Select the element in plan/3D. Defaults true."),
        zoom: z.boolean().optional().describe("Show/zoom the element in plan/3D. Defaults true."),
        fitToScreen: z.boolean().optional().describe("Run Revit UI ZoomToFit after focusing views. Defaults false."),
        create3d: z.boolean().optional().describe("Create or reuse a focused 3D view after the plan step. Defaults true."),
        viewName: z.string().optional().describe("Desired 3D view name. If omitted, one is generated from the selected element."),
        reuseExisting3d: z.boolean().optional().describe("Reuse an existing 3D view with the same name. Defaults true."),
        sectionBox: z.boolean().optional().describe("Apply a 3D section box around the element. Defaults false."),
        paddingMm: z.number().min(0).max(100000).optional().describe("Section box padding in millimeters when sectionBox=true. Defaults 500."),
        cameraOrientation: z.enum(["unchanged", "isometric", "top", "front", "back", "left", "right"]).optional().describe("Optional 3D camera direction. Defaults unchanged."),
        framingPaddingMm: z.number().min(0).max(100000).optional().describe("Padding in millimeters for camera orientation/framing. Defaults to paddingMm or 500."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Socket timeout in milliseconds. Defaults 120000."),
    }, async (args) => {
        try {
            const options = executionOptionsFromArgs(args, "Show element in plan and 3D");
            let chosenElementId = args.elementId;
            let chosenElement = null;
            let findResult = null;
            if (!chosenElementId) {
                if (!args.query && (!args.categoryNames || args.categoryNames.length === 0)) {
                    return formatJsonContent({
                        Success: false,
                        Action: "show_element_in_plan_and_3d",
                        Error: "Pass elementId, or pass query/categoryNames for a safe search.",
                    });
                }
                findResult = unwrapResponse(await sendRevitCommand("find_elements", {
                    query: args.query,
                    categoryNames: args.categoryNames,
                    includePlanCandidates: args.includeSearchPlanCandidates === true,
                    maxPlanCandidates: args.maxPlanCandidates ?? 3,
                    planNameContains: args.planNameContains,
                    limit: args.searchLimit || 20,
                    timeoutMs: args.timeoutMs,
                    taskName: "Find element for plan and 3D presentation",
                }, options));
                if (!findResult || findResult.Success === false) {
                    return formatJsonContent({
                        Success: false,
                        Action: "show_element_in_plan_and_3d",
                        Error: findResult && findResult.Error ? findResult.Error : "Element search failed.",
                        Find: findResult,
                    });
                }
                const candidates = Array.isArray(findResult.Elements) ? findResult.Elements : [];
                if (candidates.length === 0) {
                    return formatJsonContent({
                        Success: false,
                        Action: "show_element_in_plan_and_3d",
                        Error: "No matching elements were found.",
                        Find: findResult,
                    });
                }
                if (findResult.Ambiguous && args.allowAmbiguous !== true) {
                    return formatJsonContent({
                        Success: false,
                        Action: "show_element_in_plan_and_3d",
                        Error: "Multiple plausible elements matched. Use a more specific query or pass elementId before opening views.",
                        Ambiguous: true,
                        Find: findResult,
                        Candidates: candidates,
                    });
                }
                chosenElement = candidates[0];
                chosenElementId = chosenElement.Id;
            }
            const planResult = unwrapResponse(await sendRevitCommand("open_existing_plan_for_element_level", {
                elementId: chosenElementId,
                planMode: args.planMode,
                planNameContains: args.planNameContains,
                preferMechanical: args.preferMechanical,
                select: args.select,
                zoom: args.zoom,
                fitToScreen: args.fitToScreen,
                verboseCandidates: args.verboseCandidates,
                maxPlanCandidates: args.maxPlanCandidates ?? 3,
                responseMode: "full",
                timeoutMs: args.timeoutMs,
                taskName: "Show element in existing plan",
            }, options));
            if (!planResult || planResult.Success === false) {
                return formatJsonContent({
                    Success: false,
                    Action: "show_element_in_plan_and_3d",
                    Error: planResult && planResult.Error ? planResult.Error : "Plan presentation failed.",
                    ChosenElementId: chosenElementId,
                    ChosenElement: chosenElement,
                    Find: findResult,
                    Plan: planResult,
                });
            }
            let threeDResult = null;
            if (args.create3d !== false) {
                threeDResult = unwrapResponse(await sendRevitCommand("create_3d_view_for_elements", {
                    elementIds: [chosenElementId],
                    viewName: args.viewName || buildDefault3DViewName(chosenElementId, chosenElement),
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
                    timeoutMs: args.timeoutMs,
                    taskName: "Show element in focused 3D view",
                }, options));
            }
            const threeDSuccess = args.create3d === false || (threeDResult && threeDResult.Success !== false);
            const fullPayload = trimPlanCandidatesInPayload({
                Success: threeDSuccess,
                Action: "show_element_in_plan_and_3d",
                Message: args.create3d === false
                    ? "Element was shown in an existing plan."
                    : threeDSuccess
                        ? "Element was shown in an existing plan and focused in 3D."
                        : "Element was shown in plan, but the 3D step failed.",
                ChosenElementId: chosenElementId,
                ChosenElement: chosenElement,
                Find: findResult,
                Plan: planResult,
                ThreeD: threeDResult,
            }, {
                verboseCandidates: args.verboseCandidates,
                maxPlanCandidates: args.maxPlanCandidates ?? 3,
            });
            if (args.responseMode === "full" || !threeDSuccess) {
                return formatJsonContent(fullPayload);
            }
            return formatJsonContent({
                Success: fullPayload.Success,
                Action: fullPayload.Action,
                Message: fullPayload.Message,
                ResponseMode: "compact",
                ChosenElementId: chosenElementId,
                ChosenElement: compactElement(chosenElement),
                FindSummary: summarizeFind(findResult),
                PlanSummary: summarizePlan(planResult),
                ThreeDSummary: summarizeThreeD(threeDResult),
            });
        }
        catch (error) {
            return formatJsonContent({
                Success: false,
                Action: "show_element_in_plan_and_3d",
                Error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
