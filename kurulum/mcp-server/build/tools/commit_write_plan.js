import { z } from "zod";
import { mergeOfficeStandards } from "../office-standards/defaults.js";
import { formatJsonContent } from "../utils/revitToolHelpers.js";
import { executeNativeWritePlan } from "../write-plan/nativeExecutorClient.js";
import { requiresExplicitApproval } from "../write-plan/risk.js";
import { normalizePlan } from "../write-plan/schemas.js";
import { validateWritePlan } from "../write-plan/validators.js";
import { addWorkflowMappings, getPlanRecord, updatePlanRecord } from "../write-plan/workflowStore.js";

export function registerCommitWritePlanTool(server) {
    server.tool("commit_write_plan", "Commit a previously previewed typed write-plan through the native Revit executor. Requires explicit approval or a commit token and never falls back to raw dynamic code.", {
        planId: z.string().optional(),
        plan: z.any().optional(),
        commitToken: z.string().optional(),
        explicitApproval: z.boolean().optional().describe("Set true only when the user explicitly approved this commit."),
        approvalText: z.string().optional(),
        officeStandards: z.any().optional(),
    }, async (args) => {
        try {
            const resolved = resolvePlan(args);
            if (!resolved.plan) {
                return formatJsonContent({ success: false, mode: "commit", errors: [resolved.error], warnings: [] });
            }
            const plan = resolved.plan;
            const approval = Boolean(args.commitToken) || args.explicitApproval === true;
            if (!approval) {
                return formatJsonContent({
                    success: false,
                    mode: "commit",
                    planId: plan.planId,
                    riskLevel: plan.riskLevel,
                    errors: ["commit_write_plan requires commitToken or explicitApproval=true."],
                    warnings: requiresExplicitApproval(plan.riskLevel)
                        ? [`${plan.riskLevel} risk plans require clear user approval before commit.`]
                        : [],
                    canCommit: false,
                });
            }
            const officeStandards = mergeOfficeStandards(args.officeStandards || {});
            const validation = validateWritePlan(plan, { mode: "commit", officeStandards, requireInitialOperationsOnly: true });
            if (!validation.valid || validation.canCommit === false) {
                return formatJsonContent({
                    success: false,
                    mode: "commit",
                    planId: plan.planId,
                    riskLevel: plan.riskLevel,
                    validation,
                    errors: validation.errors,
                    warnings: validation.warnings,
                    canCommit: false,
                });
            }
            const result = await executeNativeWritePlan({
                mode: "commit",
                plan,
                commitToken: args.commitToken || args.approvalText || "explicit-approval",
                validation,
                allowRuntimePreviewFallback: false,
            });
            updatePlanRecord(plan.planId, {
                status: result.success ? "committed" : "commit_failed",
                validation,
                commit: result,
                action: "commit_write_plan",
            });
            if (Array.isArray(result.mappings) && result.mappings.length > 0) {
                addWorkflowMappings(plan.planId, result.mappings);
            }
            return formatJsonContent({
                ...result,
                validation,
                mutateModel: result.success === true,
            });
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                mode: "commit",
                errors: [error instanceof Error ? error.message : String(error)],
                warnings: [],
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
