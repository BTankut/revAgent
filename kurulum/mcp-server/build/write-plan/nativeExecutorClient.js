import { sendRevitCommand } from "../utils/revitToolHelpers.js";
import { buildAudit, buildPreviewRows } from "./previewFormatter.js";

export async function executeNativeWritePlan({ mode, plan, commitToken, validation, allowRuntimePreviewFallback = true }) {
    try {
        const response = await sendRevitCommand("execute_write_plan", {
            mode,
            plan,
            commitToken: commitToken || "",
        });
        return normalizeNativeResult(response, mode, plan);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if ((mode === "validate" || mode === "preview") && allowRuntimePreviewFallback) {
            return {
                success: validation ? validation.valid : mode === "preview",
                mode,
                planId: plan.planId,
                riskLevel: plan.riskLevel,
                warnings: [
                    "Native execute_write_plan command unavailable; returned MCP runtime fallback preview only.",
                    message,
                ],
                errors: validation && validation.valid === false ? validation.errors : [],
                previewRows: mode === "preview" ? buildPreviewRows(plan, validation) : [],
                mappings: [],
                audit: buildAudit(mode, plan, { nativeExecutor: "unavailable" }),
            };
        }
        return {
            success: false,
            mode,
            planId: plan.planId,
            riskLevel: plan.riskLevel,
            warnings: [],
            errors: [message],
            previewRows: [],
            mappings: [],
            audit: buildAudit(mode, plan, { nativeExecutor: "failed" }),
        };
    }
}

function normalizeNativeResult(response, mode, plan) {
    const payload = unwrapCommandResult(response && typeof response === "object" && response.result ? response.result : response);
    if (payload && typeof payload === "object" && "success" in payload) {
        return {
            warnings: [],
            errors: [],
            previewRows: [],
            mappings: [],
            audit: {},
            ...payload,
            mode: payload.mode || mode,
            planId: payload.planId || plan.planId,
            riskLevel: payload.riskLevel || plan.riskLevel,
        };
    }
    return {
        success: true,
        mode,
        planId: plan.planId,
        riskLevel: plan.riskLevel,
        warnings: [],
        errors: [],
        previewRows: [],
        mappings: [],
        audit: buildAudit(mode, plan, { rawResponse: payload }),
    };
}

function unwrapCommandResult(payload) {
    if (!payload || typeof payload !== "object") {
        return payload;
    }
    for (const key of ["result", "data", "value"]) {
        const nested = payload[key];
        if (nested && typeof nested === "object" && ("mode" in nested || "planId" in nested || "previewRows" in nested)) {
            return nested;
        }
    }
    return payload;
}
