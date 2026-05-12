using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using RevitMCPSDK.API.Interfaces;
using RevitMCPViewCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

namespace RevitMCPViewCommandSet.Commands.View
{
    public class Create3DViewForElementsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private List<int> _requestedElementIds = new List<int>();
        private string _viewName;
        private bool _reuseExisting;
        private bool _createIfMissing;
        private bool _sectionBox;
        private bool _activate;
        private bool _select;
        private bool _zoom;
        private bool _allowPartial;
        private double _paddingMm;
        private UIApplication _pendingApp;
        private ElementId _pendingViewId = ElementId.InvalidElementId;
        private bool _createdView;
        private bool _reusedView;
        private bool _sectionBoxCleared;
        private int _idlingAttempts;
        private BoundingBoxSummary _pendingBoxSummary;
        private List<int> _pendingNoBoundingBoxElementIds = new List<int>();
        private bool _pendingBoundaryShown;
        private string _pendingBoundaryWarning;
        private bool _pendingChanged;

        public ElementFocusResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetRequest(
            List<int> elementIds,
            string viewName,
            bool reuseExisting,
            bool createIfMissing,
            bool sectionBox,
            bool activate,
            bool select,
            bool zoom,
            bool allowPartial,
            double paddingMm)
        {
            _requestedElementIds = elementIds ?? new List<int>();
            _viewName = viewName;
            _reuseExisting = reuseExisting;
            _createIfMissing = createIfMissing;
            _sectionBox = sectionBox;
            _activate = activate;
            _select = select;
            _zoom = zoom;
            _allowPartial = allowPartial;
            _paddingMm = Math.Max(0, paddingMm);
            _pendingApp = null;
            _pendingViewId = ElementId.InvalidElementId;
            _createdView = false;
            _reusedView = false;
            _sectionBoxCleared = false;
            _idlingAttempts = 0;
            _pendingBoxSummary = null;
            _pendingNoBoundingBoxElementIds = new List<int>();
            _pendingBoundaryShown = false;
            _pendingBoundaryWarning = "";
            _pendingChanged = false;
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
                if (app.ActiveUIDocument.Document.IsModifiable)
                {
                    DeferUntilReady(app);
                    return;
                }

                RunCreateOrReuse(app, false);
            }
            catch (Exception ex)
            {
                Complete(new ElementFocusResult
                {
                    Success = false,
                    Action = "create_3d_view_for_elements",
                    Error = ex.Message
                });
            }
        }

        private void DeferUntilReady(UIApplication app)
        {
            _pendingApp = app;
            _idlingAttempts = 0;
            app.Idling += OnReadyIdling;
        }

        private void OnReadyIdling(object sender, IdlingEventArgs e)
        {
            _idlingAttempts++;
            try
            {
                if (_pendingApp.ActiveUIDocument.Document.IsModifiable)
                {
                    if (_idlingAttempts >= 10)
                    {
                        CompleteFromIdling(new ElementFocusResult
                        {
                            Success = false,
                            Action = "create_3d_view_for_elements",
                            Error = "Revit document stayed modifiable, so 3D view creation was deferred and not executed."
                        }, OnReadyIdling);
                    }
                    return;
                }

                _pendingApp.Idling -= OnReadyIdling;
                RunCreateOrReuse(_pendingApp, true);
            }
            catch (Exception ex)
            {
                CompleteFromIdling(new ElementFocusResult
                {
                    Success = false,
                    Action = "create_3d_view_for_elements",
                    Error = ex.Message
                }, OnReadyIdling);
            }
        }

        private void RunCreateOrReuse(UIApplication app, bool deferred)
        {
            UIDocument uiDocument = app.ActiveUIDocument;
            Document document = uiDocument.Document;

            List<ElementId> elementIds;
            List<ElementSummary> elements;
            List<int> missingElementIds;
            string elementError;
            if (!ElementFocusHelpers.TryResolveElements(document, _requestedElementIds, _allowPartial, out elementIds, out elements, out missingElementIds, out elementError))
            {
                Complete(BuildFailure(document, uiDocument, elementError, elements, missingElementIds));
                return;
            }

            BoundingBoxXYZ sectionBox;
            BoundingBoxSummary boxSummary;
            List<ElementSummary> boxedElements;
            List<int> noBoundingBoxElementIds;
            string boxError;
            sectionBox = null;
            boxSummary = null;
            boxedElements = elements;
            noBoundingBoxElementIds = ElementFocusHelpers.GetNoBoundingBoxElementIds(elements);
            if (_sectionBox)
            {
                if (!ElementFocusHelpers.TryBuildSectionBox(document, elementIds, _paddingMm, out sectionBox, out boxSummary, out boxedElements, out noBoundingBoxElementIds, out boxError))
                {
                    Complete(BuildFailure(document, uiDocument, boxError, boxedElements, missingElementIds));
                    return;
                }
            }

            View3D targetView = null;
            if (_reuseExisting && !string.IsNullOrWhiteSpace(_viewName))
            {
                targetView = FindExisting3DView(document, _viewName);
                _reusedView = targetView != null;
            }

            bool changed = false;
            string boundaryWarning = "";
            bool boundaryShown = false;

            bool createdNow = false;
            if (targetView == null)
            {
                if (!_createIfMissing)
                {
                    Complete(BuildFailure(document, uiDocument, "No matching 3D view was found and createIfMissing=false.", elements, missingElementIds));
                    return;
                }

                targetView = Create3DView(document, elementIds, sectionBox, out boundaryShown, out boundaryWarning);
                _createdView = true;
                createdNow = true;
                changed = true;
            }

            if (!createdNow && (_sectionBox || targetView.IsSectionBoxActive))
            {
                Apply3DViewSettings(document, targetView, sectionBox, out boundaryShown, out boundaryWarning);
                changed = true;
            }

            _pendingApp = app;
            _pendingViewId = targetView.Id;
            _pendingBoxSummary = boxSummary;
            _pendingNoBoundingBoxElementIds = noBoundingBoxElementIds;
            _pendingBoundaryShown = boundaryShown;
            _pendingBoundaryWarning = boundaryWarning;
            _pendingChanged = changed;
            _idlingAttempts = 0;

            if (!_activate)
            {
                Complete(BuildSuccess(uiDocument, targetView, boxedElements, missingElementIds, noBoundingBoxElementIds, boxSummary, deferred, false, changed, boundaryShown, boundaryWarning, "", ""));
                return;
            }

            if (document.ActiveView != null && document.ActiveView.Id.GetIdValue() == targetView.Id.GetIdValue())
            {
                Complete(FocusAndBuildSuccess(uiDocument, targetView, boxedElements, elementIds, missingElementIds, noBoundingBoxElementIds, boxSummary, deferred, false, changed, boundaryShown, boundaryWarning));
                return;
            }

            try
            {
                uiDocument.RequestViewChange(targetView);
            }
            catch
            {
            }

            app.Idling += OnActivationIdling;
        }

        private View3D FindExisting3DView(Document document, string viewName)
        {
            return new FilteredElementCollector(document)
                .WhereElementIsNotElementType()
                .OfClass(typeof(View3D))
                .Cast<View3D>()
                .Where(v => !v.IsTemplate && string.Equals(v.Name, viewName, StringComparison.OrdinalIgnoreCase))
                .OrderBy(v => v.Id.GetIdValue())
                .FirstOrDefault();
        }

        private View3D Create3DView(
            Document document,
            IList<ElementId> elementIds,
            BoundingBoxXYZ sectionBox,
            out bool boundaryShown,
            out string boundaryWarning)
        {
            boundaryShown = false;
            boundaryWarning = "";
            Transaction transaction = new Transaction(document, "Revit MCP create 3D view for elements");
            try
            {
                transaction.Start();

                ViewFamilyType viewFamilyType =
                    new FilteredElementCollector(document)
                        .OfClass(typeof(ViewFamilyType))
                        .Cast<ViewFamilyType>()
                        .FirstOrDefault(v => v.ViewFamily == ViewFamily.ThreeDimensional);
                if (viewFamilyType == null)
                {
                    throw new InvalidOperationException("No 3D ViewFamilyType was found in the active document.");
                }

                View3D view = View3D.CreateIsometric(document, viewFamilyType.Id);
                string requestedName = string.IsNullOrWhiteSpace(_viewName)
                    ? "3D - Focus " + elementIds[0].GetIdValue()
                    : _viewName;
                view.Name = ViewCommandHelpers.MakeUniqueViewName(document, requestedName);

                if (_sectionBox)
                {
                    boundaryShown = EnsureSectionBoxBoundaryVisible(document, view, out boundaryWarning);
                    view.IsSectionBoxActive = true;
                    view.SetSectionBox(sectionBox);
                }
                else
                {
                    view.IsSectionBoxActive = false;
                }

                transaction.Commit();
                return view;
            }
            catch
            {
                RollBackIfNeeded(transaction);
                throw;
            }
        }

        private void Apply3DViewSettings(
            Document document,
            View3D targetView,
            BoundingBoxXYZ sectionBox,
            out bool boundaryShown,
            out string boundaryWarning)
        {
            boundaryShown = false;
            boundaryWarning = "";
            Transaction transaction = new Transaction(document, "Revit MCP update 3D focus view");
            try
            {
                transaction.Start();
                if (_sectionBox)
                {
                    boundaryShown = EnsureSectionBoxBoundaryVisible(document, targetView, out boundaryWarning);
                    targetView.IsSectionBoxActive = true;
                    targetView.SetSectionBox(sectionBox);
                }
                else if (targetView.IsSectionBoxActive)
                {
                    targetView.IsSectionBoxActive = false;
                    _sectionBoxCleared = true;
                }

                transaction.Commit();
            }
            catch
            {
                RollBackIfNeeded(transaction);
                throw;
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

        private void OnActivationIdling(object sender, IdlingEventArgs e)
        {
            _idlingAttempts++;
            try
            {
                UIDocument uiDocument = _pendingApp.ActiveUIDocument;
                Document document = uiDocument.Document;
                View3D targetView = document.GetElement(_pendingViewId) as View3D;
                if (targetView == null)
                {
                    CompleteFromIdling(new ElementFocusResult
                    {
                        Success = false,
                        Action = "create_3d_view_for_elements",
                        Error = "Target 3D view no longer exists.",
                        CreatedView = _createdView,
                        ReusedView = _reusedView
                    }, OnActivationIdling);
                    return;
                }

                List<ElementId> elementIds;
                List<ElementSummary> elements;
                List<int> missingElementIds;
                string elementError;
                if (!ElementFocusHelpers.TryResolveElements(document, _requestedElementIds, _allowPartial, out elementIds, out elements, out missingElementIds, out elementError))
                {
                    CompleteFromIdling(BuildFailure(document, uiDocument, elementError, elements, missingElementIds), OnActivationIdling);
                    return;
                }

                if (document.ActiveView != null && document.ActiveView.Id.GetIdValue() == targetView.Id.GetIdValue())
                {
                    List<int> noBoundingBoxElementIds = _pendingNoBoundingBoxElementIds != null && _pendingNoBoundingBoxElementIds.Count > 0
                        ? _pendingNoBoundingBoxElementIds
                        : ElementFocusHelpers.GetNoBoundingBoxElementIds(elements);
                    CompleteFromIdling(FocusAndBuildSuccess(uiDocument, targetView, elements, elementIds, missingElementIds, noBoundingBoxElementIds, _pendingBoxSummary, _idlingAttempts > 1, true, _pendingChanged, _pendingBoundaryShown, _pendingBoundaryWarning), OnActivationIdling);
                    return;
                }

                if (!document.IsModifiable)
                {
                    uiDocument.RequestViewChange(targetView);
                }

                if (_idlingAttempts >= 10)
                {
                    CompleteFromIdling(new ElementFocusResult
                    {
                        Success = false,
                        Action = "create_3d_view_for_elements",
                        Error = "3D view was created or found, but activation could not be verified.",
                        Changed = _pendingChanged,
                        CreatedView = _createdView,
                        ReusedView = _reusedView,
                        TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, false, false),
                        ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                        OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument),
                        Elements = elements,
                        MissingElementIds = missingElementIds
                    }, OnActivationIdling);
                }
            }
            catch (Exception ex)
            {
                CompleteFromIdling(new ElementFocusResult
                {
                    Success = false,
                    Action = "create_3d_view_for_elements",
                    Error = ex.Message,
                    Changed = _pendingChanged,
                    CreatedView = _createdView,
                    ReusedView = _reusedView
                }, OnActivationIdling);
            }
        }

        private ElementFocusResult FocusAndBuildSuccess(
            UIDocument uiDocument,
            View3D targetView,
            List<ElementSummary> elements,
            IList<ElementId> elementIds,
            List<int> missingElementIds,
            List<int> noBoundingBoxElementIds,
            BoundingBoxSummary boxSummary,
            bool deferred,
            bool requested,
            bool changed,
            bool boundaryShown,
            string boundaryWarning)
        {
            string zoomMethod = ElementFocusHelpers.SelectAndZoom(uiDocument, elementIds, _select, _zoom);
            string focusNote = ElementFocusHelpers.BuildFocusNote(_zoom, zoomMethod, elements);
            return BuildSuccess(uiDocument, targetView, elements, missingElementIds, noBoundingBoxElementIds, boxSummary, deferred, requested, changed, boundaryShown, boundaryWarning, zoomMethod, focusNote);
        }

        private ElementFocusResult BuildSuccess(
            UIDocument uiDocument,
            View3D targetView,
            List<ElementSummary> elements,
            List<int> missingElementIds,
            List<int> noBoundingBoxElementIds,
            BoundingBoxSummary boxSummary,
            bool deferred,
            bool requested,
            bool changed,
            bool boundaryShown,
            string boundaryWarning,
            string zoomMethod,
            string focusNote)
        {
            Document document = uiDocument.Document;
            string message = _createdView
                ? "3D view created for the supplied elements."
                : "3D view reused for the supplied elements.";
            if (!string.IsNullOrWhiteSpace(focusNote))
            {
                message += " " + focusNote;
            }

            string boundingBoxSource = _sectionBox ? "sectionBox" : "none";

            return new ElementFocusResult
            {
                Success = true,
                Action = "create_3d_view_for_elements",
                Message = message,
                Requested = requested,
                Deferred = deferred,
                Changed = changed,
                Selected = _select && _activate,
                Zoomed = _zoom && _activate,
                ZoomMethod = zoomMethod,
                FocusNote = focusNote,
                SectionBoxApplied = _sectionBox,
                SectionBoxBoundaryShown = _sectionBox && boundaryShown,
                SectionBoxBoundaryWarning = _sectionBox ? boundaryWarning : null,
                CreatedView = _createdView,
                ReusedView = _reusedView,
                SectionBoxCleared = _sectionBoxCleared,
                PaddingMm = _sectionBox ? (double?)_paddingMm : null,
                BoundingBoxSource = boundingBoxSource,
                BoundingBoxNote = ElementFocusHelpers.BuildBoundingBoxNote(boundingBoxSource),
                TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, document.ActiveView != null && document.ActiveView.Id.GetIdValue() == targetView.Id.GetIdValue(), true),
                ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument),
                Elements = elements,
                MissingElementIds = missingElementIds,
                NoBoundingBoxElementIds = noBoundingBoxElementIds,
                BoundingBox = _sectionBox ? boxSummary : null
            };
        }

        private ElementFocusResult BuildFailure(Document document, UIDocument uiDocument, string error, List<ElementSummary> elements, List<int> missingElementIds)
        {
            return new ElementFocusResult
            {
                Success = false,
                Action = "create_3d_view_for_elements",
                Error = error,
                Changed = _createdView || _sectionBoxCleared,
                CreatedView = _createdView,
                ReusedView = _reusedView,
                SectionBoxCleared = _sectionBoxCleared,
                PaddingMm = _sectionBox ? (double?)_paddingMm : null,
                BoundingBoxSource = _sectionBox ? "sectionBox" : "none",
                BoundingBoxNote = ElementFocusHelpers.BuildBoundingBoxNote(_sectionBox ? "sectionBox" : "none"),
                ActiveView = document != null ? ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true) : null,
                OpenViews = uiDocument != null ? ViewCommandHelpers.GetOpenViewSummaries(uiDocument) : null,
                Elements = elements,
                MissingElementIds = missingElementIds
            };
        }

        private void RollBackIfNeeded(Transaction transaction)
        {
            try
            {
                if (transaction != null && transaction.GetStatus() == TransactionStatus.Started)
                {
                    transaction.RollBack();
                }
            }
            catch
            {
            }
        }

        private void CompleteFromIdling(ElementFocusResult result, EventHandler<IdlingEventArgs> handler)
        {
            if (_pendingApp != null)
            {
                _pendingApp.Idling -= handler;
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
            return "Create 3D Revit view for elements";
        }
    }
}
