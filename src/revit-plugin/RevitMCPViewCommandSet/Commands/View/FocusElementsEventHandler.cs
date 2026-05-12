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
        private bool _fitToScreen;
        private bool _allowClosedViewSearch;
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
            bool fitToScreen,
            bool allowClosedViewSearch,
            bool allowPartial)
        {
            _requestedElementIds = elementIds ?? new List<int>();
            _viewId = viewId;
            _viewName = viewName;
            _viewType = viewType;
            _exactName = exactName;
            _select = select;
            _zoom = zoom;
            _fitToScreen = fitToScreen;
            _allowClosedViewSearch = allowClosedViewSearch;
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
            Autodesk.Revit.DB.View focusView = targetView ?? document.ActiveView;
            if (_zoom && !_allowClosedViewSearch && !AreElementsVisibleInView(document, focusView, elementIds))
            {
                return BuildVisibilityFailure(document, uiDocument, focusView, elements, missingElementIds);
            }

            bool fitToScreenApplied;
            string fitToScreenMethod;
            string fitToScreenWarning;
            string zoomMethod = ElementFocusHelpers.SelectAndZoom(uiDocument, elementIds, _select, _zoom, _fitToScreen, out fitToScreenApplied, out fitToScreenMethod, out fitToScreenWarning);
            string focusNote = ElementFocusHelpers.BuildFocusNote(_zoom, zoomMethod, elements);
            List<int> noBoundingBoxElementIds = ElementFocusHelpers.GetNoBoundingBoxElementIds(elements);

            return new ElementFocusResult
            {
                Success = true,
                Action = "focus_elements",
                Message = string.IsNullOrWhiteSpace(focusNote)
                    ? "Elements focused in the active Revit view."
                    : "Elements focused in the active Revit view. " + focusNote,
                Requested = requested,
                Deferred = deferred,
                Changed = requested,
                Selected = _select,
                Zoomed = _zoom || fitToScreenApplied,
                ZoomMethod = zoomMethod,
                FocusNote = focusNote,
                FitToScreen = fitToScreenApplied,
                FitToScreenMethod = fitToScreenMethod,
                FitToScreenWarning = fitToScreenWarning,
                TargetView = targetView != null ? ViewCommandHelpers.BuildViewSummary(document, targetView, true, true) : null,
                ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument),
                Elements = elements,
                MissingElementIds = missingElementIds,
                NoBoundingBoxElementIds = noBoundingBoxElementIds,
                BoundingBoxSource = "none",
                BoundingBoxNote = ElementFocusHelpers.BuildBoundingBoxNote("none"),
                BoundingBox = null
            };
        }

        private ElementFocusResult BuildVisibilityFailure(
            Document document,
            UIDocument uiDocument,
            Autodesk.Revit.DB.View focusView,
            List<ElementSummary> elements,
            List<int> missingElementIds)
        {
            ElementFocusResult result = BuildFailure(
                document,
                uiDocument,
                "The supplied elements are not visible in the active/requested view. Revit ShowElements was not called to avoid the closed-view search dialog.",
                null,
                elements,
                missingElementIds);

            result.FocusBlocked = true;
            result.FocusBlockReason = "elementsNotVisibleInTargetView";
            result.FocusSuggestion = "Use open_existing_plan_for_element_level with planMode=elementLevel, pass a viewId/viewName where the elements are visible, or set allowClosedViewSearch=true to allow Revit's modal closed-view search.";
            result.TargetView = focusView != null ? ViewCommandHelpers.BuildViewSummary(document, focusView, document.ActiveView != null && document.ActiveView.Id.GetIdValue() == focusView.Id.GetIdValue(), ViewCommandHelpers.FindOpenUIView(uiDocument, focusView.Id) != null) : null;
            result.NoBoundingBoxElementIds = ElementFocusHelpers.GetNoBoundingBoxElementIds(elements);

            Element firstElement = null;
            if (elements != null && elements.Count > 0)
            {
                firstElement = document.GetElement(new ElementId(elements[0].Id));
            }

            if (firstElement != null)
            {
                ElementId levelId;
                string levelName;
                ElementDiscoveryHelpers.ResolveElementLevel(document, firstElement, out levelId, out levelName);
                if (levelId != null && levelId != ElementId.InvalidElementId)
                {
                    List<PlanCandidateSummary> planCandidates = ElementDiscoveryHelpers.FindPlanCandidates(document, uiDocument, levelId, "", true);
                    result.PlanCandidates = planCandidates;
                    if (planCandidates.Count > 0)
                    {
                        Autodesk.Revit.DB.View suggested = document.GetElement(new ElementId(planCandidates[0].Id)) as Autodesk.Revit.DB.View;
                        result.SuggestedView = ViewCommandHelpers.BuildViewSummary(document, suggested, false, suggested != null && ViewCommandHelpers.FindOpenUIView(uiDocument, suggested.Id) != null);
                        result.FocusSuggestion = "Suggested existing plan: " + planCandidates[0].Name + ". Use open_existing_plan_for_element_level with planMode=elementLevel to open it without triggering Revit's modal closed-view search.";
                    }
                }
            }

            return result;
        }

        private static bool AreElementsVisibleInView(Document document, Autodesk.Revit.DB.View view, IList<ElementId> elementIds)
        {
            if (document == null || view == null || elementIds == null || elementIds.Count == 0)
            {
                return false;
            }

            foreach (ElementId elementId in elementIds)
            {
                Element element = document.GetElement(elementId);
                if (element == null)
                {
                    return false;
                }

                if (!IsElementVisibleInView(element, view))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool IsElementVisibleInView(Element element, Autodesk.Revit.DB.View view)
        {
            try
            {
                return element.get_BoundingBox(view) != null;
            }
            catch
            {
                return false;
            }
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
