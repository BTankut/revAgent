import { z } from "zod";
import { mergeOfficeStandards } from "../office-standards/defaults.js";
import { formatJsonContent } from "../utils/revitToolHelpers.js";
import { executeNativeWritePlan } from "../write-plan/nativeExecutorClient.js";
import { normalizePlan } from "../write-plan/schemas.js";
import { validateWritePlan } from "../write-plan/validators.js";
import { getPlanRecord, updatePlanRecord } from "../write-plan/workflowStore.js";

export function registerVerifyWritePlanTool(server) {
    server.tool("verify_write_plan", "Verify a committed or proposed write-plan by re-reading model state through the native executor. This mode is read-only.", {
        planId: z.string().optional(),
        plan: z.any().optional(),
        officeStandards: z.any().optional(),
    }, async (args) => {
        try {
            const resolved = resolvePlan(args);
            if (!resolved.plan) {
                return formatJsonContent({ success: false, mode: "verify", errors: [resolved.error], warnings: [] });
            }
            const plan = resolved.plan;
            const officeStandards = mergeOfficeStandards(args.officeStandards || {});
            const validation = validateWritePlan(plan, { mode: "verify", officeStandards, requireInitialOperationsOnly: true });
            const result = await executeNativeWritePlan({
                mode: "verify",
                plan,
                validation,
                allowRuntimePreviewFallback: false,
            });
            updatePlanRecord(plan.planId, {
                status: result.success ? "verified" : "verify_failed",
                validation,
                verify: result,
                action: "verify_write_plan",
            });
            return formatJsonContent({
                ...result,
                validation,
                mutateModel: false,
            });
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                mode: "verify",
                errors: [error instanceof Error ? error.message : String(error)],
                warnings: [],
                mutateModel: false,
            });
        }
    });
}

function resolvePlan(args) {
    if (args.plan) {
        return { plan: normalizePlan(args.plan) };
    }
    if (!args.planId) {
        return { error: "Provide plan or planId." };
    }
    const record = getPlanRecord(args.planId);
    if (!record || !record.plan) {
        return { error: `No workflow state found for planId ${args.planId}.` };
    }
    return { plan: normalizePlan(record.plan) };
}
