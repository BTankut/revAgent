using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;

namespace RevitMCPCommandSet.Commands.View
{
    public class DeleteReviewViewCommand : ExternalEventCommandBase
    {
        private DeleteReviewViewEventHandler _handler => (DeleteReviewViewEventHandler)Handler;

        public override string CommandName => "delete_review_view";

        public DeleteReviewViewCommand(UIApplication uiApp)
            : base(new DeleteReviewViewEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            int? viewId = parameters?["viewId"]?.Value<int?>();
            string viewName = parameters?["viewName"]?.Value<string>();
            string viewType = parameters?["viewType"]?.Value<string>();
            bool exactName = parameters?["exactName"]?.Value<bool?>() ?? true;
            string mode = parameters?["mode"]?.Value<string>() ?? "dryRun";
            bool confirmDelete = parameters?["confirmDelete"]?.Value<bool?>() ?? false;
            int timeoutMs = parameters?["timeoutMs"]?.Value<int?>() ?? 15000;
            if (timeoutMs < 1000) timeoutMs = 1000;
            if (timeoutMs > 120000) timeoutMs = 120000;

            _handler.SetTarget(viewId, viewName, viewType, exactName, mode, confirmDelete);
            if (RaiseAndWaitForCompletion(timeoutMs))
            {
                return _handler.ResultInfo;
            }

            throw new TimeoutException("Timed out while deleting review view.");
        }
    }
}
