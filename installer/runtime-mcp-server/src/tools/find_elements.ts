import type { ToolServer } from "./types.js";
import { z } from "zod";
import {
    connectionTargetSchema,
    executionOptionsFromArgs,
    formatJsonContent,
    readCasedField as readField,
    sendRevitCommand,
    taskMetadataSchema,
} from "../utils/revitToolHelpers.js";
import {
    buildFindElementsSearchPolicy,
    buildGuardedNeedsScopePayload,
} from "../utils/searchPolicy.js";

function addWriteSafetyGuidance(payload: any) {
    if (!payload || typeof payload !== "object") return payload;
    const success = readField(payload, "Success", "success");
    if (success === false) return payload;

    const count = Number(payload.count ?? payload.Count ?? 0);
    const truncated = Boolean(payload.truncated ?? payload.Truncated);
    const ambiguous = Boolean(payload.ambiguous ?? payload.Ambiguous);
    const topConfidence = String(payload.topConfidence ?? payload.TopConfidence ?? "");
    const warning =
        "find_elements is discovery-only and is not sufficient evidence for parameter writes. Before writing, inspect the target with inspect_elements and inspect_parameter_schema using exact matching, then choose a stable element id and parameter identity. Do not write from a visible/display parameter name alone.";

    payload.writeSafetyWarning = warning;
    payload.writeSafety = {
        sufficientForWrite: false,
        requiresExactElementIdentity: true,
        requiresParameterSchemaPreflight: true,
        requiredPreflightTools: ["inspect_elements", "inspect_parameter_schema"],
        parameterIdentityRule: "Use builtInParameterId when available; otherwise confirm source/shared/storage/readOnly identity. Display name alone is not a write target.",
        resultRisk: {
            count,
            truncated,
            ambiguous,
            topConfidence,
        },
    };

    if (typeof payload.SelectionHint === "string" && !payload.SelectionHint.includes("find_elements is discovery-only")) {
        payload.SelectionHint = `${payload.SelectionHint} ${warning}`;
    }
    if (typeof payload.selectionHint === "string" && !payload.selectionHint.includes("find_elements is discovery-only")) {
        payload.selectionHint = `${payload.selectionHint} ${warning}`;
    }

    return payload;
}

export function registerFindElementsTool(server: ToolServer) {
    server.tool("find_elements", "Find Revit elements by MEP-aware progressive discovery. The tool infers obvious engineering scope first, e.g. fan coil/FCU -> Mechanical Equipment, uses API-level category/view filters in the Revit bridge, keeps planCandidateMode=none by default, and asks for allowExpensiveSearch/searchBudget=deep only before broad or linked scans. Discovery-only: inspect exact elements and parameter schema before writes.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        query: z.string().optional().describe("Text to search in id, unique id, name, category, family, type, mark, and comments."),
        categoryNames: z.array(z.string()).optional().describe("Category name filters, matched case-insensitively by contains, e.g. Mechanical Equipment, Ducts, Air Terminals. If omitted, common MEP terms such as fan coil/FCU, valve, damper, duct, pipe, sprinkler, pump, and AHU are inferred into a bounded category scope."),
        elementIds: z.array(z.union([z.number(), z.string()])).optional().describe("Exact element ids to inspect first when known."),
        uniqueIds: z.array(z.string()).optional().describe("Exact Revit unique ids to inspect first when known."),
        levelNames: z.array(z.string()).optional().describe("Restrict results to matching element level names, e.g. Level 08."),
        levelIds: z.array(z.union([z.number(), z.string()])).optional().describe("Restrict results to exact Revit level element ids."),
        activeViewOnly: z.boolean().optional().describe("Search only elements visible/owned in the active view when true. Preferred for large models when the user is already looking at the target area."),
        viewId: z.union([z.number(), z.string()]).optional().describe("Search only elements visible/owned in this view id."),
        familyName: z.string().optional().describe("Optional family-name filter applied before text scoring."),
        typeName: z.string().optional().describe("Optional type-name filter applied before text scoring."),
        systemName: z.string().optional().describe("Optional MEP system-name filter applied before text scoring when available."),
        worksetNames: z.array(z.string()).optional().describe("Optional workset-name filters for workshared production models."),
        worksetIds: z.array(z.union([z.number(), z.string()])).optional().describe("Optional exact workset ids for workshared production models."),
        linkScope: z.enum(["hostOnly", "linkedOnly", "hostAndLinked"]).optional().describe("Host model is searched by default. Linked model search is explicit and may require allowExpensiveSearch/searchBudget=deep on broad requests."),
        modelSignals: z.object({
            linkCount: z.number().int().nonnegative().optional(),
            linkInstances: z.number().int().nonnegative().optional(),
            loadedLinks: z.number().int().nonnegative().optional(),
            worksetCount: z.number().int().nonnegative().optional(),
            sheetCount: z.number().int().nonnegative().optional(),
            scheduleCount: z.number().int().nonnegative().optional(),
        }).optional().describe("Optional cheap large-model signals from prior context. This never triggers new category counts; it only lets the risk policy use already-known link/workset/sheet/schedule counts."),
        searchBudget: z.enum(["fast", "balanced", "deep"]).optional().describe("Preset scan/elapsed budget. fast is default for first-pass discovery; balanced/deep intentionally allow larger scans."),
        allowExpensiveSearch: z.boolean().optional().describe("Explicit operator approval for broad, linked, all-model, or verified searches that may take longer."),
        maxElementsScanned: z.number().int().positive().max(500000).optional().describe("Advanced override for the Revit-side scan cap. Prefer searchBudget for ordinary LLM use."),
        maxElapsedMs: z.number().int().positive().max(119000).optional().describe("Advanced override for the Revit-side elapsed budget. This is clamped below socket timeout so partial results can return before transport timeout."),
        includePlanCandidates: z.boolean().optional().describe("Include existing non-template plan views on each matched element level. Defaults false because view-visibility checks are intentionally expensive."),
        planCandidateMode: z.enum(["none", "metadata", "verified"]).optional().describe("Plan candidate strategy. none is fastest and default. metadata ranks same-level plans without verifying element visibility. verified confirms the element is visible in each view and is slower."),
        maxPlanCandidates: z.number().int().min(0).max(25).optional().describe("Maximum ranked plan candidates per element when planCandidateMode is metadata/verified or includePlanCandidates=true. Defaults 3."),
        planNameContains: z.string().optional().describe("Optional plan name preference used when ranking plan candidates."),
        limit: z.number().int().positive().max(200).optional().describe("Maximum elements to return. Defaults 20."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs."),
    }, async (args) => {
        try {
            const policy = buildFindElementsSearchPolicy(args);
            if (policy.guarded) {
                return formatJsonContent(addWriteSafetyGuidance(buildGuardedNeedsScopePayload(policy)));
            }
            const response = await sendRevitCommand("find_elements", {
                originalQuery: policy.originalQuery,
                query: policy.effectiveQuery,
                categoryNames: policy.effectiveCategoryNames,
                inferredScope: policy.inferredScope,
                elementIds: args.elementIds,
                uniqueIds: args.uniqueIds,
                levelNames: args.levelNames,
                levelIds: args.levelIds,
                activeViewOnly: args.activeViewOnly === true,
                viewId: args.viewId,
                familyName: args.familyName,
                typeName: args.typeName,
                systemName: args.systemName,
                worksetNames: args.worksetNames,
                worksetIds: args.worksetIds,
                linkScope: policy.linkScope,
                searchBudget: policy.searchBudget,
                allowExpensiveSearch: args.allowExpensiveSearch === true,
                maxElementsScanned: policy.maxElementsScanned,
                maxElapsedMs: policy.maxElapsedMs,
                includePlanCandidates: args.includePlanCandidates === true,
                planCandidateMode: args.planCandidateMode || (args.includePlanCandidates === true ? "verified" : "none"),
                maxPlanCandidates: args.maxPlanCandidates ?? 3,
                planNameContains: args.planNameContains,
                limit: args.limit,
                timeoutMs: policy.timeoutMs,
            }, {
                ...executionOptionsFromArgs({
                    ...args,
                    timeoutMs: policy.timeoutMs,
                }, "Find Revit elements"),
            });
            const payload = response && response.result ? response.result : response;
            if (payload && typeof payload === "object") {
                payload.inferredScope = payload.inferredScope || policy.inferredScope;
                payload.effectiveScope = payload.effectiveScope || {
                    categoryNames: policy.effectiveCategoryNames,
                    linkScope: policy.linkScope,
                };
                payload.riskPolicy = payload.riskPolicy || policy.riskPolicy;
                payload.scanPolicy = payload.scanPolicy || {
                    searchBudget: policy.searchBudget,
                    maxElementsScanned: policy.maxElementsScanned,
                    maxElapsedMs: policy.maxElapsedMs,
                    timeoutMs: policy.timeoutMs,
                    allowExpensiveSearch: args.allowExpensiveSearch === true,
                };
                payload.suggestedNextScopes = payload.suggestedNextScopes || policy.suggestedNextScopes;
                payload.warnings = [...new Set([...(Array.isArray(payload.warnings) ? payload.warnings : []), ...policy.warnings])];
            }
            return formatJsonContent(addWriteSafetyGuidance(payload));
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
