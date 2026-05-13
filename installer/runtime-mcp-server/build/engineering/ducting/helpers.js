export function normalizeText(value) {
    return String(value ?? "").trim().toLowerCase();
}
export function normalizeKey(value) {
    return normalizeText(value).replace(/[^a-z0-9]+/g, "");
}
export function asRecord(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return {};
}
export function asString(value) {
    if (value === null || value === undefined)
        return undefined;
    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
}
export function asNumber(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string") {
        const normalized = value.trim().replace(",", ".");
        if (normalized.length === 0)
            return undefined;
        const parsed = Number(normalized);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
export function asBoolean(value) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "number")
        return value !== 0;
    if (typeof value === "string") {
        const normalized = normalizeText(value);
        if (["true", "1", "yes", "y", "evet"].includes(normalized))
            return true;
        if (["false", "0", "no", "n", "hayir"].includes(normalized))
            return false;
    }
    return undefined;
}
export function valueByFields(record, fields) {
    const lookup = new Map();
    for (const [key, value] of Object.entries(record)) {
        lookup.set(normalizeKey(key), value);
    }
    for (const field of fields) {
        const value = lookup.get(normalizeKey(field));
        if (value !== undefined && value !== null && String(value).trim() !== "")
            return value;
    }
    return undefined;
}
export function numberByFields(record, fields) {
    return asNumber(valueByFields(record, fields));
}
export function stringByFields(record, fields) {
    return asString(valueByFields(record, fields));
}
export function boolByFields(record, fields) {
    return asBoolean(valueByFields(record, fields));
}
export function pointFromValue(value) {
    if (Array.isArray(value) && value.length >= 3) {
        const x = asNumber(value[0]);
        const y = asNumber(value[1]);
        const z = asNumber(value[2]);
        if (x !== undefined && y !== undefined && z !== undefined)
            return { x, y, z };
    }
    const record = asRecord(value);
    const x = numberByFields(record, ["x", "X", "x_mm", "X_mm"]);
    const y = numberByFields(record, ["y", "Y", "y_mm", "Y_mm"]);
    const z = numberByFields(record, ["z", "Z", "z_mm", "Z_mm"]);
    if (x !== undefined && y !== undefined && z !== undefined)
        return { x, y, z };
    return undefined;
}
export function aabbFromValue(value) {
    if (Array.isArray(value) && value.length >= 6) {
        const numbers = value.slice(0, 6).map(asNumber);
        if (numbers.every((entry) => entry !== undefined)) {
            return {
                minX: numbers[0],
                minY: numbers[1],
                minZ: numbers[2],
                maxX: numbers[3],
                maxY: numbers[4],
                maxZ: numbers[5],
            };
        }
    }
    const record = asRecord(value);
    const min = asRecord(valueByFields(record, ["min", "minimum"]));
    const max = asRecord(valueByFields(record, ["max", "maximum"]));
    const minX = numberByFields(record, ["minX", "min_x", "xmin"]) ?? numberByFields(min, ["x"]);
    const minY = numberByFields(record, ["minY", "min_y", "ymin"]) ?? numberByFields(min, ["y"]);
    const minZ = numberByFields(record, ["minZ", "min_z", "zmin"]) ?? numberByFields(min, ["z"]);
    const maxX = numberByFields(record, ["maxX", "max_x", "xmax"]) ?? numberByFields(max, ["x"]);
    const maxY = numberByFields(record, ["maxY", "max_y", "ymax"]) ?? numberByFields(max, ["y"]);
    const maxZ = numberByFields(record, ["maxZ", "max_z", "zmax"]) ?? numberByFields(max, ["z"]);
    if ([minX, minY, minZ, maxX, maxY, maxZ].every((entry) => entry !== undefined)) {
        return { minX: minX, minY: minY, minZ: minZ, maxX: maxX, maxY: maxY, maxZ: maxZ };
    }
    return undefined;
}
export function pointDistanceMm(left, right) {
    const dx = left.x - right.x;
    const dy = left.y - right.y;
    const dz = left.z - right.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
export function round(value, digits = 3) {
    const scale = Math.pow(10, digits);
    return Math.round(value * scale) / scale;
}
export function makeIssue(code, severity, message, context) {
    return context ? { code, severity, message, context } : { code, severity, message };
}
export function validationStatus(issues) {
    if (issues.some((issue) => issue.severity === "error"))
        return "fail";
    if (issues.some((issue) => issue.severity === "warning"))
        return "warn";
    return "pass";
}
export function flattenIssues(groups) {
    const result = [];
    for (const group of groups) {
        if (Array.isArray(group))
            result.push(...group);
        else if (group.issues)
            result.push(...group.issues);
    }
    return result;
}
