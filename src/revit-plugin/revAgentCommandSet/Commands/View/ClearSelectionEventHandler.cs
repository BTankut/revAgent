using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPSDK.API.Interfaces;
using RevAgentCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

namespace RevAgentCommandSet.Commands.View
{
    public class SelectionOperationResult
    {
        public bool Success { get; set; }
        public string Action { get; set; }
        public string State { get; set; }
        public string Message { get; set; }
        public string Error { get; set; }
        public bool Changed { get; set; }
        public bool Cleared { get; set; }
        public int SelectionCountBefore { get; set; }
        public int SelectionCountAfter { get; set; }
        public List<int> SelectionIdsBefore { get; set; }
        public ViewSummary ActiveView { get; set; }
    }

    public class ClearSelectionEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public SelectionOperationResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetRequest()
        {
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
                if (uiDocument == null || uiDocument.Document == null)
                {
                    Complete(new SelectionOperationResult
                    {
                        Success = false,
                        Action = "clear_selection",
                        State = "failed",
                        Error = "No active Revit document is available."
                    });
                    return;
                }

                Document document = uiDocument.Document;
                List<ElementId> before = uiDocument.Selection.GetElementIds().ToList();
                uiDocument.Selection.SetElementIds(new List<ElementId>());
                int afterCount = uiDocument.Selection.GetElementIds().Count;
                bool changed = before.Count > 0 && afterCount == 0;

                Complete(new SelectionOperationResult
                {
                    Success = true,
                    Action = "clear_selection",
                    State = "completed",
                    Message = changed ? "Revit selection cleared." : "Revit selection was already empty.",
                    Changed = changed,
                    Cleared = afterCount == 0,
                    SelectionCountBefore = before.Count,
                    SelectionCountAfter = afterCount,
                    SelectionIdsBefore = before.Select(id => id.GetIdValue()).ToList(),
                    ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true)
                });
            }
            catch (Exception ex)
            {
                Complete(new SelectionOperationResult
                {
                    Success = false,
                    Action = "clear_selection",
                    State = "failed",
                    Error = ex.Message
                });
            }
        }

        private void Complete(SelectionOperationResult result)
        {
            ResultInfo = result;
            TaskCompleted = true;
            _resetEvent.Set();
        }

        public string GetName()
        {
            return "Clear Revit selection";
        }
    }
}
