import { z } from "zod";
import { connectionTargetSchema, executionOptionsFromArgs, formatJsonContent, sendRevitCommand, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
export function registerDeleteReviewViewTool(server) {
    server.tool("delete_review_view", "[REVIEW_VIEW_CLEANUP_GUARDED] Dry-run or delete an explicit revAgent/Revit MCP review 3D view. Defaults to dryRun and only permits guarded cleanup of known review/focus/coordination/QA view names, including revAgent_QA_* views created by create_3d_view_for_elements; it blocks production views, active views, and open view tabs. Commit requires mode=\"commit\" and confirmDelete=true.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        viewId: z.number().int().positive().optional().describe("ElementId of the review 3D view to inspect or delete."),
        viewName: z.string().optional().describe("Exact review view name to inspect or delete when viewId is not supplied."),
        viewType: z.string().optional().describe("Optional Revit ViewType filter. Review cleanup is limited to non-template ThreeD views."),
        exactName: z.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),
        mode: z.enum(["dryRun", "commit"]).optional().describe("dryRun reports whether the view is eligible for cleanup. commit deletes only with confirmDelete=true. Defaults dryRun."),
        confirmDelete: z.boolean().optional().describe("Required true with mode=commit to delete the eligible review view."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Timeout for review view cleanup. Defaults 15000."),
    }, async (args) => {
        try {
            const response = await sendRevitCommand("delete_review_view", {
                viewId: args.viewId,
                viewName: args.viewName,
                viewType: args.viewType,
                exactName: args.exactName,
                mode: args.mode,
                confirmDelete: args.confirmDelete,
                timeoutMs: args.timeoutMs,
            }, {
                ...executionOptionsFromArgs(args, "Delete Revit review view"),
            });
            return formatJsonContent(response && response.result ? response.result : response);
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                action: "delete_review_view",
                state: "failed",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
