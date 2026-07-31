using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;
using System.Collections.Generic;
using System.Linq;

namespace RevAgentCommandSet.Commands.Spatial
{
    public class InspectLevelsCommand : ExternalEventCommandBase
    {
        private InspectLevelsEventHandler HandlerInstance
        {
            get { return (InspectLevelsEventHandler)Handler; }
        }

        public override string CommandName
        {
            get { return "inspect_levels"; }
        }

        public InspectLevelsCommand(UIApplication uiApp)
            : base(new InspectLevelsEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            InspectLevelsRequest request = ParseRequest(parameters);

            HandlerInstance.SetRequest(request);
            if (RaiseAndWaitForCompletion(request.TimeoutMs))
            {
                return HandlerInstance.ResultInfo;
            }

            throw new TimeoutException("Timed out while inspecting Revit levels.");
        }

        /// <summary>
        /// Shared command seam: used by the solo command path above and by the
        /// execute_batch step runner, which executes the handler directly on
        /// the Revit API thread.
        /// </summary>
        internal static InspectLevelsRequest ParseRequest(JObject parameters)
        {
            return new InspectLevelsRequest
            {
                SourceScope = ReadSourceScope(parameters),
                LinkInstanceIds = ReadIntArray(parameters, "linkInstanceIds"),
                LinkInstanceUniqueIds = ReadStringArray(parameters, "linkInstanceUniqueIds"),
                NameQuery = ReadString(parameters, "nameQuery", "").Trim(),
                NameMatchMode = ReadNameMatchMode(parameters),
                MaxResults = ReadInt(parameters, "maxResults", 500, 1, 5000),
                TimeoutMs = ReadInt(parameters, "timeoutMs", 30000, 2000, 60000)
            };
        }

        private static string ReadSourceScope(JObject parameters)
        {
            string value = ReadString(parameters, "sourceScope", "hostAndLinked").Trim();
            if (string.Equals(value, "hostOnly", StringComparison.OrdinalIgnoreCase)) return "hostOnly";
            if (string.Equals(value, "linkedOnly", StringComparison.OrdinalIgnoreCase)) return "linkedOnly";
            return "hostAndLinked";
        }

        private static string ReadNameMatchMode(JObject parameters)
        {
            string value = ReadString(parameters, "nameMatchMode", "contains").Trim();
            return string.Equals(value, "exact", StringComparison.OrdinalIgnoreCase) ? "exact" : "contains";
        }

        private static string ReadString(JObject parameters, string name, string fallback)
        {
            JToken token = parameters != null ? parameters[name] : null;
            return token != null && token.Type != JTokenType.Null ? token.ToString() : fallback;
        }

        private static int ReadInt(JObject parameters, string name, int fallback, int minimum, int maximum)
        {
            int value;
            if (parameters == null || parameters[name] == null || !int.TryParse(parameters[name].ToString(), out value))
            {
                value = fallback;
            }
            return Math.Max(minimum, Math.Min(maximum, value));
        }

        private static List<int> ReadIntArray(JObject parameters, string name)
        {
            JArray array = parameters != null ? parameters[name] as JArray : null;
            if (array == null) return new List<int>();

            return array
                .Select(token =>
                {
                    int value;
                    return int.TryParse(token != null ? token.ToString() : "", out value) ? value : 0;
                })
                .Where(value => value > 0)
                .Distinct()
                .OrderBy(value => value)
                .ToList();
        }

        private static List<string> ReadStringArray(JObject parameters, string name)
        {
            JArray array = parameters != null ? parameters[name] as JArray : null;
            if (array == null) return new List<string>();

            return array
                .Select(token => (token != null ? token.ToString() : "").Trim())
                .Where(value => value.Length > 0)
                .Distinct(StringComparer.Ordinal)
                .OrderBy(value => value, StringComparer.Ordinal)
                .ToList();
        }
    }
}
