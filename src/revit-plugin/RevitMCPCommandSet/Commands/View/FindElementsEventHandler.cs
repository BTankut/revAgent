using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

namespace RevitMCPCommandSet.Commands.View
{
    public class FindElementsResult
    {
        public bool Success { get; set; }
        public bool Guarded { get; set; }
        public string State { get; set; }
        public string Reason { get; set; }
        public string Action { get; set; }
        public string Message { get; set; }
        public string Error { get; set; }
        public string OriginalQuery { get; set; }
        public string Query { get; set; }
        public List<string> CategoryNames { get; set; }
        public int Count { get; set; }
        public bool Truncated { get; set; }
        public bool Ambiguous { get; set; }
        public int TopScore { get; set; }
        public string TopConfidence { get; set; }
        public int TopScoreTiedCount { get; set; }
        public string SelectionHint { get; set; }
        public string PlanCandidateMode { get; set; }
        public object InferredScope { get; set; }
        public object EffectiveScope { get; set; }
        public object ScanPolicy { get; set; }
        public int ScannedElementCount { get; set; }
        public int CandidateElementCount { get; set; }
        public bool Partial { get; set; }
        public string ScanStoppedReason { get; set; }
        public List<string> SuggestedNextScopes { get; set; }
        public List<string> Warnings { get; set; }
        public List<ElementSearchItem> Elements { get; set; }
    }

    public class FindElementsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const int VerifiedPlanCandidateMaxMatchesWithoutApproval = 3;
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private string _originalQuery;
        private string _query;
        private List<string> _categoryNames = new List<string>();
        private List<int> _elementIds = new List<int>();
        private List<string> _uniqueIds = new List<string>();
        private List<string> _levelNames = new List<string>();
        private List<int> _levelIds = new List<int>();
        private bool _activeViewOnly;
        private int? _viewId;
        private string _familyName;
        private string _typeName;
        private string _systemName;
        private List<string> _worksetNames = new List<string>();
        private List<int> _worksetIds = new List<int>();
        private string _linkScope;
        private string _searchBudget;
        private bool _allowExpensiveSearch;
        private int _maxElementsScanned;
        private int _maxElapsedMs;
        private bool _includePlanCandidates;
        private string _planCandidateMode;
        private string _planNameContains;
        private int _limit;
        private int _maxPlanCandidates;
        private object _inferredScope;

        public FindElementsResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetRequest(
            string originalQuery,
            string query,
            List<string> categoryNames,
            List<int> elementIds,
            List<string> uniqueIds,
            List<string> levelNames,
            List<int> levelIds,
            bool activeViewOnly,
            int? viewId,
            string familyName,
            string typeName,
            string systemName,
            List<string> worksetNames,
            List<int> worksetIds,
            string linkScope,
            string searchBudget,
            bool allowExpensiveSearch,
            int maxElementsScanned,
            int maxElapsedMs,
            bool includePlanCandidates,
            string planCandidateMode,
            string planNameContains,
            int limit,
            int maxPlanCandidates,
            object inferredScope)
        {
            _originalQuery = originalQuery ?? "";
            _query = query ?? "";
            _categoryNames = categoryNames ?? new List<string>();
            _elementIds = elementIds ?? new List<int>();
            _uniqueIds = uniqueIds ?? new List<string>();
            _levelNames = levelNames ?? new List<string>();
            _levelIds = levelIds ?? new List<int>();
            _activeViewOnly = activeViewOnly;
            _viewId = viewId;
            _familyName = familyName ?? "";
            _typeName = typeName ?? "";
            _systemName = systemName ?? "";
            _worksetNames = worksetNames ?? new List<string>();
            _worksetIds = worksetIds ?? new List<int>();
            _linkScope = string.IsNullOrWhiteSpace(linkScope) ? "hostOnly" : linkScope;
            _searchBudget = string.IsNullOrWhiteSpace(searchBudget) ? "fast" : searchBudget;
            _allowExpensiveSearch = allowExpensiveSearch;
            _maxElementsScanned = Math.Max(1, Math.Min(500000, maxElementsScanned));
            _maxElapsedMs = Math.Max(500, Math.Min(119000, maxElapsedMs));
            _includePlanCandidates = includePlanCandidates;
            _planCandidateMode = string.IsNullOrWhiteSpace(planCandidateMode) ? "none" : planCandidateMode;
            _planNameContains = planNameContains ?? "";
            _limit = limit;
            _maxPlanCandidates = Math.Max(0, Math.Min(25, maxPlanCandidates));
            _inferredScope = inferredScope;
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
            int scannedElementCount = 0;
            int candidateElementCount = 0;
            bool partial = false;
            string stoppedReason = "";
            List<string> warnings = new List<string>();

            try
            {
                UIDocument uiDocument = app.ActiveUIDocument;
                Document document = uiDocument.Document;

                if (!HasAnySearchScope())
                {
                    Complete(BuildGuardedResult(
                        "needs_scope",
                        "Pass query, categoryNames, elementIds, uniqueIds, or another bounded filter before searching.",
                        scannedElementCount,
                        candidateElementCount,
                        warnings));
                    return;
                }

                DateTime deadlineUtc = DateTime.UtcNow.AddMilliseconds(_maxElapsedMs);
                List<Tuple<Element, SearchMatchSummary, Document, RevitLinkInstance>> matches =
                    new List<Tuple<Element, SearchMatchSummary, Document, RevitLinkInstance>>();

                if (IsLinkedOnlyHostElementIdSearch())
                {
                    Complete(BuildGuardedResult(
                        "needs_scope",
                        "Numeric elementIds are scoped to the host document. Pass uniqueIds, query/category scope, or another linked-document filter before searching linked documents.",
                        scannedElementCount,
                        candidateElementCount,
                        warnings));
                    return;
                }

                if (ShouldSearchHostExactMatches())
                {
                    AddExactElementMatches(document, null, matches, warnings, ref scannedElementCount, ref candidateElementCount, deadlineUtc, ref partial, ref stoppedReason);
                }

                if (!partial && ShouldSearchHostCollector())
                {
                    SearchDocument(document, uiDocument, null, matches, warnings, ref scannedElementCount, ref candidateElementCount, deadlineUtc, ref partial, ref stoppedReason);
                }

                if (!partial && ShouldSearchLinkedUniqueIds())
                {
                    SearchLinkedUniqueIds(document, matches, warnings, ref scannedElementCount, ref candidateElementCount, deadlineUtc, ref partial, ref stoppedReason);
                }

                if (!partial && ShouldSearchLinks())
                {
                    SearchLinkedDocuments(document, matches, warnings, ref scannedElementCount, ref candidateElementCount, deadlineUtc, ref partial, ref stoppedReason);
                }

                List<Tuple<Element, SearchMatchSummary, Document, RevitLinkInstance>> orderedMatches = matches
                    .OrderByDescending(m => m.Item2.Score)
                    .ThenBy(m => m.Item1.Id.GetIdValue())
                    .ToList();

                if (IsVerifiedPlanCandidateMode() && !CanRunVerifiedPlanCandidates(orderedMatches.Count))
                {
                    _planCandidateMode = "metadata";
                    warnings.Add("verified plan candidate visibility was downgraded to metadata because the matched set is too broad without allowExpensiveSearch.");
                    warnings.Add("verified_visibility_expensive");
                }

                bool planCandidateStopped = false;
                List<ElementSearchItem> items = new List<ElementSearchItem>();
                foreach (Tuple<Element, SearchMatchSummary, Document, RevitLinkInstance> match in orderedMatches.Take(_limit))
                {
                    ElementSearchItem item = BuildSearchItem(match.Item3, uiDocument, match.Item1, match.Item4, match.Item2, deadlineUtc, ref planCandidateStopped, ref stoppedReason);
                    if (item != null)
                    {
                        items.Add(item);
                    }
                    if (planCandidateStopped)
                    {
                        partial = true;
                        break;
                    }
                }

                foreach (ElementSearchItem item in items)
                {
                    TrimPlanCandidates(item);
                }

                int topScore = orderedMatches.Count > 0 ? orderedMatches[0].Item2.Score : 0;
                int tiedCount = topScore > 0 ? orderedMatches.Count(m => m.Item2.Score == topScore) : 0;
                string topConfidence = orderedMatches.Count > 0 ? orderedMatches[0].Item2.Confidence : "none";
                bool ambiguous = orderedMatches.Count > 1 && (tiedCount > 1 || !string.Equals(topConfidence, "high", StringComparison.OrdinalIgnoreCase));
                string selectionHint = orderedMatches.Count == 0
                    ? "No matching elements found. Narrow or adjust the query, category, level, family/type, system, active view, or workset scope."
                    : ambiguous
                        ? "Multiple plausible matches were found. Use elementId, mark, level, system, family/type, or a more specific query before making changes."
                        : "Top match is the best current candidate; still verify level, mark, and plan before making changes.";

                Complete(new FindElementsResult
                {
                    Success = true,
                    Guarded = false,
                    State = partial ? "completed" : "completed",
                    Action = "find_elements",
                    Message = orderedMatches.Count == 0
                        ? "No matching elements found."
                        : partial
                            ? "Matching Revit elements were found before the scan budget stopped."
                            : "Matching Revit elements were found.",
                    OriginalQuery = _originalQuery,
                    Query = _query,
                    CategoryNames = _categoryNames,
                    Count = orderedMatches.Count,
                    Truncated = orderedMatches.Count > items.Count || partial,
                    Ambiguous = ambiguous,
                    TopScore = topScore,
                    TopConfidence = topConfidence,
                    TopScoreTiedCount = tiedCount,
                    SelectionHint = selectionHint,
                    PlanCandidateMode = _planCandidateMode,
                    InferredScope = _inferredScope,
                    EffectiveScope = BuildEffectiveScope(),
                    ScanPolicy = BuildScanPolicy(),
                    ScannedElementCount = scannedElementCount,
                    CandidateElementCount = candidateElementCount,
                    Partial = partial,
                    ScanStoppedReason = stoppedReason,
                    SuggestedNextScopes = BuildSuggestedNextScopes(),
                    Warnings = warnings,
                    Elements = items
                });
            }
            catch (Exception ex)
            {
                Complete(new FindElementsResult
                {
                    Success = false,
                    State = "failed",
                    Action = "find_elements",
                    Error = ex.Message,
                    OriginalQuery = _originalQuery,
                    Query = _query,
                    CategoryNames = _categoryNames,
                    InferredScope = _inferredScope,
                    EffectiveScope = BuildEffectiveScope(),
                    ScanPolicy = BuildScanPolicy(),
                    ScannedElementCount = scannedElementCount,
                    CandidateElementCount = candidateElementCount,
                    Partial = partial,
                    ScanStoppedReason = stoppedReason,
                    Warnings = warnings
                });
            }
        }

        private bool HasAnySearchScope()
        {
            return !string.IsNullOrWhiteSpace(_query)
                || _categoryNames.Count > 0
                || _elementIds.Count > 0
                || _uniqueIds.Count > 0
                || _levelNames.Count > 0
                || _levelIds.Count > 0
                || _activeViewOnly
                || _viewId.HasValue
                || !string.IsNullOrWhiteSpace(_familyName)
                || !string.IsNullOrWhiteSpace(_typeName)
                || !string.IsNullOrWhiteSpace(_systemName)
                || _worksetNames.Count > 0
                || _worksetIds.Count > 0;
        }

        private bool ShouldSearchHostCollector()
        {
            return _elementIds.Count == 0 && _uniqueIds.Count == 0 &&
                !string.Equals(_linkScope, "linkedOnly", StringComparison.OrdinalIgnoreCase);
        }

        private bool ShouldSearchHostExactMatches()
        {
            return (_elementIds.Count > 0 || _uniqueIds.Count > 0) &&
                !string.Equals(_linkScope, "linkedOnly", StringComparison.OrdinalIgnoreCase);
        }

        private bool ShouldSearchLinks()
        {
            return HasCollectorSearchScope() &&
                (string.Equals(_linkScope, "linkedOnly", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(_linkScope, "hostAndLinked", StringComparison.OrdinalIgnoreCase));
        }

        private bool ShouldSearchLinkedUniqueIds()
        {
            return _uniqueIds.Count > 0 &&
                (string.Equals(_linkScope, "linkedOnly", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(_linkScope, "hostAndLinked", StringComparison.OrdinalIgnoreCase));
        }

        private bool HasCollectorSearchScope()
        {
            return !string.IsNullOrWhiteSpace(_query)
                || _categoryNames.Count > 0
                || _levelNames.Count > 0
                || _levelIds.Count > 0
                || _activeViewOnly
                || _viewId.HasValue
                || !string.IsNullOrWhiteSpace(_familyName)
                || !string.IsNullOrWhiteSpace(_typeName)
                || !string.IsNullOrWhiteSpace(_systemName)
                || _worksetNames.Count > 0
                || _worksetIds.Count > 0;
        }

        private bool IsLinkedOnlyHostElementIdSearch()
        {
            return string.Equals(_linkScope, "linkedOnly", StringComparison.OrdinalIgnoreCase) &&
                _elementIds.Count > 0 &&
                _uniqueIds.Count == 0 &&
                !HasCollectorSearchScope();
        }

        private void AddExactElementMatches(
            Document document,
            RevitLinkInstance linkInstance,
            List<Tuple<Element, SearchMatchSummary, Document, RevitLinkInstance>> matches,
            List<string> warnings,
            ref int scannedElementCount,
            ref int candidateElementCount,
            DateTime deadlineUtc,
            ref bool partial,
            ref string stoppedReason)
        {
            foreach (int id in _elementIds)
            {
                if (StopBudgetReached(scannedElementCount, deadlineUtc, out stoppedReason))
                {
                    partial = true;
                    return;
                }
                Element element = document.GetElement(new ElementId(id));
                if (element == null)
                {
                    warnings.Add("Element id not found in " + document.Title + ": " + id.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    continue;
                }
                scannedElementCount++;
                candidateElementCount++;
                AddIfMatch(document, element, linkInstance, matches);
            }

            foreach (string uniqueId in _uniqueIds)
            {
                if (StopBudgetReached(scannedElementCount, deadlineUtc, out stoppedReason))
                {
                    partial = true;
                    return;
                }
                Element element = document.GetElement(uniqueId);
                if (element == null)
                {
                    warnings.Add("UniqueId not found in " + document.Title + ": " + uniqueId);
                    continue;
                }
                scannedElementCount++;
                candidateElementCount++;
                AddIfMatch(document, element, linkInstance, matches);
            }
        }

        private void SearchLinkedUniqueIds(
            Document hostDocument,
            List<Tuple<Element, SearchMatchSummary, Document, RevitLinkInstance>> matches,
            List<string> warnings,
            ref int scannedElementCount,
            ref int candidateElementCount,
            DateTime deadlineUtc,
            ref bool partial,
            ref string stoppedReason)
        {
            using (FilteredElementCollector linksCollector = new FilteredElementCollector(hostDocument))
            {
                IEnumerable<RevitLinkInstance> links = linksCollector
                    .OfClass(typeof(RevitLinkInstance))
                    .OfType<RevitLinkInstance>();
                foreach (RevitLinkInstance link in links)
                {
                    Document linkDocument = null;
                    try
                    {
                        linkDocument = link.GetLinkDocument();
                    }
                    catch
                    {
                    }

                    if (linkDocument == null)
                    {
                        warnings.Add("Skipped unloaded or inaccessible Revit link: " + link.Name);
                        continue;
                    }

                    foreach (string uniqueId in _uniqueIds)
                    {
                        if (string.IsNullOrWhiteSpace(uniqueId))
                        {
                            continue;
                        }

                        if (StopBudgetReached(scannedElementCount, deadlineUtc, out stoppedReason))
                        {
                            partial = true;
                            return;
                        }

                        Element element = linkDocument.GetElement(uniqueId);
                        if (element == null)
                        {
                            continue;
                        }

                        scannedElementCount++;
                        candidateElementCount++;
                        AddIfMatch(linkDocument, element, link, matches);
                    }
                }
            }
        }

        private void SearchDocument(
            Document searchDocument,
            UIDocument uiDocument,
            RevitLinkInstance linkInstance,
            List<Tuple<Element, SearchMatchSummary, Document, RevitLinkInstance>> matches,
            List<string> warnings,
            ref int scannedElementCount,
            ref int candidateElementCount,
            DateTime deadlineUtc,
            ref bool partial,
            ref string stoppedReason)
        {
            using (FilteredElementCollector collector = BuildCollector(searchDocument, uiDocument, linkInstance, warnings))
            {
                foreach (Element element in collector.WhereElementIsNotElementType())
                {
                    if (StopBudgetReached(scannedElementCount, deadlineUtc, out stoppedReason))
                    {
                        partial = true;
                        return;
                    }

                    scannedElementCount++;
                    if (!MatchesAdditionalFilters(searchDocument, element))
                    {
                        continue;
                    }

                    candidateElementCount++;
                    AddIfMatch(searchDocument, element, linkInstance, matches);
                }
            }
        }

        private FilteredElementCollector BuildCollector(Document searchDocument, UIDocument uiDocument, RevitLinkInstance linkInstance, List<string> warnings)
        {
            FilteredElementCollector collector;
            ElementId collectorViewId = ElementId.InvalidElementId;

            if (linkInstance == null)
            {
                if (_viewId.HasValue)
                {
                    collectorViewId = new ElementId(_viewId.Value);
                }
                else if (_activeViewOnly && searchDocument.ActiveView != null)
                {
                    collectorViewId = searchDocument.ActiveView.Id;
                }
            }

            try
            {
                collector = collectorViewId != ElementId.InvalidElementId
                    ? new FilteredElementCollector(searchDocument, collectorViewId)
                    : new FilteredElementCollector(searchDocument);
            }
            catch (Exception ex)
            {
                warnings.Add("View-specific collector failed, falling back to document collector: " + ex.Message);
                collector = new FilteredElementCollector(searchDocument);
            }

            List<BuiltInCategory> builtInCategories = ElementDiscoveryHelpers.ResolveBuiltInCategories(_categoryNames);
            if (builtInCategories.Count > 0)
            {
                collector = collector.WherePasses(new ElementMulticategoryFilter(builtInCategories));
            }
            else if (_categoryNames.Count > 0)
            {
                warnings.Add("Category names could not be mapped to BuiltInCategory; falling back to post-filter category matching.");
            }

            return collector;
        }

        private void SearchLinkedDocuments(
            Document hostDocument,
            List<Tuple<Element, SearchMatchSummary, Document, RevitLinkInstance>> matches,
            List<string> warnings,
            ref int scannedElementCount,
            ref int candidateElementCount,
            DateTime deadlineUtc,
            ref bool partial,
            ref string stoppedReason)
        {
            if (!_allowExpensiveSearch && _categoryNames.Count == 0 && string.IsNullOrWhiteSpace(_query))
            {
                partial = true;
                stoppedReason = "needs_scope";
                warnings.Add("Linked model search skipped because it requires a category/text scope or allowExpensiveSearch.");
                return;
            }

            using (FilteredElementCollector linkCollector = new FilteredElementCollector(hostDocument))
            {
                IEnumerable<Element> linkElements = linkCollector
                    .OfClass(typeof(RevitLinkInstance))
                    .WhereElementIsNotElementType();

                foreach (Element linkElement in linkElements)
                {
                    if (StopBudgetReached(scannedElementCount, deadlineUtc, out stoppedReason))
                    {
                        partial = true;
                        return;
                    }
                    RevitLinkInstance link = linkElement as RevitLinkInstance;
                    if (link == null) continue;
                    Document linkDocument = link.GetLinkDocument();
                    if (linkDocument == null)
                    {
                        warnings.Add("Linked document is not loaded for link instance: " + link.Name);
                        continue;
                    }

                    SearchDocument(linkDocument, null, link, matches, warnings, ref scannedElementCount, ref candidateElementCount, deadlineUtc, ref partial, ref stoppedReason);
                    if (partial) return;
                }
            }
        }

        private bool StopBudgetReached(int scannedElementCount, DateTime deadlineUtc, out string reason)
        {
            if (scannedElementCount >= _maxElementsScanned)
            {
                reason = "max_scanned";
                return true;
            }
            if (DateTime.UtcNow >= deadlineUtc)
            {
                reason = "max_elapsed";
                return true;
            }
            reason = "";
            return false;
        }

        private void AddIfMatch(
            Document searchDocument,
            Element element,
            RevitLinkInstance linkInstance,
            List<Tuple<Element, SearchMatchSummary, Document, RevitLinkInstance>> matches)
        {
            SearchMatchSummary match = ElementDiscoveryHelpers.BuildSearchMatch(searchDocument, element, _query, _categoryNames);
            if (!match.Matches)
            {
                return;
            }

            matches.Add(Tuple.Create(element, match, searchDocument, linkInstance));
        }

        private bool MatchesAdditionalFilters(Document searchDocument, Element element)
        {
            if (element == null)
            {
                return false;
            }

            if (_levelIds.Count > 0 || _levelNames.Count > 0)
            {
                ElementId levelId;
                string levelName;
                ElementDiscoveryHelpers.ResolveElementLevel(searchDocument, element, out levelId, out levelName);
                if (_levelIds.Count > 0)
                {
                    int resolvedLevelId = levelId != null ? levelId.GetIdValue() : -1;
                    if (!_levelIds.Contains(resolvedLevelId))
                    {
                        return false;
                    }
                }
                if (_levelNames.Count > 0 && !ContainsAny(levelName, _levelNames))
                {
                    return false;
                }
            }
            if (!string.IsNullOrWhiteSpace(_familyName) && !ContainsText(ElementDiscoveryHelpers.GetFamilyName(searchDocument, element), _familyName))
            {
                return false;
            }
            if (!string.IsNullOrWhiteSpace(_typeName) && !ContainsText(ElementDiscoveryHelpers.GetTypeName(searchDocument, element), _typeName))
            {
                return false;
            }
            if (!string.IsNullOrWhiteSpace(_systemName) && !ContainsText(GetSystemName(element), _systemName))
            {
                return false;
            }
            if (_worksetIds.Count > 0)
            {
                int worksetId = GetWorksetId(element);
                if (!_worksetIds.Contains(worksetId))
                {
                    return false;
                }
            }
            if (_worksetNames.Count > 0 && !ContainsAny(GetWorksetName(searchDocument, element), _worksetNames))
            {
                return false;
            }
            return true;
        }

        private static bool ContainsText(string value, string query)
        {
            return !string.IsNullOrWhiteSpace(value) &&
                !string.IsNullOrWhiteSpace(query) &&
                value.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static bool ContainsAny(string value, List<string> queries)
        {
            if (string.IsNullOrWhiteSpace(value)) return false;
            foreach (string query in queries)
            {
                if (ContainsText(value, query))
                {
                    return true;
                }
            }
            return false;
        }

        private static int GetWorksetId(Element element)
        {
            try
            {
                WorksetId id = element.WorksetId;
                return id != null ? id.IntegerValue : -1;
            }
            catch
            {
                return -1;
            }
        }

        private static string GetWorksetName(Document document, Element element)
        {
            try
            {
                WorksetId id = element.WorksetId;
                if (id == null) return "";
                WorksetTable table = document.GetWorksetTable();
                if (table == null) return "";
                Workset workset = table.GetWorkset(id);
                return workset != null ? workset.Name : "";
            }
            catch
            {
                return "";
            }
        }

        private static string GetSystemName(Element element)
        {
            try
            {
                Parameter builtIn = element.get_Parameter(BuiltInParameter.RBS_SYSTEM_NAME_PARAM);
                if (builtIn != null)
                {
                    string display = builtIn.AsValueString();
                    if (!string.IsNullOrWhiteSpace(display)) return display;
                    string raw = builtIn.AsString();
                    if (!string.IsNullOrWhiteSpace(raw)) return raw;
                }
            }
            catch
            {
            }

            string byName = ElementDiscoveryHelpers.GetParameterString(element, "System Name");
            if (!string.IsNullOrWhiteSpace(byName)) return byName;
            return ElementDiscoveryHelpers.GetParameterString(element, "System");
        }

        private ElementSearchItem BuildSearchItem(
            Document searchDocument,
            UIDocument uiDocument,
            Element element,
            RevitLinkInstance linkInstance,
            SearchMatchSummary match,
            DateTime deadlineUtc,
            ref bool partial,
            ref string stoppedReason)
        {
            bool includePlanCandidates = _includePlanCandidates && linkInstance == null;
            bool planCandidateBudgetStopped;
            string planCandidateStoppedReason;
            ElementSearchItem item = ElementDiscoveryHelpers.BuildElementSearchItem(
                searchDocument,
                uiDocument,
                element,
                includePlanCandidates,
                _planNameContains,
                _planCandidateMode,
                match,
                deadlineUtc,
                out planCandidateBudgetStopped,
                out planCandidateStoppedReason);
            if (planCandidateBudgetStopped)
            {
                partial = true;
                stoppedReason = string.IsNullOrWhiteSpace(planCandidateStoppedReason)
                    ? "max_elapsed"
                    : planCandidateStoppedReason;
            }
            if (item == null)
            {
                return null;
            }
            item.SourceDocumentTitle = searchDocument.Title;
            item.SourceDocumentKind = linkInstance == null ? "host" : "linked";
            if (linkInstance != null)
            {
                item.LinkInstanceId = linkInstance.Id.GetIdValue();
                item.LinkInstanceName = linkInstance.Name;
                item.PlanCandidateMode = "none";
                item.PlanCandidates = null;
            }
            return item;
        }

        private bool IsVerifiedPlanCandidateMode()
        {
            return _includePlanCandidates &&
                string.Equals(_planCandidateMode, "verified", StringComparison.OrdinalIgnoreCase);
        }

        private bool CanRunVerifiedPlanCandidates(int matchCount)
        {
            if (!IsVerifiedPlanCandidateMode())
            {
                return true;
            }

            if (_allowExpensiveSearch)
            {
                return true;
            }

            if (IsExactTargetVerifiedMatchSet(matchCount))
            {
                return true;
            }

            return matchCount <= VerifiedPlanCandidateMaxMatchesWithoutApproval;
        }

        private bool IsExactTargetVerifiedMatchSet(int matchCount)
        {
            int exactTargetCount = _elementIds.Count + _uniqueIds.Count;
            return exactTargetCount > 0 && matchCount <= exactTargetCount;
        }

        private object BuildEffectiveScope()
        {
            return new
            {
                categoryNames = _categoryNames,
                levelNames = _levelNames,
                levelIds = _levelIds,
                activeViewOnly = _activeViewOnly,
                viewId = _viewId,
                familyName = _familyName,
                typeName = _typeName,
                systemName = _systemName,
                worksetNames = _worksetNames,
                worksetIds = _worksetIds,
                linkScope = _linkScope
            };
        }

        private object BuildScanPolicy()
        {
            return new
            {
                searchBudget = _searchBudget,
                maxElementsScanned = _maxElementsScanned,
                maxElapsedMs = _maxElapsedMs,
                allowExpensiveSearch = _allowExpensiveSearch,
                planCandidateMode = _planCandidateMode
            };
        }

        private List<string> BuildSuggestedNextScopes()
        {
            return new List<string>
            {
                "levelNames",
                "activeViewOnly",
                "familyName",
                "typeName",
                "systemName",
                "worksetNames",
                "allowExpensiveSearch",
                "searchBudget=deep"
            };
        }

        private FindElementsResult BuildGuardedResult(
            string reason,
            string message,
            int scannedElementCount,
            int candidateElementCount,
            List<string> warnings)
        {
            return new FindElementsResult
            {
                Success = true,
                Guarded = true,
                State = "guarded",
                Reason = reason,
                Action = "find_elements",
                Message = message,
                OriginalQuery = _originalQuery,
                Query = _query,
                CategoryNames = _categoryNames,
                Count = 0,
                PlanCandidateMode = _planCandidateMode,
                InferredScope = _inferredScope,
                EffectiveScope = BuildEffectiveScope(),
                ScanPolicy = BuildScanPolicy(),
                ScannedElementCount = scannedElementCount,
                CandidateElementCount = candidateElementCount,
                Partial = false,
                ScanStoppedReason = reason,
                SuggestedNextScopes = BuildSuggestedNextScopes(),
                Warnings = warnings,
                Elements = new List<ElementSearchItem>()
            };
        }

        private void Complete(FindElementsResult result)
        {
            ResultInfo = result;
            TaskCompleted = true;
            _resetEvent.Set();
        }

        private void TrimPlanCandidates(ElementSearchItem item)
        {
            if (item == null || item.PlanCandidates == null)
            {
                return;
            }

            item.PlanCandidatesTotal = item.PlanCandidates.Count;
            if (item.PlanCandidates.Count > _maxPlanCandidates)
            {
                item.PlanCandidates = item.PlanCandidates.Take(_maxPlanCandidates).ToList();
                item.PlanCandidatesTruncated = true;
            }
        }

        public string GetName()
        {
            return "Find Revit elements";
        }
    }
}
