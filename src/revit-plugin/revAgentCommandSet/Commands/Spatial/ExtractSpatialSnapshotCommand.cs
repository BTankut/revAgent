using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;
using System.Collections.Generic;
using System.Linq;

namespace RevAgentCommandSet.Commands.Spatial
{
    public class ExtractSpatialSnapshotCommand : ExternalEventCommandBase
    {
        private ExtractSpatialSnapshotEventHandler HandlerInstance
        {
            get { return (ExtractSpatialSnapshotEventHandler)Handler; }
        }

        public override string CommandName
        {
            get { return "extract_spatial_snapshot"; }
        }

        public ExtractSpatialSnapshotCommand(UIApplication uiApp)
            : base(new ExtractSpatialSnapshotEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            SpatialSnapshotRequest request = ParseRequest(parameters);
            HandlerInstance.SetRequest(request);
            if (RaiseAndWaitForCompletion(request.TimeoutMs))
            {
                return HandlerInstance.ResultInfo;
            }

            throw new TimeoutException("Timed out while extracting the bounded Revit spatial snapshot page.");
        }

        private static SpatialSnapshotRequest ParseRequest(JObject parameters)
        {
            SpatialSnapshotRequest request = new SpatialSnapshotRequest
            {
                LevelIds = ReadIntArray(parameters, "levelIds"),
                LevelNames = ReadStringArray(parameters, "levelNames"),
                SourceScope = ReadSourceScope(parameters),
                LinkInstanceIds = ReadIntArray(parameters, "linkInstanceIds"),
                LinkInstanceUniqueIds = ReadStringArray(parameters, "linkInstanceUniqueIds"),
                LinkedSourceLevels = ReadLinkedSourceLevelSelectors(parameters, "linkedSourceLevels"),
                LinkedSourceLevelNames = ReadStringArray(parameters, "linkedSourceLevelNames"),
                IncludeHostMep = ReadBool(parameters, "includeHostMep", true),
                IncludeRoomsSpaces = ReadBool(parameters, "includeRoomsSpaces", true),
                IncludeLinkedObstructions = ReadBool(parameters, "includeLinkedObstructions", true),
                BelowLevelMm = ReadDouble(parameters, "belowLevelMm", 1000.0, 0.0, 10000.0),
                AboveLevelMm = ReadDouble(parameters, "aboveLevelMm", 6000.0, 100.0, 30000.0),
                Cursor = ReadString(parameters, "cursor", ""),
                PageTargetBytes = ReadInt(parameters, "pageTargetBytes", 4 * 1024 * 1024, 64 * 1024, 8 * 1024 * 1024),
                MaxElements = ReadInt(parameters, "maxElements", 5000, 1, 25000),
                MaxElapsedMs = ReadInt(parameters, "maxElapsedMs", 1800, 250, 5000),
                MaxGeometryPointsPerElement = ReadInt(parameters, "maxGeometryPointsPerElement", 8192, 64, 20000),
                MaxBoundarySegmentsPerElement = ReadInt(parameters, "maxBoundarySegmentsPerElement", 2048, 16, 10000)
            };

            int defaultTimeout = Math.Max(12000, request.MaxElapsedMs + 15000);
            request.TimeoutMs = ReadInt(parameters, "timeoutMs", defaultTimeout, 1000, 60000);
            if (request.MaxElapsedMs > request.TimeoutMs - 250)
            {
                request.MaxElapsedMs = Math.Max(250, request.TimeoutMs - 250);
            }

            return request;
        }

        private static string ReadSourceScope(JObject parameters)
        {
            string value = ReadString(parameters, "sourceScope", "hostAndLinked").Trim();
            if (string.Equals(value, "hostOnly", StringComparison.OrdinalIgnoreCase)) return "hostOnly";
            if (string.Equals(value, "linkedOnly", StringComparison.OrdinalIgnoreCase)) return "linkedOnly";
            return "hostAndLinked";
        }

        private static string ReadString(JObject parameters, string name, string fallback)
        {
            JToken token = parameters != null ? parameters[name] : null;
            return token == null || token.Type == JTokenType.Null ? fallback : token.ToString();
        }

        private static bool ReadBool(JObject parameters, string name, bool fallback)
        {
            JToken token = parameters != null ? parameters[name] : null;
            bool value;
            return token != null && bool.TryParse(token.ToString(), out value) ? value : fallback;
        }

        private static int ReadInt(JObject parameters, string name, int fallback, int min, int max)
        {
            JToken token = parameters != null ? parameters[name] : null;
            int value;
            if (token == null || !int.TryParse(token.ToString(), out value)) value = fallback;
            return Math.Max(min, Math.Min(max, value));
        }

        private static double ReadDouble(JObject parameters, string name, double fallback, double min, double max)
        {
            JToken token = parameters != null ? parameters[name] : null;
            double value;
            if (token == null || !double.TryParse(token.ToString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out value))
            {
                value = fallback;
            }
            return Math.Max(min, Math.Min(max, value));
        }

        private static List<int> ReadIntArray(JObject parameters, string name)
        {
            HashSet<int> seen = new HashSet<int>();
            List<int> values = new List<int>();
            JArray array = parameters != null ? parameters[name] as JArray : null;
            if (array == null) return values;
            foreach (JToken token in array)
            {
                int value;
                if (token != null && int.TryParse(token.ToString(), out value) && value > 0 && seen.Add(value))
                {
                    values.Add(value);
                }
            }
            values.Sort();
            return values;
        }

        private static List<string> ReadStringArray(JObject parameters, string name)
        {
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            List<string> values = new List<string>();
            JArray array = parameters != null ? parameters[name] as JArray : null;
            if (array == null) return values;
            foreach (JToken token in array)
            {
                string value = token != null ? token.ToString().Trim() : "";
                if (!string.IsNullOrWhiteSpace(value) && seen.Add(value)) values.Add(value);
            }
            values.Sort(StringComparer.OrdinalIgnoreCase);
            return values;
        }

        private static List<LinkedSourceLevelSelector> ReadLinkedSourceLevelSelectors(JObject parameters, string name)
        {
            Dictionary<string, LinkedSourceLevelSelector> values = new Dictionary<string, LinkedSourceLevelSelector>(StringComparer.Ordinal);
            JArray array = parameters != null ? parameters[name] as JArray : null;
            if (array == null) return new List<LinkedSourceLevelSelector>();
            foreach (JToken token in array)
            {
                JObject item = token as JObject;
                if (item == null) throw new ArgumentException("Each linkedSourceLevels entry must be an object.");
                string linkInstanceUniqueId = ReadString(item, "linkInstanceUniqueId", "").Trim();
                string levelUniqueId = ReadString(item, "levelUniqueId", "").Trim();
                string levelName = ReadString(item, "levelName", "").Trim();
                string rawLevelId = ReadString(item, "levelId", "").Trim();
                int parsedLevelId;
                int? levelId = int.TryParse(rawLevelId, out parsedLevelId) && parsedLevelId > 0
                    ? (int?)parsedLevelId
                    : null;
                if (!string.IsNullOrWhiteSpace(rawLevelId) && !levelId.HasValue) throw new ArgumentException("linkedSourceLevels.levelId must be a positive integer when supplied.");
                if (string.IsNullOrWhiteSpace(linkInstanceUniqueId) ||
                    (!levelId.HasValue && string.IsNullOrWhiteSpace(levelUniqueId) && string.IsNullOrWhiteSpace(levelName)))
                {
                    throw new ArgumentException("Each linkedSourceLevels entry requires linkInstanceUniqueId and levelId, levelUniqueId, and/or levelName.");
                }
                LinkedSourceLevelSelector selector = new LinkedSourceLevelSelector
                {
                    LinkInstanceUniqueId = linkInstanceUniqueId,
                    LevelId = levelId,
                    LevelUniqueId = levelUniqueId,
                    LevelName = levelName
                };
                string key = linkInstanceUniqueId + "\u001f" + (levelId.HasValue ? levelId.Value.ToString() : "") + "\u001f" + levelUniqueId + "\u001f" + levelName.ToUpperInvariant();
                values[key] = selector;
            }
            return values.Values
                .OrderBy(value => value.LinkInstanceUniqueId, StringComparer.Ordinal)
                .ThenBy(value => value.LevelId ?? int.MaxValue)
                .ThenBy(value => value.LevelUniqueId, StringComparer.Ordinal)
                .ThenBy(value => value.LevelName, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }
    }
}
