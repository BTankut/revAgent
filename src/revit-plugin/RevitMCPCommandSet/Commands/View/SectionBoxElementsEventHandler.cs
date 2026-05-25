using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Threading;

namespace RevitMCPCommandSet.Commands.View
{
    public class SectionBoxElementsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
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
        private double _paddingMm;
        private UIApplication _pendingApp;
        private ElementId _pendingViewId;
        private bool _hasTargetView;
        private ViewSummary _activeViewBefore;
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
            bool allowPartial,
            double paddingMm)
        {
            _requestedElementIds = elementIds ?? new List<int>();
            _viewId = viewId;
            _viewName = viewName;
            _viewType = viewType;
            _exactName = exactName;
            _select = select;
            _zoom = zoom;
            _allowPartial = allowPartial;
            _paddingMm = Math.Max(0, paddingMm);
            _pendingApp = null;
            _pendingViewId = ElementId.InvalidElementId;
            _hasTargetView = viewId.HasValue || !string.IsNullOrWhiteSpace(viewName);
            _activeViewBefore = null;
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
                _activeViewBefore = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true);

                List<ElementId> elementIds;
                List<ElementSummary> elements;
                List<int> missingElementIds;
                string elementError;
                if (!ElementFocusHelpers.TryResolveElements(document, _requestedElementIds, _allowPartial, out elementIds, out elements, out missingElementIds, out elementError))
                {
                    Complete(BuildFailure(document, uiDocument, elementError, null, null, missingElementIds));
                    return;
                }

                Autodesk.Revit.DB.View targetView;
                List<ViewSummary> candidates;
                string viewError;
                if (!TryResolveTargetView(document, out targetView, out candidates, out viewError))
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

                View3D targetView3D = targetView as View3D;
                if (targetView3D == null)
                {
                    ElementFocusResult result = BuildFailure(document, uiDocument, "Section box can only be applied to a 3D view. Pass viewId or viewName for a 3D view.", candidates, elements, missingElementIds);
                    result.TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, false, false);
                    Complete(result);
                    return;
                }

                if (document.ActiveView == null || document.ActiveView.Id.GetIdValue() != targetView.Id.GetIdValue() || document.IsModifiable)
                {
                    RequestOrDefer(app, targetView, document.IsModifiable);
                    return;
                }

                Complete(ApplySectionBoxNow(uiDocument, targetView3D, elementIds, missingElementIds, false, false));
            }
            catch (Exception ex)
            {
                Complete(new ElementFocusResult
                {
                    Success = false,
                    Action = "section_box_elements",
                    Error = ex.Message
                });
            }
        }

        private bool TryResolveTargetView(
            Document document,
            out Autodesk.Revit.DB.View targetView,
            out List<ViewSummary> candidates,
            out string error)
        {
            targetView = null;
            candidates = new List<ViewSummary>();
            error = "";

            if (_hasTargetView)
            {
                return ViewCommandHelpers.TryResolveView(document, _viewId, _viewName, _viewType, _exactName, out targetView, out candidates, out error);
            }

            targetView = document.ActiveView;
            if (targetView == null)
            {
                error = "No active Revit view is available. Pass a 3D viewId or viewName.";
                return false;
            }

            if (!(targetView is View3D))
            {
                error = "The active view is not a 3D view. Pass viewId or viewName for a 3D view.";
                return false;
            }

            return true;
        }

        private void RequestOrDefer(UIApplication app, Autodesk.Revit.DB.View targetView, bool forceDefer)
        {
            _pendingApp = app;
            _pendingViewId = targetView.Id;
            _idlingAttempts = 0;

            if (!forceDefer)
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

                View3D targetView = document.GetElement(_pendingViewId) as View3D;
                if (targetView == null)
                {
                    CompleteFromIdling(BuildFailure(document, uiDocument, "Target 3D view no longer exists.", null, elements, missingElementIds));
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
                        ElementFocusResult result = BuildFailure(document, uiDocument, "3D view activation was requested but could not be verified.", null, elements, missingElementIds);
                        result.Requested = true;
                        result.TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, false, false);
                        CompleteFromIdling(result);
                    }
                    return;
                }

                if (document.IsModifiable)
                {
                    if (_idlingAttempts >= 10)
                    {
                        CompleteFromIdling(BuildFailure(document, uiDocument, "Revit document stayed modifiable, so section box was deferred and not applied.", null, elements, missingElementIds));
                    }
                    return;
                }

                CompleteFromIdling(ApplySectionBoxNow(uiDocument, targetView, elementIds, missingElementIds, true, _idlingAttempts > 1));
            }
            catch (Exception ex)
            {
                CompleteFromIdling(new ElementFocusResult
                {
                    Success = false,
                    Action = "section_box_elements",
                    Error = ex.Message
                });
            }
        }

        private ElementFocusResult ApplySectionBoxNow(
            UIDocument uiDocument,
            View3D targetView,
            IList<ElementId> elementIds,
            List<int> missingElementIds,
            bool requested,
            bool deferred)
        {
            Document document = uiDocument.Document;
            BoundingBoxXYZ sectionBox;
            BoundingBoxSummary boxSummary;
            List<ElementSummary> elements;
            List<int> noBoundingBoxElementIds;
            string boxError;
            if (!ElementFocusHelpers.TryBuildSectionBox(document, elementIds, _paddingMm, out sectionBox, out boxSummary, out elements, out noBoundingBoxElementIds, out boxError))
            {
                ElementFocusResult failure = BuildFailure(document, uiDocument, boxError, null, elements, missingElementIds);
                failure.NoBoundingBoxElementIds = noBoundingBoxElementIds;
                failure.TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, true, true);
                return failure;
            }

            using (Transaction transaction = new Transaction(document, "Revit MCP section box elements"))
            {
                transaction.Start();
                string boundaryWarning;
                bool boundaryShown = EnsureSectionBoxBoundaryVisible(document, targetView, out boundaryWarning);
                targetView.IsSectionBoxActive = true;
                targetView.SetSectionBox(sectionBox);
                transaction.Commit();

                string zoomMethod = ElementFocusHelpers.SelectAndZoom(uiDocument, elementIds, _select, _zoom);
                string focusNote = ElementFocusHelpers.BuildFocusNote(_zoom, zoomMethod, elements);
                bool sectionBoxActive = false;
                try
                {
                    sectionBoxActive = targetView.IsSectionBoxActive;
                }
                catch
                {
                    sectionBoxActive = false;
                }

                return new ElementFocusResult
                {
                    Success = true,
                    Action = "section_box_elements",
                    Message = string.IsNullOrWhiteSpace(focusNote)
                        ? "Section box applied around the supplied elements."
                        : "Section box applied around the supplied elements. " + focusNote,
                    Requested = requested,
                    Deferred = deferred,
                    Changed = true,
                    Selected = _select,
                    Zoomed = _zoom,
                    ZoomMethod = zoomMethod,
                    FocusNote = focusNote,
                    SectionBoxApplied = true,
                    SectionBoxBoundaryShown = boundaryShown,
                    SectionBoxBoundaryWarning = boundaryWarning,
                    SectionBoxState = sectionBoxActive ? "active" : "inactive",
                    SectionBoxNote = ElementFocusHelpers.BuildSectionBoxNote(true, sectionBoxActive, false),
                    PaddingMm = _paddingMm,
                    BoundingBoxSource = "sectionBox",
                    BoundingBoxNote = ElementFocusHelpers.BuildBoundingBoxNote("sectionBox"),
                    TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, true, true),
                    ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                    OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument),
                    Elements = elements,
                    MissingElementIds = missingElementIds,
                    NoBoundingBoxElementIds = noBoundingBoxElementIds,
                    BoundingBox = boxSummary
                };
            }
        }

        private bool EnsureSectionBoxBoundaryVisible(Document document, View3D targetView, out string warning)
        {
            warning = "";
            try
            {
                Category category = document.Settings.Categories.get_Item(BuiltInCategory.OST_SectionBox);
                if (category == null)
                {
                    warning = "Section Boxes category was not found.";
                    return false;
                }

                if (targetView.GetCategoryHidden(category.Id))
                {
                    targetView.SetCategoryHidden(category.Id, false);
                }

                return !targetView.GetCategoryHidden(category.Id);
            }
            catch (Exception ex)
            {
                warning = ex.Message;
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
                Action = "section_box_elements",
                Error = error,
                PaddingMm = _paddingMm,
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
            if (result != null)
            {
                ViewCommandHelpers.PopulateViewTransition(result, _activeViewBefore, result.ActiveView);
            }
            ResultInfo = result;
            TaskCompleted = true;
            _resetEvent.Set();
        }

        public string GetName()
        {
            return "Section box Revit elements";
        }
    }
}
