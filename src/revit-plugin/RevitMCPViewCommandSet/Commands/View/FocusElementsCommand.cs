using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;
using System.Collections.Generic;

namespace RevitMCPViewCommandSet.Commands.View
{
    public class FocusElementsCommand : ExternalEventCommandBase
    {
        private FocusElementsEventHandler _handler
        {
            get { return (FocusElementsEventHandler)Handler; }
        }

        public override string CommandName
        {
            get { return "focus_elements"; }
        }

        public FocusElementsCommand(UIApplication uiApp)
            : base(new FocusElementsEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            List<int> elementIds = ParseElementIds(parameters);
            int? viewId = parameters != null && parameters["viewId"] != null ? parameters["viewId"].Value<int?>() : null;
            string viewName = parameters != null ? parameters["viewName"] != null ? parameters["viewName"].Value<string>() : null : null;
            string viewType = parameters != null ? parameters["viewType"] != null ? parameters["viewType"].Value<string>() : null : null;
            bool exactName = parameters == null || parameters["exactName"] == null || parameters["exactName"].Value<bool>();
            bool select = parameters == null || parameters["select"] == null || parameters["select"].Value<bool>();
            bool zoom = parameters == null || parameters["zoom"] == null || parameters["zoom"].Value<bool>();
            bool allowPartial = parameters != null && parameters["allowPartial"] != null && parameters["allowPartial"].Value<bool>();
            int timeoutMs = parameters != null && parameters["timeoutMs"] != null ? parameters["timeoutMs"].Value<int>() : 15000;
            if (timeoutMs < 1000) timeoutMs = 1000;
            if (timeoutMs > 60000) timeoutMs = 60000;

            _handler.SetRequest(elementIds, viewId, viewName, viewType, exactName, select, zoom, allowPartial);
            if (RaiseAndWaitForCompletion(timeoutMs))
            {
                return _handler.ResultInfo;
            }

            throw new TimeoutException("Timed out while focusing Revit elements.");
        }

        private static List<int> ParseElementIds(JObject parameters)
        {
            List<int> elementIds = new List<int>();
            JArray rawIds = parameters != null ? parameters["elementIds"] as JArray : null;
            if (rawIds == null)
            {
                return elementIds;
            }

            foreach (JToken token in rawIds)
            {
                int value;
                if (token.Type == JTokenType.String)
                {
                    if (int.TryParse(token.Value<string>(), out value))
                    {
                        elementIds.Add(value);
                    }
                    continue;
                }

                value = token.Value<int>();
                elementIds.Add(value);
            }

            return elementIds;
        }
    }
}
