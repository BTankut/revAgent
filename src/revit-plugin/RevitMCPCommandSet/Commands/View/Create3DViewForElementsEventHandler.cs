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
        private bool _fitToScreen;
        private bool _allowPartial;
        private double _paddingMm;
        private double _framingPaddingMm;
        private string _cameraOrientation;
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
        private string _requestedViewName;
        private string _actualViewName;
        private bool _viewNameChanged;
        private string _viewNameResolution;
        private bool _pendingCameraApplied;
        private string _pendingCameraWarning;

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
            bool fitToScreen,
            bool allowPartial,
            double paddingMm,
            double framingPaddingMm,
            string cameraOrientation)
        {
            _requestedElementIds = elementIds ?? new List<int>();
            _viewName = viewName;
            _reuseExisting = reuseExisting;
            _createIfMissing = createIfMissing;
            _sectionBox = sectionBox;
            _activate = activate;
            _select = select;
            _zoom = zoom;
            _fitToScreen = fitToScreen;
            _allowPartial = allowPartial;
            _paddingMm = Math.Max(0, paddingMm);
            _framingPaddingMm = Math.Max(0, framingPaddingMm);
            _cameraOrientation = NormalizeCameraOrientation(cameraOrientation);
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
            _requestedViewName = viewName ?? "";
            _actualViewName = "";
            _viewNameChanged = false;
            _viewNameResolution = "";
            _pendingCameraApplied = false;
            _pendingCameraWarning = "";
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
            bool needsAggregateBox = _sectionBox || ShouldApplyCameraOrientation();
            if (needsAggregateBox)
            {
                double boxPaddingMm = _sectionBox ? _paddingMm : _framingPaddingMm;
                if (!ElementFocusHelpers.TryBuildSectionBox(document, elementIds, boxPaddingMm, out sectionBox, out boxSummary, out boxedElements, out noBoundingBoxElementIds, out boxError))
                {
                    if (_sectionBox)
                    {
                        Complete(BuildFailure(document, uiDocument, boxError, boxedElements, missingElementIds));
                        return;
                    }

                    sectionBox = null;
                    boxSummary = null;
                    boxedElements = elements;
                    noBoundingBoxElementIds = ElementFocusHelpers.GetNoBoundingBoxElementIds(elements);
                    _pendingCameraWarning = boxError;
                }
            }

            View3D targetView = null;
            if (_reuseExisting && !string.IsNullOrWhiteSpace(_viewName))
            {
                targetView = FindExisting3DView(document, _viewName);
                _reusedView = targetView != null;
                if (targetView != null)
                {
                    _requestedViewName = _viewName;
                    _actualViewName = targetView.Name;
                    _viewNameChanged = false;
                    _viewNameResolution = "reusedExisting";
                }
            }

            bool changed = false;
            string boundaryWarning = "";
            bool boundaryShown = false;
            string cameraWarning = _pendingCameraWarning;
            bool cameraApplied = false;

            bool createdNow = false;
            if (targetView == null)
            {
                if (!_createIfMissing)
                {
                    Complete(BuildFailure(document, uiDocument, "No matching 3D view was found and createIfMissing=false.", elements, missingElementIds));
                    return;
                }

                targetView = Create3DView(document, elementIds, sectionBox, out boundaryShown, out boundaryWarning, out cameraApplied, out cameraWarning);
                _createdView = true;
                createdNow = true;
                changed = true;
            }

            if (!createdNow && (_sectionBox || targetView.IsSectionBoxActive || ShouldApplyCameraOrientation()))
            {
                Apply3DViewSettings(document, targetView, sectionBox, out boundaryShown, out boundaryWarning, out cameraApplied, out cameraWarning);
                changed = true;
            }

            _pendingApp = app;
            _pendingViewId = targetView.Id;
            _pendingBoxSummary = boxSummary;
            _pendingNoBoundingBoxElementIds = noBoundingBoxElementIds;
            _pendingBoundaryShown = boundaryShown;
            _pendingBoundaryWarning = boundaryWarning;
            _pendingChanged = changed;
            _pendingCameraApplied = cameraApplied;
            _pendingCameraWarning = cameraWarning;
            _idlingAttempts = 0;

            if (!_activate)
            {
                Complete(BuildSuccess(uiDocument, targetView, boxedElements, missingElementIds, noBoundingBoxElementIds, boxSummary, deferred, false, changed, boundaryShown, boundaryWarning, cameraApplied, cameraWarning, "", "", false, "", ""));
                return;
            }

            if (document.ActiveView != null && document.ActiveView.Id.GetIdValue() == targetView.Id.GetIdValue())
            {
                Complete(FocusAndBuildSuccess(uiDocument, targetView, boxedElements, elementIds, missingElementIds, noBoundingBoxElementIds, boxSummary, deferred, false, changed, boundaryShown, boundaryWarning, cameraApplied, cameraWarning));
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
            out string boundaryWarning,
            out bool cameraApplied,
            out string cameraWarning)
        {
            boundaryShown = false;
            boundaryWarning = "";
            cameraApplied = false;
            cameraWarning = "";
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
                string uniqueName = ViewCommandHelpers.MakeUniqueViewName(document, requestedName);
                view.Name = uniqueName;
                _requestedViewName = requestedName;
                _actualViewName = view.Name;
                _viewNameChanged = !string.Equals(requestedName, view.Name, StringComparison.OrdinalIgnoreCase);
                if (string.IsNullOrWhiteSpace(_viewName))
                {
                    _viewNameResolution = _viewNameChanged ? "generatedDefaultNameWithUniqueSuffix" : "generatedDefaultName";
                }
                else
                {
                    _viewNameResolution = _viewNameChanged ? "createdWithUniqueName" : "createdAsRequested";
                }

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

                ApplyCameraOrientation(view, sectionBox, out cameraApplied, out cameraWarning);

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
            out string boundaryWarning,
            out bool cameraApplied,
            out string cameraWarning)
        {
            boundaryShown = false;
            boundaryWarning = "";
            cameraApplied = false;
            cameraWarning = "";
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

                ApplyCameraOrientation(targetView, sectionBox, out cameraApplied, out cameraWarning);

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

        private void ApplyCameraOrientation(View3D targetView, BoundingBoxXYZ box, out bool applied, out string warning)
        {
            applied = false;
            warning = "";
            if (!ShouldApplyCameraOrientation())
            {
                return;
            }

            if (targetView == null)
            {
                warning = "Target 3D view was not available for camera orientation.";
                return;
            }

            if (box == null)
            {
                warning = string.IsNullOrWhiteSpace(_pendingCameraWarning)
                    ? "No aggregate element bounding box was available for camera orientation."
                    : _pendingCameraWarning;
                return;
            }

            try
            {
                XYZ center = new XYZ(
                    (box.Min.X + box.Max.X) / 2.0,
                    (box.Min.Y + box.Max.Y) / 2.0,
                    (box.Min.Z + box.Max.Z) / 2.0);

                double dx = box.Max.X - box.Min.X;
                double dy = box.Max.Y - box.Min.Y;
                double dz = box.Max.Z - box.Min.Z;
                double diagonal = Math.Sqrt((dx * dx) + (dy * dy) + (dz * dz));
                double distance = Math.Max(diagonal * 2.5, 10.0);

                XYZ forward;
                XYZ upHint;
                GetCameraVectors(_cameraOrientation, out forward, out upHint);
                forward = NormalizeVector(forward);
                XYZ up = OrthonormalizeUp(forward, upHint);
                XYZ eye = new XYZ(
                    center.X - forward.X * distance,
                    center.Y - forward.Y * distance,
                    center.Z - forward.Z * distance);

                targetView.SetOrientation(new ViewOrientation3D(eye, up, forward));
                applied = true;
            }
            catch (Exception ex)
            {
                warning = ex.Message;
            }
        }

        private bool ShouldApplyCameraOrientation()
        {
            return !string.IsNullOrWhiteSpace(_cameraOrientation) &&
                !string.Equals(_cameraOrientation, "unchanged", StringComparison.OrdinalIgnoreCase);
        }

        private static string NormalizeCameraOrientation(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return "unchanged";
            }

            string normalized = value.Trim();
            if (string.Equals(normalized, "iso", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "isometric", StringComparison.OrdinalIgnoreCase))
            {
                return "isometric";
            }
            if (string.Equals(normalized, "top", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "front", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "back", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "left", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "right", StringComparison.OrdinalIgnoreCase))
            {
                return normalized.ToLowerInvariant();
            }

            return "unchanged";
        }

        private static void GetCameraVectors(string orientation, out XYZ forward, out XYZ upHint)
        {
            if (string.Equals(orientation, "top", StringComparison.OrdinalIgnoreCase))
            {
                forward = new XYZ(0, 0, -1);
                upHint = new XYZ(0, 1, 0);
                return;
            }
            if (string.Equals(orientation, "front", StringComparison.OrdinalIgnoreCase))
            {
                forward = new XYZ(0, 1, 0);
                upHint = new XYZ(0, 0, 1);
                return;
            }
            if (string.Equals(orientation, "back", StringComparison.OrdinalIgnoreCase))
            {
                forward = new XYZ(0, -1, 0);
                upHint = new XYZ(0, 0, 1);
                return;
            }
            if (string.Equals(orientation, "left", StringComparison.OrdinalIgnoreCase))
            {
                forward = new XYZ(1, 0, 0);
                upHint = new XYZ(0, 0, 1);
                return;
            }
            if (string.Equals(orientation, "right", StringComparison.OrdinalIgnoreCase))
            {
                forward = new XYZ(-1, 0, 0);
                upHint = new XYZ(0, 0, 1);
                return;
            }

            forward = new XYZ(1, 1, -0.7);
            upHint = new XYZ(0, 0, 1);
        }

        private static XYZ NormalizeVector(XYZ vector)
        {
            double length = Math.Sqrt((vector.X * vector.X) + (vector.Y * vector.Y) + (vector.Z * vector.Z));
            if (length < 0.000001)
            {
                return new XYZ(1, 1, -0.7);
            }

            return new XYZ(vector.X / length, vector.Y / length, vector.Z / length);
        }

        private static XYZ OrthonormalizeUp(XYZ forward, XYZ upHint)
        {
            XYZ normalizedHint = NormalizeVector(upHint);
            double dot = DotProduct(normalizedHint, forward);
            XYZ projected = new XYZ(
                normalizedHint.X - forward.X * dot,
                normalizedHint.Y - forward.Y * dot,
                normalizedHint.Z - forward.Z * dot);

            double length = Math.Sqrt((projected.X * projected.X) + (projected.Y * projected.Y) + (projected.Z * projected.Z));
            if (length < 0.000001)
            {
                projected = new XYZ(0, 1, 0);
            }

            return NormalizeVector(projected);
        }

        private static double DotProduct(XYZ a, XYZ b)
        {
            return (a.X * b.X) + (a.Y * b.Y) + (a.Z * b.Z);
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
                    CompleteFromIdling(FocusAndBuildSuccess(uiDocument, targetView, elements, elementIds, missingElementIds, noBoundingBoxElementIds, _pendingBoxSummary, _idlingAttempts > 1, true, _pendingChanged, _pendingBoundaryShown, _pendingBoundaryWarning, _pendingCameraApplied, _pendingCameraWarning), OnActivationIdling);
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
            string boundaryWarning,
            bool cameraApplied,
            string cameraWarning)
        {
            bool fitToScreenApplied;
            string fitToScreenMethod;
            string fitToScreenWarning;
            string zoomMethod = ElementFocusHelpers.SelectAndZoom(uiDocument, elementIds, _select, _zoom, _fitToScreen, out fitToScreenApplied, out fitToScreenMethod, out fitToScreenWarning);
            string focusNote = ElementFocusHelpers.BuildFocusNote(_zoom, zoomMethod, elements);
            return BuildSuccess(uiDocument, targetView, elements, missingElementIds, noBoundingBoxElementIds, boxSummary, deferred, requested, changed, boundaryShown, boundaryWarning, cameraApplied, cameraWarning, zoomMethod, focusNote, fitToScreenApplied, fitToScreenMethod, fitToScreenWarning);
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
            bool cameraApplied,
            string cameraWarning,
            string zoomMethod,
            string focusNote,
            bool fitToScreenApplied,
            string fitToScreenMethod,
            string fitToScreenWarning)
        {
            Document document = uiDocument.Document;
            string message = _createdView
                ? "3D view created for the supplied elements."
                : "3D view reused for the supplied elements.";
            bool sectionBoxActive = false;
            try
            {
                sectionBoxActive = targetView != null && targetView.IsSectionBoxActive;
            }
            catch
            {
                sectionBoxActive = false;
            }

            if (!string.IsNullOrWhiteSpace(focusNote))
            {
                message += " " + focusNote;
            }

            string boundingBoxSource = _sectionBox ? "sectionBox" : cameraApplied ? "cameraFrame" : "none";
            string sectionBoxNote = ElementFocusHelpers.BuildSectionBoxNote(_sectionBox, sectionBoxActive, _sectionBoxCleared);

            return new ElementFocusResult
            {
                Success = true,
                Action = "create_3d_view_for_elements",
                Message = message,
                Requested = requested,
                Deferred = deferred,
                Changed = changed,
                Selected = _select && _activate,
                Zoomed = (_zoom || fitToScreenApplied) && _activate,
                ZoomMethod = zoomMethod,
                FocusNote = focusNote,
                FitToScreen = fitToScreenApplied,
                FitToScreenMethod = fitToScreenMethod,
                FitToScreenWarning = fitToScreenWarning,
                SectionBoxApplied = _sectionBox,
                SectionBoxBoundaryShown = _sectionBox && boundaryShown,
                SectionBoxBoundaryWarning = _sectionBox ? boundaryWarning : null,
                CreatedView = _createdView,
                ReusedView = _reusedView,
                SectionBoxCleared = _sectionBoxCleared,
                SectionBoxConfirmedOff = !_sectionBox && !sectionBoxActive,
                SectionBoxState = sectionBoxActive ? "active" : "inactive",
                SectionBoxNote = sectionBoxNote,
                PaddingMm = _sectionBox ? (double?)_paddingMm : null,
                CameraOrientation = _cameraOrientation,
                CameraApplied = cameraApplied,
                CameraWarning = cameraWarning,
                FramingPaddingMm = ShouldApplyCameraOrientation() ? (double?)_framingPaddingMm : null,
                BoundingBoxSource = boundingBoxSource,
                BoundingBoxNote = ElementFocusHelpers.BuildBoundingBoxNote(boundingBoxSource),
                RequestedViewName = _requestedViewName,
                ActualViewName = targetView != null ? targetView.Name : _actualViewName,
                ViewNameChanged = _viewNameChanged,
                ViewNameResolution = _viewNameResolution,
                TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, document.ActiveView != null && document.ActiveView.Id.GetIdValue() == targetView.Id.GetIdValue(), true),
                ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument),
                Elements = elements,
                MissingElementIds = missingElementIds,
                NoBoundingBoxElementIds = noBoundingBoxElementIds,
                BoundingBox = (_sectionBox || cameraApplied) ? boxSummary : null
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
                CameraOrientation = _cameraOrientation,
                CameraApplied = _pendingCameraApplied,
                CameraWarning = _pendingCameraWarning,
                FramingPaddingMm = ShouldApplyCameraOrientation() ? (double?)_framingPaddingMm : null,
                RequestedViewName = _requestedViewName,
                ActualViewName = _actualViewName,
                ViewNameChanged = _viewNameChanged,
                ViewNameResolution = _viewNameResolution,
                PaddingMm = _sectionBox ? (double?)_paddingMm : null,
                BoundingBoxSource = _sectionBox ? "sectionBox" : _pendingCameraApplied ? "cameraFrame" : "none",
                BoundingBoxNote = ElementFocusHelpers.BuildBoundingBoxNote(_sectionBox ? "sectionBox" : _pendingCameraApplied ? "cameraFrame" : "none"),
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
