import type { ToolServer } from "./types.js";
import { z } from "zod";
import {
    connectionOptionsFromArgs,
    connectionTargetSchema,
    csharpIntArray,
    csharpString,
    csharpStringArray,
    executeRevitCode,
    formatJsonContent,
    taskMetadataSchema,
    taskOptionsFromArgs,
} from "../utils/revitToolHelpers.js";
import {
    buildBroadScanFailureResult,
    buildBroadScanGuardedResult,
    normalizeBroadScanResult,
} from "../utils/broadScanResult.js";

type JsonObject = Record<string, any>;

function uniqueSections(values: unknown): string[] {
    const requested = Array.isArray(values) && values.length > 0 ? values : ["header", "body"];
    return [...new Set(requested.map((value: unknown) => String(value || "").toLowerCase()))]
        .filter((value: string) => ["header", "body", "footer"].includes(value));
}

function buildInspectSchedulesCode(args: JsonObject) {
    const scheduleIds = (args.scheduleIds || [])
        .map((value: unknown) => Number.parseInt(String(value), 10))
        .filter((value: number) => Number.isFinite(value) && value > 0);
    const sections = uniqueSections(args.sections);
    const includeCells = args.includeCells === true ? "true" : "false";
    const scanCells = args.scanCells === true || Boolean(args.cellQuery) ? "true" : "false";
    const nameQuery = csharpString(args.nameQuery || args.query || "");
    const cellQuery = csharpString(args.cellQuery || "");
    const maxSchedules = Math.max(1, Math.min(200, Number.parseInt(String(args.maxSchedules || 50), 10) || 50));
    const maxRowsPerSection = Math.max(0, Math.min(1000, Number.parseInt(String(args.maxRowsPerSection || 80), 10) || 80));
    const maxColumnsPerSection = Math.max(0, Math.min(200, Number.parseInt(String(args.maxColumnsPerSection || 30), 10) || 30));
    const maxCellTextChars = Math.max(20, Math.min(1000, Number.parseInt(String(args.maxCellTextChars || 180), 10) || 180));
    return `
int[] requestedScheduleIds = ${csharpIntArray(scheduleIds)};
string[] requestedSections = ${csharpStringArray(sections)};
string nameQuery = ${nameQuery};
string cellQuery = ${cellQuery};
bool includeCells = ${includeCells};
bool scanCells = ${scanCells};
int maxSchedules = ${maxSchedules};
int maxRowsPerSection = ${maxRowsPerSection};
int maxColumnsPerSection = ${maxColumnsPerSection};
int maxCellTextChars = ${maxCellTextChars};

string TrimCellText(string value)
{
    if (value == null) return "";
    value = value.Replace("\\r", " ").Replace("\\n", " ").Replace("\\t", " ").Trim();
    if (value.Length <= maxCellTextChars) return value;
    return value.Substring(0, maxCellTextChars) + "...";
}

string NormalizeForSearch(string value)
{
    if (value == null) return "";
    string replaced = value
        .Replace('\\u0423', 'Y')
        .Replace('\\u0443', 'y')
        .Replace('\\u011E', 'G')
        .Replace('\\u011F', 'g')
        .Replace('\\u00DC', 'U')
        .Replace('\\u00FC', 'u')
        .Replace('\\u0130', 'I')
        .Replace('\\u0131', 'i')
        .Replace('\\u015E', 'S')
        .Replace('\\u015F', 's')
        .Replace('\\u00C7', 'C')
        .Replace('\\u00E7', 'c')
        .Replace('\\u00D6', 'O')
        .Replace('\\u00F6', 'o');
    string form = replaced.Normalize(System.Text.NormalizationForm.FormD);
    System.Text.StringBuilder sb = new System.Text.StringBuilder();
    foreach (char ch in form)
    {
        System.Globalization.UnicodeCategory category = System.Globalization.CharUnicodeInfo.GetUnicodeCategory(ch);
        if (category != System.Globalization.UnicodeCategory.NonSpacingMark)
        {
            sb.Append(ch);
        }
    }
    return sb.ToString().ToLowerInvariant();
}

bool ContainsNormalized(string value, string query)
{
    if (string.IsNullOrWhiteSpace(query)) return true;
    return NormalizeForSearch(value).Contains(NormalizeForSearch(query));
}

SectionType SectionTypeForName(string sectionName)
{
    string normalized = (sectionName ?? "").ToLowerInvariant();
    if (normalized == "footer") return SectionType.Footer;
    if (normalized == "body") return SectionType.Body;
    return SectionType.Header;
}

string ReadCell(ViewSchedule schedule, SectionType sectionType, int row, int column)
{
    try
    {
        return schedule.GetCellText(sectionType, row, column) ?? "";
    }
    catch
    {
        return "";
    }
}

object ReadSection(ViewSchedule schedule, string sectionName, out int matchCount)
{
    SectionType sectionType = SectionTypeForName(sectionName);
    System.Collections.Generic.List<object> rows = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> matches = new System.Collections.Generic.List<object>();
    matchCount = 0;
    int rowCount = 0;
    int columnCount = 0;
    bool readFailed = false;
    string readError = "";

    try
    {
        TableSectionData data = schedule.GetTableData().GetSectionData(sectionType);
        rowCount = data.NumberOfRows;
        columnCount = data.NumberOfColumns;
    }
    catch (Exception ex)
    {
        readFailed = true;
        readError = ex.Message;
    }

    int rowLimit = Math.Min(rowCount, maxRowsPerSection);
    int columnLimit = Math.Min(columnCount, maxColumnsPerSection);
    bool shouldReadCells = includeCells || (scanCells && !string.IsNullOrWhiteSpace(cellQuery));

    if (!readFailed && shouldReadCells)
    {
        for (int row = 0; row < rowLimit; row++)
        {
            System.Collections.Generic.List<object> cells = new System.Collections.Generic.List<object>();
            for (int column = 0; column < columnLimit; column++)
            {
                string text = ReadCell(schedule, sectionType, row, column);
                string trimmed = TrimCellText(text);
                if (includeCells)
                {
                    cells.Add(new {
                        column = column,
                        text = trimmed
                    });
                }
                if (!string.IsNullOrWhiteSpace(cellQuery) && ContainsNormalized(text, cellQuery))
                {
                    matches.Add(new {
                        section = sectionName,
                        row = row,
                        column = column,
                        text = trimmed
                    });
                }
            }
            if (includeCells)
            {
                rows.Add(new {
                    row = row,
                    cells = cells.ToArray()
                });
            }
        }
    }

    matchCount = matches.Count;
    return new {
        section = sectionName,
        rowCount = rowCount,
        columnCount = columnCount,
        returnedRows = includeCells ? rowLimit : 0,
        returnedColumns = includeCells ? columnLimit : 0,
        rowsTruncated = rowCount > rowLimit,
        columnsTruncated = columnCount > columnLimit,
        scannedRows = shouldReadCells ? rowLimit : 0,
        scannedColumns = shouldReadCells ? columnLimit : 0,
        matches = matches.ToArray(),
        cells = rows.ToArray(),
        readFailed = readFailed,
        readError = readError
    };
}

try
{
    System.Collections.Generic.List<string> warnings = new System.Collections.Generic.List<string>();
    System.Collections.Generic.List<ViewSchedule> sourceSchedules = new System.Collections.Generic.List<ViewSchedule>();
    System.Collections.Generic.HashSet<int> requestedIds = new System.Collections.Generic.HashSet<int>();
    foreach (int id in requestedScheduleIds)
    {
        requestedIds.Add(id);
        ViewSchedule schedule = document.GetElement(new ElementId(id)) as ViewSchedule;
        if (schedule != null && !schedule.IsTemplate)
        {
            sourceSchedules.Add(schedule);
        }
        else
        {
            warnings.Add("Schedule not found or is a template: " + id.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
    }

    bool hasExplicitIds = requestedIds.Count > 0;
    if (!hasExplicitIds)
    {
        FilteredElementCollector collector = new FilteredElementCollector(document)
            .OfClass(typeof(ViewSchedule));
        foreach (Element element in collector)
        {
            ViewSchedule schedule = element as ViewSchedule;
            if (schedule == null || schedule.IsTemplate) continue;
            sourceSchedules.Add(schedule);
        }
    }

    bool hasNameQuery = !string.IsNullOrWhiteSpace(nameQuery);
    bool hasCellQuery = !string.IsNullOrWhiteSpace(cellQuery);
    if (!hasExplicitIds && hasCellQuery && !hasNameQuery)
    {
        warnings.Add("Cell scan is bounded by maxSchedules/maxRowsPerSection/maxColumnsPerSection. Use nameQuery or scheduleIds first for large projects.");
    }

    System.Collections.Generic.List<object> schedules = new System.Collections.Generic.List<object>();
    int totalSchedules = sourceSchedules.Count;
    int candidateCount = 0;
    int scannedScheduleCount = 0;
    int scheduleNameMatchedCount = 0;
    int cellMatchedScheduleCount = 0;
    int totalCellMatches = 0;
    bool truncated = false;

    foreach (ViewSchedule schedule in sourceSchedules)
    {
        bool nameMatches = !hasNameQuery || ContainsNormalized(schedule.Name, nameQuery);
        if (!hasExplicitIds && hasNameQuery && !nameMatches)
        {
            continue;
        }

        candidateCount++;
        if (!hasExplicitIds && candidateCount > maxSchedules)
        {
            truncated = true;
            break;
        }
        if (nameMatches) scheduleNameMatchedCount++;

        System.Collections.Generic.List<object> sectionResults = new System.Collections.Generic.List<object>();
        int scheduleMatchCount = 0;
        bool shouldReadSections = includeCells || scanCells;
        if (shouldReadSections)
        {
            scannedScheduleCount++;
            foreach (string sectionName in requestedSections)
            {
                int sectionMatchCount = 0;
                object sectionResult = ReadSection(schedule, sectionName, out sectionMatchCount);
                sectionResults.Add(sectionResult);
                scheduleMatchCount += sectionMatchCount;
            }
        }

        bool includeSchedule = hasExplicitIds || nameMatches || !hasCellQuery || scheduleMatchCount > 0;
        if (!includeSchedule) continue;
        if (scheduleMatchCount > 0) cellMatchedScheduleCount++;
        totalCellMatches += scheduleMatchCount;

        schedules.Add(new {
            id = schedule.Id.IntegerValue,
            uniqueId = schedule.UniqueId,
            name = schedule.Name,
            viewType = schedule.ViewType.ToString(),
            isTemplate = schedule.IsTemplate,
            nameMatched = nameMatches,
            cellMatchCount = scheduleMatchCount,
            sections = sectionResults.ToArray()
        });
    }

    return new {
        success = true,
        action = "inspect_schedules",
        query = nameQuery,
        nameQuery = nameQuery,
        cellQuery = cellQuery,
        totalSchedules = totalSchedules,
        candidateCount = candidateCount,
        returnedCount = schedules.Count,
        truncated = truncated,
        maxSchedules = maxSchedules,
        scan = new {
            enabled = scanCells,
            includeCells = includeCells,
            sections = requestedSections,
            maxRowsPerSection = maxRowsPerSection,
            maxColumnsPerSection = maxColumnsPerSection,
            scannedScheduleCount = scannedScheduleCount,
            scheduleNameMatchedCount = scheduleNameMatchedCount,
            cellMatchedScheduleCount = cellMatchedScheduleCount,
            totalCellMatches = totalCellMatches
        },
        schedules = schedules.ToArray(),
        warnings = warnings.ToArray()
    };
}
catch (Exception ex)
{
    return new {
        success = false,
        action = "inspect_schedules",
        error = ex.ToString()
    };
}`;
}

function isObject(value: unknown): value is JsonObject {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scheduleSections(payload: JsonObject) {
    const schedules = Array.isArray(payload.schedules) ? payload.schedules : [];
    return schedules.flatMap((schedule: JsonObject) => {
        const sections = Array.isArray(schedule.sections) ? schedule.sections : [];
        return sections.map((section: JsonObject) => ({ schedule, section }));
    });
}

function buildScheduleEvidenceRows(payload: JsonObject) {
    return scheduleSections(payload).flatMap(({ schedule, section }) => {
        const matches = Array.isArray(section.matches) ? section.matches : [];
        return matches
            .filter(isObject)
            .map((match) => ({
                sourceType: "scheduleCell",
                scheduleId: schedule.id,
                scheduleName: schedule.name,
                section: match.section ?? section.section,
                row: match.row,
                column: match.column,
                text: match.text,
            }));
    });
}

function inferSchedulePartial(payload: JsonObject) {
    if (payload.partial === true || payload.truncated === true) {
        return true;
    }
    return scheduleSections(payload).some(({ section }) => section.rowsTruncated === true || section.columnsTruncated === true);
}

function inferScheduleStopReason(payload: JsonObject) {
    if (!inferSchedulePartial(payload)) {
        return "completed";
    }
    if (payload.truncated === true) {
        return "max_items";
    }
    for (const { section } of scheduleSections(payload)) {
        if (section.rowsTruncated === true) return "max_rows";
        if (section.columnsTruncated === true) return "max_columns";
    }
    return "max_cells";
}

function buildScheduleSummary(payload: JsonObject) {
    const scan = isObject(payload.scan) ? payload.scan : {};
    const evidenceRows = Array.isArray(payload.evidenceRows)
        ? payload.evidenceRows
        : buildScheduleEvidenceRows(payload);
    return {
        query: payload.query ?? null,
        nameQuery: payload.nameQuery ?? null,
        cellQuery: payload.cellQuery ?? null,
        totalSchedules: payload.totalSchedules ?? null,
        candidateCount: payload.candidateCount ?? null,
        returnedCount: payload.returnedCount ?? (Array.isArray(payload.schedules) ? payload.schedules.length : null),
        matchCount: evidenceRows.length,
        totalCellMatches: scan.totalCellMatches ?? evidenceRows.length,
        scannedScheduleCount: scan.scannedScheduleCount ?? null,
        partial: payload.partial === true,
        scanStoppedReason: payload.scanStoppedReason ?? "completed",
    };
}

function inferScheduleLastRead(payload: JsonObject) {
    const evidenceRows = Array.isArray(payload.evidenceRows)
        ? payload.evidenceRows
        : buildScheduleEvidenceRows(payload);
    const lastEvidence = evidenceRows.length > 0 ? evidenceRows[evidenceRows.length - 1] : null;
    const sections = scheduleSections(payload);
    const lastSection = sections.length > 0 ? sections[sections.length - 1].section : null;
    const returnedRows = Number(lastSection?.returnedRows ?? lastSection?.scannedRows ?? 0);
    const returnedColumns = Number(lastSection?.returnedColumns ?? lastSection?.scannedColumns ?? 0);
    return {
        lastReadSection: lastEvidence?.section ?? lastSection?.section ?? null,
        lastReadRow: lastEvidence?.row ?? (returnedRows > 0 ? returnedRows - 1 : null),
        lastReadColumn: lastEvidence?.column ?? (returnedColumns > 0 ? returnedColumns - 1 : null),
        lastReadSheetId: null,
        lastReadViewId: null,
        lastReadViewportId: null,
        lastReadItemId: lastEvidence?.scheduleId ?? null,
    };
}

function buildScheduleScanPolicy(args: JsonObject) {
    return {
        allowExpensiveSearch: args.allowExpensiveSearch === true,
        includeCells: args.includeCells === true,
        scanCells: args.scanCells === true || Boolean(args.cellQuery),
        sections: uniqueSections(args.sections),
        maxSchedules: Math.max(1, Math.min(200, Number.parseInt(String(args.maxSchedules || 50), 10) || 50)),
        maxRowsPerSection: Math.max(0, Math.min(1000, Number.parseInt(String(args.maxRowsPerSection || 80), 10) || 80)),
        maxColumnsPerSection: Math.max(0, Math.min(200, Number.parseInt(String(args.maxColumnsPerSection || 30), 10) || 30)),
        timeoutMs: Math.max(1000, Math.min(120000, Number.parseInt(String(args.timeoutMs || 120000), 10) || 120000)),
    };
}

function normalizeScheduleResult(payload: JsonObject, args: JsonObject, elapsedMs: number) {
    const partial = inferSchedulePartial(payload);
    return normalizeBroadScanResult(payload, {
        action: "inspect_schedules",
        elapsedMs,
        partial,
        scanStoppedReason: payload.scanStoppedReason ?? inferScheduleStopReason(payload),
        scanPolicy: buildScheduleScanPolicy(args),
        suggestedNextScopes: ["nameQuery", "scheduleIds", "sections", "maxRowsPerSection", "maxColumnsPerSection", "allowExpensiveSearch"],
        summary: buildScheduleSummary,
        evidenceRows: buildScheduleEvidenceRows,
        lastRead: inferScheduleLastRead,
    });
}

export function registerInspectSchedulesTool(server: ToolServer) {
    server.tool("inspect_schedules", "[SCHEDULE_INSPECTION_READ_ONLY] Read-only Revit schedule discovery and bounded cell inspection for large models. Prefer this over generic send_code_to_revit when finding schedules or reading schedule cells. For large models, use nameQuery/scheduleIds first; broad cell scans require allowExpensiveSearch=true.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        query: z.string().optional().describe("Alias for nameQuery. Matches schedule names with Turkish/diacritic/Cyrillic-U normalization."),
        nameQuery: z.string().optional().describe("Schedule name filter. Use this first in large projects before scanning cells."),
        cellQuery: z.string().optional().describe("Optional text to search inside bounded schedule cells. Use with nameQuery or scheduleIds for large projects."),
        scheduleIds: z.array(z.union([z.number(), z.string()])).optional().describe("Exact ViewSchedule element ids to inspect. Preferred when known."),
        sections: z.array(z.enum(["header", "body", "footer"])).optional().describe("Schedule sections to read/scan. Defaults to header and body."),
        includeCells: z.boolean().optional().describe("Return a bounded cell snapshot for each returned schedule. Defaults false."),
        scanCells: z.boolean().optional().describe("Scan bounded cells for cellQuery. Defaults true when cellQuery is provided, otherwise false."),
        allowExpensiveSearch: z.boolean().optional().describe("Explicit approval for scanning schedule cells without scheduleIds/nameQuery. Defaults false."),
        maxSchedules: z.number().int().positive().max(200).optional().describe("Maximum schedules to inspect/return. Defaults 50."),
        maxRowsPerSection: z.number().int().min(0).max(1000).optional().describe("Maximum rows per section to read/scan. Defaults 80."),
        maxColumnsPerSection: z.number().int().min(0).max(200).optional().describe("Maximum columns per section to read/scan. Defaults 30."),
        maxCellTextChars: z.number().int().min(20).max(1000).optional().describe("Maximum characters retained per returned cell text. Defaults 180."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Socket timeout in milliseconds. Defaults 120000."),
    }, async (args) => {
        const startedAtMs = Date.now();
        try {
            const hasScheduleScope = Boolean(
                (Array.isArray(args.scheduleIds) && args.scheduleIds.length > 0) ||
                String(args.nameQuery || args.query || "").trim()
            );
            const wantsCells = Boolean(args.includeCells === true || args.scanCells === true || String(args.cellQuery || "").trim());
            if (wantsCells && !hasScheduleScope && args.allowExpensiveSearch !== true) {
                return formatJsonContent(buildBroadScanGuardedResult({
                    action: "inspect_schedules",
                    reason: "needs_scope",
                    message: "Schedule cell scanning without scheduleIds/nameQuery can be expensive in large models. First discover schedules by name, pass exact scheduleIds, or set allowExpensiveSearch=true.",
                    suggestedNextScopes: ["nameQuery", "scheduleIds", "sections", "maxRowsPerSection", "maxColumnsPerSection", "allowExpensiveSearch"],
                    scanPolicy: buildScheduleScanPolicy(args),
                    elapsedMs: Date.now() - startedAtMs,
                    summary: {
                        nameQuery: args.nameQuery ?? args.query ?? null,
                        cellQuery: args.cellQuery ?? null,
                        returnedCount: 0,
                        matchCount: 0,
                    },
                }));
            }
            const response = await executeRevitCode(buildInspectSchedulesCode(args), {
                ...connectionOptionsFromArgs(args),
                ...taskOptionsFromArgs(args, "Inspect Revit schedules"),
                toolName: "inspect_schedules",
                transactionMode: "none",
            });
            return formatJsonContent(normalizeScheduleResult(response && response.result ? response.result : response, args, Date.now() - startedAtMs));
        }
        catch (error) {
            return formatJsonContent(buildBroadScanFailureResult({
                action: "inspect_schedules",
                error: error instanceof Error ? error.message : String(error),
                elapsedMs: Date.now() - startedAtMs,
                scanPolicy: buildScheduleScanPolicy(args),
                suggestedNextScopes: ["nameQuery", "scheduleIds", "sections", "maxRowsPerSection", "maxColumnsPerSection", "allowExpensiveSearch"],
            }));
        }
    });
}
