using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;
using System.Collections.Generic;

namespace RevitMCPCommandSet.Commands.View
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
            bool includePlanCandidates = parameters != null && parameters["includePlanCandidates"] != null && parameters["includePlanCandidates"].Value<bool>();
            string planCandidateMode = parameters != null && parameters["planCandidateMode"] != null ? parameters["planCandidateMode"].Value<string>() : "";
            if (string.IsNullOrWhiteSpace(planCandidateMode))
            {
                planCandidateMode = includePlanCandidates ? "verified" : "none";
            }
            planCandidateMode = planCandidateMode.Trim().ToLowerInvariant();
            if (planCandidateMode != "none" && planCandidateMode != "metadata" && planCandidateMode != "verified")
            {
                planCandidateMode = includePlanCandidates ? "verified" : "none";
            }
            includePlanCandidates = planCandidateMode != "none";
            int maxPlanCandidates = parameters != null && parameters["maxPlanCandidates"] != null ? parameters["maxPlanCandidates"].Value<int>() : 3;
            if (maxPlanCandidates < 0) maxPlanCandidates = 0;
            if (maxPlanCandidates > 25) maxPlanCandidates = 25;
            string planNameContains = parameters != null && parameters["planNameContains"] != null ? parameters["planNameContains"].Value<string>() : "";
            int limit = parameters != null && parameters["limit"] != null ? parameters["limit"].Value<int>() : 20;
            if (limit < 1) limit = 1;
            if (limit > 200) limit = 200;
            int timeoutMs = parameters != null && parameters["timeoutMs"] != null ? parameters["timeoutMs"].Value<int>() : 30000;
            if (timeoutMs < 1000) timeoutMs = 1000;
            if (timeoutMs > 120000) timeoutMs = 120000;

            _handler.SetRequest(query, categoryNames, includePlanCandidates, planCandidateMode, planNameContains, limit, maxPlanCandidates);
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
