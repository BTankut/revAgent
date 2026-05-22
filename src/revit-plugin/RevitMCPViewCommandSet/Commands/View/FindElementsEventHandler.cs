using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPSDK.API.Interfaces;
using RevitMCPViewCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

namespace RevitMCPViewCommandSet.Commands.View
{
    public class FindElementsResult
    {
        public bool Success { get; set; }
        public string Action { get; set; }
        public string Message { get; set; }
        public string Error { get; set; }
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
        public List<ElementSearchItem> Elements { get; set; }
    }

    public class FindElementsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private string _query;
        private List<string> _categoryNames = new List<string>();
        private bool _includePlanCandidates;
        private string _planCandidateMode;
        private string _planNameContains;
        private int _limit;
        private int _maxPlanCandidates;

        public FindElementsResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetRequest(
            string query,
            List<string> categoryNames,
            bool includePlanCandidates,
            string planCandidateMode,
            string planNameContains,
            int limit,
            int maxPlanCandidates)
        {
            _query = query ?? "";
            _categoryNames = categoryNames ?? new List<string>();
            _includePlanCandidates = includePlanCandidates;
            _planCandidateMode = string.IsNullOrWhiteSpace(planCandidateMode) ? "none" : planCandidateMode;
            _planNameContains = planNameContains ?? "";
            _limit = limit;
            _maxPlanCandidates = Math.Max(0, Math.Min(25, maxPlanCandidates));
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
            try
            {
                UIDocument uiDocument = app.ActiveUIDocument;
                Document document = uiDocument.Document;

                if (string.IsNullOrWhiteSpace(_query) && _categoryNames.Count == 0)
                {
                    Complete(new FindElementsResult
                    {
                        Success = false,
                        Action = "find_elements",
                        Error = "Pass query and/or categoryNames."
                    });
                    return;
                }

                List<Tuple<Element, SearchMatchSummary>> matches = new List<Tuple<Element, SearchMatchSummary>>();
                IEnumerable<Element> elements =
                    new FilteredElementCollector(document)
                        .WhereElementIsNotElementType()
                        .ToElements();

                foreach (Element element in elements)
                {
                    SearchMatchSummary match = ElementDiscoveryHelpers.BuildSearchMatch(document, element, _query, _categoryNames);
                    if (!match.Matches)
                    {
                        continue;
                    }

                    matches.Add(Tuple.Create(element, match));
                }

                List<Tuple<Element, SearchMatchSummary>> orderedMatches = matches
                    .OrderByDescending(m => m.Item2.Score)
                    .ThenBy(m => m.Item1.Id.GetIdValue())
                    .ToList();

                List<ElementSearchItem> items = orderedMatches
                    .Take(_limit)
                    .Select(m => ElementDiscoveryHelpers.BuildElementSearchItem(
                        document,
                        uiDocument,
                        m.Item1,
                        _includePlanCandidates,
                        _planNameContains,
                        _planCandidateMode,
                        m.Item2))
                    .ToList();

                foreach (ElementSearchItem item in items)
                {
                    TrimPlanCandidates(item);
                }

                int topScore = orderedMatches.Count > 0 ? orderedMatches[0].Item2.Score : 0;
                int tiedCount = topScore > 0 ? orderedMatches.Count(m => m.Item2.Score == topScore) : 0;
                string topConfidence = orderedMatches.Count > 0 ? orderedMatches[0].Item2.Confidence : "none";
                bool ambiguous = orderedMatches.Count > 1 && (tiedCount > 1 || !string.Equals(topConfidence, "high", StringComparison.OrdinalIgnoreCase));
                string selectionHint = ambiguous
                    ? "Multiple plausible matches were found. Use elementId, mark, level, or a more specific query before making changes."
                    : "Top match is the best current candidate; still verify level, mark, and plan before making changes.";

                Complete(new FindElementsResult
                {
                    Success = true,
                    Action = "find_elements",
                    Message = "Matching Revit elements were found.",
                    Query = _query,
                    CategoryNames = _categoryNames,
                    Count = matches.Count,
                    Truncated = matches.Count > items.Count,
                    Ambiguous = ambiguous,
                    TopScore = topScore,
                    TopConfidence = topConfidence,
                    TopScoreTiedCount = tiedCount,
                    SelectionHint = selectionHint,
                    PlanCandidateMode = _planCandidateMode,
                    Elements = items
                });
            }
            catch (Exception ex)
            {
                Complete(new FindElementsResult
                {
                    Success = false,
                    Action = "find_elements",
                    Error = ex.Message
                });
            }
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
