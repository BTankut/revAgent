import { z } from "zod";
import { connectionTargetSchema, executionOptionsFromArgs, formatJsonContent, sendRevitCommand, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
export function registerFindElementsTool(server) {
    server.tool("find_elements", "Find Revit elements by category and text across element name, family, type, mark, comments, and id. Returns match score/confidence/reason fields so ambiguous large-project results can be disambiguated before writes.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        query: z.string().optional().describe("Text to search in id, unique id, name, category, family, type, mark, and comments."),
        categoryNames: z.array(z.string()).optional().describe("Category name filters, matched case-insensitively by contains, e.g. Mechanical Equipment, Ducts, Air Terminals."),
        includePlanCandidates: z.boolean().optional().describe("Include existing non-template plan views on each matched element level. Defaults true."),
        planNameContains: z.string().optional().describe("Optional plan name preference used when ranking plan candidates."),
        limit: z.number().int().positive().max(200).optional().describe("Maximum elements to return. Defaults 20."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Socket timeout in milliseconds. Defaults 120000."),
    }, async (args) => {
        try {
            const response = await sendRevitCommand("find_elements", {
                query: args.query,
                categoryNames: args.categoryNames,
                includePlanCandidates: args.includePlanCandidates,
                planNameContains: args.planNameContains,
                limit: args.limit,
                timeoutMs: args.timeoutMs,
            }, {
                ...executionOptionsFromArgs(args, "Find Revit elements"),
            });
            return formatJsonContent(response && response.result ? response.result : response);
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
