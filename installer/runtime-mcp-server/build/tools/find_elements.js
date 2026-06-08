import { z } from "zod";
import { connectionTargetSchema, executionOptionsFromArgs, formatJsonContent, readCasedField as readField, sendRevitCommand, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
import { buildFindElementsSearchPolicy, buildGuardedNeedsScopePayload, } from "../utils/searchPolicy.js";
import { boundedPositiveInt, compactObjectRows, isDetailedResponseMode, responseModeSchema, stableRowKey, } from "../utils/responseMode.js";
const DEFAULT_COMPACT_RESULT_ROWS = 25;
const DEFAULT_COMPACT_PLAN_CANDIDATE_SUMMARY_ROWS = 25;
function addWriteSafetyGuidance(payload) {
    if (!payload || typeof payload !== "object")
        return payload;
    const success = readField(payload, "Success", "success");
    if (success === false)
        return payload;
    const count = Number(payload.count ?? payload.Count ?? 0);
    const truncated = Boolean(payload.truncated ?? payload.Truncated);
    const ambiguous = Boolean(payload.ambiguous ?? payload.Ambiguous);
    const topConfidence = String(payload.topConfidence ?? payload.TopConfidence ?? "");
    const warning = "find_elements is discovery-only and is not sufficient evidence for parameter writes. Before writing, inspect the target with inspect_elements and inspect_parameter_schema using exact matching, then choose a stable element id and parameter identity. Do not write from a visible/display parameter name alone.";
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
function elementKey(row) {
    const key = row.id ?? row.Id ?? row.uniqueId ?? row.UniqueId ?? row.elementId ?? row.ElementId;
    return key !== undefined && key !== null && key !== ""
        ? String(key)
        : stableRowKey(row);
}
function planCandidateFieldName(element) {
    return Array.isArray(element.planCandidates)
        ? "planCandidates"
        : Array.isArray(element.PlanCandidates) ? "PlanCandidates" : null;
}
function readFirst(row, ...keys) {
    for (const key of keys) {
        if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
            return row[key];
        }
    }
    return undefined;
}
function omitUndefined(row) {
    return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}
function planCandidateKey(row) {
    const id = readFirst(row, "id", "Id", "viewId", "ViewId", "elementId", "ElementId");
    if (id !== undefined) {
        return String(id);
    }
    const name = readFirst(row, "name", "Name", "viewName", "ViewName");
    const level = readFirst(row, "levelId", "LevelId", "levelName", "LevelName");
    if (name !== undefined || level !== undefined) {
        return `${String(name ?? "")}|${String(level ?? "")}`;
    }
    return stableRowKey(row);
}
function compactPlanCandidateRow(row, key) {
    return omitUndefined({
        ref: key,
        id: readFirst(row, "id", "Id", "viewId", "ViewId", "elementId", "ElementId"),
        name: readFirst(row, "name", "Name", "viewName", "ViewName"),
        viewType: readFirst(row, "viewType", "ViewType"),
        levelId: readFirst(row, "levelId", "LevelId"),
        levelName: readFirst(row, "levelName", "LevelName"),
        score: readFirst(row, "score", "Score", "rankScore", "RankScore"),
        rank: readFirst(row, "rank", "Rank"),
        elementVisibleInView: readFirst(row, "elementVisibleInView", "ElementVisibleInView"),
        reason: readFirst(row, "reason", "Reason", "matchReason", "MatchReason"),
    });
}
function compactPlanCandidateRef(row, key) {
    return { ref: key };
}
function compactElementPlanReferences(element, perElementLimit, candidateByKey) {
    const fieldName = planCandidateFieldName(element);
    if (!fieldName) {
        return { element, totalCandidateRows: 0, omittedCandidateRows: 0 };
    }
    const rawCandidates = element[fieldName].filter((row) => Boolean(row) && typeof row === "object" && !Array.isArray(row));
    const refs = [];
    for (const row of rawCandidates) {
        const key = planCandidateKey(row);
        if (!candidateByKey.has(key)) {
            candidateByKey.set(key, compactPlanCandidateRow(row, key));
        }
        if (refs.length < perElementLimit) {
            refs.push(compactPlanCandidateRef(row, key));
        }
    }
    const compactElement = { ...element };
    delete compactElement.planCandidates;
    delete compactElement.PlanCandidates;
    compactElement.planCandidateRefs = refs;
    compactElement.planCandidateCount = rawCandidates.length;
    compactElement.returnedPlanCandidateRefCount = refs.length;
    compactElement.omittedPlanCandidateRefCount = Math.max(0, rawCandidates.length - refs.length);
    return {
        element: compactElement,
        totalCandidateRows: rawCandidates.length,
        omittedCandidateRows: Math.max(0, rawCandidates.length - refs.length),
    };
}
export function compactFindElementsResult(payload, args) {
    const responseMode = args.responseMode || "compact";
    if (!payload || typeof payload !== "object" || isDetailedResponseMode(responseMode)) {
        return {
            ...payload,
            responseMode,
        };
    }
    const elementField = Array.isArray(payload.elements)
        ? "elements"
        : Array.isArray(payload.Elements) ? "Elements" : null;
    if (!elementField) {
        return {
            ...payload,
            responseMode: "compact",
        };
    }
    const limit = boundedPositiveInt(args.maxResultRows ?? args.limit, DEFAULT_COMPACT_RESULT_ROWS, 200);
    const planLimit = boundedPositiveInt(args.maxPlanCandidates, 3, 25);
    const planSummaryLimit = boundedPositiveInt(args.maxPlanCandidateSummaryRows, Math.max(DEFAULT_COMPACT_PLAN_CANDIDATE_SUMMARY_ROWS, planLimit), 100);
    const elements = compactObjectRows(payload[elementField], {
        limit,
        key: elementKey,
    });
    const candidateByKey = new Map();
    let totalPlanCandidateRows = 0;
    let omittedPlanCandidateRefs = 0;
    const compactElements = elements.rows.map((element) => {
        const compacted = compactElementPlanReferences(element, planLimit, candidateByKey);
        totalPlanCandidateRows += compacted.totalCandidateRows;
        omittedPlanCandidateRefs += compacted.omittedCandidateRows;
        return compacted.element;
    });
    const uniquePlanCandidates = compactObjectRows(Array.from(candidateByKey.values()), {
        limit: planSummaryLimit,
        key: (row) => String(row.ref ?? stableRowKey(row)),
    });
    return {
        ...payload,
        responseMode: "compact",
        [elementField]: compactElements,
        planCandidateSummary: {
            compactResponse: true,
            candidateRowCount: totalPlanCandidateRows,
            uniqueCandidateCount: candidateByKey.size,
            returnedCandidateCount: uniquePlanCandidates.returnedCount,
            omittedCandidateCount: uniquePlanCandidates.omittedCount,
            duplicateCandidateRowCount: Math.max(0, totalPlanCandidateRows - candidateByKey.size),
            omittedElementCandidateRefCount: omittedPlanCandidateRefs,
            candidates: uniquePlanCandidates.rows,
        },
        summary: {
            ...(payload.summary || payload.Summary || {}),
            compactResponse: true,
            elementRowCount: elements.totalCount,
            returnedElementRowCount: elements.returnedCount,
            omittedElementRowCount: elements.omittedCount,
            duplicateElementRowCount: elements.duplicateCount,
            planCandidateRowCount: totalPlanCandidateRows,
            uniquePlanCandidateCount: candidateByKey.size,
            returnedPlanCandidateCount: uniquePlanCandidates.returnedCount,
            omittedPlanCandidateCount: uniquePlanCandidates.omittedCount,
        },
        notices: [
            ...(Array.isArray(payload.notices) ? payload.notices : []),
            "Compact response bounds element rows and deduplicates plan candidates into planCandidateSummary. Use responseMode=\"full\" for per-element plan candidate details.",
        ],
    };
}
export function registerFindElementsTool(server) {
    server.tool("find_elements", "Find Revit elements by MEP-aware progressive discovery. The tool infers obvious engineering scope first, e.g. fan coil/FCU -> Mechanical Equipment, uses API-level category/view filters plus safe in-memory level filters in the Revit bridge, keeps planCandidateMode=none by default, and asks for allowExpensiveSearch/searchBudget=deep before broad, linked, or verified visibility scans. Default responseMode=compact bounds element rows and deduplicates plan candidates into planCandidateSummary; use responseMode=full for per-element plan candidate details. Discovery-only: inspect exact elements and parameter schema before writes.", {
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
        planCandidateMode: z.enum(["none", "metadata", "verified"]).optional().describe("Plan candidate strategy. none is fastest and default. metadata ranks same-level plans without verifying element visibility. verified confirms visibility in plan views and is allowed only for exact element targets or explicit expensive-search approval."),
        maxPlanCandidates: z.number().int().min(0).max(25).optional().describe("Maximum ranked plan candidates per element when planCandidateMode is metadata/verified or includePlanCandidates=true. Defaults 3."),
        planNameContains: z.string().optional().describe("Optional plan name preference used when ranking plan candidates."),
        limit: z.number().int().positive().max(200).optional().describe("Maximum elements to return. Defaults 20."),
        responseMode: responseModeSchema,
        maxResultRows: z.number().int().positive().max(200).optional().describe("Compact-mode cap for returned element rows. Defaults to limit or 25; full/debug returns all native rows within limit."),
        maxPlanCandidateSummaryRows: z.number().int().positive().max(100).optional().describe("Compact-mode cap for the deduplicated top-level planCandidateSummary rows. Defaults 25 so global plan candidates are not capped by the per-element maxPlanCandidates limit."),
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
                allowExpensiveSearch: policy.allowExpensiveSearch,
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
                    allowExpensiveSearch: policy.allowExpensiveSearch,
                };
                payload.suggestedNextScopes = payload.suggestedNextScopes || policy.suggestedNextScopes;
                payload.warnings = [...new Set([...(Array.isArray(payload.warnings) ? payload.warnings : []), ...policy.warnings])];
            }
            return formatJsonContent(compactFindElementsResult(addWriteSafetyGuidance(payload), args));
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
