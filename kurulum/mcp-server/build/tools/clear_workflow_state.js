import { z } from "zod";
import { formatJsonContent } from "../utils/revitToolHelpers.js";
import { clearWorkflowState, workflowStatePath } from "../write-plan/workflowStore.js";

export function registerClearWorkflowStateTool(server) {
    server.tool("clear_workflow_state", "Clear local write-plan workflow state. Provide planId to clear one plan, or clearAll=true to clear all state.", {
        planId: z.string().optional(),
        clearAll: z.boolean().optional(),
    }, async (args) => {
        if (!args.planId && args.clearAll !== true) {
            return formatJsonContent({
                success: false,
                errors: ["Provide planId or clearAll=true."],
                statePath: workflowStatePath(),
            });
        }
        const result = clearWorkflowState(args.clearAll === true ? undefined : args.planId);
        return formatJsonContent({
            success: true,
            statePath: workflowStatePath(),
            clearedAll: result.clearedAll,
            planId: args.planId || null,
            updatedAt: result.state.updatedAt,
        });
    });
}
