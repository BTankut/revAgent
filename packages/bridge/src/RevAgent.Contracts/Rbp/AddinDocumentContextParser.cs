#nullable enable

using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.AddinLoopback;

namespace RevAgent.Contracts.Rbp
{
    /// <summary>
    /// Closed parser for the frozen add-in loopback v1 get_document_context
    /// success response. Unlike RBP envelopes, this local contract does not
    /// permit additive properties.
    /// </summary>
    public static class AddinDocumentContextParser
    {
        private const long MaxJsonSafeInteger = 9_007_199_254_740_991L;

        private static readonly Regex Sha256Pattern = new Regex(
            "^sha256:[0-9a-f]{64}$",
            RegexOptions.CultureInvariant);

        private static readonly Regex DisciplinePattern = new Regex(
            "^[a-z][a-z0-9_-]{0,31}$",
            RegexOptions.CultureInvariant);

        private static readonly Regex Rfc3339Pattern = new Regex(
            "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$",
            RegexOptions.CultureInvariant);

        private static readonly string[] ResponseProperties =
        {
            "jsonrpc",
            "id",
            "result",
        };

        private static readonly string[] ResultProperties =
        {
            "resultContractVersion",
            "documentContextContractVersion",
            "capturedAtUtc",
            "revision",
            "cacheState",
            "unavailableReason",
            "documents",
            "activeDocumentId",
            "activeView",
            "disciplineHint",
        };

        private static readonly string[] DocumentProperties =
        {
            "documentId",
            "title",
            "pathDigest",
            "isWorkshared",
            "isActive",
        };

        private static readonly string[] ActiveViewProperties =
        {
            "documentId",
            "id",
            "name",
            "type",
            "level",
        };

        public static AddinDocumentContextResponse ParseResponse(string json)
        {
            var root = ParseStrictObject(json, "get_document_context response");
            RequireExactProperties(root, ResponseProperties, "response");

            if (RequireString(root, "jsonrpc", "response", 3, false) != "2.0")
            {
                throw Invalid("response.jsonrpc must equal \"2.0\"");
            }

            var requestId = RequireString(root, "id", "response", 128, true);
            var result = RequireObject(root, "result", "response");
            return new AddinDocumentContextResponse(requestId, ParseResult(result));
        }

        public static AddinDocumentContextSnapshot ParseResult(JObject result)
        {
            if (result == null)
            {
                throw new ArgumentNullException(nameof(result));
            }

            RequireExactProperties(result, ResultProperties, "result");
            RequireInteger(result, "resultContractVersion", "result", 2, 2);
            RequireInteger(result, "documentContextContractVersion", "result", 1, 1);

            var capturedAtText = RequireString(result, "capturedAtUtc", "result", 64, true);
            var capturedAt = ParseRfc3339(capturedAtText, "result.capturedAtUtc");
            var revision = RequireInteger(result, "revision", "result", 0, MaxJsonSafeInteger);
            var cacheState = ParseCacheState(RequireString(result, "cacheState", "result", 11, true));
            var unavailableReason = RequireNullableString(
                result,
                "unavailableReason",
                "result",
                256,
                allowEmpty: false);

            var documentsToken = RequireArray(result, "documents", "result");
            if (documentsToken.Count > 32)
            {
                throw Invalid("result.documents exceeds the 32-document limit");
            }

            var documents = new List<AddinDocumentContextDocument>(documentsToken.Count);
            var documentIds = new HashSet<string>(StringComparer.Ordinal);
            var activeDocuments = new List<AddinDocumentContextDocument>();
            for (var index = 0; index < documentsToken.Count; index++)
            {
                var path = "result.documents[" + index.ToString(CultureInfo.InvariantCulture) + "]";
                if (!(documentsToken[index] is JObject documentObject))
                {
                    throw Invalid(path + " must be an object");
                }

                var document = ParseDocument(documentObject, path);
                if (!documentIds.Add(document.DocumentId))
                {
                    throw Invalid("result.documents contains duplicate documentId \"" + document.DocumentId + "\"");
                }

                documents.Add(document);
                if (document.IsActive)
                {
                    activeDocuments.Add(document);
                }
            }

            if (activeDocuments.Count > 1)
            {
                throw Invalid("result.documents contains more than one active document");
            }

            var activeDocumentId = RequireNullableString(
                result,
                "activeDocumentId",
                "result",
                128,
                allowEmpty: false);

            AddinDocumentContextActiveView? activeView = null;
            var activeViewToken = result["activeView"];
            if (activeViewToken == null)
            {
                throw Invalid("result.activeView is required");
            }

            if (activeViewToken.Type != JTokenType.Null)
            {
                if (!(activeViewToken is JObject activeViewObject))
                {
                    throw Invalid("result.activeView must be an object or null");
                }

                activeView = ParseActiveView(activeViewObject, "result.activeView");
            }

            var disciplineHint = RequireNullableString(
                result,
                "disciplineHint",
                "result",
                32,
                allowEmpty: false);
            if (disciplineHint != null && !DisciplinePattern.IsMatch(disciplineHint))
            {
                throw Invalid("result.disciplineHint does not match the frozen token format");
            }

            ValidateStateInvariants(
                cacheState,
                unavailableReason,
                documents,
                activeDocuments,
                activeDocumentId,
                activeView,
                disciplineHint);

            return new AddinDocumentContextSnapshot(
                capturedAt,
                revision,
                cacheState,
                unavailableReason,
                new ReadOnlyCollection<AddinDocumentContextDocument>(documents),
                activeDocumentId,
                activeView,
                disciplineHint);
        }

        private static AddinDocumentContextDocument ParseDocument(JObject value, string path)
        {
            RequireExactProperties(value, DocumentProperties, path);
            var documentId = RequireString(value, "documentId", path, 128, true);
            var title = RequireString(value, "title", path, 512, true);
            var pathDigest = RequireNullableString(value, "pathDigest", path, 71, allowEmpty: false);
            if (pathDigest != null && !Sha256Pattern.IsMatch(pathDigest))
            {
                throw Invalid(path + ".pathDigest must be lowercase sha256:<64-hex>");
            }

            return new AddinDocumentContextDocument(
                documentId,
                title,
                pathDigest,
                RequireBoolean(value, "isWorkshared", path),
                RequireBoolean(value, "isActive", path));
        }

        private static AddinDocumentContextActiveView ParseActiveView(JObject value, string path)
        {
            RequireExactProperties(value, ActiveViewProperties, path);
            return new AddinDocumentContextActiveView(
                RequireString(value, "documentId", path, 128, true),
                RequireString(value, "id", path, 64, true),
                RequireString(value, "name", path, 512, true),
                RequireString(value, "type", path, 128, true),
                RequireNullableString(value, "level", path, 512, allowEmpty: true));
        }

        private static void ValidateStateInvariants(
            DocumentContextCacheState cacheState,
            string? unavailableReason,
            IReadOnlyCollection<AddinDocumentContextDocument> documents,
            IReadOnlyList<AddinDocumentContextDocument> activeDocuments,
            string? activeDocumentId,
            AddinDocumentContextActiveView? activeView,
            string? disciplineHint)
        {
            if (cacheState != DocumentContextCacheState.Ready)
            {
                if (string.IsNullOrEmpty(unavailableReason))
                {
                    throw Invalid("non-ready result.unavailableReason must be a non-empty string");
                }

                if (documents.Count != 0 ||
                    activeDocumentId != null ||
                    activeView != null ||
                    disciplineHint != null)
                {
                    throw Invalid("warming/unavailable context must not carry documents, active context, or discipline");
                }

                return;
            }

            if (unavailableReason != null)
            {
                throw Invalid("ready result.unavailableReason must be null");
            }

            if (activeDocumentId == null)
            {
                if (activeDocuments.Count != 0)
                {
                    throw Invalid("an active document row exists while result.activeDocumentId is null");
                }

                if (activeView != null)
                {
                    throw Invalid("result.activeView must be null when result.activeDocumentId is null");
                }

                return;
            }

            if (activeDocuments.Count != 1 ||
                !string.Equals(activeDocuments[0].DocumentId, activeDocumentId, StringComparison.Ordinal))
            {
                throw Invalid("result.activeDocumentId must identify the sole isActive document");
            }

            if (activeView != null &&
                !string.Equals(activeView.DocumentId, activeDocumentId, StringComparison.Ordinal))
            {
                throw Invalid("result.activeView.documentId must equal result.activeDocumentId");
            }
        }

        private static JObject ParseStrictObject(string json, string path)
        {
            if (json == null)
            {
                throw new ArgumentNullException(nameof(json));
            }

            try
            {
                return StrictJson.ParseObject(json);
            }
            catch (RbpContractException)
            {
                throw;
            }
            catch (StrictJsonException ex)
            {
                throw new RbpContractException(path + " is not strict JSON", ex);
            }
        }

        private static DateTimeOffset ParseRfc3339(string value, string path)
        {
            if (!Rfc3339Pattern.IsMatch(value) ||
                !DateTimeOffset.TryParse(
                    value,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out var parsed))
            {
                throw Invalid(path + " must be an RFC 3339 date-time");
            }

            return parsed;
        }

        private static DocumentContextCacheState ParseCacheState(string value)
        {
            switch (value)
            {
                case "ready":
                    return DocumentContextCacheState.Ready;
                case "warming":
                    return DocumentContextCacheState.Warming;
                case "unavailable":
                    return DocumentContextCacheState.Unavailable;
                default:
                    throw Invalid("result.cacheState is not a frozen v1 state");
            }
        }

        private static void RequireExactProperties(JObject value, IEnumerable<string> expected, string path)
        {
            var remaining = new HashSet<string>(expected, StringComparer.Ordinal);
            foreach (var property in value.Properties())
            {
                if (!remaining.Remove(property.Name))
                {
                    throw Invalid(path + " contains unexpected property \"" + property.Name + "\"");
                }
            }

            if (remaining.Count != 0)
            {
                foreach (var missing in remaining)
                {
                    throw Invalid(path + " is missing required property \"" + missing + "\"");
                }
            }
        }

        private static JObject RequireObject(JObject parent, string name, string path)
        {
            var token = parent[name];
            if (!(token is JObject value))
            {
                throw Invalid(path + "." + name + " must be an object");
            }

            return value;
        }

        private static JArray RequireArray(JObject parent, string name, string path)
        {
            var token = parent[name];
            if (!(token is JArray value))
            {
                throw Invalid(path + "." + name + " must be an array");
            }

            return value;
        }

        private static string RequireString(
            JObject parent,
            string name,
            string path,
            int maxLength,
            bool requireNonEmpty)
        {
            var token = parent[name];
            if (token == null || token.Type != JTokenType.String)
            {
                throw Invalid(path + "." + name + " must be a string");
            }

            var value = token.Value<string>()!;
            ValidateStringLength(value, path + "." + name, maxLength, requireNonEmpty);
            return value;
        }

        private static string? RequireNullableString(
            JObject parent,
            string name,
            string path,
            int maxLength,
            bool allowEmpty)
        {
            var token = parent[name];
            if (token == null)
            {
                throw Invalid(path + "." + name + " is required");
            }

            if (token.Type == JTokenType.Null)
            {
                return null;
            }

            if (token.Type != JTokenType.String)
            {
                throw Invalid(path + "." + name + " must be a string or null");
            }

            var value = token.Value<string>()!;
            ValidateStringLength(value, path + "." + name, maxLength, !allowEmpty);
            return value;
        }

        private static void ValidateStringLength(
            string value,
            string path,
            int maxLength,
            bool requireNonEmpty)
        {
            if (requireNonEmpty && value.Length == 0)
            {
                throw Invalid(path + " must not be empty");
            }

            if (UnicodeCodePointLength.Count(value) > maxLength)
            {
                throw Invalid(path + " exceeds its maximum length");
            }
        }

        private static bool RequireBoolean(JObject parent, string name, string path)
        {
            var token = parent[name];
            if (token == null || token.Type != JTokenType.Boolean)
            {
                throw Invalid(path + "." + name + " must be a boolean");
            }

            return token.Value<bool>();
        }

        private static long RequireInteger(
            JObject parent,
            string name,
            string path,
            long minimum,
            long maximum)
        {
            var token = parent[name];
            long value;
            JsonIntegerReadResult readResult =
                JsonIntegerValue.TryReadExactInt64(token, out value);
            if (readResult == JsonIntegerReadResult.NotInteger)
            {
                throw Invalid(path + "." + name + " must be an integer");
            }

            if (readResult == JsonIntegerReadResult.OutsideInt64Range)
            {
                throw Invalid(path + "." + name + " is outside Int64 range");
            }

            if (value < minimum || value > maximum)
            {
                throw Invalid(path + "." + name + " is outside its frozen range");
            }

            return value;
        }

        private static RbpContractException Invalid(string message) =>
            new RbpContractException(message);
    }
}
