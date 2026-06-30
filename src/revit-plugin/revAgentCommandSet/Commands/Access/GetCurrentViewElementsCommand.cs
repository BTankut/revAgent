using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevAgentCommandSet.Services;
using RevitMCPSDK.API.Base;

namespace RevAgentCommandSet.Commands.Access
{
    public class GetCurrentViewElementsCommand : ExternalEventCommandBase
    {
        private GetCurrentViewElementsEventHandler _handler => (GetCurrentViewElementsEventHandler)Handler;

        public override string CommandName => "get_current_view_elements";

        public GetCurrentViewElementsCommand(UIApplication uiApp)
            : base(new GetCurrentViewElementsEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            try
            {
                // Parse query parameters.
                List<string> modelCategoryList = parameters?["modelCategoryList"]?.ToObject<List<string>>() ?? new List<string>();
                List<string> annotationCategoryList = parameters?["annotationCategoryList"]?.ToObject<List<string>>() ?? new List<string>();
                bool includeHidden = parameters?["includeHidden"]?.Value<bool>() ?? false;
                int limit = parameters?["limit"]?.Value<int>() ?? 100;

                // Pass query parameters to the Revit external event handler.
                _handler.SetQueryParameters(modelCategoryList, annotationCategoryList, includeHidden, limit);

                // Raise the external event and wait for completion.
                if (RaiseAndWaitForCompletion(60000))
                {
                    return _handler.ResultInfo;
                }
                else
                {
                    throw new TimeoutException("Timed out while reading elements from the current view.");
                }
            }
            catch (Exception ex)
            {
                throw new Exception($"Failed to read elements from the current view: {ex.Message}", ex);
            }
        }
    }
}
