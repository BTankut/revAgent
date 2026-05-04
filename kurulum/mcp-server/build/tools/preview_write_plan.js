import { z } from "zod";
import { mergeOfficeStandards } from "../office-standards/defaults.js";
import { formatJsonContent } from "../utils/revitToolHelpers.js";
import { executeNativeWritePlan } from "../write-plan/nativeExecutorClient.js";
import { buildPreviewRows } from "../write-plan/previewFormatter.js";
import { normalizePlan } from "../write-plan/schemas.js";
import { validateWritePlan } from "../write-plan/validators.js";
import { getPlanRecord, getWorkflowMappings, hydratePlanTargetsFromMappings, updatePlanRecord, upsertPlanRecord } from "../write-plan/workflowStore.js";

export function registerPreviewWritePlanTool(server) {
    server.tool("preview_write_plan", "Preview a typed write-plan without mutating the Revit model. Uses native execute_write_plan preview when available and otherwise returns a runtime-only fallback preview.", {
        planId: z.string().optional(),
        plan: z.any().optional(),
        officeStandards: z.any().optional(),
        useNativeExecutor: z.boolean().optional().describe("Call native execute_write_plan preview. Defaults true."),
    }, async (args) => {
        try {
            const resolved = resolvePlan(args);
            if (!resolved.plan) {
                return formatJsonContent({ success: false, errors: [resolved.error], warnings: [] });
            }
            const hydrationResult = hydratePlanTargetsFromMappings(resolved.plan, getWorkflowMappings(resolved.plan.planId));
            const plan = hydrationResult.plan;
            const officeStandards = mergeOfficeStandards(args.officeStandards || {});
            const validation = validateWritePlan(plan, { mode: "preview", officeStandards, requireInitialOperationsOnly: true });
            const fallback = {
                success: validation.valid,
                mode: "preview",
                planId: plan.planId,
                riskLevel: plan.riskLevel,
                warnings: validation.warnings,
                errors: validation.errors,
                previewRows: buildPreviewRows(plan, validation),
                mappings: [],
                audit: { mode: "preview", nativeExecutor: false },
            };
            const result = args.useNativeExecutor === false
                ? fallback
                : await executeNativeWritePlan({ mode: "preview", plan, validation });
            if (validation.valid) {
                upsertPlanRecord(plan, { status: "previewed", validation, preview: result, action: "preview_write_plan" });
            }
            else if (resolved.fromState) {
                updatePlanRecord(plan.planId, { status: "preview_blocked", validation, preview: result, action: "preview_write_plan_blocked" });
            }
            return formatJsonContent({
                ...result,
                success: validation.valid && result.success !== false,
                validation,
                eIdHydration: hydrationResult.hydration,
                mutateModel: false,
            });
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                mode: "preview",
                errors: [error instanceof Error ? error.message : String(error)],
                warnings: [],
                mutateModel: false,
            });
        }
    });
}

function resolvePlan(args) {
    if (args.plan) {
        return { plan: normalizePlan(args.plan), fromState: false };
    }
    if (!args.planId) {
        return { error: "Provide plan or planId." };
    }
    const record = getPlanRecord(args.planId);
    if (!record || !record.plan) {
        return { error: `No workflow state found for planId ${args.planId}.` };
    }
    return { plan: normalizePlan(record.plan), fromState: true };
}
