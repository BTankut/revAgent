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
            string originalQuery = parameters != null && parameters["originalQuery"] != null ? parameters["originalQuery"].Value<string>() : "";
            string query = parameters != null && parameters["query"] != null ? parameters["query"].Value<string>() : "";
            List<string> categoryNames = ParseStringArray(parameters, "categoryNames");
            List<int> elementIds = ParseIntArray(parameters, "elementIds");
            List<string> uniqueIds = ParseStringArray(parameters, "uniqueIds");
            List<string> levelNames = ParseStringArray(parameters, "levelNames");
            List<int> levelIds = ParseIntArray(parameters, "levelIds");
            bool activeViewOnly = parameters != null && parameters["activeViewOnly"] != null && parameters["activeViewOnly"].Value<bool>();
            int? viewId = ParseNullableInt(parameters, "viewId");
            string familyName = parameters != null && parameters["familyName"] != null ? parameters["familyName"].Value<string>() : "";
            string typeName = parameters != null && parameters["typeName"] != null ? parameters["typeName"].Value<string>() : "";
            string systemName = parameters != null && parameters["systemName"] != null ? parameters["systemName"].Value<string>() : "";
            List<string> worksetNames = ParseStringArray(parameters, "worksetNames");
            List<int> worksetIds = ParseIntArray(parameters, "worksetIds");
            string linkScope = parameters != null && parameters["linkScope"] != null ? parameters["linkScope"].Value<string>() : "hostOnly";
            if (linkScope != "hostOnly" && linkScope != "linkedOnly" && linkScope != "hostAndLinked")
            {
                linkScope = "hostOnly";
            }
            string searchBudget = parameters != null && parameters["searchBudget"] != null ? parameters["searchBudget"].Value<string>() : "fast";
            bool allowExpensiveSearch = parameters != null && parameters["allowExpensiveSearch"] != null && parameters["allowExpensiveSearch"].Value<bool>();
            int maxElementsScanned = parameters != null && parameters["maxElementsScanned"] != null ? parameters["maxElementsScanned"].Value<int>() : 5000;
            if (maxElementsScanned < 1) maxElementsScanned = 1;
            if (maxElementsScanned > 500000) maxElementsScanned = 500000;
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
            int maxElapsedMs = parameters != null && parameters["maxElapsedMs"] != null ? parameters["maxElapsedMs"].Value<int>() : Math.Min(4500, Math.Max(500, timeoutMs - 2500));
            if (maxElapsedMs < 500) maxElapsedMs = 500;
            if (maxElapsedMs > timeoutMs - 1000) maxElapsedMs = Math.Max(500, timeoutMs - 1000);
            if (maxElapsedMs > 119000) maxElapsedMs = 119000;
            object inferredScope = parameters != null && parameters["inferredScope"] != null ? parameters["inferredScope"].ToObject<object>() : null;

            _handler.SetRequest(
                originalQuery,
                query,
                categoryNames,
                elementIds,
                uniqueIds,
                levelNames,
                levelIds,
                activeViewOnly,
                viewId,
                familyName,
                typeName,
                systemName,
                worksetNames,
                worksetIds,
                linkScope,
                searchBudget,
                allowExpensiveSearch,
                maxElementsScanned,
                maxElapsedMs,
                includePlanCandidates,
                planCandidateMode,
                planNameContains,
                limit,
                maxPlanCandidates,
                inferredScope);
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

        private static List<int> ParseIntArray(JObject parameters, string name)
        {
            List<int> values = new List<int>();
            JArray array = parameters != null ? parameters[name] as JArray : null;
            if (array == null)
            {
                return values;
            }

            foreach (JToken token in array)
            {
                int value;
                if (int.TryParse(token.ToString(), out value) && value > 0)
                {
                    values.Add(value);
                }
            }

            return values;
        }

        private static int? ParseNullableInt(JObject parameters, string name)
        {
            if (parameters == null || parameters[name] == null)
            {
                return null;
            }
            int value;
            if (int.TryParse(parameters[name].ToString(), out value) && value > 0)
            {
                return value;
            }
            return null;
        }
    }
}
