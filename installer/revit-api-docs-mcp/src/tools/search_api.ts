import type { ToolServer } from "./types.js";
import { z } from "zod";
import { searchApi } from "../utils/docIndex.js";
import { formatJsonToolResult, formatToolFailure } from "./tool_result.js";

export function registerSearchApiTool(server: ToolServer) {
    server.tool("search_api", "Search the local Revit API index built from Revit assemblies and XML documentation.", {
        query: z.string().min(1).describe("Free-form search query such as 'Wall.Create', 'FilteredElementCollector', or 'Autodesk.Revit.DB.Plumbing'."),
        kind: z.enum(["namespace", "type", "constructor", "method", "property", "field", "event"]).optional().describe("Optional symbol kind filter."),
        assembly: z.string().optional().describe("Optional assembly name filter such as RevitAPI or RevitAPIUI."),
        revit_version: z.string().optional().describe("Optional Revit version. Defaults to 2022."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum number of results to return."),
    }, async (args) => {
        try {
            const result = await searchApi({
                query: args.query,
                kind: args.kind,
                assembly: args.assembly,
                revitVersion: args.revit_version,
                limit: args.limit,
            });
            return formatJsonToolResult(result);
        }
        catch (error) {
            return formatToolFailure("search_api", error);
        }
    });
}
