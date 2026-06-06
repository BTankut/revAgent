using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;
using System.Collections.Generic;

namespace RevitMCPCommandSet.Commands.View
{
    public class InspectSchedulesCommand : ExternalEventCommandBase
    {
        private InspectSchedulesEventHandler _handler
        {
            get { return (InspectSchedulesEventHandler)Handler; }
        }

        public override string CommandName
        {
            get { return "inspect_schedules"; }
        }

        public InspectSchedulesCommand(UIApplication uiApp)
            : base(new InspectSchedulesEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            InspectSchedulesRequest request = ParseRequest(parameters);
            _handler.SetRequest(request);
            if (RaiseAndWaitForCompletion(request.TimeoutMs))
            {
                return _handler.ResultInfo;
            }

            throw new TimeoutException("Timed out while inspecting Revit schedules.");
        }

        private static InspectSchedulesRequest ParseRequest(JObject parameters)
        {
            InspectSchedulesRequest request = new InspectSchedulesRequest();
            request.Query = ReadString(parameters, "query", "");
            request.NameQuery = ReadString(parameters, "nameQuery", request.Query);
            request.CellQuery = ReadString(parameters, "cellQuery", "");
            request.ScheduleIds = ParseIntArray(parameters, "scheduleIds");
            request.Sections = ParseSections(parameters, "sections");
            request.IncludeCells = ReadBool(parameters, "includeCells", false);
            request.ScanCells = ReadBool(parameters, "scanCells", false) || !string.IsNullOrWhiteSpace(request.CellQuery);
            request.AllowExpensiveSearch = ReadBool(parameters, "allowExpensiveSearch", false);
            request.SearchBudget = ReadEnum(parameters, "searchBudget", "fast", new HashSet<string> { "fast", "balanced", "deep" });
            request.MaxSchedules = ReadInt(parameters, "maxSchedules", 50, 1, 200);
            request.MaxRowsPerSection = ReadInt(parameters, "maxRowsPerSection", 80, 0, 1000);
            request.MaxColumnsPerSection = ReadInt(parameters, "maxColumnsPerSection", 30, 0, 200);
            request.StartRow = ReadInt(parameters, "startRow", 0, 0, 100000);
            request.StartColumn = ReadInt(parameters, "startColumn", 0, 0, 10000);
            request.MaxCellTextChars = ReadInt(parameters, "maxCellTextChars", 180, 20, 1000);
            request.MaxCells = ReadInt(parameters, "maxCells", DefaultGlobalCap(request.SearchBudget, 5000, 25000, 100000), 1, 500000);
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

            JValue value = parameters[name] as JValue;
            if (value == null)
            {
                return fallback;
            }

            return value.Value != null ? value.Value.ToString() : fallback;
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

        private static List<string> ParseSections(JObject parameters, string name)
        {
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            List<string> sections = new List<string>();
            JArray array = parameters != null ? parameters[name] as JArray : null;
            if (array != null)
            {
                foreach (JToken token in array)
                {
                    string value = (token != null ? token.ToString() : "").Trim().ToLowerInvariant();
                    if ((value == "header" || value == "body" || value == "footer") && seen.Add(value))
                    {
                        sections.Add(value);
                    }
                }
            }

            if (sections.Count == 0)
            {
                sections.Add("header");
                sections.Add("body");
            }

            return sections;
        }
    }
}
