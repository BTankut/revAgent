using Autodesk.Revit.ApplicationServices;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;

namespace RevAgentPlugin.Core
{
    /// <summary>
    /// Process-local, read-only Revit document change tracker used by the
    /// spatial truth layer. A document session id belongs to one in-memory
    /// Document object and is intentionally replaced after close/reopen or an
    /// add-in restart.
    /// </summary>
    public sealed class SpatialChangeTracker
    {
        public const int DefaultJournalCapacity = 512;
        public const int MaxStoredElementIdsPerChangeKind = 1024;
        public const int MaxReturnedJournalEntries = 256;

        private static readonly Lazy<SpatialChangeTracker> LazyInstance =
            new Lazy<SpatialChangeTracker>(() => new SpatialChangeTracker());

        private static readonly PropertyInfo ElementIdValueProperty =
            typeof(ElementId).GetProperty("Value", BindingFlags.Instance | BindingFlags.Public) ??
            typeof(ElementId).GetProperty("IntegerValue", BindingFlags.Instance | BindingFlags.Public);

        private readonly object _gate = new object();
        private readonly ConditionalWeakTable<Document, DocumentState> _documents =
            new ConditionalWeakTable<Document, DocumentState>();
        private ControlledApplication _subscribedApplication;

        private SpatialChangeTracker()
        {
            TrackerSessionId = "tracker-session:" + Guid.NewGuid().ToString("N");
            TrackerStartedAtUtc = DateTimeOffset.UtcNow;
        }

        public static SpatialChangeTracker Instance
        {
            get { return LazyInstance.Value; }
        }

        public string TrackerSessionId { get; private set; }

        public DateTimeOffset TrackerStartedAtUtc { get; private set; }

        public int JournalCapacity
        {
            get { return DefaultJournalCapacity; }
        }

        public bool IsSubscribed
        {
            get
            {
                lock (_gate)
                {
                    return _subscribedApplication != null;
                }
            }
        }

        public void Subscribe(ControlledApplication application)
        {
            if (application == null) throw new ArgumentNullException("application");

            lock (_gate)
            {
                if (ReferenceEquals(_subscribedApplication, application)) return;
                if (_subscribedApplication != null)
                {
                    _subscribedApplication.DocumentChanged -= OnDocumentChanged;
                }

                application.DocumentChanged += OnDocumentChanged;
                _subscribedApplication = application;
            }
        }

        public void Unsubscribe(ControlledApplication application)
        {
            lock (_gate)
            {
                ControlledApplication current = _subscribedApplication;
                if (current == null) return;
                if (application != null && !ReferenceEquals(current, application)) return;

                current.DocumentChanged -= OnDocumentChanged;
                _subscribedApplication = null;
            }
        }

        /// <summary>
        /// Returns the current binding without exposing model names, paths, or
        /// element payloads. Calling this method creates the session binding for
        /// a Document object if this is its first observed use.
        /// </summary>
        public SpatialDocumentChangeSnapshot GetCurrentBinding(Document document)
        {
            return ReadChangesSince(document, null, 0);
        }

        /// <summary>
        /// Reads a bounded copy of journal entries after a known sequence. A
        /// HistoryGap result means the requested sequence predates retained
        /// history and therefore cannot establish current liveness.
        /// </summary>
        public SpatialDocumentChangeSnapshot ReadChangesSince(Document document, long? afterSequence, int maxEntries)
        {
            if (document == null) throw new ArgumentNullException("document");
            if (afterSequence.HasValue && afterSequence.Value < 0)
            {
                throw new ArgumentOutOfRangeException("afterSequence");
            }

            int boundedMaxEntries = Math.Max(0, Math.Min(MaxReturnedJournalEntries, maxEntries));
            lock (_gate)
            {
                DocumentState state = GetOrCreateState(document);
                long oldestRetainedSequence = state.Journal.Count > 0
                    ? state.Journal[0].Sequence
                    : state.CurrentSequence;
                long historyCompleteAfterSequence = oldestRetainedSequence > 0
                    ? oldestRetainedSequence - 1
                    : 0;
                bool historyGap = afterSequence.HasValue &&
                    afterSequence.Value < historyCompleteAfterSequence;

                List<SpatialChangeJournalEntry> matchingEntries = afterSequence.HasValue
                    ? state.Journal.Where(entry => entry.Sequence > afterSequence.Value).ToList()
                    : new List<SpatialChangeJournalEntry>();
                bool requestedElementIdsTruncated = afterSequence.HasValue
                    ? matchingEntries.Any(entry => entry.ElementIdsTruncated || entry.ElementIdReadFailed)
                    : state.DroppedElementIdCount > 0 || state.ElementIdReadFailed;
                bool requestedElementIdReadFailed = afterSequence.HasValue
                    ? matchingEntries.Any(entry => entry.ElementIdReadFailed)
                    : state.ElementIdReadFailed;
                long requestedDroppedElementIdCount = afterSequence.HasValue
                    ? matchingEntries.Sum(entry => (long)entry.DroppedElementIdCount)
                    : state.DroppedElementIdCount;
                bool returnedEntriesTruncated = matchingEntries.Count > boundedMaxEntries;
                if (matchingEntries.Count > boundedMaxEntries)
                {
                    matchingEntries = matchingEntries.Take(boundedMaxEntries).ToList();
                }

                return new SpatialDocumentChangeSnapshot
                {
                    TrackerSessionId = TrackerSessionId,
                    TrackerStartedAtUtc = TrackerStartedAtUtc,
                    TrackerSubscribed = _subscribedApplication != null,
                    DocumentSessionId = state.DocumentSessionId,
                    CurrentSequence = state.CurrentSequence,
                    OldestRetainedSequence = oldestRetainedSequence,
                    HistoryCompleteAfterSequence = historyCompleteAfterSequence,
                    HistoryGap = historyGap,
                    JournalCapacity = DefaultJournalCapacity,
                    JournalEntryCount = state.Journal.Count,
                    JournalTruncated = state.DroppedJournalEntryCount > 0,
                    DroppedJournalEntryCount = state.DroppedJournalEntryCount,
                    ElementIdListsTruncated = requestedElementIdsTruncated,
                    ElementIdReadFailed = requestedElementIdReadFailed,
                    DroppedElementIdCount = requestedDroppedElementIdCount,
                    LastChangedAtUtc = state.LastChangedAtUtc,
                    RequestedAfterSequence = afterSequence,
                    ChangedSinceRequestedSequenceCount = afterSequence.HasValue && afterSequence.Value <= state.CurrentSequence
                        ? state.CurrentSequence - afterSequence.Value
                        : 0,
                    ReturnedEntriesTruncated = returnedEntriesTruncated,
                    Entries = matchingEntries.Select(CloneEntry).ToList()
                };
            }
        }

        private void OnDocumentChanged(object sender, DocumentChangedEventArgs args)
        {
            Document document = null;
            try
            {
                document = args != null ? args.GetDocument() : null;
            }
            catch
            {
                return;
            }
            if (document == null) return;

            ElementIdReadResult added = ReadElementIds(delegate { return args.GetAddedElementIds(); });
            ElementIdReadResult modified = ReadElementIds(delegate { return args.GetModifiedElementIds(); });
            ElementIdReadResult deleted = ReadElementIds(delegate { return args.GetDeletedElementIds(); });
            DateTimeOffset changedAtUtc = DateTimeOffset.UtcNow;

            lock (_gate)
            {
                DocumentState state = GetOrCreateState(document);
                state.CurrentSequence++;

                SpatialChangeJournalEntry entry = new SpatialChangeJournalEntry
                {
                    Sequence = state.CurrentSequence,
                    ChangedAtUtc = changedAtUtc,
                    AddedElementIds = added.StoredIds,
                    ModifiedElementIds = modified.StoredIds,
                    DeletedElementIds = deleted.StoredIds,
                    AddedElementCount = added.ObservedCount,
                    ModifiedElementCount = modified.ObservedCount,
                    DeletedElementCount = deleted.ObservedCount,
                    ElementIdsTruncated = added.DroppedCount > 0 || modified.DroppedCount > 0 || deleted.DroppedCount > 0,
                    ElementIdReadFailed = added.ReadFailed || modified.ReadFailed || deleted.ReadFailed,
                    DroppedElementIdCount = added.DroppedCount + modified.DroppedCount + deleted.DroppedCount
                };
                state.Journal.Add(entry);
                state.LastChangedAtUtc = changedAtUtc;
                state.DroppedElementIdCount += entry.DroppedElementIdCount;
                state.ElementIdReadFailed = state.ElementIdReadFailed || entry.ElementIdReadFailed;

                while (state.Journal.Count > DefaultJournalCapacity)
                {
                    state.Journal.RemoveAt(0);
                    state.DroppedJournalEntryCount++;
                }
            }
        }

        private DocumentState GetOrCreateState(Document document)
        {
            DocumentState state;
            if (_documents.TryGetValue(document, out state)) return state;

            state = new DocumentState
            {
                DocumentSessionId = "document-session:" + Guid.NewGuid().ToString("N"),
                CurrentSequence = 0,
                Journal = new List<SpatialChangeJournalEntry>()
            };
            _documents.Add(document, state);
            return state;
        }

        private static ElementIdReadResult ReadElementIds(Func<ICollection<ElementId>> reader)
        {
            try
            {
                ICollection<ElementId> source = reader != null ? reader() : null;
                if (source == null) source = new List<ElementId>();

                SortedSet<long> uniqueIds = new SortedSet<long>();
                int unreadableCount = 0;
                foreach (ElementId elementId in source)
                {
                    long value;
                    if (TryGetElementIdValue(elementId, out value)) uniqueIds.Add(value);
                    else unreadableCount++;
                }

                int observedCount = uniqueIds.Count + unreadableCount;
                List<long> stored = uniqueIds.Take(MaxStoredElementIdsPerChangeKind).ToList();
                int droppedCount = Math.Max(0, observedCount - stored.Count);
                return new ElementIdReadResult
                {
                    StoredIds = stored,
                    ObservedCount = observedCount,
                    DroppedCount = droppedCount,
                    ReadFailed = unreadableCount > 0
                };
            }
            catch
            {
                return new ElementIdReadResult
                {
                    StoredIds = new List<long>(),
                    ObservedCount = 0,
                    DroppedCount = 0,
                    ReadFailed = true
                };
            }
        }

        private static bool TryGetElementIdValue(ElementId elementId, out long value)
        {
            value = 0;
            if (elementId == null || ElementIdValueProperty == null) return false;
            try
            {
                object raw = ElementIdValueProperty.GetValue(elementId, null);
                value = Convert.ToInt64(raw, CultureInfo.InvariantCulture);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static SpatialChangeJournalEntry CloneEntry(SpatialChangeJournalEntry source)
        {
            return new SpatialChangeJournalEntry
            {
                Sequence = source.Sequence,
                ChangedAtUtc = source.ChangedAtUtc,
                AddedElementIds = new List<long>(source.AddedElementIds ?? new List<long>()),
                ModifiedElementIds = new List<long>(source.ModifiedElementIds ?? new List<long>()),
                DeletedElementIds = new List<long>(source.DeletedElementIds ?? new List<long>()),
                AddedElementCount = source.AddedElementCount,
                ModifiedElementCount = source.ModifiedElementCount,
                DeletedElementCount = source.DeletedElementCount,
                ElementIdsTruncated = source.ElementIdsTruncated,
                ElementIdReadFailed = source.ElementIdReadFailed,
                DroppedElementIdCount = source.DroppedElementIdCount
            };
        }

        private sealed class DocumentState
        {
            public string DocumentSessionId;
            public long CurrentSequence;
            public List<SpatialChangeJournalEntry> Journal;
            public long DroppedJournalEntryCount;
            public long DroppedElementIdCount;
            public bool ElementIdReadFailed;
            public DateTimeOffset? LastChangedAtUtc;
        }

        private sealed class ElementIdReadResult
        {
            public List<long> StoredIds;
            public int ObservedCount;
            public int DroppedCount;
            public bool ReadFailed;
        }
    }

    public sealed class SpatialDocumentChangeSnapshot
    {
        public string TrackerSessionId { get; internal set; }
        public DateTimeOffset TrackerStartedAtUtc { get; internal set; }
        public bool TrackerSubscribed { get; internal set; }
        public string DocumentSessionId { get; internal set; }
        public long CurrentSequence { get; internal set; }
        public long OldestRetainedSequence { get; internal set; }
        public long HistoryCompleteAfterSequence { get; internal set; }
        public bool HistoryGap { get; internal set; }
        public int JournalCapacity { get; internal set; }
        public int JournalEntryCount { get; internal set; }
        public bool JournalTruncated { get; internal set; }
        public long DroppedJournalEntryCount { get; internal set; }
        public bool ElementIdListsTruncated { get; internal set; }
        public bool ElementIdReadFailed { get; internal set; }
        public long DroppedElementIdCount { get; internal set; }
        public DateTimeOffset? LastChangedAtUtc { get; internal set; }
        public long? RequestedAfterSequence { get; internal set; }
        public long ChangedSinceRequestedSequenceCount { get; internal set; }
        public bool ReturnedEntriesTruncated { get; internal set; }
        public IList<SpatialChangeJournalEntry> Entries { get; internal set; }
    }

    public sealed class SpatialChangeJournalEntry
    {
        public long Sequence { get; internal set; }
        public DateTimeOffset ChangedAtUtc { get; internal set; }
        public IList<long> AddedElementIds { get; internal set; }
        public IList<long> ModifiedElementIds { get; internal set; }
        public IList<long> DeletedElementIds { get; internal set; }
        public int AddedElementCount { get; internal set; }
        public int ModifiedElementCount { get; internal set; }
        public int DeletedElementCount { get; internal set; }
        public bool ElementIdsTruncated { get; internal set; }
        public bool ElementIdReadFailed { get; internal set; }
        public int DroppedElementIdCount { get; internal set; }
    }
}
