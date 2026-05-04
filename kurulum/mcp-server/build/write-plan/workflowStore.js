import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultStatePath = path.join(moduleDir, ".workflow-state.json");

function statePath() {
    return process.env.REVIT_MCP_WORKFLOW_STATE_FILE || defaultStatePath;
}

export function createEmptyState() {
    return {
        schemaVersion: "1.0",
        updatedAt: new Date().toISOString(),
        plans: {},
        mappings: {},
        audit: [],
    };
}

export function loadWorkflowState() {
    const filePath = statePath();
    if (!fs.existsSync(filePath)) {
        return createEmptyState();
    }
    try {
        const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return {
            ...createEmptyState(),
            ...state,
            plans: state.plans || {},
            mappings: state.mappings || {},
            audit: Array.isArray(state.audit) ? state.audit : [],
        };
    }
    catch (error) {
        return {
            ...createEmptyState(),
            loadError: error instanceof Error ? error.message : String(error),
        };
    }
}

export function saveWorkflowState(state) {
    const next = {
        ...state,
        updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(next, null, 2), "utf8");
    return next;
}

export function getPlanRecord(planId) {
    const state = loadWorkflowState();
    return state.plans[planId] || null;
}

export function upsertPlanRecord(plan, updates = {}) {
    const state = loadWorkflowState();
    const existing = state.plans[plan.planId] || {};
    state.plans[plan.planId] = {
        ...existing,
        plan,
        status: updates.status || existing.status || "prepared",
        validation: updates.validation || existing.validation,
        preview: updates.preview || existing.preview,
        commit: updates.commit || existing.commit,
        verify: updates.verify || existing.verify,
        updatedAt: new Date().toISOString(),
    };
    appendAuditEntryInState(state, {
        planId: plan.planId,
        action: updates.action || "upsert_plan",
        status: state.plans[plan.planId].status,
    });
    return saveWorkflowState(state).plans[plan.planId];
}

export function updatePlanRecord(planId, updates = {}) {
    const state = loadWorkflowState();
    if (!state.plans[planId]) {
        return null;
    }
    state.plans[planId] = {
        ...state.plans[planId],
        ...updates,
        updatedAt: new Date().toISOString(),
    };
    appendAuditEntryInState(state, {
        planId,
        action: updates.action || "update_plan",
        status: state.plans[planId].status,
    });
    return saveWorkflowState(state).plans[planId];
}

export function addWorkflowMappings(planId, mappings = []) {
    const state = loadWorkflowState();
    const existing = Array.isArray(state.mappings[planId]) ? state.mappings[planId] : [];
    state.mappings[planId] = existing.concat(Array.isArray(mappings) ? mappings : []);
    appendAuditEntryInState(state, {
        planId,
        action: "add_mappings",
        count: Array.isArray(mappings) ? mappings.length : 0,
    });
    return saveWorkflowState(state).mappings[planId];
}

export function clearWorkflowState(planId) {
    if (!planId) {
        const empty = saveWorkflowState(createEmptyState());
        return { clearedAll: true, state: empty };
    }
    const state = loadWorkflowState();
    delete state.plans[planId];
    delete state.mappings[planId];
    appendAuditEntryInState(state, { planId, action: "clear_plan" });
    return { clearedAll: false, state: saveWorkflowState(state) };
}

export function workflowStatePath() {
    return statePath();
}

function appendAuditEntryInState(state, entry) {
    state.audit = Array.isArray(state.audit) ? state.audit : [];
    state.audit.push({
        at: new Date().toISOString(),
        ...entry,
    });
    if (state.audit.length > 500) {
        state.audit = state.audit.slice(-500);
    }
}
