using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPSDK.API.Interfaces;
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
        public List<ElementSearchItem> Elements { get; set; }
    }

    public class FindElementsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private string _query;
        private List<string> _categoryNames = new List<string>();
        private bool _includePlanCandidates;
        private string _planNameContains;
        private int _limit;

        public FindElementsResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetRequest(
            string query,
            List<string> categoryNames,
            bool includePlanCandidates,
            string planNameContains,
            int limit)
        {
            _query = query ?? "";
            _categoryNames = categoryNames ?? new List<string>();
            _includePlanCandidates = includePlanCandidates;
            _planNameContains = planNameContains ?? "";
            _limit = limit;
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

                List<ElementSearchItem> items = new List<ElementSearchItem>();
                int matchedCount = 0;
                IEnumerable<Element> elements =
                    new FilteredElementCollector(document)
                        .WhereElementIsNotElementType()
                        .ToElements();

                foreach (Element element in elements)
                {
                    if (!ElementDiscoveryHelpers.MatchesSearch(document, element, _query, _categoryNames))
                    {
                        continue;
                    }

                    matchedCount++;
                    if (items.Count < _limit)
                    {
                        items.Add(ElementDiscoveryHelpers.BuildElementSearchItem(
                            document,
                            uiDocument,
                            element,
                            _includePlanCandidates,
                            _planNameContains));
                    }
                }

                Complete(new FindElementsResult
                {
                    Success = true,
                    Action = "find_elements",
                    Message = "Matching Revit elements were found.",
                    Query = _query,
                    CategoryNames = _categoryNames,
                    Count = matchedCount,
                    Truncated = matchedCount > items.Count,
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

        public string GetName()
        {
            return "Find Revit elements";
        }
    }
}
