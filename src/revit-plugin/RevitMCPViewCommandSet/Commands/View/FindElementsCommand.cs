using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;
using System.Collections.Generic;

namespace RevitMCPViewCommandSet.Commands.View
{
    public class FindElementsCommand : ExternalEventCommandBase
    {
        private FindElementsEventHandler _handler
        {
            get { return (FindElementsEventHandler)Handler; }
        }

        public override string CommandName
        {
            get { return "find_elements"; }
        }

        public FindElementsCommand(UIApplication uiApp)
            : base(new FindElementsEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            string query = parameters != null && parameters["query"] != null ? parameters["query"].Value<string>() : "";
            List<string> categoryNames = ParseStringArray(parameters, "categoryNames");
            bool includePlanCandidates = parameters == null || parameters["includePlanCandidates"] == null || parameters["includePlanCandidates"].Value<bool>();
            string planNameContains = parameters != null && parameters["planNameContains"] != null ? parameters["planNameContains"].Value<string>() : "";
            int limit = parameters != null && parameters["limit"] != null ? parameters["limit"].Value<int>() : 20;
            if (limit < 1) limit = 1;
            if (limit > 200) limit = 200;
            int timeoutMs = parameters != null && parameters["timeoutMs"] != null ? parameters["timeoutMs"].Value<int>() : 30000;
            if (timeoutMs < 1000) timeoutMs = 1000;
            if (timeoutMs > 120000) timeoutMs = 120000;

            _handler.SetRequest(query, categoryNames, includePlanCandidates, planNameContains, limit);
            if (RaiseAndWaitForCompletion(timeoutMs))
            {
                return _handler.ResultInfo;
            }

            throw new TimeoutException("Timed out while finding Revit elements.");
        }

        private static List<string> ParseStringArray(JObject parameters, string name)
        {
            List<string> values = new List<string>();
            JArray array = parameters != null ? parameters[name] as JArray : null;
            if (array == null)
            {
                return values;
            }

            foreach (JToken token in array)
            {
                string value = token.Value<string>();
                if (!string.IsNullOrWhiteSpace(value))
                {
                    values.Add(value);
                }
            }

            return values;
        }
    }
}
