using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;

namespace RevAgentCommandSet.Commands.View
{
    public class ActivateViewCommand : ExternalEventCommandBase
    {
        private ActivateViewEventHandler _handler => (ActivateViewEventHandler)Handler;

        public override string CommandName => "activate_view";

        public ActivateViewCommand(UIApplication uiApp)
            : base(new ActivateViewEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            int? viewId = parameters?["viewId"]?.Value<int?>();
            string viewName = parameters?["viewName"]?.Value<string>();
            string viewType = parameters?["viewType"]?.Value<string>();
            bool exactName = parameters?["exactName"]?.Value<bool?>() ?? true;
            int timeoutMs = parameters?["timeoutMs"]?.Value<int?>() ?? 15000;
            if (timeoutMs < 1000) timeoutMs = 1000;
            if (timeoutMs > 120000) timeoutMs = 120000;

            _handler.SetTarget(viewId, viewName, viewType, exactName);
            if (RaiseAndWaitForCompletion(timeoutMs))
            {
                return _handler.ResultInfo;
            }

            throw new TimeoutException("Timed out while activating Revit view.");
        }
    }
}
