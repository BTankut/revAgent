import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { findWritePatterns } from "../tools/send_code_to_revit_safe_guards.js";
import {
    defaultLocalTelemetryRoot,
    isTruthy,
    normalizeMachineName,
    parseBuildHash,
    readInstalledState,
    readJsonFile,
    readUpdaterConfig,
    sanitizeTelemetryPathSegment,
} from "./runtimeIdentity.js";
import {
    appendJsonLine,
    enqueueAppendJsonLine,
    enqueueLiveWrite,
    getLiveWriteHealth,
    writeJsonFile,
} from "./telemetryWriters.js";
import { mergeRevitStatusSnapshots } from "./revitTaskMerge.js";
import type { ToolServer } from "../tools/types.js";

export { sanitizeTelemetryPathSegment } from "./runtimeIdentity.js";
export { flushLiveWritesForTests, flushTelemetryWritesForTests } from "./telemetryWriters.js";

type JsonObject = Record<string, any>;
type JsonArray = any[];

interface LiveTask extends JsonObject {
    liveTaskId?: string;
    scope?: string | null;
    toolName?: string | null;
    commandName?: string | null;
    logicalToolName?: string | null;
    executionKind?: string | null;
    taskName?: string | null;
    taskId?: string | null;
    parentTaskName?: string | null;
    parentTaskId?: string | null;
    guardSource?: string | null;
    state?: string | null;
    startedAtUtc?: string | null;
    finishedAtUtc?: string | null;
    durationMs?: number | null;
    result?: any;
}

type RuntimeActivityMode = "summary" | "full";

const TELEMETRY_SCHEMA_VERSION = "revagent.telemetry.v1";
const LIVE_STATUS_SCHEMA_VERSION = "revagent.live.status.v1";
const LIVE_ACTIVITY_SCHEMA_VERSION = "revagent.live.activity.v1";
const TELEMETRY_SESSION_ID = crypto.randomUUID();
const TELEMETRY_PROCESS_STARTED_AT_UTC = new Date().toISOString();
const SPATIAL_EXTRACTION_NAMES = new Set(["capture_spatial_snapshot", "extract_spatial_snapshot", "inspect_levels"]);
const SPATIAL_STATE_CODES = new Set(["running", "completed", "guarded", "failed"]);
const SPATIAL_ACTION_CODES = new Set(["capture_spatial_snapshot", "extract_spatial_snapshot", "inspect_levels"]);
const SPATIAL_REASON_CODES = new Set([
    "needs_scope",
    "read_failed",
    "invalid_request",
    "invalid_cursor",
    "invalid_cursor_sort_position",
    "cursor_scope_mismatch",
    "cursor_revision_mismatch",
    "cursor_hash_mismatch",
    "capture_interrupted_by_change",
    "invalid_spatial_page_contract",
    "runtime_exception",
    "invalid_response_kind",
]);
const SPATIAL_STOP_CODES = new Set(["completed", "max_elapsed", "max_items", "max_bytes", "read_failed", "needs_scope"]);
const SPATIAL_COVERAGE_CODES = new Set(["complete", "incomplete_omissions", "incomplete_budget"]);
let telemetrySequence = 0;
const liveActiveTasks = new Map<string, LiveTask>();
const liveRecentActivity: LiveTask[] = [];
let liveRevitStatus: JsonObject | null = null;
let liveHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let liveLastHeartbeatUtc: string | null = null;

function telemetryDisabled() {
    return isTruthy(process.env.REVAGENT_TELEMETRY_DISABLED);
}

function hashText(value: any) {
    return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function shortHash(value: any) {
    return hashText(value).slice(0, 16);
}

function truncateText(value: any, maxChars = 400) {
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

function countLines(value: any) {
    return String(value || "").split(/\r\n|\r|\n/).length;
}

function clampTelemetryInt(value: any, fallback: number, min: number, max: number) {
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

function isSpatialExtractionName(value: unknown) {
    return SPATIAL_EXTRACTION_NAMES.has(String(value ?? "").trim().toLowerCase());
}

export function isSpatialExtractionTelemetry(details: JsonObject = {}) {
    const params = details.params || {};
    return [
        details.toolName,
        details.commandName,
        details.logicalToolName,
        params.logicalToolName,
        params.wrapperAction,
    ].some(isSpatialExtractionName);
}

export function summarizeSpatialExtractionTelemetryParams(params: JsonObject = {}, operationName?: unknown) {
    const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
    const finiteInteger = (value: unknown) => {
        const parsed = Number.parseInt(String(value ?? ""), 10);
        return Number.isFinite(parsed) ? parsed : null;
    };
    const sourceScope = ["hostOnly", "linkedOnly", "hostAndLinked"].includes(String(params.sourceScope || ""))
        ? params.sourceScope
        : null;
    const summary: JsonObject = {
        privacyBoundary: "spatial_extraction",
        levelSelectorCount: count(params.levelIds) + count(params.levelNames),
        levelIdCount: count(params.levelIds),
        levelNameCount: count(params.levelNames),
        nameQueryPresent: typeof params.nameQuery === "string" && params.nameQuery.length > 0,
        linkInstanceSelectorCount: count(params.linkInstanceIds) + count(params.linkInstanceUniqueIds),
        linkedSourceLevelSelectorCount: count(params.linkedSourceLevels) + count(params.linkedSourceLevelNames),
        sourceScope,
        cursorPresent: typeof params.cursor === "string" && params.cursor.length > 0,
        pageTargetBytes: finiteInteger(params.pageTargetBytes),
        maxElements: finiteInteger(params.maxElements),
        maxResults: finiteInteger(params.maxResults),
        maxElapsedMs: finiteInteger(params.maxElapsedMs),
        timeoutMs: finiteInteger(params.timeoutMs),
    };
    if (String(operationName ?? "").trim().toLowerCase() !== "inspect_levels") {
        summary.includeHostMep = params.includeHostMep !== false;
        summary.includeRoomsSpaces = params.includeRoomsSpaces !== false;
        summary.includeLinkedObstructions = params.includeLinkedObstructions !== false;
    }
    return summary;
}

function summarizeText(value: any, maxChars: number) {
    const text = String(value || "");
    const summary: JsonObject = {
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

function summarizeCode(code: any) {
    const text = String(code || "");
    const summary: JsonObject = {
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

function summarizeScalarParam(key: string, value: any) {
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
        "searchBudget",
        "linkScope",
        "reason",
        "scanStoppedReason",
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

export function summarizeTelemetryParams(params: JsonObject = {}) {
    const summary: JsonObject = {
        keys: [] as string[],
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

function unwrapResponse(response: any) {
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

function getValueCaseInsensitive(object: any, names: string[]) {
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

function normalizeGuardSource(value: any): "runtime" | "client" | null {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "runtime" || normalized === "client") {
        return normalized;
    }
    return null;
}

export function summarizeTelemetryResponse(response: any, error: any = null) {
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
    const explicitGuardSource = isObject ? getValueCaseInsensitive(target, ["guardSource", "GuardSource"]) : undefined;
    const responseText = typeof target === "string" ? target : "";
    const errorLikeText = /^\s*ERROR\s*:/i.test(responseText) ? responseText : "";
    const guarded = String(state || "").toLowerCase() === "guarded" ||
        getValueCaseInsensitive(target, ["guarded", "blocked", "focusBlocked"]) === true ||
        /blocked by safety|guarded|rejected write-looking code|does not support writeCommit|only executes with transactionMode 'none'/i.test(String(errorValue || messageValue || responseText || ""));

    return {
        success: typeof successValue === "boolean" ? successValue : !errorValue && !errorLikeText,
        guarded,
        guardSource: guarded ? normalizeGuardSource(explicitGuardSource) || "runtime" : null,
        state: state || null,
        action: action || null,
        responseKind: Array.isArray(target) ? "array" : target === null ? "null" : typeof target,
        responseKeys: isObject ? Object.keys(target).sort().slice(0, 40) : [],
        errorMessage: errorValue || errorLikeText ? truncateText(errorValue || errorLikeText).text : null,
        messageHash: messageValue ? shortHash(messageValue) : null,
    };
}

function summarizeMcpToolResult(result: any, error: any = null) {
    if (error) {
        return summarizeTelemetryResponse(null, error);
    }

    try {
        const text = result?.content?.find?.((item: any) => item?.type === "text")?.text;
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

function parseJsonLikeText(value: any): any {
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

function unwrapMcpToolResult(result: any) {
    try {
        const text = result?.content?.find?.((item: any) => item?.type === "text")?.text;
        if (typeof text === "string") {
            return parseJsonLikeText(text);
        }
    }
    catch {
    }
    return result;
}

function safeSpatialCode(value: unknown, allowed: Set<string>) {
    const normalized = String(value ?? "").trim().toLowerCase();
    return allowed.has(normalized) ? normalized : null;
}

export function summarizeSpatialExtractionTelemetryResponse(response: any, error: any = null) {
    if (error) {
        return {
            success: false,
            guarded: false,
            state: "failed",
            reason: "runtime_exception",
            privacyBoundary: "spatial_extraction",
        };
    }

    const unwrappedMcp = response?.content ? unwrapMcpToolResult(response) : response;
    const target = unwrapResponse(unwrappedMcp);
    const object = asObject(target);
    if (!object) {
        return {
            success: false,
            guarded: false,
            state: "failed",
            reason: "invalid_response_kind",
            privacyBoundary: "spatial_extraction",
        };
    }

    const page = asObject(getValueCaseInsensitiveLocal(object, ["page", "Page"]));
    const nodes = getValueCaseInsensitiveLocal(object, ["nodes", "Nodes"]);
    const omissions = getValueCaseInsensitiveLocal(object, ["omissions", "Omissions"]);
    const revisions = getValueCaseInsensitiveLocal(object, ["sourceRevisions", "SourceRevisions"]);
    const successValue = getValueCaseInsensitiveLocal(object, ["success", "Success"]);
    const guarded = getValueCaseInsensitiveLocal(object, ["guarded", "Guarded"]) === true;
    const pageOrdinal = coerceNumber(getValueCaseInsensitiveLocal(page, ["ordinal", "Ordinal", "pageOrdinal", "PageOrdinal"]))
        ?? coerceNumber(getValueCaseInsensitiveLocal(object, ["pageOrdinal", "PageOrdinal"]));
    const recordCount = coerceNumber(getValueCaseInsensitiveLocal(page, ["recordCount", "RecordCount", "rowCount", "RowCount"]))
        ?? coerceNumber(getValueCaseInsensitiveLocal(object, ["returnedCount", "ReturnedCount"]))
        ?? (Array.isArray(nodes) ? nodes.length : null);
    const omissionCount = coerceNumber(getValueCaseInsensitiveLocal(page, ["omissionCount", "OmissionCount"]))
        ?? (Array.isArray(omissions) ? omissions.length : null);
    const payloadBytes = coerceNumber(getValueCaseInsensitiveLocal(page, ["payloadBytes", "PayloadBytes"]))
        ?? coerceNumber(getValueCaseInsensitiveLocal(object, ["payloadBytes", "PayloadBytes"]));
    const nextCursor = getValueCaseInsensitiveLocal(object, ["nextCursor", "NextCursor"])
        ?? getValueCaseInsensitiveLocal(page, ["nextCursor", "NextCursor"]);

    return {
        success: typeof successValue === "boolean" ? successValue : !guarded,
        guarded,
        state: safeSpatialCode(getValueCaseInsensitiveLocal(object, ["state", "State"]), SPATIAL_STATE_CODES) || (guarded ? "guarded" : "completed"),
        action: safeSpatialCode(getValueCaseInsensitiveLocal(object, ["action", "Action"]), SPATIAL_ACTION_CODES),
        reason: safeSpatialCode(getValueCaseInsensitiveLocal(object, ["reason", "Reason"]), SPATIAL_REASON_CODES),
        scanStoppedReason: safeSpatialCode(getValueCaseInsensitiveLocal(object, ["scanStoppedReason", "ScanStoppedReason"]), SPATIAL_STOP_CODES),
        coverageStatus: safeSpatialCode(getValueCaseInsensitiveLocal(object, ["coverageStatus", "CoverageStatus"]), SPATIAL_COVERAGE_CODES),
        partial: getValueCaseInsensitiveLocal(object, ["partial", "Partial"]) === true,
        pageOrdinal,
        recordCount,
        omissionCount,
        sourceRevisionCount: Array.isArray(revisions) ? revisions.length : null,
        payloadBytes,
        hasMore: getValueCaseInsensitiveLocal(page, ["hasMore", "HasMore"]) === true,
        nextCursorPresent: typeof nextCursor === "string" && nextCursor.length > 0,
        privacyBoundary: "spatial_extraction",
    };
}

function asObject(value: any): JsonObject | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function getValueCaseInsensitiveLocal(object: any, names: string[]) {
    return getValueCaseInsensitive(object, names);
}

function findFirstDeep(value: any, names: string[], maxDepth = 5): any {
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

function findArraysByKey(value: any, keyNames: string[], maxDepth = 5, results: JsonArray[] = []) {
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

function findObjectsByKey(value: any, keyNames: string[], maxDepth = 5, results: JsonObject[] = []) {
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

function coerceString(value: any) {
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

function coerceNumber(value: any) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
        return Number.parseInt(value.trim(), 10);
    }
    return null;
}

function arraySample(values: any, maxItems = 25) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map((value) => coerceNumber(value))
        .filter((value) => Number.isFinite(value)))]
        .slice(0, maxItems);
}

function extractIdsFromParams(params: JsonObject = {}) {
    const ids: any[] = [];
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

function summarizeElement(value: any) {
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

function uniqueElements(elements: any[]) {
    const seen = new Set<string>();
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

function extractElementSummaries(responseTarget: any, limit: number) {
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
    const elements: any[] = [];
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

function extractSelectionIds(responseTarget: any) {
    const raw = findFirstDeep(responseTarget, ["selectionIds", "SelectionIds"], 4);
    if (Array.isArray(raw)) {
        return arraySample(raw, 50);
    }
    return [];
}

function extractFileSummaries(responseTarget: any) {
    const arrays = findArraysByKey(responseTarget, ["files", "Files"], 4);
    const files: JsonObject[] = [];
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

function extractViewSummary(responseTarget: any, names: string[]) {
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

function uniqueStrings(values: any[], maxItems = 20) {
    return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))].slice(0, maxItems);
}

function inferDiscipline(categories: any[] = [], taskName = "", extraText = "", toolName = "") {
    const text = `${categories.join(" ")} ${taskName} ${extraText} ${toolName}`.toLowerCase();
    if (/\bm\d{2,}[a-z]?\b/i.test(text)) {
        return "mechanical_hvac";
    }
    if (/\bp\d{2,}[a-z]?\b/i.test(text)) {
        return "mechanical_piping";
    }
    if (/\be\d{2,}[a-z]?\b/i.test(text)) {
        return "electrical";
    }
    if (/\bs\d{2,}[a-z]?\b/i.test(text)) {
        return "structural";
    }
    if (/\ba\d{2,}[a-z]?\b/i.test(text)) {
        return "architectural";
    }
    if (/(duct|air terminal|mechanical equipment|diffuser|damper|hvac|fan coil|ahu|havaland|mekanik)/i.test(text)) {
        return "mechanical_hvac";
    }
    if (/(pipe|plumbing|sanitary|domestic|hydronic|sprinkler|fire|piping|boru|yangın|yangin|temiz su|pis su)/i.test(text)) {
        return "mechanical_piping";
    }
    if (/(electrical|cable|lighting|elektrik)/i.test(text)) {
        return "electrical";
    }
    if (/(structural|beam|column|framing|statik|kiris|kolon)/i.test(text)) {
        return "structural";
    }
    if (/(wall|door|window|room|space|architect|mimari)/i.test(text)) {
        return "architectural";
    }
    if (/(schedule|sheet|drawing|revision|pafta|metraj|mahal listesi)/i.test(text)) {
        return "schedule_documentation";
    }
    return null;
}

function buildProjectId(documentPath: any, documentTitle: any) {
    const identity = documentPath || documentTitle || "";
    return identity ? shortHash(identity) : null;
}

function firstStringParam(params: JsonObject = {}, names: string[] = []) {
    for (const name of names) {
        const value = params?.[name];
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }
    return null;
}

function collectStringParams(params: JsonObject = {}, names: string[] = []) {
    return names
        .map((name) => params?.[name])
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim());
}

function collectContextText(params: JsonObject = {}, taskName = "", activeView: any = null, beforeView: any = null, afterView: any = null, details: JsonObject = {}) {
    const values = [
        taskName,
        details.toolName,
        details.commandName,
        details.logicalToolName,
        ...collectStringParams(params, [
            "query",
            "nameQuery",
            "cellQuery",
            "sheetQuery",
            "scheduleNameQuery",
            "scheduleQuery",
            "rowTextQuery",
            "planNameContains",
            "category",
            "discipline",
        ]),
        ...(Array.isArray(params.rowTextQueries) ? params.rowTextQueries : []),
        ...(Array.isArray(params.categoryNames) ? params.categoryNames : []),
        activeView?.name,
        beforeView?.name,
        afterView?.name,
    ];
    return values
        .filter((value) => typeof value === "string" && value.trim())
        .join(" ");
}

function inferLevelNameFromText(...values: any[]) {
    const text = values.filter((value) => typeof value === "string" && value.trim()).join(" ");
    if (!text) {
        return null;
    }
    const levelMatch = text.match(/\b(?:level|lvl|l)\s*[-_ ]?(\d{1,2})\b/i);
    if (levelMatch) {
        return `Level ${levelMatch[1].padStart(2, "0")}`;
    }
    const floorMatch = text.match(/\b(?:kat|floor)\s*[-_ ]?(\d{1,2})\b/i);
    if (floorMatch) {
        return `Level ${floorMatch[1].padStart(2, "0")}`;
    }
    const basementMatch = text.match(/\b(?:basement|bodrum|b)\s*[-_ ]?(\d{1,2})\b/i);
    if (basementMatch) {
        return `Basement ${basementMatch[1].padStart(2, "0")}`;
    }
    return null;
}

export function extractProductionContext(details: JsonObject = {}) {
    if (isSpatialExtractionTelemetry(details)) {
        return null;
    }
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
    const query = firstStringParam(params, ["query", "nameQuery", "cellQuery", "sheetQuery", "scheduleNameQuery", "scheduleQuery", "rowTextQuery"]);
    const outputDir = typeof params.outputDir === "string" ? params.outputDir : coerceString(findFirstDeep(responseTarget, ["outputDir", "OutputDir"], 4));
    const filePrefix = typeof params.filePrefix === "string" ? params.filePrefix : coerceString(findFirstDeep(responseTarget, ["filePrefix", "FilePrefix"], 4));
    const contextText = collectContextText(params, taskName || "", activeView, beforeView, afterView, details);
    const inferredLevelName = levelName || inferLevelNameFromText(contextText);
    const inferredScope = findFirstDeep(responseTarget, ["inferredScope", "InferredScope"], 5);
    const effectiveScope = findFirstDeep(responseTarget, ["effectiveScope", "EffectiveScope"], 5);
    const riskPolicy = findFirstDeep(responseTarget, ["riskPolicy", "RiskPolicy", "searchRiskPolicy", "SearchRiskPolicy"], 5);
    const scanPolicy = findFirstDeep(responseTarget, ["scanPolicy", "ScanPolicy"], 5);
    const partial = findFirstDeep(responseTarget, ["partial", "Partial"], 4);
    const scanStoppedReason = coerceString(findFirstDeep(responseTarget, ["scanStoppedReason", "ScanStoppedReason"], 4));
    const scannedElementCount = coerceNumber(findFirstDeep(responseTarget, ["scannedElementCount", "ScannedElementCount"], 4));

    const hasProductionSignal = Boolean(
        taskName ||
        documentTitle ||
        documentPath ||
        activeView ||
        beforeView ||
        afterView ||
        targetElementIds.length ||
        selectionIds.length ||
        elements.length ||
        files.length ||
        inferredLevelName ||
        roomName ||
        spaceName ||
        query ||
        outputDir
    );
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
            levelName: inferredLevelName,
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
            disciplineHint: inferDiscipline(categories, taskName || "", contextText, details.toolName || details.logicalToolName || details.commandName || ""),
            samples: elements,
            samplesTruncated: elementLimit > 0 && elements.length >= elementLimit,
        },
        outputs: {
            outputDir,
            filePrefix,
            files,
        },
        search: {
            query,
            inferredScope,
            effectiveScope,
            riskPolicy,
            riskLevel: getValueCaseInsensitiveLocal(riskPolicy, ["riskLevel", "RiskLevel"]) || null,
            recommendedFirstScope: getValueCaseInsensitiveLocal(riskPolicy, ["recommendedFirstScope", "RecommendedFirstScope"]) || null,
            requiresUserControl: getValueCaseInsensitiveLocal(riskPolicy, ["requiresUserControl", "RequiresUserControl"]) === true,
            scanPolicy,
            searchBudget: params.searchBudget || getValueCaseInsensitiveLocal(scanPolicy, ["searchBudget", "SearchBudget"]) || null,
            linkScope: params.linkScope || getValueCaseInsensitiveLocal(effectiveScope, ["linkScope", "LinkScope"]) || null,
            planCandidateMode: params.planCandidateMode || getValueCaseInsensitiveLocal(scanPolicy, ["planCandidateMode", "PlanCandidateMode"]) || null,
            allowExpensiveSearch: params.allowExpensiveSearch === true || getValueCaseInsensitiveLocal(scanPolicy, ["allowExpensiveSearch", "AllowExpensiveSearch"]) === true,
            scannedElementCount,
            partial: partial === true,
            scanStoppedReason,
            needsScope: responseSummary.guarded && responseSummary.state === "guarded" && (
                getValueCaseInsensitiveLocal(responseObject, ["reason", "Reason"]) === "needs_scope" ||
                scanStoppedReason === "needs_scope"
            ),
        },
        response: {
            responseKeys: responseSummary.responseKeys || (responseObject ? Object.keys(responseObject).sort().slice(0, 40) : []),
        },
    };
}

function recordProductionContextTelemetry(details: JsonObject = {}) {
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

function dateParts(date: Date) {
    const year = date.getUTCFullYear().toString();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return { year, month, day, ymd: `${year}-${month}-${day}` };
}

export function resolveTelemetryTargets(event: JsonObject) {
    const config = resolveTelemetryConfig();
    if (config.disabled) {
        return [];
    }

    const timestamp = new Date(event.timestampUtc || Date.now());
    const parts = dateParts(timestamp);
    const machine = sanitizeTelemetryPathSegment(normalizeMachineName(event.machineName), "unknown-machine");
    const localPath = path.join(config.localRoot, "events", `${parts.ymd}.ndjson`);
    const targets: JsonObject[] = [{ kind: "local", path: localPath }];

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

function resolveLiveMachineTargets(relativeParts: string[] = []) {
    const config = resolveLiveConfig();
    if (config.disabled) {
        return [];
    }

    const machine = sanitizeTelemetryPathSegment(normalizeMachineName(process.env.COMPUTERNAME || os.hostname()), "unknown-machine");
    const parts = ["machines", machine, ...relativeParts];
    const targets: JsonObject[] = [
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

function compactRuntimeActivityResult(result: any) {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
        return null;
    }
    return {
        success: typeof result.success === "boolean" ? result.success : null,
        guarded: result.guarded === true,
        guardSource: result.guardSource || null,
        state: result.state || null,
        action: result.action || null,
        errorMessage: result.errorMessage || null,
        messageHash: result.messageHash || null,
    };
}

function publicLiveTask(task: LiveTask | null | undefined, mode: RuntimeActivityMode = "summary") {
    if (!task) {
        return null;
    }

    const row: JsonObject = {
        liveTaskId: task.liveTaskId,
        scope: task.scope,
        toolName: task.toolName || null,
        commandName: task.commandName || null,
        logicalToolName: task.logicalToolName || null,
        executionKind: task.executionKind || null,
        taskName: task.taskName || null,
        taskIdPresent: Boolean(task.taskId),
        parentTaskName: task.parentTaskName || null,
        parentTaskIdPresent: Boolean(task.parentTaskId),
        state: task.state,
        guardSource: task.guardSource || null,
        startedAtUtc: task.startedAtUtc,
        finishedAtUtc: task.finishedAtUtc || null,
        durationMs: task.durationMs ?? null,
        result: mode === "full" ? task.result || null : compactRuntimeActivityResult(task.result),
    };
    if (mode !== "full" && !row.result) {
        delete row.result;
    }
    return row;
}

function publicRevitStatusTask(task: any) {
    if (!task || typeof task !== "object") {
        return null;
    }
    const commandName = task.commandName || task.method || null;
    const toolName = task.wrapperAction || task.logicalToolName || task.toolName || commandName;
    const spatialExtraction = [commandName, toolName, task.wrapperAction, task.logicalToolName]
        .some(isSpatialExtractionName);

    return {
        id: task.id || null,
        requestId: task.requestId || null,
        method: toolName || null,
        toolName: toolName || null,
        commandName,
        wrapperAction: task.wrapperAction || null,
        logicalToolName: task.logicalToolName || null,
        taskName: spatialExtraction ? null : task.taskName || null,
        parentTaskName: spatialExtraction ? null : task.parentTaskName || null,
        parentTaskIdPresent: spatialExtraction ? false : Boolean(task.parentTaskIdPresent || task.parentTaskId),
        state: task.state || null,
        startedAtUtc: task.startedAtUtc || null,
        finishedAtUtc: task.finishedAtUtc || null,
        elapsedMs: task.elapsedMs ?? null,
        requestBytes: task.requestBytes ?? null,
        responseBytes: task.responseBytes ?? null,
        port: task.port || null,
        error: spatialExtraction ? null : task.error || null,
    };
}

function publicRuntimeActivityRow(task: LiveTask, mode: RuntimeActivityMode) {
    if (mode === "full") {
        return task;
    }
    const result = compactRuntimeActivityResult(task.result);
    const row: JsonObject = {
        timestampUtc: task.timestampUtc || task.finishedAtUtc || task.startedAtUtc || null,
        phase: task.phase,
        state: task.state || task.phase || null,
        scope: task.scope || null,
        toolName: task.toolName || null,
        commandName: task.commandName || null,
        logicalToolName: task.logicalToolName || null,
        executionKind: task.executionKind || null,
        taskName: task.taskName || null,
        parentTaskName: task.parentTaskName || null,
        parentTaskIdPresent: Boolean(task.parentTaskIdPresent || task.parentTaskId),
        guardSource: task.guardSource || result?.guardSource || null,
        startedAtUtc: task.startedAtUtc || null,
        finishedAtUtc: task.finishedAtUtc || null,
        durationMs: task.durationMs ?? null,
    };
    if (result) {
        row.success = result.success;
        row.guarded = result.guarded;
        row.action = result.action;
        row.errorMessage = result.errorMessage;
        row.messageHash = result.messageHash;
    }
    return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined && value !== null));
}

export function getLiveRuntimeActivityStatus(limit = 10, mode: RuntimeActivityMode = "summary") {
    const maxItems = clampTelemetryInt(limit, 10, 0, 100);
    const activityMode: RuntimeActivityMode = mode === "full" ? "full" : "summary";
    const sourceRows = activityMode === "full"
        ? liveRecentActivity
        : liveRecentActivity.filter((item) => item.phase !== "started");
    const recentActivity = sourceRows
        .slice(0, maxItems)
        .map((item) => publicRuntimeActivityRow(item, activityMode));
    return {
        mode: activityMode,
        activeTask: publicLiveTask(chooseBestActiveTask(), activityMode),
        activeTasks: [...liveActiveTasks.values()].map((item) => publicLiveTask(item, activityMode)),
        recentActivity,
        recentActivityCount: recentActivity.length,
        recentActivityStoredCount: liveRecentActivity.length,
        recentActivityCapacity: liveRecentActivityLimit(),
    };
}

function normalizeRevitStatusPayload(status: any) {
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

export function recordLiveRevitStatus(status: any) {
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
            const scopePriority = (task: LiveTask) => task.scope === "revit.command" ? 2 : 1;
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
        activeTask: publicLiveTask(chooseBestActiveTask(), "full"),
        activeTasks: [...liveActiveTasks.values()].map((item) => publicLiveTask(item, "full")),
        recentActivity: liveRecentActivity.slice(0, liveRecentActivityLimit()),
        revitStatus: liveRevitStatus,
        writeHealth: getLiveWriteHealth(liveMaxWriteInFlight()),
    };
}

function hasUsefulLiveStatusData(status: any) {
    const recentTasks = Array.isArray(status?.revitStatus?.recentTasks) ? status.revitStatus.recentTasks : [];
    const activeTasks = Array.isArray(status?.activeTasks) ? status.activeTasks : [];
    const recentActivity = Array.isArray(status?.recentActivity) ? status.recentActivity : [];
    return Boolean(
        status?.activeTask ||
        activeTasks.length > 0 ||
        recentActivity.length > 0 ||
        status?.revitStatus?.activeTask ||
        recentTasks.length > 0,
    );
}

function liveStatusAgeMs(status: any) {
    const ms = Date.parse(String(status?.generatedAtUtc || status?.lastHeartbeatUtc || ""));
    return Number.isFinite(ms) ? Math.max(0, Date.now() - ms) : Number.POSITIVE_INFINITY;
}

function mergeExistingLiveStatusSnapshot(filePath: string, snapshot: JsonObject) {
    const existing = readJsonFile(filePath);
    if (!existing || normalizeMachineName(existing.machineName) !== normalizeMachineName(snapshot.machineName)) {
        return snapshot;
    }

    const maxAgeMs = Math.max(10 * 60 * 1000, liveHeartbeatIntervalMs() * 6);
    if (!hasUsefulLiveStatusData(existing) || liveStatusAgeMs(existing) > maxAgeMs) {
        return snapshot;
    }

    // Multiple runtime sessions on the same workstation can write heartbeat-only
    // or partial snapshots. Preserve rich recent history from all recent
    // Revit-connected sessions, but never resurrect a cached active task.
    return {
        ...snapshot,
        recentActivity: Array.isArray(snapshot.recentActivity) && snapshot.recentActivity.length > 0
            ? snapshot.recentActivity
            : (Array.isArray(existing.recentActivity) ? existing.recentActivity : []),
        revitStatus: mergeRevitStatusSnapshots(snapshot.revitStatus, existing.revitStatus),
    };
}

function writeLiveStatusSnapshot(reason = "activity") {
    const snapshot = buildLiveStatusSnapshot(reason);
    for (const target of resolveLiveMachineTargets(["status.json"])) {
        enqueueLiveWrite(
            target.path,
            (filePath) => writeJsonFile(filePath, mergeExistingLiveStatusSnapshot(filePath, snapshot)),
            { disabled: liveStatusDisabled, maxInFlight: liveMaxWriteInFlight },
        );
    }
}

function rememberLiveActivity(event: JsonObject) {
    const task: LiveTask = {
        liveTaskId: event.liveTaskId,
        scope: event.scope,
        toolName: event.toolName,
        commandName: event.commandName,
        logicalToolName: event.logicalToolName,
        executionKind: event.executionKind,
        taskName: event.taskName,
        taskId: event.taskId,
        parentTaskName: event.parentTaskName,
        parentTaskId: event.parentTaskId,
        guardSource: event.guardSource,
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
        parentTaskName: event.parentTaskName || null,
        parentTaskIdPresent: Boolean(event.parentTaskId),
        guardSource: event.guardSource || null,
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

function writeLiveActivity(event: JsonObject) {
    rememberLiveActivity(event);
    const parts = dateParts(new Date(event.timestampUtc || Date.now()));
    for (const target of resolveLiveMachineTargets(["activity", `${parts.ymd}.ndjson`])) {
        enqueueLiveWrite(
            target.path,
            (filePath) => appendJsonLine(filePath, event),
            { disabled: liveStatusDisabled, maxInFlight: liveMaxWriteInFlight },
        );
    }
    writeLiveStatusSnapshot(event.phase);
}

function buildLiveTaskId(details: JsonObject = {}, startedAtMs: number) {
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

export function recordLiveActivityStarted(details: JsonObject = {}) {
    if (liveStatusDisabled()) {
        return null;
    }

    const spatialExtraction = isSpatialExtractionTelemetry(details);
    const safeDetails = spatialExtraction
        ? {
            ...details,
            taskName: null,
            taskId: null,
            parentTaskName: null,
            parentTaskId: null,
        }
        : details;
    const startedAtMs = safeDetails.startedAtMs || Date.now();
    const startedAtUtc = new Date(startedAtMs).toISOString();
    const liveTaskId = buildLiveTaskId(safeDetails, startedAtMs);
    const event = buildTelemetryEvent({
        schemaVersion: LIVE_ACTIVITY_SCHEMA_VERSION,
        eventType: "live.activity",
        phase: "started",
        state: "running",
        liveTaskId,
        scope: safeDetails.scope || "runtime",
        toolName: safeDetails.toolName || null,
        commandName: safeDetails.commandName || null,
        logicalToolName: safeDetails.logicalToolName || null,
        executionKind: safeDetails.executionKind || null,
        taskName: safeDetails.taskName || null,
        taskId: safeDetails.taskId || null,
        taskIdPresent: Boolean(safeDetails.taskId),
        parentTaskName: safeDetails.parentTaskName || null,
        parentTaskId: safeDetails.parentTaskId || null,
        parentTaskIdPresent: Boolean(safeDetails.parentTaskId),
        startedAtUtc,
        params: spatialExtraction
            ? summarizeSpatialExtractionTelemetryParams(
                safeDetails.params,
                safeDetails.toolName || safeDetails.logicalToolName || safeDetails.commandName,
            )
            : summarizeTelemetryParams(safeDetails.params),
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
        parentTaskName: event.parentTaskName,
        parentTaskId: event.parentTaskId,
        guardSource: event.guardSource,
        startedAtMs,
        startedAtUtc,
    };
}

export function recordLiveActivityFinished(task: any, details: JsonObject = {}) {
    if (!task || liveStatusDisabled()) {
        return;
    }

    const finishedAtMs = Date.now();
    const durationMs = details.durationMs ?? Math.max(0, finishedAtMs - (task.startedAtMs || finishedAtMs));
    const spatialExtraction = isSpatialExtractionTelemetry({ ...details, ...task });
    const result = spatialExtraction
        ? summarizeSpatialExtractionTelemetryResponse(details.response, details.error)
        : details.responseSummary || summarizeTelemetryResponse(details.response, details.error);
    const state = result.guarded ? "guarded" : result.success === false ? "failed" : "completed";
    const guardSource = result.guarded
        ? normalizeGuardSource(details.guardSource || task.guardSource || result.guardSource) || "runtime"
        : null;
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
        parentTaskName: task.parentTaskName || details.parentTaskName || null,
        parentTaskId: task.parentTaskId || details.parentTaskId || null,
        parentTaskIdPresent: Boolean(task.parentTaskId || details.parentTaskId),
        guardSource,
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

export function buildTelemetryEvent(partial: JsonObject = {}): JsonObject {
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

export async function recordTelemetryEvent(partial: JsonObject = {}) {
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

export function recordRevitCommandTelemetry(details: JsonObject = {}) {
    const durationMs = Math.max(0, Date.now() - (details.startedAtMs || Date.now()));
    const spatialExtraction = isSpatialExtractionTelemetry(details);
    const responseSummary = spatialExtraction
        ? summarizeSpatialExtractionTelemetryResponse(details.response, details.error)
        : summarizeTelemetryResponse(details.response, details.error);
    void recordTelemetryEvent({
        eventType: "revit.command",
        commandName: details.commandName,
        logicalToolName: details.logicalToolName || details.commandName,
        executionKind: details.executionKind || "bridgeCommand",
        taskName: spatialExtraction ? null : details.params?.taskName || details.options?.taskName || null,
        taskIdPresent: spatialExtraction ? false : Boolean(details.params?.taskId || details.options?.taskId),
        parentTaskName: spatialExtraction ? null : details.params?.parentTaskName || details.options?.parentTaskName || null,
        parentTaskIdPresent: spatialExtraction ? false : Boolean(details.params?.parentTaskId || details.options?.parentTaskId),
        transactionMode: spatialExtraction ? null : details.params?.transactionMode || details.options?.transactionMode || null,
        connection: spatialExtraction ? undefined : {
            targetPresent: Boolean(details.options?.target),
            hostPresent: Boolean(details.options?.host),
            port: details.options?.port || null,
        },
        durationMs,
        params: spatialExtraction
            ? summarizeSpatialExtractionTelemetryParams(
                details.params,
                details.logicalToolName || details.commandName,
            )
            : summarizeTelemetryParams(details.params),
        result: responseSummary,
    });
    recordProductionContextTelemetry({
        ...details,
        sourceEventType: "revit.command",
        durationMs,
        responseSummary,
        taskName: details.params?.taskName || details.options?.taskName || null,
        taskId: details.params?.taskId || details.options?.taskId || null,
        parentTaskName: details.params?.parentTaskName || details.options?.parentTaskName || null,
        parentTaskId: details.params?.parentTaskId || details.options?.parentTaskId || null,
    });
}

function shouldRecordMcpTool(name: string) {
    if (name === "get_revit_mcp_status" && !isTruthy(process.env.REVAGENT_TELEMETRY_INCLUDE_STATUS)) {
        return false;
    }
    return true;
}

export function wrapServerWithTelemetry(server: ToolServer): ToolServer {
    return {
        ...server,
        tool(name: string, description: any, schema: any, handler: any) {
            let actualDescription = description;
            let actualSchema = schema;
            let actualHandler = handler;
            if (typeof description === "object") {
                actualHandler = schema;
                actualSchema = description;
                actualDescription = "";
            }

            const wrappedHandler = async (args: any, extra: any) => {
                const startedAtMs = Date.now();
                const shouldRecord = shouldRecordMcpTool(name);
                const spatialExtraction = isSpatialExtractionName(name);
                const liveTask = shouldRecord
                    ? recordLiveActivityStarted({
                        scope: "mcp.tool",
                            toolName: name,
                            taskName: args?.taskName || null,
                            taskId: args?.taskId || null,
                            parentTaskName: args?.parentTaskName || null,
                            parentTaskId: args?.parentTaskId || null,
                            params: args,
                            startedAtMs,
                        })
                    : null;
                try {
                    const result = await actualHandler(args, extra);
                    if (shouldRecord) {
                        const durationMs = Math.max(0, Date.now() - startedAtMs);
                        const responseSummary = spatialExtraction
                            ? summarizeSpatialExtractionTelemetryResponse(result)
                            : summarizeMcpToolResult(result);
                        void recordTelemetryEvent({
                            eventType: "mcp.tool",
                            toolName: name,
                            taskName: spatialExtraction ? null : args?.taskName || null,
                            taskIdPresent: spatialExtraction ? false : Boolean(args?.taskId),
                            parentTaskName: spatialExtraction ? null : args?.parentTaskName || null,
                            parentTaskIdPresent: spatialExtraction ? false : Boolean(args?.parentTaskId),
                            durationMs,
                            params: spatialExtraction
                                ? summarizeSpatialExtractionTelemetryParams(args, name)
                                : summarizeTelemetryParams(args),
                            result: responseSummary,
                        });
                        recordProductionContextTelemetry({
                            sourceEventType: "mcp.tool",
                            toolName: name,
                            taskName: args?.taskName || null,
                            taskId: args?.taskId || null,
                            parentTaskName: args?.parentTaskName || null,
                            parentTaskId: args?.parentTaskId || null,
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
                        const responseSummary = spatialExtraction
                            ? summarizeSpatialExtractionTelemetryResponse(null, error)
                            : summarizeMcpToolResult(null, error);
                        void recordTelemetryEvent({
                            eventType: "mcp.tool",
                            toolName: name,
                            taskName: spatialExtraction ? null : args?.taskName || null,
                            taskIdPresent: spatialExtraction ? false : Boolean(args?.taskId),
                            parentTaskName: spatialExtraction ? null : args?.parentTaskName || null,
                            parentTaskIdPresent: spatialExtraction ? false : Boolean(args?.parentTaskId),
                            durationMs,
                            params: spatialExtraction
                                ? summarizeSpatialExtractionTelemetryParams(args, name)
                                : summarizeTelemetryParams(args),
                            result: responseSummary,
                        });
                        recordProductionContextTelemetry({
                            sourceEventType: "mcp.tool",
                            toolName: name,
                            taskName: args?.taskName || null,
                            taskId: args?.taskId || null,
                            parentTaskName: args?.parentTaskName || null,
                            parentTaskId: args?.parentTaskId || null,
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
    } as ToolServer;
}
