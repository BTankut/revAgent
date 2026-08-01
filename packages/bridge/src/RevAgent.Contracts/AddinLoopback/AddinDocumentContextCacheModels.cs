#nullable enable

using System;
using System.Collections.Generic;
using System.Globalization;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.AddinLoopback
{
    /// <summary>
    /// One open, non-linked document as observed by a Revit application event
    /// (Appendix A.3 <c>documents[]</c> without the derived <c>isActive</c>
    /// flag, which the snapshot computes from <c>activeDocumentId</c>).
    /// </summary>
    public sealed class AddinDocumentContextDocumentState
    {
        public AddinDocumentContextDocumentState(
            string documentId,
            string title,
            string? pathDigest,
            bool isWorkshared)
        {
            AddinDocumentContextContract.RequireBoundedToken(
                documentId,
                nameof(documentId),
                AddinDocumentContextContract.MaxDocumentIdLength,
                allowNull: false,
                allowEmpty: false);
            AddinDocumentContextContract.RequireBoundedToken(
                title,
                nameof(title),
                AddinDocumentContextContract.MaxTitleLength,
                allowNull: false,
                allowEmpty: false);
            if (pathDigest != null && !AddinDocumentContextContract.IsValidPathDigest(pathDigest))
            {
                throw new ArgumentException(
                    "pathDigest must be lowercase sha256:<64-hex> or null.",
                    nameof(pathDigest));
            }

            DocumentId = documentId;
            Title = title;
            PathDigest = pathDigest;
            IsWorkshared = isWorkshared;
        }

        public string DocumentId { get; }

        public string Title { get; }

        public string? PathDigest { get; }

        public bool IsWorkshared { get; }

        public bool NormalizedEquals(AddinDocumentContextDocumentState other)
        {
            return other != null &&
                string.Equals(DocumentId, other.DocumentId, StringComparison.Ordinal) &&
                string.Equals(Title, other.Title, StringComparison.Ordinal) &&
                string.Equals(PathDigest, other.PathDigest, StringComparison.Ordinal) &&
                IsWorkshared == other.IsWorkshared;
        }
    }

    /// <summary>
    /// The active view as observed at ViewActivated time (Appendix A.3
    /// <c>activeView</c> without <c>documentId</c>, which the snapshot copies
    /// from <c>activeDocumentId</c> so the cross-field rule holds by
    /// construction).
    /// </summary>
    public sealed class AddinDocumentContextViewState
    {
        public AddinDocumentContextViewState(
            string id,
            string name,
            string type,
            string? level)
        {
            AddinDocumentContextContract.RequireBoundedToken(
                id,
                nameof(id),
                AddinDocumentContextContract.MaxViewIdLength,
                allowNull: false,
                allowEmpty: false);
            AddinDocumentContextContract.RequireBoundedToken(
                name,
                nameof(name),
                AddinDocumentContextContract.MaxViewNameLength,
                allowNull: false,
                allowEmpty: false);
            AddinDocumentContextContract.RequireBoundedToken(
                type,
                nameof(type),
                AddinDocumentContextContract.MaxViewTypeLength,
                allowNull: false,
                allowEmpty: false);
            AddinDocumentContextContract.RequireBoundedToken(
                level,
                nameof(level),
                AddinDocumentContextContract.MaxLevelLength,
                allowNull: true,
                allowEmpty: true);

            Id = id;
            Name = name;
            Type = type;
            Level = level;
        }

        public string Id { get; }

        public string Name { get; }

        public string Type { get; }

        public string? Level { get; }

        public bool NormalizedEquals(AddinDocumentContextViewState other)
        {
            return other != null &&
                string.Equals(Id, other.Id, StringComparison.Ordinal) &&
                string.Equals(Name, other.Name, StringComparison.Ordinal) &&
                string.Equals(Type, other.Type, StringComparison.Ordinal) &&
                string.Equals(Level, other.Level, StringComparison.Ordinal);
        }
    }

    /// <summary>
    /// One immutable Appendix A.3 snapshot of the cached document context.
    /// <see cref="ToResultObject"/> emits the exact frozen success-result key
    /// set; <c>revision</c> only moves through
    /// <see cref="AddinDocumentContextCache"/>.
    /// </summary>
    public sealed class AddinDocumentContextCacheSnapshot
    {
        internal AddinDocumentContextCacheSnapshot(
            DateTimeOffset capturedAtUtc,
            long revision,
            string cacheState,
            string? unavailableReason,
            IReadOnlyList<AddinDocumentContextDocumentState> documents,
            string? activeDocumentId,
            AddinDocumentContextViewState? activeView,
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

        public int ResultContractVersion => AddinJsonRpcCodec.ResultContractVersion;

        public int DocumentContextContractVersion =>
            AddinDocumentContextContract.DocumentContextContractVersion;

        public DateTimeOffset CapturedAtUtc { get; }

        public long Revision { get; }

        public string CacheState { get; }

        public string? UnavailableReason { get; }

        public IReadOnlyList<AddinDocumentContextDocumentState> Documents { get; }

        public string? ActiveDocumentId { get; }

        public AddinDocumentContextViewState? ActiveView { get; }

        public string? DisciplineHint { get; }

        public bool IsReady =>
            string.Equals(
                CacheState,
                AddinDocumentContextContract.CacheStateReady,
                StringComparison.Ordinal);

        /// <summary>RFC 3339 UTC text exactly as serialized on the wire.</summary>
        public string CapturedAtUtcText =>
            CapturedAtUtc.UtcDateTime.ToString(
                "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                CultureInfo.InvariantCulture);

        /// <summary>
        /// Builds the exact Appendix A.3 success result object. Every key is
        /// present, no other key is emitted, and <c>isActive</c> plus
        /// <c>activeView.documentId</c> are derived from
        /// <c>activeDocumentId</c> so the semantic cross-field rules hold.
        /// </summary>
        public JObject ToResultObject()
        {
            JArray documents = new JArray();
            foreach (AddinDocumentContextDocumentState document in Documents)
            {
                documents.Add(new JObject
                {
                    ["documentId"] = document.DocumentId,
                    ["title"] = document.Title,
                    ["pathDigest"] = document.PathDigest == null
                        ? JValue.CreateNull()
                        : (JToken)document.PathDigest,
                    ["isWorkshared"] = document.IsWorkshared,
                    ["isActive"] = ActiveDocumentId != null &&
                        string.Equals(document.DocumentId, ActiveDocumentId, StringComparison.Ordinal),
                });
            }

            JToken activeView = JValue.CreateNull();
            if (ActiveView != null && ActiveDocumentId != null)
            {
                activeView = new JObject
                {
                    ["documentId"] = ActiveDocumentId,
                    ["id"] = ActiveView.Id,
                    ["name"] = ActiveView.Name,
                    ["type"] = ActiveView.Type,
                    ["level"] = ActiveView.Level == null
                        ? JValue.CreateNull()
                        : (JToken)ActiveView.Level,
                };
            }

            return new JObject
            {
                ["resultContractVersion"] = ResultContractVersion,
                ["documentContextContractVersion"] = DocumentContextContractVersion,
                ["capturedAtUtc"] = CapturedAtUtcText,
                ["revision"] = Revision,
                ["cacheState"] = CacheState,
                ["unavailableReason"] = UnavailableReason == null
                    ? JValue.CreateNull()
                    : (JToken)UnavailableReason,
                ["documents"] = documents,
                ["activeDocumentId"] = ActiveDocumentId == null
                    ? JValue.CreateNull()
                    : (JToken)ActiveDocumentId,
                ["activeView"] = activeView,
                ["disciplineHint"] = DisciplineHint == null
                    ? JValue.CreateNull()
                    : (JToken)DisciplineHint,
            };
        }
    }
}
