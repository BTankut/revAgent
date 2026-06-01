import { z } from "zod";
import {
    connectionOptionsFromArgs,
    connectionTargetSchema,
    csharpString,
    csharpStringArray,
    executeRevitCode,
    formatJsonContent,
    taskMetadataSchema,
    taskOptionsFromArgs,
} from "../utils/revitToolHelpers.js";
import { runtimeFailure } from "../utils/runtimeResult.js";

function normalizeIntegerValues(values, maxCount = 100) {
    return (Array.isArray(values) ? values : [])
        .slice(0, maxCount)
        .map((value) => Number.parseInt(String(value), 10))
        .filter((value) => Number.isFinite(value));
}

function csharpIntArray(values) {
    return `new int[] { ${values.join(", ")} }`;
}

function normalizeTextQueries(args) {
    const queries = [];
    if (typeof args.rowTextQuery === "string" && args.rowTextQuery.trim()) {
        queries.push(args.rowTextQuery.trim());
    }
    if (Array.isArray(args.rowTextQueries)) {
        for (const query of args.rowTextQueries) {
            const text = String(query ?? "").trim();
            if (text) queries.push(text);
        }
    }
    return [...new Set(queries)].slice(0, 20);
}

function buildSetScheduleCellsByTextCode(args) {
    const scheduleIds = normalizeIntegerValues(args.scheduleIds, 200);
    const sheetIds = normalizeIntegerValues(args.sheetIds, 200);
    const rowTextQueries = normalizeTextQueries(args);
    const targetColumn = Number.parseInt(String(args.targetColumn), 10);
    const maxSchedules = Math.max(1, Math.min(Number.parseInt(String(args.maxSchedules ?? 20), 10) || 20, 200));
    const maxRowsPerSchedule = Math.max(1, Math.min(Number.parseInt(String(args.maxRowsPerSchedule ?? 250), 10) || 250, 2000));
    const maxColumnsPerSchedule = Math.max(1, Math.min(Number.parseInt(String(args.maxColumnsPerSchedule ?? 80), 10) || 80, 300));
    const maxMatches = Math.max(1, Math.min(Number.parseInt(String(args.maxMatches ?? 50), 10) || 50, 500));
    const mode = args.mode === "commit" ? "commit" : "dryRun";
    const section = args.section || "body";
    const rowMatchMode = args.rowMatchMode === "any" ? "any" : "all";
    const allowMultipleMatches = args.allowMultipleMatches === true ? "true" : "false";
    const allowCurrentMismatch = args.allowCurrentMismatch === true ? "true" : "false";
    const hasExpectedCurrentText = args.expectedCurrentText !== undefined && args.expectedCurrentText !== null ? "true" : "false";
    const expectedCurrentText = csharpString(args.expectedCurrentText ?? "");

    return `
int[] exactScheduleIds = ${csharpIntArray(scheduleIds)};
int[] exactSheetIds = ${csharpIntArray(sheetIds)};
string scheduleNameQuery = ${csharpString(args.scheduleNameQuery || args.scheduleQuery || "")};
string sheetQuery = ${csharpString(args.sheetQuery || "")};
string requestedSection = ${csharpString(section)};
string[] rowTextQueries = ${csharpStringArray(rowTextQueries)};
string rowMatchMode = ${csharpString(rowMatchMode)};
int targetColumn = ${Number.isFinite(targetColumn) ? targetColumn : -1};
string requestedValue = ${csharpString(args.value ?? "")};
string mode = ${csharpString(mode)};
bool dryRun = !string.Equals(mode, "commit", StringComparison.OrdinalIgnoreCase);
bool allowMultipleMatches = ${allowMultipleMatches};
bool allowCurrentMismatch = ${allowCurrentMismatch};
bool hasExpectedCurrentText = ${hasExpectedCurrentText};
string expectedCurrentText = ${expectedCurrentText};
int maxSchedules = ${maxSchedules};
int maxRowsPerSchedule = ${maxRowsPerSchedule};
int maxColumnsPerSchedule = ${maxColumnsPerSchedule};
int maxMatches = ${maxMatches};

SectionType SectionTypeForName(string sectionName)
{
    string normalized = (sectionName ?? "").ToLowerInvariant();
    if (normalized == "footer") return SectionType.Footer;
    if (normalized == "header") return SectionType.Header;
    return SectionType.Body;
}

string NormalizeText(string value)
{
    string text = value ?? "";
    text = text.Replace("\\r", " ").Replace("\\n", " ").Replace("\\t", " ");
    text = text.Replace("\\u0130", "I").Replace("\\u0131", "i");
    string decomposed = text.Normalize(System.Text.NormalizationForm.FormD);
    System.Text.StringBuilder builder = new System.Text.StringBuilder();
    for (int i = 0; i < decomposed.Length; i++)
    {
        char ch = decomposed[i];
        System.Globalization.UnicodeCategory category = System.Globalization.CharUnicodeInfo.GetUnicodeCategory(ch);
        if (category != System.Globalization.UnicodeCategory.NonSpacingMark)
        {
            builder.Append(ch);
        }
    }
    return builder.ToString().Normalize(System.Text.NormalizationForm.FormC).ToLowerInvariant();
}

bool ContainsNormalized(string haystack, string needle)
{
    string normalizedNeedle = NormalizeText(needle);
    if (string.IsNullOrWhiteSpace(normalizedNeedle)) return true;
    return NormalizeText(haystack).Contains(normalizedNeedle);
}

bool MatchesAllQueries(string rowText)
{
    if (rowTextQueries.Length == 0) return false;
    bool any = string.Equals(rowMatchMode, "any", StringComparison.OrdinalIgnoreCase);
    bool matchedAny = false;
    for (int i = 0; i < rowTextQueries.Length; i++)
    {
        bool matched = ContainsNormalized(rowText, rowTextQueries[i]);
        if (any && matched) return true;
        if (!any && !matched) return false;
        if (matched) matchedAny = true;
    }
    return any ? matchedAny : true;
}

bool IdArrayContains(int[] ids, int id)
{
    for (int i = 0; i < ids.Length; i++)
    {
        if (ids[i] == id) return true;
    }
    return false;
}

string ReadCell(ViewSchedule schedule, SectionType sectionType, int row, int column, out bool readable, out string error)
{
    readable = false;
    error = "";
    try
    {
        string value = schedule.GetCellText(sectionType, row, column) ?? "";
        readable = true;
        return value;
    }
    catch (Exception ex)
    {
        error = ex.Message;
        return "";
    }
}

object MatchResult(ViewSchedule schedule, string sheetNumber, string sheetName, SectionType sectionType, int row, int column, string rowText, string before, bool readable, bool wouldChange, bool blocked, string reason, string error)
{
    return new {
        scheduleId = schedule.Id.IntegerValue,
        scheduleName = schedule.Name,
        sheetNumber = sheetNumber,
        sheetName = sheetName,
        section = requestedSection,
        row = row,
        column = column,
        rowText = rowText,
        before = before,
        requestedValue = requestedValue,
        readable = readable,
        wouldChange = wouldChange,
        blocked = blocked,
        reason = reason,
        error = error
    };
}

try
{
    bool hasScheduleScope = exactScheduleIds.Length > 0 || !string.IsNullOrWhiteSpace(scheduleNameQuery);
    bool hasSheetScope = exactSheetIds.Length > 0 || !string.IsNullOrWhiteSpace(sheetQuery);
    if (!hasScheduleScope && !hasSheetScope)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells_by_text",
            reason = "missing_bounded_scope",
            error = "Provide scheduleIds, scheduleNameQuery, sheetIds, or sheetQuery before searching schedule rows.",
            committed = false
        };
    }
    if (rowTextQueries.Length == 0)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells_by_text",
            reason = "missing_row_text_query",
            error = "Provide rowTextQuery or rowTextQueries before writing by row match.",
            committed = false
        };
    }
    if (targetColumn < 0)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells_by_text",
            reason = "invalid_target_column",
            error = "targetColumn must be a zero-based column index.",
            committed = false
        };
    }

    System.Collections.Generic.Dictionary<int, string> scheduleSheetLabels = new System.Collections.Generic.Dictionary<int, string>();
    System.Collections.Generic.Dictionary<int, string> scheduleSheetNames = new System.Collections.Generic.Dictionary<int, string>();
    System.Collections.Generic.HashSet<int> candidateScheduleIds = new System.Collections.Generic.HashSet<int>();

    foreach (int id in exactScheduleIds) candidateScheduleIds.Add(id);

    if (hasSheetScope)
    {
        System.Collections.Generic.List<ViewSheet> sheets = new FilteredElementCollector(document)
            .OfClass(typeof(ViewSheet))
            .Cast<ViewSheet>()
            .Where(s => !s.IsTemplate)
            .OrderBy(s => s.SheetNumber)
            .ToList();

        foreach (ViewSheet sheet in sheets)
        {
            bool match = exactSheetIds.Length == 0 && string.IsNullOrWhiteSpace(sheetQuery);
            if (!match && exactSheetIds.Length > 0 && IdArrayContains(exactSheetIds, sheet.Id.IntegerValue)) match = true;
            if (!match && !string.IsNullOrWhiteSpace(sheetQuery))
            {
                match = ContainsNormalized(sheet.SheetNumber, sheetQuery) || ContainsNormalized(sheet.Name, sheetQuery);
            }
            if (!match) continue;

            System.Collections.Generic.List<ScheduleSheetInstance> placements = new FilteredElementCollector(document, sheet.Id)
                .OfClass(typeof(ScheduleSheetInstance))
                .Cast<ScheduleSheetInstance>()
                .ToList();
            foreach (ScheduleSheetInstance placement in placements)
            {
                int scheduleId = placement.ScheduleId.IntegerValue;
                candidateScheduleIds.Add(scheduleId);
                if (!scheduleSheetLabels.ContainsKey(scheduleId)) scheduleSheetLabels[scheduleId] = sheet.SheetNumber;
                if (!scheduleSheetNames.ContainsKey(scheduleId)) scheduleSheetNames[scheduleId] = sheet.Name;
            }
        }
    }

    if (!string.IsNullOrWhiteSpace(scheduleNameQuery))
    {
        System.Collections.Generic.List<ViewSchedule> namedSchedules = new FilteredElementCollector(document)
            .OfClass(typeof(ViewSchedule))
            .Cast<ViewSchedule>()
            .Where(s => !s.IsTemplate && ContainsNormalized(s.Name, scheduleNameQuery))
            .OrderBy(s => s.Name)
            .ToList();
        foreach (ViewSchedule schedule in namedSchedules)
        {
            candidateScheduleIds.Add(schedule.Id.IntegerValue);
        }
    }

    System.Collections.Generic.List<ViewSchedule> schedules = new System.Collections.Generic.List<ViewSchedule>();
    foreach (int id in candidateScheduleIds)
    {
        ViewSchedule schedule = document.GetElement(new ElementId(id)) as ViewSchedule;
        if (schedule == null || schedule.IsTemplate) continue;
        if (!string.IsNullOrWhiteSpace(scheduleNameQuery) && !ContainsNormalized(schedule.Name, scheduleNameQuery)) continue;
        schedules.Add(schedule);
    }
    schedules = schedules
        .GroupBy(s => s.Id.IntegerValue)
        .Select(g => g.First())
        .OrderBy(s => s.Name)
        .Take(maxSchedules)
        .ToList();

    SectionType sectionType = SectionTypeForName(requestedSection);
    System.Collections.Generic.List<object> matches = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<string> errors = new System.Collections.Generic.List<string>();
    int scannedRowCount = 0;

    foreach (ViewSchedule schedule in schedules)
    {
        TableSectionData sectionData = schedule.GetTableData().GetSectionData(sectionType);
        int firstRow = sectionData.FirstRowNumber;
        int lastRow = sectionData.LastRowNumber;
        int firstColumn = sectionData.FirstColumnNumber;
        int lastColumn = sectionData.LastColumnNumber;
        int effectiveLastColumn = Math.Min(lastColumn, firstColumn + maxColumnsPerSchedule - 1);
        int scannedRowsForSchedule = 0;

        for (int row = firstRow; row <= lastRow; row++)
        {
            if (scannedRowsForSchedule >= maxRowsPerSchedule) break;
            scannedRowsForSchedule++;
            scannedRowCount++;

            System.Collections.Generic.List<string> cells = new System.Collections.Generic.List<string>();
            for (int column = firstColumn; column <= effectiveLastColumn; column++)
            {
                bool readableCell = false;
                string cellError = "";
                cells.Add(ReadCell(schedule, sectionType, row, column, out readableCell, out cellError));
            }
            string rowText = string.Join(" | ", cells);
            if (!MatchesAllQueries(rowText)) continue;

            bool blocked = false;
            string reason = "";
            string error = "";
            bool readable = false;
            string before = "";
            if (targetColumn < firstColumn || targetColumn > lastColumn)
            {
                blocked = true;
                reason = "target_column_out_of_range";
                error = "targetColumn is outside the selected schedule section.";
            }
            else
            {
                before = ReadCell(schedule, sectionType, targetColumn < 0 ? row : row, targetColumn, out readable, out error);
                if (!readable)
                {
                    blocked = true;
                    reason = "target_cell_not_readable";
                }
                if (!blocked && hasExpectedCurrentText && !allowCurrentMismatch && !string.Equals(before, expectedCurrentText, StringComparison.Ordinal))
                {
                    blocked = true;
                    reason = "current_value_mismatch";
                    error = "Current cell text does not match expectedCurrentText.";
                }
            }

            if (blocked) errors.Add(schedule.Name + " row " + row.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", column " + targetColumn.ToString(System.Globalization.CultureInfo.InvariantCulture) + ": " + reason);
            bool wouldChange = readable && !string.Equals(before, requestedValue, StringComparison.Ordinal);
            string sheetNumber = scheduleSheetLabels.ContainsKey(schedule.Id.IntegerValue) ? scheduleSheetLabels[schedule.Id.IntegerValue] : "";
            string sheetName = scheduleSheetNames.ContainsKey(schedule.Id.IntegerValue) ? scheduleSheetNames[schedule.Id.IntegerValue] : "";
            matches.Add(MatchResult(schedule, sheetNumber, sheetName, sectionType, row, targetColumn, rowText, before, readable, wouldChange, blocked, reason, error));
            if (matches.Count >= maxMatches) break;
        }
        if (matches.Count >= maxMatches) break;
    }

    if (matches.Count == 0)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells_by_text",
            reason = "no_matching_rows",
            error = "No schedule rows matched the requested row text queries.",
            committed = false,
            dryRun = dryRun,
            scheduleCount = schedules.Count,
            scannedRowCount = scannedRowCount
        };
    }
    if (matches.Count > 1 && !allowMultipleMatches)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells_by_text",
            reason = "multiple_matching_rows",
            error = "Multiple rows matched. Set allowMultipleMatches=true only after reviewing the dry-run output.",
            committed = false,
            dryRun = dryRun,
            scheduleCount = schedules.Count,
            scannedRowCount = scannedRowCount,
            matchCount = matches.Count,
            matches = matches.ToArray()
        };
    }
    if (errors.Count > 0)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells_by_text",
            reason = "matched_cell_preflight_failed",
            error = "One or more matched cells failed preflight.",
            committed = false,
            dryRun = dryRun,
            scheduleCount = schedules.Count,
            scannedRowCount = scannedRowCount,
            matchCount = matches.Count,
            matches = matches.ToArray(),
            errors = errors.ToArray()
        };
    }

    int wouldChangeCount = 0;
    foreach (object item in matches)
    {
        object value = item.GetType().GetProperty("wouldChange").GetValue(item, null);
        if (value is bool && (bool)value) wouldChangeCount++;
    }

    if (dryRun)
    {
        return new {
            success = true,
            guarded = false,
            state = "dry_run",
            action = "set_schedule_cells_by_text",
            committed = false,
            dryRun = true,
            scheduleCount = schedules.Count,
            scannedRowCount = scannedRowCount,
            matchCount = matches.Count,
            wouldChangeCount = wouldChangeCount,
            matches = matches.ToArray(),
            warnings = new string[] { "Dry run only. Re-run with mode=commit to write matched schedule cells." }
        };
    }

    System.Collections.Generic.List<object> committed = new System.Collections.Generic.List<object>();
    int changedCount = 0;
    int verifiedCount = 0;
    foreach (object match in matches)
    {
        int scheduleId = (int)match.GetType().GetProperty("scheduleId").GetValue(match, null);
        int row = (int)match.GetType().GetProperty("row").GetValue(match, null);
        int column = (int)match.GetType().GetProperty("column").GetValue(match, null);
        ViewSchedule schedule = document.GetElement(new ElementId(scheduleId)) as ViewSchedule;
        TableSectionData sectionData = schedule.GetTableData().GetSectionData(sectionType);
        bool readableBefore = false;
        string readError = "";
        string before = ReadCell(schedule, sectionType, row, column, out readableBefore, out readError);
        bool changed = !string.Equals(before, requestedValue, StringComparison.Ordinal);
        string after = before;
        bool verified = !changed;
        if (changed)
        {
            sectionData.SetCellText(row, column, requestedValue);
            changedCount++;
            bool readableAfter = false;
            string afterError = "";
            after = ReadCell(schedule, sectionType, row, column, out readableAfter, out afterError);
            verified = readableAfter && string.Equals(after, requestedValue, StringComparison.Ordinal);
            if (!verified)
            {
                throw new Exception("Schedule cell verification failed for schedule " + schedule.Name + ", row " + row.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", column " + column.ToString(System.Globalization.CultureInfo.InvariantCulture) + ".");
            }
        }
        if (verified) verifiedCount++;
        committed.Add(new {
            scheduleId = schedule.Id.IntegerValue,
            scheduleName = schedule.Name,
            row = row,
            column = column,
            before = before,
            after = after,
            changed = changed,
            verified = verified
        });
    }

    return new {
        success = true,
        guarded = false,
        state = "committed",
        action = "set_schedule_cells_by_text",
        committed = true,
        dryRun = false,
        scheduleCount = schedules.Count,
        scannedRowCount = scannedRowCount,
        matchCount = matches.Count,
        changedCount = changedCount,
        verifiedCount = verifiedCount,
        changes = committed.ToArray()
    };
}
catch (Exception ex)
{
    if (!dryRun)
    {
        throw;
    }
    return new {
        success = false,
        guarded = true,
        state = "guarded",
        action = "set_schedule_cells_by_text",
        reason = "set_schedule_cells_by_text_exception",
        error = ex.ToString(),
        committed = false
    };
}`;
}

export function registerSetScheduleCellsByTextTool(server) {
    server.tool("set_schedule_cells_by_text", "[PRODUCTION_SCHEDULE_CELL_WRITE_BY_TEXT] Finds bounded schedule rows by sheet/schedule filters and row text, then previews or commits a target column update with readback verification. Prefer this over generic send_code_to_revit for repeated schedule row text writes.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        scheduleIds: z.array(z.union([z.number(), z.string()])).optional().describe("Exact ViewSchedule ids to inspect. Preferred when known."),
        scheduleNameQuery: z.string().optional().describe("Bounded schedule name filter. Use this before broad row text matching."),
        scheduleQuery: z.string().optional().describe("Alias for scheduleNameQuery."),
        sheetIds: z.array(z.union([z.number(), z.string()])).optional().describe("Exact ViewSheet ids whose placed schedules should be inspected."),
        sheetQuery: z.string().optional().describe("Sheet number/name filter whose placed schedules should be inspected."),
        section: z.enum(["header", "body", "footer"]).optional().describe("Schedule section to search and write. Defaults to body."),
        rowTextQuery: z.string().optional().describe("Text that must appear in the row. Combine with rowTextQueries for safer matching."),
        rowTextQueries: z.array(z.string()).optional().describe("All row text terms to match by default. Use rowMatchMode=any to match any term."),
        rowMatchMode: z.enum(["all", "any"]).optional().describe("Defaults to all. all requires every rowTextQuery term to match the row text."),
        targetColumn: z.number().int().min(0).describe("Zero-based target column to write in each matched row."),
        value: z.string().describe("Target cell text."),
        expectedCurrentText: z.string().optional().describe("Optional compare-and-set guard for the target cell text."),
        allowCurrentMismatch: z.boolean().optional().describe("Defaults false. Keep false for production writes so stale target cells are blocked."),
        allowMultipleMatches: z.boolean().optional().describe("Defaults false. Required when more than one row match should be updated."),
        mode: z.enum(["dryRun", "commit"]).optional().describe("Defaults to dryRun. commit writes all matched cells in one wrapper transaction."),
        maxSchedules: z.number().int().positive().max(200).optional().describe("Maximum candidate schedules to inspect. Defaults 20."),
        maxRowsPerSchedule: z.number().int().positive().max(2000).optional().describe("Maximum rows scanned per schedule. Defaults 250."),
        maxColumnsPerSchedule: z.number().int().positive().max(300).optional().describe("Maximum columns read when matching row text. Defaults 80."),
        maxMatches: z.number().int().positive().max(500).optional().describe("Maximum matching rows returned or written. Defaults 50."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Socket timeout in milliseconds. Defaults 120000."),
    }, async (args) => {
        try {
            const mode = args.mode === "commit" ? "commit" : "dryRun";
            const scheduleNameQuery = args.scheduleNameQuery || args.scheduleQuery;
            const response = await executeRevitCode(buildSetScheduleCellsByTextCode({ ...args, scheduleNameQuery }), {
                ...connectionOptionsFromArgs(args),
                ...taskOptionsFromArgs(args, mode === "commit" ? "Set Revit schedule cells by text" : "Preview Revit schedule row text changes"),
                toolName: "set_schedule_cells_by_text",
                transactionMode: mode === "commit" ? "auto" : "none",
            });
            return formatJsonContent(response && response.result ? response.result : response);
        }
        catch (error) {
            return formatJsonContent(runtimeFailure({
                action: "set_schedule_cells_by_text",
                reason: "set_schedule_cells_by_text_runtime_error",
                error: error instanceof Error ? error.message : String(error),
                extra: { committed: false },
            }));
        }
    });
}
