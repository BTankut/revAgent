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
    public class FocusElementsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private List<int> _requestedElementIds = new List<int>();
        private int? _viewId;
        private string _viewName;
        private string _viewType;
        private bool _exactName;
        private bool _select;
        private bool _zoom;
        private bool _allowPartial;
        private UIApplication _pendingApp;
        private ElementId _pendingViewId;
        private bool _hasTargetView;
        private int _idlingAttempts;

        public ElementFocusResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetRequest(
            List<int> elementIds,
            int? viewId,
            string viewName,
            string viewType,
            bool exactName,
            bool select,
            bool zoom,
            bool allowPartial)
        {
            _requestedElementIds = elementIds ?? new List<int>();
            _viewId = viewId;
            _viewName = viewName;
            _viewType = viewType;
            _exactName = exactName;
            _select = select;
            _zoom = zoom;
            _allowPartial = allowPartial;
            _pendingApp = null;
            _pendingViewId = ElementId.InvalidElementId;
            _hasTargetView = viewId.HasValue || !string.IsNullOrWhiteSpace(viewName);
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

                List<ElementId> elementIds;
                List<ElementSummary> elements;
                List<int> missingElementIds;
                string elementError;
                if (!ElementFocusHelpers.TryResolveElements(document, _requestedElementIds, _allowPartial, out elementIds, out elements, out missingElementIds, out elementError))
                {
                    Complete(BuildFailure(document, uiDocument, elementError, null, null, missingElementIds));
                    return;
                }

                Autodesk.Revit.DB.View targetView = null;
                List<ViewSummary> candidates = null;
                if (_hasTargetView)
                {
                    string viewError;
                    if (!ViewCommandHelpers.TryResolveView(document, _viewId, _viewName, _viewType, _exactName, out targetView, out candidates, out viewError))
                    {
                        Complete(BuildFailure(document, uiDocument, viewError, candidates, elements, missingElementIds));
                        return;
                    }

                    string reason;
                    if (!ViewCommandHelpers.CanActivateView(targetView, out reason))
                    {
                        ElementFocusResult result = BuildFailure(document, uiDocument, reason, null, elements, missingElementIds);
                        result.TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, false, false);
                        Complete(result);
                        return;
                    }
                }

                if (_hasTargetView && document.ActiveView != null && document.ActiveView.Id.GetIdValue() != targetView.Id.GetIdValue())
                {
                    RequestOrDefer(app, targetView, document.IsModifiable);
                    return;
                }

                if (document.IsModifiable)
                {
                    RequestOrDefer(app, targetView ?? document.ActiveView, true);
                    return;
                }

                Complete(FocusNow(uiDocument, elementIds, elements, missingElementIds, targetView, false, false));
            }
            catch (Exception ex)
            {
                Complete(new ElementFocusResult
                {
                    Success = false,
                    Action = "focus_elements",
                    Error = ex.Message
                });
            }
        }

        private void RequestOrDefer(UIApplication app, Autodesk.Revit.DB.View targetView, bool forceDefer)
        {
            _pendingApp = app;
            _pendingViewId = targetView != null ? targetView.Id : ElementId.InvalidElementId;
            _idlingAttempts = 0;

            if (!forceDefer && targetView != null && _hasTargetView)
            {
                try
                {
                    app.ActiveUIDocument.RequestViewChange(targetView);
                }
                catch
                {
                    // Revit may only allow the view switch from a later Idling turn.
                }
            }

            app.Idling += OnIdling;
        }

        private void OnIdling(object sender, IdlingEventArgs e)
        {
            _idlingAttempts++;
            try
            {
                UIDocument uiDocument = _pendingApp.ActiveUIDocument;
                Document document = uiDocument.Document;

                List<ElementId> elementIds;
                List<ElementSummary> elements;
                List<int> missingElementIds;
                string elementError;
                if (!ElementFocusHelpers.TryResolveElements(document, _requestedElementIds, _allowPartial, out elementIds, out elements, out missingElementIds, out elementError))
                {
                    CompleteFromIdling(BuildFailure(document, uiDocument, elementError, null, null, missingElementIds));
                    return;
                }

                Autodesk.Revit.DB.View targetView = null;
                if (_hasTargetView)
                {
                    targetView = document.GetElement(_pendingViewId) as Autodesk.Revit.DB.View;
                    if (targetView == null)
                    {
                        CompleteFromIdling(BuildFailure(document, uiDocument, "Target view no longer exists.", null, elements, missingElementIds));
                        return;
                    }

                    if (document.ActiveView == null || document.ActiveView.Id.GetIdValue() != _pendingViewId.GetIdValue())
                    {
                        if (!document.IsModifiable)
                        {
                            _pendingApp.ActiveUIDocument.RequestViewChange(targetView);
                        }

                        if (_idlingAttempts >= 10)
                        {
                            ElementFocusResult result = BuildFailure(document, uiDocument, "View activation was requested but could not be verified.", null, elements, missingElementIds);
                            result.Requested = true;
                            result.TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, false, false);
                            CompleteFromIdling(result);
                        }
                        return;
                    }
                }

                if (document.IsModifiable)
                {
                    if (_idlingAttempts >= 10)
                    {
                        CompleteFromIdling(BuildFailure(document, uiDocument, "Revit document stayed modifiable, so element focus was deferred and not executed.", null, elements, missingElementIds));
                    }
                    return;
                }

                CompleteFromIdling(FocusNow(uiDocument, elementIds, elements, missingElementIds, targetView, _hasTargetView, _idlingAttempts > 1));
            }
            catch (Exception ex)
            {
                CompleteFromIdling(new ElementFocusResult
                {
                    Success = false,
                    Action = "focus_elements",
                    Error = ex.Message
                });
            }
        }

        private ElementFocusResult FocusNow(
            UIDocument uiDocument,
            IList<ElementId> elementIds,
            List<ElementSummary> elements,
            List<int> missingElementIds,
            Autodesk.Revit.DB.View targetView,
            bool requested,
            bool deferred)
        {
            Document document = uiDocument.Document;
            ElementFocusHelpers.SelectAndZoom(uiDocument, elementIds, _select, _zoom);

            return new ElementFocusResult
            {
                Success = true,
                Action = "focus_elements",
                Message = "Elements focused in the active Revit view.",
                Requested = requested,
                Deferred = deferred,
                Changed = requested,
                Selected = _select,
                Zoomed = _zoom,
                TargetView = targetView != null ? ViewCommandHelpers.BuildViewSummary(document, targetView, true, true) : null,
                ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument),
                Elements = elements,
                MissingElementIds = missingElementIds
            };
        }

        private ElementFocusResult BuildFailure(
            Document document,
            UIDocument uiDocument,
            string error,
            List<ViewSummary> candidates,
            List<ElementSummary> elements,
            List<int> missingElementIds)
        {
            return new ElementFocusResult
            {
                Success = false,
                Action = "focus_elements",
                Error = error,
                ActiveView = document != null ? ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true) : null,
                OpenViews = uiDocument != null ? ViewCommandHelpers.GetOpenViewSummaries(uiDocument) : null,
                Candidates = candidates,
                Elements = elements,
                MissingElementIds = missingElementIds
            };
        }

        private void CompleteFromIdling(ElementFocusResult result)
        {
            if (_pendingApp != null)
            {
                _pendingApp.Idling -= OnIdling;
            }
            Complete(result);
        }

        private void Complete(ElementFocusResult result)
        {
            ResultInfo = result;
            TaskCompleted = true;
            _resetEvent.Set();
        }

        public string GetName()
        {
            return "Focus Revit elements";
        }
    }
}
