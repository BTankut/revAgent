import type { ToolServer } from "./types.js";
import { z } from "zod";
import { getTypeDetails } from "../utils/docIndex.js";
import { formatJsonToolResult, formatToolFailure } from "./tool_result.js";

type JsonObject = Record<string, any>;
type ResponseMode = "compact" | "full" | "debug";
const DEFAULT_MAX_MEMBERS_PER_GROUP = 20;

function responseModeFor(value: unknown): ResponseMode {
    return value === "full" || value === "debug" ? value : "compact";
}

function boundedPositiveInt(value: unknown, fallback: number, max: number): number {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.max(1, Math.min(max, parsed));
}

function compactMemberGroups(groups: unknown, limit: number) {
    const result: JsonObject = {};
    const counts: JsonObject = {};
    const omittedCounts: JsonObject = {};
    if (!groups || typeof groups !== "object" || Array.isArray(groups)) {
        return { groups: result, counts, omittedCounts };
    }
    for (const [key, value] of Object.entries(groups as JsonObject)) {
        const rows = Array.isArray(value) ? value : [];
        result[key] = rows.slice(0, limit);
        counts[key] = rows.length;
        omittedCounts[key] = Math.max(0, rows.length - limit);
    }
    return { groups: result, counts, omittedCounts };
}

export function compactTypeDetailsResult(result: unknown, options: { responseMode?: unknown; maxMembersPerGroup?: unknown } = {}) {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
        return result;
    }
    const payload = result as JsonObject;
    const responseMode = responseModeFor(options.responseMode);
    if (responseMode === "full" || responseMode === "debug") {
        return {
            ...payload,
            responseMode,
        };
    }
    const maxMembersPerGroup = boundedPositiveInt(options.maxMembersPerGroup, DEFAULT_MAX_MEMBERS_PER_GROUP, 200);
    if (payload.ambiguous === true) {
        const matches = Array.isArray(payload.matches) ? payload.matches : [];
        return {
            ...payload,
            responseMode: "compact",
            matches: matches.slice(0, maxMembersPerGroup),
            matchCount: matches.length,
            omittedMatchCount: Math.max(0, matches.length - maxMembersPerGroup),
        };
    }
    const declared = compactMemberGroups(payload.declaredMembers, maxMembersPerGroup);
    const inheritedMembers = Array.isArray(payload.inheritedMembers)
        ? payload.inheritedMembers
            .filter((entry): entry is JsonObject => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
            .map((entry) => {
            const compact = compactMemberGroups(entry.members, maxMembersPerGroup);
            return {
                declaringType: entry.declaringType,
                members: compact.groups,
                memberCounts: compact.counts,
                omittedMemberCounts: compact.omittedCounts,
            };
        })
        : [];
    return {
        ...payload,
        responseMode: "compact",
        compactResponse: true,
        maxMembersPerGroup,
        declaredMembers: declared.groups,
        declaredMemberCounts: declared.counts,
        declaredOmittedMemberCounts: declared.omittedCounts,
        inheritedMembers,
        fullResponseHint: "Use response_mode=\"full\" for all declared/inherited member rows.",
    };
}

export function registerGetTypeDetailsTool(server: ToolServer) {
    server.tool("get_type_details", "Get information about a Revit API type, including declared members and XML documentation. Default response_mode=compact returns bounded member samples plus counts; use response_mode=full for all type/member rows.", {
        type_name: z.string().min(1).describe("Type name to resolve. Supports full names like Autodesk.Revit.DB.Wall or simple names like Wall."),
        revit_version: z.string().optional().describe("Optional Revit version. Defaults to 2022."),
        include_inherited: z.boolean().optional().describe("When true, include members declared on base types."),
        response_mode: z.enum(["compact", "full", "debug"]).optional().describe("Response shape. compact is the default; full/debug returns all member groups."),
        max_members_per_group: z.number().int().positive().max(200).optional().describe("Compact-mode cap for each declared/inherited member group. Defaults 20."),
    }, async (args) => {
        try {
            const result = await getTypeDetails({
                typeName: args.type_name,
                revitVersion: args.revit_version,
                includeInherited: args.include_inherited,
            });
            const shapedResult = compactTypeDetailsResult(result, {
                responseMode: args.response_mode,
                maxMembersPerGroup: args.max_members_per_group,
            });
            return formatJsonToolResult(shapedResult);
        }
        catch (error) {
            return formatToolFailure("get_type_details", error);
        }
    });
}
