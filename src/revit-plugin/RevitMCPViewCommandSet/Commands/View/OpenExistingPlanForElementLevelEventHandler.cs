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
    public class OpenExistingPlanForElementLevelEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private int _elementId;
        private string _planNameContains;
        private string _planMode;
        private bool _preferMechanical;
        private bool _select;
        private bool _zoom;
        private bool _fitToScreen;
        private UIApplication _pendingApp;
        private ElementId _pendingViewId = ElementId.InvalidElementId;
        private int _idlingAttempts;
        private ElementSearchItem _elementInfo;
        private List<PlanCandidateSummary> _planCandidates;
        private ViewSummary _activeViewBefore;

        public ElementFocusResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetRequest(
            int elementId,
            string planNameContains,
            string planMode,
            bool preferMechanical,
            bool select,
            bool zoom,
            bool fitToScreen)
        {
            _elementId = elementId;
            _planNameContains = planNameContains ?? "";
            _planMode = NormalizePlanMode(planMode);
            _preferMechanical = preferMechanical;
            _select = select;
            _zoom = zoom;
            _fitToScreen = fitToScreen;
            _pendingApp = null;
            _pendingViewId = ElementId.InvalidElementId;
            _idlingAttempts = 0;
            _elementInfo = null;
            _planCandidates = null;
            _activeViewBefore = null;
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

                Element element = document.GetElement(new ElementId(_elementId));
                if (element == null)
                {
                    Complete(BuildFailure(document, uiDocument, "Element was not found."));
                    return;
                }

                ElementId levelId;
                string levelName;
                ElementDiscoveryHelpers.ResolveElementLevel(document, element, out levelId, out levelName);
                if (levelId == null || levelId == ElementId.InvalidElementId)
                {
                    _elementInfo = ElementDiscoveryHelpers.BuildElementSearchItem(document, uiDocument, element, false, _planNameContains);
                    Complete(BuildFailure(document, uiDocument, "Element level could not be resolved."));
                    return;
                }

                _elementInfo = ElementDiscoveryHelpers.BuildElementSearchItem(document, uiDocument, element, false, _planNameContains);
                _planCandidates = ElementDiscoveryHelpers.FindPlanCandidates(document, uiDocument, levelId, _planNameContains, _preferMechanical, element);

                if (UseActivePlanOnly())
                {
                    ViewPlan activePlan = document.ActiveView as ViewPlan;
                    if (activePlan == null || activePlan.IsTemplate)
                    {
                        Complete(BuildFailure(document, uiDocument, "planMode=activePlan requires the current active view to be a non-template plan view."));
                        return;
                    }

                    PlanCandidateSummary activePlanCandidate = ElementDiscoveryHelpers.BuildActivePlanCandidate(activePlan, document, element);
                    _pendingApp = app;
                    _pendingViewId = activePlan.Id;
                    _idlingAttempts = 0;

                    if (document.IsModifiable)
                    {
                        app.Idling += OnIdling;
                        return;
                    }

                    Complete(FocusAndBuildSuccess(uiDocument, activePlan, activePlanCandidate, false, false));
                    return;
                }

                if (_planCandidates.Count == 0)
                {
                    Complete(BuildFailure(document, uiDocument, "No existing non-template plan was found for the element level."));
                    return;
                }

                PlanCandidateSummary selected = _planCandidates.FirstOrDefault(c => c.ElementVisibleInView == true);
                if (selected == null)
                {
                    Complete(BuildFailure(document, uiDocument, "No existing non-template plan on the element level contains the target element."));
                    return;
                }
                Autodesk.Revit.DB.View targetView = document.GetElement(new ElementId(selected.Id)) as Autodesk.Revit.DB.View;
                if (targetView == null)
                {
                    Complete(BuildFailure(document, uiDocument, "Selected plan view no longer exists."));
                    return;
                }

                _pendingApp = app;
                _pendingViewId = targetView.Id;
                _idlingAttempts = 0;

                if (document.ActiveView != null && document.ActiveView.Id.GetIdValue() == targetView.Id.GetIdValue())
                {
                    Complete(FocusAndBuildSuccess(uiDocument, targetView, selected, false, false));
                    return;
                }

                if (!document.IsModifiable)
                {
                    try
                    {
                        uiDocument.RequestViewChange(targetView);
                    }
                    catch
                    {
                    }
                }

                app.Idling += OnIdling;
            }
            catch (Exception ex)
            {
                Complete(new ElementFocusResult
                {
                    Success = false,
                    Action = "open_existing_plan_for_element_level",
                    Error = ex.Message
                });
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
                    CompleteFromIdling(BuildFailure(document, uiDocument, "Selected plan view no longer exists."));
                    return;
                }

                if (document.ActiveView != null && document.ActiveView.Id.GetIdValue() == _pendingViewId.GetIdValue())
                {
                    PlanCandidateSummary selected = _planCandidates != null ? _planCandidates.FirstOrDefault(p => p.Id == _pendingViewId.GetIdValue()) : null;
                    if (selected == null && UseActivePlanOnly())
                    {
                        selected = ElementDiscoveryHelpers.BuildActivePlanCandidate(targetView as ViewPlan, document, document.GetElement(new ElementId(_elementId)));
                    }
                    CompleteFromIdling(FocusAndBuildSuccess(uiDocument, targetView, selected, true, _idlingAttempts > 1));
                    return;
                }

                if (!document.IsModifiable)
                {
                    uiDocument.RequestViewChange(targetView);
                }

                if (_idlingAttempts >= 10)
                {
                    CompleteFromIdling(BuildFailure(document, uiDocument, "Plan activation was requested but could not be verified."));
                }
            }
            catch (Exception ex)
            {
                CompleteFromIdling(new ElementFocusResult
                {
                    Success = false,
                    Action = "open_existing_plan_for_element_level",
                    Error = ex.Message
                });
            }
        }

        private ElementFocusResult FocusAndBuildSuccess(
            UIDocument uiDocument,
            Autodesk.Revit.DB.View targetView,
            PlanCandidateSummary selected,
            bool requested,
            bool deferred)
        {
            Document document = uiDocument.Document;
            ElementId elementId = new ElementId(_elementId);
            List<ElementId> elementIds = new List<ElementId> { elementId };
            Element element = document.GetElement(elementId);
            List<ElementSummary> elements = new List<ElementSummary>();
            if (element != null)
            {
                elements.Add(ElementFocusHelpers.BuildElementSummary(element, ElementFocusHelpers.HasModelBoundingBox(element)));
            }

            bool activeViewChanged = _activeViewBefore != null && _activeViewBefore.Id != targetView.Id.GetIdValue();
            ViewPlan targetPlan = targetView as ViewPlan;
            int? activePlanLevelId = null;
            string activePlanLevelName = "";
            bool activePlanMatchesElementLevel = false;
            if (targetPlan != null && targetPlan.GenLevel != null)
            {
                activePlanLevelId = targetPlan.GenLevel.Id.GetIdValue();
                activePlanLevelName = targetPlan.GenLevel.Name;
                activePlanMatchesElementLevel = _elementInfo != null && _elementInfo.LevelId.HasValue && activePlanLevelId.Value == _elementInfo.LevelId.Value;
            }

            if (UseActivePlanOnly() && _zoom && !activePlanMatchesElementLevel)
            {
                return BuildActivePlanVisibilityFailure(
                    document,
                    uiDocument,
                    targetView,
                    selected,
                    elements,
                    activeViewChanged,
                    activePlanLevelId,
                    activePlanLevelName,
                    activePlanMatchesElementLevel);
            }

            string targetVisibilityReason;
            if (_zoom && element != null && !ElementFocusHelpers.IsElementVisibleInView(document, element, targetView, out targetVisibilityReason))
            {
                return BuildTargetPlanVisibilityFailure(
                    document,
                    uiDocument,
                    targetView,
                    selected,
                    elements,
                    activeViewChanged,
                    activePlanLevelId,
                    activePlanLevelName,
                    activePlanMatchesElementLevel,
                    targetVisibilityReason);
            }

            bool fitToScreenApplied;
            string fitToScreenMethod;
            string fitToScreenWarning;
            string zoomMethod = ElementFocusHelpers.SelectAndZoom(uiDocument, elementIds, _select, _zoom, _fitToScreen, out fitToScreenApplied, out fitToScreenMethod, out fitToScreenWarning);
            string focusNote = ElementFocusHelpers.BuildFocusNote(_zoom, zoomMethod, elements);
            bool targetStillActive = document.ActiveView != null && document.ActiveView.Id.GetIdValue() == targetView.Id.GetIdValue();
            string focusWarning = "";

            string planOpenMode;
            string planOpenNote;
            string planVisibilityWarning = "";
            if (UseActivePlanOnly())
            {
                planOpenMode = "activePlanOnly";
                planOpenNote = "The active plan was used exactly as requested; no level-based plan switch was attempted and no new plan was created.";
                if (!activePlanMatchesElementLevel)
                {
                    planVisibilityWarning = "The active plan level does not match the element level; the element may be selected but not visibly framed in this view.";
                }
            }
            else
            {
                planOpenMode = activeViewChanged
                    ? "elementLevelExistingPlanActivated"
                    : "activeViewAlreadyMatchedElementLevel";
                planOpenNote = activeViewChanged
                    ? "The active view was changed to an existing plan on the element level; no new plan was created."
                    : "The active view was already the selected existing plan for the element level; no new plan was created.";
            }

            if (_zoom && !targetStillActive)
            {
                focusWarning = "Revit focus changed the active view after ShowElements; TargetView/SelectedPlan differs from final ActiveView.";
                planVisibilityWarning = string.IsNullOrWhiteSpace(planVisibilityWarning)
                    ? focusWarning
                    : planVisibilityWarning + " " + focusWarning;
            }

            return new ElementFocusResult
            {
                Success = true,
                Action = "open_existing_plan_for_element_level",
                Message = string.IsNullOrWhiteSpace(focusNote)
                    ? "Existing plan for the element level was opened and focused."
                    : "Existing plan for the element level was opened and focused. " + focusNote,
                Requested = requested,
                Deferred = deferred,
                Changed = activeViewChanged,
                Selected = _select,
                Zoomed = _zoom || fitToScreenApplied,
                ZoomMethod = zoomMethod,
                FocusNote = focusNote,
                FitToScreen = fitToScreenApplied,
                FitToScreenMethod = fitToScreenMethod,
                FitToScreenWarning = fitToScreenWarning,
                FocusWarning = focusWarning,
                ActiveViewBefore = _activeViewBefore,
                ActiveViewChanged = activeViewChanged,
                PlanMode = _planMode,
                PlanOpenMode = planOpenMode,
                PlanOpenNote = planOpenNote,
                ActivePlanMatchesElementLevel = activePlanMatchesElementLevel,
                ActivePlanLevelId = activePlanLevelId,
                ActivePlanLevelName = activePlanLevelName,
                PlanVisibilityWarning = planVisibilityWarning,
                TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, targetStillActive, ViewCommandHelpers.FindOpenUIView(uiDocument, targetView.Id) != null),
                SelectedPlan = ViewCommandHelpers.BuildViewSummary(document, targetView, targetStillActive, ViewCommandHelpers.FindOpenUIView(uiDocument, targetView.Id) != null),
                ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument),
                Elements = elements,
                LevelId = _elementInfo != null ? _elementInfo.LevelId : null,
                LevelName = _elementInfo != null ? _elementInfo.LevelName : "",
                PlanCandidates = _planCandidates,
                PlanSelectionReason = selected != null ? selected.Reason : "",
                BoundingBoxSource = "none",
                BoundingBoxNote = ElementFocusHelpers.BuildBoundingBoxNote("none"),
                BoundingBox = null
            };
        }

        private ElementFocusResult BuildTargetPlanVisibilityFailure(
            Document document,
            UIDocument uiDocument,
            Autodesk.Revit.DB.View targetView,
            PlanCandidateSummary selected,
            List<ElementSummary> elements,
            bool activeViewChanged,
            int? activePlanLevelId,
            string activePlanLevelName,
            bool activePlanMatchesElementLevel,
            string visibilityReason)
        {
            string message = "The target plan does not contain the element; Revit ShowElements was not called to avoid changing focus to another view.";
            PlanCandidateSummary suggestedPlan = _planCandidates != null ? _planCandidates.FirstOrDefault(p => p.ElementVisibleInView == true) : null;
            ViewSummary suggestedView = null;
            if (suggestedPlan != null && selected != null && suggestedPlan.Id != selected.Id)
            {
                Autodesk.Revit.DB.View suggested = document.GetElement(new ElementId(suggestedPlan.Id)) as Autodesk.Revit.DB.View;
                suggestedView = ViewCommandHelpers.BuildViewSummary(
                    document,
                    suggested,
                    false,
                    suggested != null && ViewCommandHelpers.FindOpenUIView(uiDocument, suggested.Id) != null);
                message += " Suggested existing plan: " + suggestedPlan.Name + ".";
            }

            return new ElementFocusResult
            {
                Success = false,
                Action = "open_existing_plan_for_element_level",
                Message = message,
                Error = message,
                Requested = false,
                Deferred = false,
                Changed = activeViewChanged,
                Selected = false,
                Zoomed = false,
                FocusBlocked = true,
                FocusBlockReason = string.IsNullOrWhiteSpace(visibilityReason) ? "elementNotVisibleInTargetView" : visibilityReason,
                FocusSuggestion = suggestedPlan != null && selected != null && suggestedPlan.Id != selected.Id
                    ? "Use " + suggestedPlan.Name + " or omit the restrictive planNameContains value."
                    : "Use a plan view whose view-specific collector contains the element.",
                SuggestedView = suggestedView,
                ActiveViewBefore = _activeViewBefore,
                ActiveViewChanged = activeViewChanged,
                PlanMode = _planMode,
                PlanOpenMode = UseActivePlanOnly() ? "activePlanOnlyBlocked" : "elementLevelExistingPlanBlocked",
                PlanOpenNote = "The selected plan was rejected because the target element is not present in the view-specific collector.",
                ActivePlanMatchesElementLevel = activePlanMatchesElementLevel,
                ActivePlanLevelId = activePlanLevelId,
                ActivePlanLevelName = activePlanLevelName,
                PlanVisibilityWarning = "The selected plan does not contain the target element: " + visibilityReason + ".",
                TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, document.ActiveView != null && document.ActiveView.Id.GetIdValue() == targetView.Id.GetIdValue(), targetView != null && ViewCommandHelpers.FindOpenUIView(uiDocument, targetView.Id) != null),
                SelectedPlan = ViewCommandHelpers.BuildViewSummary(document, targetView, document.ActiveView != null && document.ActiveView.Id.GetIdValue() == targetView.Id.GetIdValue(), targetView != null && ViewCommandHelpers.FindOpenUIView(uiDocument, targetView.Id) != null),
                ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument),
                Elements = elements,
                LevelId = _elementInfo != null ? _elementInfo.LevelId : null,
                LevelName = _elementInfo != null ? _elementInfo.LevelName : "",
                PlanCandidates = _planCandidates,
                PlanSelectionReason = selected != null ? selected.Reason : "",
                BoundingBoxSource = "none",
                BoundingBoxNote = ElementFocusHelpers.BuildBoundingBoxNote("none"),
                BoundingBox = null
            };
        }

        private ElementFocusResult BuildActivePlanVisibilityFailure(
            Document document,
            UIDocument uiDocument,
            Autodesk.Revit.DB.View targetView,
            PlanCandidateSummary selected,
            List<ElementSummary> elements,
            bool activeViewChanged,
            int? activePlanLevelId,
            string activePlanLevelName,
            bool activePlanMatchesElementLevel)
        {
            string message = "Active plan does not match element level; Revit ShowElements was not called to avoid the closed-view search dialog.";
            PlanCandidateSummary suggestedPlan = _planCandidates != null ? _planCandidates.FirstOrDefault() : null;
            ViewSummary suggestedView = null;
            if (suggestedPlan != null)
            {
                Autodesk.Revit.DB.View suggested = document.GetElement(new ElementId(suggestedPlan.Id)) as Autodesk.Revit.DB.View;
                suggestedView = ViewCommandHelpers.BuildViewSummary(
                    document,
                    suggested,
                    false,
                    suggested != null && ViewCommandHelpers.FindOpenUIView(uiDocument, suggested.Id) != null);
                message += " Suggested existing plan: " + suggestedPlan.Name + ".";
            }

            return new ElementFocusResult
            {
                Success = false,
                Action = "open_existing_plan_for_element_level",
                Message = message,
                Error = message,
                Requested = false,
                Deferred = false,
                Changed = activeViewChanged,
                Selected = false,
                Zoomed = false,
                FocusBlocked = true,
                FocusBlockReason = "elementLevelDoesNotMatchPlanView",
                FocusSuggestion = suggestedPlan != null
                    ? "Use planMode=elementLevel to open " + suggestedPlan.Name + " without triggering Revit's modal closed-view search."
                    : "Use planMode=elementLevel or pass a plan view on the element level.",
                SuggestedView = suggestedView,
                ActiveViewBefore = _activeViewBefore,
                ActiveViewChanged = activeViewChanged,
                PlanMode = _planMode,
                PlanOpenMode = "activePlanOnlyBlocked",
                PlanOpenNote = "The active plan was kept as requested, but focus was blocked because its level does not match the element level.",
                ActivePlanMatchesElementLevel = activePlanMatchesElementLevel,
                ActivePlanLevelId = activePlanLevelId,
                ActivePlanLevelName = activePlanLevelName,
                PlanVisibilityWarning = "The active plan level does not match the element level; focusing here would trigger Revit's closed-view search prompt.",
                TargetView = ViewCommandHelpers.BuildViewSummary(document, targetView, true, true),
                SelectedPlan = ViewCommandHelpers.BuildViewSummary(document, targetView, true, true),
                ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument),
                Elements = elements,
                LevelId = _elementInfo != null ? _elementInfo.LevelId : null,
                LevelName = _elementInfo != null ? _elementInfo.LevelName : "",
                PlanCandidates = _planCandidates,
                PlanSelectionReason = selected != null ? selected.Reason : "",
                BoundingBoxSource = "none",
                BoundingBoxNote = ElementFocusHelpers.BuildBoundingBoxNote("none"),
                BoundingBox = null
            };
        }

        private ElementFocusResult BuildFailure(Document document, UIDocument uiDocument, string error)
        {
            List<ElementSummary> elements = null;
            if (_elementInfo != null)
            {
                elements = new List<ElementSummary>
                {
                    new ElementSummary
                    {
                        Id = _elementInfo.Id,
                        UniqueId = _elementInfo.UniqueId,
                        Name = _elementInfo.Name,
                        Category = _elementInfo.Category,
                        ClassName = _elementInfo.ClassName,
                        HasBoundingBox = _elementInfo.HasBoundingBox
                    }
                };
            }

            return new ElementFocusResult
            {
                Success = false,
                Action = "open_existing_plan_for_element_level",
                Error = error,
                ActiveViewBefore = _activeViewBefore,
                PlanMode = _planMode,
                ActiveView = document != null ? ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true) : null,
                OpenViews = uiDocument != null ? ViewCommandHelpers.GetOpenViewSummaries(uiDocument) : null,
                Elements = elements,
                LevelId = _elementInfo != null ? _elementInfo.LevelId : null,
                LevelName = _elementInfo != null ? _elementInfo.LevelName : "",
                PlanCandidates = _planCandidates,
                BoundingBoxSource = "none",
                BoundingBoxNote = ElementFocusHelpers.BuildBoundingBoxNote("none")
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
            return "Open existing plan for element level";
        }

        private static string NormalizePlanMode(string value)
        {
            if (string.Equals(value, "activeView", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(value, "activePlan", StringComparison.OrdinalIgnoreCase))
            {
                return "activePlan";
            }

            return "elementLevel";
        }

        private bool UseActivePlanOnly()
        {
            return string.Equals(_planMode, "activePlan", StringComparison.OrdinalIgnoreCase);
        }
    }
}
