export const BROAD_SCAN_STOP_REASONS = [
    "completed",
    "max_elapsed",
    "max_rows",
    "max_columns",
    "max_cells",
    "max_items",
    "max_bytes",
    "read_failed",
    "needs_scope",
];
export const BROAD_SCAN_CONTINUATION_FIELDS = [
    "lastReadSection",
    "lastReadRow",
    "lastReadColumn",
    "lastReadSheetId",
    "lastReadViewId",
    "lastReadViewportId",
    "lastReadItemId",
];
const broadScanStopReasonSet = new Set(BROAD_SCAN_STOP_REASONS);
const stopReasonAliases = {
    done: "completed",
    success: "completed",
    timeout: "max_elapsed",
    timed_out: "max_elapsed",
    socket_timeout: "max_elapsed",
    max_schedules: "max_items",
    max_sheets: "max_items",
    max_text_notes: "max_items",
    max_tags: "max_items",
    max_viewports: "max_items",
    max_scanned: "max_items",
    max_schedule_instances: "max_items",
    max_schedule_cells: "max_cells",
    max_cells_scanned: "max_cells",
    rows_truncated: "max_rows",
    columns_truncated: "max_columns",
};
function isJsonObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function cleanString(value) {
    return String(value ?? "").trim();
}
function cleanStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((item) => cleanString(item))
        .filter((item) => item.length > 0);
}
export function readNativeResultField(payload, camelName) {
    if (!isJsonObject(payload)) {
        return undefined;
    }
    const pascalName = camelName.charAt(0).toUpperCase() + camelName.slice(1);
    if (Object.prototype.hasOwnProperty.call(payload, camelName)) {
        return payload[camelName];
    }
    if (Object.prototype.hasOwnProperty.call(payload, pascalName)) {
        return payload[pascalName];
    }
    const normalized = camelName.toLowerCase();
    const matchingKey = Object.keys(payload).find((key) => key.toLowerCase() === normalized);
    return matchingKey ? payload[matchingKey] : undefined;
}
export function readNativeResultArray(payload, camelName) {
    const value = readNativeResultField(payload, camelName);
    return Array.isArray(value)
        ? value.filter((item) => isJsonObject(item))
        : [];
}
export function readNativeResultObject(payload, camelName) {
    const value = readNativeResultField(payload, camelName);
    return isJsonObject(value) ? value : null;
}
function normalizeBoolean(value, fallback = false) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true")
            return true;
        if (normalized === "false")
            return false;
    }
    return fallback;
}
function finiteNumberOrNull(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            return null;
        }
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}
export function normalizeBroadScanStopReason(value, fallback = "completed") {
    const raw = cleanString(value).toLowerCase();
    if (!raw) {
        return fallback;
    }
    if (broadScanStopReasonSet.has(raw)) {
        return raw;
    }
    return stopReasonAliases[raw] || fallback;
}
function defaultStopReason(payload, partial, guarded, state) {
    if (guarded) {
        return "needs_scope";
    }
    if (state === "failed") {
        return "read_failed";
    }
    return partial ? "max_items" : "completed";
}
function resolveValue(value, payload, fallback) {
    if (typeof value === "function") {
        return value(payload);
    }
    return value ?? fallback;
}
export function normalizeBroadScanResult(payload, options) {
    const result = isJsonObject(payload) ? { ...payload } : { value: payload };
    const rawState = cleanString(readNativeResultField(result, "state"));
    const rawError = cleanString(readNativeResultField(result, "error"));
    const guarded = normalizeBoolean(readNativeResultField(result, "guarded"), false);
    const rawSuccess = readNativeResultField(result, "success");
    const success = typeof rawSuccess === "boolean"
        ? Boolean(rawSuccess)
        : rawError.length === 0;
    const state = rawState || (guarded ? "guarded" : success ? "completed" : "failed");
    const partial = options.partial ?? normalizeBoolean(readNativeResultField(result, "partial"), false);
    const rawStopReason = cleanString(options.scanStoppedReason ?? readNativeResultField(result, "scanStoppedReason"));
    const fallbackStopReason = defaultStopReason(result, partial, guarded, state);
    const scanStoppedReason = normalizeBroadScanStopReason(rawStopReason, fallbackStopReason);
    result.success = success;
    result.guarded = guarded;
    result.state = state;
    result.action = options.action;
    result.partial = partial;
    result.scanStoppedReason = scanStoppedReason;
    if (rawStopReason && rawStopReason !== scanStoppedReason && result.rawScanStoppedReason === undefined) {
        result.rawScanStoppedReason = rawStopReason;
    }
    const scanPolicy = readNativeResultObject(result, "scanPolicy");
    result.scanPolicy = scanPolicy
        ? scanPolicy
        : (options.scanPolicy || {});
    const suggestedNextScopes = cleanStringArray(readNativeResultField(result, "suggestedNextScopes"));
    result.suggestedNextScopes = suggestedNextScopes.length > 0
        ? suggestedNextScopes
        : cleanStringArray(options.suggestedNextScopes);
    result.elapsedMs = finiteNumberOrNull(readNativeResultField(result, "elapsedMs"))
        ?? finiteNumberOrNull(options.elapsedMs);
    result.warnings = cleanStringArray(readNativeResultField(result, "warnings")).concat(cleanStringArray(options.warnings));
    result.notices = cleanStringArray(readNativeResultField(result, "notices")).concat(cleanStringArray(options.notices));
    const evidenceRows = resolveValue(options.evidenceRows, result, []);
    const nativeEvidenceRows = readNativeResultArray(result, "evidenceRows");
    result.evidenceRows = nativeEvidenceRows.length > 0
        ? nativeEvidenceRows
        : (Array.isArray(evidenceRows) ? evidenceRows : []);
    const summary = resolveValue(options.summary, result, {});
    const nativeSummary = readNativeResultObject(result, "summary");
    result.summary = nativeSummary
        ? nativeSummary
        : (isJsonObject(summary) ? summary : {});
    const lastRead = resolveValue(options.lastRead, result, {});
    for (const field of BROAD_SCAN_CONTINUATION_FIELDS) {
        const current = readNativeResultField(result, field);
        result[field] = current !== undefined ? current : lastRead[field] ?? null;
    }
    return result;
}
export function buildBroadScanGuardedResult(options) {
    const reason = cleanString(options.reason) || "needs_scope";
    return normalizeBroadScanResult({
        ...(options.extra || {}),
        success: true,
        guarded: true,
        state: "guarded",
        action: options.action,
        reason,
        message: options.message,
        partial: false,
        scanStoppedReason: reason,
    }, {
        ...options,
        partial: false,
        scanStoppedReason: reason,
        summary: options.summary || {},
        evidenceRows: options.evidenceRows || [],
    });
}
export function buildBroadScanFailureResult(options) {
    return normalizeBroadScanResult({
        ...(options.extra || {}),
        success: false,
        guarded: false,
        state: "failed",
        action: options.action,
        error: options.error,
        partial: false,
        scanStoppedReason: "read_failed",
    }, {
        ...options,
        partial: false,
        scanStoppedReason: "read_failed",
        summary: options.summary || {},
        evidenceRows: options.evidenceRows || [],
    });
}
