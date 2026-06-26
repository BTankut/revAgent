using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPSDK.API.Interfaces;
using RevitMCPCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

namespace RevitMCPCommandSet.Commands.View
{
    public class DeleteReviewViewEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private int? _viewId;
        private string _viewName;
        private string _viewType;
        private bool _exactName;
        private string _mode;
        private bool _confirmDelete;
        private ViewSummary _activeViewBefore;

        public ViewOperationResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetTarget(int? viewId, string viewName, string viewType, bool exactName, string mode, bool confirmDelete)
        {
            _viewId = viewId;
            _viewName = viewName;
            _viewType = viewType;
            _exactName = exactName;
            _mode = string.IsNullOrWhiteSpace(mode) ? "dryRun" : mode.Trim();
            _confirmDelete = confirmDelete;
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
                if (uiDocument == null || uiDocument.Document == null)
                {
                    Complete(new ViewOperationResult
                    {
                        Success = false,
                        Action = "delete_review_view",
                        State = "failed",
                        Error = "No active Revit document is available."
                    });
                    return;
                }

                Document document = uiDocument.Document;
                _activeViewBefore = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true);
                Autodesk.Revit.DB.View targetView;
                List<ViewSummary> candidates;
                string error;
                if (!ViewCommandHelpers.TryResolveView(document, _viewId, _viewName, _viewType, _exactName, out targetView, out candidates, out error))
                {
                    Complete(new ViewOperationResult
                    {
                        Success = false,
                        Action = "delete_review_view",
                        State = "failed",
                        Error = error,
                        Candidates = candidates,
                        ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                        OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument)
                    });
                    return;
                }

                List<string> reviewSignals = ViewCommandHelpers.GetReviewViewSignals(targetView);
                bool isReviewView = reviewSignals.Count > 0;
                ViewSummary targetSummary = ViewCommandHelpers.BuildViewSummary(
                    document,
                    targetView,
                    document.ActiveView != null && document.ActiveView.Id.GetIdValue() == targetView.Id.GetIdValue(),
                    ViewCommandHelpers.FindOpenUIView(uiDocument, targetView.Id) != null);

                if (!isReviewView)
                {
                    Complete(BuildGuarded(document, uiDocument, targetSummary, "non_review_view_delete_blocked", "Only revAgent review, focus, or coordination 3D views can be deleted by this tool.", reviewSignals));
                    return;
                }

                if (targetView.IsTemplate || !(targetView is View3D))
                {
                    Complete(BuildGuarded(document, uiDocument, targetSummary, "unsupported_review_view_type", "Only non-template 3D review views can be deleted by this tool.", reviewSignals));
                    return;
                }

                if (document.ActiveView != null && document.ActiveView.Id.GetIdValue() == targetView.Id.GetIdValue())
                {
                    Complete(BuildGuarded(document, uiDocument, targetSummary, "active_view_delete_blocked", "Activate or close a different view before deleting the active review view.", reviewSignals));
                    return;
                }

                if (ViewCommandHelpers.FindOpenUIView(uiDocument, targetView.Id) != null)
                {
                    Complete(BuildGuarded(document, uiDocument, targetSummary, "open_view_delete_blocked", "Close the review view tab before deleting it.", reviewSignals));
                    return;
                }

                int placedViewportCount = CountPlacedViewports(document, targetView.Id);
                if (placedViewportCount > 0)
                {
                    ViewOperationResult guarded = BuildGuarded(document, uiDocument, targetSummary, "placed_review_view_delete_blocked", "This review view is placed on a sheet. Deleting it would remove sheet viewport layout, so cleanup is blocked.", reviewSignals);
                    guarded.Warnings = new List<string> { "placedViewportCount=" + placedViewportCount };
                    Complete(guarded);
                    return;
                }

                bool dryRun = !string.Equals(_mode, "commit", StringComparison.OrdinalIgnoreCase);
                if (dryRun)
                {
                    Complete(new ViewOperationResult
                    {
                        Success = true,
                        Guarded = false,
                        State = "completed",
                        Action = "delete_review_view",
                        Message = "Dry-run only. Pass mode=\"commit\" and confirmDelete=true to delete this review view.",
                        Changed = false,
                        DryRun = true,
                        Deleted = false,
                        ConfirmDelete = _confirmDelete,
                        TargetIsReviewView = true,
                        ReviewSignals = reviewSignals,
                        TargetView = targetSummary,
                        ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                        OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument),
                        SuggestedNextScopes = new List<string> { "mode=commit", "confirmDelete=true" }
                    });
                    return;
                }

                if (!_confirmDelete)
                {
                    Complete(BuildGuarded(document, uiDocument, targetSummary, "delete_confirmation_required", "Pass confirmDelete=true with mode=\"commit\" to delete the review view.", reviewSignals));
                    return;
                }

                if (document.IsModifiable)
                {
                    Complete(BuildGuarded(document, uiDocument, targetSummary, "document_modifiable_delete_blocked", "The document is currently modifiable; retry when no other transaction is active.", reviewSignals));
                    return;
                }

                ElementId targetViewId = targetView.Id;
                int deletedCount = DeleteView(document, targetViewId);
                Autodesk.Revit.DB.View afterView = document.GetElement(targetViewId) as Autodesk.Revit.DB.View;
                Complete(new ViewOperationResult
                {
                    Success = afterView == null,
                    Guarded = false,
                    State = afterView == null ? "completed" : "failed",
                    Action = "delete_review_view",
                    Message = afterView == null ? "Review view deleted." : "Delete transaction completed but the view still exists.",
                    Error = afterView == null ? null : "delete_not_verified",
                    Changed = afterView == null,
                    DryRun = false,
                    Deleted = afterView == null,
                    ConfirmDelete = true,
                    TargetIsReviewView = true,
                    ReviewSignals = reviewSignals,
                    DeletedElementCount = deletedCount,
                    TargetView = targetSummary,
                    ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                    OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument)
                });
            }
            catch (Exception ex)
            {
                Complete(new ViewOperationResult
                {
                    Success = false,
                    Guarded = false,
                    State = "failed",
                    Action = "delete_review_view",
                    Error = ex.Message
                });
            }
        }

        private int CountPlacedViewports(Document document, ElementId viewId)
        {
            if (document == null || viewId == null)
            {
                return 0;
            }

            using (FilteredElementCollector collector = new FilteredElementCollector(document))
            {
                return collector
                    .OfClass(typeof(Viewport))
                    .Cast<Viewport>()
                    .Count(viewport => viewport != null && viewport.ViewId.GetIdValue() == viewId.GetIdValue());
            }
        }

        private int DeleteView(Document document, ElementId viewId)
        {
            using (Transaction transaction = new Transaction(document, "revAgent delete review view"))
            {
                transaction.Start();
                ICollection<ElementId> deletedIds = document.Delete(viewId);
                transaction.Commit();
                return deletedIds != null ? deletedIds.Count : 0;
            }
        }

        private ViewOperationResult BuildGuarded(Document document, UIDocument uiDocument, ViewSummary targetView, string reason, string message, List<string> reviewSignals)
        {
            return new ViewOperationResult
            {
                Success = true,
                Guarded = true,
                State = "guarded",
                Action = "delete_review_view",
                Reason = reason,
                Message = message,
                Changed = false,
                DryRun = !string.Equals(_mode, "commit", StringComparison.OrdinalIgnoreCase),
                Deleted = false,
                ConfirmDelete = _confirmDelete,
                TargetIsReviewView = reviewSignals != null && reviewSignals.Count > 0,
                ReviewSignals = reviewSignals ?? new List<string>(),
                TargetView = targetView,
                ActiveView = ViewCommandHelpers.BuildViewSummary(document, document.ActiveView, true, true),
                OpenViews = ViewCommandHelpers.GetOpenViewSummaries(uiDocument),
                SuggestedNextScopes = new List<string> { "viewId", "viewName", "mode=commit", "confirmDelete=true", "close_view" }
            };
        }

        private void Complete(ViewOperationResult result)
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
            return "Delete revAgent review view";
        }
    }
}
