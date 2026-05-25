using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

namespace RevitMCPCommandSet.Commands.View
{
    public class CloseViewEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private int? _viewId;
        private string _viewName;
        private string _viewType;
        private bool _exactName;
        private UIApplication _pendingApp;
        private ElementId _pendingCloseViewId;
        private ElementId _pendingFallbackViewId;
        private ElementId _activeViewBeforeCloseId;
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
            _pendingCloseViewId = ElementId.InvalidElementId;
            _pendingFallbackViewId = ElementId.InvalidElementId;
            _activeViewBeforeCloseId = ElementId.InvalidElementId;
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
                        Action = "close_view",
                        Error = error,
                        Candidates = candidates,
                        ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                        OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument)
                    });
                    return;
                }

                UIView targetUIView = ViewCommandHelpers.FindOpenUIView(uiDocument, targetView.Id);
                if (targetUIView == null)
                {
                    Complete(new ViewOperationResult
                    {
                        Success = true,
                        Action = "close_view",
                        Message = "Target view is not open.",
                        Closed = false,
                        TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, false, false),
                        ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                        OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument)
                    });
                    return;
                }

                List<UIView> openViews = ViewCommandHelpers.GetOpenUIViewsForDocument(uiDocument);
                if (openViews.Count <= 1)
                {
                    Complete(new ViewOperationResult
                    {
                        Success = false,
                        Action = "close_view",
                        Error = "Cannot close the last open Revit view.",
                        TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, true, true),
                        ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                        OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument)
                    });
                    return;
                }

                bool isActiveTarget = document.ActiveView != null &&
                    document.ActiveView.Id.GetIdValue() == targetView.Id.GetIdValue();
                _activeViewBeforeCloseId = document.ActiveView != null
                    ? document.ActiveView.Id
                    : ElementId.InvalidElementId;
                if (isActiveTarget)
                {
                    UIView fallbackUIView = openViews.FirstOrDefault(v => v.ViewId.GetIdValue() != targetView.Id.GetIdValue());
                    Autodesk.Revit.DB.View fallbackView = fallbackUIView != null
                        ? document.GetElement(fallbackUIView.ViewId) as Autodesk.Revit.DB.View
                        : null;
                    if (fallbackView == null)
                    {
                        Complete(new ViewOperationResult
                        {
                            Success = false,
                            Action = "close_view",
                            Error = "Could not find a fallback view to activate before closing the active view.",
                            TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, true, true),
                            OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument)
                        });
                        return;
                    }

                    _pendingApp = app;
                    _pendingCloseViewId = targetView.Id;
                    _pendingFallbackViewId = fallbackView.Id;
                    _idlingAttempts = 0;
                    if (!document.IsModifiable)
                    {
                        try
                        {
                            uiDocument.RequestViewChange(fallbackView);
                        }
                        catch
                        {
                        }
                    }
                    app.Idling += OnIdlingCloseActive;
                    return;
                }

                if (document.IsModifiable)
                {
                    _pendingApp = app;
                    _pendingCloseViewId = targetView.Id;
                    _pendingFallbackViewId = ElementId.InvalidElementId;
                    _idlingAttempts = 0;
                    app.Idling += OnIdlingCloseInactive;
                    return;
                }

                targetUIView.Close();
                Complete(new ViewOperationResult
                {
                    Success = true,
                    Action = "close_view",
                    Message = "View closed.",
                    Changed = true,
                    Closed = true,
                    ActiveViewChanged = DidActiveViewChange(document),
                    TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, false, false),
                    ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                    OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument)
                });
            }
            catch (Exception ex)
            {
                Complete(new ViewOperationResult
                {
                    Success = false,
                    Action = "close_view",
                    Error = ex.Message
                });
            }
        }

        private void OnIdlingCloseInactive(object sender, IdlingEventArgs e)
        {
            _idlingAttempts++;
            try
            {
                UIDocument uiDocument = _pendingApp.ActiveUIDocument;
                Document document = uiDocument.Document;
                if (!document.IsModifiable)
                {
                    UIView targetUIView = ViewCommandHelpers.FindOpenUIView(uiDocument, _pendingCloseViewId);
                    Autodesk.Revit.DB.View targetView = document.GetElement(_pendingCloseViewId) as Autodesk.Revit.DB.View;
                    if (targetUIView != null)
                    {
                        targetUIView.Close();
                    }
                    CompleteFromIdling(OnClosedResult(document, uiDocument, targetView, targetUIView != null));
                    return;
                }
                if (_idlingAttempts >= 10)
                {
                    CompleteFromIdling(new ViewOperationResult
                    {
                        Success = false,
                        Action = "close_view",
                        Error = "View close was deferred but the document stayed modifiable."
                    });
                }
            }
            catch (Exception ex)
            {
                CompleteFromIdling(new ViewOperationResult
                {
                    Success = false,
                    Action = "close_view",
                    Error = ex.Message
                });
            }
        }

        private void OnIdlingCloseActive(object sender, IdlingEventArgs e)
        {
            _idlingAttempts++;
            try
            {
                UIDocument uiDocument = _pendingApp.ActiveUIDocument;
                Document document = uiDocument.Document;
                Autodesk.Revit.DB.View targetView = document.GetElement(_pendingCloseViewId) as Autodesk.Revit.DB.View;
                Autodesk.Revit.DB.View fallbackView = document.GetElement(_pendingFallbackViewId) as Autodesk.Revit.DB.View;
                if (targetView == null || fallbackView == null)
                {
                    CompleteFromIdling(new ViewOperationResult
                    {
                        Success = false,
                        Action = "close_view",
                        Error = "Target or fallback view no longer exists."
                    });
                    return;
                }

                if (document.ActiveView != null &&
                    document.ActiveView.Id.GetIdValue() != _pendingCloseViewId.GetIdValue() &&
                    !document.IsModifiable)
                {
                    UIView targetUIView = ViewCommandHelpers.FindOpenUIView(uiDocument, _pendingCloseViewId);
                    if (targetUIView != null)
                    {
                        targetUIView.Close();
                    }
                    CompleteFromIdling(OnClosedResult(document, uiDocument, targetView, targetUIView != null));
                    return;
                }

                if (!document.IsModifiable)
                {
                    uiDocument.RequestViewChange(fallbackView);
                }

                if (_idlingAttempts >= 10)
                {
                    CompleteFromIdling(new ViewOperationResult
                    {
                        Success = false,
                        Action = "close_view",
                        Error = "Could not switch away from the active view before closing it.",
                        TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, true, true),
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
                    Action = "close_view",
                    Error = ex.Message
                });
            }
        }

        private ViewOperationResult OnClosedResult(Document document, UIDocument uiDocument, Autodesk.Revit.DB.View targetView, bool closed)
        {
            bool activeViewChanged = DidActiveViewChange(document);
            return new ViewOperationResult
            {
                Success = true,
                Action = "close_view",
                Message = closed ? "View closed." : "Target view was already closed.",
                Changed = closed || activeViewChanged,
                Closed = closed,
                ActiveViewChanged = activeViewChanged,
                TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, false, false),
                ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument)
            };
        }

        private bool DidActiveViewChange(Document document)
        {
            if (document == null ||
                document.ActiveView == null ||
                _activeViewBeforeCloseId == null ||
                _activeViewBeforeCloseId == ElementId.InvalidElementId)
            {
                return false;
            }

            return document.ActiveView.Id.GetIdValue() != _activeViewBeforeCloseId.GetIdValue();
        }

        private void CompleteFromIdling(ViewOperationResult result)
        {
            if (_pendingApp != null)
            {
                _pendingApp.Idling -= OnIdlingCloseActive;
                _pendingApp.Idling -= OnIdlingCloseInactive;
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
            return "Close Revit view";
        }
    }
}
