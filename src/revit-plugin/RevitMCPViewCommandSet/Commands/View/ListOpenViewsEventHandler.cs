using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPSDK.API.Interfaces;
using System;
using System.Collections.Generic;
using System.Threading;

namespace RevitMCPViewCommandSet.Commands.View
{
    public class ListOpenViewsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public ViewOperationResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void Reset()
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
                Document document = uiDocument.Document;
                List<ViewSummary> openViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument);
                ResultInfo = new ViewOperationResult
                {
                    Success = true,
                    Action = "list_open_views",
                    Message = "Open Revit views were listed.",
                    ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                    OpenViews = openViews
                };
            }
            catch (Exception ex)
            {
                ResultInfo = new ViewOperationResult
                {
                    Success = false,
                    Action = "list_open_views",
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
            return "List open Revit views";
        }
    }
}
