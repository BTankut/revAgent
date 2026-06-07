using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
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
        public string NormalizedSheetQuery { get; set; }
        public string NormalizedTextQuery { get; set; }
        public string NormalizedViewNameQuery { get; set; }
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
            _request.NormalizedSheetQuery = AnnotationEvidenceHelpers.NormalizeForSearch(_request.SheetQuery);
            _request.NormalizedTextQuery = AnnotationEvidenceHelpers.NormalizeForSearch(_request.TextQuery);
            _request.NormalizedViewNameQuery = AnnotationEvidenceHelpers.NormalizeForSearch(_request.ViewNameQuery);
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
                    bool sheetMatches = !hasSheetQuery || AnnotationEvidenceHelpers.ContainsPreNormalized(sheetLabel, _request.NormalizedSheetQuery);
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
                    SuggestedNextScopes = AnnotationEvidenceHelpers.BuildSheetTextSuggestedNextScopes(),
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
                    string text = AnnotationEvidenceHelpers.SafeText(textNote);
                    if (!AnnotationEvidenceHelpers.ContainsPreNormalized(text, _request.NormalizedTextQuery)) continue;

                    if (returned >= _request.MaxTextNotesPerSheet)
                    {
                        result.TextNotesTruncated = true;
                        state.Stop("max_text_notes");
                        continue;
                    }

                    Dictionary<string, object> record = AnnotationEvidenceHelpers.BuildTextNoteRecord(
                        "sheetTextNote",
                        sheet,
                        null,
                        null,
                        textNote,
                        text,
                        _request.MaxTextChars);
                    if (!AddRecordIfWithinResponseBudget(record, state)) return;

                    returned++;
                    state.TotalTextNoteMatches++;
                    result.TextNoteReturned = returned;
                    result.TextNotes.Add(record);
                    flatMatches.Add(AnnotationEvidenceHelpers.CloneRecord(record));
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

                    Dictionary<string, object> record = AnnotationEvidenceHelpers.BuildScheduleInstanceRecord(sheet, instance, schedule, cellScan);
                    if (!AddRecordIfWithinResponseBudget(record, state)) return;

                    returned++;
                    state.TotalScheduleInstanceMatches++;
                    result.ScheduleInstanceReturned = returned;
                    result.ScheduleInstances.Add(record);

                    Dictionary<string, object> flat = AnnotationEvidenceHelpers.CloneRecord(record);
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
                return AnnotationEvidenceHelpers.BuildScheduleCellScan(0, 0, true, matches, readFailed, readError);
            }

            try
            {
                TableData tableData = schedule.GetTableData();
                TableSectionData section = tableData != null ? tableData.GetSectionData(SectionType.Body) : null;
                if (section == null)
                {
                    readFailed = true;
                    readError = "Schedule body section data is not available.";
                    return AnnotationEvidenceHelpers.BuildScheduleCellScan(0, 0, false, matches, readFailed, readError);
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
                            return AnnotationEvidenceHelpers.BuildScheduleCellScan(scannedRows, scannedColumns, truncated, matches, readFailed, readError);
                        }
                        if (state.ScannedScheduleCellCount >= _request.MaxScheduleCellsScanned)
                        {
                            state.Stop("max_schedule_cells");
                            truncated = true;
                            return AnnotationEvidenceHelpers.BuildScheduleCellScan(scannedRows, scannedColumns, truncated, matches, readFailed, readError);
                        }

                        state.ScannedScheduleCellCount++;
                        string text = AnnotationEvidenceHelpers.ReadScheduleCell(schedule, SectionType.Body, row, column);
                        if (!string.IsNullOrWhiteSpace(_request.TextQuery) && AnnotationEvidenceHelpers.ContainsPreNormalized(text, _request.NormalizedTextQuery))
                        {
                            Dictionary<string, object> cell = AnnotationEvidenceHelpers.BuildScheduleCellMatch("body", row, column, text, _request.MaxTextChars);
                            if (!AddRecordIfWithinResponseBudget(cell, state))
                            {
                                truncated = true;
                                return AnnotationEvidenceHelpers.BuildScheduleCellScan(scannedRows, scannedColumns, truncated, matches, readFailed, readError);
                            }

                            matches.Add(cell);
                            state.TotalScheduleCellMatches++;
                            Dictionary<string, object> flat = AnnotationEvidenceHelpers.BuildPlacedScheduleCellEvidenceRow(sheet, instance, schedule, row, column, text, _request.MaxTextChars);
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

            return AnnotationEvidenceHelpers.BuildScheduleCellScan(scannedRows, scannedColumns, truncated, matches, readFailed, readError);
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
                if (!string.IsNullOrWhiteSpace(_request.ViewNameQuery) && !AnnotationEvidenceHelpers.ContainsPreNormalized(view.Name, _request.NormalizedViewNameQuery))
                {
                    continue;
                }

                try
                {
                    Dictionary<string, object> viewportRecord = AnnotationEvidenceHelpers.BuildViewportRecord(sheet, viewport, view);
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
                    string text = AnnotationEvidenceHelpers.SafeText(textNote);
                    if (!AnnotationEvidenceHelpers.ContainsPreNormalized(text, _request.NormalizedTextQuery)) continue;
                    if (textNoteReturned >= _request.MaxViewportTextNotesPerView)
                    {
                        textNotesTruncated = true;
                        state.Stop("max_text_notes");
                        break;
                    }

                    Dictionary<string, object> record = AnnotationEvidenceHelpers.BuildTextNoteRecord(
                        "viewportTextNote",
                        sheet,
                        viewport,
                        view,
                        textNote,
                        text,
                        _request.MaxTextChars);
                    if (!AddRecordIfWithinResponseBudget(record, state)) return;

                    textNoteReturned++;
                    state.TotalViewportTextNoteMatches++;
                    textNotes.Add(record);
                    flatMatches.Add(AnnotationEvidenceHelpers.CloneRecord(record));
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

                    string tagText = AnnotationEvidenceHelpers.SafeTagText(tag, warnings);
                    if (string.IsNullOrWhiteSpace(tagText))
                    {
                        AnnotationEvidenceHelpers.AddOnce(warnings, "viewport_tag_text_unavailable");
                        continue;
                    }
                    if (!AnnotationEvidenceHelpers.ContainsPreNormalized(tagText, _request.NormalizedTextQuery)) continue;
                    if (tagReturned >= _request.MaxViewportTagsPerView)
                    {
                        tagsTruncated = true;
                        state.Stop("max_items");
                        break;
                    }

                    Dictionary<string, object> record = AnnotationEvidenceHelpers.BuildViewportTagRecord(document, sheet, viewport, view, tag, tagText, _request.MaxTextChars, warnings);
                    if (!AddRecordIfWithinResponseBudget(record, state)) return;

                    tagReturned++;
                    state.TotalViewportTagMatches++;
                    tags.Add(record);
                    flatMatches.Add(AnnotationEvidenceHelpers.CloneRecord(record));
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
                SuggestedNextScopes = AnnotationEvidenceHelpers.BuildSheetTextSuggestedNextScopes(),
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
                SuggestedNextScopes = AnnotationEvidenceHelpers.BuildSheetTextSuggestedNextScopes(),
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

        private bool AddRecordIfWithinResponseBudget(Dictionary<string, object> record, SheetAnnotationScanState state)
        {
            int estimate = AnnotationEvidenceHelpers.EstimateObjectBytes(record, AnnotationEvidenceByteEstimateKind.SheetText);
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
