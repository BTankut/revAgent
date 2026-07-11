using Autodesk.Revit.DB;
using System;
using System.Collections.Generic;

namespace RevAgentCommandSet.Commands.Spatial
{
    public class SpatialSnapshotRequest
    {
        public List<int> LevelIds { get; set; }
        public List<string> LevelNames { get; set; }
        public string SourceScope { get; set; }
        public List<int> LinkInstanceIds { get; set; }
        public List<string> LinkInstanceUniqueIds { get; set; }
        public List<LinkedSourceLevelSelector> LinkedSourceLevels { get; set; }
        public List<string> LinkedSourceLevelNames { get; set; }
        public bool IncludeHostMep { get; set; }
        public bool IncludeRoomsSpaces { get; set; }
        public bool IncludeLinkedObstructions { get; set; }
        public double BelowLevelMm { get; set; }
        public double AboveLevelMm { get; set; }
        public string Cursor { get; set; }
        public int PageTargetBytes { get; set; }
        public int MaxElements { get; set; }
        public int MaxElapsedMs { get; set; }
        public int MaxGeometryPointsPerElement { get; set; }
        public int MaxBoundarySegmentsPerElement { get; set; }
        public int TimeoutMs { get; set; }
    }

    public class LinkedSourceLevelSelector
    {
        public string LinkInstanceUniqueId { get; set; }
        public int? LevelId { get; set; }
        public string LevelUniqueId { get; set; }
        public string LevelName { get; set; }
    }

    public class SpatialSnapshotResult
    {
        public bool Success { get; set; }
        public bool Guarded { get; set; }
        public string State { get; set; }
        public string Action { get; set; }
        public string Reason { get; set; }
        public string Message { get; set; }
        public string Error { get; set; }
        public string SchemaVersion { get; set; }
        public string ExtractorVersion { get; set; }
        public string CoordinateFrame { get; set; }
        public string LengthUnit { get; set; }
        public string CaptureId { get; set; }
        public string SnapshotId { get; set; }
        public string CapturedAt { get; set; }
        public bool Atomic { get; set; }
        public string Liveness { get; set; }
        public string RevisionBasisCaveat { get; set; }
        public object Scope { get; set; }
        public object EffectiveSourcePolicy { get; set; }
        public object SourceRevisions { get; set; }
        public string ScopeFingerprint { get; set; }
        public string RevisionFingerprint { get; set; }
        public List<Dictionary<string, object>> Nodes { get; set; }
        public List<Dictionary<string, object>> Omissions { get; set; }
        public object Counts { get; set; }
        public object Coverage { get; set; }
        public object TransformValidation { get; set; }
        public object Page { get; set; }
        public int PageCount { get; set; }
        public long PayloadBytes { get; set; }
        public string NextCursor { get; set; }
        public bool Partial { get; set; }
        public string CoverageStatus { get; set; }
        public string ScanStoppedReason { get; set; }
        public object ScanPolicy { get; set; }
        public List<string> SuggestedNextScopes { get; set; }
        public long ElapsedMs { get; set; }
        public string LastReadDocumentKey { get; set; }
        public string LastReadLinkInstanceUniqueId { get; set; }
        public string LastReadNodeKind { get; set; }
        public int? LastReadItemId { get; set; }
        public List<string> Warnings { get; set; }
        public List<string> Notices { get; set; }
    }

    internal sealed class SpatialSource
    {
        public Document Document;
        public RevitLinkInstance LinkInstance;
        public Transform SourceToHost;
        public DocumentIdentity Identity;
        public string PlacementKey;
        public string ContentFingerprint;
        public bool ExtractElements;

        public bool IsHost
        {
            get { return LinkInstance == null; }
        }
    }

    internal sealed class DocumentIdentity
    {
        public string DocumentKey;
        public string DocumentSessionId;
        public string ResolutionBasis;
        public string FallbackReason;
        public bool CrossSessionStable;
        public string LoadedVersion;
    }

    internal sealed class SpatialRow
    {
        public string SortKey;
        public string DocumentKey;
        public string PlacementKey;
        public string NodeKind;
        public string StableSourceIdentity;
        public int? ElementId;
        public bool IsNode;
        public Dictionary<string, object> Payload;
        public string PayloadFingerprint;
    }

    internal sealed class SpatialCandidate
    {
        public SpatialSource Source;
        public Element Element;
        public string CategoryName;
        public string StableSourceIdentity;
        public string ScopeClassification;
        public string LevelName;
        public int? LevelId;
        public string LevelUniqueId;
    }

    internal sealed class LevelBand
    {
        public int Id;
        public string UniqueId;
        public string Name;
        public double ElevationFeet;
        public double MinHostZFeet;
        public double MaxHostZFeet;
    }

    internal sealed class SpatialExtractionState
    {
        public int SourceCount;
        public int SelectedLinkCount;
        public int LoadedLinkCount;
        public int UnloadedLinkCount;
        public int ScannedElementCount;
        public int EligibleElementCount;
        public int ExtractedNodeCount;
        public int OmittedElementCount;
        public int SourceAvailabilityOmissionCount;
        public int FilteredOutOfScopeCount;
        public int TransformCount;
        public int TransformValidationFailureCount;
        public double MaxTransformRoundTripErrorMm;
        public bool BudgetStopped;
        public bool SelectionComplete;
        public string ScanStoppedReason = "completed";
        public string LastReadDocumentKey;
        public string LastReadLinkInstanceUniqueId;
        public string LastReadNodeKind;
        public int? LastReadItemId;
        public readonly Dictionary<string, int> EligibleByCategory = new Dictionary<string, int>(StringComparer.Ordinal);
        public readonly Dictionary<string, int> ExtractedByCategory = new Dictionary<string, int>(StringComparer.Ordinal);
        public readonly Dictionary<string, int> OmittedByClassification = new Dictionary<string, int>(StringComparer.Ordinal);
        public readonly Dictionary<string, int> SourceOmittedByClassification = new Dictionary<string, int>(StringComparer.Ordinal);

        public void Increment(Dictionary<string, int> target, string key)
        {
            int value;
            target.TryGetValue(key ?? "<none>", out value);
            target[key ?? "<none>"] = value + 1;
        }

        public void IncrementBy(Dictionary<string, int> target, string key, int amount)
        {
            if (amount <= 0) return;
            int value;
            target.TryGetValue(key ?? "<none>", out value);
            target[key ?? "<none>"] = value + amount;
        }

        public void Stop(string reason)
        {
            if (!BudgetStopped)
            {
                BudgetStopped = true;
                ScanStoppedReason = reason;
            }
        }
    }

    internal sealed class CursorEnvelope
    {
        public string CursorVersion { get; set; }
        public string CaptureId { get; set; }
        public int PageOrdinal { get; set; }
        public CursorSortPosition SortPosition { get; set; }
        public string PriorPageHash { get; set; }
        public string RevisionFingerprint { get; set; }
        public string ScopeFingerprint { get; set; }
        public string CapturedAt { get; set; }
    }

    internal sealed class CursorSortPosition
    {
        public string DocumentKey { get; set; }
        public string LinkPlacementKey { get; set; }
        public string NodeKind { get; set; }
        public string StableSourceIdentity { get; set; }
    }
}
