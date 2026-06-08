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

type JsonObject = Record<string, any>;

function compactViewSummary(value: any) {
    if (!value || typeof value !== "object") {
        return null;
    }
    return {
        id: readField(value, "Id", "id") ?? readField(value, "ViewId", "viewId") ?? null,
        name: readField(value, "Name", "name") ?? readField(value, "ViewName", "viewName") ?? null,
        type: readField(value, "Type", "type") ?? readField(value, "ViewType", "viewType") ?? null,
    };
}

export function compactDeleteReviewViewResult(payload: any, args: JsonObject = {}) {
    const responseMode = args.responseMode || "compact";
    if (!payload || typeof payload !== "object" || responseMode === "full") {
        return {
            ...payload,
            responseMode,
        };
    }

    const targetView = compactViewSummary(readField(payload, "TargetView", "targetView"));
    const cleanup = {
        mode: readField(payload, "Mode", "mode") ?? args.mode ?? "dryRun",
        dryRun: readField(payload, "DryRun", "dryRun") ?? null,
        changed: readField(payload, "Changed", "changed") ?? null,
        deleted: readField(payload, "Deleted", "deleted") ?? null,
        deletedElementCount: readField(payload, "DeletedElementCount", "deletedElementCount") ?? null,
        confirmed: (readField(payload, "ConfirmDelete", "confirmDelete") ?? args.confirmDelete) === true,
        targetIsReviewView: readField(payload, "TargetIsReviewView", "targetIsReviewView") ?? null,
        reviewSignals: readField(payload, "ReviewSignals", "reviewSignals") ?? [],
    };

    return {
        success: readField(payload, "Success", "success"),
        guarded: readField(payload, "Guarded", "guarded"),
        state: readField(payload, "State", "state"),
        action: readField(payload, "Action", "action") || "delete_review_view",
        responseMode: "compact",
        reason: readField(payload, "Reason", "reason"),
        error: readField(payload, "Error", "error"),
        message: readField(payload, "Message", "message"),
        targetView,
        cleanup,
        suggestedNextScopes: readField(payload, "SuggestedNextScopes", "suggestedNextScopes") ?? [],
        notices: [
            ...(Array.isArray(readField(payload, "Notices", "notices")) ? readField(payload, "Notices", "notices") : []),
            "Compact response groups cleanup-specific fields under cleanup. Use responseMode=\"full\" for raw delete_review_view diagnostics.",
        ],
    };
}

export function registerDeleteReviewViewTool(server: ToolServer) {
    server.tool("delete_review_view", "[REVIEW_VIEW_CLEANUP_GUARDED] Dry-run or delete an explicit revAgent/Revit MCP review 3D view. Defaults to dryRun and only permits guarded cleanup of known review/focus/coordination/QA view names, including revAgent_QA_* views created by create_3d_view_for_elements; it blocks production views, active views, and open view tabs. Commit requires mode=\"commit\" and confirmDelete=true.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        viewId: z.number().int().positive().optional().describe("ElementId of the review 3D view to inspect or delete."),
        viewName: z.string().optional().describe("Exact review view name to inspect or delete when viewId is not supplied."),
        viewType: z.string().optional().describe("Optional Revit ViewType filter. Review cleanup is limited to non-template ThreeD views."),
        exactName: z.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),
        mode: z.enum(["dryRun", "commit"]).optional().describe("dryRun reports whether the view is eligible for cleanup. commit deletes only with confirmDelete=true. Defaults dryRun."),
        confirmDelete: z.boolean().optional().describe("Required true with mode=commit to delete the eligible review view."),
        responseMode: z.enum(["compact", "full"]).optional().describe("Response shape. compact is the default and groups cleanup-specific fields under cleanup; full returns the raw native cleanup contract."),
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
            return formatJsonContent(compactDeleteReviewViewResult(response && response.result ? response.result : response, args));
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
