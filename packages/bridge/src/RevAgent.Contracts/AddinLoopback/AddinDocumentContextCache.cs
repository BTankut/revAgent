#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;

namespace RevAgent.Contracts.AddinLoopback
{
    /// <summary>
    /// The Appendix A.3 cacheState/revision state machine. The cache starts
    /// <c>warming</c>, becomes <c>ready</c> on the first published
    /// observation, returns to <c>ready</c> from <c>unavailable</c> on the
    /// next successful publish, and is marked <c>unavailable</c> with a
    /// bounded reason when event-driven maintenance fails. <c>revision</c>
    /// increases monotonically exactly when the normalized snapshot changes;
    /// reads never mutate state. All members are thread-safe: Revit
    /// application events publish while socket threads read.
    /// </summary>
    public sealed class AddinDocumentContextCache
    {
        private readonly object _gate = new object();
        private readonly Func<DateTimeOffset> _clock;
        private AddinDocumentContextCacheSnapshot _snapshot;

        public AddinDocumentContextCache()
            : this(null)
        {
        }

        public AddinDocumentContextCache(Func<DateTimeOffset>? clock)
            : this(clock, 0)
        {
        }

        /// <summary>
        /// Fixture-parity seeding constructor: the cache starts warming at the
        /// given revision so the JSON-safe revision ceiling stays testable.
        /// </summary>
        public AddinDocumentContextCache(Func<DateTimeOffset>? clock, long initialRevision)
        {
            if (initialRevision < 0 || initialRevision > AddinDocumentContextContract.MaxRevision)
            {
                throw new ArgumentOutOfRangeException(nameof(initialRevision));
            }

            _clock = clock ?? (() => DateTimeOffset.UtcNow);
            _snapshot = new AddinDocumentContextCacheSnapshot(
                _clock(),
                initialRevision,
                AddinDocumentContextContract.CacheStateWarming,
                AddinDocumentContextContract.WarmingReason,
                Array.Empty<AddinDocumentContextDocumentState>(),
                null,
                null,
                null);
        }

        /// <summary>Returns the current snapshot without mutating any state.</summary>
        public AddinDocumentContextCacheSnapshot Read()
        {
            lock (_gate)
            {
                return _snapshot;
            }
        }

        /// <summary>
        /// Publishes one complete observation. An invalid observation throws
        /// before any state changes; an observation equal to the current ready
        /// snapshot is a no-op that keeps revision and capturedAtUtc stable.
        /// </summary>
        public AddinDocumentContextCacheSnapshot PublishContext(
            IReadOnlyList<AddinDocumentContextDocumentState> documents,
            string? activeDocumentId,
            AddinDocumentContextViewState? activeView,
            string? disciplineHint)
        {
            if (documents == null)
            {
                throw new ArgumentNullException(nameof(documents));
            }

            if (documents.Count > AddinDocumentContextContract.MaxDocuments)
            {
                throw new ArgumentException(
                    "documents exceeds the " +
                    AddinDocumentContextContract.MaxDocuments.ToString(
                        System.Globalization.CultureInfo.InvariantCulture) +
                    "-document contract limit.",
                    nameof(documents));
            }

            HashSet<string> documentIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (AddinDocumentContextDocumentState document in documents)
            {
                if (document == null)
                {
                    throw new ArgumentException("documents must not contain null.", nameof(documents));
                }

                if (!documentIds.Add(document.DocumentId))
                {
                    throw new ArgumentException(
                        "documents contains duplicate documentId \"" + document.DocumentId + "\".",
                        nameof(documents));
                }
            }

            if (activeDocumentId != null && !documentIds.Contains(activeDocumentId))
            {
                throw new ArgumentException(
                    "activeDocumentId must identify one published document.",
                    nameof(activeDocumentId));
            }

            if (activeView != null && activeDocumentId == null)
            {
                throw new ArgumentException(
                    "activeView requires a non-null activeDocumentId.",
                    nameof(activeView));
            }

            if (disciplineHint != null &&
                !AddinDocumentContextContract.IsValidDisciplineHint(disciplineHint))
            {
                throw new ArgumentException(
                    "disciplineHint does not match the frozen token format.",
                    nameof(disciplineHint));
            }

            AddinDocumentContextDocumentState[] snapshotDocuments = documents.ToArray();
            lock (_gate)
            {
                if (IsUnchangedReadyState(snapshotDocuments, activeDocumentId, activeView, disciplineHint))
                {
                    return _snapshot;
                }

                _snapshot = new AddinDocumentContextCacheSnapshot(
                    _clock(),
                    NextRevision(),
                    AddinDocumentContextContract.CacheStateReady,
                    null,
                    snapshotDocuments,
                    activeDocumentId,
                    activeView,
                    disciplineHint);
                return _snapshot;
            }
        }

        /// <summary>
        /// Event-driven invalidation: the snapshot becomes <c>unavailable</c>
        /// with a bounded non-empty reason and carries no documents or active
        /// context. Re-marking with an identical reason is a no-op.
        /// </summary>
        public AddinDocumentContextCacheSnapshot MarkUnavailable(string? reason)
        {
            string normalizedReason = AddinDocumentContextContract.NormalizeUnavailableReason(reason);
            lock (_gate)
            {
                if (string.Equals(
                        _snapshot.CacheState,
                        AddinDocumentContextContract.CacheStateUnavailable,
                        StringComparison.Ordinal) &&
                    string.Equals(_snapshot.UnavailableReason, normalizedReason, StringComparison.Ordinal))
                {
                    return _snapshot;
                }

                _snapshot = new AddinDocumentContextCacheSnapshot(
                    _clock(),
                    NextRevision(),
                    AddinDocumentContextContract.CacheStateUnavailable,
                    normalizedReason,
                    Array.Empty<AddinDocumentContextDocumentState>(),
                    null,
                    null,
                    null);
                return _snapshot;
            }
        }

        private long NextRevision()
        {
            if (_snapshot.Revision >= AddinDocumentContextContract.MaxRevision)
            {
                throw new InvalidOperationException(
                    "Document context revision cannot increase beyond the JSON-safe integer range.");
            }

            return _snapshot.Revision + 1;
        }

        private bool IsUnchangedReadyState(
            IReadOnlyList<AddinDocumentContextDocumentState> documents,
            string? activeDocumentId,
            AddinDocumentContextViewState? activeView,
            string? disciplineHint)
        {
            if (!_snapshot.IsReady ||
                _snapshot.Documents.Count != documents.Count ||
                !string.Equals(_snapshot.ActiveDocumentId, activeDocumentId, StringComparison.Ordinal) ||
                !string.Equals(_snapshot.DisciplineHint, disciplineHint, StringComparison.Ordinal))
            {
                return false;
            }

            if (_snapshot.ActiveView == null != (activeView == null) ||
                (_snapshot.ActiveView != null && !_snapshot.ActiveView.NormalizedEquals(activeView!)))
            {
                return false;
            }

            for (int index = 0; index < documents.Count; index++)
            {
                if (!_snapshot.Documents[index].NormalizedEquals(documents[index]))
                {
                    return false;
                }
            }

            return true;
        }
    }
}
