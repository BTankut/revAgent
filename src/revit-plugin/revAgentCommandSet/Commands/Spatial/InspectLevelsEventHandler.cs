using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPSDK.API.Interfaces;
using RevAgentCommandSet.Extensions;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Threading;

namespace RevAgentCommandSet.Commands.Spatial
{
    public class InspectLevelsRequest
    {
        public string SourceScope { get; set; }
        public List<int> LinkInstanceIds { get; set; }
        public List<string> LinkInstanceUniqueIds { get; set; }
        public string NameQuery { get; set; }
        public string NameMatchMode { get; set; }
        public int MaxResults { get; set; }
        public int TimeoutMs { get; set; }
    }

    public class InspectLevelsResult
    {
        public bool Success { get; set; }
        public bool Guarded { get; set; }
        public string State { get; set; }
        public string Action { get; set; }
        public string Reason { get; set; }
        public string Message { get; set; }
        public string Error { get; set; }
        public string SourceScope { get; set; }
        public string NameQuery { get; set; }
        public string NameMatchMode { get; set; }
        public string LengthUnit { get; set; }
        public string HostCoordinateFrame { get; set; }
        public int MaxResults { get; set; }
        public int EffectiveSourceCount { get; set; }
        public int SelectedLinkCount { get; set; }
        public int LoadedSelectedLinkCount { get; set; }
        public int UnavailableSourceCount { get; set; }
        public int ScannedLevelCount { get; set; }
        public int MatchedLevelCount { get; set; }
        public int ReturnedCount { get; set; }
        public bool Truncated { get; set; }
        public bool Partial { get; set; }
        public string ScanStoppedReason { get; set; }
        public object ScanPolicy { get; set; }
        public List<string> SuggestedNextScopes { get; set; }
        public int? LastReadItemId { get; set; }
        public double ElapsedMs { get; set; }
        public List<Dictionary<string, object>> Levels { get; set; }
        public List<string> Warnings { get; set; }
        public List<string> Notices { get; set; }
    }

    internal class InspectLevelRow
    {
        public int SourceSortOrder;
        public string SourceKind;
        public string DocumentKey;
        public string DocumentSessionId;
        public int LevelId;
        public string LevelUniqueId;
        public string Name;
        public double SourceProjectElevationMm;
        public string SourceProjectElevationFrame;
        public double HostElevationMm;
        public string HostElevationFrame;
        public string HostElevationTransformBasis;
        public int? LinkInstanceId;
        public string LinkInstanceUniqueId;
        public Dictionary<string, object> LinkedSourceLevelSelector;

        public Dictionary<string, object> ToRecord()
        {
            return new Dictionary<string, object>
            {
                { "sourceKind", SourceKind },
                { "documentKey", DocumentKey },
                { "documentSessionId", DocumentSessionId },
                { "levelId", LevelId },
                { "levelUniqueId", LevelUniqueId },
                { "name", Name },
                { "sourceProjectElevationMm", SourceProjectElevationMm },
                { "sourceProjectElevationFrame", SourceProjectElevationFrame },
                { "hostElevationMm", HostElevationMm },
                { "hostElevationFrame", HostElevationFrame },
                { "hostElevationTransformBasis", HostElevationTransformBasis },
                { "linkInstanceId", LinkInstanceId },
                { "linkInstanceUniqueId", LinkInstanceUniqueId },
                { "linkedSourceLevelSelector", LinkedSourceLevelSelector }
            };
        }
    }

    public class InspectLevelsEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double FeetToMillimetres = 304.8;
        private static readonly List<string> DeterministicSortBasis = new List<string>
        {
            "sourceKind(host_before_link)",
            "linkInstanceUniqueId(ordinal)",
            "linkInstanceId",
            "sourceProjectElevationMm",
            "name(ordinal)",
            "levelUniqueId(ordinal)",
            "levelId"
        };

        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);
        private InspectLevelsRequest _request;

        public InspectLevelsResult ResultInfo { get; private set; }
        public bool TaskCompleted { get; private set; }

        public void SetRequest(InspectLevelsRequest request)
        {
            _request = request ?? new InspectLevelsRequest();
            if (_request.LinkInstanceIds == null) _request.LinkInstanceIds = new List<int>();
            if (_request.LinkInstanceUniqueIds == null) _request.LinkInstanceUniqueIds = new List<string>();
            if (_request.SourceScope == null) _request.SourceScope = "hostAndLinked";
            if (_request.NameQuery == null) _request.NameQuery = "";
            if (_request.NameMatchMode == null) _request.NameMatchMode = "contains";
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
                UIDocument uiDocument = app.ActiveUIDocument;
                if (uiDocument == null || uiDocument.Document == null)
                {
                    throw new InvalidOperationException("No active Revit document is available.");
                }

                Document hostDocument = uiDocument.Document;
                List<InspectLevelRow> rows = new List<InspectLevelRow>();
                int effectiveSourceCount = 0;
                int selectedLinkCount = 0;
                int loadedSelectedLinkCount = 0;
                HashSet<string> unavailableSources = new HashSet<string>(StringComparer.Ordinal);

                if (!string.Equals(_request.SourceScope, "linkedOnly", StringComparison.Ordinal))
                {
                    effectiveSourceCount++;
                    AddDocumentLevels(hostDocument, Transform.Identity, null, null, rows);
                }

                if (!string.Equals(_request.SourceScope, "hostOnly", StringComparison.Ordinal))
                {
                    AddLinkedLevels(
                        hostDocument,
                        rows,
                        warnings,
                        unavailableSources,
                        ref effectiveSourceCount,
                        ref selectedLinkCount,
                        ref loadedSelectedLinkCount);
                }
                else if (_request.LinkInstanceIds.Count > 0 || _request.LinkInstanceUniqueIds.Count > 0)
                {
                    notices.Add("Link-instance selectors were ignored because sourceScope=hostOnly.");
                }

                List<InspectLevelRow> matchedRows = rows
                    .Where(row => MatchesName(row.Name))
                    .OrderBy(row => row.SourceSortOrder)
                    .ThenBy(row => row.LinkInstanceUniqueId ?? "", StringComparer.Ordinal)
                    .ThenBy(row => row.LinkInstanceId ?? 0)
                    .ThenBy(row => row.SourceProjectElevationMm)
                    .ThenBy(row => row.Name ?? "", StringComparer.Ordinal)
                    .ThenBy(row => row.LevelUniqueId ?? "", StringComparer.Ordinal)
                    .ThenBy(row => row.LevelId)
                    .ToList();

                List<InspectLevelRow> returnedRows = matchedRows.Take(_request.MaxResults).ToList();
                bool truncated = matchedRows.Count > returnedRows.Count;
                bool hasUnavailableSources = unavailableSources.Count > 0;
                bool partial = truncated || hasUnavailableSources;
                string scanStoppedReason = hasUnavailableSources ? "read_failed" : truncated ? "max_items" : "completed";
                List<Dictionary<string, object>> levelRecords = returnedRows.Select(row => row.ToRecord()).ToList();

                Complete(new InspectLevelsResult
                {
                    Success = true,
                    Guarded = false,
                    State = "completed",
                    Action = "inspect_levels",
                    Reason = null,
                    Message = hasUnavailableSources
                        ? "Level inventory is incomplete because one or more selected linked sources were unavailable."
                        : truncated
                            ? "Level inventory was deterministically truncated by maxResults."
                            : "Level inventory collected.",
                    Error = null,
                    SourceScope = _request.SourceScope,
                    NameQuery = _request.NameQuery,
                    NameMatchMode = _request.NameMatchMode,
                    LengthUnit = "mm",
                    HostCoordinateFrame = "host_internal_mm",
                    MaxResults = _request.MaxResults,
                    EffectiveSourceCount = effectiveSourceCount,
                    SelectedLinkCount = selectedLinkCount,
                    LoadedSelectedLinkCount = loadedSelectedLinkCount,
                    UnavailableSourceCount = unavailableSources.Count,
                    ScannedLevelCount = rows.Count,
                    MatchedLevelCount = matchedRows.Count,
                    ReturnedCount = returnedRows.Count,
                    Truncated = truncated,
                    Partial = partial,
                    ScanStoppedReason = scanStoppedReason,
                    ScanPolicy = BuildScanPolicy(),
                    SuggestedNextScopes = BuildSuggestedNextScopes(),
                    LastReadItemId = returnedRows.Count > 0 ? (int?)returnedRows[returnedRows.Count - 1].LevelId : null,
                    ElapsedMs = stopwatch.Elapsed.TotalMilliseconds,
                    Levels = levelRecords,
                    Warnings = warnings,
                    Notices = notices
                });
            }
            catch (Exception ex)
            {
                Complete(new InspectLevelsResult
                {
                    Success = false,
                    Guarded = false,
                    State = "failed",
                    Action = "inspect_levels",
                    Reason = "read_failed",
                    Message = "Level inventory could not be collected.",
                    Error = ex.Message,
                    SourceScope = _request != null ? _request.SourceScope : "hostAndLinked",
                    NameQuery = _request != null ? _request.NameQuery : "",
                    NameMatchMode = _request != null ? _request.NameMatchMode : "contains",
                    LengthUnit = "mm",
                    HostCoordinateFrame = "host_internal_mm",
                    MaxResults = _request != null ? _request.MaxResults : 500,
                    Partial = false,
                    ScanStoppedReason = "read_failed",
                    ScanPolicy = BuildScanPolicy(),
                    SuggestedNextScopes = BuildSuggestedNextScopes(),
                    ElapsedMs = stopwatch.Elapsed.TotalMilliseconds,
                    Levels = new List<Dictionary<string, object>>(),
                    Warnings = warnings,
                    Notices = notices
                });
            }
        }

        private void AddLinkedLevels(
            Document hostDocument,
            List<InspectLevelRow> rows,
            List<string> warnings,
            HashSet<string> unavailableSources,
            ref int effectiveSourceCount,
            ref int selectedLinkCount,
            ref int loadedSelectedLinkCount)
        {
            List<RevitLinkInstance> links;
            using (FilteredElementCollector collector = new FilteredElementCollector(hostDocument))
            {
                links = collector
                    .OfClass(typeof(RevitLinkInstance))
                    .WhereElementIsNotElementType()
                    .Cast<RevitLinkInstance>()
                    .OrderBy(link => SafeUniqueId(link), StringComparer.Ordinal)
                    .ThenBy(link => link.Id.GetIdValue())
                    .ToList();
            }

            HashSet<int> foundIds = new HashSet<int>();
            HashSet<string> foundUniqueIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (RevitLinkInstance link in links)
            {
                int linkInstanceId = link.Id.GetIdValue();
                string linkInstanceUniqueId = SafeUniqueId(link);
                if (!MatchesLinkSelector(linkInstanceId, linkInstanceUniqueId)) continue;

                selectedLinkCount++;
                foundIds.Add(linkInstanceId);
                if (linkInstanceUniqueId.Length > 0) foundUniqueIds.Add(linkInstanceUniqueId);
                if (linkInstanceUniqueId.Length == 0)
                {
                    unavailableSources.Add("link-instance-id:" + linkInstanceId.ToString(CultureInfo.InvariantCulture));
                    warnings.Add("Selected link instance " + linkInstanceId.ToString(CultureInfo.InvariantCulture) + " has no readable UniqueId; copy-ready linked level selectors cannot be produced.");
                    continue;
                }

                Document linkedDocument;
                try { linkedDocument = link.GetLinkDocument(); }
                catch (Exception ex)
                {
                    unavailableSources.Add("link:" + linkInstanceUniqueId);
                    warnings.Add("Failed to read selected link " + LinkLabel(linkInstanceId, linkInstanceUniqueId) + ": " + ex.Message);
                    continue;
                }
                if (linkedDocument == null)
                {
                    unavailableSources.Add("link:" + linkInstanceUniqueId);
                    warnings.Add("Selected link " + LinkLabel(linkInstanceId, linkInstanceUniqueId) + " is unloaded or inaccessible.");
                    continue;
                }
                loadedSelectedLinkCount++;

                Transform sourceToHost;
                try { sourceToHost = link.GetTransform(); }
                catch (Exception ex)
                {
                    unavailableSources.Add("link:" + linkInstanceUniqueId);
                    warnings.Add("Failed to read transform for selected link " + LinkLabel(linkInstanceId, linkInstanceUniqueId) + ": " + ex.Message);
                    continue;
                }

                effectiveSourceCount++;
                try
                {
                    AddDocumentLevels(linkedDocument, sourceToHost, linkInstanceId, linkInstanceUniqueId, rows);
                }
                catch (Exception ex)
                {
                    effectiveSourceCount--;
                    unavailableSources.Add("link:" + linkInstanceUniqueId);
                    warnings.Add("Failed to inspect Levels in selected link " + LinkLabel(linkInstanceId, linkInstanceUniqueId) + ": " + ex.Message);
                }
            }

            foreach (int requestedId in _request.LinkInstanceIds.Where(id => !foundIds.Contains(id)))
            {
                unavailableSources.Add("requested-link-id:" + requestedId.ToString(CultureInfo.InvariantCulture));
                warnings.Add("Requested linkInstanceId was not found: " + requestedId.ToString(CultureInfo.InvariantCulture) + ".");
            }
            foreach (string requestedUniqueId in _request.LinkInstanceUniqueIds.Where(id => !foundUniqueIds.Contains(id)))
            {
                unavailableSources.Add("requested-link-uid:" + requestedUniqueId);
                warnings.Add("Requested linkInstanceUniqueId was not found: " + requestedUniqueId + ".");
            }
        }

        private void AddDocumentLevels(
            Document sourceDocument,
            Transform sourceToHost,
            int? linkInstanceId,
            string linkInstanceUniqueId,
            List<InspectLevelRow> rows)
        {
            List<Level> levels;
            using (FilteredElementCollector collector = new FilteredElementCollector(sourceDocument))
            {
                levels = collector.OfClass(typeof(Level)).Cast<Level>().ToList();
            }

            bool isHost = !linkInstanceId.HasValue;
            DocumentIdentity documentIdentity = SpatialSnapshotHelpers.ResolveDocumentIdentity(sourceDocument);
            List<InspectLevelRow> sourceRows = new List<InspectLevelRow>();
            foreach (Level level in levels)
            {
                double sourceProjectElevation = SpatialSnapshotHelpers.GetProjectElevationFeet(level);
                XYZ hostLevelPoint = sourceToHost.OfPoint(new XYZ(0, 0, sourceProjectElevation));
                string levelUniqueId = SafeUniqueId(level);
                string levelName = SafeName(level);
                sourceRows.Add(new InspectLevelRow
                {
                    SourceSortOrder = isHost ? 0 : 1,
                    SourceKind = isHost ? "host" : "link",
                    DocumentKey = documentIdentity.DocumentKey,
                    DocumentSessionId = documentIdentity.DocumentSessionId,
                    LevelId = level.Id.GetIdValue(),
                    LevelUniqueId = levelUniqueId,
                    Name = levelName,
                    SourceProjectElevationMm = RoundMm(sourceProjectElevation * FeetToMillimetres),
                    SourceProjectElevationFrame = isHost ? "host_internal_mm" : "linked_document_internal_mm",
                    HostElevationMm = RoundMm(hostLevelPoint.Z * FeetToMillimetres),
                    HostElevationFrame = "host_internal_mm",
                    HostElevationTransformBasis = isHost
                        ? "host_identity_source_origin_project_elevation_point"
                        : "revit_link_instance_get_transform_source_origin_project_elevation_point",
                    LinkInstanceId = linkInstanceId,
                    LinkInstanceUniqueId = linkInstanceUniqueId,
                    LinkedSourceLevelSelector = isHost
                        ? null
                        : new Dictionary<string, object>
                        {
                            { "linkInstanceUniqueId", linkInstanceUniqueId },
                            { "levelId", level.Id.GetIdValue() },
                            { "levelUniqueId", levelUniqueId },
                            { "levelName", levelName }
                        }
                });
            }
            rows.AddRange(sourceRows);
        }

        private bool MatchesLinkSelector(int linkInstanceId, string linkInstanceUniqueId)
        {
            if (_request.LinkInstanceIds.Count == 0 && _request.LinkInstanceUniqueIds.Count == 0) return true;
            return _request.LinkInstanceIds.Contains(linkInstanceId) ||
                   _request.LinkInstanceUniqueIds.Contains(linkInstanceUniqueId, StringComparer.Ordinal);
        }

        private bool MatchesName(string name)
        {
            if (string.IsNullOrWhiteSpace(_request.NameQuery)) return true;
            if (string.Equals(_request.NameMatchMode, "exact", StringComparison.Ordinal))
            {
                return string.Equals(name, _request.NameQuery, StringComparison.OrdinalIgnoreCase);
            }
            return (name ?? "").IndexOf(_request.NameQuery, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private object BuildScanPolicy()
        {
            return new
            {
                sourceScope = _request != null ? _request.SourceScope : "hostAndLinked",
                linkInstanceSelectorMode = "exact_id_or_unique_id",
                nameMatchMode = _request != null ? _request.NameMatchMode : "contains",
                maxResults = _request != null ? _request.MaxResults : 500,
                deterministicSortBasis = DeterministicSortBasis,
                maxResultsAppliedAfterDeterministicSort = true
            };
        }

        private static List<string> BuildSuggestedNextScopes()
        {
            return new List<string>
            {
                "sourceScope",
                "linkInstanceIds",
                "linkInstanceUniqueIds",
                "nameQuery",
                "nameMatchMode",
                "maxResults"
            };
        }

        private static string SafeUniqueId(Element element)
        {
            try { return element != null ? element.UniqueId ?? "" : ""; }
            catch { return ""; }
        }

        private static string SafeName(Element element)
        {
            try { return element != null ? element.Name ?? "" : ""; }
            catch { return ""; }
        }

        private static string LinkLabel(int id, string uniqueId)
        {
            return !string.IsNullOrWhiteSpace(uniqueId)
                ? uniqueId
                : "link-instance-id:" + id.ToString(CultureInfo.InvariantCulture);
        }

        private static double RoundMm(double value)
        {
            return Math.Round(value, 6, MidpointRounding.AwayFromZero);
        }

        private void Complete(InspectLevelsResult result)
        {
            ResultInfo = result;
            TaskCompleted = true;
            _resetEvent.Set();
        }

        public string GetName()
        {
            return "InspectLevelsEventHandler";
        }
    }
}
