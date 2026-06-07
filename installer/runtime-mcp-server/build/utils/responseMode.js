import { z } from "zod";
export const responseModeSchema = z.enum(["compact", "full", "debug"])
    .optional()
    .default("compact")
    .describe("Response shape. compact is the default for routine calls; full/debug returns larger diagnostic arrays.");
export function isDetailedResponseMode(mode) {
    return mode === "full" || mode === "debug";
}
export function boundedPositiveInt(value, fallback, max) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.max(1, Math.min(max, parsed));
}
export function compactObjectRows(rows, options) {
    const input = Array.isArray(rows)
        ? rows.filter((row) => Boolean(row) && typeof row === "object" && !Array.isArray(row))
        : [];
    const seen = new Set();
    const uniqueRows = [];
    const keyForRow = options.key || stableRowKey;
    for (const row of input) {
        const key = keyForRow(row);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        uniqueRows.push(row);
    }
    const returnedRows = uniqueRows.slice(0, Math.max(0, options.limit));
    return {
        rows: returnedRows,
        totalCount: input.length,
        uniqueCount: uniqueRows.length,
        returnedCount: returnedRows.length,
        duplicateCount: input.length - uniqueRows.length,
        omittedCount: Math.max(0, uniqueRows.length - returnedRows.length),
    };
}
export function stableRowKey(row) {
    return stableStringify(row);
}
function stableStringify(value) {
    if (value === null || value === undefined) {
        return String(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    if (typeof value === "object") {
        const objectValue = value;
        return `{${Object.keys(objectValue)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}
