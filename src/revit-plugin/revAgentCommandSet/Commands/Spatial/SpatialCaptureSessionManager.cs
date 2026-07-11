using Autodesk.Revit.DB;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

namespace RevAgentCommandSet.Commands.Spatial
{
    /// <summary>
    /// Keeps bounded native discovery/filter/extraction/finalization state and
    /// the finalized deterministic page rows between authenticated continuation
    /// calls. Sessions are process-local, short-lived, and never represent a
    /// committed spatial snapshot.
    /// </summary>
    internal sealed class SpatialCaptureSessionManager
    {
        internal static readonly SpatialCaptureSessionManager Instance = new SpatialCaptureSessionManager();

        private static readonly TimeSpan SessionLifetime = TimeSpan.FromMinutes(10);
        private const int MaximumSessions = 8;
        private readonly object _gate = new object();
        private readonly Dictionary<string, PreparedSpatialCapture> _sessions =
            new Dictionary<string, PreparedSpatialCapture>(StringComparer.Ordinal);
        private readonly Timer _purgeTimer;

        private SpatialCaptureSessionManager()
        {
            _purgeTimer = new Timer(delegate { PurgeExpired(); }, null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
        }

        internal void Store(PreparedSpatialCapture capture)
        {
            if (capture == null || string.IsNullOrWhiteSpace(capture.CaptureId))
            {
                throw new ArgumentException("A prepared spatial capture requires a capture id.", "capture");
            }

            lock (_gate)
            {
                PurgeExpiredUnsafe(DateTime.UtcNow);
                capture.ExpiresAtUtc = DateTime.UtcNow.Add(SessionLifetime);
                _sessions[capture.CaptureId] = capture;
                while (_sessions.Count > MaximumSessions)
                {
                    PreparedSpatialCapture oldest = _sessions.Values
                        .OrderBy(value => value.CreatedAtUtc)
                        .FirstOrDefault();
                    if (oldest == null) break;
                    _sessions.Remove(oldest.CaptureId);
                }
            }
        }

        internal bool TryGet(string captureId, out PreparedSpatialCapture capture)
        {
            capture = null;
            if (string.IsNullOrWhiteSpace(captureId)) return false;
            lock (_gate)
            {
                PurgeExpiredUnsafe(DateTime.UtcNow);
                if (!_sessions.TryGetValue(captureId, out capture)) return false;
                capture.ExpiresAtUtc = DateTime.UtcNow.Add(SessionLifetime);
                return true;
            }
        }

        internal void Remove(string captureId)
        {
            if (string.IsNullOrWhiteSpace(captureId)) return;
            lock (_gate)
            {
                _sessions.Remove(captureId);
            }
        }

        private void PurgeExpired()
        {
            lock (_gate)
            {
                PurgeExpiredUnsafe(DateTime.UtcNow);
            }
        }

        private void PurgeExpiredUnsafe(DateTime nowUtc)
        {
            foreach (string captureId in _sessions
                .Where(pair => pair.Value == null || pair.Value.ExpiresAtUtc <= nowUtc)
                .Select(pair => pair.Key)
                .ToList())
            {
                _sessions.Remove(captureId);
            }
        }
    }

    internal sealed class PreparedSpatialCapture
    {
        public string CaptureId;
        public string CapturedAt;
        public DateTime CreatedAtUtc;
        public DateTime ExpiresAtUtc;
        public Document HostDocument;
        public int PageTargetBytes;
        public SpatialSnapshotRequest Request;
        public List<SpatialSource> Sources;
        public List<LevelBand> Bands;
        public List<SpatialDiscoveryPartition> DiscoveryPartitions;
        public int DiscoveryPartitionIndex;
        public List<int> ActiveDiscoveryElementIds;
        public int ActiveDiscoveryElementIndex;
        public List<SpatialCandidateRecord> DiscoveredCandidates;
        public List<SpatialCandidateRecord> EligibleCandidates;
        public int FilterIndex;
        public int ExtractIndex;
        public bool ExtractLimitInitialized;
        public List<SpatialRow> OrderedRows;
        public SpatialExtractionState Extraction;
        public Dictionary<string, object> Scope;
        public Dictionary<string, object> EffectiveSourcePolicy;
        public List<Dictionary<string, object>> SourceRevisions;
        public string ScopeFingerprint;
        public string SourceBindingFingerprint;
        public string RevisionFingerprint;
        public string WorkPhase;
        public int WorkStepOrdinal;
        public int FinalizeStage;
        public int FinalizeRowIndex;
        public int FinalizeSourceIndex;
        public long PreparedCanonicalBytes;
        public int TotalPageCount;
        public long TotalPayloadBytes;
        public bool HasEffectiveSourcePolicy;
        public bool PreparationComplete;
        public List<string> Warnings;
        public List<string> Notices;
    }
}
