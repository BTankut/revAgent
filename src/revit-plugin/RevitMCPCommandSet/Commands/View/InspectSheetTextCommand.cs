using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;
using System.Collections.Generic;

namespace RevitMCPCommandSet.Commands.View
{
    public class InspectSheetTextCommand : ExternalEventCommandBase
    {
        private InspectSheetTextEventHandler _handler
        {
            get { return (InspectSheetTextEventHandler)Handler; }
        }

        public override string CommandName
        {
            get { return "inspect_sheet_text"; }
        }

        public InspectSheetTextCommand(UIApplication uiApp)
            : base(new InspectSheetTextEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            InspectSheetTextRequest request = ParseRequest(parameters);
            _handler.SetRequest(request);
            if (RaiseAndWaitForCompletion(request.TimeoutMs))
            {
                return _handler.ResultInfo;
            }

            throw new TimeoutException("Timed out while inspecting Revit sheet annotations.");
        }

        private static InspectSheetTextRequest ParseRequest(JObject parameters)
        {
            InspectSheetTextRequest request = new InspectSheetTextRequest();
            request.Query = ReadString(parameters, "query", "");
            request.SheetQuery = ReadString(parameters, "sheetQuery", request.Query);
            request.TextQuery = ReadString(parameters, "textQuery", "");
            request.SheetIds = ParseIntArray(parameters, "sheetIds");
            request.IncludeTextNotes = ReadBool(parameters, "includeTextNotes", true);
            request.IncludeScheduleInstances = ReadBool(parameters, "includeScheduleInstances", true);
            request.ScanScheduleCells = ReadBool(parameters, "scanScheduleCells", false);
            request.AllowExpensiveSearch = ReadBool(parameters, "allowExpensiveSearch", false);
            request.SearchBudget = ReadEnum(parameters, "searchBudget", "fast", new HashSet<string> { "fast", "balanced", "deep" });
            request.ViewNameQuery = ReadString(parameters, "viewNameQuery", "");
            request.IncludeViewportTextNotes = ReadBool(parameters, "includeViewportTextNotes", false);
            request.IncludeViewportTags = ReadBool(parameters, "includeViewportTags", false);
            request.MaxSheets = ReadInt(parameters, "maxSheets", 30, 1, 200);
            request.MaxTextNotesPerSheet = ReadInt(parameters, "maxTextNotesPerSheet", 200, 0, 1000);
            request.MaxScheduleInstancesPerSheet = ReadInt(parameters, "maxScheduleInstancesPerSheet", 100, 0, 300);
            request.MaxRowsPerSchedule = ReadInt(parameters, "maxRowsPerSchedule", 80, 0, 500);
            request.MaxColumnsPerSchedule = ReadInt(parameters, "maxColumnsPerSchedule", 30, 0, 100);
            request.MaxTextChars = ReadInt(parameters, "maxTextChars", 240, 20, 1000);
            request.MaxViewportsPerSheet = ReadInt(parameters, "maxViewportsPerSheet", 20, 0, 200);
            request.MaxViewportTextNotesPerView = ReadInt(parameters, "maxViewportTextNotesPerView", 200, 0, 1000);
            request.MaxViewportTagsPerView = ReadInt(parameters, "maxViewportTagsPerView", 100, 0, 500);
            request.MaxTextNotesScanned = ReadInt(parameters, "maxTextNotesScanned", DefaultGlobalCap(request.SearchBudget, 1000, 5000, 20000), 1, 200000);
            request.MaxTagsScanned = ReadInt(parameters, "maxTagsScanned", DefaultGlobalCap(request.SearchBudget, 500, 2500, 10000), 1, 100000);
            request.MaxScheduleInstancesScanned = ReadInt(parameters, "maxScheduleInstancesScanned", DefaultGlobalCap(request.SearchBudget, 500, 2500, 10000), 1, 100000);
            request.MaxScheduleCellsScanned = ReadInt(parameters, "maxScheduleCellsScanned", DefaultGlobalCap(request.SearchBudget, 5000, 25000, 100000), 1, 500000);
            request.MaxResponseBytes = ReadInt(parameters, "maxResponseBytes", 4 * 1024 * 1024, 4096, 16 * 1024 * 1024);
            request.TimeoutMs = ReadInt(parameters, "timeoutMs", 120000, 1000, 120000);

            int defaultElapsed = DefaultElapsedMs(request.SearchBudget);
            request.MaxElapsedMs = ReadInt(parameters, "maxElapsedMs", defaultElapsed, 1, 119000);
            if (request.MaxElapsedMs > request.TimeoutMs - 1000)
            {
                request.MaxElapsedMs = Math.Max(1, request.TimeoutMs - 1000);
            }

            return request;
        }

        private static int DefaultElapsedMs(string budget)
        {
            if (string.Equals(budget, "deep", StringComparison.OrdinalIgnoreCase)) return 45000;
            if (string.Equals(budget, "balanced", StringComparison.OrdinalIgnoreCase)) return 15000;
            return 4500;
        }

        private static int DefaultGlobalCap(string budget, int fast, int balanced, int deep)
        {
            if (string.Equals(budget, "deep", StringComparison.OrdinalIgnoreCase)) return deep;
            if (string.Equals(budget, "balanced", StringComparison.OrdinalIgnoreCase)) return balanced;
            return fast;
        }

        private static string ReadEnum(JObject parameters, string name, string fallback, HashSet<string> allowed)
        {
            string value = ReadString(parameters, name, fallback).Trim();
            return allowed.Contains(value) ? value : fallback;
        }

        private static string ReadString(JObject parameters, string name, string fallback)
        {
            if (parameters == null || parameters[name] == null)
            {
                return fallback;
            }

            string value = parameters[name].Value<string>();
            return value ?? fallback;
        }

        private static bool ReadBool(JObject parameters, string name, bool fallback)
        {
            if (parameters == null || parameters[name] == null)
            {
                return fallback;
            }

            bool value;
            if (bool.TryParse(parameters[name].ToString(), out value))
            {
                return value;
            }
            return fallback;
        }

        private static int ReadInt(JObject parameters, string name, int fallback, int min, int max)
        {
            if (parameters == null || parameters[name] == null)
            {
                return fallback;
            }

            int value;
            if (!int.TryParse(parameters[name].ToString(), out value))
            {
                value = fallback;
            }
            if (value < min) value = min;
            if (value > max) value = max;
            return value;
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
    }
}
