using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;
using RevAgentPlugin.Core;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;

namespace RevAgentCommandSet.Commands.Spatial
{
    public class GetSpatialChangeStateCommand : ExternalEventCommandBase
    {
        private const int MaxCurrentLivenessCacheEntries = 64;
        private static readonly object HandlerExecutionSync = new object();
        private static readonly object CurrentLivenessCacheSync = new object();
        private static readonly Dictionary<string, CurrentLivenessCacheEntry> CurrentLivenessCache =
            new Dictionary<string, CurrentLivenessCacheEntry>(StringComparer.Ordinal);
        private static long _currentLivenessCacheOrdinal;
        private bool _handlerRequestMayBePending;

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
            Stopwatch stopwatch = Stopwatch.StartNew();
            GetSpatialChangeStateRequest request = ParseRequest(parameters);

            string cacheKey = BuildExactExpectedRevisionsKey(request);
            SpatialChangeTracker tracker = SpatialChangeTracker.Instance;
            long lookupGeneration = tracker.LivenessGeneration;
            GetSpatialChangeStateResult cached;
            if (tracker.IsSubscribed &&
                TryReadCurrentLivenessCache(cacheKey, lookupGeneration, out cached) &&
                tracker.IsSubscribed &&
                tracker.LivenessGeneration == lookupGeneration)
            {
                return PrepareCachedResult(cached, lookupGeneration, stopwatch);
            }

            lock (HandlerExecutionSync)
            {
                // Another caller may have populated the exact entry while this
                // request waited for the shared ExternalEvent handler. Keep the
                // common cache-hit path lock-free, but repeat every trust check
                // before mutating the shared handler request/result state.
                long lockedLookupGeneration = tracker.LivenessGeneration;
                if (tracker.IsSubscribed &&
                    TryReadCurrentLivenessCache(cacheKey, lockedLookupGeneration, out cached) &&
                    tracker.IsSubscribed &&
                    tracker.LivenessGeneration == lockedLookupGeneration)
                {
                    return PrepareCachedResult(cached, lockedLookupGeneration, stopwatch);
                }

                if (_handlerRequestMayBePending)
                {
                    if (!HandlerInstance.WaitForCompletion(0))
                    {
                        throw new InvalidOperationException(
                            "A previous spatial change-state ExternalEvent is still pending after its caller timed out.");
                    }
                    _handlerRequestMayBePending = false;
                }

                long generationBeforeEvaluation = tracker.LivenessGeneration;
                HandlerInstance.SetRequest(CloneRequest(request));
                _handlerRequestMayBePending = true;
                if (RaiseAndWaitForCompletion(request.TimeoutMs))
                {
                    _handlerRequestMayBePending = false;
                    GetSpatialChangeStateResult result = CloneResult(HandlerInstance.ResultInfo);
                    long generationAfterEvaluation = tracker.LivenessGeneration;
                    if (result != null)
                    {
                        result.LivenessProbeBasis = "revit_external_event";
                        result.LivenessCacheHit = false;
                        result.LivenessGeneration = generationAfterEvaluation;
                    }
                    if (generationBeforeEvaluation == generationAfterEvaluation &&
                        IsCacheableCurrentResult(result, request, tracker))
                    {
                        StoreCurrentLivenessCache(cacheKey, generationAfterEvaluation, result);
                    }
                    return result;
                }

                throw new TimeoutException("Timed out while reading spatial change state.");
            }
        }

        private static GetSpatialChangeStateResult PrepareCachedResult(
            GetSpatialChangeStateResult cached,
            long generation,
            Stopwatch stopwatch)
        {
            cached.LivenessProbeBasis = "sequence_bound_process_cache";
            cached.LivenessCacheHit = true;
            cached.LivenessGeneration = generation;
            cached.ElapsedMs = stopwatch.Elapsed.TotalMilliseconds;
            return cached;
        }

        /// <summary>
        /// Shared command seam: used by the solo command path above and by the
        /// execute_batch step runner, which executes the handler directly on
        /// the Revit API thread without the process liveness cache.
        /// </summary>
        internal static GetSpatialChangeStateRequest ParseRequest(JObject parameters)
        {
            return new GetSpatialChangeStateRequest
            {
                ExpectedTrackerSessionId = ReadString(parameters, "expectedTrackerSessionId", "").Trim(),
                SourceRevisions = ReadSourceRevisions(parameters),
                TimeoutMs = ReadInt(parameters, "timeoutMs", 30000, 2000, 60000)
            };
        }

        private static string BuildExactExpectedRevisionsKey(GetSpatialChangeStateRequest request)
        {
            List<Dictionary<string, object>> sources = (request.SourceRevisions ?? new List<ExpectedSpatialSourceRevision>())
                .OrderBy(source => source.InputOrdinal)
                .Select(source => new Dictionary<string, object>(StringComparer.Ordinal)
                {
                    { "inputOrdinal", source.InputOrdinal },
                    { "documentKey", source.DocumentKey },
                    { "documentSessionId", source.DocumentSessionId },
                    { "linkInstanceUniqueId", source.LinkInstanceUniqueId },
                    { "trackerSessionId", source.TrackerSessionId },
                    { "loadedVersion", source.LoadedVersion },
                    { "sourceToHostTransformFingerprint", source.SourceToHostTransformFingerprint },
                    { "changeSequence", source.ChangeSequence }
                })
                .ToList();
            Dictionary<string, object> exactRequest = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "expectedTrackerSessionId", request.ExpectedTrackerSessionId },
                { "sourceRevisions", sources }
            };
            return SpatialSnapshotHelpers.Sha256(SpatialSnapshotHelpers.SemanticCanonicalJson(exactRequest));
        }

        private static bool IsCacheableCurrentResult(
            GetSpatialChangeStateResult result,
            GetSpatialChangeStateRequest request,
            SpatialChangeTracker tracker)
        {
            if (result == null || request == null || request.SourceRevisions == null || request.SourceRevisions.Count == 0)
            {
                return false;
            }
            if (!result.Success || result.Guarded ||
                !string.Equals(result.State, "completed", StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(result.Liveness, "current", StringComparison.OrdinalIgnoreCase) ||
                !result.TrackerSubscribed || !tracker.IsSubscribed ||
                !string.Equals(result.TrackerSessionId, tracker.TrackerSessionId, StringComparison.Ordinal) ||
                result.ExpectedSourceRevisionCount != request.SourceRevisions.Count ||
                result.ResolvedSourceCount != request.SourceRevisions.Count ||
                result.CurrentSourceCount != request.SourceRevisions.Count ||
                result.StaleSourceCount != 0 || result.UnknownSourceCount != 0 ||
                result.SourceStates == null || result.SourceStates.Count != request.SourceRevisions.Count)
            {
                return false;
            }

            Dictionary<int, SpatialSourceChangeStateRow> rowsByOrdinal = result.SourceStates
                .Where(row => row != null)
                .GroupBy(row => row.InputOrdinal)
                .Where(group => group.Count() == 1)
                .ToDictionary(group => group.Key, group => group.Single());
            if (rowsByOrdinal.Count != request.SourceRevisions.Count)
            {
                return false;
            }
            foreach (ExpectedSpatialSourceRevision expected in request.SourceRevisions)
            {
                SpatialSourceChangeStateRow row;
                if (!rowsByOrdinal.TryGetValue(expected.InputOrdinal, out row) ||
                    !IsExactCurrentRowForRequest(row, expected, request, result))
                {
                    return false;
                }
            }
            return true;
        }

        private static bool IsExactCurrentRowForRequest(
            SpatialSourceChangeStateRow row,
            ExpectedSpatialSourceRevision expected,
            GetSpatialChangeStateRequest request,
            GetSpatialChangeStateResult result)
        {
            string expectedSourceKind = string.IsNullOrWhiteSpace(expected.LinkInstanceUniqueId) ? "host" : "link";
            string expectedTrackerSessionId = !string.IsNullOrWhiteSpace(expected.TrackerSessionId)
                ? expected.TrackerSessionId
                : request.ExpectedTrackerSessionId;
            if (row == null ||
                row.InputOrdinal != expected.InputOrdinal ||
                !row.SourceResolved ||
                !string.Equals(row.Liveness, "current", StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(row.Reason, "sequence_matches", StringComparison.Ordinal) ||
                !string.Equals(row.DocumentKey, expected.DocumentKey, StringComparison.Ordinal) ||
                !string.Equals(row.SourceKind, expectedSourceKind, StringComparison.Ordinal) ||
                !string.Equals(row.LinkInstanceUniqueId, expected.LinkInstanceUniqueId, StringComparison.Ordinal))
            {
                return false;
            }

            Dictionary<string, object> exactExpectedBinding = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "documentKey", NullIfWhiteSpace(expected.DocumentKey) },
                { "trackerSessionId", NullIfWhiteSpace(expectedTrackerSessionId) },
                { "documentSessionId", NullIfWhiteSpace(expected.DocumentSessionId) },
                { "changeSequence", expected.ChangeSequence >= 0 ? (long?)expected.ChangeSequence : null },
                { "loadedVersion", NullIfWhiteSpace(expected.LoadedVersion) },
                { "sourceToHostTransformFingerprint", NullIfWhiteSpace(expected.SourceToHostTransformFingerprint) }
            };
            Dictionary<string, object> exactCurrentBinding = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "documentKey", expected.DocumentKey },
                { "trackerSessionId", result.TrackerSessionId },
                { "trackerSubscribed", true },
                { "documentSessionId", expected.DocumentSessionId },
                { "changeSequence", expected.ChangeSequence },
                { "loadedVersion", expected.LoadedVersion },
                { "sourceToHostTransformFingerprint", expected.SourceToHostTransformFingerprint },
                { "externalLinkUpdateAvailable", row.ExternalLinkUpdateAvailable }
            };
            return ExactObjectMatches(row.ExpectedBinding, exactExpectedBinding) &&
                ExactObjectMatches(row.CurrentBinding, exactCurrentBinding) &&
                HasCurrentJournalEvidence(row.JournalEvidence);
        }

        private static bool ExactObjectMatches(object actualValue, Dictionary<string, object> expectedValue)
        {
            JObject actual = ToJObject(actualValue);
            return actual != null && string.Equals(
                SpatialSnapshotHelpers.SemanticCanonicalJson(actual),
                SpatialSnapshotHelpers.SemanticCanonicalJson(expectedValue),
                StringComparison.Ordinal);
        }

        private static bool HasCurrentJournalEvidence(object journalEvidence)
        {
            JObject journal = ToJObject(journalEvidence);
            if (journal == null) return false;
            string[] expectedFields =
            {
                "oldestRetainedSequence",
                "historyCompleteAfterSequence",
                "historyGap",
                "journalCapacity",
                "journalEntryCount",
                "journalTruncated",
                "droppedJournalEntryCount",
                "elementIdListsTruncated",
                "elementIdReadFailed",
                "droppedElementIdCount",
                "changedSinceExpectedSequenceCount"
            };
            if (journal.Properties().Select(property => property.Name)
                .OrderBy(name => name, StringComparer.Ordinal)
                .SequenceEqual(expectedFields.OrderBy(name => name, StringComparer.Ordinal)) == false)
            {
                return false;
            }
            JToken historyGap = journal["historyGap"];
            JToken changedCount = journal["changedSinceExpectedSequenceCount"];
            return historyGap != null && historyGap.Type == JTokenType.Boolean && !historyGap.Value<bool>() &&
                changedCount != null && changedCount.Type == JTokenType.Integer && changedCount.Value<long>() == 0;
        }

        private static JObject ToJObject(object value)
        {
            if (value == null) return null;
            try
            {
                return value as JObject ?? JObject.FromObject(value);
            }
            catch
            {
                return null;
            }
        }

        private static bool TryReadCurrentLivenessCache(
            string cacheKey,
            long generation,
            out GetSpatialChangeStateResult result)
        {
            result = null;
            lock (CurrentLivenessCacheSync)
            {
                CurrentLivenessCacheEntry entry;
                if (!CurrentLivenessCache.TryGetValue(cacheKey, out entry))
                {
                    return false;
                }
                if (entry.Generation != generation)
                {
                    CurrentLivenessCache.Remove(cacheKey);
                    return false;
                }
                result = CloneResult(entry.Result);
                return result != null;
            }
        }

        private static void StoreCurrentLivenessCache(
            string cacheKey,
            long generation,
            GetSpatialChangeStateResult result)
        {
            GetSpatialChangeStateResult defensiveCopy = CloneResult(result);
            if (defensiveCopy == null) return;
            lock (CurrentLivenessCacheSync)
            {
                if (!CurrentLivenessCache.ContainsKey(cacheKey) &&
                    CurrentLivenessCache.Count >= MaxCurrentLivenessCacheEntries)
                {
                    string oldestKey = CurrentLivenessCache
                        .OrderBy(pair => pair.Value.Ordinal)
                        .Select(pair => pair.Key)
                        .FirstOrDefault();
                    if (!string.IsNullOrWhiteSpace(oldestKey))
                    {
                        CurrentLivenessCache.Remove(oldestKey);
                    }
                }
                checked
                {
                    _currentLivenessCacheOrdinal++;
                }
                CurrentLivenessCache[cacheKey] = new CurrentLivenessCacheEntry
                {
                    Generation = generation,
                    Ordinal = _currentLivenessCacheOrdinal,
                    Result = defensiveCopy
                };
            }
        }

        private static GetSpatialChangeStateRequest CloneRequest(GetSpatialChangeStateRequest request)
        {
            return new GetSpatialChangeStateRequest
            {
                ExpectedTrackerSessionId = request.ExpectedTrackerSessionId,
                TimeoutMs = request.TimeoutMs,
                SourceRevisions = (request.SourceRevisions ?? new List<ExpectedSpatialSourceRevision>())
                    .Select(source => new ExpectedSpatialSourceRevision
                    {
                        InputOrdinal = source.InputOrdinal,
                        DocumentKey = source.DocumentKey,
                        DocumentSessionId = source.DocumentSessionId,
                        LinkInstanceUniqueId = source.LinkInstanceUniqueId,
                        TrackerSessionId = source.TrackerSessionId,
                        LoadedVersion = source.LoadedVersion,
                        SourceToHostTransformFingerprint = source.SourceToHostTransformFingerprint,
                        ChangeSequence = source.ChangeSequence
                    })
                    .ToList()
            };
        }

        private static GetSpatialChangeStateResult CloneResult(GetSpatialChangeStateResult result)
        {
            return result == null
                ? null
                : JObject.FromObject(result).ToObject<GetSpatialChangeStateResult>();
        }

        private sealed class CurrentLivenessCacheEntry
        {
            public long Generation { get; set; }
            public long Ordinal { get; set; }
            public GetSpatialChangeStateResult Result { get; set; }
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
