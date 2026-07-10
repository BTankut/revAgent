import { z } from "zod";
import { getMemberDetails, getTypeDetails, listNamespace, searchApi, } from "../utils/docIndex.js";
import { compactTypeDetailsResult } from "./get_type_details.js";
import { formatJsonToolResult } from "./tool_result.js";
const symbolSchema = z.object({
    mode: z.enum(["search", "type", "member", "namespace"]),
    query: z.string().optional(),
    kind: z.enum(["namespace", "type", "constructor", "method", "property", "field", "event"]).optional(),
    type_name: z.string().optional(),
    member_name: z.string().optional(),
    namespace: z.string().optional(),
    include_inherited: z.boolean().optional(),
    include_child_namespaces: z.boolean().optional(),
    response_mode: z.enum(["compact", "full", "debug"]).optional(),
    max_members_per_group: z.number().int().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
});
async function resolveSymbol(revitVersion, symbol) {
    if (symbol.mode === "search") {
        if (!symbol.query) {
            throw new Error("search mode requires query");
        }
        return await searchApi({
            query: symbol.query,
            kind: symbol.kind,
            revitVersion,
            limit: symbol.limit,
        });
    }
    if (symbol.mode === "type") {
        if (!symbol.type_name && !symbol.query) {
            throw new Error("type mode requires type_name or query");
        }
        const typeName = symbol.type_name || symbol.query;
        if (!typeName) {
            throw new Error("type mode requires type_name or query");
        }
        const result = await getTypeDetails({
            typeName,
            revitVersion,
            includeInherited: symbol.include_inherited,
        });
        return compactTypeDetailsResult(result, {
            responseMode: symbol.response_mode,
            maxMembersPerGroup: symbol.max_members_per_group,
        });
    }
    if (symbol.mode === "member") {
        if (!symbol.member_name && !symbol.query) {
            throw new Error("member mode requires member_name or query");
        }
        const memberName = symbol.member_name || symbol.query;
        if (!memberName) {
            throw new Error("member mode requires member_name or query");
        }
        return await getMemberDetails({
            memberName,
            typeName: symbol.type_name,
            kind: symbol.kind,
            revitVersion,
        });
    }
    if (symbol.mode === "namespace") {
        if (!symbol.namespace && !symbol.query) {
            throw new Error("namespace mode requires namespace or query");
        }
        const namespaceName = symbol.namespace || symbol.query;
        if (!namespaceName) {
            throw new Error("namespace mode requires namespace or query");
        }
        return await listNamespace({
            namespaceName,
            revitVersion,
            includeChildNamespaces: symbol.include_child_namespaces,
        });
    }
    throw new Error(`Unsupported mode: ${symbol.mode}`);
}
export function registerResolveApiSymbolsBulkTool(server) {
    server.tool("resolve_api_symbols_bulk", "Resolve multiple Revit API searches/types/members/namespaces in one call, preserving input order. Type results default to compact bounded member samples; set response_mode=full explicitly for every member row.", {
        revit_version: z.string().min(1).describe("Revit version to resolve against, e.g. 2022."),
        symbols: z.array(symbolSchema).min(1).max(25).describe("Symbols to resolve in order."),
    }, async (args) => {
        const results = [];
        for (let index = 0; index < args.symbols.length; index++) {
            const symbol = args.symbols[index];
            try {
                results.push({
                    index,
                    mode: symbol.mode,
                    ok: true,
                    result: await resolveSymbol(args.revit_version, symbol),
                });
            }
            catch (error) {
                results.push({
                    index,
                    mode: symbol.mode,
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        const succeededCount = results.filter((result) => result.ok === true).length;
        const failedCount = results.length - succeededCount;
        const allFailed = succeededCount === 0;
        const payload = {
            success: failedCount === 0,
            state: allFailed ? "failed" : failedCount > 0 ? "partial" : "completed",
            action: "resolve_api_symbols_bulk",
            partial: succeededCount > 0 && failedCount > 0,
            revitVersion: args.revit_version,
            totalCount: results.length,
            succeededCount,
            failedCount,
            results,
        };
        if (allFailed) {
            payload.error = "All requested Revit API symbols failed to resolve.";
        }
        return formatJsonToolResult(payload, { isError: allFailed });
    });
}
