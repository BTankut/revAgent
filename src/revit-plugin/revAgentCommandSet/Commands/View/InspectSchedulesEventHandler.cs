using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPSDK.API.Interfaces;
using RevAgentCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;

namespace RevAgentCommandSet.Commands.View
{
    public class InspectSchedulesRequest
    {
        public string Query { get; set; }
        public string NameQuery { get; set; }
        public string CellQuery { get; set; }
        public List<int> ScheduleIds { get; set; }
        public List<string> Sections { get; set; }
        public bool IncludeCells { get; set; }
        public bool ScanCells { get; set; }
        public bool AllowExpensiveSearch { get; set; }
        public string SearchBudget { get; set; }
        public int MaxElapsedMs { get; set; }
        public int MaxSchedules { get; set; }
        public int MaxRowsPerSection { get; set; }
        public int MaxColumnsPerSection { get; set; }
        public int StartRow { get; set; }
        public int StartColumn { get; set; }
        public int MaxCellTextChars { get; set; }
        public int MaxCells { get; set; }
        public int MaxResponseBytes { get; set; }
        public int TimeoutMs { get; set; }
        public string NormalizedNameQuery { get; set; }
        public string NormalizedCellQuery { get; set; }
    }

    public class InspectSchedulesResult
    {
        public bool Success { get; set; }
        public bool Guarded { get; set; }
        public string State { get; set; }
        public string Action { get; set; }
        public string Reason { get; set; }
        public string Message { get; set; }
        public string Error { get; set; }
        public string Query { get; set; }
        public string NameQuery { get; set; }
        public string CellQuery { get; set; }
        public int TotalSchedules { get; set; }
        public int CandidateCount { get; set; }
        public int ReturnedCount { get; set; }
        public bool Truncated { get; set; }
        public int MaxSchedules { get; set; }
        public bool Partial { get; set; }
        public string ScanStoppedReason { get; set; }
        public object ScanPolicy { get; set; }
        public List<string> SuggestedNextScopes { get; set; }
        public int ScannedScheduleCount { get; set; }
        public int ScannedSectionCount { get; set; }
        public int ScannedRowCount { get; set; }
        public int ScannedColumnCount { get; set; }
        public int ScannedCellCount { get; set; }
        public int EstimatedResponseBytes { get; set; }
        public int MaxResponseBytes { get; set; }
        public string LastReadSection { get; set; }
        public int? LastReadRow { get; set; }
        public int? LastReadColumn { get; set; }
        public int? LastReadSheetId { get; set; }
        public int? LastReadViewId { get; set; }
        public int? LastReadViewportId { get; set; }
        public int? LastReadItemId { get; set; }
        public object Scan { get; set; }
        public List<Dictionary<string, object>> Schedules { get; set; }
        public List<Dictionary<string, object>> Matches { get; set; }
        public List<string> Warnings { get; set; }
        public List<string> Notices { get; set; }
    }

    internal class ScheduleScanState
    {
        public bool Partial;
        public string ScanStoppedReason = "";
        public int ScannedScheduleCount;
        public int ScannedSectionCount;
        public int ScannedRowCount;
        public int ScannedColumnCount;
        public int ScannedCellCount;
        public int ScheduleNameMatchedCount;
        public int CellMatchedScheduleCount;
        public int TotalCellMatches;
        public int EstimatedResponseBytes = 2048;
        public string LastReadSection;
        public int? LastReadRow;
        public int? LastReadColumn;
        public int? LastReadItemId;

        public void Stop(string reason)
        {
            if (!Partial)
            {
                Partial = true;
                ScanStoppedReason = reason;
            }
        }
    }

    public class InspectSchedulesEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private InspectSchedulesRequest _request;

        public InspectSchedulesResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetRequest(InspectSchedulesRequest request)
        {
            _request = request ?? new InspectSchedulesRequest();
            if (_request.ScheduleIds == null) _request.ScheduleIds = new List<int>();
            if (_request.Sections == null || _request.Sections.Count == 0) _request.Sections = new List<string> { "header", "body" };
            _request.NormalizedNameQuery = AnnotationEvidenceHelpers.NormalizeForSearch(_request.NameQuery);
            _request.NormalizedCellQuery = AnnotationEvidenceHelpers.NormalizeForSearch(_request.CellQuery);
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
            ScheduleScanState state = new ScheduleScanState();
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
                        "Schedule cell scanning without scheduleIds/nameQuery can be expensive in large models. First discover schedules by name, pass exact scheduleIds, or set allowExpensiveSearch=true.",
                        state,
                        warnings,
                        notices));
                    return;
                }

                List<ViewSchedule> sourceSchedules = ResolveSourceSchedules(document, warnings, deadlineUtc, state);
                if (state.Partial)
                {
                    Complete(BuildCompletedResult(sourceSchedules.Count, 0, new List<Dictionary<string, object>>(), new List<Dictionary<string, object>>(), state, warnings, notices));
                    return;
                }

                bool hasExplicitIds = _request.ScheduleIds.Count > 0;
                bool hasNameQuery = !string.IsNullOrWhiteSpace(_request.NameQuery);
                bool hasCellQuery = !string.IsNullOrWhiteSpace(_request.CellQuery);
                bool shouldReadSections = _request.IncludeCells || _request.ScanCells;
                int candidateCount = 0;
                List<Dictionary<string, object>> schedules = new List<Dictionary<string, object>>();
                List<Dictionary<string, object>> matches = new List<Dictionary<string, object>>();

                if (!hasExplicitIds && hasCellQuery && !hasNameQuery)
                {
                    warnings.Add("Cell scan is bounded by maxSchedules/maxRowsPerSection/maxColumnsPerSection/maxCells. Use nameQuery or scheduleIds first for large projects.");
                }

                foreach (ViewSchedule schedule in sourceSchedules.OrderBy(s => s.Name))
                {
                    if (StopIfNeeded(deadlineUtc, state)) break;

                    bool nameMatches = hasNameQuery && AnnotationEvidenceHelpers.ContainsPreNormalized(schedule.Name, _request.NormalizedNameQuery);
                    if (!hasExplicitIds && hasNameQuery && !nameMatches)
                    {
                        continue;
                    }

                    candidateCount++;
                    if (!hasExplicitIds && candidateCount > _request.MaxSchedules)
                    {
                        state.Stop("max_items");
                        break;
                    }
                    if (nameMatches) state.ScheduleNameMatchedCount++;

                    List<Dictionary<string, object>> sectionResults = new List<Dictionary<string, object>>();
                    int scheduleMatchCount = 0;
                    if (shouldReadSections)
                    {
                        state.ScannedScheduleCount++;
                        foreach (string sectionName in _request.Sections)
                        {
                            if (StopIfNeeded(deadlineUtc, state)) break;
                            int sectionMatchCount;
                            Dictionary<string, object> sectionResult = ReadSection(schedule, sectionName, deadlineUtc, state, warnings, matches, out sectionMatchCount);
                            if (sectionResult != null)
                            {
                                sectionResults.Add(sectionResult);
                            }
                            scheduleMatchCount += sectionMatchCount;
                            if (state.Partial) break;
                        }
                    }

                    bool includeSchedule = hasExplicitIds || nameMatches || (!hasNameQuery && !hasCellQuery) || scheduleMatchCount > 0;
                    if (!includeSchedule) continue;
                    if (scheduleMatchCount > 0) state.CellMatchedScheduleCount++;

                    Dictionary<string, object> scheduleRecord = AnnotationEvidenceHelpers.BuildScheduleRecord(schedule, nameMatches, scheduleMatchCount, sectionResults);
                    state.LastReadItemId = schedule.Id.GetIdValue();
                    if (!AddRecordIfWithinResponseBudget(scheduleRecord, state)) break;
                    schedules.Add(scheduleRecord);
                    if (state.Partial) break;
                }

                Complete(BuildCompletedResult(sourceSchedules.Count, candidateCount, schedules, matches, state, warnings, notices));
            }
            catch (Exception ex)
            {
                Complete(new InspectSchedulesResult
                {
                    Success = false,
                    Guarded = false,
                    State = "failed",
                    Action = "inspect_schedules",
                    Error = ex.Message,
                    Query = _request.Query,
                    NameQuery = _request.NameQuery,
                    CellQuery = _request.CellQuery,
                    ScanPolicy = BuildScanPolicy(),
                    Partial = false,
                    ScanStoppedReason = "read_failed",
                    ScannedScheduleCount = state.ScannedScheduleCount,
                    ScannedSectionCount = state.ScannedSectionCount,
                    ScannedRowCount = state.ScannedRowCount,
                    ScannedColumnCount = state.ScannedColumnCount,
                    ScannedCellCount = state.ScannedCellCount,
                    EstimatedResponseBytes = state.EstimatedResponseBytes,
                    MaxResponseBytes = _request.MaxResponseBytes,
                    LastReadSection = state.LastReadSection,
                    LastReadRow = state.LastReadRow,
                    LastReadColumn = state.LastReadColumn,
                    LastReadSheetId = null,
                    LastReadViewId = null,
                    LastReadViewportId = null,
                    LastReadItemId = state.LastReadItemId,
                    SuggestedNextScopes = AnnotationEvidenceHelpers.BuildScheduleSuggestedNextScopes(),
                    Warnings = warnings,
                    Notices = notices,
                    Schedules = new List<Dictionary<string, object>>(),
                    Matches = new List<Dictionary<string, object>>()
                });
            }
        }

        private Dictionary<string, object> ReadSection(
            ViewSchedule schedule,
            string sectionName,
            DateTime deadlineUtc,
            ScheduleScanState state,
            List<string> warnings,
            List<Dictionary<string, object>> flatMatches,
            out int matchCount)
        {
            matchCount = 0;
            string normalizedSection = AnnotationEvidenceHelpers.NormalizeSectionName(sectionName);
            SectionType sectionType = AnnotationEvidenceHelpers.SectionTypeForName(normalizedSection);
            List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
            List<Dictionary<string, object>> matches = new List<Dictionary<string, object>>();
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
                warnings.Add("Schedule section read failed for " + schedule.Name + " / " + normalizedSection + ": " + ex.Message);
            }

            int rowStart = Math.Min(Math.Max(0, _request.StartRow), Math.Max(0, rowCount));
            int columnStart = Math.Min(Math.Max(0, _request.StartColumn), Math.Max(0, columnCount));
            int rowEnd = Math.Min(rowCount, rowStart + _request.MaxRowsPerSection);
            int columnEnd = Math.Min(columnCount, columnStart + _request.MaxColumnsPerSection);
            bool shouldReadCells = !readFailed && (_request.IncludeCells || (_request.ScanCells && !string.IsNullOrWhiteSpace(_request.CellQuery)));
            int scannedRows = 0;
            int scannedColumns = 0;
            int scannedCells = 0;
            int lastReadRow = -1;
            int lastReadColumn = -1;

            state.ScannedSectionCount++;
            if (shouldReadCells)
            {
                for (int row = rowStart; row < rowEnd; row++)
                {
                    if (StopIfNeeded(deadlineUtc, state)) break;
                    Dictionary<string, object> rowRecord = new Dictionary<string, object>();
                    List<Dictionary<string, object>> cells = new List<Dictionary<string, object>>();
                    int rowColumnsScanned = 0;

                    for (int column = columnStart; column < columnEnd; column++)
                    {
                        if (state.ScannedCellCount >= _request.MaxCells)
                        {
                            state.Stop("max_cells");
                            break;
                        }

                        string text = AnnotationEvidenceHelpers.ReadScheduleCell(schedule, sectionType, row, column);
                        string trimmed = AnnotationEvidenceHelpers.TrimText(text, _request.MaxCellTextChars);
                        state.ScannedCellCount++;
                        scannedCells++;
                        rowColumnsScanned++;
                        lastReadRow = row;
                        lastReadColumn = column;
                        state.LastReadSection = normalizedSection;
                        state.LastReadRow = row;
                        state.LastReadColumn = column;
                        state.LastReadItemId = schedule.Id.GetIdValue();

                        if (_request.IncludeCells)
                        {
                            Dictionary<string, object> cellRecord = new Dictionary<string, object>();
                            cellRecord["column"] = column;
                            cellRecord["text"] = trimmed;
                            cells.Add(cellRecord);
                        }

                        if (!string.IsNullOrWhiteSpace(_request.CellQuery) && AnnotationEvidenceHelpers.ContainsPreNormalized(text, _request.NormalizedCellQuery))
                        {
                            Dictionary<string, object> match = new Dictionary<string, object>();
                            match["section"] = normalizedSection;
                            match["row"] = row;
                            match["column"] = column;
                            match["text"] = trimmed;
                            Dictionary<string, object> flatMatch = AnnotationEvidenceHelpers.BuildScheduleCellEvidenceRow(schedule, match);
                            if (!AddRecordIfWithinResponseBudget(match, state)) break;
                            if (!AddRecordIfWithinResponseBudget(flatMatch, state)) break;
                            matches.Add(match);
                            flatMatches.Add(flatMatch);
                            matchCount++;
                            state.TotalCellMatches++;
                        }
                    }

                    if (rowColumnsScanned > 0)
                    {
                        scannedRows++;
                        scannedColumns = Math.Max(scannedColumns, rowColumnsScanned);
                        state.ScannedRowCount++;
                        state.ScannedColumnCount = Math.Max(state.ScannedColumnCount, rowColumnsScanned);
                    }

                    if (_request.IncludeCells)
                    {
                        rowRecord["row"] = row;
                        rowRecord["cells"] = cells;
                        if (!AddRecordIfWithinResponseBudget(rowRecord, state)) break;
                        rows.Add(rowRecord);
                    }

                    if (state.Partial) break;
                }
            }

            Dictionary<string, object> sectionRecord = new Dictionary<string, object>();
            sectionRecord["section"] = normalizedSection;
            sectionRecord["rowCount"] = rowCount;
            sectionRecord["columnCount"] = columnCount;
            sectionRecord["startRow"] = rowStart;
            sectionRecord["startColumn"] = columnStart;
            sectionRecord["returnedRows"] = _request.IncludeCells ? rows.Count : 0;
            sectionRecord["returnedColumns"] = _request.IncludeCells ? scannedColumns : 0;
            sectionRecord["rowsTruncated"] = rowEnd < rowCount;
            sectionRecord["columnsTruncated"] = columnEnd < columnCount;
            sectionRecord["scannedRows"] = shouldReadCells ? scannedRows : 0;
            sectionRecord["scannedColumns"] = shouldReadCells ? scannedColumns : 0;
            sectionRecord["scannedCells"] = scannedCells;
            sectionRecord["lastReadRow"] = lastReadRow >= 0 ? (object)lastReadRow : null;
            sectionRecord["lastReadColumn"] = lastReadColumn >= 0 ? (object)lastReadColumn : null;
            sectionRecord["matches"] = matches;
            sectionRecord["cells"] = rows;
            sectionRecord["readFailed"] = readFailed;
            sectionRecord["readError"] = readError;
            return sectionRecord;
        }

        private List<ViewSchedule> ResolveSourceSchedules(Document document, List<string> warnings, DateTime deadlineUtc, ScheduleScanState state)
        {
            List<ViewSchedule> sourceSchedules = new List<ViewSchedule>();
            HashSet<int> requestedIds = new HashSet<int>();
            if (_request.ScheduleIds != null)
            {
                foreach (int id in _request.ScheduleIds)
                {
                    if (!requestedIds.Add(id))
                    {
                        continue;
                    }

                    ViewSchedule schedule = document.GetElement(new ElementId(id)) as ViewSchedule;
                    if (schedule != null && !schedule.IsTemplate)
                    {
                        sourceSchedules.Add(schedule);
                    }
                    else
                    {
                        warnings.Add("Schedule not found or is a template: " + id.ToString(CultureInfo.InvariantCulture));
                    }
                }
            }

            if (requestedIds.Count > 0)
            {
                return sourceSchedules;
            }

            using (FilteredElementCollector collector = new FilteredElementCollector(document))
            {
                foreach (Element element in collector.OfClass(typeof(ViewSchedule)))
                {
                    if (StopIfNeeded(deadlineUtc, state)) break;
                    ViewSchedule schedule = element as ViewSchedule;
                    if (schedule == null || schedule.IsTemplate) continue;
                    sourceSchedules.Add(schedule);
                }
            }

            return sourceSchedules;
        }

        private bool ShouldGuardNeedsScope()
        {
            bool hasScheduleScope = (_request.ScheduleIds != null && _request.ScheduleIds.Count > 0) || !string.IsNullOrWhiteSpace(_request.NameQuery);
            bool wantsCells = _request.IncludeCells || _request.ScanCells || !string.IsNullOrWhiteSpace(_request.CellQuery);
            return wantsCells && !hasScheduleScope && !_request.AllowExpensiveSearch;
        }

        private InspectSchedulesResult BuildGuardedResult(
            string reason,
            string message,
            ScheduleScanState state,
            List<string> warnings,
            List<string> notices)
        {
            return new InspectSchedulesResult
            {
                Success = true,
                Guarded = true,
                State = "guarded",
                Action = "inspect_schedules",
                Reason = reason,
                Message = message,
                Query = _request.Query,
                NameQuery = _request.NameQuery,
                CellQuery = _request.CellQuery,
                MaxSchedules = _request.MaxSchedules,
                Partial = false,
                ScanStoppedReason = reason,
                ScanPolicy = BuildScanPolicy(),
                SuggestedNextScopes = AnnotationEvidenceHelpers.BuildScheduleSuggestedNextScopes(),
                ScannedScheduleCount = state.ScannedScheduleCount,
                ScannedSectionCount = state.ScannedSectionCount,
                ScannedRowCount = state.ScannedRowCount,
                ScannedColumnCount = state.ScannedColumnCount,
                ScannedCellCount = state.ScannedCellCount,
                EstimatedResponseBytes = state.EstimatedResponseBytes,
                MaxResponseBytes = _request.MaxResponseBytes,
                LastReadSection = state.LastReadSection,
                LastReadRow = state.LastReadRow,
                LastReadColumn = state.LastReadColumn,
                LastReadSheetId = null,
                LastReadViewId = null,
                LastReadViewportId = null,
                LastReadItemId = state.LastReadItemId,
                Scan = BuildScan(state),
                Schedules = new List<Dictionary<string, object>>(),
                Matches = new List<Dictionary<string, object>>(),
                Warnings = warnings,
                Notices = notices
            };
        }

        private InspectSchedulesResult BuildCompletedResult(
            int totalSchedules,
            int candidateCount,
            List<Dictionary<string, object>> schedules,
            List<Dictionary<string, object>> matches,
            ScheduleScanState state,
            List<string> warnings,
            List<string> notices)
        {
            return new InspectSchedulesResult
            {
                Success = true,
                Guarded = false,
                State = "completed",
                Action = "inspect_schedules",
                Reason = null,
                Message = state.Partial ? "Schedule evidence returned before the native scan budget stopped." : "Schedule evidence collected.",
                Query = _request.Query,
                NameQuery = _request.NameQuery,
                CellQuery = _request.CellQuery,
                TotalSchedules = totalSchedules,
                CandidateCount = candidateCount,
                ReturnedCount = schedules.Count,
                Truncated = state.Partial,
                MaxSchedules = _request.MaxSchedules,
                Partial = state.Partial,
                ScanStoppedReason = state.Partial ? state.ScanStoppedReason : "completed",
                ScanPolicy = BuildScanPolicy(),
                SuggestedNextScopes = AnnotationEvidenceHelpers.BuildScheduleSuggestedNextScopes(),
                ScannedScheduleCount = state.ScannedScheduleCount,
                ScannedSectionCount = state.ScannedSectionCount,
                ScannedRowCount = state.ScannedRowCount,
                ScannedColumnCount = state.ScannedColumnCount,
                ScannedCellCount = state.ScannedCellCount,
                EstimatedResponseBytes = state.EstimatedResponseBytes,
                MaxResponseBytes = _request.MaxResponseBytes,
                LastReadSection = state.LastReadSection,
                LastReadRow = state.LastReadRow,
                LastReadColumn = state.LastReadColumn,
                LastReadSheetId = null,
                LastReadViewId = null,
                LastReadViewportId = null,
                LastReadItemId = state.LastReadItemId,
                Scan = BuildScan(state),
                Schedules = schedules,
                Matches = matches,
                Warnings = warnings,
                Notices = notices
            };
        }

        private object BuildScanPolicy()
        {
            return new
            {
                searchBudget = _request.SearchBudget,
                allowExpensiveSearch = _request.AllowExpensiveSearch,
                includeCells = _request.IncludeCells,
                scanCells = _request.ScanCells,
                sections = _request.Sections,
                maxElapsedMs = _request.MaxElapsedMs,
                timeoutMs = _request.TimeoutMs,
                maxSchedules = _request.MaxSchedules,
                maxRowsPerSection = _request.MaxRowsPerSection,
                maxColumnsPerSection = _request.MaxColumnsPerSection,
                startRow = _request.StartRow,
                startColumn = _request.StartColumn,
                maxCellTextChars = _request.MaxCellTextChars,
                maxCells = _request.MaxCells,
                maxResponseBytes = _request.MaxResponseBytes
            };
        }

        private object BuildScan(ScheduleScanState state)
        {
            return new
            {
                enabled = _request.ScanCells,
                includeCells = _request.IncludeCells,
                sections = _request.Sections,
                maxRowsPerSection = _request.MaxRowsPerSection,
                maxColumnsPerSection = _request.MaxColumnsPerSection,
                startRow = _request.StartRow,
                startColumn = _request.StartColumn,
                maxCells = _request.MaxCells,
                scannedScheduleCount = state.ScannedScheduleCount,
                scannedSectionCount = state.ScannedSectionCount,
                scannedRowCount = state.ScannedRowCount,
                scannedColumnCount = state.ScannedColumnCount,
                scannedCellCount = state.ScannedCellCount,
                scheduleNameMatchedCount = state.ScheduleNameMatchedCount,
                cellMatchedScheduleCount = state.CellMatchedScheduleCount,
                totalCellMatches = state.TotalCellMatches
            };
        }

        private bool StopIfNeeded(DateTime deadlineUtc, ScheduleScanState state)
        {
            if (state.Partial) return true;
            if (DateTime.UtcNow >= deadlineUtc)
            {
                state.Stop("max_elapsed");
                return true;
            }
            return false;
        }

        private bool AddRecordIfWithinResponseBudget(object record, ScheduleScanState state)
        {
            int bytes = AnnotationEvidenceHelpers.EstimateObjectBytes(record, AnnotationEvidenceByteEstimateKind.Schedule);
            if (state.EstimatedResponseBytes + bytes > _request.MaxResponseBytes)
            {
                state.Stop("max_bytes");
                return false;
            }

            state.EstimatedResponseBytes += bytes;
            return true;
        }

        private void Complete(InspectSchedulesResult result)
        {
            ResultInfo = result;
            TaskCompleted = true;
            _resetEvent.Set();
        }

        public string GetName()
        {
            return "InspectSchedulesEventHandler";
        }
    }
}
