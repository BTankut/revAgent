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
    public class GetSelectedElementsCommand : ExternalEventCommandBase
    {
        private static readonly object _executionLock = new object();
        private GetSelectedElementsEventHandler _handler => (GetSelectedElementsEventHandler)Handler;

        public override string CommandName => "get_selected_elements";

        public GetSelectedElementsCommand(UIApplication uiApp)
            : base(new GetSelectedElementsEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            lock (_executionLock)
            {
                try
                {
                    // Parse query parameters.
                    int? limit = parameters?["limit"]?.Value<int>();

                    // Pass the result limit to the Revit external event handler.
                    _handler.Limit = limit;

                    // Raise the external event and wait for completion.
                    if (RaiseAndWaitForCompletion(15000))
                    {
                        return _handler.ResultElements;
                    }
                    else
                    {
                        throw new TimeoutException("Timed out while reading selected elements.");
                    }
                }
                catch (Exception ex)
                {
                    throw new Exception($"Failed to read selected elements: {ex.Message}", ex);
                }
            }
        }
    }
}
