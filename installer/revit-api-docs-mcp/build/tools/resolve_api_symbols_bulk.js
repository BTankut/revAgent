import { z } from "zod";
import { getMemberDetails, getTypeDetails, listNamespace, searchApi, } from "../utils/docIndex.js";
const symbolSchema = z.object({
    mode: z.enum(["search", "type", "member", "namespace"]),
    query: z.string().optional(),
    kind: z.enum(["namespace", "type", "constructor", "method", "property", "field", "event"]).optional(),
    type_name: z.string().optional(),
    member_name: z.string().optional(),
    namespace: z.string().optional(),
    include_inherited: z.boolean().optional(),
    include_child_namespaces: z.boolean().optional(),
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
        return await getTypeDetails({
            typeName: symbol.type_name || symbol.query,
            revitVersion,
            includeInherited: symbol.include_inherited,
        });
    }
    if (symbol.mode === "member") {
        if (!symbol.member_name && !symbol.query) {
            throw new Error("member mode requires member_name or query");
        }
        return await getMemberDetails({
            memberName: symbol.member_name || symbol.query,
            typeName: symbol.type_name,
            kind: symbol.kind,
            revitVersion,
        });
    }
    if (symbol.mode === "namespace") {
        if (!symbol.namespace && !symbol.query) {
            throw new Error("namespace mode requires namespace or query");
        }
        return await listNamespace({
            namespaceName: symbol.namespace || symbol.query,
            revitVersion,
            includeChildNamespaces: symbol.include_child_namespaces,
        });
    }
    throw new Error(`Unsupported mode: ${symbol.mode}`);
}
export function registerResolveApiSymbolsBulkTool(server) {
    server.tool("resolve_api_symbols_bulk", "Resolve multiple Revit API searches/types/members/namespaces in one call, preserving input order.", {
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
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: true,
                        revitVersion: args.revit_version,
                        results,
                    }, null, 2),
                },
            ],
        };
    });
}
