using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;

namespace RevAgentCommandSet.Commands.View
{
    public class ListOpenViewsCommand : ExternalEventCommandBase
    {
        private ListOpenViewsEventHandler _handler => (ListOpenViewsEventHandler)Handler;

        public override string CommandName => "list_open_views";

        public ListOpenViewsCommand(UIApplication uiApp)
            : base(new ListOpenViewsEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            _handler.Reset();
            if (RaiseAndWaitForCompletion(10000))
            {
                return _handler.ResultInfo;
            }

            throw new TimeoutException("Timed out while listing open Revit views.");
        }
    }
}
