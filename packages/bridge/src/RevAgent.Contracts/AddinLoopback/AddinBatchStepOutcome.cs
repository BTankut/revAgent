#nullable enable

using System;
using System.Text;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.AddinLoopback
{
    public enum AddinBatchStepExecutionState
    {
        Completed,
        Guarded,
        Failed,
    }

    /// <summary>
    /// The normalized outcome of one executed batch step before envelope
    /// construction. Step error codes are the exact Appendix A.4 set.
    /// </summary>
    public sealed class AddinBatchStepOutcome
    {
        public const string CommandFailureCode = "command_failure";
        public const string RevitApiCode = "revit_api";
        public const string InvalidResultCode = "invalid_result";
        public const string ResponsePayloadLimitCode = "response_payload_limit";

        private const int MaxErrorMessageChars = 600;
        private const int MaxGuardedReasonChars = 64;

        private AddinBatchStepOutcome(
            AddinBatchStepExecutionState state,
            JToken? result,
            string? guardedReason,
            string? errorCode,
            string? errorMessage,
            long? maxResponsePayloadBytes,
            long? tentativeResponsePayloadBytes)
        {
            State = state;
            Result = result;
            GuardedReason = guardedReason;
            ErrorCode = errorCode;
            ErrorMessage = errorMessage;
            MaxResponsePayloadBytes = maxResponsePayloadBytes;
            TentativeResponsePayloadBytes = tentativeResponsePayloadBytes;
        }

        public AddinBatchStepExecutionState State { get; }

        public JToken? Result { get; }

        public string? GuardedReason { get; }

        public string? ErrorCode { get; }

        public string? ErrorMessage { get; }

        public long? MaxResponsePayloadBytes { get; }

        public long? TentativeResponsePayloadBytes { get; }

        public static AddinBatchStepOutcome Completed(JToken? result)
        {
            return new AddinBatchStepOutcome(
                AddinBatchStepExecutionState.Completed,
                result ?? JValue.CreateNull(),
                null,
                null,
                null,
                null,
                null);
        }

        public static AddinBatchStepOutcome Guarded(string? reason)
        {
            return new AddinBatchStepOutcome(
                AddinBatchStepExecutionState.Guarded,
                null,
                NormalizeGuardedReason(reason),
                null,
                null,
                null,
                null);
        }

        public static AddinBatchStepOutcome Failed(string errorCode, string? message)
        {
            return new AddinBatchStepOutcome(
                AddinBatchStepExecutionState.Failed,
                null,
                null,
                errorCode,
                BoundMessage(message),
                null,
                null);
        }

        public static AddinBatchStepOutcome ResponsePayloadLimit(
            long maxResponsePayloadBytes,
            long tentativeResponsePayloadBytes)
        {
            return new AddinBatchStepOutcome(
                AddinBatchStepExecutionState.Failed,
                null,
                null,
                ResponsePayloadLimitCode,
                BoundMessage("Tentative batch response exceeds the aggregate result cap"),
                maxResponsePayloadBytes,
                tentativeResponsePayloadBytes);
        }

        /// <summary>
        /// Classifies a canonical camelCase command result into a batch step
        /// outcome. Mirrors the frozen loopback fixture: an explicit guard
        /// signal stops the batch as <c>guarded</c>, a failure-shaped result
        /// stops it as <c>failed</c>, and anything else is a completed inline
        /// result.
        /// </summary>
        public static AddinBatchStepOutcome FromCommandResult(JToken? result)
        {
            if (!(result is JObject obj))
            {
                return Completed(result);
            }

            if (IsTrue(obj, "guarded") ||
                IsTrue(obj, "blocked") ||
                IsTrue(obj, "focusBlocked") ||
                HasStateValue(obj, "guarded"))
            {
                return Guarded(ExtractText(
                    obj,
                    "guardedReason",
                    "reason",
                    "focusBlockReason",
                    "blockReason",
                    "guardReason",
                    "safetyReason"));
            }

            if (IsFalse(obj, "success") || HasStateValue(obj, "failed"))
            {
                string? message = ExtractText(obj, "errorMessage", "message", "error", "reason");
                return Failed(
                    CommandFailureCode,
                    string.IsNullOrEmpty(message) ? "Command returned a failure result" : message);
            }

            JToken? error = obj["error"];
            if (error != null && error.Type != JTokenType.Null)
            {
                string message = error.Type == JTokenType.String
                    ? error.Value<string>() ?? string.Empty
                    : error.ToString(Newtonsoft.Json.Formatting.None);
                if (!string.IsNullOrEmpty(message))
                {
                    return Failed(CommandFailureCode, message);
                }
            }

            return Completed(obj);
        }

        public static string NormalizeGuardedReason(string? reason)
        {
            string source = string.IsNullOrEmpty(reason) ? "guarded" : reason!;
            StringBuilder builder = new StringBuilder(source.Length);
            foreach (char character in source.ToLowerInvariant())
            {
                bool valid = (character >= 'a' && character <= 'z') ||
                    (character >= '0' && character <= '9') ||
                    character == '_';
                builder.Append(valid ? character : '_');
            }

            string token = builder.ToString().TrimStart('_');
            if (token.Length == 0)
            {
                token = "guarded";
            }
            else if (token[0] < 'a' || token[0] > 'z')
            {
                token = "guarded_" + token;
            }

            return token.Length > MaxGuardedReasonChars ? token.Substring(0, MaxGuardedReasonChars) : token;
        }

        public static string BoundMessage(string? message)
        {
            string text = string.IsNullOrEmpty(message) ? "Unknown batch step error" : message!;
            return text.Length > MaxErrorMessageChars ? text.Substring(0, MaxErrorMessageChars) : text;
        }

        private static bool IsTrue(JObject obj, string name)
        {
            JToken? token = obj[name];
            return token != null && token.Type == JTokenType.Boolean && token.Value<bool>();
        }

        private static bool IsFalse(JObject obj, string name)
        {
            JToken? token = obj[name];
            return token != null && token.Type == JTokenType.Boolean && !token.Value<bool>();
        }

        private static bool HasStateValue(JObject obj, string expected)
        {
            JToken? token = obj["state"];
            return token != null &&
                token.Type == JTokenType.String &&
                string.Equals(token.Value<string>(), expected, StringComparison.OrdinalIgnoreCase);
        }

        private static string? ExtractText(JObject obj, params string[] keys)
        {
            foreach (string key in keys)
            {
                JToken? token = obj[key];
                if (token == null || token.Type == JTokenType.Null)
                {
                    continue;
                }

                string text = token.Type == JTokenType.String
                    ? token.Value<string>() ?? string.Empty
                    : token.ToString(Newtonsoft.Json.Formatting.None);
                if (!string.IsNullOrWhiteSpace(text))
                {
                    return text;
                }
            }

            return null;
        }
    }
}
