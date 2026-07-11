using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using System;
using System.Collections.Generic;
using System.Linq;

namespace RevAgentCommandSet.Commands.Spatial
{
    public class GetSpatialChangeStateCommand : ExternalEventCommandBase
    {
        private GetSpatialChangeStateEventHandler HandlerInstance
        {
            get { return (GetSpatialChangeStateEventHandler)Handler; }
        }

        public override string CommandName
        {
            get { return "get_spatial_change_state"; }
        }

        public GetSpatialChangeStateCommand(UIApplication uiApp)
            : base(new GetSpatialChangeStateEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            GetSpatialChangeStateRequest request = new GetSpatialChangeStateRequest
            {
                ExpectedTrackerSessionId = ReadString(parameters, "expectedTrackerSessionId", "").Trim(),
                SourceRevisions = ReadSourceRevisions(parameters),
                TimeoutMs = ReadInt(parameters, "timeoutMs", 30000, 2000, 60000)
            };

            HandlerInstance.SetRequest(request);
            if (RaiseAndWaitForCompletion(request.TimeoutMs))
            {
                return HandlerInstance.ResultInfo;
            }

            throw new TimeoutException("Timed out while reading spatial change state.");
        }

        private static List<ExpectedSpatialSourceRevision> ReadSourceRevisions(JObject parameters)
        {
            JArray array = parameters != null ? parameters["sourceRevisions"] as JArray : null;
            if (array == null && parameters != null)
            {
                array = parameters["expectedSourceRevisions"] as JArray;
            }
            if (array == null) return new List<ExpectedSpatialSourceRevision>();

            List<ExpectedSpatialSourceRevision> revisions = new List<ExpectedSpatialSourceRevision>();
            for (int index = 0; index < array.Count; index++)
            {
                JObject item = array[index] as JObject;
                if (item == null)
                {
                    revisions.Add(new ExpectedSpatialSourceRevision
                    {
                        InputOrdinal = index,
                        ChangeSequence = -1
                    });
                    continue;
                }

                long changeSequence;
                bool hasSequence = TryReadLong(item["changeSequence"], out changeSequence);
                revisions.Add(new ExpectedSpatialSourceRevision
                {
                    InputOrdinal = index,
                    DocumentKey = ReadString(item, "documentKey", "").Trim(),
                    DocumentSessionId = ReadString(item, "documentSessionId", "").Trim(),
                    LinkInstanceUniqueId = NullIfWhiteSpace(ReadString(item, "linkInstanceUniqueId", "")),
                    TrackerSessionId = NullIfWhiteSpace(ReadString(item, "trackerSessionId", "")),
                    LoadedVersion = NullIfWhiteSpace(ReadString(item, "loadedVersion", "")),
                    SourceToHostTransformFingerprint = item["sourceToHostTransform"] != null
                        ? SpatialSnapshotHelpers.Sha256(SpatialSnapshotHelpers.SemanticCanonicalJson(item["sourceToHostTransform"]))
                        : null,
                    ChangeSequence = hasSequence ? changeSequence : -1
                });
            }

            return revisions;
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

        private static bool TryReadLong(JToken token, out long value)
        {
            value = -1;
            return token != null && token.Type != JTokenType.Null &&
                long.TryParse(token.ToString(), out value) && value >= 0;
        }

        private static string NullIfWhiteSpace(string value)
        {
            string cleaned = (value ?? "").Trim();
            return cleaned.Length > 0 ? cleaned : null;
        }
    }
}
