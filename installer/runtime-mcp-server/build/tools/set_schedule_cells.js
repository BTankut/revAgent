import { z } from "zod";
import { connectionOptionsFromArgs, connectionTargetSchema, csharpString, csharpStringArray, executeRevitCode, formatJsonContent, taskMetadataSchema, taskOptionsFromArgs, } from "../utils/revitToolHelpers.js";
function csharpIntArrayFromValues(values) {
    const normalized = values
        .map((value) => Number.parseInt(String(value), 10))
        .filter((value) => Number.isFinite(value));
    return `new int[] { ${normalized.join(", ")} }`;
}
function csharpBoolArray(values) {
    return `new bool[] { ${values.map((value) => value ? "true" : "false").join(", ")} }`;
}
function normalizeCellSpecs(args) {
    const cells = Array.isArray(args.cells) ? args.cells : [];
    return cells.slice(0, 200).map((cell) => ({
        row: Math.max(0, Number.parseInt(String(cell.row), 10) || 0),
        column: Math.max(0, Number.parseInt(String(cell.column), 10) || 0),
        value: String(cell.value ?? ""),
        hasExpectedCurrentText: cell.expectedCurrentText !== undefined && cell.expectedCurrentText !== null,
        expectedCurrentText: String(cell.expectedCurrentText ?? ""),
    }));
}
function buildSetScheduleCellsCode(args) {
    const scheduleId = Number.parseInt(String(args.scheduleId), 10);
    const cells = normalizeCellSpecs(args);
    const section = csharpString(args.section);
    const mode = csharpString(args.mode === "commit" ? "commit" : "dryRun");
    const allowCurrentMismatch = args.allowCurrentMismatch === true ? "true" : "false";
    return `
int scheduleId = ${Number.isFinite(scheduleId) ? scheduleId : 0};
string requestedSection = ${section};
string mode = ${mode};
bool dryRun = !string.Equals(mode, "commit", StringComparison.OrdinalIgnoreCase);
bool allowCurrentMismatch = ${allowCurrentMismatch};
int[] rows = ${csharpIntArrayFromValues(cells.map((cell) => cell.row))};
int[] columns = ${csharpIntArrayFromValues(cells.map((cell) => cell.column))};
string[] requestedValues = ${csharpStringArray(cells.map((cell) => cell.value))};
bool[] hasExpectedCurrentTexts = ${csharpBoolArray(cells.map((cell) => cell.hasExpectedCurrentText))};
string[] expectedCurrentTexts = ${csharpStringArray(cells.map((cell) => cell.expectedCurrentText))};

SectionType SectionTypeForName(string sectionName)
{
    string normalized = (sectionName ?? "").ToLowerInvariant();
    if (normalized == "footer") return SectionType.Footer;
    if (normalized == "body") return SectionType.Body;
    return SectionType.Header;
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

object CellResult(int index, int row, int column, string requestedValue, string beforeValue, string afterValue, bool readable, bool changed, bool verified, bool blocked, string reason, string error)
{
    return new {
        index = index,
        row = row,
        column = column,
        requestedValue = requestedValue,
        before = beforeValue,
        after = afterValue,
        readable = readable,
        changed = changed,
        verified = verified,
        blocked = blocked,
        reason = reason,
        error = error
    };
}

try
{
    System.Collections.Generic.List<object> planned = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<string> errors = new System.Collections.Generic.List<string>();
    System.Collections.Generic.HashSet<string> seenCells = new System.Collections.Generic.HashSet<string>();
    int wouldChangeCount = 0;

    ViewSchedule schedule = document.GetElement(new ElementId(scheduleId)) as ViewSchedule;
    if (schedule == null || schedule.IsTemplate)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells",
            reason = "schedule_not_found",
            error = "Schedule not found or schedule id points to a template.",
            scheduleId = scheduleId,
            committed = false
        };
    }

    SectionType sectionType = SectionTypeForName(requestedSection);
    TableSectionData sectionData = schedule.GetTableData().GetSectionData(sectionType);
    int rowCount = sectionData.NumberOfRows;
    int columnCount = sectionData.NumberOfColumns;

    if (rows.Length == 0)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells",
            reason = "no_cells",
            error = "Provide at least one schedule cell.",
            scheduleId = scheduleId,
            scheduleName = schedule.Name,
            committed = false
        };
    }

    for (int i = 0; i < rows.Length; i++)
    {
        int row = rows[i];
        int column = columns[i];
        string requestedValue = requestedValues[i] ?? "";
        bool blocked = false;
        string reason = "";
        string error = "";
        bool readable = false;
        string before = "";
        string key = row.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + column.ToString(System.Globalization.CultureInfo.InvariantCulture);

        if (seenCells.Contains(key))
        {
            blocked = true;
            reason = "duplicate_cell";
            error = "The same schedule cell was requested more than once.";
        }
        seenCells.Add(key);

        if (!blocked && (row < 0 || row >= rowCount || column < 0 || column >= columnCount))
        {
            blocked = true;
            reason = "cell_out_of_range";
            error = "Requested cell is outside the selected schedule section.";
        }

        if (!blocked)
        {
            before = ReadCell(schedule, sectionType, row, column, out readable, out error);
            if (!readable)
            {
                blocked = true;
                reason = "cell_not_readable";
            }
        }

        if (!blocked && hasExpectedCurrentTexts[i] && !allowCurrentMismatch && !string.Equals(before, expectedCurrentTexts[i] ?? "", StringComparison.Ordinal))
        {
            blocked = true;
            reason = "current_value_mismatch";
            error = "Current cell text does not match expectedCurrentText.";
        }

        if (blocked)
        {
            errors.Add(reason + " at row " + row.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", column " + column.ToString(System.Globalization.CultureInfo.InvariantCulture) + ": " + error);
        }

        bool cellWouldChange = !string.Equals(before, requestedValue, StringComparison.Ordinal);
        if (!blocked && cellWouldChange) wouldChangeCount++;
        planned.Add(CellResult(i, row, column, requestedValue, before, before, readable, cellWouldChange, false, blocked, reason, error));
    }

    if (errors.Count > 0)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells",
            reason = "schedule_cell_preflight_failed",
            error = "One or more requested schedule cells failed preflight.",
            scheduleId = schedule.Id.IntegerValue,
            scheduleName = schedule.Name,
            section = requestedSection,
            rowCount = rowCount,
            columnCount = columnCount,
            committed = false,
            dryRun = dryRun,
            changes = planned.ToArray(),
            errors = errors.ToArray()
        };
    }

    if (dryRun)
    {
        return new {
            success = true,
            guarded = false,
            action = "set_schedule_cells",
            scheduleId = schedule.Id.IntegerValue,
            scheduleName = schedule.Name,
            section = requestedSection,
            rowCount = rowCount,
            columnCount = columnCount,
            committed = false,
            dryRun = true,
            requestedCellCount = rows.Length,
            wouldChangeCount = wouldChangeCount,
            changes = planned.ToArray(),
            warnings = new string[] { "Dry run only. Re-run with mode=commit to write schedule cell text." }
        };
    }

    System.Collections.Generic.List<object> committedChanges = new System.Collections.Generic.List<object>();
    int changedCount = 0;
    int verifiedCount = 0;
    for (int i = 0; i < rows.Length; i++)
    {
        int row = rows[i];
        int column = columns[i];
        string requestedValue = requestedValues[i] ?? "";
        bool readableBefore = false;
        string readError = "";
        string before = ReadCell(schedule, sectionType, row, column, out readableBefore, out readError);
        bool changed = !string.Equals(before, requestedValue, StringComparison.Ordinal);
        string after = before;
        bool verified = !changed;
        string writeError = "";
        try
        {
            if (changed)
            {
                sectionData.SetCellText(row, column, requestedValue);
                changedCount++;
                bool readableAfter = false;
                string afterReadError = "";
                after = ReadCell(schedule, sectionType, row, column, out readableAfter, out afterReadError);
                verified = readableAfter && string.Equals(after, requestedValue, StringComparison.Ordinal);
                if (!verified) writeError = afterReadError;
            }
        }
        catch (Exception ex)
        {
            throw new Exception("Schedule cell write failed at row " + row.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", column " + column.ToString(System.Globalization.CultureInfo.InvariantCulture) + ": " + ex.Message, ex);
        }
        if (!verified)
        {
            throw new Exception("Schedule cell verification failed at row " + row.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", column " + column.ToString(System.Globalization.CultureInfo.InvariantCulture) + ": requested value was not observed after write.");
        }
        if (verified) verifiedCount++;
        committedChanges.Add(CellResult(i, row, column, requestedValue, before, after, readableBefore, changed, verified, !verified, verified ? "" : "verification_failed", writeError));
    }

    bool success = verifiedCount == rows.Length;
    return new {
        success = success,
        guarded = !success,
        state = success ? null : "guarded",
        action = "set_schedule_cells",
        reason = success ? null : "schedule_cell_verification_failed",
        scheduleId = schedule.Id.IntegerValue,
        scheduleName = schedule.Name,
        section = requestedSection,
        rowCount = rowCount,
        columnCount = columnCount,
        committed = true,
        dryRun = false,
        requestedCellCount = rows.Length,
        changedCount = changedCount,
        verifiedCount = verifiedCount,
        changes = committedChanges.ToArray()
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
        action = "set_schedule_cells",
        reason = "set_schedule_cells_exception",
        error = ex.ToString(),
        scheduleId = scheduleId,
        committed = false
    };
}`;
}
export function registerSetScheduleCellsTool(server) {
    server.tool("set_schedule_cells", "[PRODUCTION_SCHEDULE_CELL_WRITE] Writes exact Revit schedule cells by scheduleId, section, row, and column. Defaults to dryRun, blocks mismatched expectedCurrentText, and verifies committed values.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        scheduleId: z.union([z.number(), z.string()]).describe("Exact ViewSchedule element id. Schedule names are not accepted for writes."),
        section: z.enum(["header", "body", "footer"]).describe("Exact schedule section containing the target cells."),
        cells: z.array(z.object({
            row: z.number().int().min(0).describe("Zero-based row index in the selected schedule section."),
            column: z.number().int().min(0).describe("Zero-based column index in the selected schedule section."),
            value: z.string().describe("Target cell text."),
            expectedCurrentText: z.string().optional().describe("Optional exact preflight value. Commit is blocked if current text differs unless allowCurrentMismatch=true."),
        })).min(1).max(200).describe("Exact cells to update. Use inspect_schedules first to discover row/column coordinates."),
        mode: z.enum(["dryRun", "commit"]).optional().describe("Defaults to dryRun. commit writes schedule cell text in one Revit transaction."),
        allowCurrentMismatch: z.boolean().optional().describe("Defaults false. Keep false for production writes so stale row/column targets are blocked."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Socket timeout in milliseconds. Defaults 120000."),
    }, async (args) => {
        try {
            const mode = args.mode === "commit" ? "commit" : "dryRun";
            const response = await executeRevitCode(buildSetScheduleCellsCode(args), {
                ...connectionOptionsFromArgs(args),
                ...taskOptionsFromArgs(args, mode === "commit" ? "Set Revit schedule cells" : "Preview Revit schedule cell changes"),
                toolName: "set_schedule_cells",
                transactionMode: mode === "commit" ? "auto" : "none",
            });
            return formatJsonContent(response && response.result ? response.result : response);
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                guarded: true,
                state: "guarded",
                action: "set_schedule_cells",
                reason: "set_schedule_cells_runtime_error",
                error: error instanceof Error ? error.message : String(error),
                committed: false,
            });
        }
    });
}
