import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPreviewRows } from "./previewFormatter.js";
import { classifyPlanRisk } from "./risk.js";
import { commitRuntimeReportPlan, isRuntimeReportPlan, previewRuntimeReportPlan } from "./runtimeReportExecutor.js";
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

const schedulePlan = buildPlanFromArgs({
    title: "Create mechanical equipment schedule",
    discipline: "general",
    operation: "create_schedule_or_update_schedule",
    targets: {},
    arguments: {
        scheduleName: "Codex Mechanical Equipment Schedule",
        category: "OST_MechanicalEquipment",
        fields: [
            { builtInParameter: "ELEM_FAMILY_AND_TYPE_PARAM", heading: "Family and Type" },
            { builtInParameter: "ALL_MODEL_MARK", heading: "Mark" },
        ],
    },
});
const scheduleValidation = validateWritePlan(schedulePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(scheduleValidation.valid, true);
assert.equal(classifyPlanRisk(schedulePlan), "medium");

const reroutePlan = buildPlanFromArgs({
    title: "Commit explicit reroute geometry",
    discipline: "clash",
    operation: "commit_reroute",
    targets: {},
    arguments: {
        curveType: "duct",
        systemTypeId: 11,
        ductTypeId: 22,
        levelId: 33,
        unit: "m",
        points: [
            { x: 0, y: 0, z: 3 },
            { x: 1, y: 0, z: 3 },
            { x: 1, y: 1, z: 3 },
        ],
        obstacleBoxes: [
            { min: { x: 0.25, y: 0.25, z: 2.8 }, max: { x: 0.75, y: 0.75, z: 3.2 } },
        ],
        clearanceM: 0.1,
    },
});
const rerouteValidation = validateWritePlan(reroutePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(rerouteValidation.valid, true);
assert.equal(classifyPlanRisk(reroutePlan), "critical");

const reportOutputDir = path.join(os.tmpdir(), `revit-mcp-report-test-${process.pid}`);
const reportPlan = normalizePlan({
    schemaVersion: "1.0",
    planId: "report-plan-001",
    title: "Export BOQ report",
    discipline: "general",
    riskLevel: "low",
    source: { userRequest: "export report", createdBy: "llm", revitVersion: "2022" },
    context: { documentTitle: "test", activeViewId: 0, activeViewType: "" },
    steps: [
        {
            stepId: "report-001",
            operation: "export_boq_report",
            dependsOn: [],
            targets: {},
            arguments: {
                outputDirectory: reportOutputDir,
                fileName: "boq.csv",
                rows: [{ elementId: "123", category: "Ducts", quantity: 2 }],
            },
            preconditions: [],
            riskLevel: "low",
        },
    ],
});
assert.equal(isRuntimeReportPlan(reportPlan), true);
const reportValidation = validateWritePlan(reportPlan, { mode: "commit", requireInitialOperationsOnly: false });
assert.equal(reportValidation.valid, true);
const reportPreview = previewRuntimeReportPlan(reportPlan);
assert.equal(reportPreview.success, true);
assert.equal(reportPreview.mutateModel, false);
assert.equal(reportPreview.previewRows[0].rowCount, 1);
const reportCommit = commitRuntimeReportPlan(reportPlan);
assert.equal(reportCommit.success, true);
assert.equal(reportCommit.mutateModel, false);
assert.equal(reportCommit.writesFiles, true);
assert.equal(fs.existsSync(reportCommit.files[0].outputPath), true);
assert(fs.readFileSync(reportCommit.files[0].outputPath, "utf8").includes("elementId"));

clearWorkflowState();

console.log("write-plan schema/state/risk tests passed");
