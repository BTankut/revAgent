using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json;
using RevitMCPSDK.API.Interfaces;
using RevAgentCommandSet.Extensions;
using RevAgentPlugin.Core;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Threading;

namespace RevAgentCommandSet.Commands.Spatial
{
    public class ExtractSpatialSnapshotEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const int MaximumDiscoveredCandidateCount = 250000;
        private const long MaximumPreparedCanonicalBytes = 512L * 1024L * 1024L;
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private SpatialSnapshotRequest _request;

        public SpatialSnapshotResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetRequest(SpatialSnapshotRequest request)
        {
            _request = request ?? new SpatialSnapshotRequest();
            if (_request.LevelIds == null) _request.LevelIds = new List<int>();
            if (_request.LevelNames == null) _request.LevelNames = new List<string>();
            if (_request.LinkInstanceIds == null) _request.LinkInstanceIds = new List<int>();
            if (_request.LinkInstanceUniqueIds == null) _request.LinkInstanceUniqueIds = new List<string>();
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
            List<string> notices = new List<string> { SpatialSnapshotHelpers.Phase1aCaveat };
            CursorEnvelope pageCursor = null;
            WorkCursorEnvelope workCursor = null;
            string cursorError;

            try
            {
                if (SpatialSnapshotHelpers.IsWorkCursor(_request.Cursor))
                {
                    if (!SpatialSnapshotHelpers.TryDecodeWorkCursor(_request.Cursor, out workCursor, out cursorError))
                    {
                        Complete(BuildGuarded("invalid_work_cursor", "The work continuation cursor could not be decoded: " + cursorError, stopwatch, warnings, notices));
                        return;
                    }
                }
                else if (!SpatialSnapshotHelpers.TryDecodeCursor(_request.Cursor, out pageCursor, out cursorError))
                {
                    Complete(BuildGuarded("invalid_cursor", "The page continuation cursor could not be decoded: " + cursorError, stopwatch, warnings, notices));
                    return;
                }

                if (_request.LevelIds.Count == 0 && _request.LevelNames.Count == 0)
                {
                    Complete(BuildGuarded("needs_scope", "extract_spatial_snapshot requires at least one explicit host levelId or exact levelName.", stopwatch, warnings, notices));
                    return;
                }

                UIDocument uiDocument = app != null ? app.ActiveUIDocument : null;
                Document hostDocument = uiDocument != null ? uiDocument.Document : null;
                if (hostDocument == null)
                {
                    Complete(BuildFailed("No active Revit document is available.", stopwatch, warnings, notices));
                    return;
                }

                if (workCursor != null)
                {
                    CompletePreparedWorkContinuation(hostDocument, workCursor, stopwatch, warnings, notices);
                    return;
                }
                if (pageCursor != null)
                {
                    CompletePreparedPageContinuation(hostDocument, pageCursor, stopwatch, warnings, notices);
                    return;
                }

                StartPreparedCapture(hostDocument, stopwatch, warnings, notices);
            }
            catch (Exception ex)
            {
                if (workCursor != null) SpatialCaptureSessionManager.Instance.Remove(workCursor.CaptureId);
                if (pageCursor != null) SpatialCaptureSessionManager.Instance.Remove(pageCursor.CaptureId);
                Complete(BuildFailed(ex.Message, stopwatch, warnings, notices));
            }
        }

        private void StartPreparedCapture(Document hostDocument, Stopwatch stopwatch, List<string> warnings, List<string> notices)
        {
            SpatialExtractionState extraction = new SpatialExtractionState();
            List<SpatialRow> rows = new List<SpatialRow>();
            List<SpatialSource> sources = new List<SpatialSource>();
            try
            {
                DocumentIdentity hostIdentity = SpatialSnapshotHelpers.ResolveDocumentIdentity(hostDocument);
                if (!hostIdentity.TrackerSubscribed)
                {
                    Complete(BuildGuarded("change_tracker_unavailable", "The shared Revit DocumentChanged tracker is not subscribed; a sequence-bound capture cannot start.", stopwatch, warnings, notices));
                    return;
                }

                List<LevelBand> bands = SpatialSnapshotHelpers.ResolveLevelBands(hostDocument, _request, warnings);
                if (bands.Count == 0)
                {
                    Complete(BuildGuarded("needs_scope", "None of the requested levelIds/levelNames resolved in the active host document.", stopwatch, warnings, notices));
                    return;
                }

                ResolveSources(hostDocument, hostIdentity, sources, rows, extraction, warnings);
                extraction.SourceCount = sources.Count;
                if (sources.Any(source => source.Identity == null || !source.Identity.TrackerSubscribed))
                {
                    Complete(BuildGuarded("change_tracker_unavailable", "At least one in-scope document has no subscribed DocumentChanged binding; the capture was not prepared.", stopwatch, warnings, notices));
                    return;
                }

                string transformReason;
                if (!ValidateSourceTransforms(sources, extraction, out transformReason))
                {
                    Complete(BuildGuarded("invalid_source_transform", transformReason, stopwatch, warnings, notices));
                    return;
                }

                Dictionary<string, object> scope = SpatialSnapshotHelpers.BuildScope(_request, bands, hostDocument, hostIdentity);
                scope["resolvedLinkedSourceLevels"] = BuildResolvedLinkedSourceLevelRecords(sources);
                string scopeFingerprint = SpatialSnapshotHelpers.BuildScopeFingerprint(_request, bands, scope);
                bool hasEffectiveSourcePolicy;
                Dictionary<string, object> effectiveSourcePolicy = BuildEffectiveSourcePolicy(sources, extraction, out hasEffectiveSourcePolicy);
                if (!hasEffectiveSourcePolicy)
                {
                    SpatialSnapshotResult guarded = BuildGuarded(
                        "needs_scope",
                        "The requested flags/sourceScope resolve no readable source-category extraction policy. Enable at least one applicable category family and, for linkedOnly, select or load at least one readable link.",
                        stopwatch,
                        warnings,
                        notices);
                    guarded.Scope = scope;
                    guarded.ScopeFingerprint = scopeFingerprint;
                    guarded.EffectiveSourcePolicy = effectiveSourcePolicy;
                    guarded.Omissions = rows.Where(row => !row.IsNode).Select(row => row.Payload).ToList();
                    guarded.Coverage = new Dictionary<string, object>
                    {
                        { "effectiveScope", false },
                        { "extractionCoverageRatio", 0.0 },
                        { "allEligibleOmissionsClassified", false },
                        { "phase0TargetAtLeast0_995", false },
                        { "complete", false }
                    };
                    Complete(guarded);
                    return;
                }
                if (!ValidateLinkedSourceLevelScope(sources, warnings, notices))
                {
                    SpatialSnapshotResult guarded = BuildGuarded(
                        "needs_scope",
                        "One or more exact linked source-level selectors did not resolve in the selected loaded links. Use inspect_levels and restart without cursor.",
                        stopwatch,
                        warnings,
                        notices);
                    guarded.Scope = scope;
                    guarded.ScopeFingerprint = scopeFingerprint;
                    guarded.EffectiveSourcePolicy = effectiveSourcePolicy;
                    guarded.Omissions = rows.Where(row => !row.IsNode).Select(row => row.Payload).ToList();
                    guarded.Coverage = new Dictionary<string, object>
                    {
                        { "effectiveScope", false },
                        { "extractionCoverageRatio", 0.0 },
                        { "allEligibleOmissionsClassified", false },
                        { "phase0TargetAtLeast0_995", false },
                        { "complete", false }
                    };
                    guarded.SuggestedNextScopes = new List<string>
                    {
                        "Call inspect_levels with the same source/link scope, then use a returned placement-qualified selector.",
                        "Restart capture without cursor after correcting linkedSourceLevels or linkedSourceLevelNames."
                    };
                    Complete(guarded);
                    return;
                }

                string captureId = Guid.NewGuid().ToString("N");
                string capturedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
                PreparedSpatialCapture prepared = new PreparedSpatialCapture
                {
                    CaptureId = captureId,
                    CapturedAt = capturedAt,
                    CreatedAtUtc = DateTime.UtcNow,
                    HostDocument = hostDocument,
                    HostDocumentKey = hostIdentity.DocumentKey,
                    HostDocumentSessionId = hostIdentity.DocumentSessionId,
                    HostTrackerSessionId = hostIdentity.TrackerSessionId,
                    PageTargetBytes = _request.PageTargetBytes,
                    Request = _request,
                    Sources = sources,
                    Bands = bands,
                    DiscoveryPartitions = BuildDiscoveryPartitions(sources),
                    DiscoveryPartitionIndex = 0,
                    ActiveDiscoveryElementIds = new List<int>(),
                    ActiveDiscoveryElementIndex = 0,
                    DiscoveredCandidates = new List<SpatialCandidateRecord>(),
                    EligibleCandidates = new List<SpatialCandidateRecord>(),
                    FilterIndex = 0,
                    ExtractIndex = 0,
                    OrderedRows = rows,
                    Extraction = extraction,
                    Scope = scope,
                    EffectiveSourcePolicy = effectiveSourcePolicy,
                    ScopeFingerprint = scopeFingerprint,
                    SourceBindingFingerprint = BuildSourceBindingFingerprint(sources, rows),
                    WorkPhase = "discover",
                    WorkStepOrdinal = 0,
                    HasEffectiveSourcePolicy = hasEffectiveSourcePolicy,
                    PreparationComplete = false,
                    Warnings = warnings,
                    Notices = notices
                };

                string consistencyReason;
                if (!ValidatePreparedCaptureBindings(prepared, out consistencyReason))
                {
                    Complete(BuildInterruptedByChange(prepared, consistencyReason, stopwatch));
                    return;
                }

                string workFailure;
                DateTime deadlineUtc = ResolveWorkDeadline(stopwatch, prepared.Request.MaxElapsedMs);
                if (!AdvancePreparedWork(prepared, deadlineUtc, out workFailure))
                {
                    Complete(BuildWorkFailure(prepared, workFailure, stopwatch));
                    return;
                }
                if (!ValidatePreparedCaptureBindings(prepared, out consistencyReason))
                {
                    Complete(BuildInterruptedByChange(prepared, consistencyReason, stopwatch));
                    return;
                }
                CompletePreparedOrProgress(prepared, stopwatch);
            }
            catch (Exception ex)
            {
                Complete(BuildFailed(ex.Message, stopwatch, warnings, notices));
            }
        }

        private void CompletePreparedWorkContinuation(Document hostDocument, WorkCursorEnvelope cursor, Stopwatch stopwatch, List<string> warnings, List<string> notices)
        {
            PreparedSpatialCapture prepared;
            if (!SpatialCaptureSessionManager.Instance.TryGet(cursor.CaptureId, out prepared))
            {
                Complete(BuildGuarded("expired_capture_session", "The prepared native capture session is missing or expired. Restart without cursor.", stopwatch, warnings, notices));
                return;
            }

            string consistencyReason;
            if (!TryBindCurrentHostDocument(prepared, hostDocument, out consistencyReason))
            {
                Complete(BuildInterruptedByChange(prepared, consistencyReason, stopwatch));
                return;
            }

            if (!string.Equals(cursor.CapturedAt, prepared.CapturedAt, StringComparison.Ordinal) ||
                !string.Equals(cursor.ScopeFingerprint, prepared.ScopeFingerprint, StringComparison.Ordinal) ||
                !string.Equals(cursor.SourceBindingFingerprint, prepared.SourceBindingFingerprint, StringComparison.Ordinal) ||
                !string.Equals(cursor.WorkPhase, prepared.WorkPhase, StringComparison.Ordinal) ||
                cursor.StepOrdinal != prepared.WorkStepOrdinal)
            {
                SpatialCaptureSessionManager.Instance.Remove(prepared.CaptureId);
                Complete(BuildCursorGuarded("invalid_work_cursor", "The authenticated work cursor does not match the prepared phase, step, scope, or binding.", stopwatch, prepared.Warnings, prepared.Notices, prepared.Scope, prepared.EffectiveSourcePolicy, prepared.ScopeFingerprint, prepared.RevisionFingerprint, prepared.SourceRevisions));
                return;
            }

            if (!ValidatePreparedCaptureBindings(prepared, out consistencyReason))
            {
                Complete(BuildInterruptedByChange(prepared, consistencyReason, stopwatch));
                return;
            }

            string workFailure;
            if (!AdvancePreparedWork(prepared, ResolveWorkDeadline(stopwatch, prepared.Request.MaxElapsedMs), out workFailure))
            {
                Complete(BuildWorkFailure(prepared, workFailure, stopwatch));
                return;
            }
            if (!ValidatePreparedCaptureBindings(prepared, out consistencyReason))
            {
                Complete(BuildInterruptedByChange(prepared, consistencyReason, stopwatch));
                return;
            }
            CompletePreparedOrProgress(prepared, stopwatch);
        }

        private void CompletePreparedPageContinuation(Document hostDocument, CursorEnvelope cursor, Stopwatch stopwatch, List<string> warnings, List<string> notices)
        {
            PreparedSpatialCapture prepared;
            if (!SpatialCaptureSessionManager.Instance.TryGet(cursor.CaptureId, out prepared))
            {
                Complete(BuildGuarded("expired_capture_session", "The prepared native capture session is missing or expired. Restart without cursor.", stopwatch, warnings, notices));
                return;
            }

            string consistencyReason;
            if (!TryBindCurrentHostDocument(prepared, hostDocument, out consistencyReason))
            {
                Complete(BuildInterruptedByChange(prepared, consistencyReason, stopwatch));
                return;
            }
            if (!prepared.PreparationComplete || !string.Equals(cursor.ScopeFingerprint, prepared.ScopeFingerprint, StringComparison.Ordinal))
            {
                SpatialCaptureSessionManager.Instance.Remove(prepared.CaptureId);
                Complete(BuildCursorGuarded("cursor_scope_mismatch", "The page cursor does not match a finalized prepared capture session.", stopwatch, prepared.Warnings, prepared.Notices, prepared.Scope, prepared.EffectiveSourcePolicy, prepared.ScopeFingerprint, prepared.RevisionFingerprint, prepared.SourceRevisions));
                return;
            }
            if (!string.Equals(cursor.RevisionFingerprint, prepared.RevisionFingerprint, StringComparison.Ordinal) ||
                !string.Equals(cursor.CapturedAt, prepared.CapturedAt, StringComparison.Ordinal))
            {
                SpatialCaptureSessionManager.Instance.Remove(prepared.CaptureId);
                Complete(BuildCursorGuarded("cursor_revision_mismatch", "The signed page cursor revision basis does not match the prepared capture session.", stopwatch, prepared.Warnings, prepared.Notices, prepared.Scope, prepared.EffectiveSourcePolicy, prepared.ScopeFingerprint, prepared.RevisionFingerprint, prepared.SourceRevisions));
                return;
            }

            if (!ValidatePreparedCaptureBindings(prepared, out consistencyReason))
            {
                Complete(BuildInterruptedByChange(prepared, consistencyReason, stopwatch));
                return;
            }

            string cursorSortKey = SpatialSnapshotHelpers.BuildSortKey(cursor.SortPosition.DocumentKey, cursor.SortPosition.LinkPlacementKey, cursor.SortPosition.NodeKind, cursor.SortPosition.StableSourceIdentity);
            int exactIndex = prepared.OrderedRows.FindIndex(row => string.Equals(row.SortKey, cursorSortKey, StringComparison.Ordinal));
            if (exactIndex < 0)
            {
                SpatialCaptureSessionManager.Instance.Remove(prepared.CaptureId);
                Complete(BuildCursorGuarded("invalid_cursor_sort_position", "The signed cursor sort position is absent from the prepared capture session.", stopwatch, prepared.Warnings, prepared.Notices, prepared.Scope, prepared.EffectiveSourcePolicy, prepared.ScopeFingerprint, prepared.RevisionFingerprint, prepared.SourceRevisions));
                return;
            }

            int startIndex = exactIndex + 1;
            int expectedOrdinal;
            string expectedPriorPageHash;
            if (!TryResolveContinuationBoundary(prepared.OrderedRows, prepared.PageTargetBytes, prepared.CaptureId, startIndex, out expectedOrdinal, out expectedPriorPageHash) ||
                cursor.PageOrdinal != expectedOrdinal || !string.Equals(cursor.PriorPageHash, expectedPriorPageHash, StringComparison.Ordinal))
            {
                SpatialCaptureSessionManager.Instance.Remove(prepared.CaptureId);
                Complete(BuildCursorGuarded("invalid_cursor_chain", "The signed cursor ordinal, boundary, or prior-page hash is inconsistent with the prepared page chain.", stopwatch, prepared.Warnings, prepared.Notices, prepared.Scope, prepared.EffectiveSourcePolicy, prepared.ScopeFingerprint, prepared.RevisionFingerprint, prepared.SourceRevisions));
                return;
            }

            SpatialSnapshotResult result = BuildPreparedPageResult(prepared, startIndex, cursor, stopwatch, true);
            if (!ValidatePreparedCaptureBindings(prepared, out consistencyReason))
            {
                Complete(BuildInterruptedByChange(prepared, consistencyReason, stopwatch));
                return;
            }

            // UI-occupancy evidence must include the mandatory post-page source
            // binding check, not only page serialization.
            result.ElapsedMs = stopwatch.ElapsedMilliseconds;
            if (string.IsNullOrWhiteSpace(result.NextCursor)) SpatialCaptureSessionManager.Instance.Remove(prepared.CaptureId);
            Complete(result);
        }

        private DateTime ResolveWorkDeadline(Stopwatch stopwatch, int requestedMaxElapsedMs)
        {
            int targetMs = Math.Max(250, Math.Min(5000, requestedMaxElapsedMs));
            int remainingMs = targetMs - (int)Math.Min(int.MaxValue, stopwatch.ElapsedMilliseconds) - 75;
            return remainingMs > 25 ? DateTime.UtcNow.AddMilliseconds(remainingMs) : DateTime.UtcNow;
        }

        private static bool HasWorkTime(DateTime deadlineUtc, int reserveMs = 25)
        {
            return DateTime.UtcNow.AddMilliseconds(reserveMs) < deadlineUtc;
        }

        private static ElementId CreateElementId(int value)
        {
#if REVIT2024_OR_GREATER
            return new ElementId((long)value);
#else
            return new ElementId(value);
#endif
        }

        private List<SpatialDiscoveryPartition> BuildDiscoveryPartitions(IList<SpatialSource> sources)
        {
            List<SpatialDiscoveryPartition> result = new List<SpatialDiscoveryPartition>();
            for (int sourceOrdinal = 0; sourceOrdinal < sources.Count; sourceOrdinal++)
            {
                SpatialSource source = sources[sourceOrdinal];
                foreach (BuiltInCategory category in SpatialSnapshotHelpers.GetCategoriesForSource(source, _request)
                    .Distinct()
                    .OrderBy(value => value.ToString(), StringComparer.Ordinal))
                {
                    if (!source.ExtractElements) continue;
                    result.Add(new SpatialDiscoveryPartition { SourceOrdinal = sourceOrdinal, Category = category });
                }
            }
            return result;
        }

        private bool AdvancePreparedWork(PreparedSpatialCapture prepared, DateTime deadlineUtc, out string failureReason)
        {
            failureReason = null;
            while (HasWorkTime(deadlineUtc))
            {
                if (string.Equals(prepared.WorkPhase, "discover", StringComparison.Ordinal))
                {
                    if (!AdvanceDiscovery(prepared, deadlineUtc, out failureReason)) return false;
                }
                else if (string.Equals(prepared.WorkPhase, "filter", StringComparison.Ordinal))
                {
                    if (!AdvanceFiltering(prepared, deadlineUtc, out failureReason)) return false;
                }
                else if (string.Equals(prepared.WorkPhase, "extract", StringComparison.Ordinal))
                {
                    if (!AdvanceExtraction(prepared, deadlineUtc, out failureReason)) return false;
                }
                else if (string.Equals(prepared.WorkPhase, "finalize", StringComparison.Ordinal))
                {
                    if (!FinalizePreparedCapture(prepared, deadlineUtc, out failureReason)) return false;
                }
                else if (string.Equals(prepared.WorkPhase, "transport", StringComparison.Ordinal))
                {
                    return true;
                }
                else
                {
                    failureReason = "invalid_capture_work_phase";
                    return false;
                }
            }
            return true;
        }

        private bool AdvanceDiscovery(PreparedSpatialCapture prepared, DateTime deadlineUtc, out string failureReason)
        {
            failureReason = null;
            while (prepared.DiscoveryPartitionIndex < prepared.DiscoveryPartitions.Count && HasWorkTime(deadlineUtc, 75))
            {
                SpatialDiscoveryPartition partition = prepared.DiscoveryPartitions[prepared.DiscoveryPartitionIndex];
                SpatialSource source = prepared.Sources[partition.SourceOrdinal];
                if (prepared.ActiveDiscoveryElementIds == null || prepared.ActiveDiscoveryElementIds.Count == 0)
                {
                    try
                    {
                        using (FilteredElementCollector collector = new FilteredElementCollector(source.Document))
                        {
                            prepared.ActiveDiscoveryElementIds = collector
                                .OfCategory(partition.Category)
                                .WhereElementIsNotElementType()
                                .ToElementIds()
                                .Select(id => id.GetIdValue())
                                .OrderBy(id => id)
                                .ToList();
                        }
                        prepared.ActiveDiscoveryElementIndex = 0;
                        if ((long)prepared.DiscoveredCandidates.Count + prepared.ActiveDiscoveryElementIds.Count > MaximumDiscoveredCandidateCount)
                        {
                            failureReason = "candidate_inventory_limit_exceeded";
                            return false;
                        }
                    }
                    catch (Exception ex)
                    {
                        prepared.Warnings.Add("Source/category discovery failed for " + source.Identity.DocumentKey + " / " + source.PlacementKey + " / " + partition.Category + ": " + ex.GetType().Name + ".");
                        AddSourceOmission(prepared.OrderedRows, source.Identity.DocumentKey, source.PlacementKey, "source_collector_failed", ex.Message, source.LinkInstanceId, prepared.Extraction, partition.Category.ToString());
                        prepared.ActiveDiscoveryElementIds = new List<int>();
                        prepared.ActiveDiscoveryElementIndex = 0;
                        prepared.DiscoveryPartitionIndex++;
                        continue;
                    }
                }

                while (prepared.ActiveDiscoveryElementIndex < prepared.ActiveDiscoveryElementIds.Count && HasWorkTime(deadlineUtc))
                {
                    int elementId = prepared.ActiveDiscoveryElementIds[prepared.ActiveDiscoveryElementIndex];
                    Element element = source.Document.GetElement(CreateElementId(elementId));
                    if (element == null)
                    {
                        failureReason = "capture_candidate_identity_changed";
                        return false;
                    }
                    prepared.DiscoveredCandidates.Add(new SpatialCandidateRecord
                    {
                        SourceOrdinal = partition.SourceOrdinal,
                        ElementId = elementId,
                        StableSourceIdentity = SpatialSnapshotHelpers.StableUniqueId(element),
                        CategoryName = SpatialSnapshotHelpers.GetCategoryName(element),
                        BuiltInCategory = partition.Category
                    });
                    prepared.ActiveDiscoveryElementIndex++;
                }
                if (prepared.ActiveDiscoveryElementIndex < prepared.ActiveDiscoveryElementIds.Count) return true;
                prepared.ActiveDiscoveryElementIds = new List<int>();
                prepared.ActiveDiscoveryElementIndex = 0;
                prepared.DiscoveryPartitionIndex++;
            }

            prepared.Extraction.ScannedElementCount = prepared.DiscoveredCandidates.Count;
            if (prepared.DiscoveryPartitionIndex < prepared.DiscoveryPartitions.Count) return true;
            prepared.DiscoveredCandidates = prepared.DiscoveredCandidates
                .GroupBy(item => item.SourceOrdinal.ToString(CultureInfo.InvariantCulture) + "\u001f" + item.StableSourceIdentity, StringComparer.Ordinal)
                .Select(group => group.First())
                .OrderBy(item => prepared.Sources[item.SourceOrdinal].Identity.DocumentKey, StringComparer.Ordinal)
                .ThenBy(item => prepared.Sources[item.SourceOrdinal].PlacementKey, StringComparer.Ordinal)
                .ThenBy(item => item.StableSourceIdentity, StringComparer.Ordinal)
                .ToList();
            prepared.WorkPhase = "filter";
            return true;
        }

        private bool AdvanceFiltering(PreparedSpatialCapture prepared, DateTime deadlineUtc, out string failureReason)
        {
            failureReason = null;
            while (prepared.FilterIndex < prepared.DiscoveredCandidates.Count && HasWorkTime(deadlineUtc))
            {
                SpatialCandidateRecord record = prepared.DiscoveredCandidates[prepared.FilterIndex];
                SpatialSource source = prepared.Sources[record.SourceOrdinal];
                Element element = source.Document.GetElement(CreateElementId(record.ElementId));
                if (element == null || !string.Equals(SpatialSnapshotHelpers.StableUniqueId(element), record.StableSourceIdentity, StringComparison.Ordinal))
                {
                    failureReason = "capture_candidate_identity_changed";
                    return false;
                }

                SpatialCandidate candidate = new SpatialCandidate
                {
                    Source = source,
                    Element = element,
                    CategoryName = record.CategoryName,
                    StableSourceIdentity = record.StableSourceIdentity
                };
                try
                {
                    candidate.ScopeClassification = SpatialSnapshotHelpers.ClassifyLevelScope(
                        element,
                        source,
                        prepared.Bands,
                        out candidate.LevelName,
                        out candidate.LevelId,
                        out candidate.LevelUniqueId);
                }
                catch (Exception ex)
                {
                    candidate.ScopeClassification = "scope_read_failed";
                    prepared.Warnings.Add("Element scope read failed for " + record.StableSourceIdentity + ": " + ex.GetType().Name + ".");
                }

                if (string.Equals(candidate.ScopeClassification, "out_of_scope", StringComparison.Ordinal))
                {
                    prepared.Extraction.FilteredOutOfScopeCount++;
                }
                else if (RequiresLinkedSourceLevelFilter(candidate) &&
                    !candidate.LevelId.HasValue && string.IsNullOrWhiteSpace(candidate.LevelUniqueId) && string.IsNullOrWhiteSpace(candidate.LevelName))
                {
                    record.ScopeClassification = "linked_source_level_unresolved";
                    record.LevelName = candidate.LevelName;
                    record.LevelId = candidate.LevelId;
                    record.LevelUniqueId = candidate.LevelUniqueId;
                    prepared.EligibleCandidates.Add(record);
                }
                else if (!MatchesLinkedSourceLevelFilter(candidate))
                {
                    prepared.Extraction.FilteredOutOfScopeCount++;
                }
                else
                {
                    record.ScopeClassification = candidate.ScopeClassification;
                    record.LevelName = candidate.LevelName;
                    record.LevelId = candidate.LevelId;
                    record.LevelUniqueId = candidate.LevelUniqueId;
                    prepared.EligibleCandidates.Add(record);
                }
                prepared.FilterIndex++;
            }

            if (prepared.FilterIndex < prepared.DiscoveredCandidates.Count) return true;
            prepared.EligibleCandidates = prepared.EligibleCandidates
                .OrderBy(item => prepared.Sources[item.SourceOrdinal].Identity.DocumentKey, StringComparer.Ordinal)
                .ThenBy(item => prepared.Sources[item.SourceOrdinal].PlacementKey, StringComparer.Ordinal)
                .ThenBy(item => item.StableSourceIdentity, StringComparer.Ordinal)
                .ToList();
            prepared.Extraction.SelectionComplete = true;
            prepared.Extraction.EligibleElementCount = prepared.EligibleCandidates.Count;
            foreach (SpatialCandidateRecord candidate in prepared.EligibleCandidates)
            {
                prepared.Extraction.Increment(prepared.Extraction.EligibleByCategory, candidate.CategoryName);
            }
            prepared.WorkPhase = "extract";
            return true;
        }

        private bool AdvanceExtraction(PreparedSpatialCapture prepared, DateTime deadlineUtc, out string failureReason)
        {
            failureReason = null;
            int processCount = Math.Min(prepared.EligibleCandidates.Count, prepared.Request.MaxElements);
            if (!prepared.ExtractLimitInitialized)
            {
                prepared.ExtractLimitInitialized = true;
                int omittedByLimit = prepared.EligibleCandidates.Count - processCount;
                if (omittedByLimit > 0)
                {
                    prepared.Extraction.SelectionLimited = true;
                    prepared.Extraction.BudgetStopped = true;
                    prepared.Extraction.ScanStoppedReason = "max_items";
                    prepared.Extraction.OmittedElementCount += omittedByLimit;
                    prepared.Extraction.UnmaterializedOmissionCount += omittedByLimit;
                    prepared.Extraction.IncrementBy(prepared.Extraction.OmittedByClassification, "max_items", omittedByLimit);
                    prepared.Extraction.IncrementBy(prepared.Extraction.UnmaterializedOmissionsByClassification, "max_items", omittedByLimit);
                }
            }

            while (prepared.ExtractIndex < processCount && HasWorkTime(deadlineUtc))
            {
                SpatialCandidateRecord record = prepared.EligibleCandidates[prepared.ExtractIndex];
                SpatialSource source = prepared.Sources[record.SourceOrdinal];
                Element element = source.Document.GetElement(CreateElementId(record.ElementId));
                if (element == null || !string.Equals(SpatialSnapshotHelpers.StableUniqueId(element), record.StableSourceIdentity, StringComparison.Ordinal))
                {
                    failureReason = "capture_candidate_identity_changed";
                    return false;
                }

                if (!string.Equals(record.ScopeClassification, "eligible", StringComparison.Ordinal))
                {
                    string detail = string.Equals(record.ScopeClassification, "scope_unresolved", StringComparison.Ordinal)
                        ? "Element has no readable bounding box for physical host level-band filtering; source Level identity is diagnostic only."
                        : string.Equals(record.ScopeClassification, "linked_source_level_unresolved", StringComparison.Ordinal)
                            ? "Linked Room/Space has no resolvable source level for the requested exact linked source-level filter."
                            : "Element scope could not be read reliably.";
                    AddElementOmission(prepared.OrderedRows, source, element, record.CategoryName, record.ScopeClassification, detail, record.LevelName, record.LevelId, record.LevelUniqueId, prepared.Extraction, true);
                    prepared.ExtractIndex++;
                    continue;
                }
                if (record.StableSourceIdentity.StartsWith("element-id:", StringComparison.Ordinal))
                {
                    AddElementOmission(prepared.OrderedRows, source, element, record.CategoryName, "stable_identity_unavailable", "Element.UniqueId was unavailable; no stable node or connector identities were emitted.", record.LevelName, record.LevelId, record.LevelUniqueId, prepared.Extraction, true);
                    prepared.ExtractIndex++;
                    continue;
                }

                Dictionary<string, object> geometry;
                string omissionClassification;
                string omissionDetail;
                if (!SpatialSnapshotHelpers.TryBuildGeometry(
                    element,
                    source,
                    deadlineUtc,
                    prepared.Request.MaxGeometryPointsPerElement,
                    prepared.Request.MaxBoundarySegmentsPerElement,
                    out geometry,
                    out omissionClassification,
                    out omissionDetail))
                {
                    if (string.Equals(omissionClassification, "geometry_deadline_exceeded", StringComparison.Ordinal)) return true;
                    AddElementOmission(prepared.OrderedRows, source, element, record.CategoryName, omissionClassification ?? "geometry_unavailable", omissionDetail, record.LevelName, record.LevelId, record.LevelUniqueId, prepared.Extraction, true);
                    prepared.ExtractIndex++;
                    continue;
                }

                SpatialRow row = BuildNodeRow(source, element, record.CategoryName, record.LevelName, record.LevelId, record.LevelUniqueId, geometry);
                if (GetCanonicalRowByteCount(row) + 2 > prepared.PageTargetBytes)
                {
                    AddElementOmission(prepared.OrderedRows, source, element, record.CategoryName, "row_payload_too_large", "The canonical element row exceeds pageTargetBytes and was replaced with this classified omission.", record.LevelName, record.LevelId, record.LevelUniqueId, prepared.Extraction, true);
                    prepared.ExtractIndex++;
                    continue;
                }
                bool connectorReadFailed;
                bool connectorDeadlineExceeded;
                List<SpatialRow> connectorRows = SpatialSnapshotHelpers.BuildConnectorRows(
                    source,
                    element,
                    Convert.ToString(row.Payload["nodeId"], CultureInfo.InvariantCulture),
                    deadlineUtc,
                    prepared.Warnings,
                    out connectorReadFailed,
                    out connectorDeadlineExceeded);
                if (connectorDeadlineExceeded) return true;

                prepared.OrderedRows.Add(row);
                prepared.Extraction.ExtractedNodeCount++;
                prepared.Extraction.Increment(prepared.Extraction.ExtractedByCategory, record.CategoryName);
                if (connectorReadFailed)
                {
                    prepared.Extraction.OmittedConnectorCount++;
                    prepared.Extraction.Increment(prepared.Extraction.ConnectorOmittedByClassification, "connector_read_failed");
                    AddConnectorOmission(
                        prepared.OrderedRows,
                        source,
                        element,
                        Convert.ToString(row.Payload["nodeId"], CultureInfo.InvariantCulture),
                        null,
                        "connector_read_failed",
                        "The owner connector manager or connector set could not be read completely.");
                }
                foreach (SpatialRow connectorRow in connectorRows)
                {
                    if (GetCanonicalRowByteCount(connectorRow) + 2 > prepared.PageTargetBytes)
                    {
                        prepared.Extraction.OmittedConnectorCount++;
                        prepared.Extraction.Increment(prepared.Extraction.ConnectorOmittedByClassification, "row_payload_too_large");
                        AddConnectorOmission(
                            prepared.OrderedRows,
                            source,
                            element,
                            Convert.ToString(row.Payload["nodeId"], CultureInfo.InvariantCulture),
                            Convert.ToString(connectorRow.Payload["connectorKey"], CultureInfo.InvariantCulture),
                            "row_payload_too_large",
                            "The canonical connector row exceeds pageTargetBytes and was replaced with this classified omission.");
                        continue;
                    }
                    prepared.OrderedRows.Add(connectorRow);
                    prepared.Extraction.ExtractedConnectorCount++;
                }
                prepared.ExtractIndex++;
            }

            if (prepared.ExtractIndex < processCount) return true;
            prepared.WorkPhase = "finalize";
            return true;
        }

        private bool FinalizePreparedCapture(PreparedSpatialCapture prepared, DateTime deadlineUtc, out string failureReason)
        {
            failureReason = null;
            if (prepared.FinalizeStage == 0)
            {
                prepared.OrderedRows = prepared.OrderedRows
                    .OrderBy(row => row.DocumentKey, StringComparer.Ordinal)
                    .ThenBy(row => row.PlacementKey, StringComparer.Ordinal)
                    .ThenBy(row => row.NodeKind, StringComparer.Ordinal)
                    .ThenBy(row => row.StableSourceIdentity, StringComparer.Ordinal)
                    .ToList();
                prepared.FinalizeStage = 1;
            }
            if (prepared.FinalizeStage == 1)
            {
                while (prepared.FinalizeRowIndex < prepared.OrderedRows.Count && HasWorkTime(deadlineUtc))
                {
                    prepared.PreparedCanonicalBytes += GetCanonicalRowByteCount(prepared.OrderedRows[prepared.FinalizeRowIndex]);
                    if (prepared.PreparedCanonicalBytes > MaximumPreparedCanonicalBytes)
                    {
                        failureReason = "prepared_capture_byte_limit_exceeded";
                        return false;
                    }
                    prepared.FinalizeRowIndex++;
                }
                if (prepared.FinalizeRowIndex < prepared.OrderedRows.Count) return true;
                prepared.FinalizeStage = 2;
            }
            if (prepared.FinalizeStage == 2)
            {
                List<SpatialSource> orderedSources = prepared.Sources
                    .OrderBy(source => source.Identity.DocumentKey, StringComparer.Ordinal)
                    .ThenBy(source => source.PlacementKey, StringComparer.Ordinal)
                    .ToList();
                while (prepared.FinalizeSourceIndex < orderedSources.Count && HasWorkTime(deadlineUtc))
                {
                    SpatialSource source = orderedSources[prepared.FinalizeSourceIndex];
                    string prefix = source.Identity.DocumentKey + "\u001f" + source.PlacementKey + "\u001f";
                    source.ContentFingerprint = SpatialSnapshotHelpers.Sha256(string.Join("\n", prepared.OrderedRows
                        .Where(row => row.SortKey.StartsWith(prefix, StringComparison.Ordinal))
                        .Select(row => row.SortKey + "|" + row.PayloadFingerprint)));
                    prepared.FinalizeSourceIndex++;
                }
                if (prepared.FinalizeSourceIndex < orderedSources.Count) return true;
                prepared.FinalizeStage = 3;
            }
            if (prepared.FinalizeStage == 3 && HasWorkTime(deadlineUtc))
            {
                if (prepared.Sources.Any(source => !source.IsHost && source.Identity.ExternalLinkUpdateAvailable))
                {
                    prepared.Warnings.Add("One or more linked sources have a different external file version available; the snapshot contains the geometry currently loaded in Revit.");
                }
                prepared.Warnings = prepared.Warnings.Distinct(StringComparer.Ordinal).ToList();
                prepared.SourceRevisions = BuildSourceRevisions(prepared.Sources, prepared.Extraction);
                if (prepared.Extraction.TransformValidationFailureCount > 0)
                {
                    failureReason = "invalid_source_transform";
                    return false;
                }
                prepared.RevisionFingerprint = BuildRevisionFingerprint(prepared.Sources, prepared.SourceRevisions, prepared.OrderedRows, prepared.SourceBindingFingerprint);
                prepared.TotalPageCount = CountPages(prepared.OrderedRows, prepared.PageTargetBytes);
                prepared.TotalPayloadBytes = ComputeTotalPayloadBytes(prepared.OrderedRows, prepared.PageTargetBytes);
                prepared.FinalizeStage = 4;
            }
            if (prepared.FinalizeStage == 4)
            {
                prepared.PreparationComplete = true;
                prepared.WorkPhase = "transport";
            }
            return true;
        }

        private void CompletePreparedOrProgress(PreparedSpatialCapture prepared, Stopwatch stopwatch)
        {
            if (prepared.PreparationComplete)
            {
                SpatialSnapshotResult firstPage = BuildPreparedPageResult(prepared, 0, null, stopwatch, true);
                if (string.IsNullOrWhiteSpace(firstPage.NextCursor)) SpatialCaptureSessionManager.Instance.Remove(prepared.CaptureId);
                else SpatialCaptureSessionManager.Instance.Store(prepared);
                Complete(firstPage);
                return;
            }

            prepared.WorkStepOrdinal++;
            SpatialSnapshotResult progress = BuildWorkProgress(prepared, stopwatch);
            SpatialCaptureSessionManager.Instance.Store(prepared);
            Complete(progress);
        }

        private SpatialSnapshotResult BuildWorkProgress(PreparedSpatialCapture prepared, Stopwatch stopwatch)
        {
            int processed;
            object total;
            if (prepared.WorkPhase == "discover")
            {
                processed = prepared.DiscoveryPartitionIndex;
                total = prepared.DiscoveryPartitions.Count;
            }
            else if (prepared.WorkPhase == "filter")
            {
                processed = prepared.FilterIndex;
                total = prepared.DiscoveredCandidates.Count;
            }
            else if (prepared.WorkPhase == "extract")
            {
                processed = prepared.ExtractIndex;
                total = Math.Min(prepared.EligibleCandidates.Count, prepared.Request.MaxElements);
            }
            else
            {
                processed = 0;
                total = null;
            }

            string nextCursor = SpatialSnapshotHelpers.EncodeWorkCursor(new WorkCursorEnvelope
            {
                CursorVersion = SpatialSnapshotHelpers.WorkCursorVersion,
                CursorKind = "work",
                CaptureId = prepared.CaptureId,
                WorkPhase = prepared.WorkPhase,
                StepOrdinal = prepared.WorkStepOrdinal,
                ScopeFingerprint = prepared.ScopeFingerprint,
                SourceBindingFingerprint = prepared.SourceBindingFingerprint,
                CapturedAt = prepared.CapturedAt
            });
            Dictionary<string, object> preparation = new Dictionary<string, object>
            {
                { "phase", prepared.WorkPhase },
                { "stepOrdinal", prepared.WorkStepOrdinal },
                { "processed", processed },
                { "total", total },
                { "hasMore", true },
                { "cursorVersion", SpatialSnapshotHelpers.WorkCursorVersion },
                { "nextCursor", nextCursor },
                { "uiOccupancyTargetMs", Math.Max(250, Math.Min(5000, prepared.Request.MaxElapsedMs)) }
            };
            return new SpatialSnapshotResult
            {
                Success = true,
                Guarded = false,
                State = "in_progress",
                Action = "extract_spatial_snapshot",
                Message = "A bounded native preparation chunk completed; continue with the authenticated work cursor before staging spatial pages.",
                ContinuationKind = "work",
                SchemaVersion = SpatialSnapshotHelpers.SchemaVersion,
                ExtractorVersion = SpatialSnapshotHelpers.ExtractorVersion,
                CoordinateFrame = SpatialSnapshotHelpers.CoordinateFrame,
                LengthUnit = "mm",
                CaptureId = prepared.CaptureId,
                SnapshotId = prepared.CaptureId,
                CapturedAt = prepared.CapturedAt,
                Atomic = false,
                Liveness = "staging",
                CaptureConsistency = SpatialSnapshotHelpers.CaptureConsistency,
                RevisionBasisCaveat = SpatialSnapshotHelpers.Phase1aCaveat,
                Scope = prepared.Scope,
                EffectiveSourcePolicy = prepared.EffectiveSourcePolicy,
                ScopeFingerprint = prepared.ScopeFingerprint,
                SourceBindingFingerprint = prepared.SourceBindingFingerprint,
                Preparation = preparation,
                NextCursor = nextCursor,
                Partial = false,
                ScanPolicy = BuildScanPolicy(prepared.Request),
                SuggestedNextScopes = new List<string>(),
                ElapsedMs = stopwatch.ElapsedMilliseconds,
                Warnings = new List<string>(prepared.Warnings ?? new List<string>()),
                Notices = new List<string>(prepared.Notices ?? new List<string>())
            };
        }

        private static bool TryBindCurrentHostDocument(PreparedSpatialCapture prepared, Document hostDocument, out string reason)
        {
            reason = null;
            if (prepared == null || hostDocument == null ||
                string.IsNullOrWhiteSpace(prepared.HostDocumentKey) ||
                string.IsNullOrWhiteSpace(prepared.HostDocumentSessionId) ||
                string.IsNullOrWhiteSpace(prepared.HostTrackerSessionId))
            {
                reason = "capture_has_no_host_binding";
                return false;
            }

            DocumentIdentity currentIdentity;
            try
            {
                currentIdentity = SpatialSnapshotHelpers.ResolveDocumentIdentity(hostDocument);
            }
            catch
            {
                reason = "capture_host_binding_read_failed";
                return false;
            }

            if (currentIdentity == null)
            {
                reason = "capture_host_binding_read_failed";
                return false;
            }
            if (!string.Equals(prepared.HostDocumentKey, currentIdentity.DocumentKey, StringComparison.Ordinal))
            {
                reason = "capture_document_identity_changed";
                return false;
            }
            if (!string.Equals(prepared.HostTrackerSessionId, currentIdentity.TrackerSessionId, StringComparison.Ordinal))
            {
                reason = "capture_tracker_session_changed";
                return false;
            }
            if (!currentIdentity.TrackerSubscribed)
            {
                reason = "change_tracker_unavailable";
                return false;
            }
            if (!string.Equals(prepared.HostDocumentSessionId, currentIdentity.DocumentSessionId, StringComparison.Ordinal))
            {
                reason = "capture_document_session_changed";
                return false;
            }

            // Revit can surface a new managed wrapper for the same open native document.
            // Refresh only after the stable tracker-backed open-document binding matches.
            prepared.HostDocument = hostDocument;
            return true;
        }

        private bool ValidatePreparedCaptureBindings(PreparedSpatialCapture prepared, out string reason)
        {
            reason = null;
            if (prepared == null || prepared.Sources == null || prepared.Sources.Count == 0 || prepared.HostDocument == null)
            {
                reason = "capture_has_no_source_bindings";
                return false;
            }
            List<SpatialSource> currentSources = new List<SpatialSource>();
            List<SpatialRow> availabilityRows = new List<SpatialRow>();
            SpatialExtractionState currentState = new SpatialExtractionState();
            List<string> ignoredWarnings = new List<string>();
            SpatialSnapshotRequest activeRequest = _request;
            try
            {
                _request = prepared.Request;
                DocumentIdentity hostIdentity = SpatialSnapshotHelpers.ResolveDocumentIdentity(prepared.HostDocument);
                ResolveSources(prepared.HostDocument, hostIdentity, currentSources, availabilityRows, currentState, ignoredWarnings, false);
            }
            catch
            {
                reason = "capture_source_binding_read_failed";
                return false;
            }
            finally
            {
                _request = activeRequest;
            }

            reason = DetermineBindingMismatchReason(prepared.Sources, prepared.OrderedRows, currentSources, availabilityRows);
            if (reason != null) return false;
            string currentFingerprint = BuildSourceBindingFingerprint(currentSources, availabilityRows);
            if (!string.Equals(currentFingerprint, prepared.SourceBindingFingerprint, StringComparison.Ordinal))
            {
                reason = "capture_source_binding_fingerprint_changed";
                return false;
            }
            for (int index = 0; index < currentSources.Count; index++)
            {
                currentSources[index].Identity.ExternalSourceVersion = prepared.Sources[index].Identity.ExternalSourceVersion;
                currentSources[index].Identity.ExternalLinkUpdateAvailable = prepared.Sources[index].Identity.ExternalLinkUpdateAvailable;
                currentSources[index].Identity.ExternalObservationBasis = prepared.Sources[index].Identity.ExternalObservationBasis;
            }
            prepared.Sources = currentSources;
            return true;
        }

        private static string DetermineBindingMismatchReason(
            IList<SpatialSource> expectedSources,
            IList<SpatialRow> expectedRows,
            IList<SpatialSource> currentSources,
            IList<SpatialRow> currentRows)
        {
            if (expectedSources.Count != currentSources.Count) return "capture_source_set_changed";
            for (int index = 0; index < expectedSources.Count; index++)
            {
                SpatialSource expected = expectedSources[index];
                SpatialSource current = currentSources[index];
                if (!string.Equals(expected.PlacementKey, current.PlacementKey, StringComparison.Ordinal) || expected.IsHost != current.IsHost)
                    return "capture_source_set_changed";
                if (!string.Equals(expected.Identity.DocumentKey, current.Identity.DocumentKey, StringComparison.Ordinal))
                    return "capture_document_identity_changed";
                if (!string.Equals(expected.Identity.TrackerSessionId, current.Identity.TrackerSessionId, StringComparison.Ordinal))
                    return "capture_tracker_session_changed";
                if (!current.Identity.TrackerSubscribed) return "change_tracker_unavailable";
                if (!string.Equals(expected.Identity.DocumentSessionId, current.Identity.DocumentSessionId, StringComparison.Ordinal))
                    return "capture_document_session_changed";
                if (expected.Identity.ChangeSequence != current.Identity.ChangeSequence)
                    return "capture_change_sequence_advanced";
                if (!string.Equals(expected.Identity.LoadedVersion, current.Identity.LoadedVersion, StringComparison.Ordinal) ||
                    expected.Identity.LoadedVersionAvailable != current.Identity.LoadedVersionAvailable)
                    return "capture_loaded_version_changed";
                if (!string.Equals(CanonicalSourceTransform(expected), CanonicalSourceTransform(current), StringComparison.Ordinal))
                    return "capture_link_transform_changed";
            }
            string expectedAvailability = BuildAvailabilityFingerprint(expectedRows);
            string currentAvailability = BuildAvailabilityFingerprint(currentRows);
            return string.Equals(expectedAvailability, currentAvailability, StringComparison.Ordinal)
                ? null
                : "capture_source_availability_changed";
        }

        private static bool ValidateSourceTransforms(IList<SpatialSource> sources, SpatialExtractionState state, out string reason)
        {
            reason = null;
            foreach (SpatialSource source in sources)
            {
                double errorMm;
                bool valid;
                SpatialSnapshotHelpers.BuildTransformRecord(source.SourceToHost, out errorMm, out valid);
                if (!valid)
                {
                    reason = "Source-to-host transform validation failed for placement " + source.PlacementKey + ".";
                    return false;
                }
            }
            return true;
        }

        private static string BuildSourceBindingFingerprint(IList<SpatialSource> sources, IList<SpatialRow> availabilityRows)
        {
            List<Dictionary<string, object>> sourceBindings = sources
                .OrderBy(source => source.Identity.DocumentKey, StringComparer.Ordinal)
                .ThenBy(source => source.PlacementKey, StringComparer.Ordinal)
                .Select(source =>
                {
                    double errorMm;
                    bool valid;
                    return new Dictionary<string, object>
                    {
                        { "sourceKind", source.IsHost ? "host" : "link" },
                        { "placementKey", source.PlacementKey },
                        { "documentKey", source.Identity.DocumentKey },
                        { "documentSessionId", source.Identity.DocumentSessionId },
                        { "trackerSessionId", source.Identity.TrackerSessionId },
                        { "changeSequence", source.Identity.ChangeSequence },
                        { "loadedVersion", source.Identity.LoadedVersion },
                        { "loadedVersionAvailable", source.Identity.LoadedVersionAvailable },
                        { "loadedVersionBasis", source.Identity.LoadedVersionBasis },
                        { "sourceToHostTransform", SpatialSnapshotHelpers.BuildTransformRecord(source.SourceToHost, out errorMm, out valid) },
                        { "transformValid", valid }
                    };
                })
                .ToList();
            Dictionary<string, object> basis = new Dictionary<string, object>
            {
                { "bindingVersion", "phase1a-source-binding/1.0" },
                { "sources", sourceBindings },
                { "sourceAvailabilityFingerprint", BuildAvailabilityFingerprint(availabilityRows) }
            };
            return SpatialSnapshotHelpers.Sha256(SpatialSnapshotHelpers.SemanticCanonicalJson(basis));
        }

        private static string CanonicalSourceTransform(SpatialSource source)
        {
            double errorMm;
            bool valid;
            return SpatialSnapshotHelpers.SemanticCanonicalJson(SpatialSnapshotHelpers.BuildTransformRecord(source.SourceToHost, out errorMm, out valid));
        }

        private static string BuildAvailabilityFingerprint(IList<SpatialRow> rows)
        {
            IEnumerable<string> values = (rows ?? new List<SpatialRow>())
                .Where(IsBindingAvailabilityRow)
                .OrderBy(row => row.SortKey, StringComparer.Ordinal)
                .Select(row => row.SortKey + "|" + SpatialSnapshotHelpers.SemanticCanonicalJson(new Dictionary<string, object>
                {
                    { "classification", row.Payload.ContainsKey("classification") ? row.Payload["classification"] : null },
                    { "documentKey", row.Payload.ContainsKey("documentKey") ? row.Payload["documentKey"] : null },
                    { "linkInstanceUniqueId", row.Payload.ContainsKey("linkInstanceUniqueId") ? row.Payload["linkInstanceUniqueId"] : null },
                    { "linkInstanceId", row.Payload.ContainsKey("linkInstanceId") ? row.Payload["linkInstanceId"] : null }
                }));
            return SpatialSnapshotHelpers.Sha256(string.Join("\n", values));
        }

        private static bool IsBindingAvailabilityRow(SpatialRow row)
        {
            if (row == null || !string.Equals(row.NodeKind, "source_omission", StringComparison.Ordinal) || row.Payload == null) return false;
            object raw;
            string classification = row.Payload.TryGetValue("classification", out raw)
                ? Convert.ToString(raw, CultureInfo.InvariantCulture)
                : "";
            return classification == "link_instance_identity_unavailable" ||
                classification == "link_transform_unavailable" ||
                classification == "linked_document_read_failed" ||
                classification == "unloaded_link" ||
                classification == "requested_link_not_found";
        }

        private SpatialSnapshotResult BuildWorkFailure(PreparedSpatialCapture prepared, string reason, Stopwatch stopwatch)
        {
            if (reason == "candidate_inventory_limit_exceeded" || reason == "prepared_capture_byte_limit_exceeded")
            {
                SpatialCaptureSessionManager.Instance.Remove(prepared.CaptureId);
                SpatialSnapshotResult guarded = BuildCursorGuarded(
                    "needs_scope",
                    "The bounded native capture exceeded its candidate or prepared-byte lease. Narrow the explicit level/link/category scope and restart without cursor.",
                    stopwatch,
                    prepared.Warnings,
                    prepared.Notices,
                    prepared.Scope,
                    prepared.EffectiveSourcePolicy,
                    prepared.ScopeFingerprint,
                    prepared.RevisionFingerprint,
                    prepared.SourceRevisions);
                guarded.CaptureId = prepared.CaptureId;
                guarded.SnapshotId = prepared.CaptureId;
                guarded.CapturedAt = prepared.CapturedAt;
                guarded.SourceBindingFingerprint = prepared.SourceBindingFingerprint;
                guarded.Notices = new List<string>(guarded.Notices ?? new List<string>());
                guarded.Notices.Add("Preparation guard: " + reason);
                return guarded;
            }
            return BuildInterruptedByChange(prepared, reason, stopwatch);
        }

        private SpatialSnapshotResult BuildInterruptedByChange(PreparedSpatialCapture prepared, string consistencyReason, Stopwatch stopwatch)
        {
            if (prepared != null) SpatialCaptureSessionManager.Instance.Remove(prepared.CaptureId);
            List<string> warnings = prepared != null ? prepared.Warnings : new List<string>();
            List<string> notices = prepared != null ? prepared.Notices : new List<string> { SpatialSnapshotHelpers.Phase1aCaveat };
            SpatialSnapshotResult result = BuildCursorGuarded(
                "capture_interrupted_by_change",
                "The model revision changed while the sequence-bound capture was being prepared or paged. The native prepared session was discarded; restart without cursor.",
                stopwatch,
                warnings,
                notices,
                prepared != null ? prepared.Scope : null,
                prepared != null ? prepared.EffectiveSourcePolicy : null,
                prepared != null ? prepared.ScopeFingerprint : null,
                prepared != null ? prepared.RevisionFingerprint : null,
                prepared != null ? prepared.SourceRevisions : null);
            result.CaptureId = prepared != null ? prepared.CaptureId : null;
            result.SnapshotId = prepared != null ? prepared.CaptureId : null;
            result.CapturedAt = prepared != null ? prepared.CapturedAt : null;
            result.CaptureConsistency = SpatialSnapshotHelpers.CaptureConsistency;
            result.SourceBindingFingerprint = prepared != null ? prepared.SourceBindingFingerprint : null;
            result.Liveness = "staging";
            result.Notices = new List<string>(notices ?? new List<string>());
            result.Notices.Add("Consistency guard: " + (string.IsNullOrWhiteSpace(consistencyReason) ? "sequence_binding_changed" : consistencyReason));
            return result;
        }

        private SpatialSnapshotResult BuildPreparedPageResult(PreparedSpatialCapture prepared, int startIndex, CursorEnvelope cursor, Stopwatch stopwatch, bool allowContinuation)
        {
            int pageOrdinal = cursor != null ? cursor.PageOrdinal : 0;
            string priorPageHash = cursor != null ? cursor.PriorPageHash : null;
            List<SpatialRow> pageRows = PackPage(prepared.OrderedRows, startIndex, prepared.PageTargetBytes, prepared.Warnings);
            int nextIndex = startIndex + pageRows.Count;
            bool hasMore = allowContinuation && nextIndex < prepared.OrderedRows.Count;
            List<Dictionary<string, object>> nodes = pageRows.Where(row => row.IsNode).Select(row => row.Payload).ToList();
            List<Dictionary<string, object>> omissions = pageRows.Where(row => !row.IsNode).Select(row => row.Payload).ToList();
            List<Dictionary<string, object>> canonicalPageRows = BuildCanonicalPageRows(pageRows);
            string pageHash = BuildPageHash(prepared.CaptureId, pageOrdinal, priorPageHash, canonicalPageRows);
            int payloadBytes = Encoding.UTF8.GetByteCount(SpatialSnapshotHelpers.SemanticCanonicalJson(canonicalPageRows));
            int totalPageCount = allowContinuation ? prepared.TotalPageCount : 1;
            long totalPayloadBytes = allowContinuation ? prepared.TotalPayloadBytes : payloadBytes;
            string nextCursor = null;
            if (hasMore && pageRows.Count > 0)
            {
                SpatialRow last = pageRows[pageRows.Count - 1];
                nextCursor = SpatialSnapshotHelpers.EncodeCursor(new CursorEnvelope
                {
                    CursorVersion = SpatialSnapshotHelpers.CursorVersion,
                    CaptureId = prepared.CaptureId,
                    PageOrdinal = pageOrdinal + 1,
                    SortPosition = new CursorSortPosition
                    {
                        DocumentKey = last.DocumentKey,
                        LinkPlacementKey = last.PlacementKey,
                        NodeKind = last.NodeKind,
                        StableSourceIdentity = last.StableSourceIdentity
                    },
                    PriorPageHash = pageHash,
                    RevisionFingerprint = prepared.RevisionFingerprint,
                    ScopeFingerprint = prepared.ScopeFingerprint,
                    CapturedAt = prepared.CapturedAt
                });
            }

            SpatialRow lastRead = pageRows.Count > 0 ? pageRows[pageRows.Count - 1] : null;
            if (lastRead != null)
            {
                prepared.Extraction.LastReadDocumentKey = lastRead.DocumentKey;
                prepared.Extraction.LastReadLinkInstanceUniqueId = string.Equals(lastRead.PlacementKey, "host", StringComparison.Ordinal) ? null : lastRead.PlacementKey;
                prepared.Extraction.LastReadNodeKind = lastRead.NodeKind;
                prepared.Extraction.LastReadItemId = lastRead.ElementId;
            }

            bool hasCoverageGaps = prepared.Extraction.OmittedElementCount > 0 ||
                prepared.Extraction.OmittedConnectorCount > 0 ||
                prepared.Extraction.SourceAvailabilityOmissionCount > 0 ||
                prepared.Extraction.TransformValidationFailureCount > 0;
            bool partial = hasMore || prepared.Extraction.BudgetStopped || hasCoverageGaps;
            string coverageStatus = prepared.Extraction.BudgetStopped ? "incomplete_budget" : hasCoverageGaps ? "incomplete_omissions" : "complete";
            string stoppedReason = prepared.Extraction.BudgetStopped
                ? (string.IsNullOrWhiteSpace(prepared.Extraction.ScanStoppedReason) ? "max_elapsed" : prepared.Extraction.ScanStoppedReason)
                : hasMore ? "max_bytes" : hasCoverageGaps ? "read_failed" : "completed";
            int expectedSupportedNodeCount = prepared.Extraction.EligibleElementCount +
                prepared.Extraction.ExtractedConnectorCount + prepared.Extraction.OmittedConnectorCount;
            int extractedSupportedNodeCount = prepared.Extraction.ExtractedNodeCount + prepared.Extraction.ExtractedConnectorCount;
            double coverageRatio = !prepared.Extraction.SelectionComplete
                ? 0.0
                : expectedSupportedNodeCount == 0
                    ? 1.0
                    : (double)extractedSupportedNodeCount / expectedSupportedNodeCount;
            int classifiedOmissions = prepared.Extraction.OmittedByClassification.Values.Sum() +
                prepared.Extraction.ConnectorOmittedByClassification.Values.Sum() +
                prepared.Extraction.SourceOmittedByClassification.Values.Sum();
            Dictionary<string, object> page = new Dictionary<string, object>
            {
                { "ordinal", pageOrdinal },
                { "targetBytes", prepared.PageTargetBytes },
                { "payloadBytes", payloadBytes },
                { "rows", canonicalPageRows },
                { "rowCount", canonicalPageRows.Count },
                { "recordCount", nodes.Count },
                { "nodeCount", nodes.Count },
                { "omissionCount", omissions.Count },
                { "hasMore", hasMore },
                { "pageSha256", pageHash },
                { "pageHash", pageHash },
                { "priorPageSha256", priorPageHash },
                { "priorPageHash", priorPageHash },
                { "firstSortPosition", pageRows.Count > 0 ? pageRows[0].SortKey : null },
                { "lastSortPosition", pageRows.Count > 0 ? pageRows[pageRows.Count - 1].SortKey : null },
                { "nextCursor", nextCursor }
            };

            return new SpatialSnapshotResult
            {
                Success = true,
                Guarded = false,
                State = "completed",
                Action = "extract_spatial_snapshot",
                Message = partial ? "A sequence-bound Phase 1a staging page was produced with explicit continuation or coverage state." : "The final sequence-bound Phase 1a staging page was produced.",
                SchemaVersion = SpatialSnapshotHelpers.SchemaVersion,
                ExtractorVersion = SpatialSnapshotHelpers.ExtractorVersion,
                CoordinateFrame = SpatialSnapshotHelpers.CoordinateFrame,
                LengthUnit = "mm",
                CaptureId = prepared.CaptureId,
                SnapshotId = prepared.CaptureId,
                CapturedAt = prepared.CapturedAt,
                Atomic = false,
                Liveness = "staging",
                CaptureConsistency = SpatialSnapshotHelpers.CaptureConsistency,
                RevisionBasisCaveat = SpatialSnapshotHelpers.Phase1aCaveat,
                Scope = prepared.Scope,
                EffectiveSourcePolicy = prepared.EffectiveSourcePolicy,
                SourceRevisions = prepared.SourceRevisions,
                ScopeFingerprint = prepared.ScopeFingerprint,
                SourceBindingFingerprint = prepared.SourceBindingFingerprint,
                RevisionFingerprint = prepared.RevisionFingerprint,
                Nodes = nodes,
                Omissions = omissions,
                Counts = new Dictionary<string, object>
                {
                    { "totalNodes", prepared.Extraction.ExtractedNodeCount + prepared.Extraction.ExtractedConnectorCount },
                    { "nodesByKind", new Dictionary<string, object> { { "revit_element", prepared.Extraction.ExtractedNodeCount }, { "connector", prepared.Extraction.ExtractedConnectorCount }, { "derived", 0 } } },
                    { "expectedSupportedNodes", expectedSupportedNodeCount },
                    { "extractedSupportedNodes", extractedSupportedNodeCount },
                    { "omittedSupportedNodes", prepared.Extraction.OmittedElementCount + prepared.Extraction.OmittedConnectorCount },
                    { "omissionsByReason", prepared.Extraction.OmittedByClassification },
                    { "connectorOmissionsByReason", prepared.Extraction.ConnectorOmittedByClassification }
                },
                Coverage = new Dictionary<string, object>
                {
                    { "sourceCount", prepared.Extraction.SourceCount },
                    { "selectedLinkCount", prepared.Extraction.SelectedLinkCount },
                    { "loadedLinkCount", prepared.Extraction.LoadedLinkCount },
                    { "unloadedLinkCount", prepared.Extraction.UnloadedLinkCount },
                    { "scannedElementCount", prepared.Extraction.ScannedElementCount },
                    { "filteredOutOfScopeCount", prepared.Extraction.FilteredOutOfScopeCount },
                    { "sourceAvailabilityOmissionCount", prepared.Extraction.SourceAvailabilityOmissionCount },
                    { "totalOrderedRowCount", prepared.OrderedRows.Count },
                    { "pageNodeCount", nodes.Count },
                    { "pageOmissionCount", omissions.Count },
                    { "eligibleByCategory", prepared.Extraction.EligibleByCategory },
                    { "extractedByCategory", prepared.Extraction.ExtractedByCategory },
                    { "omittedByClassification", prepared.Extraction.OmittedByClassification },
                    { "connectorOmittedByClassification", prepared.Extraction.ConnectorOmittedByClassification },
                    { "unmaterializedOmissionCount", prepared.Extraction.UnmaterializedOmissionCount },
                    { "unmaterializedOmissionsByClassification", prepared.Extraction.UnmaterializedOmissionsByClassification },
                    { "sourceOmittedByClassification", prepared.Extraction.SourceOmittedByClassification },
                    { "classifiedOmissionCount", classifiedOmissions },
                    { "effectiveScope", prepared.HasEffectiveSourcePolicy },
                    { "selectionComplete", prepared.Extraction.SelectionComplete },
                    { "allEligibleOmissionsClassified", prepared.Extraction.SelectionComplete && classifiedOmissions == prepared.Extraction.OmittedElementCount + prepared.Extraction.OmittedConnectorCount + prepared.Extraction.SourceAvailabilityOmissionCount },
                    { "extractionCoverageRatio", Math.Round(coverageRatio, 6, MidpointRounding.AwayFromZero) },
                    { "phase0TargetAtLeast0_995", prepared.Extraction.SelectionComplete && coverageRatio >= 0.995 && !prepared.Extraction.BudgetStopped && prepared.Extraction.SourceAvailabilityOmissionCount == 0 && prepared.Extraction.TransformValidationFailureCount == 0 },
                    { "complete", prepared.Extraction.SelectionComplete && !partial && prepared.Extraction.TransformValidationFailureCount == 0 && classifiedOmissions == prepared.Extraction.OmittedElementCount + prepared.Extraction.OmittedConnectorCount + prepared.Extraction.SourceAvailabilityOmissionCount }
                },
                TransformValidation = new Dictionary<string, object>
                {
                    { "transformCount", prepared.Extraction.TransformCount },
                    { "validatedCount", prepared.Extraction.TransformCount - prepared.Extraction.TransformValidationFailureCount },
                    { "failedCount", prepared.Extraction.TransformValidationFailureCount },
                    { "maxRoundTripErrorMm", prepared.Extraction.TransformCount > 0 ? (object)Math.Round(prepared.Extraction.MaxTransformRoundTripErrorMm, 6, MidpointRounding.AwayFromZero) : null },
                    { "allWithin0_5mm", prepared.Extraction.TransformValidationFailureCount == 0 }
                },
                Page = page,
                PageCount = totalPageCount,
                PayloadBytes = totalPayloadBytes,
                NextCursor = nextCursor,
                Partial = partial,
                CoverageStatus = coverageStatus,
                ScanStoppedReason = stoppedReason,
                ScanPolicy = BuildScanPolicy(prepared.Request),
                SuggestedNextScopes = BuildSuggestedNextScopes(hasMore, prepared.Extraction),
                ElapsedMs = stopwatch.ElapsedMilliseconds,
                LastReadDocumentKey = prepared.Extraction.LastReadDocumentKey,
                LastReadLinkInstanceUniqueId = prepared.Extraction.LastReadLinkInstanceUniqueId,
                LastReadNodeKind = prepared.Extraction.LastReadNodeKind,
                LastReadItemId = prepared.Extraction.LastReadItemId,
                Warnings = new List<string>(prepared.Warnings ?? new List<string>()),
                Notices = new List<string>(prepared.Notices ?? new List<string>())
            };
        }

        private void ResolveSources(Document hostDocument, DocumentIdentity hostIdentity, List<SpatialSource> sources, List<SpatialRow> rows, SpatialExtractionState state, List<string> warnings, bool observeExternalVersions = true)
        {
            if (!hostIdentity.CrossSessionStable)
            {
                warnings.Add("The host document identity is session-only or otherwise not cross-session comparable; node identity is valid for this open-document session only.");
            }
            sources.Add(new SpatialSource
            {
                Document = hostDocument,
                LinkInstance = null,
                IsHostSource = true,
                LinkInstanceId = null,
                SourceToHost = Transform.Identity,
                Identity = hostIdentity,
                PlacementKey = "host",
                ExtractElements = !string.Equals(_request.SourceScope, "linkedOnly", StringComparison.OrdinalIgnoreCase)
            });

            if (string.Equals(_request.SourceScope, "hostOnly", StringComparison.OrdinalIgnoreCase)) return;

            List<RevitLinkInstance> allLinks;
            using (FilteredElementCollector collector = new FilteredElementCollector(hostDocument))
            {
                allLinks = collector.OfClass(typeof(RevitLinkInstance)).WhereElementIsNotElementType().Cast<RevitLinkInstance>()
                    .OrderBy(link => SafeUniqueId(link), StringComparer.Ordinal)
                    .ThenBy(link => link.Id.GetIdValue())
                    .ToList();
            }

            HashSet<int> foundIds = new HashSet<int>();
            HashSet<string> foundUniqueIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (RevitLinkInstance link in allLinks)
            {
                string linkUniqueId = SafeUniqueId(link);
                int linkId = link.Id.GetIdValue();
                if (!MatchesLinkFilter(linkId, linkUniqueId)) continue;
                foundIds.Add(linkId);
                if (!string.IsNullOrWhiteSpace(linkUniqueId)) foundUniqueIds.Add(linkUniqueId);
                state.SelectedLinkCount++;

                if (string.IsNullOrWhiteSpace(linkUniqueId))
                {
                    AddSourceOmission(rows, hostIdentity.DocumentKey, "link-instance-id:" + linkId.ToString(CultureInfo.InvariantCulture), "link_instance_identity_unavailable", "Selected link placement has no readable UniqueId; it cannot satisfy double-placement identity requirements.", linkId, state);
                    continue;
                }

                Transform transform;
                try { transform = link.GetTransform(); }
                catch (Exception ex)
                {
                    AddSourceOmission(rows, hostIdentity.DocumentKey, linkUniqueId, "link_transform_unavailable", ex.Message, linkId, state);
                    continue;
                }

                Document linkDocument;
                try { linkDocument = link.GetLinkDocument(); }
                catch (Exception ex)
                {
                    AddSourceOmission(rows, hostIdentity.DocumentKey, linkUniqueId, "linked_document_read_failed", ex.Message, linkId, state);
                    continue;
                }
                if (linkDocument == null)
                {
                    state.UnloadedLinkCount++;
                    AddSourceOmission(rows, "unloaded-link:" + SpatialSnapshotHelpers.Sha256(hostIdentity.DocumentKey + "|" + linkUniqueId), linkUniqueId, "unloaded_link", "Selected Revit link is unloaded or inaccessible; no linked Room/Space or obstruction elements can be extracted.", linkId, state);
                    continue;
                }

                state.LoadedLinkCount++;
                DocumentIdentity linkIdentity = SpatialSnapshotHelpers.ResolveDocumentIdentity(linkDocument, true, observeExternalVersions);
                if (!linkIdentity.CrossSessionStable)
                {
                    warnings.Add("Linked source identity is not cross-session comparable for placement " + linkUniqueId + "; its node identity is session-scoped.");
                }
                if (!linkIdentity.LoadedVersionAvailable)
                {
                    warnings.Add("The in-memory loaded version could not be resolved for linked placement " + linkUniqueId + "; revision identity remains session/sequence/content bound.");
                }
                if (linkIdentity.ExternalLinkUpdateAvailable)
                {
                    warnings.Add("A different external file version is available for linked placement " + linkUniqueId + "; the currently loaded Revit geometry remains the capture truth until the link is reloaded.");
                }
                sources.Add(new SpatialSource
                {
                    Document = linkDocument,
                    LinkInstance = null,
                    IsHostSource = false,
                    LinkInstanceId = linkId,
                    SourceToHost = transform,
                    Identity = linkIdentity,
                    PlacementKey = linkUniqueId,
                    ExtractElements = true
                });
            }

            foreach (int requestedId in _request.LinkInstanceIds.Where(id => !foundIds.Contains(id)))
            {
                AddSourceOmission(rows, hostIdentity.DocumentKey, "requested-link-id:" + requestedId.ToString(CultureInfo.InvariantCulture), "requested_link_not_found", "Requested linkInstanceId was not found in the host document.", requestedId, state);
            }
            foreach (string requestedUniqueId in _request.LinkInstanceUniqueIds.Where(id => !foundUniqueIds.Contains(id)))
            {
                AddSourceOmission(rows, hostIdentity.DocumentKey, requestedUniqueId, "requested_link_not_found", "Requested linkInstanceUniqueId was not found in the host document.", null, state);
            }
        }

        private bool MatchesLinkFilter(int id, string uniqueId)
        {
            if (_request.LinkInstanceIds.Count == 0 && _request.LinkInstanceUniqueIds.Count == 0) return true;
            return _request.LinkInstanceIds.Contains(id) || _request.LinkInstanceUniqueIds.Contains(uniqueId, StringComparer.Ordinal);
        }

        private static List<Level> GetLevels(Document document)
        {
            if (document == null) return new List<Level>();
            try
            {
                using (FilteredElementCollector collector = new FilteredElementCollector(document))
                {
                    return collector.OfClass(typeof(Level)).Cast<Level>()
                        .OrderBy(level => SpatialSnapshotHelpers.GetProjectElevationFeet(level))
                        .ThenBy(level => level.Id.GetIdValue())
                        .ToList();
                }
            }
            catch
            {
                return new List<Level>();
            }
        }

        private bool HasLinkedSourceLevelFilter()
        {
            return _request.LinkedSourceLevels.Count > 0 || _request.LinkedSourceLevelNames.Count > 0;
        }

        private bool MatchesLinkedSourceLevelFilter(SpatialCandidate candidate)
        {
            if (!RequiresLinkedSourceLevelFilter(candidate)) return true;
            if (!string.IsNullOrWhiteSpace(candidate.LevelName) && _request.LinkedSourceLevelNames.Contains(candidate.LevelName, StringComparer.OrdinalIgnoreCase)) return true;
            return _request.LinkedSourceLevels.Any(selector =>
                string.Equals(selector.LinkInstanceUniqueId, candidate.Source.PlacementKey, StringComparison.Ordinal) &&
                (!selector.LevelId.HasValue || selector.LevelId == candidate.LevelId) &&
                (string.IsNullOrWhiteSpace(selector.LevelUniqueId) || string.Equals(selector.LevelUniqueId, candidate.LevelUniqueId, StringComparison.Ordinal)) &&
                (string.IsNullOrWhiteSpace(selector.LevelName) || string.Equals(selector.LevelName, candidate.LevelName, StringComparison.OrdinalIgnoreCase)));
        }

        private bool RequiresLinkedSourceLevelFilter(SpatialCandidate candidate)
        {
            return candidate != null && candidate.Source != null && !candidate.Source.IsHost && HasLinkedSourceLevelFilter() &&
                SpatialSnapshotHelpers.SpatialCategories.Contains(SpatialSnapshotHelpers.GetBuiltInCategory(candidate.Element));
        }

        private static bool MatchesLevelSelector(Level level, LinkedSourceLevelSelector selector)
        {
            if (level == null || selector == null) return false;
            return (!selector.LevelId.HasValue || selector.LevelId.Value == level.Id.GetIdValue()) &&
                (string.IsNullOrWhiteSpace(selector.LevelUniqueId) || string.Equals(selector.LevelUniqueId, SafeUniqueId(level), StringComparison.Ordinal)) &&
                (string.IsNullOrWhiteSpace(selector.LevelName) || string.Equals(selector.LevelName, level.Name, StringComparison.OrdinalIgnoreCase));
        }

        private List<Dictionary<string, object>> BuildResolvedLinkedSourceLevelRecords(IList<SpatialSource> sources)
        {
            List<Dictionary<string, object>> records = new List<Dictionary<string, object>>();
            if (!HasLinkedSourceLevelFilter()) return records;
            foreach (SpatialSource source in sources.Where(item => !item.IsHost && item.ExtractElements).OrderBy(item => item.PlacementKey, StringComparer.Ordinal))
            {
                foreach (Level level in GetLevels(source.Document))
                {
                    bool matchesName = !string.IsNullOrWhiteSpace(level.Name) && _request.LinkedSourceLevelNames.Contains(level.Name, StringComparer.OrdinalIgnoreCase);
                    bool matchesSelector = _request.LinkedSourceLevels.Any(selector =>
                        string.Equals(selector.LinkInstanceUniqueId, source.PlacementKey, StringComparison.Ordinal) && MatchesLevelSelector(level, selector));
                    if (!matchesName && !matchesSelector) continue;
                    records.Add(new Dictionary<string, object>
                    {
                        { "linkInstanceUniqueId", source.PlacementKey },
                        { "levelId", level.Id.GetIdValue() },
                        { "levelUniqueId", SafeUniqueId(level) },
                        { "levelName", level.Name }
                    });
                }
            }
            return records
                .OrderBy(record => Convert.ToString(record["linkInstanceUniqueId"], CultureInfo.InvariantCulture), StringComparer.Ordinal)
                .ThenBy(record => Convert.ToString(record["levelUniqueId"], CultureInfo.InvariantCulture), StringComparer.Ordinal)
                .ToList();
        }

        private bool ValidateLinkedSourceLevelScope(IList<SpatialSource> sources, List<string> warnings, List<string> notices)
        {
            List<SpatialSource> linkedSources = sources.Where(source => !source.IsHost && source.ExtractElements).ToList();
            if (!HasLinkedSourceLevelFilter())
            {
                if (linkedSources.Count > 0)
                {
                    notices.Add("Host level scope uses an explicit host-Z vertical band and is not an exact linked source-level filter. Adjacent linked levels can overlap the band; use placement-qualified linkedSourceLevels and/or linkedSourceLevelNames when exact linked-level membership is required.");
                }
                return true;
            }
            if (!_request.IncludeRoomsSpaces)
            {
                warnings.Add("Exact linked source-level selectors apply only to linked Room/Space rows, but includeRoomsSpaces=false.");
                return false;
            }
            if (linkedSources.Count == 0)
            {
                warnings.Add("Exact linked source-level selectors were supplied, but no selected loaded link is available for extraction.");
                return false;
            }

            bool valid = true;
            HashSet<string> availableNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (SpatialSource linkedSource in linkedSources)
            {
                foreach (Level level in GetLevels(linkedSource.Document))
                {
                    if (!string.IsNullOrWhiteSpace(level.Name)) availableNames.Add(level.Name);
                }
            }
            foreach (string requestedName in _request.LinkedSourceLevelNames.Where(name => !availableNames.Contains(name)))
            {
                warnings.Add("Requested exact linked source level name was not found in the selected loaded links: " + requestedName + ".");
                valid = false;
            }
            foreach (LinkedSourceLevelSelector selector in _request.LinkedSourceLevels)
            {
                SpatialSource source = linkedSources.FirstOrDefault(item => string.Equals(item.PlacementKey, selector.LinkInstanceUniqueId, StringComparison.Ordinal));
                if (source == null)
                {
                    warnings.Add("Requested exact linked source level selector references a link instance that is not selected and loaded: " + selector.LinkInstanceUniqueId + ".");
                    valid = false;
                    continue;
                }
                if (!GetLevels(source.Document).Any(level => MatchesLevelSelector(level, selector)))
                {
                    warnings.Add("Requested exact linked source level selector did not resolve inside link instance " + selector.LinkInstanceUniqueId + ".");
                    valid = false;
                }
            }
            return valid;
        }

        private static string SafeUniqueId(Element element)
        {
            try { return element.UniqueId ?? ""; }
            catch { return ""; }
        }

        private Dictionary<string, object> BuildEffectiveSourcePolicy(IList<SpatialSource> sources, SpatialExtractionState state, out bool hasEffectivePolicy)
        {
            List<Dictionary<string, object>> effectiveSources = new List<Dictionary<string, object>>();
            HashSet<string> effectiveCategories = new HashSet<string>(StringComparer.Ordinal);
            foreach (SpatialSource source in sources
                .OrderBy(item => item.Identity.DocumentKey, StringComparer.Ordinal)
                .ThenBy(item => item.PlacementKey, StringComparer.Ordinal))
            {
                List<string> categories = SpatialSnapshotHelpers.GetCategoriesForSource(source, _request)
                    .Select(category => category.ToString())
                    .OrderBy(category => category, StringComparer.Ordinal)
                    .ToList();
                if (!source.ExtractElements || categories.Count == 0) continue;
                foreach (string category in categories) effectiveCategories.Add(category);
                effectiveSources.Add(new Dictionary<string, object>
                {
                    { "documentKey", source.Identity.DocumentKey },
                    { "sourceKind", source.IsHost ? "host" : "link" },
                    { "linkPlacementKey", source.PlacementKey },
                    { "categories", categories }
                });
            }

            hasEffectivePolicy = effectiveSources.Count > 0 && effectiveCategories.Count > 0;
            return new Dictionary<string, object>
            {
                { "requestedSourceScope", _request.SourceScope },
                { "sourceDocumentPolicy", GetSourceDocumentPolicy(_request.SourceScope) },
                { "includeHostMep", _request.IncludeHostMep },
                { "includeRoomsSpaces", _request.IncludeRoomsSpaces },
                { "includeLinkedObstructions", _request.IncludeLinkedObstructions },
                { "linkedSourceLevelFilterMode", HasLinkedSourceLevelFilter() ? "exact" : "none" },
                { "linkedSourceLevelFilterAppliesTo", new List<string> { "linked_room_space" } },
                { "requestedLinkedSourceLevels", SpatialSnapshotHelpers.BuildLinkedSourceLevelSelectorRecords(_request.LinkedSourceLevels) },
                { "requestedLinkedSourceLevelNames", _request.LinkedSourceLevelNames.OrderBy(value => value, StringComparer.OrdinalIgnoreCase).ToList() },
                { "selectedLinkCount", state.SelectedLinkCount },
                { "loadedSelectedLinkCount", state.LoadedLinkCount },
                { "effectiveSourceCount", effectiveSources.Count },
                { "effectiveCategories", effectiveCategories.OrderBy(value => value, StringComparer.Ordinal).ToList() },
                { "effectiveSources", effectiveSources },
                { "hasEffectiveExtractionPolicy", hasEffectivePolicy }
            };
        }

        private static string GetSourceDocumentPolicy(string sourceScope)
        {
            if (string.Equals(sourceScope, "hostOnly", StringComparison.OrdinalIgnoreCase)) return "host_only";
            if (string.Equals(sourceScope, "linkedOnly", StringComparison.OrdinalIgnoreCase)) return "linked_only";
            return "host_and_loaded_links";
        }

        private bool TryDiscoverAndFilterCandidates(
            IList<SpatialSource> sources,
            IList<LevelBand> bands,
            List<SpatialRow> rows,
            SpatialExtractionState state,
            DateTime deadlineUtc,
            List<string> warnings,
            out List<SpatialCandidate> candidates)
        {
            List<SpatialCandidate> discovered = new List<SpatialCandidate>();
            candidates = new List<SpatialCandidate>();

            foreach (SpatialSource source in sources
                .Where(item => item.ExtractElements)
                .OrderBy(item => item.Identity.DocumentKey, StringComparer.Ordinal)
                .ThenBy(item => item.PlacementKey, StringComparer.Ordinal))
            {
                List<BuiltInCategory> categories = SpatialSnapshotHelpers.GetCategoriesForSource(source, _request);
                if (categories.Count == 0) continue;
                try
                {
                    using (FilteredElementCollector collector = new FilteredElementCollector(source.Document))
                    {
                        IEnumerable<Element> elements = collector
                            .WherePasses(new ElementMulticategoryFilter(categories))
                            .WhereElementIsNotElementType();
                        foreach (Element element in elements)
                        {
                            if (DateTime.UtcNow >= deadlineUtc)
                            {
                                state.ScannedElementCount = discovered.Count;
                                state.Stop("max_elapsed");
                                warnings.Add("Candidate discovery exceeded maxElapsedMs; no collector-order-dependent element subset was emitted.");
                                return false;
                            }
                            discovered.Add(new SpatialCandidate
                            {
                                Source = source,
                                Element = element,
                                CategoryName = SpatialSnapshotHelpers.GetCategoryName(element),
                                StableSourceIdentity = SpatialSnapshotHelpers.StableUniqueId(element)
                            });
                        }
                    }
                }
                catch (Exception ex)
                {
                    warnings.Add("Source collector failed for " + source.Identity.DocumentKey + " / " + source.PlacementKey + ": " + ex.Message);
                    AddSourceOmission(rows, source.Identity.DocumentKey, source.PlacementKey, "source_collector_failed", ex.Message, source.LinkInstanceId, state);
                }
            }

            discovered = discovered
                .OrderBy(item => item.Source.Identity.DocumentKey, StringComparer.Ordinal)
                .ThenBy(item => item.Source.PlacementKey, StringComparer.Ordinal)
                .ThenBy(item => item.StableSourceIdentity, StringComparer.Ordinal)
                .ToList();
            state.ScannedElementCount = discovered.Count;

            foreach (SpatialCandidate candidate in discovered)
            {
                if (DateTime.UtcNow >= deadlineUtc)
                {
                    state.Stop("max_elapsed");
                    warnings.Add("Level-scope filtering exceeded maxElapsedMs; no collector-order-dependent element subset was emitted.");
                    candidates.Clear();
                    return false;
                }
                try
                {
                    candidate.ScopeClassification = SpatialSnapshotHelpers.ClassifyLevelScope(
                        candidate.Element,
                        candidate.Source,
                        bands,
                        out candidate.LevelName,
                        out candidate.LevelId,
                        out candidate.LevelUniqueId);
                }
                catch (Exception ex)
                {
                    candidate.ScopeClassification = "scope_read_failed";
                    candidate.LevelName = null;
                    candidate.LevelId = null;
                    candidate.LevelUniqueId = null;
                    warnings.Add("Element scope read failed for " + candidate.StableSourceIdentity + ": " + ex.Message);
                }

                if (string.Equals(candidate.ScopeClassification, "out_of_scope", StringComparison.Ordinal))
                {
                    state.FilteredOutOfScopeCount++;
                    continue;
                }
                if (RequiresLinkedSourceLevelFilter(candidate) &&
                    !candidate.LevelId.HasValue && string.IsNullOrWhiteSpace(candidate.LevelUniqueId) && string.IsNullOrWhiteSpace(candidate.LevelName))
                {
                    candidate.ScopeClassification = "linked_source_level_unresolved";
                }
                else if (!MatchesLinkedSourceLevelFilter(candidate))
                {
                    state.FilteredOutOfScopeCount++;
                    continue;
                }
                candidates.Add(candidate);
            }

            candidates = candidates
                .OrderBy(item => item.Source.Identity.DocumentKey, StringComparer.Ordinal)
                .ThenBy(item => item.Source.PlacementKey, StringComparer.Ordinal)
                .ThenBy(item => item.StableSourceIdentity, StringComparer.Ordinal)
                .ToList();
            state.SelectionComplete = true;
            state.EligibleElementCount = candidates.Count;
            foreach (SpatialCandidate candidate in candidates) state.Increment(state.EligibleByCategory, candidate.CategoryName);
            return true;
        }

        private void ExtractCandidates(
            IList<SpatialCandidate> candidates,
            List<SpatialRow> rows,
            SpatialExtractionState state,
            DateTime deadlineUtc,
            List<string> warnings)
        {
            int processCount = Math.Min(candidates.Count, _request.MaxElements);
            int maxItemOmissions = candidates.Count - processCount;
            if (maxItemOmissions > 0)
            {
                state.Stop("max_items");
                state.OmittedElementCount += maxItemOmissions;
                state.IncrementBy(state.OmittedByClassification, "max_items", maxItemOmissions);
            }

            for (int index = 0; index < processCount; index++)
            {
                SpatialCandidate candidate = candidates[index];
                if (DateTime.UtcNow >= deadlineUtc)
                {
                    int remaining = processCount - index;
                    state.Stop("max_elapsed");
                    state.OmittedElementCount += remaining;
                    state.IncrementBy(state.OmittedByClassification, "max_elapsed", remaining);
                    warnings.Add("Geometry extraction reached maxElapsedMs; the remaining deterministic candidate suffix was classified as max_elapsed.");
                    break;
                }

                if (!string.Equals(candidate.ScopeClassification, "eligible", StringComparison.Ordinal))
                {
                    string detail = string.Equals(candidate.ScopeClassification, "scope_unresolved", StringComparison.Ordinal)
                        ? "Element has no readable bounding box for physical host level-band filtering; source Level identity, when available, is diagnostic only."
                        : string.Equals(candidate.ScopeClassification, "linked_source_level_unresolved", StringComparison.Ordinal)
                            ? "Linked Room/Space has no resolvable source level for the requested exact linked source-level filter."
                        : "Element scope could not be read reliably.";
                    AddElementOmission(rows, candidate.Source, candidate.Element, candidate.CategoryName, candidate.ScopeClassification, detail, candidate.LevelName, candidate.LevelId, candidate.LevelUniqueId, state, true);
                    continue;
                }

                if (candidate.StableSourceIdentity.StartsWith("element-id:", StringComparison.Ordinal))
                {
                    AddElementOmission(rows, candidate.Source, candidate.Element, candidate.CategoryName, "stable_identity_unavailable", "Element.UniqueId was unavailable; the numeric ElementId is retained only as session evidence and no stable node was emitted.", candidate.LevelName, candidate.LevelId, candidate.LevelUniqueId, state, true);
                    continue;
                }

                Dictionary<string, object> geometry;
                string omissionClassification;
                string omissionDetail;
                if (!SpatialSnapshotHelpers.TryBuildGeometry(
                    candidate.Element,
                    candidate.Source,
                    deadlineUtc,
                    _request.MaxGeometryPointsPerElement,
                    _request.MaxBoundarySegmentsPerElement,
                    out geometry,
                    out omissionClassification,
                    out omissionDetail))
                {
                    AddElementOmission(rows, candidate.Source, candidate.Element, candidate.CategoryName, omissionClassification ?? "geometry_unavailable", omissionDetail, candidate.LevelName, candidate.LevelId, candidate.LevelUniqueId, state, true);
                    if (string.Equals(omissionClassification, "geometry_deadline_exceeded", StringComparison.Ordinal))
                    {
                        int remaining = processCount - index - 1;
                        state.Stop("max_elapsed");
                        state.OmittedElementCount += remaining;
                        state.IncrementBy(state.OmittedByClassification, "max_elapsed", remaining);
                        break;
                    }
                    continue;
                }

                SpatialRow row = BuildNodeRow(candidate.Source, candidate.Element, candidate.CategoryName, candidate.LevelName, candidate.LevelId, candidate.LevelUniqueId, geometry);
                if (GetCanonicalRowByteCount(row) + 2 > _request.PageTargetBytes)
                {
                    AddElementOmission(rows, candidate.Source, candidate.Element, candidate.CategoryName, "row_payload_too_large", "The canonical element row exceeds pageTargetBytes and was replaced with this classified omission.", candidate.LevelName, candidate.LevelId, candidate.LevelUniqueId, state, true);
                    continue;
                }
                rows.Add(row);
                state.ExtractedNodeCount++;
                state.Increment(state.ExtractedByCategory, candidate.CategoryName);
            }
        }

        private static SpatialRow BuildNodeRow(SpatialSource source, Element element, string categoryName, string levelName, int? levelId, string levelUniqueId, Dictionary<string, object> geometry)
        {
            string uniqueId = SpatialSnapshotHelpers.StableUniqueId(element);
            string nodeId = SpatialSnapshotHelpers.BuildNodeId(source, uniqueId);
            Dictionary<string, object> elementRef = SpatialSnapshotHelpers.BuildElementRef(source, element, uniqueId);
            BuiltInCategory category = SpatialSnapshotHelpers.GetBuiltInCategory(element);
            Dictionary<string, object> sourceRef = new Dictionary<string, object>
            {
                { "documentKey", source.Identity.DocumentKey },
                { "documentSessionId", source.Identity.DocumentSessionId }
            };
            if (!source.IsHost) sourceRef["linkInstanceUniqueId"] = source.PlacementKey;
            Dictionary<string, object> nodeRef = new Dictionary<string, object>
            {
                { "nodeId", nodeId },
                { "nodeKind", "revit_element" },
                { "elementRef", elementRef },
                { "sourceRefs", new List<object>
                    {
                        sourceRef
                    }
                }
            };
            Dictionary<string, object> payload = new Dictionary<string, object>
            {
                { "nodeId", nodeId },
                { "nodeKind", "revit_element" },
                { "nodeRef", nodeRef },
                { "elementRef", elementRef },
                { "sourceRefs", nodeRef["sourceRefs"] },
                { "category", categoryName },
                { "builtInCategory", category.ToString() },
                { "categoryRole", SpatialSnapshotHelpers.GetCategoryRole(source, category) },
                { "name", SpatialSnapshotHelpers.GetElementName(element) },
                { "familyName", SpatialSnapshotHelpers.GetFamilyName(source.Document, element) },
                { "typeName", SpatialSnapshotHelpers.GetTypeName(source.Document, element) },
                { "levelRef", new Dictionary<string, object>
                    {
                        { "sourceLevelId", levelId },
                        { "sourceLevelName", levelName },
                        { "sourceLevelUniqueId", levelUniqueId }
                    }
                },
                { "geometry", geometry }
            };
            string sortKey = SpatialSnapshotHelpers.BuildSortKey(source.Identity.DocumentKey, source.PlacementKey, "revit_element", uniqueId);
            return new SpatialRow
            {
                SortKey = sortKey,
                DocumentKey = source.Identity.DocumentKey,
                PlacementKey = source.PlacementKey,
                NodeKind = "revit_element",
                StableSourceIdentity = uniqueId,
                ElementId = element.Id.GetIdValue(),
                IsNode = true,
                Payload = payload,
                PayloadFingerprint = SpatialSnapshotHelpers.Sha256(SpatialSnapshotHelpers.SerializePayload(payload))
            };
        }

        private static void AddElementOmission(List<SpatialRow> rows, SpatialSource source, Element element, string categoryName, string classification, string detail, string levelName, int? levelId, string levelUniqueId, SpatialExtractionState state, bool alreadyCountedEligible = false)
        {
            if (!alreadyCountedEligible)
            {
                state.EligibleElementCount++;
                state.Increment(state.EligibleByCategory, categoryName);
            }
            state.OmittedElementCount++;
            state.Increment(state.OmittedByClassification, classification);
            string uniqueId = SpatialSnapshotHelpers.StableUniqueId(element);
            bool hasStableUniqueId = !uniqueId.StartsWith("element-id:", StringComparison.Ordinal);
            Dictionary<string, object> payload = new Dictionary<string, object>
            {
                { "classification", classification },
                { "detail", TrimDetail(detail) },
                { "eligible", true },
                { "nodeKind", "revit_element" },
                { "category", categoryName },
                { "levelRef", new Dictionary<string, object> { { "sourceLevelId", levelId }, { "sourceLevelName", levelName }, { "sourceLevelUniqueId", levelUniqueId } } }
            };
            if (hasStableUniqueId)
            {
                payload["elementRef"] = SpatialSnapshotHelpers.BuildElementRef(source, element, uniqueId);
            }
            else
            {
                payload["sessionEvidence"] = new Dictionary<string, object>
                {
                    { "documentKey", source.Identity.DocumentKey },
                    { "documentSessionId", source.Identity.DocumentSessionId },
                    { "linkInstanceUniqueId", source.IsHost ? null : source.PlacementKey },
                    { "elementId", element.Id.GetIdValue() }
                };
            }
            string sortKey = SpatialSnapshotHelpers.BuildSortKey(source.Identity.DocumentKey, source.PlacementKey, "revit_element_omission", uniqueId);
            rows.Add(new SpatialRow
            {
                SortKey = sortKey,
                DocumentKey = source.Identity.DocumentKey,
                PlacementKey = source.PlacementKey,
                NodeKind = "revit_element_omission",
                StableSourceIdentity = uniqueId,
                ElementId = element.Id.GetIdValue(),
                IsNode = false,
                Payload = payload,
                PayloadFingerprint = SpatialSnapshotHelpers.Sha256(SpatialSnapshotHelpers.SerializePayload(payload))
            });
        }

        private static void AddConnectorOmission(
            List<SpatialRow> rows,
            SpatialSource source,
            Element owner,
            string ownerNodeId,
            string connectorKey,
            string classification,
            string detail)
        {
            string ownerUniqueId = SpatialSnapshotHelpers.StableUniqueId(owner);
            Dictionary<string, object> payload = new Dictionary<string, object>
            {
                { "classification", classification },
                { "detail", TrimDetail(detail) },
                { "eligible", true },
                { "nodeKind", "connector" },
                { "ownerNodeId", ownerNodeId },
                { "connectorKey", string.IsNullOrWhiteSpace(connectorKey) ? null : connectorKey },
                { "elementRef", SpatialSnapshotHelpers.BuildElementRef(source, owner, ownerUniqueId) }
            };
            string stableIdentity = ownerNodeId + "|" + (string.IsNullOrWhiteSpace(connectorKey) ? classification : connectorKey + "|" + classification);
            rows.Add(new SpatialRow
            {
                SortKey = SpatialSnapshotHelpers.BuildSortKey(source.Identity.DocumentKey, source.PlacementKey, "connector_omission", stableIdentity),
                DocumentKey = source.Identity.DocumentKey,
                PlacementKey = source.PlacementKey,
                NodeKind = "connector_omission",
                StableSourceIdentity = stableIdentity,
                ElementId = owner.Id.GetIdValue(),
                IsNode = false,
                Payload = payload,
                PayloadFingerprint = SpatialSnapshotHelpers.Sha256(SpatialSnapshotHelpers.SerializePayload(payload))
            });
        }

        private static void AddSourceOmission(List<SpatialRow> rows, string documentKey, string placementKey, string classification, string detail, int? linkInstanceId, SpatialExtractionState state, string sourcePartition = null)
        {
            state.SourceAvailabilityOmissionCount++;
            state.Increment(state.SourceOmittedByClassification, classification);
            Dictionary<string, object> payload = new Dictionary<string, object>
            {
                { "classification", classification },
                { "detail", TrimDetail(detail) },
                { "eligible", true },
                { "nodeKind", "source_availability" },
                { "documentKey", documentKey },
                { "linkInstanceUniqueId", placementKey },
                { "linkInstanceId", linkInstanceId }
            };
            if (!string.IsNullOrWhiteSpace(sourcePartition)) payload["sourcePartition"] = sourcePartition;
            string stableIdentity = placementKey + ":" + classification + ":" + (sourcePartition ?? "");
            rows.Add(new SpatialRow
            {
                SortKey = SpatialSnapshotHelpers.BuildSortKey(documentKey, placementKey, "source_omission", stableIdentity),
                DocumentKey = documentKey,
                PlacementKey = placementKey,
                NodeKind = "source_omission",
                StableSourceIdentity = stableIdentity,
                ElementId = linkInstanceId,
                IsNode = false,
                Payload = payload,
                PayloadFingerprint = SpatialSnapshotHelpers.Sha256(SpatialSnapshotHelpers.SerializePayload(payload))
            });
        }

        private static string TrimDetail(string detail)
        {
            if (string.IsNullOrWhiteSpace(detail)) return "No additional detail was available.";
            string value = detail.Trim();
            return value.Length <= 1000 ? value : value.Substring(0, 1000);
        }

        private static List<Dictionary<string, object>> BuildSourceRevisions(List<SpatialSource> sources, SpatialExtractionState state)
        {
            List<Dictionary<string, object>> result = new List<Dictionary<string, object>>();
            foreach (SpatialSource source in sources
                .OrderBy(item => item.Identity.DocumentKey, StringComparer.Ordinal)
                .ThenBy(item => item.PlacementKey, StringComparer.Ordinal))
            {
                double errorMm;
                bool valid;
                Dictionary<string, object> transform = SpatialSnapshotHelpers.BuildTransformRecord(source.SourceToHost, out errorMm, out valid);
                state.TransformCount++;
                if (!valid) state.TransformValidationFailureCount++;
                if (!double.IsNaN(errorMm) && !double.IsInfinity(errorMm)) state.MaxTransformRoundTripErrorMm = Math.Max(state.MaxTransformRoundTripErrorMm, errorMm);
                Dictionary<string, object> revision = new Dictionary<string, object>
                {
                    { "documentKey", source.Identity.DocumentKey },
                    { "documentSessionId", source.Identity.DocumentSessionId },
                    { "loadedVersion", source.Identity.LoadedVersion },
                    { "changeSequence", source.Identity.ChangeSequence },
                    { "changeSequenceState", "tracked" },
                    { "oldestRetainedSequence", source.Identity.OldestRetainedSequence },
                    { "trackerSessionId", source.Identity.TrackerSessionId },
                    { "journalEntryCount", source.Identity.JournalEntryCount },
                    { "journalCapacity", source.Identity.JournalCapacity },
                    { "journalTruncated", source.Identity.JournalTruncated },
                    { "externalLinkUpdateAvailable", !source.IsHost && source.Identity.ExternalLinkUpdateAvailable },
                    { "sourceToHostTransform", transform },
                    { "documentKeyResolution", new Dictionary<string, object>
                        {
                            { "resolverVersion", "phase1a-document-key/0.2" },
                            { "basis", MapDocumentIdentityBasis(source.Identity.ResolutionBasis) },
                            { "crossSessionComparable", source.Identity.CrossSessionStable }
                        }
                    }
                };
                if (!source.IsHost) revision["linkInstanceUniqueId"] = source.PlacementKey;
                Dictionary<string, object> resolution = (Dictionary<string, object>)revision["documentKeyResolution"];
                if (!string.IsNullOrWhiteSpace(source.Identity.FallbackReason)) resolution["fallbackReason"] = source.Identity.FallbackReason;
                result.Add(revision);
            }
            return result;
        }

        private static string MapDocumentIdentityBasis(string basis)
        {
            if (string.Equals(basis, "cloud_project_model_identity", StringComparison.Ordinal)) return "cloud";
            if (string.Equals(basis, "workshared_central_identity", StringComparison.Ordinal)) return "workshared_central";
            if (string.Equals(basis, "project_information_plus_normalized_path", StringComparison.Ordinal)) return "saved_standalone";
            return "session_only";
        }

        private static string BuildRevisionFingerprint(IList<SpatialSource> sources, IList<Dictionary<string, object>> sourceRevisions, IList<SpatialRow> rows, string sourceBindingFingerprint)
        {
            StringBuilder text = new StringBuilder();
            text.Append("extractor=").Append(SpatialSnapshotHelpers.ExtractorVersion).Append('\n');
            text.Append("source-binding=").Append(sourceBindingFingerprint ?? "").Append('\n');
            foreach (Dictionary<string, object> source in sourceRevisions)
            {
                Dictionary<string, object> revisionIdentity = source
                    .Where(pair => !string.Equals(pair.Key, "externalLinkUpdateAvailable", StringComparison.Ordinal))
                    .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
                text.Append(SpatialSnapshotHelpers.CanonicalJson(revisionIdentity)).Append('\n');
            }
            foreach (SpatialSource source in sources
                .OrderBy(item => item.Identity.DocumentKey, StringComparer.Ordinal)
                .ThenBy(item => item.PlacementKey, StringComparer.Ordinal))
            {
                text.Append("content=")
                    .Append(source.Identity.DocumentKey).Append('|')
                    .Append(source.PlacementKey).Append('|')
                    .Append(source.ContentFingerprint).Append('\n');
            }
            text.Append("capture-content=").Append(SpatialSnapshotHelpers.Sha256(string.Join("\n", rows.Select(row => row.SortKey + "|" + row.PayloadFingerprint)))).Append('\n');
            return SpatialSnapshotHelpers.Sha256(text.ToString());
        }

        private static List<SpatialRow> PackPage(IList<SpatialRow> rows, int startIndex, int targetBytes, List<string> warnings)
        {
            List<SpatialRow> page = new List<SpatialRow>();
            int payloadBytes = 2;
            for (int index = startIndex; index < rows.Count; index++)
            {
                SpatialRow row = rows[index];
                int rowBytes = GetCanonicalRowByteCount(row);
                int additionalBytes = rowBytes + (page.Count > 0 ? 1 : 0);
                if (page.Count > 0 && payloadBytes + additionalBytes > targetBytes) break;
                if (page.Count == 0 && payloadBytes + additionalBytes > targetBytes)
                {
                    throw new InvalidOperationException("A canonical spatial row exceeds pageTargetBytes after oversized element rows were classified.");
                }
                page.Add(row);
                payloadBytes += additionalBytes;
            }
            return page;
        }

        private static List<Dictionary<string, object>> BuildCanonicalPageRows(IList<SpatialRow> pageRows)
        {
            return pageRows.Select(row => new Dictionary<string, object>
            {
                { "orderKey", new Dictionary<string, object>
                    {
                        { "documentKey", row.DocumentKey },
                        { "linkPlacementKey", row.PlacementKey },
                        { "nodeKind", row.NodeKind },
                        { "stableSourceIdentity", row.StableSourceIdentity }
                    }
                },
                { row.IsNode ? "node" : "omission", row.Payload }
            }).ToList();
        }

        private static string BuildPageHash(string captureId, int pageOrdinal, string priorPageHash, IList<Dictionary<string, object>> pageRows)
        {
            Dictionary<string, object> envelope = new Dictionary<string, object>
            {
                { "captureId", captureId },
                { "pageOrdinal", pageOrdinal },
                { "priorPageHash", priorPageHash },
                { "rows", pageRows }
            };
            return SpatialSnapshotHelpers.Sha256(SpatialSnapshotHelpers.SemanticCanonicalJson(envelope));
        }

        private static int GetCanonicalRowByteCount(SpatialRow row)
        {
            if (row.CanonicalByteCount > 0) return row.CanonicalByteCount;
            row.CanonicalByteCount = Encoding.UTF8.GetByteCount(SpatialSnapshotHelpers.SemanticCanonicalJson(BuildCanonicalPageRows(new[] { row })[0]));
            return row.CanonicalByteCount;
        }

        private static bool TryResolveContinuationBoundary(
            IList<SpatialRow> rows,
            int targetBytes,
            string captureId,
            int requestedStartIndex,
            out int pageOrdinal,
            out string priorPageHash)
        {
            pageOrdinal = 0;
            priorPageHash = null;
            int index = 0;
            while (index < rows.Count)
            {
                List<SpatialRow> page = PackPage(rows, index, targetBytes, new List<string>());
                if (page.Count == 0) return false;
                string pageHash = BuildPageHash(captureId, pageOrdinal, priorPageHash, BuildCanonicalPageRows(page));
                index += page.Count;
                pageOrdinal++;
                priorPageHash = pageHash;
                if (index == requestedStartIndex) return true;
                if (index > requestedStartIndex) return false;
            }
            return requestedStartIndex == rows.Count && rows.Count > 0;
        }

        private static int CountPages(IList<SpatialRow> rows, int targetBytes)
        {
            if (rows.Count == 0) return 1;
            int pages = 0;
            int index = 0;
            while (index < rows.Count)
            {
                int payloadBytes = 2;
                int pageRows = 0;
                while (index < rows.Count)
                {
                    SpatialRow row = rows[index];
                    int rowBytes = GetCanonicalRowByteCount(row);
                    int additionalBytes = rowBytes + (pageRows > 0 ? 1 : 0);
                    if (pageRows > 0 && payloadBytes + additionalBytes > targetBytes) break;
                    if (pageRows == 0 && payloadBytes + additionalBytes > targetBytes)
                    {
                        throw new InvalidOperationException("A canonical spatial row exceeds pageTargetBytes while counting pages.");
                    }
                    payloadBytes += additionalBytes;
                    pageRows++;
                    index++;
                }
                pages++;
            }
            return pages;
        }

        private static long ComputeTotalPayloadBytes(IList<SpatialRow> rows, int targetBytes)
        {
            if (rows.Count == 0) return 2;
            long totalBytes = 0;
            int index = 0;
            while (index < rows.Count)
            {
                int pageBytes = 2;
                int pageRows = 0;
                while (index < rows.Count)
                {
                    int rowBytes = GetCanonicalRowByteCount(rows[index]);
                    int additionalBytes = rowBytes + (pageRows > 0 ? 1 : 0);
                    if (pageRows > 0 && pageBytes + additionalBytes > targetBytes) break;
                    if (pageRows == 0 && pageBytes + additionalBytes > targetBytes)
                    {
                        throw new InvalidOperationException("A canonical spatial row exceeds pageTargetBytes while totaling payload bytes.");
                    }
                    pageBytes += additionalBytes;
                    pageRows++;
                    index++;
                }
                totalBytes += pageBytes;
            }
            return totalBytes;
        }

        private object BuildScanPolicy(SpatialSnapshotRequest request = null)
        {
            SpatialSnapshotRequest policyRequest = request ?? _request ?? new SpatialSnapshotRequest();
            return new Dictionary<string, object>
            {
                { "levelScopeRequired", true },
                { "maxElements", policyRequest.MaxElements },
                { "maxElapsedMs", Math.Max(250, Math.Min(5000, policyRequest.MaxElapsedMs)) },
                { "pageTargetBytes", policyRequest.PageTargetBytes },
                { "pagePayloadBasis", "canonical_ieee754_rows_utf8_v1" },
                { "hardPageCap", true },
                { "maxGeometryPointsPerElement", policyRequest.MaxGeometryPointsPerElement },
                { "maxBoundarySegmentsPerElement", policyRequest.MaxBoundarySegmentsPerElement },
                { "ordering", new[] { "documentKey", "linkPlacement", "nodeKind", "stableSourceIdentity" } },
                { "selectionAndFilteringBeforeMaxElements", true },
                { "coordinateFrame", SpatialSnapshotHelpers.CoordinateFrame },
                { "cursorVersion", SpatialSnapshotHelpers.CursorVersion },
                { "cursorIntegrity", "hmac_sha256_process_session" },
                { "cursorInvalidAfterRestart", true },
                { "sequenceBound", true },
                { "maxUiOccupancyMs", 5000 },
                { "readOnly", true },
                { "transactionOpened", false }
            };
        }

        private static List<string> BuildSuggestedNextScopes(bool hasMore, SpatialExtractionState extraction)
        {
            List<string> suggestions = new List<string>();
            if (hasMore) suggestions.Add("Pass page.nextCursor unchanged to request the next deterministic page.");
            if (extraction.BudgetStopped)
            {
                suggestions.Add("Narrow to one exact level and, for links, explicit linkInstanceIds/linkInstanceUniqueIds.");
                suggestions.Add("Split hostOnly and linkedOnly captures if the bounded element/time budget is reached.");
            }
            return suggestions;
        }

        private SpatialSnapshotResult BuildGuarded(string reason, string message, Stopwatch stopwatch, List<string> warnings, List<string> notices)
        {
            return new SpatialSnapshotResult
            {
                Success = true,
                Guarded = true,
                State = "guarded",
                Action = "extract_spatial_snapshot",
                Reason = reason,
                Message = message,
                SchemaVersion = SpatialSnapshotHelpers.SchemaVersion,
                ExtractorVersion = SpatialSnapshotHelpers.ExtractorVersion,
                CoordinateFrame = SpatialSnapshotHelpers.CoordinateFrame,
                LengthUnit = "mm",
                Atomic = false,
                Liveness = "staging",
                CaptureConsistency = SpatialSnapshotHelpers.CaptureConsistency,
                RevisionBasisCaveat = SpatialSnapshotHelpers.Phase1aCaveat,
                Nodes = new List<Dictionary<string, object>>(),
                Omissions = new List<Dictionary<string, object>>(),
                Partial = true,
                ScanStoppedReason = reason == "needs_scope" ? "needs_scope" : "read_failed",
                ScanPolicy = BuildScanPolicy(),
                SuggestedNextScopes = new List<string> { "Provide an exact host levelId or exact levelName and restart without cursor." },
                ElapsedMs = stopwatch.ElapsedMilliseconds,
                Warnings = warnings,
                Notices = notices
            };
        }

        private SpatialSnapshotResult BuildCursorGuarded(string reason, string message, Stopwatch stopwatch, List<string> warnings, List<string> notices, object scope, object effectiveSourcePolicy, string scopeFingerprint, string revisionFingerprint, object sourceRevisions)
        {
            SpatialSnapshotResult result = BuildGuarded(reason, message, stopwatch, warnings, notices);
            result.Scope = scope;
            result.EffectiveSourcePolicy = effectiveSourcePolicy;
            result.ScopeFingerprint = scopeFingerprint;
            result.RevisionFingerprint = revisionFingerprint;
            result.SourceRevisions = sourceRevisions;
            result.SuggestedNextScopes = new List<string> { "Omit cursor and start a new sequence-bound capture for the current bounded scope." };
            return result;
        }

        private SpatialSnapshotResult BuildFailed(string error, Stopwatch stopwatch, List<string> warnings, List<string> notices)
        {
            return new SpatialSnapshotResult
            {
                Success = false,
                Guarded = false,
                State = "failed",
                Action = "extract_spatial_snapshot",
                Error = error,
                SchemaVersion = SpatialSnapshotHelpers.SchemaVersion,
                ExtractorVersion = SpatialSnapshotHelpers.ExtractorVersion,
                CoordinateFrame = SpatialSnapshotHelpers.CoordinateFrame,
                LengthUnit = "mm",
                Atomic = false,
                Liveness = "staging",
                CaptureConsistency = SpatialSnapshotHelpers.CaptureConsistency,
                RevisionBasisCaveat = SpatialSnapshotHelpers.Phase1aCaveat,
                Nodes = new List<Dictionary<string, object>>(),
                Omissions = new List<Dictionary<string, object>>(),
                Partial = true,
                ScanStoppedReason = "read_failed",
                ScanPolicy = BuildScanPolicy(),
                SuggestedNextScopes = new List<string>(),
                ElapsedMs = stopwatch.ElapsedMilliseconds,
                Warnings = warnings,
                Notices = notices
            };
        }

        private void Complete(SpatialSnapshotResult result)
        {
            ResultInfo = result;
            TaskCompleted = true;
            _resetEvent.Set();
        }

        public string GetName()
        {
            return "Extract sequence-bound Phase 1a spatial snapshot page";
        }
    }
}
