import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findWritePatterns } from "../tools/send_code_to_revit_safe_guards.js";
const TELEMETRY_SCHEMA_VERSION = "revagent.telemetry.v1";
const TELEMETRY_SESSION_ID = crypto.randomUUID();
const TELEMETRY_PROCESS_STARTED_AT_UTC = new Date().toISOString();
let telemetrySequence = 0;
function isTruthy(value) {
    return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}
function telemetryDisabled() {
    return isTruthy(process.env.REVAGENT_TELEMETRY_DISABLED);
}
function readJsonFile(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            return null;
        }
        return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    }
    catch {
        return null;
    }
}
function getRuntimeRoot() {
    const thisFile = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(thisFile), "..", "..");
}
function getInstallRoot() {
    const runtimeRoot = getRuntimeRoot();
    const parent = path.dirname(runtimeRoot);
    return parent && parent !== runtimeRoot ? parent : runtimeRoot;
}
function getProgramDataRoot() {
    return process.env.ProgramData || process.env.PROGRAMDATA || "C:\\ProgramData";
}
function readUpdaterConfig() {
    const installRoot = getInstallRoot();
    const candidates = [
        process.env.REVAGENT_UPDATER_CONFIG,
        path.join(installRoot, "updater", "updater-config.json"),
        path.join(getProgramDataRoot(), "DPE", "RevitMCP", "updater", "updater-config.json"),
    ].filter(Boolean);
    for (const candidate of candidates) {
        const config = readJsonFile(candidate);
        if (config) {
            return config;
        }
    }
    return null;
}
function readInstalledState() {
    const installRoot = getInstallRoot();
    const candidates = [
        path.join(installRoot, "updater", "installed.json"),
        path.join(getProgramDataRoot(), "DPE", "RevitMCP", "updater", "installed.json"),
    ];
    for (const candidate of candidates) {
        const state = readJsonFile(candidate);
        if (state) {
            return state;
        }
    }
    return null;
}
function parseBuildHash(version) {
    const match = String(version || "").match(/-([0-9a-f]{7,40})$/i);
    return match ? match[1] : null;
}
function defaultLocalTelemetryRoot() {
    return path.join(getProgramDataRoot(), "DPE", "RevitMCP", "state", "telemetry");
}
export function sanitizeTelemetryPathSegment(value, fallback = "unknown") {
    const text = String(value || "").trim();
    if (!text) {
        return fallback;
    }
    const safe = text
        .replace(/[<>:"/\\|?*\x00-\x1F\s]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^[._-]+|[._-]+$/g, "");
    return safe || fallback;
}
function hashText(value) {
    return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}
function shortHash(value) {
    return hashText(value).slice(0, 16);
}
function redactPotentialSensitiveText(value) {
    return String(value || "")
        .replace(/\\\\[^\\\s]+\\[^\r\n\t"]+/g, "[unc-path]")
        .replace(/[A-Za-z]:\\[^\r\n\t"]+/g, "[local-path]")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
}
function truncateText(value, maxChars = 400) {
    const text = redactPotentialSensitiveText(value);
    if (text.length <= maxChars) {
        return text;
    }
    return `${text.slice(0, maxChars)}...[truncated ${text.length - maxChars} chars]`;
}
function countLines(value) {
    return String(value || "").split(/\r\n|\r|\n/).length;
}
function summarizeCode(code) {
    const text = String(code || "");
    return {
        hash: shortHash(text),
        length: text.length,
        lineCount: countLines(text),
        writePatternCount: findWritePatterns(text).length,
        writePatterns: findWritePatterns(text).slice(0, 12),
        hasManualTransaction: /new\s+(Transaction|SubTransaction|TransactionGroup)\s*\(|\b(Transaction|SubTransaction|TransactionGroup)\s*\(/i.test(text),
    };
}
function summarizeScalarParam(key, value) {
    const safeStringKeys = new Set([
        "transactionMode",
        "responseMode",
        "planMode",
        "planCandidateMode",
        "targetVisualStyle",
        "intent",
        "imageFormat",
        "cameraOrientation",
        "viewType",
        "category",
        "discipline",
        "cropBasis",
    ]);
    if (typeof value === "boolean" || typeof value === "number") {
        return value;
    }
    if (typeof value === "string") {
        if (safeStringKeys.has(key)) {
            return value;
        }
        return {
            hash: shortHash(value),
            length: value.length,
            present: value.length > 0,
        };
    }
    return undefined;
}
export function summarizeTelemetryParams(params = {}) {
    const summary = {
        keys: [],
    };
    if (!params || typeof params !== "object") {
        return summary;
    }
    const keys = Object.keys(params).sort();
    summary.keys = keys.filter((key) => key !== "code" && key !== "parameters");
    for (const key of keys) {
        const value = params[key];
        if (key === "code") {
            summary.code = summarizeCode(value);
            continue;
        }
        if (key === "parameters") {
            summary.parameters = {
                count: Array.isArray(value) ? value.length : value === undefined || value === null ? 0 : 1,
            };
            continue;
        }
        if (/elementIds$/i.test(key) && Array.isArray(value)) {
            summary[key] = { count: value.length };
            continue;
        }
        if (Array.isArray(value)) {
            summary[key] = { count: value.length };
            continue;
        }
        if (value && typeof value === "object") {
            summary[key] = { keys: Object.keys(value).sort() };
            continue;
        }
        const scalar = summarizeScalarParam(key, value);
        if (scalar !== undefined) {
            summary[key] = scalar;
        }
    }
    return summary;
}
function unwrapResponse(response) {
    if (response && typeof response === "object" && "result" in response) {
        return response.result;
    }
    return response;
}
function getValueCaseInsensitive(object, names) {
    if (!object || typeof object !== "object") {
        return undefined;
    }
    for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(object, name)) {
            return object[name];
        }
    }
    const entries = Object.entries(object);
    for (const [key, value] of entries) {
        if (names.some((name) => key.toLowerCase() === name.toLowerCase())) {
            return value;
        }
    }
    return undefined;
}
export function summarizeTelemetryResponse(response, error = null) {
    if (error) {
        return {
            success: false,
            errorMessage: truncateText(error instanceof Error ? error.message : String(error)),
            errorType: error instanceof Error ? error.name : "Error",
        };
    }
    const target = unwrapResponse(response);
    const isObject = target && typeof target === "object" && !Array.isArray(target);
    const successValue = isObject ? getValueCaseInsensitive(target, ["success", "Success"]) : undefined;
    const state = isObject ? getValueCaseInsensitive(target, ["state", "State"]) : undefined;
    const action = isObject ? getValueCaseInsensitive(target, ["action", "Action"]) : undefined;
    const errorValue = isObject ? getValueCaseInsensitive(target, ["error", "Error"]) : undefined;
    const messageValue = isObject ? getValueCaseInsensitive(target, ["message", "Message"]) : undefined;
    const responseText = typeof target === "string" ? target : "";
    const errorLikeText = /^\s*ERROR\s*:/i.test(responseText) ? responseText : "";
    const guarded = String(state || "").toLowerCase() === "guarded" ||
        /blocked by safety|guarded/i.test(String(errorValue || messageValue || responseText || ""));
    return {
        success: typeof successValue === "boolean" ? successValue : !errorValue && !errorLikeText,
        guarded,
        state: state || null,
        action: action || null,
        responseKind: Array.isArray(target) ? "array" : target === null ? "null" : typeof target,
        responseKeys: isObject ? Object.keys(target).sort().slice(0, 40) : [],
        errorMessage: errorValue || errorLikeText ? truncateText(errorValue || errorLikeText) : null,
        messageHash: messageValue ? shortHash(messageValue) : null,
    };
}
function summarizeMcpToolResult(result, error = null) {
    if (error) {
        return summarizeTelemetryResponse(null, error);
    }
    try {
        const text = result?.content?.find?.((item) => item?.type === "text")?.text;
        if (typeof text === "string" && text.trim().startsWith("{")) {
            return summarizeTelemetryResponse(JSON.parse(text));
        }
    }
    catch {
    }
    return {
        success: true,
        guarded: false,
        responseKind: result === null ? "null" : typeof result,
        responseKeys: result && typeof result === "object" ? Object.keys(result).sort().slice(0, 40) : [],
    };
}
function resolveTelemetryConfig() {
    const updaterConfig = readUpdaterConfig();
    return {
        disabled: telemetryDisabled(),
        localOnly: isTruthy(process.env.REVAGENT_TELEMETRY_LOCAL_ONLY),
        localRoot: process.env.REVAGENT_TELEMETRY_ROOT || defaultLocalTelemetryRoot(),
        reportsRoot: process.env.REVAGENT_REPORTS_ROOT || updaterConfig?.reportsRoot || "",
    };
}
function dateParts(date) {
    const year = date.getUTCFullYear().toString();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return { year, month, day, ymd: `${year}-${month}-${day}` };
}
export function resolveTelemetryTargets(event) {
    const config = resolveTelemetryConfig();
    if (config.disabled) {
        return [];
    }
    const timestamp = new Date(event.timestampUtc || Date.now());
    const parts = dateParts(timestamp);
    const machine = sanitizeTelemetryPathSegment(event.machineName, "unknown-machine");
    const localPath = path.join(config.localRoot, "events", `${parts.ymd}.ndjson`);
    const targets = [{ kind: "local", path: localPath }];
    if (!config.localOnly && config.reportsRoot) {
        targets.push({
            kind: "remote",
            path: path.join(config.reportsRoot, "events", parts.year, parts.month, parts.day, machine, `${event.sessionId}.ndjson`),
        });
    }
    return targets;
}
export function buildTelemetryEvent(partial = {}) {
    const installedState = readInstalledState();
    const runtimeVersion = installedState?.version || null;
    return {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        eventId: crypto.randomUUID(),
        eventType: partial.eventType || "runtime.event",
        timestampUtc: partial.timestampUtc || new Date().toISOString(),
        sessionId: TELEMETRY_SESSION_ID,
        sequence: ++telemetrySequence,
        source: "runtime-mcp-server",
        process: {
            pid: process.pid,
            nodeVersion: process.version,
            startedAtUtc: TELEMETRY_PROCESS_STARTED_AT_UTC,
        },
        machineName: process.env.COMPUTERNAME || os.hostname(),
        userName: process.env.USERNAME || process.env.USER || "",
        runtime: {
            version: runtimeVersion,
            buildHash: parseBuildHash(runtimeVersion),
        },
        ...partial,
    };
}
async function appendJsonLine(filePath, event) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
}
export async function recordTelemetryEvent(partial = {}) {
    if (telemetryDisabled()) {
        return;
    }
    const event = buildTelemetryEvent(partial);
    const targets = resolveTelemetryTargets(event);
    await Promise.allSettled(targets.map((target) => appendJsonLine(target.path, event)));
}
export function recordRuntimeSessionStart() {
    void recordTelemetryEvent({
        eventType: "runtime.session.start",
    });
}
export function recordRevitCommandTelemetry(details = {}) {
    const durationMs = Math.max(0, Date.now() - (details.startedAtMs || Date.now()));
    const responseSummary = summarizeTelemetryResponse(details.response, details.error);
    void recordTelemetryEvent({
        eventType: "revit.command",
        commandName: details.commandName,
        logicalToolName: details.logicalToolName || details.commandName,
        executionKind: details.executionKind || "bridgeCommand",
        taskName: details.params?.taskName || details.options?.taskName || null,
        taskIdPresent: Boolean(details.params?.taskId || details.options?.taskId),
        transactionMode: details.params?.transactionMode || details.options?.transactionMode || null,
        connection: {
            targetPresent: Boolean(details.options?.target),
            hostPresent: Boolean(details.options?.host),
            port: details.options?.port || null,
        },
        durationMs,
        params: summarizeTelemetryParams(details.params),
        result: responseSummary,
    });
}
function shouldRecordMcpTool(name) {
    if (name === "get_revit_mcp_status" && !isTruthy(process.env.REVAGENT_TELEMETRY_INCLUDE_STATUS)) {
        return false;
    }
    return true;
}
export function wrapServerWithTelemetry(server) {
    return {
        ...server,
        tool(name, description, schema, handler) {
            let actualDescription = description;
            let actualSchema = schema;
            let actualHandler = handler;
            if (typeof description === "object") {
                actualHandler = schema;
                actualSchema = description;
                actualDescription = "";
            }
            const wrappedHandler = async (args, extra) => {
                const startedAtMs = Date.now();
                try {
                    const result = await actualHandler(args, extra);
                    if (shouldRecordMcpTool(name)) {
                        void recordTelemetryEvent({
                            eventType: "mcp.tool",
                            toolName: name,
                            durationMs: Math.max(0, Date.now() - startedAtMs),
                            params: summarizeTelemetryParams(args),
                            result: summarizeMcpToolResult(result),
                        });
                    }
                    return result;
                }
                catch (error) {
                    if (shouldRecordMcpTool(name)) {
                        void recordTelemetryEvent({
                            eventType: "mcp.tool",
                            toolName: name,
                            durationMs: Math.max(0, Date.now() - startedAtMs),
                            params: summarizeTelemetryParams(args),
                            result: summarizeMcpToolResult(null, error),
                        });
                    }
                    throw error;
                }
            };
            return server.tool(name, actualDescription, actualSchema, wrappedHandler);
        },
    };
}
