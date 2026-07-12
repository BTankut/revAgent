using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPSDK.API.Interfaces;
using RevAgentPlugin.Core;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;

namespace RevAgentCommandSet.Commands.Spatial
{
    public class GetSpatialChangeStateRequest
    {
        public string ExpectedTrackerSessionId { get; set; }
        public List<ExpectedSpatialSourceRevision> SourceRevisions { get; set; }
        public int TimeoutMs { get; set; }
    }

    public class ExpectedSpatialSourceRevision
    {
        public int InputOrdinal { get; set; }
        public string DocumentKey { get; set; }
        public string DocumentSessionId { get; set; }
        public string LinkInstanceUniqueId { get; set; }
        public string TrackerSessionId { get; set; }
        public string LoadedVersion { get; set; }
        public string SourceToHostTransformFingerprint { get; set; }
        public long ChangeSequence { get; set; }
    }

    public class GetSpatialChangeStateResult
    {
        public bool Success { get; set; }
        public bool Guarded { get; set; }
        public string State { get; set; }
        public string Action { get; set; }
        public string Reason { get; set; }
        public string Message { get; set; }
        public string Error { get; set; }
        public string Liveness { get; set; }
        public string TrackerSessionId { get; set; }
        public bool TrackerSubscribed { get; set; }
        public int ExpectedSourceRevisionCount { get; set; }
        public int ResolvedSourceCount { get; set; }
        public int CurrentSourceCount { get; set; }
        public int StaleSourceCount { get; set; }
        public int UnknownSourceCount { get; set; }
        public int ExternalLinkUpdateAvailableCount { get; set; }
        public bool Partial { get; set; }
        public string ScanStoppedReason { get; set; }
        public double ElapsedMs { get; set; }
        public string LivenessProbeBasis { get; set; }
        public bool LivenessCacheHit { get; set; }
        public long LivenessGeneration { get; set; }
        public List<SpatialSourceChangeStateRow> SourceStates { get; set; }
        public List<string> Warnings { get; set; }
        public List<string> Notices { get; set; }
    }

    public class SpatialSourceChangeStateRow
    {
        public int InputOrdinal { get; set; }
        public string DocumentKey { get; set; }
        public string SourceKind { get; set; }
        public string LinkInstanceUniqueId { get; set; }
        public bool SourceResolved { get; set; }
        public string Liveness { get; set; }
        public string Reason { get; set; }
        public bool ExternalLinkUpdateAvailable { get; set; }
        public object ExpectedBinding { get; set; }
        public object CurrentBinding { get; set; }
        public object JournalEvidence { get; set; }
    }

    internal sealed class ResolvedSpatialSource
    {
        public string SourceKind;
        public string LinkInstanceUniqueId;
        public Document Document;
        public Transform SourceToHost;
    }

    public class GetSpatialChangeStateEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private GetSpatialChangeStateRequest _request;

        public GetSpatialChangeStateResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetRequest(GetSpatialChangeStateRequest request)
        {
            _request = request ?? new GetSpatialChangeStateRequest();
            if (_request.SourceRevisions == null) _request.SourceRevisions = new List<ExpectedSpatialSourceRevision>();
            if (_request.ExpectedTrackerSessionId == null) _request.ExpectedTrackerSessionId = "";
            TaskCompleted = false;
            ResultInfo = null;
            _resetEvent.Reset();
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Stopwatch stopwatch = Stopwatch.StartNew();
            List<string> warnings = new List<string>();
            List<string> notices = new List<string>();
            try
            {
                UIDocument uiDocument = app != null ? app.ActiveUIDocument : null;
                Document hostDocument = uiDocument != null ? uiDocument.Document : null;
                if (hostDocument == null)
                {
                    throw new InvalidOperationException("No active Revit document is available.");
                }

                if (_request.SourceRevisions.Count == 0)
                {
                    Complete(new GetSpatialChangeStateResult
                    {
                        Success = true,
                        Guarded = true,
                        State = "guarded",
                        Action = "get_spatial_change_state",
                        Reason = "expected_source_revisions_required",
                        Message = "Pass the sourceRevisions captured with the spatial snapshot.",
                        Error = null,
                        Liveness = "unknown",
                        TrackerSessionId = SpatialChangeTracker.Instance.TrackerSessionId,
                        TrackerSubscribed = SpatialChangeTracker.Instance.IsSubscribed,
                        ExpectedSourceRevisionCount = 0,
                        ResolvedSourceCount = 0,
                        CurrentSourceCount = 0,
                        StaleSourceCount = 0,
                        UnknownSourceCount = 0,
                        Partial = false,
                        ScanStoppedReason = "needs_scope",
                        ElapsedMs = stopwatch.Elapsed.TotalMilliseconds,
                        SourceStates = new List<SpatialSourceChangeStateRow>(),
                        Warnings = warnings,
                        Notices = notices
                    });
                    return;
                }

                Dictionary<string, ResolvedSpatialSource> linkedSources = ResolveLoadedLinks(hostDocument, warnings);
                bool hasExpectedHostBinding = _request.SourceRevisions.Any(
                    revision => string.IsNullOrWhiteSpace(revision.LinkInstanceUniqueId));
                bool hasExpectedLinkBinding = _request.SourceRevisions.Any(
                    revision => !string.IsNullOrWhiteSpace(revision.LinkInstanceUniqueId));
                List<SpatialSourceChangeStateRow> rows = _request.SourceRevisions
                    .OrderBy(revision => string.IsNullOrWhiteSpace(revision.LinkInstanceUniqueId) ? 0 : 1)
                    .ThenBy(revision => revision.LinkInstanceUniqueId ?? "", StringComparer.Ordinal)
                    .ThenBy(revision => revision.DocumentKey ?? "", StringComparer.Ordinal)
                    .ThenBy(revision => revision.InputOrdinal)
                    .Select(revision => EvaluateRevision(hostDocument, linkedSources, revision))
                    .ToList();

                if (hasExpectedLinkBinding && !hasExpectedHostBinding)
                {
                    foreach (SpatialSourceChangeStateRow row in rows.Where(
                        item => item.SourceKind == "link" && item.Liveness == "current"))
                    {
                        row.Liveness = "unknown";
                        row.Reason = "host_binding_required_for_link_liveness";
                    }
                    warnings.Add("Linked placement liveness requires the host document source revision so host-side reload, unload, and transform changes cannot be missed.");
                }

                int currentCount = rows.Count(row => row.Liveness == "current");
                int staleCount = rows.Count(row => row.Liveness == "stale");
                int unknownCount = rows.Count(row => row.Liveness == "unknown");
                int resolvedCount = rows.Count(row => row.SourceResolved);
                int externalLinkUpdateAvailableCount = rows.Count(row => row.ExternalLinkUpdateAvailable);
                string aggregateLiveness = unknownCount > 0 ? "unknown" : staleCount > 0 ? "stale" : "current";
                string aggregateReason = rows
                    .Where(row => row.Liveness == aggregateLiveness)
                    .Select(row => row.Reason)
                    .FirstOrDefault(reason => !string.IsNullOrWhiteSpace(reason));

                if (!SpatialChangeTracker.Instance.IsSubscribed)
                {
                    warnings.Add("The process-local spatial change tracker is not subscribed to DocumentChanged; liveness is unknown.");
                }
                if (externalLinkUpdateAvailableCount > 0)
                {
                    warnings.Add("A newer external linked-model source version is available; the currently loaded Revit geometry remains authoritative until the link is reloaded.");
                }

                Complete(new GetSpatialChangeStateResult
                {
                    Success = true,
                    Guarded = false,
                    State = "completed",
                    Action = "get_spatial_change_state",
                    Reason = aggregateReason,
                    Message = aggregateLiveness == "current"
                        ? "All expected source revisions match the live process-local change bindings."
                        : aggregateLiveness == "stale"
                            ? "At least one source has a retained committed change after the expected revision."
                            : "Current liveness cannot be established for at least one expected source revision.",
                    Error = null,
                    Liveness = aggregateLiveness,
                    TrackerSessionId = SpatialChangeTracker.Instance.TrackerSessionId,
                    TrackerSubscribed = SpatialChangeTracker.Instance.IsSubscribed,
                    ExpectedSourceRevisionCount = rows.Count,
                    ResolvedSourceCount = resolvedCount,
                    CurrentSourceCount = currentCount,
                    StaleSourceCount = staleCount,
                    UnknownSourceCount = unknownCount,
                    ExternalLinkUpdateAvailableCount = externalLinkUpdateAvailableCount,
                    Partial = unknownCount > 0,
                    ScanStoppedReason = unknownCount > 0 ? "read_failed" : "completed",
                    ElapsedMs = stopwatch.Elapsed.TotalMilliseconds,
                    SourceStates = rows,
                    Warnings = warnings.Distinct(StringComparer.Ordinal).ToList(),
                    Notices = notices
                });
            }
            catch (Exception ex)
            {
                Complete(new GetSpatialChangeStateResult
                {
                    Success = false,
                    Guarded = false,
                    State = "failed",
                    Action = "get_spatial_change_state",
                    Reason = "read_failed",
                    Message = "Spatial change state could not be read.",
                    Error = ex.Message,
                    Liveness = "unknown",
                    TrackerSessionId = SpatialChangeTracker.Instance.TrackerSessionId,
                    TrackerSubscribed = SpatialChangeTracker.Instance.IsSubscribed,
                    ExpectedSourceRevisionCount = _request != null && _request.SourceRevisions != null ? _request.SourceRevisions.Count : 0,
                    ResolvedSourceCount = 0,
                    CurrentSourceCount = 0,
                    StaleSourceCount = 0,
                    UnknownSourceCount = _request != null && _request.SourceRevisions != null ? _request.SourceRevisions.Count : 0,
                    Partial = true,
                    ScanStoppedReason = "read_failed",
                    ElapsedMs = stopwatch.Elapsed.TotalMilliseconds,
                    SourceStates = new List<SpatialSourceChangeStateRow>(),
                    Warnings = warnings,
                    Notices = notices
                });
            }
        }

        private SpatialSourceChangeStateRow EvaluateRevision(
            Document hostDocument,
            IDictionary<string, ResolvedSpatialSource> linkedSources,
            ExpectedSpatialSourceRevision expected)
        {
            string expectedTrackerSessionId = !string.IsNullOrWhiteSpace(expected.TrackerSessionId)
                ? expected.TrackerSessionId
                : _request.ExpectedTrackerSessionId;
            ResolvedSpatialSource resolved = null;
            if (string.IsNullOrWhiteSpace(expected.LinkInstanceUniqueId))
            {
                resolved = new ResolvedSpatialSource
                {
                    SourceKind = "host",
                    LinkInstanceUniqueId = null,
                    Document = hostDocument,
                    SourceToHost = Transform.Identity
                };
            }
            else
            {
                linkedSources.TryGetValue(expected.LinkInstanceUniqueId, out resolved);
            }

            object expectedBinding = new
            {
                documentKey = string.IsNullOrWhiteSpace(expected.DocumentKey) ? null : expected.DocumentKey,
                trackerSessionId = string.IsNullOrWhiteSpace(expectedTrackerSessionId) ? null : expectedTrackerSessionId,
                documentSessionId = string.IsNullOrWhiteSpace(expected.DocumentSessionId) ? null : expected.DocumentSessionId,
                changeSequence = expected.ChangeSequence >= 0 ? (long?)expected.ChangeSequence : null,
                loadedVersion = string.IsNullOrWhiteSpace(expected.LoadedVersion) ? null : expected.LoadedVersion,
                sourceToHostTransformFingerprint = string.IsNullOrWhiteSpace(expected.SourceToHostTransformFingerprint) ? null : expected.SourceToHostTransformFingerprint
            };

            if (resolved == null || resolved.Document == null)
            {
                return BuildRow(expected, false, "unknown", "source_unavailable", expectedBinding, null, null);
            }

            bool linkedSource = !string.IsNullOrWhiteSpace(expected.LinkInstanceUniqueId);
            DocumentIdentity currentIdentity = SpatialSnapshotHelpers.ResolveDocumentIdentity(resolved.Document, linkedSource, true);
            SpatialDocumentChangeSnapshot current = SpatialChangeTracker.Instance.GetCurrentBinding(resolved.Document);
            double transformErrorMm;
            bool transformValid;
            string currentTransformFingerprint = SpatialSnapshotHelpers.Sha256(SpatialSnapshotHelpers.SemanticCanonicalJson(
                SpatialSnapshotHelpers.BuildTransformRecord(resolved.SourceToHost, out transformErrorMm, out transformValid)));
            transformValid = resolved.SourceToHost != null && transformValid;
            object currentBinding = new
            {
                documentKey = currentIdentity.DocumentKey,
                trackerSessionId = current.TrackerSessionId,
                trackerSubscribed = current.TrackerSubscribed,
                documentSessionId = current.DocumentSessionId,
                changeSequence = current.CurrentSequence,
                loadedVersion = currentIdentity.LoadedVersion,
                sourceToHostTransformFingerprint = currentTransformFingerprint,
                externalLinkUpdateAvailable = linkedSource && currentIdentity.ExternalLinkUpdateAvailable
            };
            object journalEvidence = BuildJournalEvidence(current);

            if (!current.TrackerSubscribed)
            {
                return BuildRow(expected, true, "unknown", "tracker_not_subscribed", expectedBinding, currentBinding, journalEvidence, currentIdentity.ExternalLinkUpdateAvailable);
            }
            if (expected.ChangeSequence < 0 || string.IsNullOrWhiteSpace(expected.DocumentSessionId) ||
                string.IsNullOrWhiteSpace(expected.DocumentKey) || string.IsNullOrWhiteSpace(expected.LoadedVersion))
            {
                return BuildRow(expected, true, "unknown", "invalid_expected_revision", expectedBinding, currentBinding, journalEvidence, currentIdentity.ExternalLinkUpdateAvailable);
            }
            if (!transformValid || string.IsNullOrWhiteSpace(expected.SourceToHostTransformFingerprint))
            {
                return BuildRow(expected, true, "unknown", "invalid_source_transform_binding", expectedBinding, currentBinding, journalEvidence, currentIdentity.ExternalLinkUpdateAvailable);
            }
            if (!string.Equals(expected.DocumentKey, currentIdentity.DocumentKey, StringComparison.Ordinal))
            {
                return BuildRow(expected, true, "unknown", "document_identity_changed", expectedBinding, currentBinding, journalEvidence, currentIdentity.ExternalLinkUpdateAvailable);
            }
            if (!string.Equals(expected.LoadedVersion, currentIdentity.LoadedVersion, StringComparison.Ordinal))
            {
                return BuildRow(expected, true, "unknown", "loaded_version_changed_without_sequence_evidence", expectedBinding, currentBinding, journalEvidence, currentIdentity.ExternalLinkUpdateAvailable);
            }
            if (!string.Equals(expected.SourceToHostTransformFingerprint, currentTransformFingerprint, StringComparison.Ordinal))
            {
                return BuildRow(expected, true, "stale", "link_transform_changed", expectedBinding, currentBinding, journalEvidence, currentIdentity.ExternalLinkUpdateAvailable);
            }
            if (!string.IsNullOrWhiteSpace(expectedTrackerSessionId) &&
                !string.Equals(expectedTrackerSessionId, current.TrackerSessionId, StringComparison.Ordinal))
            {
                return BuildRow(expected, true, "unknown", "tracker_session_changed", expectedBinding, currentBinding, journalEvidence, currentIdentity.ExternalLinkUpdateAvailable);
            }
            if (!string.Equals(expected.DocumentSessionId, current.DocumentSessionId, StringComparison.Ordinal))
            {
                return BuildRow(expected, true, "unknown", "document_session_changed", expectedBinding, currentBinding, journalEvidence, currentIdentity.ExternalLinkUpdateAvailable);
            }
            if (expected.ChangeSequence > current.CurrentSequence)
            {
                return BuildRow(expected, true, "unknown", "future_change_sequence", expectedBinding, currentBinding, journalEvidence, currentIdentity.ExternalLinkUpdateAvailable);
            }
            if (expected.ChangeSequence == current.CurrentSequence)
            {
                return BuildRow(expected, true, "current", "sequence_matches", expectedBinding, currentBinding, journalEvidence, currentIdentity.ExternalLinkUpdateAvailable);
            }

            SpatialDocumentChangeSnapshot changes = SpatialChangeTracker.Instance.ReadChangesSince(
                resolved.Document,
                expected.ChangeSequence,
                0);
            journalEvidence = BuildJournalEvidence(changes);
            if (changes.HistoryGap)
            {
                return BuildRow(expected, true, "unknown", "journal_gap", expectedBinding, currentBinding, journalEvidence, currentIdentity.ExternalLinkUpdateAvailable);
            }

            // This narrow Phase 1a surface intentionally has no scope-geometry
            // evaluator. Any retained committed source change is therefore
            // conservatively relevant and marks the snapshot stale.
            return BuildRow(expected, true, "stale", "relevant_committed_change", expectedBinding, currentBinding, journalEvidence, currentIdentity.ExternalLinkUpdateAvailable);
        }

        private static SpatialSourceChangeStateRow BuildRow(
            ExpectedSpatialSourceRevision expected,
            bool sourceResolved,
            string liveness,
            string reason,
            object expectedBinding,
            object currentBinding,
            object journalEvidence,
            bool externalLinkUpdateAvailable = false)
        {
            return new SpatialSourceChangeStateRow
            {
                InputOrdinal = expected.InputOrdinal,
                DocumentKey = expected.DocumentKey,
                SourceKind = string.IsNullOrWhiteSpace(expected.LinkInstanceUniqueId) ? "host" : "link",
                LinkInstanceUniqueId = expected.LinkInstanceUniqueId,
                SourceResolved = sourceResolved,
                Liveness = liveness,
                Reason = reason,
                ExternalLinkUpdateAvailable = externalLinkUpdateAvailable,
                ExpectedBinding = expectedBinding,
                CurrentBinding = currentBinding,
                JournalEvidence = journalEvidence
            };
        }

        private static object BuildJournalEvidence(SpatialDocumentChangeSnapshot state)
        {
            return new
            {
                oldestRetainedSequence = state.OldestRetainedSequence,
                historyCompleteAfterSequence = state.HistoryCompleteAfterSequence,
                historyGap = state.HistoryGap,
                journalCapacity = state.JournalCapacity,
                journalEntryCount = state.JournalEntryCount,
                journalTruncated = state.JournalTruncated,
                droppedJournalEntryCount = state.DroppedJournalEntryCount,
                elementIdListsTruncated = state.ElementIdListsTruncated,
                elementIdReadFailed = state.ElementIdReadFailed,
                droppedElementIdCount = state.DroppedElementIdCount,
                changedSinceExpectedSequenceCount = state.ChangedSinceRequestedSequenceCount
            };
        }

        private static Dictionary<string, ResolvedSpatialSource> ResolveLoadedLinks(
            Document hostDocument,
            IList<string> warnings)
        {
            Dictionary<string, ResolvedSpatialSource> result =
                new Dictionary<string, ResolvedSpatialSource>(StringComparer.Ordinal);
            IEnumerable<RevitLinkInstance> links = new FilteredElementCollector(hostDocument)
                .OfClass(typeof(RevitLinkInstance))
                .Cast<RevitLinkInstance>()
                .OrderBy(link => SafeUniqueId(link), StringComparer.Ordinal);

            foreach (RevitLinkInstance link in links)
            {
                string uniqueId = SafeUniqueId(link);
                if (string.IsNullOrWhiteSpace(uniqueId)) continue;

                Document linkedDocument = null;
                try
                {
                    linkedDocument = link.GetLinkDocument();
                }
                catch (Exception ex)
                {
                    warnings.Add("A linked source document could not be resolved: " + ex.GetType().Name + ".");
                }

                result[uniqueId] = new ResolvedSpatialSource
                {
                    SourceKind = "link",
                    LinkInstanceUniqueId = uniqueId,
                    Document = linkedDocument,
                    SourceToHost = SafeTransform(link)
                };
            }
            return result;
        }

        private static string SafeUniqueId(Element element)
        {
            try { return element != null ? element.UniqueId ?? "" : ""; }
            catch { return ""; }
        }

        private static Transform SafeTransform(RevitLinkInstance link)
        {
            try { return link != null ? link.GetTransform() : null; }
            catch { return null; }
        }

        private void Complete(GetSpatialChangeStateResult result)
        {
            ResultInfo = result;
            TaskCompleted = true;
            _resetEvent.Set();
        }

        public string GetName()
        {
            return "GetSpatialChangeStateEventHandler";
        }
    }
}
