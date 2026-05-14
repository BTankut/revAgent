import {
    aabbFromValue,
    asRecord,
    makeIssue,
    numberByFields,
    pointFromValue,
    stringByFields,
    validationStatus,
} from "./helpers.js";
import type { AirBalanceRow, AirflowAssignment, FlowSet, SpaceRecord } from "./types.js";

const EMPTY_FLOW: FlowSet = { supplyLps: 0, returnLps: 0, exhaustLps: 0 };

function flowFromRow(row: Record<string, unknown>, kind: "supply" | "return" | "exhaust"): number {
    const lps = numberByFields(row, [
        `${kind}Lps`,
        `${kind}_lps`,
        `${kind}FlowLps`,
        `${kind}_flow_lps`,
        `${kind}AirflowLps`,
        `${kind}_airflow_lps`,
        `${kind} l/s`,
    ]);
    if (lps !== undefined) return Math.max(0, lps);

    const m3h = numberByFields(row, [
        `${kind}M3h`,
        `${kind}_m3h`,
        `${kind}FlowM3h`,
        `${kind}_flow_m3h`,
        `${kind}AirflowM3h`,
        `${kind}_airflow_m3h`,
        `${kind} m3/h`,
        `${kind} m3h`,
    ]);
    if (m3h !== undefined) return Math.max(0, m3h / 3.6);
    return 0;
}

export function normalizeSpaces(input: Record<string, unknown>[] = []): SpaceRecord[] {
    return input.map((raw, index) => {
        const record = asRecord(raw);
        const id = stringByFields(record, ["id", "spaceId", "space_id", "elementId", "element_id", "uniqueId", "unique_id"])
            ?? `space-${index + 1}`;
        const centroidMm = pointFromValue(record.centroidMm ?? record.centroid_mm ?? record.centroid);
        const aabbMm = aabbFromValue(record.aabbMm ?? record.aabb_mm ?? record.bboxMm ?? record.bbox_mm ?? record.boundsMm ?? record.bounds_mm);
        return {
            id,
            number: stringByFields(record, ["number", "spaceNumber", "space_number", "roomNumber", "room_number"]),
            name: stringByFields(record, ["name", "spaceName", "space_name", "roomName", "room_name"]),
            levelName: stringByFields(record, ["levelName", "level_name", "level"]),
            areaM2: numberByFields(record, ["areaM2", "area_m2", "area"]),
            centroidMm,
            aabbMm,
            source: record,
        };
    });
}

export function normalizeAirBalanceRows(input: Record<string, unknown>[] = []): AirBalanceRow[] {
    return input.map((raw, index) => {
        const record = asRecord(raw);
        return {
            id: stringByFields(record, ["id", "rowId", "row_id"]) ?? `air-balance-${index + 1}`,
            spaceId: stringByFields(record, ["spaceId", "space_id", "roomId", "room_id", "elementId", "element_id", "uniqueId", "unique_id"]),
            spaceNumber: stringByFields(record, ["spaceNumber", "space_number", "roomNumber", "room_number", "number"]),
            spaceName: stringByFields(record, ["spaceName", "space_name", "roomName", "room_name", "name"]),
            levelName: stringByFields(record, ["levelName", "level_name", "level"]),
            flows: {
                supplyLps: flowFromRow(record, "supply"),
                returnLps: flowFromRow(record, "return"),
                exhaustLps: flowFromRow(record, "exhaust"),
            },
            source: record,
        };
    });
}

function key(parts: Array<string | undefined>): string {
    return parts.map((part) => String(part ?? "").trim().toLowerCase()).join("|");
}

function addIndex(index: Map<string, AirBalanceRow[]>, indexKey: string, row: AirBalanceRow): void {
    if (!indexKey.replace(/\|/g, "")) return;
    const rows = index.get(indexKey) ?? [];
    rows.push(row);
    index.set(indexKey, rows);
}

function getUnique(index: Map<string, AirBalanceRow[]>, indexKey: string): AirBalanceRow | undefined {
    const rows = index.get(indexKey);
    return rows && rows.length === 1 ? rows[0] : undefined;
}

export function buildAirflowAssignments(
    spacesInput: Record<string, unknown>[] = [],
    rowsInput: Record<string, unknown>[] = [],
): { spaces: SpaceRecord[]; rows: AirBalanceRow[]; assignments: AirflowAssignment[]; issues: ReturnType<typeof makeIssue>[] } {
    const spaces = normalizeSpaces(spacesInput);
    const rows = normalizeAirBalanceRows(rowsInput);
    const issues: ReturnType<typeof makeIssue>[] = [];
    const byId = new Map<string, AirBalanceRow[]>();
    const byNumberLevel = new Map<string, AirBalanceRow[]>();
    const byNumber = new Map<string, AirBalanceRow[]>();
    const byNameLevel = new Map<string, AirBalanceRow[]>();

    for (const row of rows) {
        addIndex(byId, key([row.spaceId]), row);
        addIndex(byNumberLevel, key([row.spaceNumber, row.levelName]), row);
        addIndex(byNumber, key([row.spaceNumber]), row);
        addIndex(byNameLevel, key([row.spaceName, row.levelName]), row);
    }

    for (const [indexKey, indexedRows] of [...byId, ...byNumberLevel, ...byNumber, ...byNameLevel]) {
        if (indexedRows.length > 1) {
            issues.push(makeIssue("air_balance_duplicate_key", "warning", "Air balance schedule has duplicate mapping keys.", {
                key: indexKey,
                rowIds: indexedRows.map((row) => row.id),
            }));
        }
    }

    const matchedRowIds = new Set<string>();
    const assignments = spaces.map((space) => {
        let row = getUnique(byId, key([space.id]));
        let matchKey = "space_id";
        if (!row) {
            row = getUnique(byNumberLevel, key([space.number, space.levelName]));
            matchKey = "number_level";
        }
        if (!row) {
            row = getUnique(byNumber, key([space.number]));
            matchKey = "number";
        }
        if (!row) {
            row = getUnique(byNameLevel, key([space.name, space.levelName]));
            matchKey = "name_level";
        }
        const assignmentIssues = [];
        if (!row) {
            assignmentIssues.push(makeIssue("air_balance_row_missing", "warning", "No air balance schedule row matched this space.", { spaceId: space.id }));
        } else {
            matchedRowIds.add(row.id);
        }
        const flows = row ? row.flows : { ...EMPTY_FLOW };
        if (flows.supplyLps + flows.returnLps + flows.exhaustLps <= 0) {
            assignmentIssues.push(makeIssue("room_no_airflow", "warning", "Matched space has no supply, return or exhaust airflow.", { spaceId: space.id }));
        }
        return {
            space,
            flows,
            rowId: row?.id,
            matchKey: row ? matchKey : undefined,
            issues: assignmentIssues,
        };
    });

    for (const row of rows) {
        if (!matchedRowIds.has(row.id)) {
            issues.push(makeIssue("air_balance_row_unmatched", "warning", "Air balance row did not match any known space.", { rowId: row.id }));
        }
    }

    return { spaces, rows, assignments, issues };
}

export function summarizeAirflow(assignments: AirflowAssignment[]): Record<string, unknown> {
    const totals = assignments.reduce(
        (acc, assignment) => {
            acc.supplyLps += assignment.flows.supplyLps;
            acc.returnLps += assignment.flows.returnLps;
            acc.exhaustLps += assignment.flows.exhaustLps;
            if (assignment.flows.supplyLps + assignment.flows.returnLps + assignment.flows.exhaustLps > 0) acc.spacesWithAirflow++;
            return acc;
        },
        { supplyLps: 0, returnLps: 0, exhaustLps: 0, spacesWithAirflow: 0 },
    );
    const issues = assignments.flatMap((assignment) => assignment.issues);
    return {
        status: validationStatus(issues),
        spaceCount: assignments.length,
        spacesWithAirflow: totals.spacesWithAirflow,
        totalSupplyLps: Math.round(totals.supplyLps * 1000) / 1000,
        totalReturnLps: Math.round(totals.returnLps * 1000) / 1000,
        totalExhaustLps: Math.round(totals.exhaustLps * 1000) / 1000,
    };
}
