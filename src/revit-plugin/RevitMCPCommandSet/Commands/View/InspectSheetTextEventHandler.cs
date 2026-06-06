using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Threading;

namespace RevitMCPCommandSet.Commands.View
{
    public class InspectSheetTextRequest
    {
        public string Query { get; set; }
        public string SheetQuery { get; set; }
        public string TextQuery { get; set; }
        public List<int> SheetIds { get; set; }
        public bool IncludeTextNotes { get; set; }
        public bool IncludeScheduleInstances { get; set; }
        public bool ScanScheduleCells { get; set; }
        public bool AllowExpensiveSearch { get; set; }
        public string SearchBudget { get; set; }
        public int MaxElapsedMs { get; set; }
        public bool IncludeViewportTextNotes { get; set; }
        public bool IncludeViewportTags { get; set; }
        public string ViewNameQuery { get; set; }
        public int MaxSheets { get; set; }
        public int MaxTextNotesPerSheet { get; set; }
        public int MaxScheduleInstancesPerSheet { get; set; }
        public int MaxRowsPerSchedule { get; set; }
        public int MaxColumnsPerSchedule { get; set; }
        public int MaxTextChars { get; set; }
        public int MaxViewportsPerSheet { get; set; }
        public int MaxViewportTextNotesPerView { get; set; }
        public int MaxViewportTagsPerView { get; set; }
        public int MaxTextNotesScanned { get; set; }
        public int MaxTagsScanned { get; set; }
        public int MaxScheduleInstancesScanned { get; set; }
        public int MaxScheduleCellsScanned { get; set; }
        public int MaxResponseBytes { get; set; }
        public int TimeoutMs { get; set; }
    }

    public class InspectSheetTextResult
    {
        public bool Success { get; set; }
        public bool Guarded { get; set; }
        public string State { get; set; }
        public string Action { get; set; }
        public string Reason { get; set; }
        public string Message { get; set; }
        public string Error { get; set; }
        public string SheetQuery { get; set; }
        public string TextQuery { get; set; }
        public int TotalSheets { get; set; }
        public int CandidateCount { get; set; }
        public int ReturnedCount { get; set; }
        public bool Truncated { get; set; }
        public int MaxSheets { get; set; }
        public bool Partial { get; set; }
        public string ScanStoppedReason { get; set; }
        public object ScanPolicy { get; set; }
        public List<string> SuggestedNextScopes { get; set; }
        public int ScannedSheetCount { get; set; }
        public int ScannedViewportCount { get; set; }
        public int ScannedTextNoteCount { get; set; }
        public int ScannedTagCount { get; set; }
        public int ScannedScheduleInstanceCount { get; set; }
        public int ScannedScheduleCellCount { get; set; }
        public int EstimatedResponseBytes { get; set; }
        public int MaxResponseBytes { get; set; }
        public object Scan { get; set; }
        public List<InspectSheetTextSheetResult> Sheets { get; set; }
        public List<Dictionary<string, object>> Matches { get; set; }
        public List<string> Warnings { get; set; }
        public List<string> Notices { get; set; }
    }

    public class InspectSheetTextSheetResult
    {
        public int Id { get; set; }
        public string UniqueId { get; set; }
        public string SheetNumber { get; set; }
        public string Name { get; set; }
        public bool MatchedSheetQuery { get; set; }
        public int TextNoteCount { get; set; }
        public int TextNoteReturned { get; set; }
        public bool TextNotesTruncated { get; set; }
        public List<Dictionary<string, object>> TextNotes { get; set; }
        public int ScheduleInstanceCount { get; set; }
        public int ScheduleInstanceReturned { get; set; }
        public bool ScheduleInstancesTruncated { get; set; }
        public List<Dictionary<string, object>> ScheduleInstances { get; set; }
        public int ViewportCount { get; set; }
        public int ViewportReturned { get; set; }
        public bool ViewportsTruncated { get; set; }
        public List<Dictionary<string, object>> Viewports { get; set; }
    }

    internal class SheetAnnotationScanState
    {
        public bool Partial;
        public string ScanStoppedReason = "";
        public int ScannedSheetCount;
        public int ScannedViewportCount;
        public int ScannedTextNoteCount;
        public int ScannedTagCount;
        public int ScannedScheduleInstanceCount;
        public int ScannedScheduleCellCount;
        public int EstimatedResponseBytes = 2048;
        public int TotalTextNoteMatches;
        public int TotalViewportTextNoteMatches;
        public int TotalViewportTagMatches;
        public int TotalScheduleCellMatches;
        public int TotalScheduleInstanceMatches;

        public void Stop(string reason)
        {
            if (!Partial)
            {
                Partial = true;
                ScanStoppedReason = reason;
            }
        }
    }

    public class InspectSheetTextEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private InspectSheetTextRequest _request;

        public InspectSheetTextResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetRequest(InspectSheetTextRequest request)
        {
            _request = request ?? new InspectSheetTextRequest();
            TaskCompleted = false;
            ResultInfo = null;
            _resetEvent.Reset();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            SheetAnnotationScanState state = new SheetAnnotationScanState();
            List<string> warnings = new List<string>();
            List<string> notices = new List<string>();
            DateTime deadlineUtc = DateTime.UtcNow.AddMilliseconds(_request.MaxElapsedMs);

            try
            {
                UIDocument uiDocument = app.ActiveUIDocument;
                Document document = uiDocument.Document;

                if (ShouldGuardNeedsScope())
                {
                    Complete(BuildGuardedResult(
                        "needs_scope",
                        "Project-wide sheet annotation, viewport text, tag, or placed schedule-cell scans can be expensive. Pass sheetQuery/sheetIds or set allowExpensiveSearch=true with bounded caps.",
                        state,
                        warnings,
                        notices));
                    return;
                }

                List<ViewSheet> sourceSheets = ResolveSourceSheets(document, warnings, deadlineUtc, state);
                if (state.Partial)
                {
                    Complete(BuildCompletedResult(sourceSheets.Count, 0, new List<InspectSheetTextSheetResult>(), new List<Dictionary<string, object>>(), state, warnings, notices));
                    return;
                }

                bool hasSheetQuery = !string.IsNullOrWhiteSpace(_request.SheetQuery);
                bool hasTextQuery = !string.IsNullOrWhiteSpace(_request.TextQuery);
                bool hasExplicitIds = _request.SheetIds != null && _request.SheetIds.Count > 0;
                int candidateCount = 0;
                List<InspectSheetTextSheetResult> sheets = new List<InspectSheetTextSheetResult>();
                List<Dictionary<string, object>> matches = new List<Dictionary<string, object>>();

                foreach (ViewSheet sheet in sourceSheets.OrderBy(s => s.SheetNumber).ThenBy(s => s.Name))
                {
                    if (StopIfNeeded(deadlineUtc, state)) break;

                    string sheetLabel = ((sheet.SheetNumber ?? "") + " " + (sheet.Name ?? "")).Trim();
                    bool sheetMatches = !hasSheetQuery || ContainsNormalized(sheetLabel, _request.SheetQuery);
                    if (!hasExplicitIds && hasSheetQuery && !sheetMatches)
                    {
                        continue;
                    }

                    candidateCount++;
                    if (!hasExplicitIds && candidateCount > _request.MaxSheets)
                    {
                        state.Stop("max_sheets");
                        break;
                    }

                    state.ScannedSheetCount++;
                    InspectSheetTextSheetResult sheetResult = ScanSheet(document, sheet, sheetMatches, hasTextQuery, deadlineUtc, state, warnings, matches);
                    if (sheetResult == null)
                    {
                        break;
                    }

                    bool includeSheet = hasExplicitIds || sheetMatches || sheetResult.TextNotes.Count > 0 ||
                        sheetResult.ScheduleInstances.Count > 0 || HasViewportEvidence(sheetResult) || !hasTextQuery;
                    if (includeSheet)
                    {
                        sheets.Add(sheetResult);
                    }
                }

                Complete(BuildCompletedResult(sourceSheets.Count, candidateCount, sheets, matches, state, warnings, notices));
            }
            catch (Exception ex)
            {
                Complete(new InspectSheetTextResult
                {
                    Success = false,
                    Guarded = false,
                    State = "failed",
                    Action = "inspect_sheet_text",
                    Error = ex.Message,
                    SheetQuery = _request.SheetQuery,
                    TextQuery = _request.TextQuery,
                    ScanPolicy = BuildScanPolicy(),
                    Partial = state.Partial,
                    ScanStoppedReason = state.ScanStoppedReason,
                    ScannedSheetCount = state.ScannedSheetCount,
                    ScannedViewportCount = state.ScannedViewportCount,
                    ScannedTextNoteCount = state.ScannedTextNoteCount,
                    ScannedTagCount = state.ScannedTagCount,
                    ScannedScheduleInstanceCount = state.ScannedScheduleInstanceCount,
                    ScannedScheduleCellCount = state.ScannedScheduleCellCount,
                    EstimatedResponseBytes = state.EstimatedResponseBytes,
                    MaxResponseBytes = _request.MaxResponseBytes,
                    SuggestedNextScopes = BuildSuggestedNextScopes(),
                    Warnings = warnings,
                    Notices = notices,
                    Sheets = new List<InspectSheetTextSheetResult>(),
                    Matches = new List<Dictionary<string, object>>()
                });
            }
        }

        private InspectSheetTextSheetResult ScanSheet(
            Document document,
            ViewSheet sheet,
            bool sheetMatches,
            bool hasTextQuery,
            DateTime deadlineUtc,
            SheetAnnotationScanState state,
            List<string> warnings,
            List<Dictionary<string, object>> flatMatches)
        {
            InspectSheetTextSheetResult result = new InspectSheetTextSheetResult
            {
                Id = sheet.Id.GetIdValue(),
                UniqueId = sheet.UniqueId,
                SheetNumber = sheet.SheetNumber,
                Name = sheet.Name,
                MatchedSheetQuery = sheetMatches,
                TextNotes = new List<Dictionary<string, object>>(),
                ScheduleInstances = new List<Dictionary<string, object>>(),
                Viewports = new List<Dictionary<string, object>>()
            };

            if (_request.IncludeTextNotes)
            {
                ScanSheetTextNotes(document, sheet, result, deadlineUtc, state, flatMatches);
                if (state.Partial && IsHardStop(state.ScanStoppedReason)) return result;
            }

            if (_request.IncludeScheduleInstances)
            {
                ScanScheduleInstances(document, sheet, result, hasTextQuery, deadlineUtc, state, warnings, flatMatches);
                if (state.Partial && IsHardStop(state.ScanStoppedReason)) return result;
            }

            if (_request.IncludeViewportTextNotes || _request.IncludeViewportTags)
            {
                ScanViewports(document, sheet, result, deadlineUtc, state, warnings, flatMatches);
            }

            return result;
        }

        private void ScanSheetTextNotes(
            Document document,
            ViewSheet sheet,
            InspectSheetTextSheetResult result,
            DateTime deadlineUtc,
            SheetAnnotationScanState state,
            List<Dictionary<string, object>> flatMatches)
        {
            if (state.ScannedTextNoteCount >= _request.MaxTextNotesScanned)
            {
                state.Stop("max_text_notes");
                return;
            }

            int returned = 0;
            using (FilteredElementCollector collector = new FilteredElementCollector(document, sheet.Id))
            {
                foreach (Element element in collector.OfClass(typeof(TextNote)).WhereElementIsNotElementType())
                {
                    if (StopIfNeeded(deadlineUtc, state)) return;
                    if (state.ScannedTextNoteCount >= _request.MaxTextNotesScanned)
                    {
                        state.Stop("max_text_notes");
                        return;
                    }

                    TextNote textNote = element as TextNote;
                    if (textNote == null) continue;

                    state.ScannedTextNoteCount++;
                    result.TextNoteCount++;
                    string text = SafeText(textNote);
                    if (!ContainsNormalized(text, _request.TextQuery)) continue;

                    if (returned >= _request.MaxTextNotesPerSheet)
                    {
                        result.TextNotesTruncated = true;
                        state.Stop("max_text_notes");
                        continue;
                    }

                    Dictionary<string, object> record = BuildTextNoteRecord(
                        "sheetTextNote",
                        sheet,
                        null,
                        null,
                        textNote,
                        text,
                        textNote.get_BoundingBox(sheet));
                    if (!AddRecordIfWithinResponseBudget(record, state)) return;

                    returned++;
                    state.TotalTextNoteMatches++;
                    result.TextNoteReturned = returned;
                    result.TextNotes.Add(record);
                    flatMatches.Add(CloneRecord(record));
                }
            }
        }

        private void ScanScheduleInstances(
            Document document,
            ViewSheet sheet,
            InspectSheetTextSheetResult result,
            bool hasTextQuery,
            DateTime deadlineUtc,
            SheetAnnotationScanState state,
            List<string> warnings,
            List<Dictionary<string, object>> flatMatches)
        {
            if (state.ScannedScheduleInstanceCount >= _request.MaxScheduleInstancesScanned)
            {
                state.Stop("max_scanned");
                return;
            }

            int returned = 0;
            using (FilteredElementCollector collector = new FilteredElementCollector(document, sheet.Id))
            {
                foreach (Element element in collector.OfClass(typeof(ScheduleSheetInstance)).WhereElementIsNotElementType())
                {
                    if (StopIfNeeded(deadlineUtc, state)) return;
                    if (state.ScannedScheduleInstanceCount >= _request.MaxScheduleInstancesScanned)
                    {
                        state.Stop("max_scanned");
                        return;
                    }

                    ScheduleSheetInstance instance = element as ScheduleSheetInstance;
                    if (instance == null) continue;
                    state.ScannedScheduleInstanceCount++;
                    result.ScheduleInstanceCount++;

                    if (returned >= _request.MaxScheduleInstancesPerSheet)
                    {
                        result.ScheduleInstancesTruncated = true;
                        state.Stop("max_scanned");
                        continue;
                    }

                    ViewSchedule schedule = document.GetElement(instance.ScheduleId) as ViewSchedule;
                    Dictionary<string, object> cellScan = null;
                    int scheduleCellMatchCount = 0;
                    if (_request.ScanScheduleCells && schedule != null)
                    {
                        cellScan = ScanScheduleCells(schedule, sheet, instance, deadlineUtc, state, flatMatches);
                        if (cellScan.ContainsKey("matchCount"))
                        {
                            scheduleCellMatchCount = Convert.ToInt32(cellScan["matchCount"], CultureInfo.InvariantCulture);
                        }
                    }

                    bool includeSchedule = !hasTextQuery || !_request.ScanScheduleCells || scheduleCellMatchCount > 0;
                    if (!includeSchedule) continue;

                    Dictionary<string, object> record = BuildScheduleInstanceRecord(sheet, instance, schedule, cellScan);
                    if (!AddRecordIfWithinResponseBudget(record, state)) return;

                    returned++;
                    state.TotalScheduleInstanceMatches++;
                    result.ScheduleInstanceReturned = returned;
                    result.ScheduleInstances.Add(record);

                    Dictionary<string, object> flat = CloneRecord(record);
                    flat["kind"] = "scheduleInstance";
                    flatMatches.Add(flat);
                }
            }
        }

        private Dictionary<string, object> ScanScheduleCells(
            ViewSchedule schedule,
            ViewSheet sheet,
            ScheduleSheetInstance instance,
            DateTime deadlineUtc,
            SheetAnnotationScanState state,
            List<Dictionary<string, object>> flatMatches)
        {
            List<Dictionary<string, object>> matches = new List<Dictionary<string, object>>();
            int scannedRows = 0;
            int scannedColumns = 0;
            bool truncated = false;
            bool readFailed = false;
            string readError = "";

            if (state.ScannedScheduleCellCount >= _request.MaxScheduleCellsScanned)
            {
                state.Stop("max_schedule_cells");
                return BuildScheduleCellScan(0, 0, true, matches, readFailed, readError);
            }

            try
            {
                TableData tableData = schedule.GetTableData();
                TableSectionData section = tableData != null ? tableData.GetSectionData(SectionType.Body) : null;
                if (section == null)
                {
                    readFailed = true;
                    readError = "Schedule body section data is not available.";
                    return BuildScheduleCellScan(0, 0, false, matches, readFailed, readError);
                }

                int rowLimit = Math.Min(section.NumberOfRows, _request.MaxRowsPerSchedule);
                int columnLimit = Math.Min(section.NumberOfColumns, _request.MaxColumnsPerSchedule);
                scannedRows = rowLimit;
                scannedColumns = columnLimit;
                truncated = section.NumberOfRows > rowLimit || section.NumberOfColumns > columnLimit;

                for (int row = 0; row < rowLimit; row++)
                {
                    for (int column = 0; column < columnLimit; column++)
                    {
                        if (StopIfNeeded(deadlineUtc, state))
                        {
                            truncated = true;
                            return BuildScheduleCellScan(scannedRows, scannedColumns, truncated, matches, readFailed, readError);
                        }
                        if (state.ScannedScheduleCellCount >= _request.MaxScheduleCellsScanned)
                        {
                            state.Stop("max_schedule_cells");
                            truncated = true;
                            return BuildScheduleCellScan(scannedRows, scannedColumns, truncated, matches, readFailed, readError);
                        }

                        state.ScannedScheduleCellCount++;
                        string text = ReadScheduleCell(schedule, SectionType.Body, row, column);
                        if (!string.IsNullOrWhiteSpace(_request.TextQuery) && ContainsNormalized(text, _request.TextQuery))
                        {
                            Dictionary<string, object> cell = new Dictionary<string, object>();
                            cell["section"] = "body";
                            cell["row"] = row;
                            cell["column"] = column;
                            cell["text"] = TrimText(text);
                            if (!AddRecordIfWithinResponseBudget(cell, state))
                            {
                                truncated = true;
                                return BuildScheduleCellScan(scannedRows, scannedColumns, truncated, matches, readFailed, readError);
                            }

                            matches.Add(cell);
                            state.TotalScheduleCellMatches++;

                            Dictionary<string, object> flat = new Dictionary<string, object>();
                            flat["kind"] = "scheduleCell";
                            flat["sheetId"] = sheet.Id.GetIdValue();
                            flat["sheetNumber"] = sheet.SheetNumber;
                            flat["sheetName"] = sheet.Name;
                            flat["scheduleInstanceId"] = instance.Id.GetIdValue();
                            flat["scheduleId"] = schedule.Id.GetIdValue();
                            flat["scheduleName"] = schedule.Name;
                            flat["section"] = "body";
                            flat["row"] = row;
                            flat["column"] = column;
                            flat["text"] = TrimText(text);
                            flat["textNormalized"] = NormalizeForSearch(text);
                            flatMatches.Add(flat);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                readFailed = true;
                readError = ex.Message;
            }

            return BuildScheduleCellScan(scannedRows, scannedColumns, truncated, matches, readFailed, readError);
        }

        private void ScanViewports(
            Document document,
            ViewSheet sheet,
            InspectSheetTextSheetResult result,
            DateTime deadlineUtc,
            SheetAnnotationScanState state,
            List<string> warnings,
            List<Dictionary<string, object>> flatMatches)
        {
            ICollection<ElementId> viewportIds = sheet.GetAllViewports();
            int considered = 0;
            foreach (ElementId viewportId in viewportIds)
            {
                if (StopIfNeeded(deadlineUtc, state)) return;
                if (considered >= _request.MaxViewportsPerSheet)
                {
                    result.ViewportsTruncated = true;
                    state.Stop("max_viewports");
                    return;
                }

                Viewport viewport = document.GetElement(viewportId) as Viewport;
                if (viewport == null) continue;
                considered++;
                state.ScannedViewportCount++;
                result.ViewportCount++;

                Autodesk.Revit.DB.View view = document.GetElement(viewport.ViewId) as Autodesk.Revit.DB.View;
                if (view == null)
                {
                    warnings.Add("Viewport view not found on sheet " + sheet.SheetNumber + ": " + viewport.Id.GetIdValue().ToString(CultureInfo.InvariantCulture));
                    continue;
                }
                if (!string.IsNullOrWhiteSpace(_request.ViewNameQuery) && !ContainsNormalized(view.Name, _request.ViewNameQuery))
                {
                    continue;
                }

                try
                {
                    Dictionary<string, object> viewportRecord = BuildViewportRecord(sheet, viewport, view);
                    if (!AddRecordIfWithinResponseBudget(viewportRecord, state)) return;

                    List<Dictionary<string, object>> textNotes = new List<Dictionary<string, object>>();
                    List<Dictionary<string, object>> tags = new List<Dictionary<string, object>>();
                    int textNoteCount = 0;
                    int textNoteReturned = 0;
                    int tagCount = 0;
                    int tagReturned = 0;
                    bool textNotesTruncated = false;
                    bool tagsTruncated = false;

                    if (!CanIterateViewElements(document, view, warnings, sheet, viewport))
                    {
                        if (_request.IncludeViewportTextNotes)
                        {
                            viewportRecord["textNoteScanSkipped"] = true;
                            viewportRecord["textNoteScanSkippedReason"] = "view_not_valid_for_element_iteration";
                        }
                        if (_request.IncludeViewportTags)
                        {
                            viewportRecord["tagScanSkipped"] = true;
                            viewportRecord["tagScanSkippedReason"] = "view_not_valid_for_element_iteration";
                        }
                        viewportRecord["textNoteCount"] = 0;
                        viewportRecord["textNoteReturned"] = 0;
                        viewportRecord["textNotesTruncated"] = false;
                        viewportRecord["textNotes"] = textNotes;
                        viewportRecord["tagCount"] = 0;
                        viewportRecord["tagReturned"] = 0;
                        viewportRecord["tagsTruncated"] = false;
                        viewportRecord["tags"] = tags;
                        result.Viewports.Add(viewportRecord);
                        result.ViewportReturned = result.Viewports.Count;
                        continue;
                    }

                    if (_request.IncludeViewportTextNotes)
                    {
                        ScanViewportTextNotes(document, sheet, viewport, view, deadlineUtc, state, flatMatches, textNotes, out textNoteCount, out textNoteReturned, out textNotesTruncated);
                        if (state.Partial && IsHardStop(state.ScanStoppedReason)) return;
                    }

                    if (_request.IncludeViewportTags)
                    {
                        ScanViewportTags(document, sheet, viewport, view, deadlineUtc, state, warnings, flatMatches, tags, out tagCount, out tagReturned, out tagsTruncated);
                        if (state.Partial && IsHardStop(state.ScanStoppedReason)) return;
                    }

                    viewportRecord["textNoteCount"] = textNoteCount;
                    viewportRecord["textNoteReturned"] = textNoteReturned;
                    viewportRecord["textNotesTruncated"] = textNotesTruncated;
                    viewportRecord["textNotes"] = textNotes;
                    viewportRecord["tagCount"] = tagCount;
                    viewportRecord["tagReturned"] = tagReturned;
                    viewportRecord["tagsTruncated"] = tagsTruncated;
                    viewportRecord["tags"] = tags;
                    result.Viewports.Add(viewportRecord);
                    result.ViewportReturned = result.Viewports.Count;
                }
                catch (Exception ex)
                {
                    warnings.Add("Failed to scan viewport " + viewport.Id.GetIdValue().ToString(CultureInfo.InvariantCulture) + " (view " + view.Id.GetIdValue().ToString(CultureInfo.InvariantCulture) + ") on sheet " + sheet.SheetNumber + ": " + ex.Message);
                }
            }
        }

        private void ScanViewportTextNotes(
            Document document,
            ViewSheet sheet,
            Viewport viewport,
            Autodesk.Revit.DB.View view,
            DateTime deadlineUtc,
            SheetAnnotationScanState state,
            List<Dictionary<string, object>> flatMatches,
            List<Dictionary<string, object>> textNotes,
            out int textNoteCount,
            out int textNoteReturned,
            out bool textNotesTruncated)
        {
            textNoteCount = 0;
            textNoteReturned = 0;
            textNotesTruncated = false;

            if (state.ScannedTextNoteCount >= _request.MaxTextNotesScanned)
            {
                state.Stop("max_text_notes");
                return;
            }

            using (FilteredElementCollector collector = new FilteredElementCollector(document, view.Id))
            {
                foreach (Element element in collector.OfClass(typeof(TextNote)).WhereElementIsNotElementType())
                {
                    if (StopIfNeeded(deadlineUtc, state)) return;
                    if (state.ScannedTextNoteCount >= _request.MaxTextNotesScanned)
                    {
                        state.Stop("max_text_notes");
                        return;
                    }

                    TextNote textNote = element as TextNote;
                    if (textNote == null) continue;
                    state.ScannedTextNoteCount++;
                    textNoteCount++;
                    string text = SafeText(textNote);
                    if (!ContainsNormalized(text, _request.TextQuery)) continue;
                    if (textNoteReturned >= _request.MaxViewportTextNotesPerView)
                    {
                        textNotesTruncated = true;
                        state.Stop("max_text_notes");
                        break;
                    }

                    Dictionary<string, object> record = BuildTextNoteRecord(
                        "viewportTextNote",
                        sheet,
                        viewport,
                        view,
                        textNote,
                        text,
                        textNote.get_BoundingBox(view));
                    if (!AddRecordIfWithinResponseBudget(record, state)) return;

                    textNoteReturned++;
                    state.TotalViewportTextNoteMatches++;
                    textNotes.Add(record);
                    flatMatches.Add(CloneRecord(record));
                }
            }
        }

        private void ScanViewportTags(
            Document document,
            ViewSheet sheet,
            Viewport viewport,
            Autodesk.Revit.DB.View view,
            DateTime deadlineUtc,
            SheetAnnotationScanState state,
            List<string> warnings,
            List<Dictionary<string, object>> flatMatches,
            List<Dictionary<string, object>> tags,
            out int tagCount,
            out int tagReturned,
            out bool tagsTruncated)
        {
            tagCount = 0;
            tagReturned = 0;
            tagsTruncated = false;

            if (state.ScannedTagCount >= _request.MaxTagsScanned)
            {
                state.Stop("max_items");
                return;
            }

            using (FilteredElementCollector collector = new FilteredElementCollector(document, view.Id))
            {
                foreach (Element element in collector.OfClass(typeof(IndependentTag)).WhereElementIsNotElementType())
                {
                    if (StopIfNeeded(deadlineUtc, state)) return;
                    if (state.ScannedTagCount >= _request.MaxTagsScanned)
                    {
                        state.Stop("max_items");
                        return;
                    }

                    IndependentTag tag = element as IndependentTag;
                    if (tag == null) continue;
                    state.ScannedTagCount++;
                    tagCount++;

                    string tagText = SafeTagText(tag, warnings);
                    if (string.IsNullOrWhiteSpace(tagText))
                    {
                        AddOnce(warnings, "viewport_tag_text_unavailable");
                        continue;
                    }
                    if (!ContainsNormalized(tagText, _request.TextQuery)) continue;
                    if (tagReturned >= _request.MaxViewportTagsPerView)
                    {
                        tagsTruncated = true;
                        state.Stop("max_items");
                        break;
                    }

                    Dictionary<string, object> record = BuildViewportTagRecord(document, sheet, viewport, view, tag, tagText, warnings);
                    if (!AddRecordIfWithinResponseBudget(record, state)) return;

                    tagReturned++;
                    state.TotalViewportTagMatches++;
                    tags.Add(record);
                    flatMatches.Add(CloneRecord(record));
                }
            }
        }

        private static bool CanIterateViewElements(
            Document document,
            Autodesk.Revit.DB.View view,
            List<string> warnings,
            ViewSheet sheet,
            Viewport viewport)
        {
            try
            {
                if (FilteredElementCollector.IsViewValidForElementIteration(document, view.Id))
                {
                    return true;
                }
            }
            catch (Exception ex)
            {
                warnings.Add("Viewport view iteration check failed on sheet " + sheet.SheetNumber + ", viewport " + viewport.Id.GetIdValue().ToString(CultureInfo.InvariantCulture) + ": " + ex.Message);
                return false;
            }

            warnings.Add("Skipped viewport annotation scan because the placed view is not valid for element iteration on sheet " + sheet.SheetNumber + ", viewport " + viewport.Id.GetIdValue().ToString(CultureInfo.InvariantCulture) + ".");
            return false;
        }

        private List<ViewSheet> ResolveSourceSheets(Document document, List<string> warnings, DateTime deadlineUtc, SheetAnnotationScanState state)
        {
            List<ViewSheet> sourceSheets = new List<ViewSheet>();
            HashSet<int> requestedIds = new HashSet<int>();
            if (_request.SheetIds != null)
            {
                foreach (int id in _request.SheetIds)
                {
                    if (!requestedIds.Add(id))
                    {
                        continue;
                    }

                    ViewSheet sheet = document.GetElement(new ElementId(id)) as ViewSheet;
                    if (sheet != null && !sheet.IsTemplate)
                    {
                        sourceSheets.Add(sheet);
                    }
                    else
                    {
                        warnings.Add("Sheet not found or is a template: " + id.ToString(CultureInfo.InvariantCulture));
                    }
                }
            }

            if (requestedIds.Count > 0)
            {
                return sourceSheets;
            }

            using (FilteredElementCollector collector = new FilteredElementCollector(document))
            {
                foreach (Element element in collector.OfClass(typeof(ViewSheet)))
                {
                    if (StopIfNeeded(deadlineUtc, state)) break;
                    ViewSheet sheet = element as ViewSheet;
                    if (sheet == null || sheet.IsTemplate) continue;
                    sourceSheets.Add(sheet);
                }
            }

            return sourceSheets;
        }

        private bool ShouldGuardNeedsScope()
        {
            bool hasSheetScope = (_request.SheetIds != null && _request.SheetIds.Count > 0) || !string.IsNullOrWhiteSpace(_request.SheetQuery);
            bool hasTextQuery = !string.IsNullOrWhiteSpace(_request.TextQuery);
            if (hasSheetScope || _request.AllowExpensiveSearch)
            {
                return false;
            }

            return hasTextQuery || _request.IncludeViewportTextNotes || _request.ScanScheduleCells || _request.IncludeViewportTags;
        }

        private InspectSheetTextResult BuildGuardedResult(
            string reason,
            string message,
            SheetAnnotationScanState state,
            List<string> warnings,
            List<string> notices)
        {
            return new InspectSheetTextResult
            {
                Success = true,
                Guarded = true,
                State = "guarded",
                Action = "inspect_sheet_text",
                Reason = reason,
                Message = message,
                SheetQuery = _request.SheetQuery,
                TextQuery = _request.TextQuery,
                MaxSheets = _request.MaxSheets,
                Partial = false,
                ScanStoppedReason = reason,
                ScanPolicy = BuildScanPolicy(),
                SuggestedNextScopes = BuildSuggestedNextScopes(),
                ScannedSheetCount = state.ScannedSheetCount,
                ScannedViewportCount = state.ScannedViewportCount,
                ScannedTextNoteCount = state.ScannedTextNoteCount,
                ScannedTagCount = state.ScannedTagCount,
                ScannedScheduleInstanceCount = state.ScannedScheduleInstanceCount,
                ScannedScheduleCellCount = state.ScannedScheduleCellCount,
                EstimatedResponseBytes = state.EstimatedResponseBytes,
                MaxResponseBytes = _request.MaxResponseBytes,
                Scan = BuildScanSummary(state),
                Sheets = new List<InspectSheetTextSheetResult>(),
                Matches = new List<Dictionary<string, object>>(),
                Warnings = warnings,
                Notices = notices
            };
        }

        private InspectSheetTextResult BuildCompletedResult(
            int totalSheets,
            int candidateCount,
            List<InspectSheetTextSheetResult> sheets,
            List<Dictionary<string, object>> matches,
            SheetAnnotationScanState state,
            List<string> warnings,
            List<string> notices)
        {
            if (!string.IsNullOrWhiteSpace(_request.TextQuery) && _request.IncludeScheduleInstances && !_request.ScanScheduleCells)
            {
                warnings.Add("Schedule instances are listed but schedule cells are not scanned. Set scanScheduleCells=true when the text may be inside placed schedules.");
            }

            return new InspectSheetTextResult
            {
                Success = true,
                Guarded = false,
                State = "completed",
                Action = "inspect_sheet_text",
                Message = state.Partial
                    ? "Sheet annotation evidence returned before the native scan budget stopped."
                    : "Sheet annotation evidence collected.",
                SheetQuery = _request.SheetQuery,
                TextQuery = _request.TextQuery,
                TotalSheets = totalSheets,
                CandidateCount = candidateCount,
                ReturnedCount = sheets.Count,
                Truncated = state.Partial,
                MaxSheets = _request.MaxSheets,
                Partial = state.Partial,
                ScanStoppedReason = state.ScanStoppedReason,
                ScanPolicy = BuildScanPolicy(),
                SuggestedNextScopes = BuildSuggestedNextScopes(),
                ScannedSheetCount = state.ScannedSheetCount,
                ScannedViewportCount = state.ScannedViewportCount,
                ScannedTextNoteCount = state.ScannedTextNoteCount,
                ScannedTagCount = state.ScannedTagCount,
                ScannedScheduleInstanceCount = state.ScannedScheduleInstanceCount,
                ScannedScheduleCellCount = state.ScannedScheduleCellCount,
                EstimatedResponseBytes = state.EstimatedResponseBytes,
                MaxResponseBytes = _request.MaxResponseBytes,
                Scan = BuildScanSummary(state),
                Sheets = sheets,
                Matches = matches,
                Warnings = warnings,
                Notices = notices
            };
        }

        private Dictionary<string, object> BuildScanSummary(SheetAnnotationScanState state)
        {
            Dictionary<string, object> scan = new Dictionary<string, object>();
            scan["includeTextNotes"] = _request.IncludeTextNotes;
            scan["includeScheduleInstances"] = _request.IncludeScheduleInstances;
            scan["scanScheduleCells"] = _request.ScanScheduleCells;
            scan["includeViewportTextNotes"] = _request.IncludeViewportTextNotes;
            scan["includeViewportTags"] = _request.IncludeViewportTags;
            scan["maxTextNotesPerSheet"] = _request.MaxTextNotesPerSheet;
            scan["maxScheduleInstancesPerSheet"] = _request.MaxScheduleInstancesPerSheet;
            scan["maxRowsPerSchedule"] = _request.MaxRowsPerSchedule;
            scan["maxColumnsPerSchedule"] = _request.MaxColumnsPerSchedule;
            scan["maxViewportsPerSheet"] = _request.MaxViewportsPerSheet;
            scan["maxViewports"] = _request.MaxViewportsPerSheet;
            scan["maxViewportTextNotesPerView"] = _request.MaxViewportTextNotesPerView;
            scan["maxViewportTagsPerView"] = _request.MaxViewportTagsPerView;
            scan["maxTags"] = _request.MaxTagsScanned;
            scan["totalTextNoteMatches"] = state.TotalTextNoteMatches;
            scan["totalViewportTextNoteMatches"] = state.TotalViewportTextNoteMatches;
            scan["totalViewportTagMatches"] = state.TotalViewportTagMatches;
            scan["totalScheduleCellMatches"] = state.TotalScheduleCellMatches;
            scan["totalScheduleInstanceMatches"] = state.TotalScheduleInstanceMatches;
            return scan;
        }

        private Dictionary<string, object> BuildScanPolicy()
        {
            Dictionary<string, object> policy = new Dictionary<string, object>();
            policy["searchBudget"] = _request.SearchBudget;
            policy["allowExpensiveSearch"] = _request.AllowExpensiveSearch;
            policy["maxElapsedMs"] = _request.MaxElapsedMs;
            policy["timeoutMs"] = _request.TimeoutMs;
            policy["maxSheets"] = _request.MaxSheets;
            policy["maxViewports"] = _request.MaxViewportsPerSheet;
            policy["maxTextNotesScanned"] = _request.MaxTextNotesScanned;
            policy["maxTags"] = _request.MaxTagsScanned;
            policy["maxTagsScanned"] = _request.MaxTagsScanned;
            policy["maxScheduleInstancesScanned"] = _request.MaxScheduleInstancesScanned;
            policy["maxScheduleCellsScanned"] = _request.MaxScheduleCellsScanned;
            policy["maxResponseBytes"] = _request.MaxResponseBytes;
            return policy;
        }

        private List<string> BuildSuggestedNextScopes()
        {
            return new List<string>
            {
                "sheetQuery",
                "sheetIds",
                "viewNameQuery",
                "maxSheets",
                "allowExpensiveSearch",
                "searchBudget=deep"
            };
        }

        private Dictionary<string, object> BuildTextNoteRecord(
            string kind,
            ViewSheet sheet,
            Viewport viewport,
            Autodesk.Revit.DB.View view,
            TextNote textNote,
            string text,
            BoundingBoxXYZ box)
        {
            Dictionary<string, object> record = new Dictionary<string, object>();
            record["kind"] = kind;
            record["id"] = textNote.Id.GetIdValue();
            record["elementId"] = textNote.Id.GetIdValue();
            record["uniqueId"] = textNote.UniqueId;
            record["sheetId"] = sheet.Id.GetIdValue();
            record["sheetNumber"] = sheet.SheetNumber;
            record["sheetName"] = sheet.Name;
            if (viewport != null)
            {
                record["viewportId"] = viewport.Id.GetIdValue();
            }
            if (view != null)
            {
                record["viewId"] = view.Id.GetIdValue();
                record["viewName"] = view.Name;
                record["viewType"] = view.ViewType.ToString();
            }
            record["text"] = TrimText(text);
            record["textNormalized"] = NormalizeForSearch(text);
            record["point"] = PointInfo(textNote.Coord);
            record["box"] = BoxInfo(box);
            return record;
        }

        private Dictionary<string, object> BuildScheduleInstanceRecord(
            ViewSheet sheet,
            ScheduleSheetInstance instance,
            ViewSchedule schedule,
            Dictionary<string, object> cellScan)
        {
            Dictionary<string, object> record = new Dictionary<string, object>();
            record["kind"] = "scheduleInstance";
            record["sheetId"] = sheet.Id.GetIdValue();
            record["sheetNumber"] = sheet.SheetNumber;
            record["sheetName"] = sheet.Name;
            record["instanceId"] = instance.Id.GetIdValue();
            record["uniqueId"] = instance.UniqueId;
            record["scheduleId"] = instance.ScheduleId.GetIdValue();
            record["scheduleName"] = schedule != null ? schedule.Name : "";
            record["isTitleblockRevisionSchedule"] = IsRevisionScheduleInstance(instance);
            record["point"] = ScheduleInstancePointInfo(instance);
            record["box"] = BoxInfo(instance.get_BoundingBox(sheet));
            record["cellScan"] = cellScan;
            return record;
        }

        private Dictionary<string, object> BuildViewportRecord(ViewSheet sheet, Viewport viewport, Autodesk.Revit.DB.View view)
        {
            Dictionary<string, object> record = new Dictionary<string, object>();
            record["sheetId"] = sheet.Id.GetIdValue();
            record["sheetNumber"] = sheet.SheetNumber;
            record["sheetName"] = sheet.Name;
            record["viewportId"] = viewport.Id.GetIdValue();
            record["viewId"] = view.Id.GetIdValue();
            record["viewName"] = view.Name;
            record["viewType"] = view.ViewType.ToString();
            record["scale"] = view.Scale;
            record["boxCenter"] = PointInfo(SafeViewportBoxCenter(viewport));
            record["box"] = SafeViewportBox(viewport);
            return record;
        }

        private Dictionary<string, object> BuildViewportTagRecord(
            Document document,
            ViewSheet sheet,
            Viewport viewport,
            Autodesk.Revit.DB.View view,
            IndependentTag tag,
            string tagText,
            List<string> warnings)
        {
            Dictionary<string, object> record = new Dictionary<string, object>();
            record["kind"] = "viewportTag";
            record["id"] = tag.Id.GetIdValue();
            record["elementId"] = tag.Id.GetIdValue();
            record["tagId"] = tag.Id.GetIdValue();
            record["uniqueId"] = tag.UniqueId;
            record["sheetId"] = sheet.Id.GetIdValue();
            record["sheetNumber"] = sheet.SheetNumber;
            record["sheetName"] = sheet.Name;
            record["viewportId"] = viewport.Id.GetIdValue();
            record["viewId"] = view.Id.GetIdValue();
            record["viewName"] = view.Name;
            record["viewType"] = view.ViewType.ToString();
            record["tagText"] = TrimText(tagText);
            record["tagTextNormalized"] = NormalizeForSearch(tagText);
            record["text"] = TrimText(tagText);
            record["textNormalized"] = NormalizeForSearch(tagText);
            record["box"] = BoxInfo(SafeBoundingBox(tag, view));

            Element tagType = SafeGetElement(document, tag.GetTypeId());
            if (tagType != null)
            {
                record["tagFamilyName"] = FamilyNameForElement(tagType);
                record["tagTypeName"] = SafeElementName(tagType);
            }

            ElementId taggedElementId = ResolveTaggedLocalElementId(tag, warnings);
            if (taggedElementId == null || taggedElementId == ElementId.InvalidElementId)
            {
                record["taggedElementResolved"] = false;
                AddOnce(warnings, "viewport_tag_tagged_element_unresolved");
                return record;
            }

            record["taggedElementId"] = taggedElementId.GetIdValue();
            Element taggedElement = SafeGetElement(document, taggedElementId);
            if (taggedElement == null)
            {
                record["taggedElementResolved"] = false;
                AddOnce(warnings, "viewport_tag_tagged_element_not_found");
                return record;
            }

            record["taggedElementResolved"] = true;
            record["taggedCategory"] = taggedElement.Category != null ? taggedElement.Category.Name : "";
            record["taggedFamilyName"] = FamilyNameForElement(taggedElement);
            record["taggedTypeName"] = TypeNameForElement(document, taggedElement);
            return record;
        }

        private static Dictionary<string, object> BuildScheduleCellScan(
            int scannedRows,
            int scannedColumns,
            bool truncated,
            List<Dictionary<string, object>> matches,
            bool readFailed,
            string readError)
        {
            Dictionary<string, object> scan = new Dictionary<string, object>();
            scan["scannedRows"] = scannedRows;
            scan["scannedColumns"] = scannedColumns;
            scan["truncated"] = truncated;
            scan["matchCount"] = matches.Count;
            scan["matches"] = matches;
            scan["readFailed"] = readFailed;
            scan["readError"] = readError;
            return scan;
        }

        private bool AddRecordIfWithinResponseBudget(Dictionary<string, object> record, SheetAnnotationScanState state)
        {
            int estimate = EstimateObjectBytes(record);
            if (state.EstimatedResponseBytes + estimate > _request.MaxResponseBytes)
            {
                state.Stop("max_bytes");
                return false;
            }

            state.EstimatedResponseBytes += estimate;
            return true;
        }

        private bool StopIfNeeded(DateTime deadlineUtc, SheetAnnotationScanState state)
        {
            if (state.Partial && IsHardStop(state.ScanStoppedReason))
            {
                return true;
            }

            if (DateTime.UtcNow >= deadlineUtc)
            {
                state.Stop("max_elapsed");
                return true;
            }

            if (state.EstimatedResponseBytes >= _request.MaxResponseBytes)
            {
                state.Stop("max_bytes");
                return true;
            }

            return false;
        }

        private static bool IsHardStop(string reason)
        {
            return string.Equals(reason, "max_elapsed", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(reason, "max_bytes", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(reason, "max_schedule_cells", StringComparison.OrdinalIgnoreCase);
        }

        private static bool HasViewportEvidence(InspectSheetTextSheetResult sheet)
        {
            if (sheet == null || sheet.Viewports == null) return false;
            foreach (Dictionary<string, object> viewport in sheet.Viewports)
            {
                object textNotesObj;
                if (viewport.TryGetValue("textNotes", out textNotesObj))
                {
                    List<Dictionary<string, object>> textNotes = textNotesObj as List<Dictionary<string, object>>;
                    if (textNotes != null && textNotes.Count > 0)
                    {
                        return true;
                    }
                }

                object tagsObj;
                if (viewport.TryGetValue("tags", out tagsObj))
                {
                    List<Dictionary<string, object>> tags = tagsObj as List<Dictionary<string, object>>;
                    if (tags != null && tags.Count > 0)
                    {
                        return true;
                    }
                }
            }
            return false;
        }

        private static Dictionary<string, object> CloneRecord(Dictionary<string, object> record)
        {
            return new Dictionary<string, object>(record);
        }

        private string TrimText(string value)
        {
            if (value == null) return "";
            value = value.Replace("\r", " ").Replace("\n", " ").Replace("\t", " ").Trim();
            if (value.Length <= _request.MaxTextChars) return value;
            return value.Substring(0, _request.MaxTextChars) + "...";
        }

        private static string SafeText(TextNote textNote)
        {
            try
            {
                return textNote.Text ?? "";
            }
            catch
            {
                return "";
            }
        }

        private static string ReadScheduleCell(ViewSchedule schedule, SectionType sectionType, int row, int column)
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

        private static bool ContainsNormalized(string value, string query)
        {
            if (string.IsNullOrWhiteSpace(query)) return true;
            return NormalizeForSearch(value).Contains(NormalizeForSearch(query));
        }

        private static string NormalizeForSearch(string value)
        {
            if (value == null) return "";
            string replaced = value
                .Replace('\u0423', 'Y')
                .Replace('\u0443', 'y')
                .Replace('\u011E', 'G')
                .Replace('\u011F', 'g')
                .Replace('\u00DC', 'U')
                .Replace('\u00FC', 'u')
                .Replace('\u0130', 'I')
                .Replace('\u0131', 'i')
                .Replace('\u015E', 'S')
                .Replace('\u015F', 's')
                .Replace('\u00C7', 'C')
                .Replace('\u00E7', 'c')
                .Replace('\u00D6', 'O')
                .Replace('\u00F6', 'o');
            string form = replaced.Normalize(NormalizationForm.FormD);
            StringBuilder builder = new StringBuilder();
            foreach (char ch in form)
            {
                UnicodeCategory category = CharUnicodeInfo.GetUnicodeCategory(ch);
                if (category != UnicodeCategory.NonSpacingMark)
                {
                    builder.Append(ch);
                }
            }
            return builder.ToString().ToLowerInvariant();
        }

        private static Dictionary<string, object> PointInfo(XYZ point)
        {
            if (point == null) return null;
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["x"] = Math.Round(point.X, 6);
            result["y"] = Math.Round(point.Y, 6);
            result["z"] = Math.Round(point.Z, 6);
            return result;
        }

        private static Dictionary<string, object> BoxInfo(BoundingBoxXYZ box)
        {
            if (box == null) return null;
            return BoxFromPoints(box.Min, box.Max);
        }

        private static Dictionary<string, object> BoxFromPoints(XYZ min, XYZ max)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["min"] = PointInfo(min);
            result["max"] = PointInfo(max);
            return result;
        }

        private static XYZ SafeViewportBoxCenter(Viewport viewport)
        {
            try
            {
                return viewport.GetBoxCenter();
            }
            catch
            {
                return null;
            }
        }

        private static Dictionary<string, object> SafeViewportBox(Viewport viewport)
        {
            try
            {
                Outline outline = viewport.GetBoxOutline();
                return BoxFromPoints(outline.MinimumPoint, outline.MaximumPoint);
            }
            catch
            {
                return null;
            }
        }

        private static Dictionary<string, object> ScheduleInstancePointInfo(ScheduleSheetInstance instance)
        {
            try
            {
                System.Reflection.PropertyInfo pointProperty = instance.GetType().GetProperty("Point");
                if (pointProperty == null) return null;
                return PointInfo(pointProperty.GetValue(instance, null) as XYZ);
            }
            catch
            {
                return null;
            }
        }

        private static bool IsRevisionScheduleInstance(ScheduleSheetInstance instance)
        {
            try
            {
                System.Reflection.PropertyInfo revisionProperty = instance.GetType().GetProperty("IsTitleblockRevisionSchedule");
                if (revisionProperty == null) return false;
                object value = revisionProperty.GetValue(instance, null);
                return value is bool && (bool)value;
            }
            catch
            {
                return false;
            }
        }

        private static Element SafeGetElement(Document document, ElementId id)
        {
            try
            {
                if (document == null || id == null || id == ElementId.InvalidElementId) return null;
                return document.GetElement(id);
            }
            catch
            {
                return null;
            }
        }

        private static BoundingBoxXYZ SafeBoundingBox(Element element, Autodesk.Revit.DB.View view)
        {
            try
            {
                return element != null ? element.get_BoundingBox(view) : null;
            }
            catch
            {
                return null;
            }
        }

        private static string SafeElementName(Element element)
        {
            try
            {
                return element != null ? element.Name ?? "" : "";
            }
            catch
            {
                return "";
            }
        }

        private static string FamilyNameForElement(Element element)
        {
            try
            {
                if (element == null) return "";

                ElementType type = element as ElementType;
                if (type != null)
                {
                    return type.FamilyName ?? "";
                }

                FamilyInstance instance = element as FamilyInstance;
                if (instance != null && instance.Symbol != null)
                {
                    return instance.Symbol.FamilyName ?? "";
                }
            }
            catch
            {
                return "";
            }

            return "";
        }

        private static string TypeNameForElement(Document document, Element element)
        {
            try
            {
                if (document == null || element == null) return "";
                ElementId typeId = element.GetTypeId();
                Element typeElement = SafeGetElement(document, typeId);
                return SafeElementName(typeElement);
            }
            catch
            {
                return "";
            }
        }

        private static ElementId ResolveTaggedLocalElementId(IndependentTag tag, List<string> warnings)
        {
            if (tag == null) return null;

            try
            {
                System.Reflection.MethodInfo method = tag.GetType().GetMethod("GetTaggedLocalElementIds", Type.EmptyTypes);
                if (method != null)
                {
                    System.Collections.IEnumerable ids = method.Invoke(tag, null) as System.Collections.IEnumerable;
                    if (ids != null)
                    {
                        foreach (object item in ids)
                        {
                            ElementId id = item as ElementId;
                            if (id != null && id != ElementId.InvalidElementId)
                            {
                                return id;
                            }
                        }
                    }
                }
            }
            catch
            {
                AddOnce(warnings, "viewport_tag_tagged_local_element_ids_read_failed");
            }

            try
            {
                System.Reflection.MethodInfo method = tag.GetType().GetMethod("GetTaggedElementIds", Type.EmptyTypes);
                if (method != null)
                {
                    System.Collections.IEnumerable ids = method.Invoke(tag, null) as System.Collections.IEnumerable;
                    if (ids != null)
                    {
                        foreach (object item in ids)
                        {
                            ElementId linkedId = TryReadElementIdProperty(item, "LinkedElementId");
                            if (linkedId != null && linkedId != ElementId.InvalidElementId)
                            {
                                AddOnce(warnings, "viewport_tag_linked_element_unresolved");
                                continue;
                            }

                            ElementId hostId = TryReadElementIdProperty(item, "HostElementId");
                            if (hostId != null && hostId != ElementId.InvalidElementId)
                            {
                                return hostId;
                            }
                        }
                    }
                }
            }
            catch
            {
                AddOnce(warnings, "viewport_tag_tagged_element_ids_read_failed");
            }

            return null;
        }

        private static ElementId TryReadElementIdProperty(object value, string propertyName)
        {
            try
            {
                if (value == null) return null;
                System.Reflection.PropertyInfo property = value.GetType().GetProperty(propertyName);
                if (property == null) return null;
                return property.GetValue(value, null) as ElementId;
            }
            catch
            {
                return null;
            }
        }

        private static string SafeTagText(IndependentTag tag, List<string> warnings)
        {
            try
            {
                return tag != null ? tag.TagText ?? "" : "";
            }
            catch
            {
                AddOnce(warnings, "viewport_tag_text_read_failed");
                return "";
            }
        }

        private static void AddOnce(List<string> values, string value)
        {
            if (values == null || string.IsNullOrWhiteSpace(value)) return;
            if (!values.Contains(value))
            {
                values.Add(value);
            }
        }

        private static int EstimateObjectBytes(object value)
        {
            if (value == null) return 4;
            string text = value as string;
            if (text != null) return 16 + (text.Length * 2);
            if (value is bool || value is int || value is long || value is double || value is decimal) return 32;

            System.Collections.IDictionary dictionary = value as System.Collections.IDictionary;
            if (dictionary != null)
            {
                int total = 32;
                foreach (System.Collections.DictionaryEntry entry in dictionary)
                {
                    total += 8 + EstimateObjectBytes(entry.Key) + EstimateObjectBytes(entry.Value);
                }
                return total;
            }

            System.Collections.IEnumerable enumerable = value as System.Collections.IEnumerable;
            if (enumerable != null)
            {
                int total = 32;
                foreach (object item in enumerable)
                {
                    total += EstimateObjectBytes(item);
                }
                return total;
            }

            return 64 + (Convert.ToString(value, CultureInfo.InvariantCulture) ?? "").Length * 2;
        }

        private void Complete(InspectSheetTextResult result)
        {
            ResultInfo = result;
            TaskCompleted = true;
            _resetEvent.Set();
        }

        public string GetName()
        {
            return "Inspect Revit sheet annotations";
        }
    }
}
