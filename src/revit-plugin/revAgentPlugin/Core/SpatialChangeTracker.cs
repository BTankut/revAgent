using Autodesk.Revit.ApplicationServices;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;

namespace RevAgentPlugin.Core
{
    /// <summary>
    /// Process-local, read-only Revit document change tracker used by the
    /// spatial truth layer. A document session id belongs to one native open
    /// document session, not to one transient managed Document wrapper. It is
    /// intentionally replaced after close/reopen or an add-in restart.
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
        private ConditionalWeakTable<Document, DocumentState> _documentAliases =
            new ConditionalWeakTable<Document, DocumentState>();
        private readonly Dictionary<string, DocumentState> _documentsByStableKey =
            new Dictionary<string, DocumentState>(StringComparer.Ordinal);
        private readonly Dictionary<int, DocumentState> _closingDocuments =
            new Dictionary<int, DocumentState>();
        private ControlledApplication _subscribedApplication;
        private long _livenessGeneration;

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

        /// <summary>
        /// Monotonic, process-local invalidation generation for sequence-bound
        /// spatial liveness cache entries. This is not a model revision and is
        /// never persisted; it only proves that no tracked invalidation event
        /// occurred between a native liveness evaluation and a cache lookup.
        /// </summary>
        public long LivenessGeneration
        {
            get
            {
                lock (_gate)
                {
                    return _livenessGeneration;
                }
            }
        }

        /// <summary>
        /// Invalidates process-local liveness cache entries when the operator
        /// changes the active Revit document/view. Same-document view changes
        /// are intentionally conservative and may invalidate unnecessarily.
        /// </summary>
        public void InvalidateActiveDocumentView()
        {
            lock (_gate)
            {
                AdvanceLivenessGeneration();
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
                    _subscribedApplication.DocumentClosing -= OnDocumentClosing;
                    _subscribedApplication.DocumentClosed -= OnDocumentClosed;
                    _subscribedApplication.DocumentSaved -= OnDocumentSaved;
                    _subscribedApplication.DocumentSavedAs -= OnDocumentSavedAs;
                    _subscribedApplication.DocumentSynchronizedWithCentral -= OnDocumentSynchronizedWithCentral;
                    _subscribedApplication.DocumentReloadedLatest -= OnDocumentReloadedLatest;
                    ResetDocumentBindings();
                }

                application.DocumentChanged += OnDocumentChanged;
                application.DocumentClosing += OnDocumentClosing;
                application.DocumentClosed += OnDocumentClosed;
                application.DocumentSaved += OnDocumentSaved;
                application.DocumentSavedAs += OnDocumentSavedAs;
                application.DocumentSynchronizedWithCentral += OnDocumentSynchronizedWithCentral;
                application.DocumentReloadedLatest += OnDocumentReloadedLatest;
                _subscribedApplication = application;
                AdvanceLivenessGeneration();
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
                current.DocumentClosing -= OnDocumentClosing;
                current.DocumentClosed -= OnDocumentClosed;
                current.DocumentSaved -= OnDocumentSaved;
                current.DocumentSavedAs -= OnDocumentSavedAs;
                current.DocumentSynchronizedWithCentral -= OnDocumentSynchronizedWithCentral;
                current.DocumentReloadedLatest -= OnDocumentReloadedLatest;
                _subscribedApplication = null;
                ResetDocumentBindings();
                AdvanceLivenessGeneration();
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

            // Invalidate a previously cached current result before reading the
            // potentially large change-id collections. Socket requests run on
            // background threads and must not observe the old generation once
            // Revit has begun publishing this committed change.
            lock (_gate)
            {
                AdvanceLivenessGeneration();
            }

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

        private void OnDocumentClosing(object sender, DocumentClosingEventArgs args)
        {
            if (args == null) return;

            Document document;
            try
            {
                document = args.Document;
            }
            catch
            {
                return;
            }
            if (document == null) return;

            lock (_gate)
            {
                DocumentState state;
                if (TryResolveState(document, out state))
                {
                    _closingDocuments[args.DocumentId] = state;
                }
            }
        }

        private void OnDocumentClosed(object sender, DocumentClosedEventArgs args)
        {
            if (args == null) return;

            lock (_gate)
            {
                DocumentState state;
                bool hasClosingState = _closingDocuments.TryGetValue(args.DocumentId, out state);
                if (hasClosingState)
                {
                    _closingDocuments.Remove(args.DocumentId);
                }
                if (args.Status != RevitAPIEventStatus.Succeeded) return;

                if (hasClosingState) RemoveDocumentState(state);
                AdvanceLivenessGeneration();
            }
        }

        private void OnDocumentSavedAs(object sender, DocumentSavedAsEventArgs args)
        {
            if (args == null || args.Status != RevitAPIEventStatus.Succeeded) return;

            // Save As can change stable document identity without a
            // DocumentChanged event. Invalidate before resolving the refreshed
            // path/identity so no background cache hit can span this event.
            lock (_gate)
            {
                AdvanceLivenessGeneration();
            }

            Document document;
            try
            {
                document = args.Document;
            }
            catch
            {
                return;
            }
            if (document == null) return;

            lock (_gate)
            {
                DocumentState state;
                if (_documentAliases.TryGetValue(document, out state))
                {
                    RefreshStableAliases(document, state);
                    return;
                }

                string originalPath = NormalizeDocumentPath(
                    SafeReadString(delegate { return args.OriginalPath; }));
                if (!string.IsNullOrWhiteSpace(originalPath) &&
                    _documentsByStableKey.TryGetValue("path|" + originalPath, out state))
                {
                    AddWrapperAlias(document, state);
                    RefreshStableAliases(document, state);
                    return;
                }

                string projectInformationId = TryGetProjectInformationId(document);
                if (!string.IsNullOrWhiteSpace(projectInformationId) &&
                    _documentsByStableKey.TryGetValue(
                        "unsaved|project|" + projectInformationId,
                        out state))
                {
                    AddWrapperAlias(document, state);
                    RefreshStableAliases(document, state);
                    return;
                }

                GetOrCreateState(document);
            }
        }

        private void OnDocumentSaved(object sender, DocumentSavedEventArgs args)
        {
            InvalidateSuccessfulDocumentBoundary(args != null ? args.Status : RevitAPIEventStatus.Failed);
        }

        private void OnDocumentSynchronizedWithCentral(
            object sender,
            DocumentSynchronizedWithCentralEventArgs args)
        {
            InvalidateSuccessfulDocumentBoundary(args != null ? args.Status : RevitAPIEventStatus.Failed);
        }

        private void OnDocumentReloadedLatest(object sender, DocumentReloadedLatestEventArgs args)
        {
            InvalidateSuccessfulDocumentBoundary(args != null ? args.Status : RevitAPIEventStatus.Failed);
        }

        private void InvalidateSuccessfulDocumentBoundary(RevitAPIEventStatus status)
        {
            if (status != RevitAPIEventStatus.Succeeded) return;
            lock (_gate)
            {
                AdvanceLivenessGeneration();
            }
        }

        private DocumentState GetOrCreateState(Document document)
        {
            DocumentState state;
            if (_documentAliases.TryGetValue(document, out state))
            {
                RegisterStableAliases(document, state);
                return state;
            }

            if (TryResolveState(document, out state))
            {
                AddWrapperAlias(document, state);
                RegisterStableAliases(document, state);
                return state;
            }

            state = new DocumentState
            {
                DocumentSessionId = "document-session:" + Guid.NewGuid().ToString("N"),
                CurrentSequence = 0,
                Journal = new List<SpatialChangeJournalEntry>(),
                StableKeys = new HashSet<string>(StringComparer.Ordinal)
            };
            AddWrapperAlias(document, state);
            RegisterStableAliases(document, state);
            return state;
        }

        private bool TryResolveState(Document document, out DocumentState state)
        {
            state = null;
            if (document == null) return false;

            DocumentState aliased;
            if (_documentAliases.TryGetValue(document, out aliased))
            {
                state = aliased;
                return true;
            }

            foreach (string key in ResolveStableDocumentKeys(document))
            {
                DocumentState candidate;
                if (!_documentsByStableKey.TryGetValue(key, out candidate)) continue;
                // A stable key is authoritative for the lifetime bracketed by
                // DocumentClosing/DocumentClosed. Revit may return different
                // managed wrappers for one linked native document, so wrapper
                // Equals/reference identity must not gate this reuse.
                state = candidate;
                return true;
            }
            return false;
        }

        private void AddWrapperAlias(Document document, DocumentState state)
        {
            DocumentState existing;
            if (_documentAliases.TryGetValue(document, out existing))
            {
                if (ReferenceEquals(existing, state)) return;
                _documentAliases.Remove(document);
            }
            _documentAliases.Add(document, state);
        }

        private void RegisterStableAliases(Document document, DocumentState state)
        {
            foreach (string key in ResolveStableDocumentKeys(document))
            {
                DocumentState existing;
                if (_documentsByStableKey.TryGetValue(key, out existing) &&
                    !ReferenceEquals(existing, state))
                {
                    // Strong stable keys are unique among simultaneously open
                    // Revit documents. Do not overwrite another live binding;
                    // its successful DocumentClosed event owns retirement.
                    continue;
                }

                _documentsByStableKey[key] = state;
                state.StableKeys.Add(key);
            }
        }

        private void RefreshStableAliases(Document document, DocumentState state)
        {
            // Save As keeps the native open-document session but transfers its
            // stable identity. Retaining the original path or unsaved key would
            // incorrectly bind a separately reopened original file to this
            // still-open session.
            foreach (string key in state.StableKeys.ToList())
            {
                DocumentState current;
                if (_documentsByStableKey.TryGetValue(key, out current) &&
                    ReferenceEquals(current, state))
                {
                    _documentsByStableKey.Remove(key);
                }
            }
            state.StableKeys.Clear();
            RegisterStableAliases(document, state);
        }

        private void RemoveDocumentState(DocumentState state)
        {
            if (state == null) return;
            foreach (string key in state.StableKeys.ToList())
            {
                DocumentState current;
                if (_documentsByStableKey.TryGetValue(key, out current) &&
                    ReferenceEquals(current, state))
                {
                    _documentsByStableKey.Remove(key);
                }
            }
            state.StableKeys.Clear();

            foreach (int documentId in _closingDocuments
                .Where(item => ReferenceEquals(item.Value, state))
                .Select(item => item.Key)
                .ToList())
            {
                _closingDocuments.Remove(documentId);
            }

            // ConditionalWeakTable has wrapper-identity semantics and cannot
            // enumerate aliases. Replacing it drops stale aliases while the
            // stable-key registry preserves every other open document state.
            _documentAliases = new ConditionalWeakTable<Document, DocumentState>();
        }

        private void ResetDocumentBindings()
        {
            _documentAliases = new ConditionalWeakTable<Document, DocumentState>();
            _documentsByStableKey.Clear();
            _closingDocuments.Clear();
            AdvanceLivenessGeneration();
        }

        private void AdvanceLivenessGeneration()
        {
            checked
            {
                _livenessGeneration++;
            }
        }

        private static IList<string> ResolveStableDocumentKeys(Document document)
        {
            List<string> keys = new List<string>();
            string projectInformationId = TryGetProjectInformationId(document);
            string cloudIdentity = TryGetCloudIdentity(document);
            string centralIdentity = string.IsNullOrWhiteSpace(cloudIdentity)
                ? TryGetCentralIdentity(document)
                : "";
            string path = NormalizeDocumentPath(SafeReadString(delegate { return document.PathName; }));

            if (!string.IsNullOrWhiteSpace(cloudIdentity))
            {
                keys.Add("cloud|" + cloudIdentity);
                if (!string.IsNullOrWhiteSpace(projectInformationId))
                {
                    keys.Add("cloud|" + cloudIdentity + "|project|" + projectInformationId);
                }
            }
            if (!string.IsNullOrWhiteSpace(centralIdentity))
            {
                keys.Add("central|" + centralIdentity);
                if (!string.IsNullOrWhiteSpace(projectInformationId))
                {
                    keys.Add("central|" + centralIdentity + "|project|" + projectInformationId);
                }
            }
            if (!string.IsNullOrWhiteSpace(path))
            {
                keys.Add("path|" + path);
                if (!string.IsNullOrWhiteSpace(projectInformationId))
                {
                    keys.Add("path|" + path + "|project|" + projectInformationId);
                }
            }
            if (keys.Count == 0 && !string.IsNullOrWhiteSpace(projectInformationId))
            {
                string title = SafeReadString(delegate { return document.Title; });
                keys.Add("unsaved|project|" + projectInformationId);
                if (!string.IsNullOrWhiteSpace(title))
                {
                    keys.Add("unsaved|project|" + projectInformationId + "|title|" + title);
                }
            }
            else if (keys.Count == 0)
            {
                try
                {
                    string title = SafeReadString(delegate { return document.Title; });
                    keys.Add("native|" + document.GetHashCode().ToString(CultureInfo.InvariantCulture) + "|title|" + title);
                }
                catch
                {
                }
            }

            return keys.Distinct(StringComparer.Ordinal).ToList();
        }

        private static string TryGetProjectInformationId(Document document)
        {
            return SafeReadString(delegate
            {
                ProjectInfo info = document.ProjectInformation;
                return info != null ? info.UniqueId : "";
            });
        }

        private static string SafeReadString(Func<string> reader)
        {
            try
            {
                return reader != null ? (reader() ?? "").Trim() : "";
            }
            catch
            {
                return "";
            }
        }

        private static string NormalizeDocumentPath(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "";
            try
            {
                value = Path.GetFullPath(value);
            }
            catch
            {
            }
            return value.Replace('\\', '/').Trim().ToUpperInvariant();
        }

        private static string TryGetCloudIdentity(Document document)
        {
            try
            {
                MethodInfo method = document.GetType().GetMethod(
                    "GetCloudModelPath",
                    BindingFlags.Instance | BindingFlags.Public,
                    null,
                    Type.EmptyTypes,
                    null);
                object modelPath = method != null ? method.Invoke(document, null) : null;
                if (modelPath == null) return "";
                Type type = modelPath.GetType();
                PropertyInfo projectProperty = type.GetProperty("ProjectGUID", BindingFlags.Instance | BindingFlags.Public);
                PropertyInfo modelProperty = type.GetProperty("ModelGUID", BindingFlags.Instance | BindingFlags.Public);
                object project = projectProperty != null
                    ? projectProperty.GetValue(modelPath, null)
                    : InvokeNoArg(type, modelPath, "GetProjectGUID");
                object model = modelProperty != null
                    ? modelProperty.GetValue(modelPath, null)
                    : InvokeNoArg(type, modelPath, "GetModelGUID");
                return project != null || model != null ? (project ?? "") + "|" + (model ?? "") : "";
            }
            catch
            {
                return "";
            }
        }

        private static string TryGetCentralIdentity(Document document)
        {
            try
            {
                if (!document.IsWorkshared) return "";
                MethodInfo centralGuidMethod = typeof(WorksharingUtils).GetMethod(
                    "GetCentralGUID",
                    BindingFlags.Public | BindingFlags.Static,
                    null,
                    new[] { typeof(Document) },
                    null);
                object guid = centralGuidMethod != null
                    ? centralGuidMethod.Invoke(null, new object[] { document })
                    : null;
                if (guid != null &&
                    !string.Equals(guid.ToString(), Guid.Empty.ToString(), StringComparison.OrdinalIgnoreCase))
                {
                    return guid.ToString();
                }
            }
            catch
            {
            }

            try
            {
                ModelPath central = document.GetWorksharingCentralModelPath();
                return central != null
                    ? NormalizeDocumentPath(ModelPathUtils.ConvertModelPathToUserVisiblePath(central))
                    : "";
            }
            catch
            {
                return "";
            }
        }

        private static object InvokeNoArg(Type type, object instance, string methodName)
        {
            try
            {
                MethodInfo method = type.GetMethod(
                    methodName,
                    BindingFlags.Instance | BindingFlags.Public,
                    null,
                    Type.EmptyTypes,
                    null);
                return method != null ? method.Invoke(instance, null) : null;
            }
            catch
            {
                return null;
            }
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
            public HashSet<string> StableKeys;
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
