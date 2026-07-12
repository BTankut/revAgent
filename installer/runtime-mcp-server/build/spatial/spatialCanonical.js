import crypto from "node:crypto";
export function isJsonObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function canonicalJson(value) {
    if (value === null)
        return "null";
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new TypeError("Spatial canonical JSON rejects non-finite numbers.");
        }
        return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    if (typeof value === "string" || typeof value === "boolean") {
        return JSON.stringify(value);
    }
    if (typeof value === "undefined")
        return "null";
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (isJsonObject(value)) {
        return `{${Object.keys(value)
            .sort(compareText)
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(String(value));
}
export function sha256Canonical(value) {
    return `sha256:${crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}
export function createEvidenceId(prefix) {
    return `${prefix}:${crypto.randomUUID()}`;
}
export function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
export function cleanText(value) {
    const text = typeof value === "string" ? value.trim() : "";
    return text.length > 0 ? text : null;
}
export function finiteNumber(value) {
    if (typeof value !== "number" && (typeof value !== "string" || value.trim().length === 0))
        return null;
    const parsed = typeof value === "number" ? value : Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
}
export function finiteInteger(value) {
    const parsed = finiteNumber(value);
    return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}
export function readPath(value, ...path) {
    let current = value;
    for (const key of path) {
        if (!isJsonObject(current))
            return undefined;
        current = current[key];
    }
    return current;
}
export function firstDefined(value, paths) {
    for (const path of paths) {
        const candidate = readPath(value, ...path);
        if (candidate !== undefined && candidate !== null)
            return candidate;
    }
    return undefined;
}
export function cleanStringArray(value, maximum = 10_000) {
    if (!Array.isArray(value))
        return [];
    return [...new Set(value
            .slice(0, maximum)
            .map(cleanText)
            .filter((item) => item !== null))]
        .sort(compareText);
}
export function clampInteger(value, fallback, minimum, maximum) {
    const parsed = finiteInteger(value);
    return Math.max(minimum, Math.min(maximum, parsed ?? fallback));
}
export function omitKeys(value, keys) {
    const omitted = new Set(keys);
    return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)));
}
