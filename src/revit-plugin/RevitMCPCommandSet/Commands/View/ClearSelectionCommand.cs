using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;

namespace RevitMCPCommandSet.Commands.View
{
    public class ClearSelectionCommand : ExternalEventCommandBase
    {
        private ClearSelectionEventHandler _handler => (ClearSelectionEventHandler)Handler;

        public override string CommandName => "clear_selection";

        public ClearSelectionCommand(UIApplication uiApp)
            : base(new ClearSelectionEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            int timeoutMs = parameters?["timeoutMs"]?.Value<int?>() ?? 10000;
            if (timeoutMs < 1000) timeoutMs = 1000;
            if (timeoutMs > 30000) timeoutMs = 30000;

            _handler.SetRequest();
            if (RaiseAndWaitForCompletion(timeoutMs))
            {
                return _handler.ResultInfo;
            }

            throw new TimeoutException("Timed out while clearing Revit selection.");
        }
    }
}
