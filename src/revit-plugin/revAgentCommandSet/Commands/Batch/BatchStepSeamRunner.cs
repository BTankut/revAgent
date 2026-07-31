using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.AddinLoopback;
using RevAgentCommandSet.Commands.Spatial;
using RevAgentCommandSet.Commands.View;
using RevAgentCommandSet.Services;
using RevAgentPlugin.Core;
using System;
using System.Collections.Generic;

namespace RevAgentCommandSet.Commands.Batch
{
    /// <summary>
    /// Executes one validated batch step through the extracted command seam:
    /// a fresh event-handler instance is configured with the same parameter
    /// parsing as the solo command and its <c>Execute(UIApplication)</c> body
    /// runs directly on the current Revit API thread. No nested ExternalEvent
    /// is raised or awaited.
    /// </summary>
    internal static class BatchStepSeamRunner
    {
        public static AddinBatchStepOutcome Run(UIApplication app, AddinBatchStep step)
        {
            object rawResult = ExecuteSeam(app, step.Method, step.Parameters);
            JToken canonicalResult = BridgeResultContract.ToCamelCaseToken(rawResult);
            return AddinBatchStepOutcome.FromCommandResult(canonicalResult);
        }

        private static object ExecuteSeam(UIApplication app, string method, JObject parameters)
        {
            switch (method)
            {
                case "get_current_view_elements":
                    return RunGetCurrentViewElements(app, parameters);
                case "get_current_view_info":
                    return RunGetCurrentViewInfo(app);
                case "get_selected_elements":
                    return RunGetSelectedElements(app, parameters);
                case "list_open_views":
                    return RunListOpenViews(app);
                case "get_ui_state":
                    return RunGetUiState(app, parameters);
                case "find_elements":
                    return RunFindElements(app, parameters);
                case "inspect_levels":
                    return RunInspectLevels(app, parameters);
                case "inspect_sheet_text":
                    return RunInspectSheetText(app, parameters);
                case "inspect_schedules":
                    return RunInspectSchedules(app, parameters);
                case "count_annotations":
                    return RunCountAnnotations(app, parameters);
                case "extract_spatial_snapshot":
                    return RunExtractSpatialSnapshot(app, parameters);
                case "get_spatial_change_state":
                    return RunGetSpatialChangeState(app, parameters);
                case "delete_review_view":
                    return RunDeleteReviewView(app, parameters);
                default:
                    // Unreachable behind AddinBatchRequestParser; fail closed.
                    throw new InvalidOperationException(
                        "Method '" + method + "' has no batchable command seam.");
            }
        }

        private static object RunGetCurrentViewElements(UIApplication app, JObject parameters)
        {
            List<string> modelCategoryList =
                parameters?["modelCategoryList"]?.ToObject<List<string>>() ?? new List<string>();
            List<string> annotationCategoryList =
                parameters?["annotationCategoryList"]?.ToObject<List<string>>() ?? new List<string>();
            bool includeHidden = parameters?["includeHidden"]?.Value<bool>() ?? false;
            int limit = parameters?["limit"]?.Value<int>() ?? 100;

            GetCurrentViewElementsEventHandler handler = new GetCurrentViewElementsEventHandler();
            handler.SetQueryParameters(modelCategoryList, annotationCategoryList, includeHidden, limit);
            handler.Execute(app);
            return handler.ResultInfo;
        }

        private static object RunGetCurrentViewInfo(UIApplication app)
        {
            GetCurrentViewInfoEventHandler handler = new GetCurrentViewInfoEventHandler();
            handler.Execute(app);
            return handler.ResultInfo;
        }

        private static object RunGetSelectedElements(UIApplication app, JObject parameters)
        {
            int? limit = parameters?["limit"]?.Value<int>();
            GetSelectedElementsEventHandler handler = new GetSelectedElementsEventHandler();
            handler.Limit = limit;
            handler.Execute(app);
            return handler.ResultElements;
        }

        private static object RunListOpenViews(UIApplication app)
        {
            ListOpenViewsEventHandler handler = new ListOpenViewsEventHandler();
            handler.Reset();
            handler.Execute(app);
            return handler.ResultInfo;
        }

        private static object RunGetUiState(UIApplication app, JObject parameters)
        {
            int selectionLimit = parameters != null && parameters["selectionLimit"] != null
                ? parameters["selectionLimit"].Value<int>()
                : 100;
            if (selectionLimit < 0) selectionLimit = 0;
            if (selectionLimit > 1000) selectionLimit = 1000;

            GetUiStateEventHandler handler = new GetUiStateEventHandler();
            handler.SetRequest(selectionLimit);
            handler.Execute(app);
            return handler.ResultInfo;
        }

        private static object RunFindElements(UIApplication app, JObject parameters)
        {
            FindElementsEventHandler handler = new FindElementsEventHandler();
            FindElementsCommand.ApplyRequest(handler, parameters);
            handler.Execute(app);
            return handler.ResultInfo;
        }

        private static object RunInspectLevels(UIApplication app, JObject parameters)
        {
            InspectLevelsEventHandler handler = new InspectLevelsEventHandler();
            handler.SetRequest(InspectLevelsCommand.ParseRequest(parameters));
            handler.Execute(app);
            return handler.ResultInfo;
        }

        private static object RunInspectSheetText(UIApplication app, JObject parameters)
        {
            InspectSheetTextEventHandler handler = new InspectSheetTextEventHandler();
            handler.SetRequest(InspectSheetTextCommand.ParseRequest(parameters));
            handler.Execute(app);
            return handler.ResultInfo;
        }

        private static object RunInspectSchedules(UIApplication app, JObject parameters)
        {
            InspectSchedulesEventHandler handler = new InspectSchedulesEventHandler();
            handler.SetRequest(InspectSchedulesCommand.ParseRequest(parameters));
            handler.Execute(app);
            return handler.ResultInfo;
        }

        private static object RunCountAnnotations(UIApplication app, JObject parameters)
        {
            CountAnnotationsEventHandler handler = new CountAnnotationsEventHandler();
            handler.SetRequest(CountAnnotationsCommand.ParseRequest(parameters));
            handler.Execute(app);
            return handler.ResultInfo;
        }

        private static object RunExtractSpatialSnapshot(UIApplication app, JObject parameters)
        {
            ExtractSpatialSnapshotEventHandler handler = new ExtractSpatialSnapshotEventHandler();
            handler.SetRequest(ExtractSpatialSnapshotCommand.ParseRequest(parameters));
            handler.Execute(app);
            return handler.ResultInfo;
        }

        private static object RunGetSpatialChangeState(UIApplication app, JObject parameters)
        {
            GetSpatialChangeStateEventHandler handler = new GetSpatialChangeStateEventHandler();
            handler.SetRequest(GetSpatialChangeStateCommand.ParseRequest(parameters));
            handler.Execute(app);
            GetSpatialChangeStateResult result = handler.ResultInfo;
            if (result != null)
            {
                // The evaluation ran live in Revit API context inside the one
                // batch ExternalEvent; the process cache is intentionally not
                // consulted or populated on the batch path.
                result.LivenessProbeBasis = "revit_external_event";
                result.LivenessCacheHit = false;
                result.LivenessGeneration = SpatialChangeTracker.Instance.LivenessGeneration;
            }

            return result;
        }

        private static object RunDeleteReviewView(UIApplication app, JObject parameters)
        {
            int? viewId = parameters?["viewId"]?.Value<int?>();
            string viewName = parameters?["viewName"]?.Value<string>();
            string viewType = parameters?["viewType"]?.Value<string>();
            bool exactName = parameters?["exactName"]?.Value<bool?>() ?? true;
            string mode = parameters?["mode"]?.Value<string>() ?? "dryRun";
            bool confirmDelete = parameters?["confirmDelete"]?.Value<bool?>() ?? false;

            DeleteReviewViewEventHandler handler = new DeleteReviewViewEventHandler();
            handler.SetTarget(viewId, viewName, viewType, exactName, mode, confirmDelete);
            handler.Execute(app);
            return handler.ResultInfo;
        }
    }
}
