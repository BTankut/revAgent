import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findWritePatterns } from "../tools/send_code_to_revit_safe_guards.js";
const TELEMETRY_SCHEMA_VERSION = "revagent.telemetry.v1";
const LIVE_STATUS_SCHEMA_VERSION = "revagent.live.status.v1";
const LIVE_ACTIVITY_SCHEMA_VERSION = "revagent.live.activity.v1";
const TELEMETRY_SESSION_ID = crypto.randomUUID();
const TELEMETRY_PROCESS_STARTED_AT_UTC = new Date().toISOString();
let telemetrySequence = 0;
const telemetryWriteQueues = new Map();
const liveWriteQueues = new Map();
const liveActiveTasks = new Map();
const liveRecentActivity = [];
let liveRevitStatus = null;
let liveWritesInFlight = 0;
let liveWritesDropped = 0;
let liveHeartbeatTimer = null;
let liveLastHeartbeatUtc = null;
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
function normalizeMachineName(value) {
    const text = String(value || "").trim();
    return (text || "unknown-machine").toUpperCase();
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
function truncateText(value, maxChars = 400) {
    const text = String(value || "");
    if (text.length <= maxChars) {
        return {
            text,
            truncated: false,
        };
    }
    return {
        text: `${text.slice(0, maxChars)}...[truncated ${text.length - maxChars} chars]`,
        truncated: true,
    };
}
function countLines(value) {
    return String(value || "").split(/\r\n|\r|\n/).length;
}
function clampTelemetryInt(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}
function telemetryTextLimit() {
    return clampTelemetryInt(process.env.REVAGENT_TELEMETRY_TEXT_CHARS, 1000, 0, 10000);
}
function telemetryCodeLimit() {
    return clampTelemetryInt(process.env.REVAGENT_TELEMETRY_CODE_CHARS, 4000, 0, 100000);
}
function liveStatusDisabled() {
    return telemetryDisabled() || isTruthy(process.env.REVAGENT_LIVE_STATUS_DISABLED);
}
function liveRecentActivityLimit() {
    return clampTelemetryInt(process.env.REVAGENT_LIVE_STATUS_RECENT, 50, 5, 200);
}
function liveMaxWriteInFlight() {
    return clampTelemetryInt(process.env.REVAGENT_LIVE_STATUS_MAX_IN_FLIGHT, 32, 1, 64);
}
function liveHeartbeatIntervalMs() {
    return clampTelemetryInt(process.env.REVAGENT_LIVE_STATUS_HEARTBEAT_MS, 5000, 0, 60000);
}
function summarizeText(value, maxChars) {
    const text = String(value || "");
    const summary = {
        hash: shortHash(text),
        length: text.length,
        present: text.length > 0,
    };
    if (maxChars > 0) {
        const truncated = truncateText(text, maxChars);
        summary.text = truncated.text;
        summary.textTruncated = truncated.truncated;
    }
    return summary;
}
function summarizeCode(code) {
    const text = String(code || "");
    const summary = {
        hash: shortHash(text),
        length: text.length,
        lineCount: countLines(text),
        writePatternCount: findWritePatterns(text).length,
        writePatterns: findWritePatterns(text).slice(0, 12),
        hasManualTransaction: /new\s+(Transaction|SubTransaction|TransactionGroup)\s*\(|\b(Transaction|SubTransaction|TransactionGroup)\s*\(/i.test(text),
    };
    const maxChars = telemetryCodeLimit();
    if (maxChars > 0) {
        const preview = truncateText(text, maxChars);
        summary.preview = preview.text;
        summary.previewTruncated = preview.truncated;
    }
    return summary;
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
        return summarizeText(value, telemetryTextLimit());
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
    if (response && typeof response === "object") {
        const topLevelSuccess = getValueCaseInsensitive(response, ["success", "Success"]);
        if (topLevelSuccess === false) {
            return response;
        }
        if ("result" in response && response.result !== null && response.result !== undefined) {
            return response.result;
        }
        if ("result" in response) {
            return response;
        }
    }
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
            errorMessage: truncateText(error instanceof Error ? error.message : String(error)).text,
            errorType: error instanceof Error ? error.name : "Error",
        };
    }
    const target = unwrapResponse(response);
    const isObject = target && typeof target === "object" && !Array.isArray(target);
    const successValue = isObject ? getValueCaseInsensitive(target, ["success", "Success"]) : undefined;
    const state = isObject ? getValueCaseInsensitive(target, ["state", "State"]) : undefined;
    const action = isObject ? getValueCaseInsensitive(target, ["action", "Action"]) : undefined;
    const errorValue = isObject ? getValueCaseInsensitive(target, ["error", "Error", "errorMessage", "ErrorMessage"]) : undefined;
    const messageValue = isObject ? getValueCaseInsensitive(target, ["message", "Message"]) : undefined;
    const responseText = typeof target === "string" ? target : "";
    const errorLikeText = /^\s*ERROR\s*:/i.test(responseText) ? responseText : "";
    const guarded = String(state || "").toLowerCase() === "guarded" ||
        getValueCaseInsensitive(target, ["guarded", "blocked", "focusBlocked"]) === true ||
        /blocked by safety|guarded|rejected write-looking code|does not support writeCommit|only executes with transactionMode 'none'/i.test(String(errorValue || messageValue || responseText || ""));
    return {
        success: typeof successValue === "boolean" ? successValue : !errorValue && !errorLikeText,
        guarded,
        state: state || null,
        action: action || null,
        responseKind: Array.isArray(target) ? "array" : target === null ? "null" : typeof target,
        responseKeys: isObject ? Object.keys(target).sort().slice(0, 40) : [],
        errorMessage: errorValue || errorLikeText ? truncateText(errorValue || errorLikeText).text : null,
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
function telemetryContextElementLimit() {
    return clampTelemetryInt(process.env.REVAGENT_TELEMETRY_CONTEXT_ELEMENTS, 12, 0, 100);
}
function parseJsonLikeText(value) {
    if (typeof value !== "string") {
        return value;
    }
    const text = value.trim();
    if (!text.startsWith("{") && !text.startsWith("[") && !text.startsWith("\"")) {
        return value;
    }
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed === "string") {
            return parseJsonLikeText(parsed);
        }
        return parsed;
    }
    catch {
        return value;
    }
}
function unwrapMcpToolResult(result) {
    try {
        const text = result?.content?.find?.((item) => item?.type === "text")?.text;
        if (typeof text === "string") {
            return parseJsonLikeText(text);
        }
    }
    catch {
    }
    return result;
}
function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function getValueCaseInsensitiveLocal(object, names) {
    return getValueCaseInsensitive(object, names);
}
function findFirstDeep(value, names, maxDepth = 5) {
    if (maxDepth < 0 || value === null || value === undefined) {
        return undefined;
    }
    if (Array.isArray(value)) {
        for (const item of value.slice(0, 50)) {
            const found = findFirstDeep(item, names, maxDepth - 1);
            if (found !== undefined && found !== null && found !== "") {
                return found;
            }
        }
        return undefined;
    }
    const object = asObject(value);
    if (!object) {
        return undefined;
    }
    const direct = getValueCaseInsensitiveLocal(object, names);
    if (direct !== undefined && direct !== null && direct !== "") {
        return direct;
    }
    for (const child of Object.values(object)) {
        const found = findFirstDeep(child, names, maxDepth - 1);
        if (found !== undefined && found !== null && found !== "") {
            return found;
        }
    }
    return undefined;
}
function findArraysByKey(value, keyNames, maxDepth = 5, results = []) {
    if (maxDepth < 0 || value === null || value === undefined || results.length >= 20) {
        return results;
    }
    if (Array.isArray(value)) {
        for (const item of value.slice(0, 50)) {
            findArraysByKey(item, keyNames, maxDepth - 1, results);
        }
        return results;
    }
    const object = asObject(value);
    if (!object) {
        return results;
    }
    for (const [key, child] of Object.entries(object)) {
        if (keyNames.some((name) => key.toLowerCase() === name.toLowerCase()) && Array.isArray(child)) {
            results.push(child);
        }
        findArraysByKey(child, keyNames, maxDepth - 1, results);
    }
    return results;
}
function findObjectsByKey(value, keyNames, maxDepth = 5, results = []) {
    if (maxDepth < 0 || value === null || value === undefined || results.length >= 20) {
        return results;
    }
    if (Array.isArray(value)) {
        for (const item of value.slice(0, 50)) {
            findObjectsByKey(item, keyNames, maxDepth - 1, results);
        }
        return results;
    }
    const object = asObject(value);
    if (!object) {
        return results;
    }
    for (const [key, child] of Object.entries(object)) {
        if (keyNames.some((name) => key.toLowerCase() === name.toLowerCase()) && asObject(child)) {
            results.push(child);
        }
        findObjectsByKey(child, keyNames, maxDepth - 1, results);
    }
    return results;
}
function coerceString(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return null;
}
function coerceNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
        return Number.parseInt(value.trim(), 10);
    }
    return null;
}
function arraySample(values, maxItems = 25) {
    return [...new Set((Array.isArray(values) ? values : [])
            .map((value) => coerceNumber(value))
            .filter((value) => Number.isFinite(value)))]
        .slice(0, maxItems);
}
function extractIdsFromParams(params = {}) {
    const ids = [];
    if (params.elementId !== undefined) {
        ids.push(params.elementId);
    }
    if (params.viewId !== undefined) {
        ids.push(params.viewId);
    }
    for (const [key, value] of Object.entries(params || {})) {
        if (/elementIds$/i.test(key) && Array.isArray(value)) {
            ids.push(...value);
        }
    }
    return arraySample(ids, 50);
}
function summarizeElement(value) {
    const object = asObject(value);
    if (!object) {
        return null;
    }
    const id = coerceNumber(getValueCaseInsensitiveLocal(object, ["id", "Id", "elementId", "ElementId"]));
    const name = coerceString(getValueCaseInsensitiveLocal(object, ["name", "Name"]));
    const category = coerceString(getValueCaseInsensitiveLocal(object, ["category", "Category", "categoryName", "CategoryName"]));
    const typeName = coerceString(getValueCaseInsensitiveLocal(object, ["typeName", "TypeName", "familyName", "FamilyName"]));
    const levelName = coerceString(getValueCaseInsensitiveLocal(object, ["levelName", "LevelName", "level", "Level"]));
    const roomName = coerceString(getValueCaseInsensitiveLocal(object, ["roomName", "RoomName", "room", "Room"]));
    const roomNumber = coerceString(getValueCaseInsensitiveLocal(object, ["roomNumber", "RoomNumber"]));
    const spaceName = coerceString(getValueCaseInsensitiveLocal(object, ["spaceName", "SpaceName", "space", "Space"]));
    const spaceNumber = coerceString(getValueCaseInsensitiveLocal(object, ["spaceNumber", "SpaceNumber"]));
    if (!id && !name && !category && !typeName && !levelName && !roomName && !spaceName) {
        return null;
    }
    return {
        id,
        name,
        category,
        typeName,
        levelName,
        roomName,
        roomNumber,
        spaceName,
        spaceNumber,
    };
}
function uniqueElements(elements) {
    const seen = new Set();
    return elements.filter((element) => {
        if (!element) {
            return false;
        }
        const key = element.id ? `id:${element.id}` : JSON.stringify(element);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
function extractElementSummaries(responseTarget, limit) {
    const arrays = findArraysByKey(responseTarget, [
        "elements",
        "Elements",
        "selectionElements",
        "SelectionElements",
    ]);
    const directObjects = findObjectsByKey(responseTarget, [
        "chosenElement",
        "ChosenElement",
        "targetElement",
        "TargetElement",
    ]);
    const elements = [];
    for (const object of directObjects) {
        elements.push(summarizeElement(object));
    }
    for (const array of arrays) {
        for (const item of array.slice(0, limit)) {
            elements.push(summarizeElement(item));
        }
    }
    return uniqueElements(elements).slice(0, limit);
}
function extractSelectionIds(responseTarget) {
    const raw = findFirstDeep(responseTarget, ["selectionIds", "SelectionIds"], 4);
    if (Array.isArray(raw)) {
        return arraySample(raw, 50);
    }
    return [];
}
function extractFileSummaries(responseTarget) {
    const arrays = findArraysByKey(responseTarget, ["files", "Files"], 4);
    const files = [];
    for (const array of arrays) {
        for (const item of array.slice(0, 12)) {
            const object = asObject(item);
            if (!object) {
                continue;
            }
            files.push({
                path: coerceString(getValueCaseInsensitiveLocal(object, ["path", "Path"])),
                fileName: coerceString(getValueCaseInsensitiveLocal(object, ["fileName", "FileName"])),
                bytes: coerceNumber(getValueCaseInsensitiveLocal(object, ["bytes", "Bytes"])),
                width: coerceNumber(getValueCaseInsensitiveLocal(object, ["width", "Width"])),
                height: coerceNumber(getValueCaseInsensitiveLocal(object, ["height", "Height"])),
                finalPixelSizeMatchesRequest: getValueCaseInsensitiveLocal(object, ["finalPixelSizeMatchesRequest", "FinalPixelSizeMatchesRequest"]),
            });
        }
    }
    return files.filter((file) => file.path || file.fileName);
}
function extractViewSummary(responseTarget, names) {
    const object = findFirstDeep(responseTarget, names, 4);
    if (!asObject(object)) {
        return null;
    }
    return {
        id: coerceNumber(getValueCaseInsensitiveLocal(object, ["id", "Id", "viewId", "ViewId"])),
        name: coerceString(getValueCaseInsensitiveLocal(object, ["name", "Name", "viewName", "ViewName"])),
        type: coerceString(getValueCaseInsensitiveLocal(object, ["type", "Type", "viewType", "ViewType"])),
    };
}
function uniqueStrings(values, maxItems = 20) {
    return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))].slice(0, maxItems);
}
function inferDiscipline(categories = [], taskName = "") {
    const text = `${categories.join(" ")} ${taskName}`.toLowerCase();
    if (/(duct|air terminal|mechanical equipment|diffuser|damper|hvac|fan coil|ahu|havaland|mekanik)/i.test(text)) {
        return "mechanical_hvac";
    }
    if (/(pipe|plumbing|sanitary|domestic|hydronic|sprinkler|fire|piping|boru|yangın|temiz su|pis su)/i.test(text)) {
        return "mechanical_piping";
    }
    if (/(electrical|cable|lighting|elektrik)/i.test(text)) {
        return "electrical";
    }
    if (/(wall|door|window|room|space|architect|mimari)/i.test(text)) {
        return "architectural";
    }
    return null;
}
function buildProjectId(documentPath, documentTitle) {
    const identity = documentPath || documentTitle || "";
    return identity ? shortHash(identity) : null;
}
export function extractProductionContext(details = {}) {
    const responseTarget = details.sourceEventType === "mcp.tool"
        ? unwrapMcpToolResult(details.response)
        : unwrapResponse(details.response);
    const responseObject = asObject(responseTarget);
    const params = details.params || {};
    const taskName = details.taskName || params.taskName || details.options?.taskName || details.logicalToolName || details.toolName || details.commandName || null;
    const responseSummary = details.responseSummary || summarizeTelemetryResponse(details.response, details.error);
    const elementLimit = telemetryContextElementLimit();
    const elements = elementLimit > 0 ? extractElementSummaries(responseTarget, elementLimit) : [];
    const categories = uniqueStrings([
        ...(Array.isArray(params.categoryNames) ? params.categoryNames.map(String) : []),
        coerceString(params.category),
        ...elements.map((element) => element.category),
    ]);
    const documentObject = findFirstDeep(responseTarget, ["document", "Document"], 3);
    const documentTitle = coerceString(findFirstDeep(responseTarget, ["documentTitle", "DocumentTitle"], 5)) ||
        coerceString(getValueCaseInsensitiveLocal(documentObject, ["title", "Title", "name", "Name"]));
    const documentPath = coerceString(findFirstDeep(responseTarget, ["documentPath", "DocumentPath"], 5)) ||
        coerceString(getValueCaseInsensitiveLocal(documentObject, ["path", "Path", "modelPath", "ModelPath"]));
    const activeView = extractViewSummary(responseTarget, ["activeView", "ActiveView", "view", "View"]);
    const beforeView = extractViewSummary(responseTarget, ["beforeView", "BeforeView", "activeViewBefore", "ActiveViewBefore"]);
    const afterView = extractViewSummary(responseTarget, ["afterView", "AfterView"]);
    const targetElementIds = extractIdsFromParams(params);
    const selectionIds = extractSelectionIds(responseTarget);
    const files = extractFileSummaries(responseTarget);
    const levelName = coerceString(findFirstDeep(responseTarget, ["levelName", "LevelName", "activePlanLevelName", "ActivePlanLevelName"], 5));
    const levelId = coerceNumber(findFirstDeep(responseTarget, ["levelId", "LevelId", "activePlanLevelId", "ActivePlanLevelId"], 5));
    const roomName = coerceString(findFirstDeep(responseTarget, ["roomName", "RoomName"], 5));
    const roomNumber = coerceString(findFirstDeep(responseTarget, ["roomNumber", "RoomNumber"], 5));
    const spaceName = coerceString(findFirstDeep(responseTarget, ["spaceName", "SpaceName"], 5));
    const spaceNumber = coerceString(findFirstDeep(responseTarget, ["spaceNumber", "SpaceNumber"], 5));
    const query = typeof params.query === "string" ? params.query : null;
    const outputDir = typeof params.outputDir === "string" ? params.outputDir : coerceString(findFirstDeep(responseTarget, ["outputDir", "OutputDir"], 4));
    const filePrefix = typeof params.filePrefix === "string" ? params.filePrefix : coerceString(findFirstDeep(responseTarget, ["filePrefix", "FilePrefix"], 4));
    const hasProductionSignal = Boolean(taskName ||
        documentTitle ||
        documentPath ||
        activeView ||
        beforeView ||
        afterView ||
        targetElementIds.length ||
        selectionIds.length ||
        elements.length ||
        files.length ||
        levelName ||
        roomName ||
        spaceName ||
        query ||
        outputDir);
    if (!hasProductionSignal) {
        return null;
    }
    return {
        eventType: "production.context",
        contextSchemaVersion: "revagent.production.context.v1",
        related: {
            sourceEventType: details.sourceEventType,
            toolName: details.toolName || null,
            commandName: details.commandName || null,
            logicalToolName: details.logicalToolName || null,
            executionKind: details.executionKind || null,
        },
        runId: details.taskId || params.taskId || details.options?.taskId || shortHash(`${TELEMETRY_SESSION_ID}|${details.sourceEventType || ""}|${details.toolName || ""}|${details.commandName || ""}|${details.startedAtMs || ""}|${taskName || ""}`),
        operation: {
            taskName,
            query,
            action: responseSummary.action || coerceString(findFirstDeep(responseTarget, ["action", "Action"], 3)),
            durationMs: details.durationMs,
            success: responseSummary.success,
            guarded: responseSummary.guarded,
            state: responseSummary.state,
            errorMessage: responseSummary.errorMessage,
        },
        project: {
            projectId: buildProjectId(documentPath, documentTitle),
            documentTitle,
            documentPath,
            isFamilyDocument: findFirstDeep(responseTarget, ["isFamilyDocument", "IsFamilyDocument"], 4),
            isReadOnly: findFirstDeep(responseTarget, ["isReadOnly", "IsReadOnly"], 4),
            isModifiable: findFirstDeep(responseTarget, ["isModifiable", "IsModifiable"], 4),
        },
        view: {
            active: activeView,
            before: beforeView,
            after: afterView,
            activeViewChanged: findFirstDeep(responseTarget, ["activeViewChanged", "ActiveViewChanged"], 4),
        },
        location: {
            levelId,
            levelName,
            roomName,
            roomNumber,
            spaceName,
            spaceNumber,
        },
        elements: {
            targetElementIds,
            selectionIds,
            selectionCount: coerceNumber(findFirstDeep(responseTarget, ["selectionCount", "SelectionCount"], 4)),
            categories,
            disciplineHint: inferDiscipline(categories, taskName || ""),
            samples: elements,
            samplesTruncated: elementLimit > 0 && elements.length >= elementLimit,
        },
        outputs: {
            outputDir,
            filePrefix,
            files,
        },
        response: {
            responseKeys: responseSummary.responseKeys || (responseObject ? Object.keys(responseObject).sort().slice(0, 40) : []),
        },
    };
}
function recordProductionContextTelemetry(details = {}) {
    const context = extractProductionContext(details);
    if (!context) {
        return;
    }
    void recordTelemetryEvent(context);
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
    const machine = sanitizeTelemetryPathSegment(normalizeMachineName(event.machineName), "unknown-machine");
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
function resolveLiveConfig() {
    const telemetryConfig = resolveTelemetryConfig();
    return {
        disabled: liveStatusDisabled(),
        localOnly: telemetryConfig.localOnly || isTruthy(process.env.REVAGENT_LIVE_STATUS_LOCAL_ONLY),
        localRoot: process.env.REVAGENT_LIVE_STATUS_LOCAL_ROOT || path.join(telemetryConfig.localRoot, "live"),
        reportsRoot: process.env.REVAGENT_LIVE_STATUS_ROOT || (telemetryConfig.reportsRoot ? path.join(telemetryConfig.reportsRoot, "live") : ""),
    };
}
function resolveLiveMachineTargets(relativeParts = []) {
    const config = resolveLiveConfig();
    if (config.disabled) {
        return [];
    }
    const machine = sanitizeTelemetryPathSegment(normalizeMachineName(process.env.COMPUTERNAME || os.hostname()), "unknown-machine");
    const parts = ["machines", machine, ...relativeParts];
    const targets = [
        {
            kind: "local",
            path: path.join(config.localRoot, ...parts),
        },
    ];
    if (!config.localOnly && config.reportsRoot) {
        targets.push({
            kind: "remote",
            path: path.join(config.reportsRoot, ...parts),
        });
    }
    return targets;
}
async function writeJsonFile(filePath, value) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function enqueueLiveWrite(filePath, writer) {
    if (liveStatusDisabled()) {
        return false;
    }
    if (liveWritesInFlight >= liveMaxWriteInFlight()) {
        liveWritesDropped++;
        return false;
    }
    liveWritesInFlight++;
    const previous = liveWriteQueues.get(filePath) || Promise.resolve();
    const write = previous
        .catch(() => undefined)
        .then(() => writer(filePath));
    liveWriteQueues.set(filePath, write);
    write
        .catch(() => {
        liveWritesDropped++;
    })
        .finally(() => {
        if (liveWriteQueues.get(filePath) === write) {
            liveWriteQueues.delete(filePath);
        }
        liveWritesInFlight = Math.max(0, liveWritesInFlight - 1);
    });
    return true;
}
function publicLiveTask(task) {
    if (!task) {
        return null;
    }
    return {
        liveTaskId: task.liveTaskId,
        scope: task.scope,
        toolName: task.toolName || null,
        commandName: task.commandName || null,
        logicalToolName: task.logicalToolName || null,
        executionKind: task.executionKind || null,
        taskName: task.taskName || null,
        taskIdPresent: Boolean(task.taskId),
        state: task.state,
        startedAtUtc: task.startedAtUtc,
        finishedAtUtc: task.finishedAtUtc || null,
        durationMs: task.durationMs ?? null,
        result: task.result || null,
    };
}
function publicRevitStatusTask(task) {
    if (!task || typeof task !== "object") {
        return null;
    }
    return {
        id: task.id || null,
        requestId: task.requestId || null,
        method: task.method || null,
        taskName: task.taskName || null,
        state: task.state || null,
        startedAtUtc: task.startedAtUtc || null,
        finishedAtUtc: task.finishedAtUtc || null,
        elapsedMs: task.elapsedMs ?? null,
        requestBytes: task.requestBytes ?? null,
        responseBytes: task.responseBytes ?? null,
        port: task.port || null,
        error: task.error || null,
    };
}
function normalizeRevitStatusPayload(status) {
    if (!status || typeof status !== "object") {
        return null;
    }
    const target = status.result && typeof status.result === "object" ? status.result : status;
    return {
        capturedAtUtc: new Date().toISOString(),
        activeTask: publicRevitStatusTask(target.activeTask),
        recentTasks: (Array.isArray(target.recentTasks) ? target.recentTasks : [])
            .map(publicRevitStatusTask)
            .filter(Boolean)
            .slice(0, 100),
        recentHistoryCount: target.recentHistoryCount ?? null,
        recentHistoryCapacity: target.recentHistoryCapacity ?? null,
    };
}
export function recordLiveRevitStatus(status) {
    if (liveStatusDisabled()) {
        return;
    }
    const normalized = normalizeRevitStatusPayload(status);
    if (!normalized) {
        return;
    }
    liveRevitStatus = normalized;
    writeLiveStatusSnapshot("revit.status");
}
function chooseBestActiveTask() {
    const active = [...liveActiveTasks.values()];
    if (active.length === 0) {
        return null;
    }
    return active
        .sort((a, b) => {
        const scopePriority = (task) => task.scope === "revit.command" ? 2 : 1;
        const priorityDelta = scopePriority(b) - scopePriority(a);
        if (priorityDelta !== 0) {
            return priorityDelta;
        }
        return String(b.startedAtUtc || "").localeCompare(String(a.startedAtUtc || ""));
    })[0];
}
function buildLiveStatusSnapshot(reason = "activity") {
    const installedState = readInstalledState();
    const runtimeVersion = installedState?.version || null;
    const nowUtc = new Date().toISOString();
    liveLastHeartbeatUtc = nowUtc;
    return {
        schemaVersion: LIVE_STATUS_SCHEMA_VERSION,
        generatedAtUtc: nowUtc,
        lastHeartbeatUtc: liveLastHeartbeatUtc,
        reason,
        machineName: normalizeMachineName(process.env.COMPUTERNAME || os.hostname()),
        userName: process.env.USERNAME || process.env.USER || "",
        sessionId: TELEMETRY_SESSION_ID,
        runtime: {
            version: runtimeVersion,
            buildHash: parseBuildHash(runtimeVersion),
        },
        process: {
            pid: process.pid,
            nodeVersion: process.version,
            startedAtUtc: TELEMETRY_PROCESS_STARTED_AT_UTC,
        },
        activeTask: publicLiveTask(chooseBestActiveTask()),
        activeTasks: [...liveActiveTasks.values()].map(publicLiveTask),
        recentActivity: liveRecentActivity.slice(0, liveRecentActivityLimit()),
        revitStatus: liveRevitStatus,
        writeHealth: {
            inFlight: liveWritesInFlight,
            dropped: liveWritesDropped,
            maxInFlight: liveMaxWriteInFlight(),
        },
    };
}
function hasUsefulLiveStatusData(status) {
    const recentTasks = Array.isArray(status?.revitStatus?.recentTasks) ? status.revitStatus.recentTasks : [];
    const activeTasks = Array.isArray(status?.activeTasks) ? status.activeTasks : [];
    const recentActivity = Array.isArray(status?.recentActivity) ? status.recentActivity : [];
    return Boolean(status?.activeTask ||
        activeTasks.length > 0 ||
        recentActivity.length > 0 ||
        status?.revitStatus?.activeTask ||
        recentTasks.length > 0);
}
function liveStatusAgeMs(status) {
    const ms = Date.parse(String(status?.generatedAtUtc || status?.lastHeartbeatUtc || ""));
    return Number.isFinite(ms) ? Math.max(0, Date.now() - ms) : Number.POSITIVE_INFINITY;
}
function mergeExistingLiveStatusSnapshot(filePath, snapshot) {
    if (hasUsefulLiveStatusData(snapshot)) {
        return snapshot;
    }
    const existing = readJsonFile(filePath);
    if (!existing || normalizeMachineName(existing.machineName) !== normalizeMachineName(snapshot.machineName)) {
        return snapshot;
    }
    const maxAgeMs = Math.max(10 * 60 * 1000, liveHeartbeatIntervalMs() * 6);
    if (!hasUsefulLiveStatusData(existing) || liveStatusAgeMs(existing) > maxAgeMs) {
        return snapshot;
    }
    return {
        ...snapshot,
        recentActivity: Array.isArray(snapshot.recentActivity) && snapshot.recentActivity.length > 0
            ? snapshot.recentActivity
            : (Array.isArray(existing.recentActivity) ? existing.recentActivity : []),
        revitStatus: existing.revitStatus
            ? {
                ...existing.revitStatus,
                activeTask: snapshot.revitStatus?.activeTask || null,
            }
            : snapshot.revitStatus,
    };
}
function writeLiveStatusSnapshot(reason = "activity") {
    const snapshot = buildLiveStatusSnapshot(reason);
    for (const target of resolveLiveMachineTargets(["status.json"])) {
        enqueueLiveWrite(target.path, (filePath) => writeJsonFile(filePath, mergeExistingLiveStatusSnapshot(filePath, snapshot)));
    }
}
function rememberLiveActivity(event) {
    const task = {
        liveTaskId: event.liveTaskId,
        scope: event.scope,
        toolName: event.toolName,
        commandName: event.commandName,
        logicalToolName: event.logicalToolName,
        executionKind: event.executionKind,
        taskName: event.taskName,
        taskId: event.taskId,
        state: event.state,
        startedAtUtc: event.startedAtUtc,
        finishedAtUtc: event.finishedAtUtc,
        durationMs: event.durationMs,
        result: event.result,
    };
    if (event.phase === "started") {
        liveActiveTasks.set(event.liveTaskId, task);
    }
    else {
        liveActiveTasks.delete(event.liveTaskId);
    }
    liveRecentActivity.unshift({
        timestampUtc: event.timestampUtc,
        phase: event.phase,
        state: event.state,
        scope: event.scope,
        toolName: event.toolName || null,
        commandName: event.commandName || null,
        logicalToolName: event.logicalToolName || null,
        executionKind: event.executionKind || null,
        taskName: event.taskName || null,
        startedAtUtc: event.startedAtUtc,
        finishedAtUtc: event.finishedAtUtc || null,
        durationMs: event.durationMs ?? null,
        result: event.result || null,
    });
    const limit = liveRecentActivityLimit();
    if (liveRecentActivity.length > limit) {
        liveRecentActivity.splice(limit);
    }
}
function writeLiveActivity(event) {
    rememberLiveActivity(event);
    const parts = dateParts(new Date(event.timestampUtc || Date.now()));
    for (const target of resolveLiveMachineTargets(["activity", `${parts.ymd}.ndjson`])) {
        enqueueLiveWrite(target.path, (filePath) => appendJsonLine(filePath, event));
    }
    writeLiveStatusSnapshot(event.phase);
}
function buildLiveTaskId(details = {}, startedAtMs) {
    if (details.taskId) {
        return String(details.taskId);
    }
    return shortHash([
        TELEMETRY_SESSION_ID,
        details.scope || "",
        details.toolName || "",
        details.commandName || "",
        details.logicalToolName || "",
        startedAtMs || Date.now(),
        details.taskName || "",
    ].join("|"));
}
export function recordLiveActivityStarted(details = {}) {
    if (liveStatusDisabled()) {
        return null;
    }
    const startedAtMs = details.startedAtMs || Date.now();
    const startedAtUtc = new Date(startedAtMs).toISOString();
    const liveTaskId = buildLiveTaskId(details, startedAtMs);
    const event = buildTelemetryEvent({
        schemaVersion: LIVE_ACTIVITY_SCHEMA_VERSION,
        eventType: "live.activity",
        phase: "started",
        state: "running",
        liveTaskId,
        scope: details.scope || "runtime",
        toolName: details.toolName || null,
        commandName: details.commandName || null,
        logicalToolName: details.logicalToolName || null,
        executionKind: details.executionKind || null,
        taskName: details.taskName || null,
        taskId: details.taskId || null,
        taskIdPresent: Boolean(details.taskId),
        startedAtUtc,
        params: summarizeTelemetryParams(details.params),
    });
    writeLiveActivity(event);
    return {
        liveTaskId,
        scope: event.scope,
        toolName: event.toolName,
        commandName: event.commandName,
        logicalToolName: event.logicalToolName,
        executionKind: event.executionKind,
        taskName: event.taskName,
        taskId: event.taskId,
        startedAtMs,
        startedAtUtc,
    };
}
export function recordLiveActivityFinished(task, details = {}) {
    if (!task || liveStatusDisabled()) {
        return;
    }
    const finishedAtMs = Date.now();
    const durationMs = details.durationMs ?? Math.max(0, finishedAtMs - (task.startedAtMs || finishedAtMs));
    const result = details.responseSummary || summarizeTelemetryResponse(details.response, details.error);
    const state = result.guarded ? "guarded" : result.success === false ? "failed" : "completed";
    const event = buildTelemetryEvent({
        schemaVersion: LIVE_ACTIVITY_SCHEMA_VERSION,
        eventType: "live.activity",
        phase: state,
        state,
        liveTaskId: task.liveTaskId,
        scope: task.scope || details.scope || "runtime",
        toolName: task.toolName || details.toolName || null,
        commandName: task.commandName || details.commandName || null,
        logicalToolName: task.logicalToolName || details.logicalToolName || null,
        executionKind: task.executionKind || details.executionKind || null,
        taskName: task.taskName || details.taskName || null,
        taskId: task.taskId || details.taskId || null,
        taskIdPresent: Boolean(task.taskId || details.taskId),
        startedAtUtc: task.startedAtUtc || null,
        finishedAtUtc: new Date(finishedAtMs).toISOString(),
        durationMs,
        result,
    });
    writeLiveActivity(event);
}
function startLiveStatusHeartbeat() {
    if (liveHeartbeatTimer || liveStatusDisabled()) {
        return;
    }
    const intervalMs = liveHeartbeatIntervalMs();
    if (intervalMs <= 0) {
        return;
    }
    writeLiveStatusSnapshot("session.start");
    liveHeartbeatTimer = setInterval(() => {
        writeLiveStatusSnapshot("heartbeat");
    }, intervalMs);
    if (typeof liveHeartbeatTimer.unref === "function") {
        liveHeartbeatTimer.unref();
    }
}
export async function flushLiveWritesForTests(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (liveWritesInFlight > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
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
        machineName: normalizeMachineName(process.env.COMPUTERNAME || os.hostname()),
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
function enqueueAppendJsonLine(filePath, event) {
    const previous = telemetryWriteQueues.get(filePath) || Promise.resolve();
    const write = previous
        .catch(() => undefined)
        .then(() => appendJsonLine(filePath, event));
    telemetryWriteQueues.set(filePath, write);
    write
        .finally(() => {
        if (telemetryWriteQueues.get(filePath) === write) {
            telemetryWriteQueues.delete(filePath);
        }
    })
        .catch(() => undefined);
    return write;
}
export async function recordTelemetryEvent(partial = {}) {
    if (telemetryDisabled()) {
        return;
    }
    const event = buildTelemetryEvent(partial);
    const targets = resolveTelemetryTargets(event);
    await Promise.allSettled(targets.map((target) => enqueueAppendJsonLine(target.path, event)));
}
export function recordRuntimeSessionStart() {
    startLiveStatusHeartbeat();
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
    recordProductionContextTelemetry({
        ...details,
        sourceEventType: "revit.command",
        durationMs,
        responseSummary,
        taskName: details.params?.taskName || details.options?.taskName || null,
        taskId: details.params?.taskId || details.options?.taskId || null,
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
                const shouldRecord = shouldRecordMcpTool(name);
                const liveTask = shouldRecord
                    ? recordLiveActivityStarted({
                        scope: "mcp.tool",
                        toolName: name,
                        taskName: args?.taskName || null,
                        taskId: args?.taskId || null,
                        params: args,
                        startedAtMs,
                    })
                    : null;
                try {
                    const result = await actualHandler(args, extra);
                    if (shouldRecord) {
                        const durationMs = Math.max(0, Date.now() - startedAtMs);
                        const responseSummary = summarizeMcpToolResult(result);
                        void recordTelemetryEvent({
                            eventType: "mcp.tool",
                            toolName: name,
                            taskName: args?.taskName || null,
                            taskIdPresent: Boolean(args?.taskId),
                            durationMs,
                            params: summarizeTelemetryParams(args),
                            result: responseSummary,
                        });
                        recordProductionContextTelemetry({
                            sourceEventType: "mcp.tool",
                            toolName: name,
                            taskName: args?.taskName || null,
                            taskId: args?.taskId || null,
                            params: args,
                            response: result,
                            durationMs,
                            startedAtMs,
                            responseSummary,
                        });
                        recordLiveActivityFinished(liveTask, {
                            response: result,
                            responseSummary,
                            durationMs,
                        });
                    }
                    return result;
                }
                catch (error) {
                    if (shouldRecord) {
                        const durationMs = Math.max(0, Date.now() - startedAtMs);
                        const responseSummary = summarizeMcpToolResult(null, error);
                        void recordTelemetryEvent({
                            eventType: "mcp.tool",
                            toolName: name,
                            taskName: args?.taskName || null,
                            taskIdPresent: Boolean(args?.taskId),
                            durationMs,
                            params: summarizeTelemetryParams(args),
                            result: responseSummary,
                        });
                        recordProductionContextTelemetry({
                            sourceEventType: "mcp.tool",
                            toolName: name,
                            taskName: args?.taskName || null,
                            taskId: args?.taskId || null,
                            params: args,
                            error,
                            durationMs,
                            startedAtMs,
                            responseSummary,
                        });
                        recordLiveActivityFinished(liveTask, {
                            error,
                            responseSummary,
                            durationMs,
                        });
                    }
                    throw error;
                }
            };
            return server.tool(name, actualDescription, actualSchema, wrappedHandler);
        },
    };
}
