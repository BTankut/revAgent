using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;
using System.Collections.Generic;

namespace RevAgentCommandSet.Commands.View
{
    public class CountAnnotationsCommand : ExternalEventCommandBase
    {
        private CountAnnotationsEventHandler _handler
        {
            get { return (CountAnnotationsEventHandler)Handler; }
        }

        public override string CommandName
        {
            get { return "count_annotations"; }
        }

        public CountAnnotationsCommand(UIApplication uiApp)
            : base(new CountAnnotationsEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            AnnotationCountRequest request = ParseRequest(parameters);
            _handler.SetRequest(request);
            if (RaiseAndWaitForCompletion(request.TimeoutMs))
            {
                return _handler.ResultInfo;
            }

            throw new TimeoutException("Timed out while counting Revit annotations.");
        }

        private static AnnotationCountRequest ParseRequest(JObject parameters)
        {
            AnnotationCountRequest request = new AnnotationCountRequest();
            request.Query = ReadString(parameters, "query", "");
            request.SheetQuery = ReadString(parameters, "sheetQuery", "");
            request.SheetIds = ParseIntArray(parameters, "sheetIds");
            request.ViewNameQuery = ReadString(parameters, "viewNameQuery", "");
            request.CountMode = ReadCountMode(parameters, "countMode", "occurrence");
            request.GroupBy = ParseStringArray(parameters, "groupBy");
            request.SourcesExplicit = HasArray(parameters, "sources");
            request.Sources = ParseSources(parameters, request.CountMode);
            request.Profiles = ParseProfiles(parameters);
            request.AllowExpensiveSearch = ReadBool(parameters, "allowExpensiveSearch", false);
            request.SearchBudget = ReadEnum(parameters, "searchBudget", "fast", new HashSet<string> { "fast", "balanced", "deep" });
            request.MaxSheets = ReadInt(parameters, "maxSheets", 30, 1, 200);
            request.MaxViewportsPerSheet = ReadInt(parameters, "maxViewportsPerSheet", ReadInt(parameters, "maxViewports", 20, 0, 200), 0, 200);
            request.MaxTextNotesScanned = ReadInt(parameters, "maxTextNotesScanned", DefaultGlobalCap(request.SearchBudget, 1000, 5000, 20000), 1, 200000);
            request.MaxTagsScanned = ReadInt(parameters, "maxTagsScanned", ReadInt(parameters, "maxTags", DefaultGlobalCap(request.SearchBudget, 500, 2500, 10000), 1, 100000), 1, 100000);
            request.MaxScheduleInstancesPerSheet = ReadInt(parameters, "maxScheduleInstancesPerSheet", 20, 0, 200);
            request.MaxRowsPerSchedule = ReadInt(parameters, "maxRowsPerSchedule", 250, 1, 2000);
            request.MaxColumnsPerSchedule = ReadInt(parameters, "maxColumnsPerSchedule", 20, 1, 200);
            request.MaxScheduleInstancesScanned = ReadInt(parameters, "maxScheduleInstancesScanned", DefaultGlobalCap(request.SearchBudget, 200, 1000, 5000), 1, 20000);
            request.MaxScheduleCellsScanned = ReadInt(parameters, "maxScheduleCellsScanned", DefaultGlobalCap(request.SearchBudget, 1000, 5000, 20000), 1, 200000);
            request.MaxMatches = ReadInt(parameters, "maxMatches", DefaultGlobalCap(request.SearchBudget, 1000, 5000, 20000), 1, 200000);
            request.MaxTextChars = ReadInt(parameters, "maxTextChars", 240, 1, 1000);
            request.MaxRegexPatternLength = ReadInt(parameters, "maxRegexPatternLength", 240, 1, 1000);
            request.RegexTimeoutMs = ReadInt(parameters, "regexTimeoutMs", 25, 1, 250);
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

        private static List<AnnotationCountProfile> ParseProfiles(JObject parameters)
        {
            List<AnnotationCountProfile> profiles = new List<AnnotationCountProfile>();
            JArray rawProfiles = parameters != null ? parameters["profiles"] as JArray : null;
            if (rawProfiles != null)
            {
                int profileOrdinal = 0;
                foreach (JToken token in rawProfiles)
                {
                    JObject rawProfile = token as JObject;
                    if (rawProfile == null) continue;
                    profileOrdinal++;
                    string profileName = ReadString(rawProfile, "profileName", ReadString(rawProfile, "name", "profile." + profileOrdinal.ToString()));
                    AnnotationCountProfile profile = new AnnotationCountProfile
                    {
                        ProfileName = string.IsNullOrWhiteSpace(profileName) ? "profile." + profileOrdinal.ToString() : profileName.Trim(),
                        Patterns = new List<AnnotationCountPattern>()
                    };

                    JArray rawPatterns = rawProfile["patterns"] as JArray;
                    if (rawPatterns != null)
                    {
                        int patternOrdinal = 0;
                        foreach (JToken patternToken in rawPatterns)
                        {
                            patternOrdinal++;
                            AnnotationCountPattern pattern = ParsePattern(patternToken, profile.ProfileName, patternOrdinal);
                            if (pattern != null)
                            {
                                profile.Patterns.Add(pattern);
                            }
                        }
                    }

                    if (profile.Patterns.Count > 0)
                    {
                        profiles.Add(profile);
                    }
                }
            }

            if (profiles.Count == 0)
            {
                AnnotationCountProfile anonymous = new AnnotationCountProfile
                {
                    ProfileName = ReadString(parameters, "profileName", "anonymous"),
                    Patterns = new List<AnnotationCountPattern>()
                };
                string explicitMode = ReadString(parameters, "matchMode", "");
                string query = ReadString(parameters, "query", "");
                string regex = ReadString(parameters, "regex", "");
                string normalizedRegex = ReadString(parameters, "normalizedRegex", "");
                if (!string.IsNullOrWhiteSpace(regex))
                {
                    anonymous.Patterns.Add(BuildPattern("anonymous.regex.1", "regex", regex));
                }
                if (!string.IsNullOrWhiteSpace(normalizedRegex))
                {
                    anonymous.Patterns.Add(BuildPattern("anonymous.normalizedRegex.1", "normalizedRegex", normalizedRegex));
                }
                if (!string.IsNullOrWhiteSpace(query))
                {
                    string mode = NormalizeMatchMode(explicitMode);
                    if (string.IsNullOrWhiteSpace(mode)) mode = "contains";
                    anonymous.Patterns.Add(BuildPattern("anonymous." + mode + "." + (anonymous.Patterns.Count + 1).ToString(), mode, query));
                }
                if (anonymous.Patterns.Count == 0)
                {
                    anonymous.Patterns.Add(BuildPattern("anonymous.all.1", "contains", ""));
                }
                profiles.Add(anonymous);
            }

            return profiles;
        }

        private static AnnotationCountPattern ParsePattern(JToken token, string profileName, int ordinal)
        {
            JValue scalar = token as JValue;
            if (scalar != null)
            {
                return BuildPattern(profileName + ".contains." + ordinal.ToString(), "contains", scalar.Value != null ? scalar.Value.ToString() : "");
            }

            JObject raw = token as JObject;
            if (raw == null) return null;

            string mode = NormalizeMatchMode(ReadString(raw, "matchMode", ReadString(raw, "mode", "")));
            string value = ReadString(raw, "value", ReadString(raw, "pattern", ReadString(raw, "text", ReadString(raw, "query", ""))));
            if (raw["exact"] != null)
            {
                mode = "exact";
                value = raw["exact"].ToString();
            }
            else if (raw["startsWith"] != null)
            {
                mode = "startsWith";
                value = raw["startsWith"].ToString();
            }
            else if (raw["contains"] != null)
            {
                mode = "contains";
                value = raw["contains"].ToString();
            }
            else if (raw["regex"] != null)
            {
                mode = "regex";
                value = raw["regex"].ToString();
            }
            else if (raw["normalizedRegex"] != null)
            {
                mode = "normalizedRegex";
                value = raw["normalizedRegex"].ToString();
            }

            if (string.IsNullOrWhiteSpace(mode)) mode = "contains";
            string name = ReadString(raw, "patternName", ReadString(raw, "name", profileName + "." + mode + "." + ordinal.ToString()));
            return BuildPattern(name, mode, value);
        }

        private static AnnotationCountPattern BuildPattern(string name, string mode, string value)
        {
            return new AnnotationCountPattern
            {
                PatternName = string.IsNullOrWhiteSpace(name) ? "pattern" : name.Trim(),
                MatchMode = NormalizeMatchMode(mode),
                Value = value ?? ""
            };
        }

        private static string NormalizeMatchMode(string mode)
        {
            string normalized = (mode ?? "").Trim();
            if (string.Equals(normalized, "exact", StringComparison.OrdinalIgnoreCase)) return "exact";
            if (string.Equals(normalized, "startswith", StringComparison.OrdinalIgnoreCase) || string.Equals(normalized, "startsWith", StringComparison.OrdinalIgnoreCase)) return "startsWith";
            if (string.Equals(normalized, "regex", StringComparison.OrdinalIgnoreCase)) return "regex";
            if (string.Equals(normalized, "normalizedregex", StringComparison.OrdinalIgnoreCase) || string.Equals(normalized, "normalizedRegex", StringComparison.OrdinalIgnoreCase)) return "normalizedRegex";
            if (string.Equals(normalized, "contains", StringComparison.OrdinalIgnoreCase)) return "contains";
            return string.IsNullOrWhiteSpace(normalized) ? "" : "contains";
        }

        private static List<string> ParseSources(JObject parameters, string countMode)
        {
            List<string> sources = new List<string>();
            JArray raw = parameters != null ? parameters["sources"] as JArray : null;
            if (raw != null)
            {
                foreach (JToken token in raw)
                {
                    string source = NormalizeSource(token != null ? token.ToString() : "");
                    if (!string.IsNullOrWhiteSpace(source) && !sources.Contains(source))
                    {
                        sources.Add(source);
                    }
                }
            }

            if (sources.Count == 0)
            {
                if (IsTagCountMode(countMode))
                {
                    sources.Add("viewport_tags");
                }
                else
                {
                    sources.Add("sheet_text_notes");
                    sources.Add("viewport_text_notes");
                    sources.Add("placed_schedule_cells");
                    sources.Add("viewport_tags");
                }
            }

            return sources;
        }

        private static string NormalizeSource(string value)
        {
            string normalized = (value ?? "").Trim();
            if (string.Equals(normalized, "sheetTextNotes", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "sheetTextNote", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "sheet_text_notes", StringComparison.OrdinalIgnoreCase))
            {
                return "sheet_text_notes";
            }
            if (string.Equals(normalized, "viewportTags", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "viewportTag", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "viewport_tags", StringComparison.OrdinalIgnoreCase))
            {
                return "viewport_tags";
            }
            if (string.Equals(normalized, "viewportTextNotes", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "viewportTextNote", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "viewport_text_notes", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "viewport_text_note", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "view_text_notes", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "viewTextNotes", StringComparison.OrdinalIgnoreCase))
            {
                return "viewport_text_notes";
            }
            if (string.Equals(normalized, "placedScheduleCells", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "placedScheduleCell", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "placed_schedule_cells", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "placed_schedule_cell", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "schedule_cells", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "schedule_cell", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "scheduleCells", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalized, "scheduleCell", StringComparison.OrdinalIgnoreCase))
            {
                return "placed_schedule_cells";
            }
            return normalized;
        }

        private static bool IsTagCountMode(string countMode)
        {
            return string.Equals(countMode, "uniqueTag", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(countMode, "uniqueTaggedElement", StringComparison.OrdinalIgnoreCase);
        }

        private static string ReadCountMode(JObject parameters, string name, string fallback)
        {
            string value = ReadString(parameters, name, fallback).Trim();
            if (string.Equals(value, "unique_text", StringComparison.OrdinalIgnoreCase) || string.Equals(value, "uniqueText", StringComparison.OrdinalIgnoreCase)) return "uniqueText";
            if (string.Equals(value, "unique_tag", StringComparison.OrdinalIgnoreCase) || string.Equals(value, "uniqueTag", StringComparison.OrdinalIgnoreCase)) return "uniqueTag";
            if (string.Equals(value, "unique_tagged_element", StringComparison.OrdinalIgnoreCase) || string.Equals(value, "uniqueTaggedElement", StringComparison.OrdinalIgnoreCase)) return "uniqueTaggedElement";
            return "occurrence";
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

        private static bool HasArray(JObject parameters, string name)
        {
            JArray raw = parameters != null ? parameters[name] as JArray : null;
            return raw != null && raw.Count > 0;
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
                if (token != null && int.TryParse(token.ToString(), out value) && value > 0 && !values.Contains(value))
                {
                    values.Add(value);
                }
            }

            return values;
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
                string value = (token != null ? token.ToString() : "").Trim();
                if (!string.IsNullOrWhiteSpace(value) && !values.Contains(value))
                {
                    values.Add(value);
                }
            }

            return values;
        }
    }
}
