#nullable enable

using System;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.AddinLoopback
{
    /// <summary>
    /// Frozen add-in loopback v1 <c>get_document_context</c> contract constants
    /// (O1 Appendix A.2/A.3 and
    /// packages/protocol/schemas/addin-loopback/v1/get-document-context.schema.json).
    /// The command serves an application-event-maintained cached snapshot; it
    /// never raises a Revit ExternalEvent and is never composed from
    /// <c>get_current_view_info</c> plus <c>list_open_views</c>.
    /// </summary>
    public static class AddinDocumentContextContract
    {
        public const int DocumentContextContractVersion = 1;
        public const string Method = "get_document_context";
        public const string Source = "application_events_cache";
        public const int PollIntervalMs = 15000;

        public const string CacheStateReady = "ready";
        public const string CacheStateWarming = "warming";
        public const string CacheStateUnavailable = "unavailable";

        public const int MaxDocuments = 32;
        public const int MaxDocumentIdLength = 128;
        public const int MaxTitleLength = 512;
        public const int MaxViewIdLength = 64;
        public const int MaxViewNameLength = 512;
        public const int MaxViewTypeLength = 128;
        public const int MaxLevelLength = 512;
        public const int MaxUnavailableReasonLength = 256;
        public const int MaxDisciplineHintLength = 32;

        /// <summary>The largest JSON-safe revision (2^53 - 1).</summary>
        public const long MaxRevision = 9_007_199_254_740_991L;

        /// <summary>Bounded reason served while the cache has no observation yet.</summary>
        public const string WarmingReason =
            "Document context cache has not observed a Revit application event yet";

        /// <summary>Bounded fallback reason for an empty invalidation message.</summary>
        public const string DefaultUnavailableReason =
            "Document context capture failed for an unspecified reason";

        private static readonly Regex Sha256Pattern = new Regex(
            "^sha256:[0-9a-f]{64}$",
            RegexOptions.CultureInvariant);

        private static readonly Regex DisciplinePattern = new Regex(
            "^[a-z][a-z0-9_-]{0,31}$",
            RegexOptions.CultureInvariant);

        /// <summary>
        /// Builds the exact Appendix A.2 <c>doc_context_cached_v1</c> capability
        /// descriptor. The caller MUST advertise it only while the command is
        /// actually served from the application-event-backed cache.
        /// </summary>
        public static AddinDocumentContextCapability CreateCapability()
        {
            return new AddinDocumentContextCapability();
        }

        /// <summary>
        /// Appendix A.3: the request params are the empty object. A missing
        /// params object is tolerated as empty; any property is rejected with
        /// JSON-RPC -32602 before the cache is read.
        /// </summary>
        public static void ValidateRequestParameters(JObject? parameters)
        {
            if (parameters == null)
            {
                return;
            }

            if (parameters.Count > 0)
            {
                throw new AddinDocumentContextRequestException(
                    -32602,
                    "get_document_context params must be an empty object.");
            }
        }

        /// <summary>
        /// Digests a raw model path so it is never present on the wire:
        /// lowercase hex SHA-256 of the exact UTF-8 path bytes with the
        /// <c>sha256:</c> prefix, or null for a document without a path.
        /// </summary>
        public static string? ComputePathDigest(string? modelPath)
        {
            if (string.IsNullOrEmpty(modelPath))
            {
                return null;
            }

            using (SHA256 sha256 = SHA256.Create())
            {
                byte[] hash = sha256.ComputeHash(Encoding.UTF8.GetBytes(modelPath));
                StringBuilder builder = new StringBuilder("sha256:", 7 + (hash.Length * 2));
                foreach (byte value in hash)
                {
                    builder.Append(value.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
                }

                return builder.ToString();
            }
        }

        /// <summary>
        /// Normalizes an invalidation reason to the bounded non-empty A.3
        /// shape: trimmed, never empty, at most 256 Unicode code points.
        /// </summary>
        public static string NormalizeUnavailableReason(string? reason)
        {
            string trimmed = reason == null ? string.Empty : reason.Trim();
            if (trimmed.Length == 0)
            {
                return DefaultUnavailableReason;
            }

            return TruncateByCodePoints(trimmed, MaxUnavailableReasonLength);
        }

        /// <summary>
        /// Normalizes a discipline hint to the frozen token format; a value
        /// that cannot be represented becomes null because the hint is
        /// advisory, never load-bearing.
        /// </summary>
        public static string? NormalizeDisciplineHint(string? hint)
        {
            if (string.IsNullOrEmpty(hint))
            {
                return null;
            }

            string lowered = hint!.Trim().ToLowerInvariant();
            return DisciplinePattern.IsMatch(lowered) ? lowered : null;
        }

        internal static bool IsValidPathDigest(string digest)
        {
            return Sha256Pattern.IsMatch(digest);
        }

        internal static bool IsValidDisciplineHint(string hint)
        {
            return DisciplinePattern.IsMatch(hint);
        }

        internal static string TruncateByCodePoints(string value, int maxCodePoints)
        {
            if (UnicodeCodePointLength.Count(value) <= maxCodePoints)
            {
                return value;
            }

            int codePoints = 0;
            int index = 0;
            while (index < value.Length && codePoints < maxCodePoints)
            {
                index += char.IsHighSurrogate(value[index]) &&
                    index + 1 < value.Length &&
                    char.IsLowSurrogate(value[index + 1])
                        ? 2
                        : 1;
                codePoints++;
            }

            return value.Substring(0, index);
        }

        internal static void RequireBoundedToken(
            string? value,
            string name,
            int maxCodePoints,
            bool allowNull,
            bool allowEmpty)
        {
            if (value == null)
            {
                if (allowNull)
                {
                    return;
                }

                throw new ArgumentException(name + " must not be null.", name);
            }

            if (!allowEmpty && value.Length == 0)
            {
                throw new ArgumentException(name + " must not be empty.", name);
            }

            if (UnicodeCodePointLength.Count(value) > maxCodePoints)
            {
                throw new ArgumentException(
                    name + " exceeds " + maxCodePoints.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                    " code points.",
                    name);
            }
        }
    }

    /// <summary>
    /// A JSON-RPC-mappable rejection raised while validating a
    /// <c>get_document_context</c> request before the cached snapshot is read.
    /// </summary>
    public sealed class AddinDocumentContextRequestException : Exception
    {
        public AddinDocumentContextRequestException(int jsonRpcErrorCode, string message)
            : base(message)
        {
            JsonRpcErrorCode = jsonRpcErrorCode;
        }

        /// <summary>One of the standard v1 codes (-32600 or -32602).</summary>
        public int JsonRpcErrorCode { get; }
    }
}
