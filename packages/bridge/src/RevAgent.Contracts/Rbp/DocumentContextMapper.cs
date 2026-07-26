#nullable enable

using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.Rbp
{
    public static class DocumentContextMapper
    {
        public static RbpDocumentContextUpdate Map(AddinDocumentContextSnapshot snapshot)
        {
            if (snapshot == null)
            {
                throw new ArgumentNullException(nameof(snapshot));
            }

            var documents = new List<RbpDocumentContextDocument>(snapshot.Documents.Count);
            foreach (var document in snapshot.Documents)
            {
                documents.Add(
                    new RbpDocumentContextDocument(
                        document.DocumentId,
                        document.Title,
                        document.PathDigest,
                        document.IsWorkshared,
                        document.IsActive));
            }

            RbpDocumentContextActiveView? activeView = null;
            if (snapshot.ActiveView != null)
            {
                // activeView.documentId is an add-in ownership assertion. The
                // parser validates it, but it is not part of the frozen RBP shape.
                activeView = new RbpDocumentContextActiveView(
                    snapshot.ActiveView.Id,
                    snapshot.ActiveView.Name,
                    snapshot.ActiveView.Type,
                    snapshot.ActiveView.Level);
            }

            return new RbpDocumentContextUpdate(
                documents.AsReadOnly(),
                snapshot.ActiveDocumentId,
                activeView,
                snapshot.DisciplineHint);
        }

        /// <summary>
        /// Produces the fixed-order, metadata-free RBP payload used by the
        /// watcher diff. Cache timestamps, revision and unavailable details do
        /// not produce spurious document-context updates.
        /// </summary>
        public static string NormalizeForComparison(AddinDocumentContextSnapshot snapshot)
        {
            return ToNormalizedJObject(snapshot).ToString(Formatting.None);
        }

        public static JObject ToNormalizedJObject(AddinDocumentContextSnapshot snapshot)
        {
            var mapped = Map(snapshot);
            var documents = new JArray();
            foreach (var document in mapped.Documents)
            {
                documents.Add(
                    new JObject
                    {
                        ["document_id"] = document.DocumentId,
                        ["title"] = document.Title,
                        ["path_digest"] = document.PathDigest == null
                            ? JValue.CreateNull()
                            : new JValue(document.PathDigest),
                        ["is_workshared"] = document.IsWorkshared,
                        ["is_active"] = document.IsActive,
                    });
            }

            var result = new JObject
            {
                ["documents"] = documents,
                ["active_document"] = mapped.ActiveDocument == null
                    ? JValue.CreateNull()
                    : new JValue(mapped.ActiveDocument),
            };

            if (mapped.ActiveView == null)
            {
                result["active_view"] = JValue.CreateNull();
            }
            else
            {
                result["active_view"] = new JObject
                {
                    ["id"] = mapped.ActiveView.Id,
                    ["name"] = mapped.ActiveView.Name,
                    ["type"] = mapped.ActiveView.Type,
                    ["level"] = mapped.ActiveView.Level == null
                        ? JValue.CreateNull()
                        : new JValue(mapped.ActiveView.Level),
                };
            }

            if (mapped.DisciplineHint != null)
            {
                result["discipline_hint"] = mapped.DisciplineHint;
            }

            return result;
        }
    }
}
