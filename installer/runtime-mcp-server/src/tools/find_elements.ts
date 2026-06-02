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
    server.tool("find_elements", "Find Revit elements by category and text across element name, family, type, mark, comments, and id. Returns match score/confidence/reason fields so ambiguous large-project results can be disambiguated before writes.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        query: z.string().optional().describe("Text to search in id, unique id, name, category, family, type, mark, and comments."),
        categoryNames: z.array(z.string()).optional().describe("Category name filters, matched case-insensitively by contains, e.g. Mechanical Equipment, Ducts, Air Terminals."),
        includePlanCandidates: z.boolean().optional().describe("Include existing non-template plan views on each matched element level. Defaults false because view-visibility checks are intentionally expensive."),
        planCandidateMode: z.enum(["none", "metadata", "verified"]).optional().describe("Plan candidate strategy. none is fastest and default. metadata ranks same-level plans without verifying element visibility. verified confirms the element is visible in each view and is slower."),
        maxPlanCandidates: z.number().int().min(0).max(25).optional().describe("Maximum ranked plan candidates per element when planCandidateMode is metadata/verified or includePlanCandidates=true. Defaults 3."),
        planNameContains: z.string().optional().describe("Optional plan name preference used when ranking plan candidates."),
        limit: z.number().int().positive().max(200).optional().describe("Maximum elements to return. Defaults 20."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Socket timeout in milliseconds. Defaults 120000."),
    }, async (args) => {
        try {
            const response = await sendRevitCommand("find_elements", {
                query: args.query,
                categoryNames: args.categoryNames,
                includePlanCandidates: args.includePlanCandidates === true,
                planCandidateMode: args.planCandidateMode || (args.includePlanCandidates === true ? "verified" : "none"),
                maxPlanCandidates: args.maxPlanCandidates ?? 3,
                planNameContains: args.planNameContains,
                limit: args.limit,
                timeoutMs: args.timeoutMs,
            }, {
                ...executionOptionsFromArgs(args, "Find Revit elements"),
            });
            return formatJsonContent(addWriteSafetyGuidance(response && response.result ? response.result : response));
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
