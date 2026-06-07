using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Extensions;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;

namespace RevitMCPCommandSet.Commands.View
{
    public class AnnotationCountRequest
    {
        public string Query { get; set; }
        public string SheetQuery { get; set; }
        public List<int> SheetIds { get; set; }
        public string ViewNameQuery { get; set; }
        public List<string> Sources { get; set; }
        public bool SourcesExplicit { get; set; }
        public List<AnnotationCountProfile> Profiles { get; set; }
        public string CountMode { get; set; }
        public List<string> GroupBy { get; set; }
        public bool AllowExpensiveSearch { get; set; }
        public string SearchBudget { get; set; }
        public int MaxElapsedMs { get; set; }
        public int MaxSheets { get; set; }
        public int MaxViewportsPerSheet { get; set; }
        public int MaxTextNotesScanned { get; set; }
        public int MaxTagsScanned { get; set; }
        public int MaxMatches { get; set; }
        public int MaxTextChars { get; set; }
        public int MaxRegexPatternLength { get; set; }
        public int RegexTimeoutMs { get; set; }
        public int MaxResponseBytes { get; set; }
        public int TimeoutMs { get; set; }
        public string NormalizedSheetQuery { get; set; }
        public string NormalizedViewNameQuery { get; set; }
        public string ValidationError { get; set; }
        public string ValidationMessage { get; set; }
    }

    public class AnnotationCountProfile
    {
        public string ProfileName { get; set; }
        public List<AnnotationCountPattern> Patterns { get; set; }
    }

    public class AnnotationCountPattern
    {
        public string PatternName { get; set; }
        public string MatchMode { get; set; }
        public string Value { get; set; }
        public string NormalizedValue { get; set; }
        public Regex CompiledRegex { get; set; }
    }

    internal class AnnotationTextMatch
    {
        public string MatchedText { get; set; }
        public int MatchIndex { get; set; }
    }

    public class CountAnnotationsResult
    {
        public bool Success { get; set; }
        public bool Guarded { get; set; }
        public string State { get; set; }
        public string Action { get; set; }
        public string Reason { get; set; }
        public string Message { get; set; }
        public string Error { get; set; }
        public bool Partial { get; set; }
        public string ScanStoppedReason { get; set; }
        public object ScanPolicy { get; set; }
        public List<string> SuggestedNextScopes { get; set; }
        public object Summary { get; set; }
        public List<Dictionary<string, object>> EvidenceRows { get; set; }
        public List<Dictionary<string, object>> Matches { get; set; }
        public List<Dictionary<string, object>> Groups { get; set; }
        public string CountMode { get; set; }
        public int Count { get; set; }
        public int ScannedSheetCount { get; set; }
        public int ScannedViewportCount { get; set; }
        public int ScannedTextNoteCount { get; set; }
        public int ScannedTagCount { get; set; }
        public int MatchedOccurrenceCount { get; set; }
        public int EstimatedResponseBytes { get; set; }
        public int MaxResponseBytes { get; set; }
        public int? LastReadSheetId { get; set; }
        public int? LastReadViewId { get; set; }
        public int? LastReadViewportId { get; set; }
        public int? LastReadItemId { get; set; }
        public string LastReadSection { get; set; }
        public int? LastReadRow { get; set; }
        public int? LastReadColumn { get; set; }
        public List<string> Warnings { get; set; }
        public List<string> Notices { get; set; }
    }

    internal class AnnotationCountGroup
    {
        public string GroupKey { get; set; }
        public Dictionary<string, object> Fields { get; set; }
        public int Count { get; set; }
        public int OccurrenceCount { get; set; }
        public int EvidenceRowCount { get; set; }

        public Dictionary<string, object> ToRecord()
        {
            Dictionary<string, object> record = new Dictionary<string, object>();
            record["groupKey"] = GroupKey;
            foreach (KeyValuePair<string, object> field in Fields)
            {
                record[field.Key] = field.Value;
            }
            record["count"] = Count;
            record["occurrenceCount"] = OccurrenceCount;
            record["evidenceRowCount"] = EvidenceRowCount;
            return record;
        }
    }

    internal class AnnotationCountScanState
    {
        public bool Partial;
        public string ScanStoppedReason = "";
        public int ScannedSheetCount;
        public int ScannedViewportCount;
        public int ScannedTextNoteCount;
        public int ScannedTagCount;
        public int MatchedOccurrenceCount;
        public int Count;
        public int EstimatedResponseBytes = 2048;
        public int? LastReadSheetId;
        public int? LastReadViewId;
        public int? LastReadViewportId;
        public int? LastReadItemId;
        public Dictionary<string, AnnotationCountGroup> Groups = new Dictionary<string, AnnotationCountGroup>();
        public HashSet<string> CountedKeys = new HashSet<string>();

        public void Stop(string reason)
        {
            if (!Partial)
            {
                Partial = true;
                ScanStoppedReason = reason;
            }
        }
    }

    public class CountAnnotationsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private AnnotationCountRequest _request;

        public CountAnnotationsResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetRequest(AnnotationCountRequest request)
        {
            _request = request ?? new AnnotationCountRequest();
            if (_request.SheetIds == null) _request.SheetIds = new List<int>();
            if (_request.Sources == null || _request.Sources.Count == 0) _request.Sources = new List<string> { "sheet_text_notes", "viewport_tags" };
            if (_request.GroupBy == null) _request.GroupBy = new List<string>();
            if (_request.Profiles == null || _request.Profiles.Count == 0)
            {
                _request.Profiles = new List<AnnotationCountProfile>
                {
                    new AnnotationCountProfile
                    {
                        ProfileName = "anonymous",
                        Patterns = new List<AnnotationCountPattern>
                        {
                            new AnnotationCountPattern { PatternName = "anonymous.all.1", MatchMode = "contains", Value = "" }
                        }
                    }
                };
            }
            _request.NormalizedSheetQuery = AnnotationEvidenceHelpers.NormalizeForSearch(_request.SheetQuery);
            _request.NormalizedViewNameQuery = AnnotationEvidenceHelpers.NormalizeForSearch(_request.ViewNameQuery);
            ValidateAndPrepareProfiles();
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
            AnnotationCountScanState state = new AnnotationCountScanState();
            List<string> warnings = new List<string>();
            List<string> notices = new List<string>();
            List<Dictionary<string, object>> evidenceRows = new List<Dictionary<string, object>>();
            DateTime deadlineUtc = DateTime.UtcNow.AddMilliseconds(_request.MaxElapsedMs);

            try
            {
                UIDocument uiDocument = app.ActiveUIDocument;
                if (uiDocument == null)
                {
                    throw new InvalidOperationException("No active document found in Revit.");
                }
                Document document = uiDocument.Document;

                if (HasInvalidSource())
                {
                    Complete(BuildGuardedResult(
                        "invalid_source",
                        "count_annotations currently supports sheet_text_notes and viewport_tags sources.",
                        state,
                        warnings,
                        notices));
                    return;
                }

                if (HasInvalidCountModeForSources())
                {
                    Complete(BuildGuardedResult(
                        "invalid_count_mode_for_sources",
                        "uniqueTag and uniqueTaggedElement count modes require viewport_tags as the only source. Omit sources to let the tool default to viewport_tags.",
                        state,
                        warnings,
                        notices));
                    return;
                }

                if (!string.IsNullOrWhiteSpace(_request.ValidationError))
                {
                    Complete(BuildGuardedResult(
                        _request.ValidationError,
                        _request.ValidationMessage,
                        state,
                        warnings,
                        notices));
                    return;
                }

                if (ShouldGuardNeedsScope())
                {
                    Complete(BuildGuardedResult(
                        "needs_scope",
                        "Annotation counting can scan many sheets and placed views. Pass sheetQuery/sheetIds, or set allowExpensiveSearch=true with bounded caps.",
                        state,
                        warnings,
                        notices));
                    return;
                }

                List<ViewSheet> sourceSheets = ResolveSourceSheets(document, warnings, deadlineUtc, state);
                if (state.Partial)
                {
                    Complete(BuildCompletedResult(sourceSheets.Count, 0, state, evidenceRows, warnings, notices));
                    return;
                }

                bool hasExplicitIds = _request.SheetIds.Count > 0;
                bool hasSheetQuery = !string.IsNullOrWhiteSpace(_request.SheetQuery);
                int candidateCount = 0;

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
                        state.Stop("max_items");
                        break;
                    }

                    state.ScannedSheetCount++;
                    state.LastReadSheetId = sheet.Id.GetIdValue();
                    if (_request.Sources.Contains("sheet_text_notes"))
                    {
                        ScanSheetTextNotes(document, sheet, deadlineUtc, state, warnings, evidenceRows);
                        if (state.Partial && IsHardStop(state.ScanStoppedReason)) break;
                    }

                    if (_request.Sources.Contains("viewport_tags"))
                    {
                        ScanViewportTags(document, sheet, deadlineUtc, state, warnings, evidenceRows);
                        if (state.Partial && IsHardStop(state.ScanStoppedReason)) break;
                    }
                }

                Complete(BuildCompletedResult(sourceSheets.Count, candidateCount, state, evidenceRows, warnings, notices));
            }
            catch (Exception ex)
            {
                Complete(new CountAnnotationsResult
                {
                    Success = false,
                    Guarded = false,
                    State = "failed",
                    Action = "count_annotations",
                    Error = ex.Message,
                    Partial = false,
                    ScanStoppedReason = "read_failed",
                    ScanPolicy = BuildScanPolicy(),
                    SuggestedNextScopes = AnnotationEvidenceHelpers.BuildAnnotationCountSuggestedNextScopes(),
                    Summary = BuildSummary(0, 0, state, evidenceRows),
                    EvidenceRows = evidenceRows,
                    Matches = evidenceRows,
                    Groups = BuildGroupRecords(state),
                    CountMode = _request.CountMode,
                    Count = state.Count,
                    ScannedSheetCount = state.ScannedSheetCount,
                    ScannedViewportCount = state.ScannedViewportCount,
                    ScannedTextNoteCount = state.ScannedTextNoteCount,
                    ScannedTagCount = state.ScannedTagCount,
                    MatchedOccurrenceCount = state.MatchedOccurrenceCount,
                    EstimatedResponseBytes = state.EstimatedResponseBytes,
                    MaxResponseBytes = _request.MaxResponseBytes,
                    LastReadSheetId = state.LastReadSheetId,
                    LastReadViewId = state.LastReadViewId,
                    LastReadViewportId = state.LastReadViewportId,
                    LastReadItemId = state.LastReadItemId,
                    LastReadSection = null,
                    LastReadRow = null,
                    LastReadColumn = null,
                    Warnings = warnings,
                    Notices = notices
                });
            }
        }

        private void ScanSheetTextNotes(
            Document document,
            ViewSheet sheet,
            DateTime deadlineUtc,
            AnnotationCountScanState state,
            List<string> warnings,
            List<Dictionary<string, object>> evidenceRows)
        {
            if (state.ScannedTextNoteCount >= _request.MaxTextNotesScanned)
            {
                state.Stop("max_items");
                return;
            }
            if (!CanIterateSheetElements(document, sheet, warnings))
            {
                return;
            }

            using (FilteredElementCollector collector = new FilteredElementCollector(document, sheet.Id))
            {
                foreach (Element element in collector.OfClass(typeof(TextNote)).WhereElementIsNotElementType())
                {
                    if (StopIfNeeded(deadlineUtc, state)) return;
                    if (state.ScannedTextNoteCount >= _request.MaxTextNotesScanned)
                    {
                        state.Stop("max_items");
                        return;
                    }

                    TextNote textNote = element as TextNote;
                    if (textNote == null) continue;
                    state.ScannedTextNoteCount++;
                    state.LastReadItemId = textNote.Id.GetIdValue();

                    string text = AnnotationEvidenceHelpers.TrimText(AnnotationEvidenceHelpers.SafeText(textNote), _request.MaxTextChars);
                    Dictionary<string, object> record = AnnotationEvidenceHelpers.BuildTextNoteRecord("sheetTextNote", sheet, null, null, textNote, text, _request.MaxTextChars);
                    AddPatternEvidence(record, "sheetTextNote", text, state, warnings, evidenceRows);
                    if (state.Partial) return;
                }
            }
        }

        private void ScanViewportTags(
            Document document,
            ViewSheet sheet,
            DateTime deadlineUtc,
            AnnotationCountScanState state,
            List<string> warnings,
            List<Dictionary<string, object>> evidenceRows)
        {
            ICollection<ElementId> viewportIds = sheet.GetAllViewports();
            int considered = 0;
            foreach (ElementId viewportId in viewportIds)
            {
                if (StopIfNeeded(deadlineUtc, state)) return;
                if (considered >= _request.MaxViewportsPerSheet)
                {
                    state.Stop("max_items");
                    return;
                }

                Viewport viewport = document.GetElement(viewportId) as Viewport;
                if (viewport == null) continue;

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
                if (!CanIterateViewElements(document, view, warnings, sheet, viewport))
                {
                    continue;
                }

                considered++;
                state.ScannedViewportCount++;
                state.LastReadViewportId = viewport.Id.GetIdValue();
                state.LastReadViewId = view.Id.GetIdValue();

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
                        state.LastReadItemId = tag.Id.GetIdValue();
                        if (!AnnotationEvidenceHelpers.IsAnnotationElementVisibleInViewCrop(view, tag, warnings, "viewport_tag"))
                        {
                            continue;
                        }

                        string tagText = AnnotationEvidenceHelpers.TrimText(AnnotationEvidenceHelpers.SafeTagText(tag, warnings), _request.MaxTextChars);
                        if (string.IsNullOrWhiteSpace(tagText))
                        {
                            AnnotationEvidenceHelpers.AddOnce(warnings, "viewport_tag_text_unavailable");
                            continue;
                        }

                        Dictionary<string, object> record = AnnotationEvidenceHelpers.BuildViewportTagRecord(document, sheet, viewport, view, tag, tagText, _request.MaxTextChars, warnings);
                        AddPatternEvidence(record, "viewportTag", tagText, state, warnings, evidenceRows);
                        if (state.Partial) return;
                    }
                }
            }
        }

        private void AddPatternEvidence(
            Dictionary<string, object> record,
            string sourceType,
            string candidateText,
            AnnotationCountScanState state,
            List<string> warnings,
            List<Dictionary<string, object>> evidenceRows)
        {
            string trimmedCandidate = AnnotationEvidenceHelpers.TrimText(candidateText, _request.MaxTextChars);
            string normalizedCandidate = AnnotationEvidenceHelpers.NormalizeForSearch(trimmedCandidate);
            foreach (AnnotationCountProfile profile in _request.Profiles)
            {
                foreach (AnnotationCountPattern pattern in profile.Patterns)
                {
                    List<AnnotationTextMatch> matches = MatchPattern(pattern, trimmedCandidate, normalizedCandidate, warnings);
                    foreach (AnnotationTextMatch match in matches)
                    {
                        if (state.MatchedOccurrenceCount >= _request.MaxMatches)
                        {
                            state.Stop("max_items");
                            return;
                        }

                        Dictionary<string, object> row = AnnotationEvidenceHelpers.CloneRecord(record);
                        row["sourceType"] = sourceType;
                        row["profileName"] = profile.ProfileName;
                        row["patternName"] = pattern.PatternName;
                        row["matchMode"] = pattern.MatchMode;
                        row["matchedText"] = match.MatchedText;
                        row["matchedTextNormalized"] = AnnotationEvidenceHelpers.NormalizeForSearch(match.MatchedText);
                        row["matchIndex"] = match.MatchIndex;
                        row["countMode"] = _request.CountMode;
                        if (!AddRowIfWithinResponseBudget(row, state))
                        {
                            return;
                        }
                        RegisterCount(row, sourceType, state, warnings);
                        evidenceRows.Add(row);
                        state.MatchedOccurrenceCount++;
                    }
                }
            }
        }

        private List<AnnotationTextMatch> MatchPattern(
            AnnotationCountPattern pattern,
            string candidateText,
            string normalizedCandidate,
            List<string> warnings)
        {
            List<AnnotationTextMatch> matches = new List<AnnotationTextMatch>();
            string mode = pattern.MatchMode ?? "contains";
            string value = pattern.Value ?? "";
            string normalizedValue = pattern.NormalizedValue ?? "";
            if (mode == "exact")
            {
                if (normalizedCandidate == normalizedValue)
                {
                    matches.Add(new AnnotationTextMatch { MatchedText = candidateText, MatchIndex = 0 });
                }
                return matches;
            }
            if (mode == "startsWith")
            {
                if (string.IsNullOrWhiteSpace(normalizedValue) || normalizedCandidate.StartsWith(normalizedValue, StringComparison.Ordinal))
                {
                    matches.Add(new AnnotationTextMatch { MatchedText = string.IsNullOrWhiteSpace(value) ? candidateText : value, MatchIndex = 0 });
                }
                return matches;
            }
            if (mode == "regex" || mode == "normalizedRegex")
            {
                string candidate = mode == "normalizedRegex" ? normalizedCandidate : candidateText;
                try
                {
                    MatchCollection regexMatches = pattern.CompiledRegex.Matches(candidate);
                    int index = 0;
                    foreach (Match regexMatch in regexMatches)
                    {
                        if (!regexMatch.Success) continue;
                        matches.Add(new AnnotationTextMatch { MatchedText = regexMatch.Value, MatchIndex = index });
                        index++;
                    }
                }
                catch (RegexMatchTimeoutException)
                {
                    AnnotationEvidenceHelpers.AddOnce(warnings, "annotation_regex_match_timed_out");
                }
                return matches;
            }

            if (string.IsNullOrWhiteSpace(normalizedValue) || normalizedCandidate.Contains(normalizedValue))
            {
                matches.Add(new AnnotationTextMatch { MatchedText = string.IsNullOrWhiteSpace(value) ? candidateText : value, MatchIndex = 0 });
            }
            return matches;
        }

        private void RegisterCount(
            Dictionary<string, object> row,
            string sourceType,
            AnnotationCountScanState state,
            List<string> warnings)
        {
            Dictionary<string, object> groupFields = BuildGroupFields(row);
            string groupKey = BuildGroupKey(groupFields);
            AnnotationCountGroup group;
            if (!state.Groups.TryGetValue(groupKey, out group))
            {
                group = new AnnotationCountGroup
                {
                    GroupKey = groupKey,
                    Fields = groupFields,
                    Count = 0,
                    OccurrenceCount = 0,
                    EvidenceRowCount = 0
                };
                state.Groups[groupKey] = group;
                state.EstimatedResponseBytes += 128;
            }

            group.OccurrenceCount++;
            group.EvidenceRowCount++;
            string countToken = ResolveCountToken(row, sourceType, state, warnings);
            bool counted = !string.IsNullOrWhiteSpace(countToken) && state.CountedKeys.Add(groupKey + "||" + countToken);
            row["groupKey"] = groupKey;
            row["countKey"] = countToken;
            row["counted"] = counted;
            if (counted)
            {
                group.Count++;
                state.Count++;
            }
        }

        private string ResolveCountToken(IDictionary row, string sourceType, AnnotationCountScanState state, List<string> warnings)
        {
            if (_request.CountMode == "occurrence")
            {
                return "occurrence:" + state.MatchedOccurrenceCount.ToString(CultureInfo.InvariantCulture);
            }
            if (_request.CountMode == "uniqueText")
            {
                return "profile:" + ReadString(row, "profileName") + "|text:" + ReadString(row, "matchedTextNormalized");
            }
            if (_request.CountMode == "uniqueTag")
            {
                if (sourceType != "viewportTag") return "";
                string tagId = ReadString(row, "tagId");
                return string.IsNullOrWhiteSpace(tagId) ? "" : "tag:" + tagId;
            }
            if (_request.CountMode == "uniqueTaggedElement")
            {
                if (sourceType != "viewportTag") return "";
                bool resolved = ReadBool(row, "taggedElementResolved");
                string taggedElementId = ReadString(row, "taggedElementId");
                if (!resolved || string.IsNullOrWhiteSpace(taggedElementId))
                {
                    AnnotationEvidenceHelpers.AddOnce(warnings, "viewport_tag_tagged_element_unresolved_not_counted");
                    return "";
                }
                return "taggedElement:" + taggedElementId;
            }
            return "";
        }

        private Dictionary<string, object> BuildGroupFields(Dictionary<string, object> row)
        {
            Dictionary<string, object> fields = new Dictionary<string, object>();
            if (_request.GroupBy.Count == 0)
            {
                fields["group"] = "all";
                return fields;
            }

            foreach (string raw in _request.GroupBy)
            {
                string key = NormalizeGroupKey(raw);
                if (key == "sheet")
                {
                    fields["sheetId"] = ReadObject(row, "sheetId");
                    fields["sheetNumber"] = ReadObject(row, "sheetNumber");
                }
                else if (key == "view")
                {
                    fields["viewId"] = ReadObject(row, "viewId");
                    fields["viewName"] = ReadObject(row, "viewName");
                }
                else if (key == "sourceType")
                {
                    fields["sourceType"] = ReadObject(row, "sourceType");
                }
                else if (key == "profile")
                {
                    fields["profileName"] = ReadObject(row, "profileName");
                }
                else if (key == "pattern")
                {
                    fields["patternName"] = ReadObject(row, "patternName");
                }
                else if (key == "matchedText")
                {
                    fields["matchedTextNormalized"] = ReadObject(row, "matchedTextNormalized");
                }
                else if (key == "tagFamilyType")
                {
                    fields["tagFamilyName"] = ReadObject(row, "tagFamilyName");
                    fields["tagTypeName"] = ReadObject(row, "tagTypeName");
                }
                else if (key == "taggedElement")
                {
                    fields["taggedElementId"] = ReadObject(row, "taggedElementId");
                }
            }

            if (fields.Count == 0)
            {
                fields["group"] = "all";
            }
            return fields;
        }

        private static string BuildGroupKey(Dictionary<string, object> fields)
        {
            return string.Join("|", fields.OrderBy(kvp => kvp.Key).Select(kvp => kvp.Key + "=" + Convert.ToString(kvp.Value, CultureInfo.InvariantCulture)));
        }

        private static string NormalizeGroupKey(string value)
        {
            string normalized = (value ?? "").Trim();
            if (string.Equals(normalized, "source_type", StringComparison.OrdinalIgnoreCase) || string.Equals(normalized, "sourceType", StringComparison.OrdinalIgnoreCase)) return "sourceType";
            if (string.Equals(normalized, "profileName", StringComparison.OrdinalIgnoreCase) || string.Equals(normalized, "profile", StringComparison.OrdinalIgnoreCase)) return "profile";
            if (string.Equals(normalized, "patternName", StringComparison.OrdinalIgnoreCase) || string.Equals(normalized, "pattern", StringComparison.OrdinalIgnoreCase)) return "pattern";
            if (string.Equals(normalized, "matchedCode", StringComparison.OrdinalIgnoreCase) || string.Equals(normalized, "matchedText", StringComparison.OrdinalIgnoreCase) || string.Equals(normalized, "uniqueText", StringComparison.OrdinalIgnoreCase)) return "matchedText";
            if (string.Equals(normalized, "tagFamilyType", StringComparison.OrdinalIgnoreCase)) return "tagFamilyType";
            if (string.Equals(normalized, "taggedElementId", StringComparison.OrdinalIgnoreCase) || string.Equals(normalized, "taggedElement", StringComparison.OrdinalIgnoreCase)) return "taggedElement";
            if (string.Equals(normalized, "view", StringComparison.OrdinalIgnoreCase)) return "view";
            if (string.Equals(normalized, "sheet", StringComparison.OrdinalIgnoreCase)) return "sheet";
            return normalized;
        }

        private List<ViewSheet> ResolveSourceSheets(Document document, List<string> warnings, DateTime deadlineUtc, AnnotationCountScanState state)
        {
            List<ViewSheet> sourceSheets = new List<ViewSheet>();
            if (_request.SheetIds.Count > 0)
            {
                foreach (int id in _request.SheetIds)
                {
                    if (StopIfNeeded(deadlineUtc, state)) break;
                    ViewSheet sheet = document.GetElement(new ElementId(id)) as ViewSheet;
                    if (sheet == null)
                    {
                        warnings.Add("Requested sheetId not found: " + id.ToString(CultureInfo.InvariantCulture));
                        continue;
                    }
                    sourceSheets.Add(sheet);
                }
                return sourceSheets;
            }

            using (FilteredElementCollector collector = new FilteredElementCollector(document))
            {
                foreach (ViewSheet sheet in collector.OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
                {
                    if (StopIfNeeded(deadlineUtc, state)) break;
                    sourceSheets.Add(sheet);
                }
            }
            return sourceSheets;
        }

        private bool AddRowIfWithinResponseBudget(Dictionary<string, object> row, AnnotationCountScanState state)
        {
            int estimate = AnnotationEvidenceHelpers.EstimateObjectBytes(row, AnnotationEvidenceByteEstimateKind.SheetText);
            if (state.EstimatedResponseBytes + estimate > _request.MaxResponseBytes)
            {
                state.Stop("max_bytes");
                return false;
            }
            state.EstimatedResponseBytes += estimate;
            return true;
        }

        private bool StopIfNeeded(DateTime deadlineUtc, AnnotationCountScanState state)
        {
            if (state.Partial) return true;
            if (DateTime.UtcNow >= deadlineUtc)
            {
                state.Stop("max_elapsed");
                return true;
            }
            return false;
        }

        private bool ShouldGuardNeedsScope()
        {
            bool hasSheetScope = _request.SheetIds.Count > 0 || !string.IsNullOrWhiteSpace(_request.SheetQuery);
            return !hasSheetScope && !_request.AllowExpensiveSearch;
        }

        private bool HasInvalidSource()
        {
            foreach (string source in _request.Sources)
            {
                if (source != "sheet_text_notes" && source != "viewport_tags")
                {
                    return true;
                }
            }
            return false;
        }

        private bool HasInvalidCountModeForSources()
        {
            if (!(_request.CountMode == "uniqueTag" || _request.CountMode == "uniqueTaggedElement"))
            {
                return false;
            }
            if (!_request.SourcesExplicit)
            {
                return false;
            }
            return _request.Sources.Any(source => source != "viewport_tags");
        }

        private void ValidateAndPrepareProfiles()
        {
            foreach (AnnotationCountProfile profile in _request.Profiles)
            {
                if (string.IsNullOrWhiteSpace(profile.ProfileName)) profile.ProfileName = "anonymous";
                if (profile.Patterns == null) profile.Patterns = new List<AnnotationCountPattern>();
                foreach (AnnotationCountPattern pattern in profile.Patterns)
                {
                    if (string.IsNullOrWhiteSpace(pattern.MatchMode)) pattern.MatchMode = "contains";
                    if (!(pattern.MatchMode == "exact" || pattern.MatchMode == "contains" || pattern.MatchMode == "startsWith" || pattern.MatchMode == "regex" || pattern.MatchMode == "normalizedRegex"))
                    {
                        pattern.MatchMode = "contains";
                    }
                    if (string.IsNullOrWhiteSpace(pattern.PatternName)) pattern.PatternName = profile.ProfileName + "." + pattern.MatchMode;
                    pattern.Value = pattern.Value ?? "";
                    pattern.NormalizedValue = AnnotationEvidenceHelpers.NormalizeForSearch(pattern.Value);
                    if ((pattern.MatchMode == "regex" || pattern.MatchMode == "normalizedRegex") && pattern.Value.Length > _request.MaxRegexPatternLength)
                    {
                        _request.ValidationError = "invalid_regex";
                        _request.ValidationMessage = "Regex pattern exceeds maxRegexPatternLength.";
                        return;
                    }
                    if (pattern.MatchMode == "regex" || pattern.MatchMode == "normalizedRegex")
                    {
                        try
                        {
                            pattern.CompiledRegex = new Regex(pattern.Value, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(_request.RegexTimeoutMs));
                        }
                        catch (Exception ex)
                        {
                            _request.ValidationError = "invalid_regex";
                            _request.ValidationMessage = "Invalid annotation regex pattern: " + ex.Message;
                            return;
                        }
                    }
                }
            }
        }

        private CountAnnotationsResult BuildGuardedResult(
            string reason,
            string message,
            AnnotationCountScanState state,
            List<string> warnings,
            List<string> notices)
        {
            return new CountAnnotationsResult
            {
                Success = true,
                Guarded = true,
                State = "guarded",
                Action = "count_annotations",
                Reason = reason,
                Message = message,
                Partial = false,
                ScanStoppedReason = "needs_scope",
                ScanPolicy = BuildScanPolicy(),
                SuggestedNextScopes = AnnotationEvidenceHelpers.BuildAnnotationCountSuggestedNextScopes(),
                Summary = BuildSummary(0, 0, state, new List<Dictionary<string, object>>()),
                EvidenceRows = new List<Dictionary<string, object>>(),
                Matches = new List<Dictionary<string, object>>(),
                Groups = new List<Dictionary<string, object>>(),
                CountMode = _request.CountMode,
                Count = 0,
                ScannedSheetCount = state.ScannedSheetCount,
                ScannedViewportCount = state.ScannedViewportCount,
                ScannedTextNoteCount = state.ScannedTextNoteCount,
                ScannedTagCount = state.ScannedTagCount,
                MatchedOccurrenceCount = state.MatchedOccurrenceCount,
                EstimatedResponseBytes = state.EstimatedResponseBytes,
                MaxResponseBytes = _request.MaxResponseBytes,
                LastReadSheetId = state.LastReadSheetId,
                LastReadViewId = state.LastReadViewId,
                LastReadViewportId = state.LastReadViewportId,
                LastReadItemId = state.LastReadItemId,
                LastReadSection = null,
                LastReadRow = null,
                LastReadColumn = null,
                Warnings = warnings,
                Notices = notices
            };
        }

        private CountAnnotationsResult BuildCompletedResult(
            int totalSheets,
            int candidateCount,
            AnnotationCountScanState state,
            List<Dictionary<string, object>> evidenceRows,
            List<string> warnings,
            List<string> notices)
        {
            string stopReason = state.Partial ? state.ScanStoppedReason : "completed";
            return new CountAnnotationsResult
            {
                Success = true,
                Guarded = false,
                State = state.Partial ? "partial" : "completed",
                Action = "count_annotations",
                Partial = state.Partial,
                ScanStoppedReason = stopReason,
                ScanPolicy = BuildScanPolicy(),
                SuggestedNextScopes = AnnotationEvidenceHelpers.BuildAnnotationCountSuggestedNextScopes(),
                Summary = BuildSummary(totalSheets, candidateCount, state, evidenceRows),
                EvidenceRows = evidenceRows,
                Matches = evidenceRows,
                Groups = BuildGroupRecords(state),
                CountMode = _request.CountMode,
                Count = state.Count,
                ScannedSheetCount = state.ScannedSheetCount,
                ScannedViewportCount = state.ScannedViewportCount,
                ScannedTextNoteCount = state.ScannedTextNoteCount,
                ScannedTagCount = state.ScannedTagCount,
                MatchedOccurrenceCount = state.MatchedOccurrenceCount,
                EstimatedResponseBytes = state.EstimatedResponseBytes,
                MaxResponseBytes = _request.MaxResponseBytes,
                LastReadSheetId = state.LastReadSheetId,
                LastReadViewId = state.LastReadViewId,
                LastReadViewportId = state.LastReadViewportId,
                LastReadItemId = state.LastReadItemId,
                LastReadSection = null,
                LastReadRow = null,
                LastReadColumn = null,
                Warnings = warnings,
                Notices = notices
            };
        }

        private Dictionary<string, object> BuildSummary(
            int totalSheets,
            int candidateCount,
            AnnotationCountScanState state,
            List<Dictionary<string, object>> evidenceRows)
        {
            Dictionary<string, object> summary = new Dictionary<string, object>();
            summary["count"] = state.Count;
            summary["countMode"] = _request.CountMode;
            summary["occurrenceCount"] = state.MatchedOccurrenceCount;
            summary["matchCount"] = evidenceRows.Count;
            summary["evidenceRowCount"] = evidenceRows.Count;
            summary["groupCount"] = state.Groups.Count;
            summary["totalSheets"] = totalSheets;
            summary["candidateCount"] = candidateCount;
            summary["scannedSheetCount"] = state.ScannedSheetCount;
            summary["scannedViewportCount"] = state.ScannedViewportCount;
            summary["scannedTextNoteCount"] = state.ScannedTextNoteCount;
            summary["scannedTagCount"] = state.ScannedTagCount;
            summary["partial"] = state.Partial;
            summary["scanStoppedReason"] = state.Partial ? state.ScanStoppedReason : "completed";
            summary["sources"] = _request.Sources;
            summary["profileCount"] = _request.Profiles.Count;
            summary["patternCount"] = _request.Profiles.Sum(profile => profile.Patterns.Count);
            return summary;
        }

        private List<Dictionary<string, object>> BuildGroupRecords(AnnotationCountScanState state)
        {
            return state.Groups.Values
                .OrderBy(group => group.GroupKey)
                .Select(group => group.ToRecord())
                .ToList();
        }

        private Dictionary<string, object> BuildScanPolicy()
        {
            Dictionary<string, object> policy = new Dictionary<string, object>();
            policy["searchBudget"] = _request.SearchBudget;
            policy["allowExpensiveSearch"] = _request.AllowExpensiveSearch;
            policy["sources"] = _request.Sources;
            policy["countMode"] = _request.CountMode;
            policy["groupBy"] = _request.GroupBy;
            policy["maxElapsedMs"] = _request.MaxElapsedMs;
            policy["timeoutMs"] = _request.TimeoutMs;
            policy["maxSheets"] = _request.MaxSheets;
            policy["maxViewportsPerSheet"] = _request.MaxViewportsPerSheet;
            policy["maxTextNotesScanned"] = _request.MaxTextNotesScanned;
            policy["maxTagsScanned"] = _request.MaxTagsScanned;
            policy["maxMatches"] = _request.MaxMatches;
            policy["maxTextChars"] = _request.MaxTextChars;
            policy["maxRegexPatternLength"] = _request.MaxRegexPatternLength;
            policy["regexTimeoutMs"] = _request.RegexTimeoutMs;
            policy["maxResponseBytes"] = _request.MaxResponseBytes;
            policy["sheetScoped"] = _request.SheetIds.Count > 0 || !string.IsNullOrWhiteSpace(_request.SheetQuery);
            return policy;
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

        private static bool CanIterateSheetElements(
            Document document,
            ViewSheet sheet,
            List<string> warnings)
        {
            try
            {
                if (FilteredElementCollector.IsViewValidForElementIteration(document, sheet.Id))
                {
                    return true;
                }
            }
            catch (Exception ex)
            {
                warnings.Add("Sheet text note iteration check failed on sheet " + sheet.SheetNumber + ": " + ex.Message);
                return false;
            }

            warnings.Add("Skipped sheet text note scan because the sheet is not valid for element iteration: " + sheet.SheetNumber);
            return false;
        }

        private static bool IsHardStop(string reason)
        {
            return reason == "max_elapsed" || reason == "max_bytes" || reason == "max_items";
        }

        private void Complete(CountAnnotationsResult result)
        {
            ResultInfo = result;
            TaskCompleted = true;
            _resetEvent.Set();
        }

        public string GetName()
        {
            return "CountAnnotationsEventHandler";
        }

        private static object ReadObject(IDictionary row, string key)
        {
            return row != null && row.Contains(key) ? row[key] : null;
        }

        private static string ReadString(IDictionary row, string key)
        {
            object value = ReadObject(row, key);
            return value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) ?? "" : "";
        }

        private static bool ReadBool(IDictionary row, string key)
        {
            object value = ReadObject(row, key);
            if (value is bool) return (bool)value;
            bool parsed;
            return bool.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), out parsed) && parsed;
        }
    }
}
