import type { AabbMm, EngineeringIssue, IssueSeverity, PointMm } from "./types.js";

export function normalizeText(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
}

export function normalizeKey(value: unknown): string {
    return normalizeText(value).replace(/[^a-z0-9]+/g, "");
}

export function asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return {};
}

export function asString(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined;
    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
}

export function asNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const normalized = value.trim().replace(",", ".");
        if (normalized.length === 0) return undefined;
        const parsed = Number(normalized);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
        const normalized = normalizeText(value);
        if (["true", "1", "yes", "y", "evet"].includes(normalized)) return true;
        if (["false", "0", "no", "n", "hayir"].includes(normalized)) return false;
    }
    return undefined;
}

export function valueByFields(record: Record<string, unknown>, fields: string[]): unknown {
    const lookup = new Map<string, unknown>();
    for (const [key, value] of Object.entries(record)) {
        lookup.set(normalizeKey(key), value);
    }
    for (const field of fields) {
        const value = lookup.get(normalizeKey(field));
        if (value !== undefined && value !== null && String(value).trim() !== "") return value;
    }
    return undefined;
}

export function numberByFields(record: Record<string, unknown>, fields: string[]): number | undefined {
    return asNumber(valueByFields(record, fields));
}

export function stringByFields(record: Record<string, unknown>, fields: string[]): string | undefined {
    return asString(valueByFields(record, fields));
}

export function boolByFields(record: Record<string, unknown>, fields: string[]): boolean | undefined {
    return asBoolean(valueByFields(record, fields));
}

export function pointFromValue(value: unknown): PointMm | undefined {
    if (Array.isArray(value) && value.length >= 3) {
        const x = asNumber(value[0]);
        const y = asNumber(value[1]);
        const z = asNumber(value[2]);
        if (x !== undefined && y !== undefined && z !== undefined) return { x, y, z };
    }
    const record = asRecord(value);
    const x = numberByFields(record, ["x", "X", "x_mm", "X_mm"]);
    const y = numberByFields(record, ["y", "Y", "y_mm", "Y_mm"]);
    const z = numberByFields(record, ["z", "Z", "z_mm", "Z_mm"]);
    if (x !== undefined && y !== undefined && z !== undefined) return { x, y, z };
    return undefined;
}

function tripleFromValue(value: unknown): { x: number; y: number; z: number } | undefined {
    if (Array.isArray(value) && value.length >= 3) {
        const x = asNumber(value[0]);
        const y = asNumber(value[1]);
        const z = asNumber(value[2]);
        if (x !== undefined && y !== undefined && z !== undefined) return { x, y, z };
        return undefined;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        const x = numberByFields(record, ["x", "X", "x_mm", "X_mm"]);
        const y = numberByFields(record, ["y", "Y", "y_mm", "Y_mm"]);
        const z = numberByFields(record, ["z", "Z", "z_mm", "Z_mm"]);
        if (x !== undefined && y !== undefined && z !== undefined) return { x, y, z };
    }
    return undefined;
}

export function aabbFromValue(value: unknown): AabbMm | undefined {
    if (Array.isArray(value) && value.length >= 6) {
        const numbers = value.slice(0, 6).map(asNumber);
        if (numbers.every((entry) => entry !== undefined)) {
            return {
                minX: numbers[0] as number,
                minY: numbers[1] as number,
                minZ: numbers[2] as number,
                maxX: numbers[3] as number,
                maxY: numbers[4] as number,
                maxZ: numbers[5] as number,
            };
        }
    }
    const record = asRecord(value);
    const minTriple = tripleFromValue(valueByFields(record, ["min", "minimum", "min_mm", "minMm"]));
    const maxTriple = tripleFromValue(valueByFields(record, ["max", "maximum", "max_mm", "maxMm"]));
    const minX = numberByFields(record, ["minX", "min_x", "xmin"]) ?? minTriple?.x;
    const minY = numberByFields(record, ["minY", "min_y", "ymin"]) ?? minTriple?.y;
    const minZ = numberByFields(record, ["minZ", "min_z", "zmin"]) ?? minTriple?.z;
    const maxX = numberByFields(record, ["maxX", "max_x", "xmax"]) ?? maxTriple?.x;
    const maxY = numberByFields(record, ["maxY", "max_y", "ymax"]) ?? maxTriple?.y;
    const maxZ = numberByFields(record, ["maxZ", "max_z", "zmax"]) ?? maxTriple?.z;
    if ([minX, minY, minZ, maxX, maxY, maxZ].every((entry) => entry !== undefined)) {
        return { minX: minX as number, minY: minY as number, minZ: minZ as number, maxX: maxX as number, maxY: maxY as number, maxZ: maxZ as number };
    }
    return undefined;
}

export function pointDistanceMm(left: PointMm, right: PointMm): number {
    const dx = left.x - right.x;
    const dy = left.y - right.y;
    const dz = left.z - right.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function round(value: number, digits = 3): number {
    const scale = Math.pow(10, digits);
    return Math.round(value * scale) / scale;
}

export function makeIssue(code: string, severity: IssueSeverity, message: string, context?: Record<string, unknown>): EngineeringIssue {
    return context ? { code, severity, message, context } : { code, severity, message };
}

export function validationStatus(issues: EngineeringIssue[]): "pass" | "warn" | "fail" | "not_run" {
    if (issues.some((issue) => issue.severity === "error")) return "fail";
    if (issues.some((issue) => issue.severity === "warning")) return "warn";
    return "pass";
}

export function flattenIssues(groups: Array<{ issues?: EngineeringIssue[] } | EngineeringIssue[]>): EngineeringIssue[] {
    const result: EngineeringIssue[] = [];
    for (const group of groups) {
        if (Array.isArray(group)) result.push(...group);
        else if (group.issues) result.push(...group.issues);
    }
    return result;
}
