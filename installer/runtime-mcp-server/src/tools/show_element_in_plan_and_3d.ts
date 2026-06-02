import type { ToolServer } from "./types.js";
import { z } from "zod";
import {
    connectionTargetSchema,
    executionOptionsFromArgs,
    formatJsonContent,
    readCasedField as readField,
    sendRevitCommand,
    taskMetadataSchema,
    trimPlanCandidatesInPayload,
} from "../utils/revitToolHelpers.js";

const elementIdSchema = z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/),
]);

type JsonObject = Record<string, any>;

function unwrapResponse(response: any) {
    return response && response.result ? response.result : response;
}

function isSuccess(payload: any) {
    if (!payload || typeof payload !== "object") {
        return false;
    }
    return readField(payload, "Success", "success") !== false;
}

function isGuardedResult(payload: any) {
    if (!payload || typeof payload !== "object") {
        return false;
    }
    return readField(payload, "Guarded", "guarded") === true ||
        readField(payload, "State", "state") === "guarded" ||
        readField(payload, "FocusBlocked", "focusBlocked") === true;
}

function buildDefault3DViewName(elementId: string | number, element: JsonObject | null) {
    const label = element && (element.FamilyName || element.TypeName || element.Name)
        ? String(element.FamilyName || element.TypeName || element.Name)
        : "Element";
    return `3D - ${label} ${elementId}`.replace(/[{}[\];<>?`~]/g, "").slice(0, 90);
}

function compactElement(element: any) {
    if (!element || typeof element !== "object") return element;
    return {
        Id: readField(element, "Id", "id"),
        Name: readField(element, "Name", "name"),
        Category: readField(element, "Category", "category"),
        FamilyName: readField(element, "FamilyName", "familyName"),
        TypeName: readField(element, "TypeName", "typeName"),
        LevelId: readField(element, "LevelId", "levelId"),
        LevelName: readField(element, "LevelName", "levelName"),
        Mark: readField(element, "Mark", "mark"),
        MatchScore: readField(element, "MatchScore", "matchScore"),
        MatchConfidence: readField(element, "MatchConfidence", "matchConfidence"),
    };
}

function compactView(view: any) {
    if (!view || typeof view !== "object") return view;
    return {
        Id: view.Id ?? view.id,
        Name: view.Name ?? view.name,
        ViewType: view.ViewType ?? view.viewType,
        Scale: view.Scale ?? view.scale,
    };
}

function summarizeFind(findResult: any) {
    if (!findResult || typeof findResult !== "object") return findResult;
    return {
        Success: readField(findResult, "Success", "success"),
        Count: readField(findResult, "Count", "count"),
        Truncated: readField(findResult, "Truncated", "truncated"),
        Ambiguous: readField(findResult, "Ambiguous", "ambiguous"),
        TopScore: readField(findResult, "TopScore", "topScore"),
        TopConfidence: readField(findResult, "TopConfidence", "topConfidence"),
        TopScoreTiedCount: readField(findResult, "TopScoreTiedCount", "topScoreTiedCount"),
        PlanCandidateMode: readField(findResult, "PlanCandidateMode", "planCandidateMode"),
        SelectionHint: readField(findResult, "SelectionHint", "selectionHint"),
    };
}

function summarizePlan(planResult: any) {
    if (!planResult || typeof planResult !== "object") return planResult;
    return {
        Success: readField(planResult, "Success", "success"),
        Message: readField(planResult, "Message", "message"),
        Error: readField(planResult, "Error", "error"),
        PlanMode: readField(planResult, "PlanMode", "planMode"),
        PlanOpenMode: readField(planResult, "PlanOpenMode", "planOpenMode"),
        PlanOpenNote: readField(planResult, "PlanOpenNote", "planOpenNote"),
        SelectedPlan: compactView(readField(planResult, "SelectedPlan", "selectedPlan")),
        TargetView: compactView(readField(planResult, "TargetView", "targetView")),
        ActiveView: compactView(readField(planResult, "ActiveView", "activeView")),
        ActiveViewChanged: readField(planResult, "ActiveViewChanged", "activeViewChanged"),
        ActivePlanMatchesElementLevel: readField(planResult, "ActivePlanMatchesElementLevel", "activePlanMatchesElementLevel"),
        PlanSelectionReason: readField(planResult, "PlanSelectionReason", "planSelectionReason"),
        ZoomMethod: readField(planResult, "ZoomMethod", "zoomMethod"),
        Selected: readField(planResult, "Selected", "selected"),
        Zoomed: readField(planResult, "Zoomed", "zoomed"),
        FitToScreen: readField(planResult, "FitToScreen", "fitToScreen"),
        FitToScreenWarning: readField(planResult, "FitToScreenWarning", "fitToScreenWarning"),
        PlanVisibilityWarning: readField(planResult, "PlanVisibilityWarning", "planVisibilityWarning"),
        FocusWarning: readField(planResult, "FocusWarning", "focusWarning"),
        PlanCandidatesTotal: readField(planResult, "PlanCandidatesTotal", "planCandidatesTotal"),
        PlanCandidatesTruncated: readField(planResult, "PlanCandidatesTruncated", "planCandidatesTruncated"),
    };
}

function summarizeThreeD(threeDResult: any) {
    if (!threeDResult || typeof threeDResult !== "object") return threeDResult;
    return {
        Success: readField(threeDResult, "Success", "success"),
        Message: readField(threeDResult, "Message", "message"),
        Error: readField(threeDResult, "Error", "error"),
        TargetView: compactView(readField(threeDResult, "TargetView", "targetView")),
        ActiveView: compactView(readField(threeDResult, "ActiveView", "activeView")),
        CreatedView: readField(threeDResult, "CreatedView", "createdView"),
        ReusedView: readField(threeDResult, "ReusedView", "reusedView"),
        SectionBoxApplied: readField(threeDResult, "SectionBoxApplied", "sectionBoxApplied"),
        SectionBoxState: readField(threeDResult, "SectionBoxState", "sectionBoxState"),
        CameraOrientation: readField(threeDResult, "CameraOrientation", "cameraOrientation"),
        CameraApplied: readField(threeDResult, "CameraApplied", "cameraApplied"),
        CameraWarning: readField(threeDResult, "CameraWarning", "cameraWarning"),
        ZoomMethod: readField(threeDResult, "ZoomMethod", "zoomMethod"),
        Selected: readField(threeDResult, "Selected", "selected"),
        Zoomed: readField(threeDResult, "Zoomed", "zoomed"),
    };
}

function firstResultContractVersion(...payloads: any[]) {
    for (const payload of payloads) {
        const raw = readField(payload, "ResultContractVersion", "resultContractVersion");
        const parsed = Number.parseInt(String(raw ?? ""), 10);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return null;
}

function workflowPayload(args: {
    success: boolean;
    guarded?: boolean;
    message?: string;
    error?: string;
    chosenElementId?: string | number;
    chosenElement?: JsonObject | null;
    find?: JsonObject | null;
    plan?: JsonObject | null;
    threeD?: JsonObject | null;
    ambiguous?: boolean;
    candidates?: JsonObject[];
}) {
    const guarded = args.guarded === true;
    return {
        success: args.success,
        guarded,
        state: guarded ? "guarded" : args.success ? "completed" : "failed",
        action: "show_element_in_plan_and_3d",
        message: args.message,
        error: args.error,
        resultContractVersion: firstResultContractVersion(args.find, args.plan, args.threeD),
        chosenElementId: args.chosenElementId,
        chosenElement: args.chosenElement,
        find: args.find,
        plan: args.plan,
        threeD: args.threeD,
        ambiguous: args.ambiguous,
        candidates: args.candidates,
    };
}

export function registerShowElementInPlanAnd3DTool(server: ToolServer) {
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
            let chosenElementId: string | number | undefined = args.elementId;
            let chosenElement: JsonObject | null = null;
            let findResult: JsonObject | null = null;

            if (!chosenElementId) {
                if (!args.query && (!args.categoryNames || args.categoryNames.length === 0)) {
                    return formatJsonContent(workflowPayload({
                        success: false,
                        guarded: true,
                        error: "Pass elementId, or pass query/categoryNames for a safe search.",
                    }));
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

                if (!findResult || !isSuccess(findResult)) {
                    return formatJsonContent(workflowPayload({
                        success: false,
                        error: readField(findResult, "Error", "error") || "Element search failed.",
                        find: findResult,
                    }));
                }

                const candidates: JsonObject[] = Array.isArray(readField(findResult, "Elements", "elements"))
                    ? readField(findResult, "Elements", "elements")
                    : [];
                if (candidates.length === 0) {
                    return formatJsonContent(workflowPayload({
                        success: false,
                        guarded: true,
                        error: "No matching elements were found.",
                        find: findResult,
                    }));
                }

                if (readField(findResult, "Ambiguous", "ambiguous") && args.allowAmbiguous !== true) {
                    return formatJsonContent(workflowPayload({
                        success: false,
                        guarded: true,
                        error: "Multiple plausible elements matched. Use a more specific query or pass elementId before opening views.",
                        ambiguous: true,
                        find: findResult,
                        candidates,
                    }));
                }

                chosenElement = candidates[0] || null;
                if (!chosenElement) {
                    return formatJsonContent(workflowPayload({
                        success: false,
                        guarded: true,
                        error: "No usable element candidate was returned.",
                        find: findResult,
                    }));
                }
                chosenElementId = readField(chosenElement, "Id", "id");
            }

            if (chosenElementId === undefined || chosenElementId === null) {
                return formatJsonContent(workflowPayload({
                    success: false,
                    guarded: true,
                    error: "No element id was resolved.",
                    find: findResult,
                }));
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

            if (!planResult || !isSuccess(planResult)) {
                return formatJsonContent(workflowPayload({
                    success: false,
                    guarded: isGuardedResult(planResult),
                    error: readField(planResult, "Error", "error") || "Plan presentation failed.",
                    chosenElementId,
                    chosenElement,
                    find: findResult,
                    plan: planResult,
                }));
            }

            let threeDResult: JsonObject | null = null;
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

            const threeDSuccess = args.create3d === false || isSuccess(threeDResult);
            const fullPayload = trimPlanCandidatesInPayload(workflowPayload({
                success: threeDSuccess,
                message: args.create3d === false
                    ? "Element was shown in an existing plan."
                    : threeDSuccess
                        ? "Element was shown in an existing plan and focused in 3D."
                        : "Element was shown in plan, but the 3D step failed.",
                chosenElementId,
                chosenElement,
                find: findResult,
                plan: planResult,
                threeD: threeDResult,
            }), {
                verboseCandidates: args.verboseCandidates,
                maxPlanCandidates: args.maxPlanCandidates ?? 3,
            });

            if (args.responseMode === "full" || !threeDSuccess) {
                return formatJsonContent(fullPayload);
            }

            return formatJsonContent({
                success: readField(fullPayload, "Success", "success"),
                guarded: readField(fullPayload, "Guarded", "guarded") === true,
                state: readField(fullPayload, "State", "state"),
                action: readField(fullPayload, "Action", "action"),
                message: readField(fullPayload, "Message", "message"),
                error: readField(fullPayload, "Error", "error"),
                resultContractVersion: readField(fullPayload, "ResultContractVersion", "resultContractVersion"),
                responseMode: "compact",
                chosenElementId,
                chosenElement: compactElement(chosenElement),
                findSummary: summarizeFind(findResult),
                planSummary: summarizePlan(planResult),
                threeDSummary: summarizeThreeD(threeDResult),
            });
        }
        catch (error) {
            return formatJsonContent(workflowPayload({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            }));
        }
    });
}
