using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json;
using RevitMCPSDK.API.Interfaces;
using RevAgentCommandSet.Extensions;
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
            SpatialExtractionState extraction = new SpatialExtractionState();
            List<string> warnings = new List<string>();
            List<string> notices = new List<string> { SpatialSnapshotHelpers.Phase0Caveat };
            List<SpatialRow> rows = new List<SpatialRow>();
            List<SpatialSource> sources = new List<SpatialSource>();
            CursorEnvelope cursor;
            string cursorError;

            try
            {
                if (!SpatialSnapshotHelpers.TryDecodeCursor(_request.Cursor, out cursor, out cursorError))
                {
                    Complete(BuildGuarded("invalid_cursor", "The continuation cursor could not be decoded: " + cursorError, stopwatch, warnings, notices));
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

                DocumentIdentity hostIdentity = SpatialSnapshotHelpers.ResolveDocumentIdentity(hostDocument);

                List<LevelBand> bands = SpatialSnapshotHelpers.ResolveLevelBands(hostDocument, _request, warnings);
                if (bands.Count == 0)
                {
                    Complete(BuildGuarded("needs_scope", "None of the requested levelIds/levelNames resolved in the active host document.", stopwatch, warnings, notices));
                    return;
                }

                DateTime deadlineUtc = DateTime.UtcNow.AddMilliseconds(_request.MaxElapsedMs);
                ResolveSources(hostDocument, hostIdentity, sources, rows, extraction, warnings);
                extraction.SourceCount = sources.Count;
                Dictionary<string, object> scope = SpatialSnapshotHelpers.BuildScope(_request, bands, hostDocument, hostIdentity);
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

                List<SpatialCandidate> candidates;
                if (TryDiscoverAndFilterCandidates(sources, bands, rows, extraction, deadlineUtc, warnings, out candidates))
                {
                    ExtractCandidates(candidates, rows, extraction, deadlineUtc, warnings);
                }

                List<SpatialRow> orderedRows = rows
                    .OrderBy(row => row.DocumentKey, StringComparer.Ordinal)
                    .ThenBy(row => row.PlacementKey, StringComparer.Ordinal)
                    .ThenBy(row => row.NodeKind, StringComparer.Ordinal)
                    .ThenBy(row => row.StableSourceIdentity, StringComparer.Ordinal)
                    .ToList();

                foreach (SpatialSource source in sources)
                {
                    string prefix = source.Identity.DocumentKey + "\u001f" + source.PlacementKey + "\u001f";
                    source.ContentFingerprint = SpatialSnapshotHelpers.Sha256(string.Join("\n", orderedRows
                        .Where(row => row.SortKey.StartsWith(prefix, StringComparison.Ordinal))
                        .Select(row => row.SortKey + "|" + row.PayloadFingerprint)));
                }

                List<Dictionary<string, object>> sourceRevisions = BuildSourceRevisions(sources, extraction);
                string revisionFingerprint = BuildRevisionFingerprint(sourceRevisions, orderedRows);

                if (cursor != null && !string.Equals(cursor.ScopeFingerprint, scopeFingerprint, StringComparison.Ordinal))
                {
                    Complete(BuildCursorGuarded("cursor_scope_mismatch", "The cursor was created for a different spatial scope. Start a new capture without cursor.", stopwatch, warnings, notices, scope, effectiveSourcePolicy, scopeFingerprint, revisionFingerprint, sourceRevisions));
                    return;
                }
                if (cursor != null && !string.Equals(cursor.RevisionFingerprint, revisionFingerprint, StringComparison.Ordinal))
                {
                    Complete(BuildCursorGuarded("cursor_revision_mismatch", "The bounded Phase 0 revision fingerprint changed between pages. Start a new capture; this spike cannot guarantee an atomic/current multi-page result.", stopwatch, warnings, notices, scope, effectiveSourcePolicy, scopeFingerprint, revisionFingerprint, sourceRevisions));
                    return;
                }

                int pageOrdinal = cursor != null ? cursor.PageOrdinal : 0;
                string captureId = cursor != null ? cursor.CaptureId : Guid.NewGuid().ToString("N");
                string capturedAt = cursor != null && !string.IsNullOrWhiteSpace(cursor.CapturedAt)
                    ? cursor.CapturedAt
                    : DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
                string priorPageHash = cursor != null ? cursor.PriorPageHash : null;
                int startIndex = 0;
                if (cursor != null)
                {
                    string cursorSortKey = SpatialSnapshotHelpers.BuildSortKey(cursor.SortPosition.DocumentKey, cursor.SortPosition.LinkPlacementKey, cursor.SortPosition.NodeKind, cursor.SortPosition.StableSourceIdentity);
                    int exactIndex = orderedRows.FindIndex(row => string.Equals(row.SortKey, cursorSortKey, StringComparison.Ordinal));
                    if (exactIndex < 0)
                    {
                        Complete(BuildCursorGuarded("invalid_cursor_sort_position", "The cursor sort position is not present in the revision-bound extraction. Start a new capture.", stopwatch, warnings, notices, scope, effectiveSourcePolicy, scopeFingerprint, revisionFingerprint, sourceRevisions));
                        return;
                    }
                    startIndex = exactIndex + 1;
                    int expectedOrdinal;
                    string expectedPriorPageHash;
                    if (!TryResolveContinuationBoundary(orderedRows, _request.PageTargetBytes, cursor.CaptureId, startIndex, out expectedOrdinal, out expectedPriorPageHash) ||
                        cursor.PageOrdinal != expectedOrdinal || !string.Equals(cursor.PriorPageHash, expectedPriorPageHash, StringComparison.Ordinal))
                    {
                        Complete(BuildCursorGuarded("invalid_cursor_chain", "The signed cursor ordinal, page boundary, or prior-page hash does not match the deterministic page chain.", stopwatch, warnings, notices, scope, effectiveSourcePolicy, scopeFingerprint, revisionFingerprint, sourceRevisions));
                        return;
                    }
                }

                List<SpatialRow> pageRows = PackPage(orderedRows, startIndex, _request.PageTargetBytes, warnings);
                int nextIndex = startIndex + pageRows.Count;
                bool hasMore = nextIndex < orderedRows.Count;
                List<Dictionary<string, object>> nodes = pageRows.Where(row => row.IsNode).Select(row => row.Payload).ToList();
                List<Dictionary<string, object>> omissions = pageRows.Where(row => !row.IsNode).Select(row => row.Payload).ToList();
                List<Dictionary<string, object>> canonicalPageRows = BuildCanonicalPageRows(pageRows);
                string pageHash = BuildPageHash(captureId, pageOrdinal, priorPageHash, canonicalPageRows);
                int payloadBytes = Encoding.UTF8.GetByteCount(SpatialSnapshotHelpers.SemanticCanonicalJson(canonicalPageRows));
                long totalPayloadBytes = ComputeTotalPayloadBytes(orderedRows, _request.PageTargetBytes);
                int totalPageCount = CountPages(orderedRows, _request.PageTargetBytes);
                string nextCursor = null;
                if (hasMore && pageRows.Count > 0)
                {
                    nextCursor = SpatialSnapshotHelpers.EncodeCursor(new CursorEnvelope
                    {
                        CursorVersion = SpatialSnapshotHelpers.CursorVersion,
                        CaptureId = captureId,
                        PageOrdinal = pageOrdinal + 1,
                        SortPosition = new CursorSortPosition
                        {
                            DocumentKey = pageRows[pageRows.Count - 1].DocumentKey,
                            LinkPlacementKey = pageRows[pageRows.Count - 1].PlacementKey,
                            NodeKind = pageRows[pageRows.Count - 1].NodeKind,
                            StableSourceIdentity = pageRows[pageRows.Count - 1].StableSourceIdentity
                        },
                        PriorPageHash = pageHash,
                        RevisionFingerprint = revisionFingerprint,
                        ScopeFingerprint = scopeFingerprint,
                        CapturedAt = capturedAt
                    });
                }

                bool hasCoverageGaps = extraction.OmittedElementCount > 0 || extraction.SourceAvailabilityOmissionCount > 0;
                bool partial = hasMore || extraction.BudgetStopped || hasCoverageGaps;
                string stoppedReason = extraction.BudgetStopped ? extraction.ScanStoppedReason : hasMore ? "max_bytes" : hasCoverageGaps ? "read_failed" : "completed";
                SpatialRow lastRead = pageRows.Count > 0 ? pageRows[pageRows.Count - 1] : null;
                if (lastRead != null)
                {
                    extraction.LastReadDocumentKey = lastRead.DocumentKey;
                    extraction.LastReadLinkInstanceUniqueId = string.Equals(lastRead.PlacementKey, "host", StringComparison.Ordinal) ? null : lastRead.PlacementKey;
                    extraction.LastReadNodeKind = lastRead.NodeKind;
                    extraction.LastReadItemId = lastRead.ElementId;
                }

                double coverageRatio = !extraction.SelectionComplete
                    ? 0.0
                    : extraction.EligibleElementCount == 0
                        ? 1.0
                        : (double)extraction.ExtractedNodeCount / extraction.EligibleElementCount;
                int classifiedOmissions = extraction.OmittedByClassification.Values.Sum() + extraction.SourceOmittedByClassification.Values.Sum();
                Dictionary<string, object> page = new Dictionary<string, object>
                {
                    { "ordinal", pageOrdinal },
                    { "targetBytes", _request.PageTargetBytes },
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

                Complete(new SpatialSnapshotResult
                {
                    Success = true,
                    Guarded = false,
                    State = "completed",
                    Action = "extract_spatial_snapshot",
                    Message = partial ? "A bounded Phase 0 spatial extraction page was produced with explicit continuation/partial state." : "The complete bounded Phase 0 spatial extraction was produced in this page.",
                    SchemaVersion = SpatialSnapshotHelpers.SchemaVersion,
                    ExtractorVersion = SpatialSnapshotHelpers.ExtractorVersion,
                    CoordinateFrame = SpatialSnapshotHelpers.CoordinateFrame,
                    LengthUnit = "mm",
                    CaptureId = captureId,
                    SnapshotId = captureId,
                    CapturedAt = capturedAt,
                    Atomic = false,
                    Liveness = "unknown",
                    RevisionBasisCaveat = SpatialSnapshotHelpers.Phase0Caveat,
                    Scope = scope,
                    EffectiveSourcePolicy = effectiveSourcePolicy,
                    SourceRevisions = sourceRevisions,
                    ScopeFingerprint = scopeFingerprint,
                    RevisionFingerprint = revisionFingerprint,
                    Nodes = nodes,
                    Omissions = omissions,
                    Counts = new Dictionary<string, object>
                    {
                        { "totalNodes", extraction.ExtractedNodeCount },
                        { "nodesByKind", new Dictionary<string, object>
                            {
                                { "revit_element", extraction.ExtractedNodeCount },
                                { "connector", 0 },
                                { "derived", 0 }
                            }
                        },
                        { "expectedSupportedNodes", extraction.EligibleElementCount },
                        { "extractedSupportedNodes", extraction.ExtractedNodeCount },
                        { "omittedSupportedNodes", extraction.OmittedElementCount },
                        { "omissionsByReason", extraction.OmittedByClassification }
                    },
                    Coverage = new Dictionary<string, object>
                    {
                        { "sourceCount", extraction.SourceCount },
                        { "selectedLinkCount", extraction.SelectedLinkCount },
                        { "loadedLinkCount", extraction.LoadedLinkCount },
                        { "unloadedLinkCount", extraction.UnloadedLinkCount },
                        { "scannedElementCount", extraction.ScannedElementCount },
                        { "filteredOutOfScopeCount", extraction.FilteredOutOfScopeCount },
                        { "sourceAvailabilityOmissionCount", extraction.SourceAvailabilityOmissionCount },
                        { "totalOrderedRowCount", orderedRows.Count },
                        { "pageNodeCount", nodes.Count },
                        { "pageOmissionCount", omissions.Count },
                        { "eligibleByCategory", extraction.EligibleByCategory },
                        { "extractedByCategory", extraction.ExtractedByCategory },
                        { "omittedByClassification", extraction.OmittedByClassification },
                        { "sourceOmittedByClassification", extraction.SourceOmittedByClassification },
                        { "classifiedOmissionCount", classifiedOmissions },
                        { "effectiveScope", hasEffectiveSourcePolicy },
                        { "selectionComplete", extraction.SelectionComplete },
                        { "allEligibleOmissionsClassified", extraction.SelectionComplete && classifiedOmissions == extraction.OmittedElementCount + extraction.SourceAvailabilityOmissionCount },
                        { "extractionCoverageRatio", Math.Round(coverageRatio, 6, MidpointRounding.AwayFromZero) },
                        { "phase0TargetAtLeast0_995", extraction.SelectionComplete && coverageRatio >= 0.995 && !extraction.BudgetStopped && extraction.SourceAvailabilityOmissionCount == 0 },
                        { "complete", extraction.SelectionComplete && !partial && classifiedOmissions == extraction.OmittedElementCount + extraction.SourceAvailabilityOmissionCount }
                    },
                    TransformValidation = new Dictionary<string, object>
                    {
                        { "transformCount", extraction.TransformCount },
                        { "validatedCount", extraction.TransformCount - extraction.TransformValidationFailureCount },
                        { "failedCount", extraction.TransformValidationFailureCount },
                        { "maxRoundTripErrorMm", extraction.TransformCount > 0 ? (object)Math.Round(extraction.MaxTransformRoundTripErrorMm, 6, MidpointRounding.AwayFromZero) : null },
                        { "allWithin0_5mm", extraction.TransformValidationFailureCount == 0 }
                    },
                    Page = page,
                    PageCount = totalPageCount,
                    PayloadBytes = totalPayloadBytes,
                    NextCursor = nextCursor,
                    Partial = partial,
                    ScanStoppedReason = stoppedReason,
                    ScanPolicy = BuildScanPolicy(),
                    SuggestedNextScopes = BuildSuggestedNextScopes(hasMore, extraction),
                    ElapsedMs = stopwatch.ElapsedMilliseconds,
                    LastReadDocumentKey = extraction.LastReadDocumentKey,
                    LastReadLinkInstanceUniqueId = extraction.LastReadLinkInstanceUniqueId,
                    LastReadNodeKind = extraction.LastReadNodeKind,
                    LastReadItemId = extraction.LastReadItemId,
                    Warnings = warnings,
                    Notices = notices
                });
            }
            catch (Exception ex)
            {
                Complete(BuildFailed(ex.Message, stopwatch, warnings, notices));
            }
        }

        private void ResolveSources(Document hostDocument, DocumentIdentity hostIdentity, List<SpatialSource> sources, List<SpatialRow> rows, SpatialExtractionState state, List<string> warnings)
        {
            if (!hostIdentity.CrossSessionStable)
            {
                warnings.Add("The host document identity is session-only or otherwise not cross-session comparable; node identity is valid for this open-document session only.");
            }
            sources.Add(new SpatialSource
            {
                Document = hostDocument,
                LinkInstance = null,
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
                DocumentIdentity linkIdentity = SpatialSnapshotHelpers.ResolveDocumentIdentity(linkDocument);
                if (!linkIdentity.CrossSessionStable)
                {
                    warnings.Add("Linked source identity is not cross-session comparable for placement " + linkUniqueId + "; its node identity is session-scoped.");
                }
                sources.Add(new SpatialSource
                {
                    Document = linkDocument,
                    LinkInstance = link,
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
                    AddSourceOmission(rows, source.Identity.DocumentKey, source.PlacementKey, "source_collector_failed", ex.Message, source.LinkInstance != null ? (int?)source.LinkInstance.Id.GetIdValue() : null, state);
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
                        out candidate.LevelId);
                }
                catch (Exception ex)
                {
                    candidate.ScopeClassification = "scope_read_failed";
                    candidate.LevelName = null;
                    candidate.LevelId = null;
                    warnings.Add("Element scope read failed for " + candidate.StableSourceIdentity + ": " + ex.Message);
                }

                if (string.Equals(candidate.ScopeClassification, "out_of_scope", StringComparison.Ordinal))
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
                        ? "Element has neither a resolvable source level nor a readable bounding box for host level-band filtering."
                        : "Element scope could not be read reliably.";
                    AddElementOmission(rows, candidate.Source, candidate.Element, candidate.CategoryName, candidate.ScopeClassification, detail, candidate.LevelName, candidate.LevelId, state, true);
                    continue;
                }

                if (candidate.StableSourceIdentity.StartsWith("element-id:", StringComparison.Ordinal))
                {
                    AddElementOmission(rows, candidate.Source, candidate.Element, candidate.CategoryName, "stable_identity_unavailable", "Element.UniqueId was unavailable; the numeric ElementId is retained only as session evidence and no stable node was emitted.", candidate.LevelName, candidate.LevelId, state, true);
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
                    AddElementOmission(rows, candidate.Source, candidate.Element, candidate.CategoryName, omissionClassification ?? "geometry_unavailable", omissionDetail, candidate.LevelName, candidate.LevelId, state, true);
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

                SpatialRow row = BuildNodeRow(candidate.Source, candidate.Element, candidate.CategoryName, candidate.LevelName, candidate.LevelId, geometry);
                if (GetCanonicalRowByteCount(row) + 2 > _request.PageTargetBytes)
                {
                    AddElementOmission(rows, candidate.Source, candidate.Element, candidate.CategoryName, "row_payload_too_large", "The canonical element row exceeds pageTargetBytes and was replaced with this classified omission.", candidate.LevelName, candidate.LevelId, state, true);
                    continue;
                }
                rows.Add(row);
                state.ExtractedNodeCount++;
                state.Increment(state.ExtractedByCategory, candidate.CategoryName);
            }
        }

        private static SpatialRow BuildNodeRow(SpatialSource source, Element element, string categoryName, string levelName, int? levelId, Dictionary<string, object> geometry)
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
                        { "sourceLevelName", levelName }
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

        private static void AddElementOmission(List<SpatialRow> rows, SpatialSource source, Element element, string categoryName, string classification, string detail, string levelName, int? levelId, SpatialExtractionState state, bool alreadyCountedEligible = false)
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
                { "levelRef", new Dictionary<string, object> { { "sourceLevelId", levelId }, { "sourceLevelName", levelName } } }
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

        private static void AddSourceOmission(List<SpatialRow> rows, string documentKey, string placementKey, string classification, string detail, int? linkInstanceId, SpatialExtractionState state)
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
            string stableIdentity = placementKey + ":" + classification;
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
                    { "changeSequence", 0 },
                    { "changeSequenceState", "unknown_phase0_sentinel" },
                    { "sourceToHostTransform", transform },
                    { "documentKeyResolution", new Dictionary<string, object>
                        {
                            { "resolverVersion", "phase0-document-key/0.1" },
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

        private static string BuildRevisionFingerprint(IList<Dictionary<string, object>> sourceRevisions, IList<SpatialRow> rows)
        {
            StringBuilder text = new StringBuilder();
            text.Append("extractor=").Append(SpatialSnapshotHelpers.ExtractorVersion).Append('\n');
            foreach (Dictionary<string, object> source in sourceRevisions)
            {
                text.Append(SpatialSnapshotHelpers.CanonicalJson(source)).Append('\n');
            }
            foreach (SpatialRow row in rows)
            {
                text.Append(row.SortKey).Append('|').Append(row.PayloadFingerprint).Append('\n');
            }
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
            return Encoding.UTF8.GetByteCount(SpatialSnapshotHelpers.SemanticCanonicalJson(BuildCanonicalPageRows(new[] { row })[0]));
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

        private object BuildScanPolicy()
        {
            return new Dictionary<string, object>
            {
                { "levelScopeRequired", true },
                { "maxElements", _request.MaxElements },
                { "maxElapsedMs", _request.MaxElapsedMs },
                { "pageTargetBytes", _request.PageTargetBytes },
                { "pagePayloadBasis", "canonical_ieee754_rows_utf8_v1" },
                { "hardPageCap", true },
                { "maxGeometryPointsPerElement", _request.MaxGeometryPointsPerElement },
                { "maxBoundarySegmentsPerElement", _request.MaxBoundarySegmentsPerElement },
                { "ordering", new[] { "documentKey", "linkPlacement", "nodeKind", "stableSourceIdentity" } },
                { "selectionAndFilteringBeforeMaxElements", true },
                { "coordinateFrame", SpatialSnapshotHelpers.CoordinateFrame },
                { "cursorVersion", SpatialSnapshotHelpers.CursorVersion },
                { "cursorIntegrity", "hmac_sha256_process_session" },
                { "cursorInvalidAfterRestart", true },
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
                Liveness = "unknown",
                RevisionBasisCaveat = SpatialSnapshotHelpers.Phase0Caveat,
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
            result.SuggestedNextScopes = new List<string> { "Omit cursor and start a new Phase 0 capture for the current bounded revision." };
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
                Liveness = "unknown",
                RevisionBasisCaveat = SpatialSnapshotHelpers.Phase0Caveat,
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
            return "Extract bounded Phase 0 spatial snapshot";
        }
    }
}
