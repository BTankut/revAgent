import { z } from "zod";
import { connectionOptionsFromArgs, connectionTargetSchema, csharpIntArray, csharpString, executeRevitCode, formatJsonContent, taskMetadataSchema, taskOptionsFromArgs, } from "../utils/revitToolHelpers.js";
function buildInspectSheetTextCode(args) {
    const sheetIds = (args.sheetIds || [])
        .map((value) => Number.parseInt(String(value), 10))
        .filter((value) => Number.isFinite(value) && value > 0);
    const sheetQuery = csharpString(args.sheetQuery || args.query || "");
    const textQuery = csharpString(args.textQuery || "");
    const includeTextNotes = args.includeTextNotes === false ? "false" : "true";
    const includeScheduleInstances = args.includeScheduleInstances === false ? "false" : "true";
    const scanScheduleCells = args.scanScheduleCells === true ? "true" : "false";
    const maxSheets = Math.max(1, Math.min(200, Number.parseInt(String(args.maxSheets || 30), 10) || 30));
    const maxTextNotesPerSheet = Math.max(0, Math.min(1000, Number.parseInt(String(args.maxTextNotesPerSheet || 200), 10) || 200));
    const maxScheduleInstancesPerSheet = Math.max(0, Math.min(300, Number.parseInt(String(args.maxScheduleInstancesPerSheet || 100), 10) || 100));
    const maxRowsPerSchedule = Math.max(0, Math.min(500, Number.parseInt(String(args.maxRowsPerSchedule || 80), 10) || 80));
    const maxColumnsPerSchedule = Math.max(0, Math.min(100, Number.parseInt(String(args.maxColumnsPerSchedule || 30), 10) || 30));
    const maxTextChars = Math.max(20, Math.min(1000, Number.parseInt(String(args.maxTextChars || 240), 10) || 240));
    return `
int[] requestedSheetIds = ${csharpIntArray(sheetIds)};
string sheetQuery = ${sheetQuery};
string textQuery = ${textQuery};
bool includeTextNotes = ${includeTextNotes};
bool includeScheduleInstances = ${includeScheduleInstances};
bool scanScheduleCells = ${scanScheduleCells};
int maxSheets = ${maxSheets};
int maxTextNotesPerSheet = ${maxTextNotesPerSheet};
int maxScheduleInstancesPerSheet = ${maxScheduleInstancesPerSheet};
int maxRowsPerSchedule = ${maxRowsPerSchedule};
int maxColumnsPerSchedule = ${maxColumnsPerSchedule};
int maxTextChars = ${maxTextChars};

string TrimText(string value)
{
    if (value == null) return "";
    value = value.Replace("\\r", " ").Replace("\\n", " ").Replace("\\t", " ").Trim();
    if (value.Length <= maxTextChars) return value;
    return value.Substring(0, maxTextChars) + "...";
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

object PointInfo(XYZ point)
{
    if (point == null) return null;
    return new {
        x = Math.Round(point.X, 6),
        y = Math.Round(point.Y, 6),
        z = Math.Round(point.Z, 6)
    };
}

object BoxInfo(BoundingBoxXYZ box)
{
    if (box == null) return null;
    return new {
        min = PointInfo(box.Min),
        max = PointInfo(box.Max)
    };
}

object ScheduleInstancePointInfo(ScheduleSheetInstance instance)
{
    try
    {
        var pointProperty = instance.GetType().GetProperty("Point");
        if (pointProperty == null) return null;
        return PointInfo(pointProperty.GetValue(instance, null) as XYZ);
    }
    catch
    {
        return null;
    }
}

bool IsRevisionScheduleInstance(ScheduleSheetInstance instance)
{
    try
    {
        var revisionProperty = instance.GetType().GetProperty("IsTitleblockRevisionSchedule");
        if (revisionProperty == null) return false;
        object value = revisionProperty.GetValue(instance, null);
        return value is bool && (bool)value;
    }
    catch
    {
        return false;
    }
}

string ReadScheduleCell(ViewSchedule schedule, SectionType sectionType, int row, int column)
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

object ScanPlacedSchedule(ViewSchedule schedule)
{
    System.Collections.Generic.List<object> matches = new System.Collections.Generic.List<object>();
    int scannedRows = 0;
    int scannedColumns = 0;
    bool truncated = false;
    bool readFailed = false;
    string readError = "";

    try
    {
        TableSectionData section = schedule.GetTableData().GetSectionData(SectionType.Body);
        int rowLimit = Math.Min(section.NumberOfRows, maxRowsPerSchedule);
        int columnLimit = Math.Min(section.NumberOfColumns, maxColumnsPerSchedule);
        scannedRows = rowLimit;
        scannedColumns = columnLimit;
        truncated = section.NumberOfRows > rowLimit || section.NumberOfColumns > columnLimit;

        for (int row = 0; row < rowLimit; row++)
        {
            for (int column = 0; column < columnLimit; column++)
            {
                string text = ReadScheduleCell(schedule, SectionType.Body, row, column);
                if (!string.IsNullOrWhiteSpace(textQuery) && ContainsNormalized(text, textQuery))
                {
                    matches.Add(new {
                        section = "body",
                        row = row,
                        column = column,
                        text = TrimText(text)
                    });
                }
            }
        }
    }
    catch (Exception ex)
    {
        readFailed = true;
        readError = ex.Message;
    }

    return new {
        scannedRows = scannedRows,
        scannedColumns = scannedColumns,
        truncated = truncated,
        matchCount = matches.Count,
        matches = matches.ToArray(),
        readFailed = readFailed,
        readError = readError
    };
}

try
{
    System.Collections.Generic.List<string> warnings = new System.Collections.Generic.List<string>();
    System.Collections.Generic.List<ViewSheet> sourceSheets = new System.Collections.Generic.List<ViewSheet>();
    System.Collections.Generic.HashSet<int> requestedIds = new System.Collections.Generic.HashSet<int>();
    foreach (int id in requestedSheetIds)
    {
        requestedIds.Add(id);
        ViewSheet sheet = document.GetElement(new ElementId(id)) as ViewSheet;
        if (sheet != null && !sheet.IsTemplate)
        {
            sourceSheets.Add(sheet);
        }
        else
        {
            warnings.Add("Sheet not found or is a template: " + id.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
    }

    bool hasExplicitIds = requestedIds.Count > 0;
    if (!hasExplicitIds)
    {
        FilteredElementCollector collector = new FilteredElementCollector(document)
            .OfClass(typeof(ViewSheet));
        foreach (Element element in collector)
        {
            ViewSheet sheet = element as ViewSheet;
            if (sheet == null || sheet.IsTemplate) continue;
            sourceSheets.Add(sheet);
        }
    }

    bool hasSheetQuery = !string.IsNullOrWhiteSpace(sheetQuery);
    bool hasTextQuery = !string.IsNullOrWhiteSpace(textQuery);
    System.Collections.Generic.List<object> sheets = new System.Collections.Generic.List<object>();
    int candidateCount = 0;
    int totalTextNoteMatches = 0;
    int totalScheduleCellMatches = 0;
    bool truncated = false;

    foreach (ViewSheet sheet in sourceSheets.OrderBy(s => s.SheetNumber).ThenBy(s => s.Name))
    {
        string sheetLabel = ((sheet.SheetNumber ?? "") + " " + (sheet.Name ?? "")).Trim();
        bool sheetMatches = !hasSheetQuery || ContainsNormalized(sheetLabel, sheetQuery);
        if (!hasExplicitIds && hasSheetQuery && !sheetMatches)
        {
            continue;
        }

        candidateCount++;
        if (!hasExplicitIds && candidateCount > maxSheets)
        {
            truncated = true;
            break;
        }

        System.Collections.Generic.List<object> textNotes = new System.Collections.Generic.List<object>();
        int textNoteCount = 0;
        int textNoteReturned = 0;
        bool textNotesTruncated = false;
        if (includeTextNotes)
        {
            FilteredElementCollector textCollector = new FilteredElementCollector(document, sheet.Id)
                .OfClass(typeof(TextNote));
            foreach (Element textElement in textCollector)
            {
                TextNote textNote = textElement as TextNote;
                if (textNote == null) continue;
                textNoteCount++;
                string text = textNote.Text ?? "";
                bool textMatches = !hasTextQuery || ContainsNormalized(text, textQuery);
                if (!textMatches) continue;
                if (textNoteReturned >= maxTextNotesPerSheet)
                {
                    textNotesTruncated = true;
                    continue;
                }
                totalTextNoteMatches++;
                textNoteReturned++;
                textNotes.Add(new {
                    id = textNote.Id.IntegerValue,
                    uniqueId = textNote.UniqueId,
                    text = TrimText(text),
                    point = PointInfo(textNote.Coord),
                    box = BoxInfo(textNote.get_BoundingBox(sheet))
                });
            }
        }

        System.Collections.Generic.List<object> schedules = new System.Collections.Generic.List<object>();
        int scheduleInstanceCount = 0;
        int scheduleInstanceReturned = 0;
        bool scheduleInstancesTruncated = false;
        if (includeScheduleInstances)
        {
            FilteredElementCollector scheduleCollector = new FilteredElementCollector(document, sheet.Id)
                .OfClass(typeof(ScheduleSheetInstance));
            foreach (Element scheduleElement in scheduleCollector)
            {
                ScheduleSheetInstance instance = scheduleElement as ScheduleSheetInstance;
                if (instance == null) continue;
                scheduleInstanceCount++;
                if (scheduleInstanceReturned >= maxScheduleInstancesPerSheet)
                {
                    scheduleInstancesTruncated = true;
                    continue;
                }
                ViewSchedule schedule = document.GetElement(instance.ScheduleId) as ViewSchedule;
                object scan = null;
                int scheduleCellMatchCount = 0;
                if (scanScheduleCells && schedule != null)
                {
                    scan = ScanPlacedSchedule(schedule);
                    var matchCountProperty = scan.GetType().GetProperty("matchCount");
                    if (matchCountProperty != null)
                    {
                        object matchValue = matchCountProperty.GetValue(scan, null);
                        if (matchValue is int) scheduleCellMatchCount = (int)matchValue;
                    }
                    totalScheduleCellMatches += scheduleCellMatchCount;
                }
                bool includeSchedule = !hasTextQuery || !scanScheduleCells || scheduleCellMatchCount > 0;
                if (!includeSchedule) continue;
                scheduleInstanceReturned++;
                schedules.Add(new {
                    instanceId = instance.Id.IntegerValue,
                    uniqueId = instance.UniqueId,
                    scheduleId = instance.ScheduleId.IntegerValue,
                    scheduleName = schedule != null ? schedule.Name : "",
                    isTitleblockRevisionSchedule = IsRevisionScheduleInstance(instance),
                    point = ScheduleInstancePointInfo(instance),
                    box = BoxInfo(instance.get_BoundingBox(sheet)),
                    cellScan = scan
                });
            }
        }

        bool includeSheet = hasExplicitIds || sheetMatches || textNotes.Count > 0 || schedules.Count > 0 || !hasTextQuery;
        if (!includeSheet) continue;
        sheets.Add(new {
            id = sheet.Id.IntegerValue,
            uniqueId = sheet.UniqueId,
            sheetNumber = sheet.SheetNumber,
            name = sheet.Name,
            matchedSheetQuery = sheetMatches,
            textNoteCount = textNoteCount,
            textNoteReturned = textNoteReturned,
            textNotesTruncated = textNotesTruncated,
            textNotes = textNotes.ToArray(),
            scheduleInstanceCount = scheduleInstanceCount,
            scheduleInstanceReturned = scheduleInstanceReturned,
            scheduleInstancesTruncated = scheduleInstancesTruncated,
            scheduleInstances = schedules.ToArray()
        });
    }

    if (hasTextQuery && includeScheduleInstances && !scanScheduleCells)
    {
        warnings.Add("Schedule instances are listed but schedule cells are not scanned. Set scanScheduleCells=true when the text may be inside placed schedules.");
    }

    return new {
        success = true,
        action = "inspect_sheet_text",
        sheetQuery = sheetQuery,
        textQuery = textQuery,
        totalSheets = sourceSheets.Count,
        candidateCount = candidateCount,
        returnedCount = sheets.Count,
        truncated = truncated,
        maxSheets = maxSheets,
        scan = new {
            includeTextNotes = includeTextNotes,
            includeScheduleInstances = includeScheduleInstances,
            scanScheduleCells = scanScheduleCells,
            maxTextNotesPerSheet = maxTextNotesPerSheet,
            maxScheduleInstancesPerSheet = maxScheduleInstancesPerSheet,
            maxRowsPerSchedule = maxRowsPerSchedule,
            maxColumnsPerSchedule = maxColumnsPerSchedule,
            totalTextNoteMatches = totalTextNoteMatches,
            totalScheduleCellMatches = totalScheduleCellMatches
        },
        sheets = sheets.ToArray(),
        warnings = warnings.ToArray()
    };
}
catch (Exception ex)
{
    return new {
        success = false,
        action = "inspect_sheet_text",
        error = ex.ToString()
    };
}`;
}
export function registerInspectSheetTextTool(server) {
    server.tool("inspect_sheet_text", "[SHEET_TEXT_INSPECTION_READ_ONLY] Read-only bounded search of DrawingSheet text notes and placed schedule instances. Prefer this over generic send_code_to_revit for sheet text searches in large projects. Use sheetQuery/sheetIds first; project-wide text or placed-schedule cell scans require allowExpensiveSearch=true.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        query: z.string().optional().describe("Alias for sheetQuery. Matches sheet number and sheet name with Turkish/diacritic/Cyrillic-U normalization."),
        sheetQuery: z.string().optional().describe("Sheet number/name filter. Use this first in large projects before broad text search."),
        textQuery: z.string().optional().describe("Optional text to search in sheet text notes. Set scanScheduleCells=true when the text may be inside placed schedules."),
        sheetIds: z.array(z.union([z.number(), z.string()])).optional().describe("Exact ViewSheet element ids to inspect. Preferred when known."),
        includeTextNotes: z.boolean().optional().describe("Include bounded sheet TextNote results. Defaults true."),
        includeScheduleInstances: z.boolean().optional().describe("Include placed ScheduleSheetInstance entries on matching sheets. Defaults true."),
        scanScheduleCells: z.boolean().optional().describe("When true, search bounded body cells of placed schedules for textQuery. Defaults false to avoid broad scans."),
        allowExpensiveSearch: z.boolean().optional().describe("Explicit approval for project-wide sheet text or placed-schedule cell scans without sheetIds/sheetQuery. Defaults false."),
        maxSheets: z.number().int().positive().max(200).optional().describe("Maximum sheets to inspect/return. Defaults 30."),
        maxTextNotesPerSheet: z.number().int().min(0).max(1000).optional().describe("Maximum matching text notes returned per sheet. Defaults 200."),
        maxScheduleInstancesPerSheet: z.number().int().min(0).max(300).optional().describe("Maximum schedule instances returned per sheet. Defaults 100."),
        maxRowsPerSchedule: z.number().int().min(0).max(500).optional().describe("Maximum schedule body rows to scan when scanScheduleCells=true. Defaults 80."),
        maxColumnsPerSchedule: z.number().int().min(0).max(100).optional().describe("Maximum schedule body columns to scan when scanScheduleCells=true. Defaults 30."),
        maxTextChars: z.number().int().min(20).max(1000).optional().describe("Maximum characters retained per returned text value. Defaults 240."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Socket timeout in milliseconds. Defaults 120000."),
    }, async (args) => {
        try {
            const hasSheetScope = Boolean((Array.isArray(args.sheetIds) && args.sheetIds.length > 0) ||
                String(args.sheetQuery || args.query || "").trim());
            const hasTextQuery = Boolean(String(args.textQuery || "").trim());
            const wantsBroadTextSearch = hasTextQuery && !hasSheetScope;
            const wantsScheduleCellScan = args.scanScheduleCells === true;
            if ((wantsBroadTextSearch || wantsScheduleCellScan) && !hasSheetScope && args.allowExpensiveSearch !== true) {
                return formatJsonContent({
                    success: true,
                    guarded: true,
                    state: "guarded",
                    action: "inspect_sheet_text",
                    reason: "needs_scope",
                    message: "Project-wide sheet text or placed schedule cell scanning can be expensive in large models. First pass sheetQuery/sheetIds, or set allowExpensiveSearch=true.",
                    suggestedNextScopes: ["sheetQuery", "sheetIds", "maxSheets", "scanScheduleCells=false", "allowExpensiveSearch"],
                    scanPolicy: {
                        allowExpensiveSearch: false,
                        textQuery: hasTextQuery,
                        scanScheduleCells: wantsScheduleCellScan,
                    },
                });
            }
            const response = await executeRevitCode(buildInspectSheetTextCode(args), {
                ...connectionOptionsFromArgs(args),
                ...taskOptionsFromArgs(args, "Inspect Revit sheet text"),
                toolName: "inspect_sheet_text",
                transactionMode: "none",
            });
            return formatJsonContent(response && response.result ? response.result : response);
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                action: "inspect_sheet_text",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
