#nullable enable

using System;
using System.Collections.Generic;

namespace RevAgent.Contracts.AddinLoopback
{
    /// <summary>
    /// One open, non-linked document as enumerated by the add-in glue at
    /// application-event time, keyed by a session-local stable key (a path
    /// digest or an untitled-title key) instead of a managed wrapper identity.
    /// </summary>
    public sealed class AddinDocumentContextDocumentSource
    {
        public AddinDocumentContextDocumentSource(
            string stableKey,
            string title,
            string? pathDigest,
            bool isWorkshared)
        {
            if (string.IsNullOrEmpty(stableKey))
            {
                throw new ArgumentException("stableKey must not be empty.", nameof(stableKey));
            }

            StableKey = stableKey;
            Title = title;
            PathDigest = pathDigest;
            IsWorkshared = isWorkshared;
        }

        public string StableKey { get; }

        public string Title { get; }

        public string? PathDigest { get; }

        public bool IsWorkshared { get; }
    }

    /// <summary>
    /// RES-3: the application-event-maintained document-context aggregate.
    /// Each Revit application event kind (document open/create, save-as,
    /// closing/closed, view activated) maps to one method that refreshes the
    /// underlying <see cref="AddinDocumentContextCache"/>; a failed capture is
    /// recorded through <see cref="MarkUnavailable"/>. Session-local
    /// documentIds are assigned per stable key and never re-used after the
    /// key's document closes. All members are thread-safe.
    /// </summary>
    public sealed class AddinDocumentContextAggregator
    {
        private readonly object _gate = new object();
        private readonly AddinDocumentContextCache _cache;
        private readonly Dictionary<string, string> _documentIdsByStableKey =
            new Dictionary<string, string>(StringComparer.Ordinal);
        private readonly List<AddinDocumentContextDocumentSource> _openDocuments =
            new List<AddinDocumentContextDocumentSource>();
        private readonly Dictionary<long, string> _closingStableKeysByRevitDocumentId =
            new Dictionary<long, string>();
        private string? _activeStableKey;
        private AddinDocumentContextViewState? _activeView;
        private string? _disciplineHint;
        private long _documentIdSequence;

        public AddinDocumentContextAggregator()
            : this(null)
        {
        }

        public AddinDocumentContextAggregator(Func<DateTimeOffset>? clock)
        {
            _cache = new AddinDocumentContextCache(clock);
        }

        /// <summary>Reads the current snapshot without mutating any state.</summary>
        public AddinDocumentContextCacheSnapshot Read()
        {
            return _cache.Read();
        }

        /// <summary>
        /// Publishes the initial ready snapshot right after the glue
        /// subscribes to Revit application events, before any document can
        /// open, so the empty document list is truthful rather than warming.
        /// </summary>
        public AddinDocumentContextCacheSnapshot RecordStartupBaseline()
        {
            lock (_gate)
            {
                return PublishLocked();
            }
        }

        /// <summary>
        /// DocumentOpened/DocumentCreated/DocumentSavedAs: replaces the open
        /// document list with the freshly enumerated one (stable keys keep
        /// session-local documentIds; unseen keys get new ids) and keeps the
        /// last observed active view when its document is still open.
        /// </summary>
        public AddinDocumentContextCacheSnapshot RecordDocumentsChanged(
            IReadOnlyList<AddinDocumentContextDocumentSource> openDocuments)
        {
            if (openDocuments == null)
            {
                throw new ArgumentNullException(nameof(openDocuments));
            }

            lock (_gate)
            {
                ReplaceOpenDocumentsLocked(openDocuments);
                return PublishLocked();
            }
        }

        /// <summary>
        /// ViewActivated: replaces the open document list and the active
        /// document/view/discipline context in one observation.
        /// </summary>
        public AddinDocumentContextCacheSnapshot RecordViewActivated(
            IReadOnlyList<AddinDocumentContextDocumentSource> openDocuments,
            string activeStableKey,
            AddinDocumentContextViewState? activeView,
            string? disciplineHint)
        {
            if (openDocuments == null)
            {
                throw new ArgumentNullException(nameof(openDocuments));
            }

            if (string.IsNullOrEmpty(activeStableKey))
            {
                throw new ArgumentException("activeStableKey must not be empty.", nameof(activeStableKey));
            }

            lock (_gate)
            {
                ReplaceOpenDocumentsLocked(openDocuments);
                if (!_documentIdsByStableKey.ContainsKey(activeStableKey))
                {
                    throw new ArgumentException(
                        "activeStableKey must identify one enumerated open document.",
                        nameof(activeStableKey));
                }

                _activeStableKey = activeStableKey;
                _activeView = activeView;
                _disciplineHint = AddinDocumentContextContract.NormalizeDisciplineHint(disciplineHint);
                return PublishLocked();
            }
        }

        /// <summary>
        /// DocumentClosing: pairs the still-readable document with the numeric
        /// id later reported by DocumentClosed. The snapshot is unchanged
        /// because the document is still open until the close succeeds.
        /// </summary>
        public AddinDocumentContextCacheSnapshot RecordDocumentClosing(
            long revitDocumentId,
            string stableKey)
        {
            if (string.IsNullOrEmpty(stableKey))
            {
                throw new ArgumentException("stableKey must not be empty.", nameof(stableKey));
            }

            lock (_gate)
            {
                _closingStableKeysByRevitDocumentId[revitDocumentId] = stableKey;
                return _cache.Read();
            }
        }

        /// <summary>
        /// DocumentClosed: on success removes the paired document (clearing
        /// the active context when the active document closed) and publishes;
        /// a cancelled or failed close only drops the pairing.
        /// </summary>
        public AddinDocumentContextCacheSnapshot RecordDocumentClosed(
            long revitDocumentId,
            bool succeeded)
        {
            lock (_gate)
            {
                string? stableKey;
                if (!_closingStableKeysByRevitDocumentId.TryGetValue(revitDocumentId, out stableKey))
                {
                    return _cache.Read();
                }

                _closingStableKeysByRevitDocumentId.Remove(revitDocumentId);
                if (!succeeded)
                {
                    return _cache.Read();
                }

                _openDocuments.RemoveAll(document =>
                    string.Equals(document.StableKey, stableKey, StringComparison.Ordinal));
                _documentIdsByStableKey.Remove(stableKey);
                if (string.Equals(_activeStableKey, stableKey, StringComparison.Ordinal))
                {
                    ClearActiveContextLocked();
                }

                return PublishLocked();
            }
        }

        /// <summary>
        /// Event-driven invalidation for a failed capture on any event type.
        /// The retained document map keeps serving later publishes so the
        /// cache self-heals on the next successful application event.
        /// </summary>
        public AddinDocumentContextCacheSnapshot MarkUnavailable(string? reason)
        {
            return _cache.MarkUnavailable(reason);
        }

        private void ReplaceOpenDocumentsLocked(
            IReadOnlyList<AddinDocumentContextDocumentSource> openDocuments)
        {
            HashSet<string> seenKeys = new HashSet<string>(StringComparer.Ordinal);
            foreach (AddinDocumentContextDocumentSource document in openDocuments)
            {
                if (document == null)
                {
                    throw new ArgumentException(
                        "openDocuments must not contain null.",
                        nameof(openDocuments));
                }

                if (!seenKeys.Add(document.StableKey))
                {
                    throw new ArgumentException(
                        "openDocuments contains duplicate stable key \"" + document.StableKey + "\".",
                        nameof(openDocuments));
                }
            }

            _openDocuments.Clear();
            foreach (AddinDocumentContextDocumentSource document in openDocuments)
            {
                if (!_documentIdsByStableKey.ContainsKey(document.StableKey))
                {
                    _documentIdSequence++;
                    _documentIdsByStableKey[document.StableKey] = "doc-" +
                        _documentIdSequence.ToString(System.Globalization.CultureInfo.InvariantCulture);
                }

                _openDocuments.Add(document);
            }

            List<string> removedKeys = new List<string>();
            foreach (string knownKey in _documentIdsByStableKey.Keys)
            {
                if (!seenKeys.Contains(knownKey))
                {
                    removedKeys.Add(knownKey);
                }
            }

            foreach (string removedKey in removedKeys)
            {
                _documentIdsByStableKey.Remove(removedKey);
            }

            if (_activeStableKey != null && !seenKeys.Contains(_activeStableKey))
            {
                ClearActiveContextLocked();
            }
        }

        private void ClearActiveContextLocked()
        {
            _activeStableKey = null;
            _activeView = null;
            _disciplineHint = null;
        }

        private AddinDocumentContextCacheSnapshot PublishLocked()
        {
            List<AddinDocumentContextDocumentState> documents =
                new List<AddinDocumentContextDocumentState>(_openDocuments.Count);
            string? activeDocumentId = null;
            foreach (AddinDocumentContextDocumentSource source in _openDocuments)
            {
                string documentId = _documentIdsByStableKey[source.StableKey];
                documents.Add(new AddinDocumentContextDocumentState(
                    documentId,
                    source.Title,
                    source.PathDigest,
                    source.IsWorkshared));
                if (string.Equals(source.StableKey, _activeStableKey, StringComparison.Ordinal))
                {
                    activeDocumentId = documentId;
                }
            }

            return _cache.PublishContext(
                documents,
                activeDocumentId,
                activeDocumentId != null ? _activeView : null,
                activeDocumentId != null ? _disciplineHint : null);
        }
    }
}
