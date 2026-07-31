#nullable enable

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.AddinLoopback
{
    /// <summary>
    /// Validates a complete <c>execute_batch</c> request against Appendix A.4
    /// and execute-batch.schema.json before any Revit execution. Every
    /// rejection is an <see cref="AddinBatchRequestException"/> that maps to a
    /// standard JSON-RPC error response with zero executed steps and no open
    /// TransactionGroup.
    /// </summary>
    public static class AddinBatchRequestParser
    {
        private const int InvalidRequestCode = -32600;
        private const int InvalidParamsCode = -32602;
        private const long MaxAggregateResultBytesCeiling = 33554432;

        private static readonly Regex UuidV7Pattern = new Regex(
            "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            RegexOptions.CultureInvariant);

        private static readonly Regex Sha256Pattern = new Regex(
            "^sha256:[0-9a-f]{64}$",
            RegexOptions.CultureInvariant);

        private static readonly string[] RequiredParamsKeys =
        {
            "batchContractVersion",
            "batchId",
            "batchDigest",
            "atomic",
            "rollbackPolicy",
            "maxAggregateResultBytes",
            "steps",
        };

        private static readonly string[] RequiredStepKeys =
        {
            "index",
            "invocationId",
            "method",
            "params",
            "paramsDigest",
            "effect",
        };

        private static readonly string[] AllowedDeleteReviewViewKeys =
        {
            "viewId",
            "viewName",
            "viewType",
            "exactName",
            "mode",
            "confirmDelete",
        };

        public static AddinBatchRequest Parse(string? requestId, JObject? parameters)
        {
            if (string.IsNullOrEmpty(requestId))
            {
                throw Invalid(InvalidRequestCode, "execute_batch requires a non-empty request id");
            }

            if (parameters == null)
            {
                throw Invalid(InvalidParamsCode, "execute_batch.params must be an object");
            }

            RequireExactKeys(parameters, RequiredParamsKeys, "execute_batch.params");

            if (!IsInteger(parameters["batchContractVersion"], out long contractVersion) ||
                contractVersion != AddinBatchContract.BatchContractVersion)
            {
                throw Invalid(InvalidParamsCode, "execute_batch.params.batchContractVersion must equal 1");
            }

            string batchId = RequireString(parameters, "batchId", "execute_batch.params.batchId");
            if (!UuidV7Pattern.IsMatch(batchId))
            {
                throw Invalid(InvalidParamsCode, "execute_batch.params.batchId must be a lowercase UUIDv7");
            }

            if (!string.Equals(requestId, batchId, StringComparison.Ordinal))
            {
                throw Invalid(InvalidParamsCode, "execute_batch request id must equal params.batchId");
            }

            string batchDigest = RequireString(parameters, "batchDigest", "execute_batch.params.batchDigest");
            if (!Sha256Pattern.IsMatch(batchDigest))
            {
                throw Invalid(InvalidParamsCode, "execute_batch.params.batchDigest must be a sha256: digest");
            }

            JToken? atomic = parameters["atomic"];
            if (atomic == null || atomic.Type != JTokenType.Boolean || !atomic.Value<bool>())
            {
                throw Invalid(InvalidParamsCode, "execute_batch.params.atomic must equal true");
            }

            string rollbackPolicy = RequireString(parameters, "rollbackPolicy", "execute_batch.params.rollbackPolicy");
            if (!string.Equals(rollbackPolicy, AddinBatchContract.RollbackPolicy, StringComparison.Ordinal))
            {
                throw Invalid(
                    InvalidParamsCode,
                    "execute_batch.params.rollbackPolicy must equal rollback_on_non_success");
            }

            if (!IsInteger(parameters["maxAggregateResultBytes"], out long maxAggregateResultBytes) ||
                maxAggregateResultBytes < 1 ||
                maxAggregateResultBytes > MaxAggregateResultBytesCeiling)
            {
                throw Invalid(
                    InvalidParamsCode,
                    "execute_batch.params.maxAggregateResultBytes must be an integer from 1 through 33554432");
            }

            if (!(parameters["steps"] is JArray stepsArray))
            {
                throw Invalid(InvalidParamsCode, "execute_batch.params.steps must be an array");
            }

            if (stepsArray.Count < 1 || stepsArray.Count > AddinBatchContract.MaxSteps)
            {
                throw Invalid(
                    InvalidParamsCode,
                    "execute_batch.params.steps must contain from 1 through 64 steps");
            }

            List<AddinBatchStep> steps = new List<AddinBatchStep>(stepsArray.Count);
            HashSet<string> invocationIds = new HashSet<string>(StringComparer.Ordinal);
            for (int index = 0; index < stepsArray.Count; index++)
            {
                steps.Add(ParseStep(stepsArray[index], index, invocationIds));
            }

            return new AddinBatchRequest(batchId, batchDigest, maxAggregateResultBytes, steps);
        }

        private static AddinBatchStep ParseStep(JToken token, int index, HashSet<string> invocationIds)
        {
            string label = "execute_batch.steps[" + index + "]";
            if (!(token is JObject step))
            {
                throw Invalid(InvalidParamsCode, label + " must be an object");
            }

            RequireExactKeys(step, RequiredStepKeys, label);

            if (!IsInteger(step["index"], out long declaredIndex) || declaredIndex != index)
            {
                throw Invalid(InvalidParamsCode, label + ".index is not contiguous from zero");
            }

            string invocationId = RequireString(step, "invocationId", label + ".invocationId");
            if (!UuidV7Pattern.IsMatch(invocationId))
            {
                throw Invalid(InvalidParamsCode, label + ".invocationId must be a lowercase UUIDv7");
            }

            if (!invocationIds.Add(invocationId))
            {
                throw Invalid(InvalidParamsCode, label + ".invocationId is duplicated");
            }

            string method = RequireString(step, "method", label + ".method");
            if (!AddinBatchContract.TryGetDescriptor(method, out AddinBatchableCommand descriptor))
            {
                throw Invalid(InvalidParamsCode, label + ".method is not a batchable v1 command: " + method);
            }

            string effect = RequireString(step, "effect", label + ".effect");
            if (!string.Equals(effect, descriptor.Effect, StringComparison.Ordinal))
            {
                throw Invalid(InvalidParamsCode, label + ".effect differs from the advertised descriptor");
            }

            if (!(step["params"] is JObject stepParams))
            {
                throw Invalid(InvalidParamsCode, label + ".params must be an object");
            }

            string paramsDigest = RequireString(step, "paramsDigest", label + ".paramsDigest");
            if (!Sha256Pattern.IsMatch(paramsDigest))
            {
                throw Invalid(InvalidParamsCode, label + ".paramsDigest must be a sha256: digest");
            }

            if (string.Equals(
                descriptor.ParameterProfile,
                AddinBatchContract.DeleteReviewViewParameterProfile,
                StringComparison.Ordinal))
            {
                ValidateDeleteReviewViewParams(stepParams, label);
            }
            else
            {
                ValidateOrdinaryParams(stepParams, label);
            }

            return new AddinBatchStep(index, invocationId, method, stepParams, paramsDigest, effect);
        }

        private static void ValidateOrdinaryParams(JObject stepParams, string label)
        {
            foreach (JProperty property in stepParams.Properties())
            {
                if (AddinBatchContract.IsReservedOrdinaryParameterName(property.Name))
                {
                    throw Invalid(
                        InvalidParamsCode,
                        label + ".params contains the reserved name " + property.Name);
                }
            }
        }

        private static void ValidateDeleteReviewViewParams(JObject stepParams, string label)
        {
            foreach (JProperty property in stepParams.Properties())
            {
                if (Array.IndexOf(AllowedDeleteReviewViewKeys, property.Name) < 0)
                {
                    throw Invalid(
                        InvalidParamsCode,
                        label + ".params contains an unsupported delete_review_view field: " + property.Name);
                }
            }

            JToken? mode = stepParams["mode"];
            if (mode == null || mode.Type != JTokenType.String ||
                !string.Equals(mode.Value<string>(), "commit", StringComparison.Ordinal))
            {
                throw Invalid(InvalidParamsCode, label + ".params.mode must equal commit");
            }

            JToken? confirmDelete = stepParams["confirmDelete"];
            if (confirmDelete == null || confirmDelete.Type != JTokenType.Boolean || !confirmDelete.Value<bool>())
            {
                throw Invalid(InvalidParamsCode, label + ".params.confirmDelete must equal true");
            }

            JToken? viewType = stepParams["viewType"];
            if (viewType != null &&
                (viewType.Type != JTokenType.String ||
                 !string.Equals(viewType.Value<string>(), "ThreeD", StringComparison.Ordinal)))
            {
                throw Invalid(InvalidParamsCode, label + ".params.viewType must equal ThreeD when present");
            }

            JToken? viewId = stepParams["viewId"];
            JToken? viewName = stepParams["viewName"];
            JToken? exactName = stepParams["exactName"];
            bool hasViewId = viewId != null;
            bool hasViewName = viewName != null;
            if (hasViewId == hasViewName)
            {
                throw Invalid(
                    InvalidParamsCode,
                    label + ".params must select exactly one of viewId or viewName");
            }

            if (hasViewId)
            {
                if (!IsInteger(viewId, out long viewIdValue) || viewIdValue < 1 || viewIdValue > int.MaxValue)
                {
                    throw Invalid(InvalidParamsCode, label + ".params.viewId must be a positive 32-bit integer");
                }

                if (exactName != null)
                {
                    throw Invalid(InvalidParamsCode, label + ".params.exactName requires the viewName selector");
                }
            }
            else
            {
                if (viewName!.Type != JTokenType.String)
                {
                    throw Invalid(InvalidParamsCode, label + ".params.viewName must be a string");
                }

                string viewNameValue = viewName.Value<string>() ?? string.Empty;
                if (viewNameValue.Length < 1 || viewNameValue.Length > 512)
                {
                    throw Invalid(
                        InvalidParamsCode,
                        label + ".params.viewName must contain from 1 through 512 characters");
                }

                if (exactName == null || exactName.Type != JTokenType.Boolean || !exactName.Value<bool>())
                {
                    throw Invalid(
                        InvalidParamsCode,
                        label + ".params.exactName must equal true with the viewName selector");
                }
            }
        }

        private static void RequireExactKeys(JObject value, string[] keys, string label)
        {
            foreach (string key in keys)
            {
                if (value.Property(key, StringComparison.Ordinal) == null)
                {
                    throw Invalid(InvalidParamsCode, label + " is missing required field " + key);
                }
            }

            foreach (JProperty property in value.Properties())
            {
                if (Array.IndexOf(keys, property.Name) < 0)
                {
                    throw Invalid(InvalidParamsCode, label + " contains an unsupported field: " + property.Name);
                }
            }
        }

        private static string RequireString(JObject value, string key, string label)
        {
            JToken? token = value[key];
            if (token == null || token.Type != JTokenType.String)
            {
                throw Invalid(InvalidParamsCode, label + " must be a string");
            }

            string text = token.Value<string>() ?? string.Empty;
            if (text.Length == 0)
            {
                throw Invalid(InvalidParamsCode, label + " must not be empty");
            }

            return text;
        }

        private static bool IsInteger(JToken? token, out long value)
        {
            value = 0;
            if (token == null || token.Type != JTokenType.Integer)
            {
                return false;
            }

            value = token.Value<long>();
            return true;
        }

        private static AddinBatchRequestException Invalid(int code, string message)
        {
            return new AddinBatchRequestException(code, message);
        }
    }
}
