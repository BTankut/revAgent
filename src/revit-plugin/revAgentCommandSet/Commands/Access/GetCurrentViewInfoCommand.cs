using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevAgentCommandSet.Services;
using RevitMCPSDK.API.Base;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

namespace RevAgentCommandSet.Commands.Access
{
    public class GetCurrentViewInfoCommand : ExternalEventCommandBase
    {
        private GetCurrentViewInfoEventHandler _handler => (GetCurrentViewInfoEventHandler)Handler;

        public override string CommandName => "get_current_view_info";

        public GetCurrentViewInfoCommand(UIApplication uiApp)
            : base(new GetCurrentViewInfoEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            // Raise the external event and wait for completion.
            if (RaiseAndWaitForCompletion(10000))
            {
                return _handler.ResultInfo;
            }
            else
            {
                throw new TimeoutException("Timed out while reading current view information.");
            }
        }
    }
}
