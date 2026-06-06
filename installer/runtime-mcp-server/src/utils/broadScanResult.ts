type JsonObject = Record<string, any>;

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
] as const;

export type BroadScanStopReason = typeof BROAD_SCAN_STOP_REASONS[number];

export const BROAD_SCAN_CONTINUATION_FIELDS = [
    "lastReadSection",
    "lastReadRow",
    "lastReadColumn",
    "lastReadSheetId",
    "lastReadViewId",
    "lastReadViewportId",
    "lastReadItemId",
] as const;

const broadScanStopReasonSet = new Set<string>(BROAD_SCAN_STOP_REASONS);

const stopReasonAliases: Record<string, BroadScanStopReason> = {
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

export type BroadScanNormalizeOptions = {
    action: string;
    elapsedMs?: number;
    partial?: boolean;
    scanStoppedReason?: string;
    scanPolicy?: JsonObject;
    suggestedNextScopes?: string[];
    summary?: JsonObject | ((payload: JsonObject) => JsonObject);
    evidenceRows?: JsonObject[] | ((payload: JsonObject) => JsonObject[]);
    lastRead?: Partial<Record<typeof BROAD_SCAN_CONTINUATION_FIELDS[number], unknown>> | ((payload: JsonObject) => Partial<Record<typeof BROAD_SCAN_CONTINUATION_FIELDS[number], unknown>>);
    warnings?: string[];
    notices?: string[];
};

export type BroadScanGuardedOptions = BroadScanNormalizeOptions & {
    reason?: string;
    message: string;
    extra?: JsonObject;
};

export type BroadScanFailureOptions = BroadScanNormalizeOptions & {
    error: string;
    extra?: JsonObject;
};

function isJsonObject(value: any): value is JsonObject {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string {
    return String(value ?? "").trim();
}

function cleanStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((item) => cleanString(item))
        .filter((item) => item.length > 0);
}

function readCasedField(payload: JsonObject, camelName: string) {
    const pascalName = camelName.charAt(0).toUpperCase() + camelName.slice(1);
    return payload[camelName] ?? payload[pascalName];
}

function normalizeBoolean(value: unknown, fallback = false) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true") return true;
        if (normalized === "false") return false;
    }
    return fallback;
}

export function normalizeBroadScanStopReason(value: unknown, fallback: BroadScanStopReason = "completed"): BroadScanStopReason {
    const raw = cleanString(value).toLowerCase();
    if (!raw) {
        return fallback;
    }
    if (broadScanStopReasonSet.has(raw)) {
        return raw as BroadScanStopReason;
    }
    return stopReasonAliases[raw] || fallback;
}

function defaultStopReason(payload: JsonObject, partial: boolean, guarded: boolean, state: string): BroadScanStopReason {
    if (guarded) {
        return "needs_scope";
    }
    if (state === "failed") {
        return "read_failed";
    }
    return partial ? "max_items" : "completed";
}

function resolveValue<T>(
    value: T | ((payload: JsonObject) => T) | undefined,
    payload: JsonObject,
    fallback: T,
): T {
    if (typeof value === "function") {
        return (value as (payload: JsonObject) => T)(payload);
    }
    return value ?? fallback;
}

export function normalizeBroadScanResult(payload: any, options: BroadScanNormalizeOptions): JsonObject {
    const result: JsonObject = isJsonObject(payload) ? { ...payload } : { value: payload };
    const rawState = cleanString(readCasedField(result, "state"));
    const rawError = cleanString(readCasedField(result, "error"));
    const guarded = normalizeBoolean(readCasedField(result, "guarded"), false);
    const success = typeof readCasedField(result, "success") === "boolean"
        ? Boolean(readCasedField(result, "success"))
        : rawError.length === 0;
    const state = rawState || (guarded ? "guarded" : success ? "completed" : "failed");
    const partial = options.partial ?? normalizeBoolean(readCasedField(result, "partial"), false);
    const rawStopReason = cleanString(options.scanStoppedReason ?? readCasedField(result, "scanStoppedReason"));
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

    result.scanPolicy = isJsonObject(readCasedField(result, "scanPolicy"))
        ? readCasedField(result, "scanPolicy")
        : (options.scanPolicy || {});
    result.suggestedNextScopes = cleanStringArray(readCasedField(result, "suggestedNextScopes")).length > 0
        ? cleanStringArray(readCasedField(result, "suggestedNextScopes"))
        : cleanStringArray(options.suggestedNextScopes);
    result.elapsedMs = Number.isFinite(Number(readCasedField(result, "elapsedMs")))
        ? Number(readCasedField(result, "elapsedMs"))
        : (Number.isFinite(Number(options.elapsedMs)) ? Number(options.elapsedMs) : null);
    result.warnings = cleanStringArray(readCasedField(result, "warnings")).concat(cleanStringArray(options.warnings));
    result.notices = cleanStringArray(readCasedField(result, "notices")).concat(cleanStringArray(options.notices));

    const summary = resolveValue(options.summary, result, {});
    const evidenceRows = resolveValue(options.evidenceRows, result, []);
    result.summary = isJsonObject(readCasedField(result, "summary"))
        ? readCasedField(result, "summary")
        : (isJsonObject(summary) ? summary : {});
    result.evidenceRows = Array.isArray(readCasedField(result, "evidenceRows"))
        ? readCasedField(result, "evidenceRows")
        : (Array.isArray(evidenceRows) ? evidenceRows : []);

    const lastRead = resolveValue(options.lastRead, result, {});
    for (const field of BROAD_SCAN_CONTINUATION_FIELDS) {
        const current = readCasedField(result, field);
        result[field] = current !== undefined ? current : lastRead[field] ?? null;
    }

    return result;
}

export function buildBroadScanGuardedResult(options: BroadScanGuardedOptions): JsonObject {
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

export function buildBroadScanFailureResult(options: BroadScanFailureOptions): JsonObject {
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
