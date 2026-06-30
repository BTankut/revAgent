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
    public class UiStateResult
    {
        public bool Success { get; set; }
        public string Action { get; set; }
        public string Message { get; set; }
        public string Error { get; set; }
        public string DocumentTitle { get; set; }
        public string DocumentPath { get; set; }
        public bool IsFamilyDocument { get; set; }
        public bool IsReadOnly { get; set; }
        public bool IsModifiable { get; set; }
        public ViewSummary ActiveView { get; set; }
        public List<ViewSummary> OpenViews { get; set; }
        public List<int> SelectionIds { get; set; }
        public List<ElementSummary> SelectionElements { get; set; }
        public int SelectionCount { get; set; }
        public bool SelectionTruncated { get; set; }
    }

    public class GetUiStateEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private int _selectionLimit;

        public UiStateResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetRequest(int selectionLimit)
        {
            _selectionLimit = selectionLimit;
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

                List<ElementId> selectedIds = uiDocument.Selection.GetElementIds().ToList();
                List<ElementSummary> selectedElements = new List<ElementSummary>();
                foreach (ElementId id in selectedIds.Take(_selectionLimit))
                {
                    Element element = document.GetElement(id);
                    if (element == null)
                    {
                        continue;
                    }

                    selectedElements.Add(ElementFocusHelpers.BuildElementSummary(
                        element,
                        ElementFocusHelpers.HasModelBoundingBox(element)));
                }

                ResultInfo = new UiStateResult
                {
                    Success = true,
                    Action = "get_ui_state",
                    Message = "Revit UI state was read.",
                    DocumentTitle = document.Title,
                    DocumentPath = document.PathName,
                    IsFamilyDocument = document.IsFamilyDocument,
                    IsReadOnly = document.IsReadOnly,
                    IsModifiable = document.IsModifiable,
                    ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                    OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument),
                    SelectionIds = selectedIds.Select(id => id.GetIdValue()).ToList(),
                    SelectionElements = selectedElements,
                    SelectionCount = selectedIds.Count,
                    SelectionTruncated = selectedIds.Count > _selectionLimit
                };
            }
            catch (Exception ex)
            {
                ResultInfo = new UiStateResult
                {
                    Success = false,
                    Action = "get_ui_state",
                    Error = ex.Message
                };
            }
            finally
            {
                TaskCompleted = true;
                _resetEvent.Set();
            }
        }

        public string GetName()
        {
            return "Get Revit UI state";
        }
    }
}
