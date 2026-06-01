export type RuntimeResultState = "completed" | "guarded" | "failed";

export type RuntimeResult = {
    success: boolean;
    guarded: boolean;
    state: RuntimeResultState;
    action: string;
    error?: string;
    reason?: string;
    warnings?: string[];
    notices?: string[];
    [key: string]: unknown;
};

type RuntimeResultOptions = {
    action: string;
    error?: string;
    reason?: string;
    warnings?: string[];
    notices?: string[];
    extra?: Record<string, unknown>;
};

const reservedRuntimeResultKeys = new Set([
    "success",
    "guarded",
    "state",
    "action",
    "error",
    "reason",
    "warnings",
    "notices",
]);

function cleanText(value: string | undefined): string | undefined {
    const text = String(value || "").trim();
    return text.length > 0 ? text : undefined;
}

function cleanStringArray(values: string[] | undefined): string[] | undefined {
    if (!Array.isArray(values)) {
        return undefined;
    }
    const cleaned = values
        .map((value) => String(value || "").trim())
        .filter((value) => value.length > 0);
    return cleaned.length > 0 ? cleaned : undefined;
}

function cleanExtra(extra: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!extra) {
        return {};
    }
    return Object.fromEntries(
        Object.entries(extra).filter(([key]) => !reservedRuntimeResultKeys.has(key)),
    );
}

function withCommonFields(
    base: RuntimeResult,
    options: RuntimeResultOptions,
): RuntimeResult {
    const output: RuntimeResult = {
        ...cleanExtra(options.extra),
        ...base,
        action: options.action,
    };
    const error = cleanText(options.error);
    const reason = cleanText(options.reason);
    const warnings = cleanStringArray(options.warnings);
    const notices = cleanStringArray(options.notices);
    if (error) output.error = error;
    if (reason) output.reason = reason;
    if (warnings) output.warnings = warnings;
    if (notices) output.notices = notices;
    return output;
}

export function runtimeSuccess(options: RuntimeResultOptions): RuntimeResult {
    return withCommonFields({
        success: true,
        guarded: false,
        state: "completed",
        action: options.action,
    }, options);
}

export function runtimeGuarded(options: RuntimeResultOptions): RuntimeResult {
    return withCommonFields({
        success: false,
        guarded: true,
        state: "guarded",
        action: options.action,
    }, options);
}

export function runtimeFailure(options: RuntimeResultOptions): RuntimeResult {
    return withCommonFields({
        success: false,
        guarded: false,
        state: "failed",
        action: options.action,
    }, options);
}
