import { z } from "zod";

type JsonObject = Record<string, any>;

export type ResponseMode = "compact" | "full" | "debug";

export const responseModeSchema = z.enum(["compact", "full", "debug"])
    .optional()
    .default("compact")
    .describe("Response shape. compact is the default for routine calls; full/debug returns larger diagnostic arrays.");

export function isDetailedResponseMode(mode: unknown): boolean {
    return mode === "full" || mode === "debug";
}

export function boundedPositiveInt(value: unknown, fallback: number, max: number): number {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.max(1, Math.min(max, parsed));
}

export function compactObjectRows<T extends JsonObject>(
    rows: unknown,
    options: {
        limit: number;
        key?: (row: T) => string;
    },
): {
    rows: T[];
    totalCount: number;
    uniqueCount: number;
    returnedCount: number;
    duplicateCount: number;
    omittedCount: number;
} {
    const input = Array.isArray(rows)
        ? rows.filter((row): row is T => Boolean(row) && typeof row === "object" && !Array.isArray(row))
        : [];
    const seen = new Set<string>();
    const uniqueRows: T[] = [];
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

export function stableRowKey(row: JsonObject): string {
    return stableStringify(row);
}

function stableStringify(value: unknown): string {
    if (value === null || value === undefined) {
        return String(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    if (typeof value === "object") {
        const objectValue = value as JsonObject;
        return `{${Object.keys(objectValue)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}
