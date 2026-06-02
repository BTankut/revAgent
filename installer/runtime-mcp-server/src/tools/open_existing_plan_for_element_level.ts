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

function compactView(view: any) {
    if (!view || typeof view !== "object") return view;
    return {
        Id: readField(view, "Id", "id"),
        Name: readField(view, "Name", "name"),
        ViewType: readField(view, "ViewType", "viewType"),
        Scale: readField(view, "Scale", "scale"),
    };
}

function compactElement(element: any) {
    if (!element || typeof element !== "object") return element;
    return {
        Id: readField(element, "Id", "id"),
        Name: readField(element, "Name", "name"),
        Category: readField(element, "Category", "category"),
        ClassName: readField(element, "ClassName", "className"),
        FamilyName: readField(element, "FamilyName", "familyName"),
        TypeName: readField(element, "TypeName", "typeName"),
        LevelId: readField(element, "LevelId", "levelId"),
        LevelName: readField(element, "LevelName", "levelName"),
        Mark: readField(element, "Mark", "mark"),
        HasBoundingBox: readField(element, "HasBoundingBox", "hasBoundingBox"),
    };
}

function compactPlanResult(payload: any) {
    if (!payload || typeof payload !== "object") {
        return payload;
    }
    return {
        Success: readField(payload, "Success", "success"),
        Action: readField(payload, "Action", "action"),
        Message: readField(payload, "Message", "message"),
        Error: readField(payload, "Error", "error"),
        ResponseMode: "compact",
        PlanMode: readField(payload, "PlanMode", "planMode"),
        PlanCandidateMode: readField(payload, "PlanCandidateMode", "planCandidateMode"),
        FallbackUsed: readField(payload, "FallbackUsed", "fallbackUsed"),
        VerifiedCandidateCount: readField(payload, "VerifiedCandidateCount", "verifiedCandidateCount"),
        RejectedCandidateCount: readField(payload, "RejectedCandidateCount", "rejectedCandidateCount"),
        PlanOpenMode: readField(payload, "PlanOpenMode", "planOpenMode"),
        PlanOpenNote: readField(payload, "PlanOpenNote", "planOpenNote"),
        FocusBlocked: readField(payload, "FocusBlocked", "focusBlocked"),
        FocusBlockReason: readField(payload, "FocusBlockReason", "focusBlockReason"),
        FocusSuggestion: readField(payload, "FocusSuggestion", "focusSuggestion"),
        TargetView: compactView(readField(payload, "TargetView", "targetView")),
        SelectedPlan: compactView(readField(payload, "SelectedPlan", "selectedPlan")),
        SuggestedView: compactView(readField(payload, "SuggestedView", "suggestedView")),
        ActiveView: compactView(readField(payload, "ActiveView", "activeView")),
        ActiveViewChanged: readField(payload, "ActiveViewChanged", "activeViewChanged"),
        ActivePlanMatchesElementLevel: readField(payload, "ActivePlanMatchesElementLevel", "activePlanMatchesElementLevel"),
        LevelId: readField(payload, "LevelId", "levelId"),
        LevelName: readField(payload, "LevelName", "levelName"),
        PlanSelectionReason: readField(payload, "PlanSelectionReason", "planSelectionReason"),
        Selected: readField(payload, "Selected", "selected"),
        Zoomed: readField(payload, "Zoomed", "zoomed"),
        ZoomMethod: readField(payload, "ZoomMethod", "zoomMethod"),
        FitToScreen: readField(payload, "FitToScreen", "fitToScreen"),
        FitToScreenWarning: readField(payload, "FitToScreenWarning", "fitToScreenWarning"),
        PlanVisibilityWarning: readField(payload, "PlanVisibilityWarning", "planVisibilityWarning"),
        FocusWarning: readField(payload, "FocusWarning", "focusWarning"),
        Element: compactElement(readField(payload, "ElementInfo", "elementInfo")),
        PlanCandidatesTotal: readField(payload, "PlanCandidatesTotal", "planCandidatesTotal"),
        PlanCandidatesTruncated: readField(payload, "PlanCandidatesTruncated", "planCandidatesTruncated"),
    };
}

export function registerOpenExistingPlanForElementLevelTool(server: ToolServer) {
    server.tool("open_existing_plan_for_element_level", "Open the best existing non-template plan view for an element's level, then select and zoom to the element. This does not create a new view.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        elementId: elementIdSchema.describe("ElementId to locate in an existing plan view."),
        planMode: z.enum(["elementLevel", "activePlan"]).optional().describe("elementLevel opens the best existing plan on the element level. activePlan keeps the current active plan and does not switch to the element level. Defaults elementLevel."),
        planCandidateMode: z.enum(["metadataFirst", "verified"]).optional().describe("Plan selection strategy for elementLevel mode. metadataFirst is the default and ranks same-level plans without scanning every candidate view, then verifies a small number of ranked candidates. verified scans all candidate views before selecting and is slower."),
        fallbackToVerified: z.boolean().optional().describe("When metadataFirst cannot find a visible element within the limited ranked-candidate check, run the slower verified scan before failing. Defaults true."),
        maxMetadataVerifyCandidates: z.number().int().min(1).max(25).optional().describe("Maximum ranked metadata candidates verified before fallback. Defaults 5."),
        planNameContains: z.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level."),
        preferMechanical: z.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),
        select: z.boolean().optional().describe("Select the element after activating the plan. Defaults true."),
        zoom: z.boolean().optional().describe("Zoom/show the element after activating the plan. Defaults true."),
        fitToScreen: z.boolean().optional().describe("After opening/focusing the plan, run Revit UI ZoomToFit on the active view. Defaults false."),
        verboseCandidates: z.boolean().optional().describe("Return full PlanCandidates arrays. Defaults false; routine responses return only the top candidates."),
        maxPlanCandidates: z.number().int().min(0).max(50).optional().describe("Maximum PlanCandidates returned when verboseCandidates=false. Defaults 3."),
        responseMode: z.enum(["compact", "full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns the raw tool result."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Timeout for asynchronous plan activation/focus. Defaults 20000."),
    }, async (args) => {
        try {
            const response = await sendRevitCommand("open_existing_plan_for_element_level", {
                elementId: args.elementId,
                planMode: args.planMode,
                planCandidateMode: args.planCandidateMode,
                fallbackToVerified: args.fallbackToVerified,
                maxMetadataVerifyCandidates: args.maxMetadataVerifyCandidates,
                planNameContains: args.planNameContains,
                preferMechanical: args.preferMechanical,
                select: args.select,
                zoom: args.zoom,
                fitToScreen: args.fitToScreen,
                timeoutMs: args.timeoutMs,
            }, {
                ...executionOptionsFromArgs(args, "Open existing plan for element level"),
            });
            const payload = response && response.result ? response.result : response;
            const trimmedPayload = trimPlanCandidatesInPayload(payload, {
                verboseCandidates: args.verboseCandidates,
                maxPlanCandidates: args.maxPlanCandidates ?? 3,
            });
            if (args.responseMode === "full") {
                return formatJsonContent(trimmedPayload);
            }
            return formatJsonContent(compactPlanResult(trimmedPayload));
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
