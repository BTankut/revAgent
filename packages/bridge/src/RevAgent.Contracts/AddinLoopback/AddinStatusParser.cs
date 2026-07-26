#nullable enable

using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.AddinLoopback
{
    public sealed class AddinStatusContractException : FormatException
    {
        internal AddinStatusContractException(string code, string message)
            : base(message)
        {
            Code = code;
        }

        public string Code { get; }
    }

    /// <summary>
    /// Closed parser for the frozen add-in loopback v1 mcp_status result.
    /// The local contract does not permit additive fields.
    /// </summary>
    public static class AddinStatusParser
    {
        private static readonly Regex RevitVersionPattern = new Regex(
            "^[0-9]{4}$",
            RegexOptions.CultureInvariant);

        private static readonly Regex MethodPattern = new Regex(
            "^[a-z][a-z0-9_]{0,127}$",
            RegexOptions.CultureInvariant);

        private static readonly Regex Rfc3339Pattern = new Regex(
            "^\\d{4}-\\d{2}-\\d{2}[Tt]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:[Zz]|[+-]\\d{2}:\\d{2})$",
            RegexOptions.CultureInvariant);

        private static readonly string[] ResultProperties =
        {
            "resultContractVersion",
            "addinLoopbackContractVersion",
            "addinVersion",
            "revit",
            "service",
            "sessionCapabilities",
            "capabilityContracts",
            "activeTask",
            "recentTasks",
            "recentHistoryCount",
            "recentHistoryCapacity",
            "plan",
        };

        private static readonly string[] RevitProperties =
        {
            "version",
            "build",
            "processId",
        };

        private static readonly string[] ServiceProperties =
        {
            "isRunning",
            "port",
            "binding",
            "boundAddresses",
            "framing",
        };

        private static readonly string[] FramingProperties =
        {
            "protocol",
            "headerBytes",
            "byteOrder",
            "payloadEncoding",
            "maxRequestPayloadBytes",
            "maxResponsePayloadBytes",
        };

        private static readonly string[] BatchCapabilityProperties =
        {
            "contractVersion",
            "method",
            "maxSteps",
            "maxRequestPayloadBytes",
            "maxResponsePayloadBytes",
            "transactionBoundary",
            "rollbackPolicy",
            "batchableCommands",
        };

        private static readonly string[] DocumentContextCapabilityProperties =
        {
            "contractVersion",
            "method",
            "source",
            "pollIntervalMs",
            "uiThreadRoundTrip",
        };

        private static readonly string[] BatchableCommandProperties =
        {
            "method",
            "effect",
            "transactionPolicy",
            "rollbackDisposition",
            "parameterProfile",
            "resultDelivery",
            "maxInlineResultBytes",
        };

        private static readonly string[] RequiredTaskProperties =
        {
            "id",
            "requestId",
            "method",
            "taskName",
            "state",
            "startedAtUtc",
            "finishedAtUtc",
            "elapsedMs",
            "port",
            "error",
            "framing",
            "requestBytes",
            "receiveMs",
            "parseMs",
            "executeMs",
            "responseBytes",
        };

        private static readonly string[] AllowedTaskProperties =
        {
            "id",
            "requestId",
            "method",
            "wrapperAction",
            "logicalToolName",
            "taskName",
            "parentTaskName",
            "parentTaskId",
            "state",
            "startedAtUtc",
            "finishedAtUtc",
            "elapsedMs",
            "port",
            "error",
            "framing",
            "requestBytes",
            "receiveMs",
            "parseMs",
            "executeMs",
            "responseBytes",
        };

        private static readonly string[] PlanProperties =
        {
            "pending",
            "completed",
        };

        private static readonly HashSet<string> AllowedCapabilities =
            new HashSet<string>(
                new[]
                {
                    AddinStatusContract.BatchAtomicCapability,
                    AddinStatusContract.DocumentContextCachedCapability,
                },
                StringComparer.Ordinal);

        private static readonly HashSet<string> AllowedBatchableMethods =
            new HashSet<string>(
                new[]
                {
                    "get_current_view_elements",
                    "get_current_view_info",
                    "get_selected_elements",
                    "list_open_views",
                    "get_ui_state",
                    "find_elements",
                    "inspect_levels",
                    "inspect_sheet_text",
                    "inspect_schedules",
                    "count_annotations",
                    "extract_spatial_snapshot",
                    "get_spatial_change_state",
                    "delete_review_view",
                },
                StringComparer.Ordinal);

        public static AddinStatusSnapshot Parse(AddinJsonRpcResponse response)
        {
            if (response == null)
            {
                throw new ArgumentNullException(nameof(response));
            }

            if (!response.IsSuccess || response.Result == null)
            {
                throw Invalid(
                    "mcp_status_jsonrpc_error",
                    "mcp_status did not return a JSON-RPC success result");
            }

            return ParseResult(response.Result);
        }

        public static AddinStatusSnapshot ParseResult(JObject result)
        {
            if (result == null)
            {
                throw new ArgumentNullException(nameof(result));
            }

            RequireExactProperties(result, ResultProperties, ResultProperties, "result");
            RequireInteger(
                result,
                "resultContractVersion",
                "result",
                AddinJsonRpcCodec.ResultContractVersion,
                AddinJsonRpcCodec.ResultContractVersion);
            long loopbackVersion = RequireInteger(
                result,
                "addinLoopbackContractVersion",
                "result",
                long.MinValue,
                long.MaxValue);
            if (loopbackVersion != AddinStatusContract.Version)
            {
                throw Invalid(
                    "unsupported_addin_loopback_contract_version",
                    "result.addinLoopbackContractVersion must equal 1");
            }

            string addinVersion = RequireString(
                result,
                "addinVersion",
                "result",
                128,
                requireNonEmpty: true);
            AddinRevitIdentity revit = ParseRevit(
                RequireObject(result, "revit", "result"));
            AddinServiceStatus service = ParseService(
                RequireObject(result, "service", "result"));
            IReadOnlyList<string> sessionCapabilities =
                ParseSessionCapabilities(
                    RequireArray(result, "sessionCapabilities", "result"));
            JObject capabilityContracts =
                RequireObject(result, "capabilityContracts", "result");

            AddinBatchAtomicCapability? batchAtomic = null;
            AddinDocumentContextCapability? documentContextCached = null;
            RequireExactProperties(
                capabilityContracts,
                sessionCapabilities,
                sessionCapabilities,
                "result.capabilityContracts");

            if (sessionCapabilities.Contains(
                    AddinStatusContract.BatchAtomicCapability))
            {
                batchAtomic = ParseBatchAtomicCapability(
                    RequireObject(
                        capabilityContracts,
                        AddinStatusContract.BatchAtomicCapability,
                        "result.capabilityContracts"),
                    service.Framing);
            }

            if (sessionCapabilities.Contains(
                    AddinStatusContract.DocumentContextCachedCapability))
            {
                documentContextCached = ParseDocumentContextCapability(
                    RequireObject(
                        capabilityContracts,
                        AddinStatusContract.DocumentContextCachedCapability,
                        "result.capabilityContracts"));
            }

            AddinTaskStatus? activeTask = ParseNullableTask(
                result["activeTask"],
                "result.activeTask");
            var recentTaskArray = RequireArray(result, "recentTasks", "result");
            if (recentTaskArray.Count > 100)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    "result.recentTasks exceeds the 100-item limit");
            }

            var recentTasks = new List<AddinTaskStatus>(recentTaskArray.Count);
            for (int index = 0; index < recentTaskArray.Count; index++)
            {
                string path = "result.recentTasks[" +
                    index.ToString(CultureInfo.InvariantCulture) +
                    "]";
                recentTasks.Add(ParseRequiredTask(recentTaskArray[index], path));
            }

            int recentHistoryCount = checked((int)RequireInteger(
                result,
                "recentHistoryCount",
                "result",
                0,
                100));
            if (recentHistoryCount != recentTasks.Count)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    "result.recentHistoryCount must equal result.recentTasks length");
            }

            RequireInteger(
                result,
                "recentHistoryCapacity",
                "result",
                100,
                100);
            AddinPlanStatus plan = ParsePlan(
                RequireObject(result, "plan", "result"));

            return new AddinStatusSnapshot(
                addinVersion,
                revit,
                service,
                new ReadOnlyCollection<string>(
                    new List<string>(sessionCapabilities)),
                batchAtomic,
                documentContextCached,
                activeTask,
                new ReadOnlyCollection<AddinTaskStatus>(recentTasks),
                recentHistoryCount,
                plan);
        }

        private static AddinRevitIdentity ParseRevit(JObject value)
        {
            const string Path = "result.revit";
            RequireExactProperties(value, RevitProperties, RevitProperties, Path);
            string version = RequireString(
                value,
                "version",
                Path,
                4,
                requireNonEmpty: true);
            if (!RevitVersionPattern.IsMatch(version))
            {
                throw Invalid(
                    "invalid_mcp_status",
                    "result.revit.version must contain exactly four ASCII digits");
            }

            return new AddinRevitIdentity(
                version,
                RequireString(
                    value,
                    "build",
                    Path,
                    128,
                    requireNonEmpty: true),
                RequireInteger(
                    value,
                    "processId",
                    Path,
                    1,
                    long.MaxValue));
        }

        private static AddinServiceStatus ParseService(JObject value)
        {
            const string Path = "result.service";
            RequireExactProperties(value, ServiceProperties, ServiceProperties, Path);
            RequireBoolean(value, "isRunning", Path, expected: true);
            int port = checked((int)RequireInteger(
                value,
                "port",
                Path,
                1,
                65535));
            RequireStringConstant(value, "binding", Path, "loopback_only");

            var addressArray = RequireArray(value, "boundAddresses", Path);
            if (addressArray.Count is < 1 or > 2)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    "result.service.boundAddresses must contain one or two addresses");
            }

            var addresses = new List<string>(addressArray.Count);
            var uniqueAddresses = new HashSet<string>(StringComparer.Ordinal);
            for (int index = 0; index < addressArray.Count; index++)
            {
                string addressPath = Path + ".boundAddresses[" +
                    index.ToString(CultureInfo.InvariantCulture) +
                    "]";
                JToken token = addressArray[index];
                if (token.Type != JTokenType.String)
                {
                    throw Invalid(
                        "invalid_mcp_status",
                        addressPath + " must be a string");
                }

                string address = token.Value<string>()!;
                if (!IsCanonicalLoopbackAddress(address))
                {
                    throw Invalid(
                        "invalid_mcp_status",
                        addressPath + " must be canonical ::1 or a 127/8 IPv4 address");
                }

                if (!uniqueAddresses.Add(address))
                {
                    throw Invalid(
                        "invalid_mcp_status",
                        "result.service.boundAddresses must be unique");
                }

                addresses.Add(address);
            }

            AddinFramingStatus framing = ParseFraming(
                RequireObject(value, "framing", Path));
            return new AddinServiceStatus(
                port,
                new ReadOnlyCollection<string>(addresses),
                framing);
        }

        private static AddinFramingStatus ParseFraming(JObject value)
        {
            const string Path = "result.service.framing";
            RequireExactProperties(value, FramingProperties, FramingProperties, Path);
            RequireStringConstant(
                value,
                "protocol",
                Path,
                "length_prefixed_jsonrpc_v1");
            RequireInteger(
                value,
                "headerBytes",
                Path,
                AddinFrameLimits.HeaderBytes,
                AddinFrameLimits.HeaderBytes);
            RequireStringConstant(value, "byteOrder", Path, "big_endian");
            RequireStringConstant(value, "payloadEncoding", Path, "utf-8");
            int maxRequestPayloadBytes = checked((int)RequireInteger(
                value,
                "maxRequestPayloadBytes",
                Path,
                AddinFrameLimits.MinimumRequestPayloadBytes,
                AddinFrameLimits.AbsoluteMaxRequestPayloadBytes));
            RequireInteger(
                value,
                "maxResponsePayloadBytes",
                Path,
                AddinFrameLimits.MaxResponsePayloadBytes,
                AddinFrameLimits.MaxResponsePayloadBytes);
            return new AddinFramingStatus(maxRequestPayloadBytes);
        }

        private static IReadOnlyList<string> ParseSessionCapabilities(
            JArray values)
        {
            const string Path = "result.sessionCapabilities";
            if (values.Count > 2)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    "result.sessionCapabilities exceeds the two-item limit");
            }

            var capabilities = new List<string>(values.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (int index = 0; index < values.Count; index++)
            {
                JToken token = values[index];
                if (token.Type != JTokenType.String)
                {
                    throw Invalid(
                        "invalid_mcp_status",
                        Path + " entries must be strings");
                }

                string capability = token.Value<string>()!;
                if (!AllowedCapabilities.Contains(capability))
                {
                    throw Invalid(
                        "invalid_mcp_status",
                        Path + " contains an unsupported capability");
                }

                if (!unique.Add(capability))
                {
                    throw Invalid(
                        "invalid_mcp_status",
                        Path + " must contain unique capabilities");
                }

                capabilities.Add(capability);
            }

            return capabilities;
        }

        private static AddinBatchAtomicCapability ParseBatchAtomicCapability(
            JObject value,
            AddinFramingStatus framing)
        {
            const string Path = "result.capabilityContracts.batch_atomic";
            RequireExactProperties(
                value,
                BatchCapabilityProperties,
                BatchCapabilityProperties,
                Path);
            RequireInteger(value, "contractVersion", Path, 1, 1);
            RequireStringConstant(value, "method", Path, "execute_batch");
            int maxSteps = checked((int)RequireInteger(
                value,
                "maxSteps",
                Path,
                1,
                64));
            int maxRequestPayloadBytes = checked((int)RequireInteger(
                value,
                "maxRequestPayloadBytes",
                Path,
                AddinFrameLimits.MinimumRequestPayloadBytes,
                AddinFrameLimits.AbsoluteMaxRequestPayloadBytes));
            int maxResponsePayloadBytes = checked((int)RequireInteger(
                value,
                "maxResponsePayloadBytes",
                Path,
                AddinFrameLimits.MaxResponsePayloadBytes,
                AddinFrameLimits.MaxResponsePayloadBytes));
            if (maxRequestPayloadBytes != framing.MaxRequestPayloadBytes ||
                maxResponsePayloadBytes != framing.MaxResponsePayloadBytes)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    Path + " payload limits must equal result.service.framing limits");
            }

            RequireStringConstant(
                value,
                "transactionBoundary",
                Path,
                "revit_transaction_group");
            RequireStringConstant(
                value,
                "rollbackPolicy",
                Path,
                "rollback_on_non_success");

            JArray commandArray = RequireArray(value, "batchableCommands", Path);
            if (commandArray.Count is < 1 or > 13)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    Path + ".batchableCommands must contain one through thirteen descriptors");
            }

            var commands = new List<AddinBatchableCommand>(commandArray.Count);
            var methods = new HashSet<string>(StringComparer.Ordinal);
            bool hasDeleteReviewView = false;
            for (int index = 0; index < commandArray.Count; index++)
            {
                string commandPath = Path + ".batchableCommands[" +
                    index.ToString(CultureInfo.InvariantCulture) +
                    "]";
                if (!(commandArray[index] is JObject commandObject))
                {
                    throw Invalid(
                        "invalid_mcp_status",
                        commandPath + " must be an object");
                }

                AddinBatchableCommand command =
                    ParseBatchableCommand(commandObject, commandPath);
                if (!methods.Add(command.Method))
                {
                    throw Invalid(
                        "invalid_mcp_status",
                        Path + ".batchableCommands methods must be unique");
                }

                hasDeleteReviewView |= string.Equals(
                    command.Method,
                    "delete_review_view",
                    StringComparison.Ordinal);
                commands.Add(command);
            }

            if (!hasDeleteReviewView)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    Path + " must advertise delete_review_view rollback support");
            }

            return new AddinBatchAtomicCapability(
                maxSteps,
                maxRequestPayloadBytes,
                new ReadOnlyCollection<AddinBatchableCommand>(commands));
        }

        private static AddinBatchableCommand ParseBatchableCommand(
            JObject value,
            string path)
        {
            RequireExactProperties(
                value,
                BatchableCommandProperties,
                BatchableCommandProperties,
                path);
            string method = RequireString(
                value,
                "method",
                path,
                128,
                requireNonEmpty: true);
            if (!AllowedBatchableMethods.Contains(method))
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + ".method is not eligible in add-in loopback v1");
            }

            bool isDeleteReviewView = string.Equals(
                method,
                "delete_review_view",
                StringComparison.Ordinal);
            string effect = RequireStringConstant(
                value,
                "effect",
                path,
                isDeleteReviewView ? "model_transaction" : "read_only");
            string transactionPolicy = RequireStringConstant(
                value,
                "transactionPolicy",
                path,
                isDeleteReviewView ? "nested_transaction_required" : "none");
            string rollbackDisposition = RequireStringConstant(
                value,
                "rollbackDisposition",
                path,
                isDeleteReviewView
                    ? "transaction_group_rollback"
                    : "discard_result_on_batch_rollback");
            string parameterProfile = RequireStringConstant(
                value,
                "parameterProfile",
                path,
                isDeleteReviewView
                    ? "delete_review_view_commit_v1"
                    : "ordinary_v1");
            RequireStringConstant(
                value,
                "resultDelivery",
                path,
                "inline_only");
            RequireInteger(
                value,
                "maxInlineResultBytes",
                path,
                8 * 1024 * 1024,
                8 * 1024 * 1024);
            return new AddinBatchableCommand(
                method,
                effect,
                transactionPolicy,
                rollbackDisposition,
                parameterProfile);
        }

        private static AddinDocumentContextCapability
            ParseDocumentContextCapability(JObject value)
        {
            const string Path =
                "result.capabilityContracts.doc_context_cached_v1";
            RequireExactProperties(
                value,
                DocumentContextCapabilityProperties,
                DocumentContextCapabilityProperties,
                Path);
            RequireInteger(value, "contractVersion", Path, 1, 1);
            RequireStringConstant(
                value,
                "method",
                Path,
                "get_document_context");
            RequireStringConstant(
                value,
                "source",
                Path,
                "application_events_cache");
            RequireInteger(value, "pollIntervalMs", Path, 15000, 15000);
            RequireBoolean(value, "uiThreadRoundTrip", Path, expected: false);
            return new AddinDocumentContextCapability();
        }

        private static AddinTaskStatus? ParseNullableTask(
            JToken? token,
            string path)
        {
            if (token == null)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + " is required");
            }

            if (token.Type == JTokenType.Null)
            {
                return null;
            }

            return ParseRequiredTask(token, path);
        }

        private static AddinTaskStatus ParseRequiredTask(
            JToken token,
            string path)
        {
            if (!(token is JObject value))
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + " must be an object");
            }

            RequireExactProperties(
                value,
                RequiredTaskProperties,
                AllowedTaskProperties,
                path);
            string method = RequireMethod(value, "method", path);
            string? wrapperAction = RequireOptionalMethod(
                value,
                "wrapperAction",
                path);
            string? logicalToolName = RequireOptionalMethod(
                value,
                "logicalToolName",
                path);
            string state = RequireString(
                value,
                "state",
                path,
                9,
                requireNonEmpty: true);
            if (state != "running" &&
                state != "completed" &&
                state != "guarded" &&
                state != "failed")
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + ".state is not a frozen task state");
            }

            string? framing = RequireNullableString(
                value,
                "framing",
                path,
                15,
                allowEmpty: false);
            if (framing != null &&
                framing != "length-prefixed" &&
                framing != "legacy-json")
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + ".framing is not a frozen framing value");
            }

            return new AddinTaskStatus(
                RequireString(value, "id", path, 128, requireNonEmpty: true),
                RequireString(
                    value,
                    "requestId",
                    path,
                    128,
                    requireNonEmpty: true),
                method,
                wrapperAction,
                logicalToolName,
                RequireString(
                    value,
                    "taskName",
                    path,
                    256,
                    requireNonEmpty: true),
                RequireOptionalString(
                    value,
                    "parentTaskName",
                    path,
                    256,
                    requireNonEmpty: true),
                RequireOptionalString(
                    value,
                    "parentTaskId",
                    path,
                    128,
                    requireNonEmpty: true),
                state,
                RequireDateTime(value, "startedAtUtc", path),
                RequireNullableDateTime(value, "finishedAtUtc", path),
                RequireInteger(value, "elapsedMs", path, 0, long.MaxValue),
                checked((int)RequireInteger(
                    value,
                    "port",
                    path,
                    1,
                    65535)),
                RequireNullableString(
                    value,
                    "error",
                    path,
                    600,
                    allowEmpty: true),
                framing,
                RequireNullableInteger(
                    value,
                    "requestBytes",
                    path,
                    0,
                    long.MaxValue),
                RequireNullableInteger(
                    value,
                    "receiveMs",
                    path,
                    0,
                    long.MaxValue),
                RequireNullableInteger(
                    value,
                    "parseMs",
                    path,
                    0,
                    long.MaxValue),
                RequireNullableInteger(
                    value,
                    "executeMs",
                    path,
                    0,
                    long.MaxValue),
                RequireNullableInteger(
                    value,
                    "responseBytes",
                    path,
                    0,
                    long.MaxValue));
        }

        private static AddinPlanStatus ParsePlan(JObject value)
        {
            const string Path = "result.plan";
            RequireExactProperties(value, PlanProperties, PlanProperties, Path);
            return new AddinPlanStatus(
                ParseBoundedStringArray(
                    RequireArray(value, "pending", Path),
                    Path + ".pending",
                    100,
                    256),
                ParseBoundedStringArray(
                    RequireArray(value, "completed", Path),
                    Path + ".completed",
                    100,
                    256));
        }

        private static IReadOnlyList<string> ParseBoundedStringArray(
            JArray array,
            string path,
            int maxItems,
            int maxStringLength)
        {
            if (array.Count > maxItems)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + " exceeds its item limit");
            }

            var values = new List<string>(array.Count);
            for (int index = 0; index < array.Count; index++)
            {
                JToken token = array[index];
                if (token.Type != JTokenType.String)
                {
                    throw Invalid(
                        "invalid_mcp_status",
                        path + " entries must be strings");
                }

                string value = token.Value<string>()!;
                ValidateStringLength(
                    value,
                    path + "[" + index.ToString(CultureInfo.InvariantCulture) + "]",
                    maxStringLength,
                    requireNonEmpty: true);
                values.Add(value);
            }

            return new ReadOnlyCollection<string>(values);
        }

        private static bool IsCanonicalLoopbackAddress(string value)
        {
            if (string.Equals(value, "::1", StringComparison.Ordinal))
            {
                return true;
            }

            if (!IPAddress.TryParse(value, out IPAddress? address) ||
                address.AddressFamily != AddressFamily.InterNetwork ||
                !IPAddress.IsLoopback(address))
            {
                return false;
            }

            return string.Equals(
                address.ToString(),
                value,
                StringComparison.Ordinal);
        }

        private static void RequireExactProperties(
            JObject value,
            IEnumerable<string> required,
            IEnumerable<string> allowed,
            string path)
        {
            var remaining = new HashSet<string>(required, StringComparer.Ordinal);
            var allowedSet = new HashSet<string>(allowed, StringComparer.Ordinal);
            foreach (JProperty property in value.Properties())
            {
                if (!allowedSet.Contains(property.Name))
                {
                    throw Invalid(
                        "invalid_mcp_status",
                        path + " contains unexpected property \"" +
                        property.Name +
                        "\"");
                }

                remaining.Remove(property.Name);
            }

            if (remaining.Count != 0)
            {
                foreach (string missing in remaining)
                {
                    throw Invalid(
                        "invalid_mcp_status",
                        path + " is missing required property \"" +
                        missing +
                        "\"");
                }
            }
        }

        private static JObject RequireObject(
            JObject parent,
            string name,
            string path)
        {
            if (!(parent[name] is JObject value))
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " must be an object");
            }

            return value;
        }

        private static JArray RequireArray(
            JObject parent,
            string name,
            string path)
        {
            if (!(parent[name] is JArray value))
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " must be an array");
            }

            return value;
        }

        private static string RequireMethod(
            JObject parent,
            string name,
            string path)
        {
            string value = RequireString(
                parent,
                name,
                path,
                128,
                requireNonEmpty: true);
            if (!MethodPattern.IsMatch(value))
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " is not a frozen method name");
            }

            return value;
        }

        private static string? RequireOptionalMethod(
            JObject parent,
            string name,
            string path)
        {
            string? value = RequireOptionalString(
                parent,
                name,
                path,
                128,
                requireNonEmpty: true);
            if (value != null && !MethodPattern.IsMatch(value))
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " is not a frozen method name");
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
            JToken? token = parent[name];
            if (token == null || token.Type != JTokenType.String)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " must be a string");
            }

            string value = token.Value<string>()!;
            ValidateStringLength(
                value,
                path + "." + name,
                maxLength,
                requireNonEmpty);
            return value;
        }

        private static string RequireStringConstant(
            JObject parent,
            string name,
            string path,
            string expected)
        {
            string value = RequireString(
                parent,
                name,
                path,
                expected.Length,
                requireNonEmpty: true);
            if (!string.Equals(value, expected, StringComparison.Ordinal))
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " must equal \"" + expected + "\"");
            }

            return value;
        }

        private static string? RequireOptionalString(
            JObject parent,
            string name,
            string path,
            int maxLength,
            bool requireNonEmpty)
        {
            JProperty? property = parent.Property(name, StringComparison.Ordinal);
            if (property == null)
            {
                return null;
            }

            if (property.Value.Type != JTokenType.String)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " must be a string when present");
            }

            string value = property.Value.Value<string>()!;
            ValidateStringLength(
                value,
                path + "." + name,
                maxLength,
                requireNonEmpty);
            return value;
        }

        private static string? RequireNullableString(
            JObject parent,
            string name,
            string path,
            int maxLength,
            bool allowEmpty)
        {
            JToken? token = parent[name];
            if (token == null)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " is required");
            }

            if (token.Type == JTokenType.Null)
            {
                return null;
            }

            if (token.Type != JTokenType.String)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " must be a string or null");
            }

            string value = token.Value<string>()!;
            ValidateStringLength(
                value,
                path + "." + name,
                maxLength,
                requireNonEmpty: !allowEmpty);
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
                throw Invalid(
                    "invalid_mcp_status",
                    path + " must not be empty");
            }

            if (UnicodeCodePointLength.Count(value) > maxLength)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + " exceeds its maximum length");
            }
        }

        private static long RequireInteger(
            JObject parent,
            string name,
            string path,
            long minimum,
            long maximum)
        {
            JToken? token = parent[name];
            JsonIntegerReadResult readResult =
                JsonIntegerValue.TryReadExactInt64(token, out long value);
            if (readResult == JsonIntegerReadResult.NotInteger)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " must be an integer");
            }

            if (readResult == JsonIntegerReadResult.OutsideInt64Range ||
                value < minimum ||
                value > maximum)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " is outside its allowed range");
            }

            return value;
        }

        private static long? RequireNullableInteger(
            JObject parent,
            string name,
            string path,
            long minimum,
            long maximum)
        {
            JToken? token = parent[name];
            if (token == null)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " is required");
            }

            if (token.Type == JTokenType.Null)
            {
                return null;
            }

            return RequireInteger(parent, name, path, minimum, maximum);
        }

        private static void RequireBoolean(
            JObject parent,
            string name,
            string path,
            bool expected)
        {
            JToken? token = parent[name];
            if (token == null ||
                token.Type != JTokenType.Boolean ||
                token.Value<bool>() != expected)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " must equal " +
                    expected.ToString().ToLowerInvariant());
            }
        }

        private static DateTimeOffset RequireDateTime(
            JObject parent,
            string name,
            string path)
        {
            JToken? token = parent[name];
            if (token == null || token.Type != JTokenType.String)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " must be a date-time string");
            }

            string value = token.Value<string>()!;
            return ParseDateTime(value, path + "." + name);
        }

        private static DateTimeOffset? RequireNullableDateTime(
            JObject parent,
            string name,
            string path)
        {
            JToken? token = parent[name];
            if (token == null)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " is required");
            }

            if (token.Type == JTokenType.Null)
            {
                return null;
            }

            if (token.Type != JTokenType.String)
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + "." + name + " must be a date-time string or null");
            }

            string value = token.Value<string>()!;
            return ParseDateTime(value, path + "." + name);
        }

        private static DateTimeOffset ParseDateTime(
            string value,
            string path)
        {
            if (!Rfc3339Pattern.IsMatch(value))
            {
                throw Invalid(
                    "invalid_mcp_status",
                    path + " must be an RFC 3339 date-time");
            }

            if (DateTimeOffset.TryParse(
                    value,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out DateTimeOffset parsed) ||
                TryParseLeapSecond(value, out parsed))
            {
                return parsed;
            }

            throw Invalid(
                "invalid_mcp_status",
                path + " must be an RFC 3339 date-time");
        }

        private static bool TryParseLeapSecond(
            string value,
            out DateTimeOffset parsed)
        {
            parsed = default(DateTimeOffset);
            if (value.Length < 19 ||
                value[17] != '6' ||
                value[18] != '0')
            {
                return false;
            }

            string normalized =
                value.Substring(0, 17) +
                "59" +
                value.Substring(19);
            if (!DateTimeOffset.TryParse(
                    normalized,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out DateTimeOffset precedingSecond))
            {
                return false;
            }

            try
            {
                parsed = precedingSecond.AddSeconds(1);
                return true;
            }
            catch (ArgumentOutOfRangeException)
            {
                return false;
            }
        }

        private static AddinStatusContractException Invalid(
            string code,
            string message)
        {
            return new AddinStatusContractException(code, message);
        }
    }
}
