using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;

namespace RevitMCPViewCommandSet.Commands.View
{
    public class OpenExistingPlanForElementLevelCommand : ExternalEventCommandBase
    {
        private OpenExistingPlanForElementLevelEventHandler _handler
        {
            get { return (OpenExistingPlanForElementLevelEventHandler)Handler; }
        }

        public override string CommandName
        {
            get { return "open_existing_plan_for_element_level"; }
        }

        public OpenExistingPlanForElementLevelCommand(UIApplication uiApp)
            : base(new OpenExistingPlanForElementLevelEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            int elementId = parameters != null && parameters["elementId"] != null ? parameters["elementId"].Value<int>() : 0;
            string planNameContains = parameters != null && parameters["planNameContains"] != null ? parameters["planNameContains"].Value<string>() : "";
            string planMode = parameters != null && parameters["planMode"] != null ? parameters["planMode"].Value<string>() : "elementLevel";
            bool preferMechanical = parameters == null || parameters["preferMechanical"] == null || parameters["preferMechanical"].Value<bool>();
            bool select = parameters == null || parameters["select"] == null || parameters["select"].Value<bool>();
            bool zoom = parameters == null || parameters["zoom"] == null || parameters["zoom"].Value<bool>();
            bool fitToScreen = parameters != null && parameters["fitToScreen"] != null && parameters["fitToScreen"].Value<bool>();
            int timeoutMs = parameters != null && parameters["timeoutMs"] != null ? parameters["timeoutMs"].Value<int>() : 20000;
            if (timeoutMs < 1000) timeoutMs = 1000;
            if (timeoutMs > 120000) timeoutMs = 120000;

            _handler.SetRequest(elementId, planNameContains, planMode, preferMechanical, select, zoom, fitToScreen);
            if (RaiseAndWaitForCompletion(timeoutMs))
            {
                return _handler.ResultInfo;
            }

            throw new TimeoutException("Timed out while opening an existing plan for the Revit element level.");
        }
    }
}
