using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;

namespace RevitMCPCommandSet.Commands.View
{
    public class GetUiStateCommand : ExternalEventCommandBase
    {
        private GetUiStateEventHandler _handler
        {
            get { return (GetUiStateEventHandler)Handler; }
        }

        public override string CommandName
        {
            get { return "get_ui_state"; }
        }

        public GetUiStateCommand(UIApplication uiApp)
            : base(new GetUiStateEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            int selectionLimit = parameters != null && parameters["selectionLimit"] != null
                ? parameters["selectionLimit"].Value<int>()
                : 100;
            if (selectionLimit < 0) selectionLimit = 0;
            if (selectionLimit > 1000) selectionLimit = 1000;

            _handler.SetRequest(selectionLimit);
            if (RaiseAndWaitForCompletion(10000))
            {
                return _handler.ResultInfo;
            }

            throw new TimeoutException("Timed out while reading Revit UI state.");
        }
    }
}
