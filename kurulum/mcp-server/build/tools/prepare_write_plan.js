import { z } from "zod";
import { mergeOfficeStandards } from "../office-standards/defaults.js";
import { formatJsonContent } from "../utils/revitToolHelpers.js";
import { buildPlanFromArgs, normalizePlan } from "../write-plan/schemas.js";
import { validateWritePlan } from "../write-plan/validators.js";
import { upsertPlanRecord } from "../write-plan/workflowStore.js";

export function registerPrepareWritePlanTool(server) {
    server.tool("prepare_write_plan", "Create or validate a typed Revit write-plan. This never writes to Revit; it stores a prepared plan and returns schema/precondition/risk results.", {
        plan: z.any().optional().describe("Full write-plan object. If omitted, operation/targets/arguments are used to build a one-step plan."),
        userRequest: z.string().optional(),
        title: z.string().optional(),
        discipline: z.enum(["hvac", "hydronic", "sanitary", "domestic_water", "fire", "sprinkler", "clash", "general"]).optional(),
        riskLevel: z.enum(["low", "medium", "high", "critical"]).optional(),
        operation: z.string().optional(),
        targets: z.any().optional(),
        arguments: z.any().optional(),
        steps: z.array(z.any()).optional(),
        context: z.any().optional(),
        officeStandards: z.any().optional(),
    }, async (args) => {
        try {
            if (!args.plan && !args.operation && (!Array.isArray(args.steps) || args.steps.length === 0)) {
                return formatJsonContent({
                    success: false,
                    errors: ["Provide plan, operation, or steps."],
                    warnings: [],
                });
            }
            const officeStandards = mergeOfficeStandards(args.officeStandards || {});
            const context = args.context || {};
            const plan = args.plan ? normalizePlan(args.plan) : buildPlanFromArgs(args, context);
            const validation = validateWritePlan(plan, { mode: "validate", officeStandards });
            if (validation.valid) {
                upsertPlanRecord(plan, {
                    status: "prepared",
                    validation,
                    action: "prepare_write_plan",
                });
            }
            return formatJsonContent({
                success: validation.valid,
                mode: "validate",
                planId: plan.planId,
                riskLevel: plan.riskLevel,
                validation,
                plan,
            });
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                errors: [error instanceof Error ? error.message : String(error)],
                warnings: [],
            });
        }
    });
}
