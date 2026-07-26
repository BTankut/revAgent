#nullable enable

using System;
using System.Collections.Generic;
using Newtonsoft.Json;

namespace RevAgent.Contracts.Rbp
{
    public enum DocumentContextCacheState
    {
        Ready,
        Warming,
        Unavailable,
    }

    public sealed class AddinDocumentContextResponse
    {
        internal AddinDocumentContextResponse(string requestId, AddinDocumentContextSnapshot context)
        {
            RequestId = requestId;
            Context = context;
        }

        public string RequestId { get; }

        public AddinDocumentContextSnapshot Context { get; }
    }

    public sealed class AddinDocumentContextSnapshot
    {
        internal AddinDocumentContextSnapshot(
            DateTimeOffset capturedAtUtc,
            long revision,
            DocumentContextCacheState cacheState,
            string? unavailableReason,
            IReadOnlyList<AddinDocumentContextDocument> documents,
            string? activeDocumentId,
            AddinDocumentContextActiveView? activeView,
            string? disciplineHint)
        {
            CapturedAtUtc = capturedAtUtc;
            Revision = revision;
            CacheState = cacheState;
            UnavailableReason = unavailableReason;
            Documents = documents;
            ActiveDocumentId = activeDocumentId;
            ActiveView = activeView;
            DisciplineHint = disciplineHint;
        }

        public int ResultContractVersion => 2;

        public int DocumentContextContractVersion => 1;

        public DateTimeOffset CapturedAtUtc { get; }

        public long Revision { get; }

        public DocumentContextCacheState CacheState { get; }

        public string? UnavailableReason { get; }

        public IReadOnlyList<AddinDocumentContextDocument> Documents { get; }

        public string? ActiveDocumentId { get; }

        public AddinDocumentContextActiveView? ActiveView { get; }

        public string? DisciplineHint { get; }
    }

    public sealed class AddinDocumentContextDocument
    {
        internal AddinDocumentContextDocument(
            string documentId,
            string title,
            string? pathDigest,
            bool isWorkshared,
            bool isActive)
        {
            DocumentId = documentId;
            Title = title;
            PathDigest = pathDigest;
            IsWorkshared = isWorkshared;
            IsActive = isActive;
        }

        public string DocumentId { get; }

        public string Title { get; }

        public string? PathDigest { get; }

        public bool IsWorkshared { get; }

        public bool IsActive { get; }
    }

    public sealed class AddinDocumentContextActiveView
    {
        internal AddinDocumentContextActiveView(
            string documentId,
            string id,
            string name,
            string type,
            string? level)
        {
            DocumentId = documentId;
            Id = id;
            Name = name;
            Type = type;
            Level = level;
        }

        public string DocumentId { get; }

        public string Id { get; }

        public string Name { get; }

        public string Type { get; }

        public string? Level { get; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    public sealed class RbpDocumentContextUpdate
    {
        internal RbpDocumentContextUpdate(
            IReadOnlyList<RbpDocumentContextDocument> documents,
            string? activeDocument,
            RbpDocumentContextActiveView? activeView,
            string? disciplineHint)
        {
            Documents = documents;
            ActiveDocument = activeDocument;
            ActiveView = activeView;
            DisciplineHint = disciplineHint;
        }

        [JsonProperty("documents", Order = 1)]
        public IReadOnlyList<RbpDocumentContextDocument> Documents { get; }

        [JsonProperty("active_document", Order = 2)]
        public string? ActiveDocument { get; }

        [JsonProperty("active_view", Order = 3)]
        public RbpDocumentContextActiveView? ActiveView { get; }

        [JsonProperty("discipline_hint", Order = 4, NullValueHandling = NullValueHandling.Ignore)]
        public string? DisciplineHint { get; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    public sealed class RbpDocumentContextDocument
    {
        internal RbpDocumentContextDocument(
            string documentId,
            string title,
            string? pathDigest,
            bool isWorkshared,
            bool isActive)
        {
            DocumentId = documentId;
            Title = title;
            PathDigest = pathDigest;
            IsWorkshared = isWorkshared;
            IsActive = isActive;
        }

        [JsonProperty("document_id", Order = 1)]
        public string DocumentId { get; }

        [JsonProperty("title", Order = 2)]
        public string Title { get; }

        [JsonProperty("path_digest", Order = 3)]
        public string? PathDigest { get; }

        [JsonProperty("is_workshared", Order = 4)]
        public bool IsWorkshared { get; }

        [JsonProperty("is_active", Order = 5)]
        public bool IsActive { get; }
    }

    [JsonObject(MemberSerialization.OptIn)]
    public sealed class RbpDocumentContextActiveView
    {
        internal RbpDocumentContextActiveView(string id, string name, string type, string? level)
        {
            Id = id;
            Name = name;
            Type = type;
            Level = level;
        }

        [JsonProperty("id", Order = 1)]
        public string Id { get; }

        [JsonProperty("name", Order = 2)]
        public string Name { get; }

        [JsonProperty("type", Order = 3)]
        public string Type { get; }

        [JsonProperty("level", Order = 4)]
        public string? Level { get; }
    }
}
