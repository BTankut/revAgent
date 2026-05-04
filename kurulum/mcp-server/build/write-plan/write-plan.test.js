import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { buildPreviewRows } from "./previewFormatter.js";
import { classifyPlanRisk } from "./risk.js";
import { buildPlanFromArgs, normalizePlan } from "./schemas.js";
import { validateWritePlan } from "./validators.js";
import {
    addWorkflowMappings,
    clearWorkflowState,
    getPlanRecord,
    getWorkflowMappings,
    hydratePlanTargetsFromMappings,
    upsertPlanRecord,
} from "./workflowStore.js";

process.env.REVIT_MCP_WORKFLOW_STATE_FILE = path.join(os.tmpdir(), `revit-mcp-workflow-test-${process.pid}.json`);

const invalid = validateWritePlan(normalizePlan({}), { mode: "validate" });
assert.equal(invalid.valid, false);
assert(invalid.errors.includes("steps must contain at least one step"));

const plan = buildPlanFromArgs({
    title: "Set test parameter",
    discipline: "general",
    operation: "set_parameter",
    targets: { elementId: 123 },
    arguments: { parameterName: "Comments", value: "MCP test" },
});

const validation = validateWritePlan(plan, { mode: "validate" });
assert.equal(validation.valid, true);
assert.equal(classifyPlanRisk(plan), "low");

const rows = buildPreviewRows(plan, validation);
assert.equal(rows.length, 1);
assert.equal(rows[0].operation, "set_parameter");
assert.equal(rows[0].willMutateModel, false);

upsertPlanRecord(plan, { validation, status: "prepared" });
assert.equal(getPlanRecord(plan.planId).status, "prepared");

addWorkflowMappings(plan.planId, [
    {
        eId: "duct-main-001",
        stepId: "step-001",
        elementId: 456,
        uniqueId: "unique-456",
        category: "OST_DuctCurves",
        createdByPlan: true,
    },
]);
assert.equal(getWorkflowMappings(plan.planId).length, 1);

const eIdPlan = normalizePlan({
    ...plan,
    steps: [
        {
            stepId: "step-002",
            eId: "duct-main-001",
            operation: "set_parameter",
            dependsOn: [],
            targets: { eId: "duct-main-001" },
            arguments: { parameterName: "Comments", value: "eId update" },
            preconditions: [],
            riskLevel: "low",
        },
    ],
});
const hydrated = hydratePlanTargetsFromMappings(eIdPlan, getWorkflowMappings(plan.planId));
assert.equal(hydrated.hydration.applied.length, 1);
assert.equal(hydrated.plan.steps[0].targets.elementId, 456);
assert.equal(hydrated.plan.steps[0].targets.uniqueId, "unique-456");

const commitValidation = validateWritePlan(plan, { mode: "commit" });
assert.equal(commitValidation.valid, true);

clearWorkflowState();

console.log("write-plan schema/state/risk tests passed");
