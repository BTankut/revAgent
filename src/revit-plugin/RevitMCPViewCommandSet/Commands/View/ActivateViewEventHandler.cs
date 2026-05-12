using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using RevitMCPSDK.API.Interfaces;
using RevitMCPViewCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Threading;

namespace RevitMCPViewCommandSet.Commands.View
{
    public class ActivateViewEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private int? _viewId;
        private string _viewName;
        private string _viewType;
        private bool _exactName;
        private UIApplication _pendingApp;
        private ElementId _pendingViewId;
        private int _idlingAttempts;

        public ViewOperationResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetTarget(int? viewId, string viewName, string viewType, bool exactName)
        {
            _viewId = viewId;
            _viewName = viewName;
            _viewType = viewType;
            _exactName = exactName;
            _pendingApp = null;
            _pendingViewId = ElementId.InvalidElementId;
            _idlingAttempts = 0;
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
                Autodesk.Revit.DB.View targetView;
                List<ViewSummary> candidates;
                string error;
                if (!ViewCommandHelpers.TryResolveView(document, _viewId, _viewName, _viewType, _exactName, out targetView, out candidates, out error))
                {
                    Complete(new ViewOperationResult
                    {
                        Success = false,
                        Action = "activate_view",
                        Error = error,
                        Candidates = candidates,
                        ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                        OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument)
                    });
                    return;
                }

                string reason;
                if (!ViewCommandHelpers.CanActivateView(targetView, out reason))
                {
                    Complete(new ViewOperationResult
                    {
                        Success = false,
                        Action = "activate_view",
                        Error = reason,
                        TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, false, false),
                        ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                        OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument)
                    });
                    return;
                }

                if (document.ActiveView != null && document.ActiveView.Id.GetIdValue() == targetView.Id.GetIdValue())
                {
                    Complete(new ViewOperationResult
                    {
                        Success = true,
                        Action = "activate_view",
                        Message = "Target view is already active.",
                        Changed = false,
                        TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, true, true),
                        ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                        OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument)
                    });
                    return;
                }

                RequestOrDefer(app, targetView, document.IsModifiable);
            }
            catch (Exception ex)
            {
                Complete(new ViewOperationResult
                {
                    Success = false,
                    Action = "activate_view",
                    Error = ex.Message
                });
            }
        }

        private void RequestOrDefer(UIApplication app, Autodesk.Revit.DB.View targetView, bool forceDefer)
        {
            _pendingApp = app;
            _pendingViewId = targetView.Id;
            _idlingAttempts = 0;
            if (forceDefer)
            {
                app.Idling += OnIdling;
                return;
            }

            try
            {
                app.ActiveUIDocument.RequestViewChange(targetView);
                app.Idling += OnIdling;
            }
            catch
            {
                app.Idling += OnIdling;
            }
        }

        private void OnIdling(object sender, IdlingEventArgs e)
        {
            _idlingAttempts++;
            try
            {
                UIDocument uiDocument = _pendingApp.ActiveUIDocument;
                Document document = uiDocument.Document;
                Autodesk.Revit.DB.View targetView = document.GetElement(_pendingViewId) as Autodesk.Revit.DB.View;
                if (targetView == null)
                {
                    CompleteFromIdling(new ViewOperationResult
                    {
                        Success = false,
                        Action = "activate_view",
                        Error = "Target view no longer exists."
                    });
                    return;
                }

                if (document.ActiveView != null && document.ActiveView.Id.GetIdValue() == _pendingViewId.GetIdValue())
                {
                    CompleteFromIdling(new ViewOperationResult
                    {
                        Success = true,
                        Action = "activate_view",
                        Message = "View activated.",
                        Requested = true,
                        Deferred = _idlingAttempts > 1,
                        Changed = true,
                        TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, true, true),
                        ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                        OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument)
                    });
                    return;
                }

                if (!document.IsModifiable)
                {
                    _pendingApp.ActiveUIDocument.RequestViewChange(targetView);
                }

                if (_idlingAttempts >= 10)
                {
                    CompleteFromIdling(new ViewOperationResult
                    {
                        Success = false,
                        Action = "activate_view",
                        Error = "View activation was requested but could not be verified.",
                        Requested = true,
                        TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, false, false),
                        ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                        OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument)
                    });
                }
            }
            catch (Exception ex)
            {
                CompleteFromIdling(new ViewOperationResult
                {
                    Success = false,
                    Action = "activate_view",
                    Error = ex.Message
                });
            }
        }

        private void CompleteFromIdling(ViewOperationResult result)
        {
            if (_pendingApp != null)
            {
                _pendingApp.Idling -= OnIdling;
            }
            Complete(result);
        }

        private void Complete(ViewOperationResult result)
        {
            ResultInfo = result;
            TaskCompleted = true;
            _resetEvent.Set();
        }

        public string GetName()
        {
            return "Activate Revit view";
        }
    }
}
