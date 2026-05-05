import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { csharpString, executeRevitCode, sendRevitCommand } from "../utils/revitToolHelpers.js";
import { buildAudit, buildPreviewRows } from "./previewFormatter.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export async function executeNativeWritePlan({ mode, plan, commitToken, validation, allowRuntimePreviewFallback = true, allowDirectAssemblyFallback = true }) {
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
        if (allowDirectAssemblyFallback && canUseDirectAssemblyFallback(mode)) {
            const directResult = await executeDirectAssemblyFallback({ mode, plan, commitToken });
            if (directResult) {
                directResult.warnings = [
                    ...(directResult.warnings || []),
                    "Native execute_write_plan command was unavailable; invoked the native WritePlanExecutor by direct assembly fallback.",
                    message,
                ];
                directResult.audit = {
                    ...(directResult.audit || {}),
                    directAssemblyFallback: true,
                };
                return directResult;
            }
        }
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

async function executeDirectAssemblyFallback({ mode, plan, commitToken }) {
    const dllPath = resolveExecutorDllPath();
    if (!dllPath) {
        return null;
    }
    const code = buildDirectAssemblyCode(dllPath, mode, plan, commitToken || "");
    try {
        const response = await executeRevitCode(code, { transactionMode: "none" });
        const payload = normalizeNativeResult(response, mode, plan);
        if (payload && payload.success !== false) {
            return payload;
        }
        return payload;
    }
    catch {
        return null;
    }
}

function canUseDirectAssemblyFallback(mode) {
    if (mode === "validate" || mode === "preview" || mode === "verify") {
        return true;
    }
    return mode === "commit" && process.env.REVIT_MCP_ALLOW_DIRECT_EXECUTOR_COMMIT === "true";
}

function resolveExecutorDllPath() {
    const candidates = [
        process.env.REVIT_MCP_WRITE_PLAN_EXECUTOR_DLL,
        process.env.APPDATA
            ? path.join(process.env.APPDATA, "Autodesk", "Revit", "Addins", "2022", "revit_mcp_plugin", "Commands", "RevitMCPCommandSet", "2022", "RevitMCPWritePlanCommandSet.dll")
            : null,
        path.join(moduleDir, "..", "..", "..", "revit-plugin", "revit_mcp_plugin", "Commands", "RevitMCPCommandSet", "2022", "RevitMCPWritePlanCommandSet.dll"),
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function buildDirectAssemblyCode(dllPath, mode, plan, commitToken) {
    const planJson = JSON.stringify(plan);
    const folderPath = path.dirname(dllPath);
    return `
try
{
    string folder = ${csharpString(folderPath)};
    string commandPath = ${csharpString(dllPath)};
    string jsonPath = System.IO.Path.Combine(folder, "Newtonsoft.Json.dll");
    if (System.IO.File.Exists(jsonPath))
    {
        System.Reflection.Assembly.LoadFrom(jsonPath);
    }
    System.Reflection.Assembly commandAssembly = System.Reflection.Assembly.LoadFrom(commandPath);
    System.Reflection.Assembly jsonAssembly = null;
    foreach (System.Reflection.Assembly loaded in System.AppDomain.CurrentDomain.GetAssemblies())
    {
        if (loaded.GetName().Name == "Newtonsoft.Json" && loaded.GetType("Newtonsoft.Json.Linq.JObject") != null)
        {
            jsonAssembly = loaded;
        }
    }
    if (jsonAssembly == null) return "{\\"success\\":false,\\"error\\":\\"Newtonsoft.Json assembly not found\\"}";
    System.Type jobjectType = jsonAssembly.GetType("Newtonsoft.Json.Linq.JObject");
    System.Reflection.MethodInfo parseMethod = jobjectType.GetMethod("Parse", new System.Type[] { typeof(string) });
    if (parseMethod == null) return "{\\"success\\":false,\\"error\\":\\"JObject.Parse not found\\"}";
    object plan = parseMethod.Invoke(null, new object[] { ${csharpString(planJson)} });
    System.Type executorType = commandAssembly.GetType("RevitMCPWritePlanCommandSet.Commands.WritePlan.Operations.WritePlanExecutor");
    if (executorType == null) return "{\\"success\\":false,\\"error\\":\\"WritePlanExecutor type not found\\"}";
    System.Reflection.MethodInfo executeMethod = executorType.GetMethod("Execute", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
    if (executeMethod == null) return "{\\"success\\":false,\\"error\\":\\"Execute method not found\\"}";
    object result = executeMethod.Invoke(null, new object[] { document, ${csharpString(mode)}, plan, ${csharpString(commitToken)} });
    return result != null ? result.ToString() : "{\\"success\\":false,\\"error\\":\\"Executor returned null\\"}";
}
catch (Exception ex)
{
    string message = ex.ToString().Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"").Replace("\\r", " ").Replace("\\n", " ");
    return "{\\"success\\":false,\\"error\\":\\"" + message + "\\"}";
}`;
}

function normalizeNativeResult(response, mode, plan) {
    const payload = unwrapCommandResult(parseNativePayload(response && typeof response === "object" && response.result ? response.result : response));
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

function parseNativePayload(payload, depth = 0) {
    if (depth > 3 || typeof payload !== "string") {
        return payload;
    }
    const text = payload.trim();
    if (!text.startsWith("{") && !text.startsWith("[") && !text.startsWith("\"")) {
        return payload;
    }
    try {
        return parseNativePayload(JSON.parse(text), depth + 1);
    }
    catch {
        return payload;
    }
}

function unwrapCommandResult(payload) {
    if (!payload || typeof payload !== "object") {
        return payload;
    }
    for (const key of ["result", "data", "value", "Result", "Data", "Value"]) {
        const nested = payload[key];
        if (nested && typeof nested === "object" && ("mode" in nested || "planId" in nested || "previewRows" in nested)) {
            return nested;
        }
    }
    return payload;
}
