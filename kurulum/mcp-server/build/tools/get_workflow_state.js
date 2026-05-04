import { z } from "zod";
import { formatJsonContent } from "../utils/revitToolHelpers.js";
import { loadWorkflowState, workflowStatePath } from "../write-plan/workflowStore.js";

export function registerGetWorkflowStateTool(server) {
    server.tool("get_workflow_state", "Read the local JSON-backed write-plan workflow state, including plans, eId mappings, and audit entries.", {
        planId: z.string().optional(),
        includeAudit: z.boolean().optional(),
    }, async (args) => {
        const state = loadWorkflowState();
        const payload = {
            success: true,
            statePath: workflowStatePath(),
            updatedAt: state.updatedAt,
        };
        if (args.planId) {
            payload.plan = state.plans[args.planId] || null;
            payload.mappings = state.mappings[args.planId] || [];
        }
        else {
            payload.planCount = Object.keys(state.plans || {}).length;
            payload.mappingPlanCount = Object.keys(state.mappings || {}).length;
            payload.plans = state.plans;
            payload.mappings = state.mappings;
        }
        if (args.includeAudit) {
            payload.audit = state.audit || [];
        }
        if (state.loadError) {
            payload.warnings = [`Workflow state could not be loaded cleanly: ${state.loadError}`];
        }
        return formatJsonContent(payload);
    });
}
