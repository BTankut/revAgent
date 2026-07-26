using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevAgent.Contracts.AddinLoopback
{
    /// <summary>
    /// Closed add-in loopback v1 JSON-RPC request/response envelope codec.
    /// </summary>
    public static class AddinJsonRpcCodec
    {
        public const int ResultContractVersion = 2;

        private static readonly UTF8Encoding StrictUtf8 =
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

        private static readonly Regex MethodPattern = new Regex(
            "^[a-z][a-z0-9_]{0,127}$",
            RegexOptions.CultureInvariant);

        private static readonly HashSet<int> AllowedErrorCodes =
            new HashSet<int>
            {
                -32700,
                -32600,
                -32601,
                -32602,
                -32603
            };

        public static byte[] SerializeRequest(
            string id,
            string method,
            JObject parameters)
        {
            ValidateRequestId(id, allowNull: false);
            ValidateMethod(method);
            if (parameters == null)
            {
                throw new ArgumentNullException(nameof(parameters));
            }

            var envelope = new JObject
            {
                ["jsonrpc"] = "2.0",
                ["id"] = id,
                ["method"] = method,
                ["params"] = parameters.DeepClone()
            };

            return StrictUtf8.GetBytes(envelope.ToString(Formatting.None));
        }

        public static AddinJsonRpcRequest ParseRequest(byte[] utf8)
        {
            JObject envelope = StrictJson.ParseObject(utf8);
            RequireExactProperties(
                envelope,
                "request",
                "jsonrpc",
                "id",
                "method",
                "params");
            RequireJsonRpcVersion(envelope);

            string id = ReadRequiredString(envelope, "id");
            ValidateRequestId(id, allowNull: false);
            string method = ReadRequiredString(envelope, "method");
            ValidateMethod(method);

            var parameters = envelope["params"] as JObject;
            if (parameters == null)
            {
                throw ProtocolError(
                    "invalid_request_params",
                    "JSON-RPC request params must be an object.");
            }

            return new AddinJsonRpcRequest(
                id,
                method,
                (JObject)parameters.DeepClone());
        }

        public static AddinJsonRpcResponse ParseResponse(byte[] utf8)
        {
            return ParseResponseCore(utf8, expectedId: null, enforceCorrelation: false);
        }

        public static AddinJsonRpcResponse ParseResponse(
            byte[] utf8,
            string expectedId)
        {
            ValidateRequestId(expectedId, allowNull: false);
            return ParseResponseCore(utf8, expectedId, enforceCorrelation: true);
        }

        private static AddinJsonRpcResponse ParseResponseCore(
            byte[] utf8,
            string? expectedId,
            bool enforceCorrelation)
        {
            JObject envelope = StrictJson.ParseObject(utf8);
            RequireJsonRpcVersion(envelope);

            bool hasResult = envelope.Property("result", StringComparison.Ordinal) != null;
            bool hasError = envelope.Property("error", StringComparison.Ordinal) != null;
            if (hasResult == hasError)
            {
                throw ProtocolError(
                    "invalid_response_shape",
                    "A JSON-RPC response must contain exactly one of result or error.");
            }

            string? id = ReadResponseId(envelope);
            JObject? result = null;
            AddinJsonRpcError? error = null;

            if (hasResult)
            {
                RequireExactProperties(envelope, "success response", "jsonrpc", "id", "result");
                ValidateRequestId(id, allowNull: false);

                result = envelope["result"] as JObject;
                if (result == null)
                {
                    throw ProtocolError(
                        "invalid_response_result",
                        "A JSON-RPC success result must be an object.");
                }

                JToken? contractVersion = result["resultContractVersion"];
                long contractVersionValue;
                if (JsonIntegerValue.TryReadInt64(
                        contractVersion,
                        out contractVersionValue) != JsonIntegerReadResult.Success ||
                    contractVersionValue != ResultContractVersion)
                {
                    throw ProtocolError(
                        "unsupported_result_contract_version",
                        "A JSON-RPC success result must carry resultContractVersion 2.");
                }

                result = (JObject)result.DeepClone();
            }
            else
            {
                RequireExactProperties(envelope, "error response", "jsonrpc", "id", "error");
                error = ParseError(envelope["error"]!);
                ValidateErrorId(error.Code, id);
            }

            if (enforceCorrelation &&
                !string.Equals(id, expectedId, StringComparison.Ordinal))
            {
                throw ProtocolError(
                    "response_id_mismatch",
                    "JSON-RPC response id did not exactly match the invocation id.");
            }

            var rawCopy = new byte[utf8.Length];
            Buffer.BlockCopy(utf8, 0, rawCopy, 0, utf8.Length);
            return new AddinJsonRpcResponse(id, result, error, rawCopy);
        }

        private static AddinJsonRpcError ParseError(JToken token)
        {
            var error = token as JObject;
            if (error == null)
            {
                throw ProtocolError(
                    "invalid_response_error",
                    "JSON-RPC error must be an object.");
            }

            var propertyNames = new HashSet<string>(StringComparer.Ordinal);
            foreach (JProperty property in error.Properties())
            {
                propertyNames.Add(property.Name);
                if (property.Name != "code" &&
                    property.Name != "message" &&
                    property.Name != "data")
                {
                    throw ProtocolError(
                        "unexpected_error_property",
                        "Unexpected JSON-RPC error property '" + property.Name + "'.");
                }
            }

            if (!propertyNames.Contains("code") || !propertyNames.Contains("message"))
            {
                throw ProtocolError(
                    "invalid_response_error",
                    "JSON-RPC error requires code and message.");
            }

            JToken codeToken = error["code"]!;
            long codeValue;
            JsonIntegerReadResult codeReadResult =
                JsonIntegerValue.TryReadInt64(codeToken, out codeValue);
            if (codeReadResult == JsonIntegerReadResult.NotInteger)
            {
                throw ProtocolError(
                    "invalid_error_code",
                    "JSON-RPC error code must be an integer.");
            }

            if (codeReadResult == JsonIntegerReadResult.OutsideInt64Range ||
                codeValue < int.MinValue ||
                codeValue > int.MaxValue ||
                !AllowedErrorCodes.Contains((int)codeValue))
            {
                throw ProtocolError(
                    "unsupported_error_code",
                    "JSON-RPC error code is not part of add-in loopback v1.");
            }

            string message = ReadRequiredString(error, "message");
            if (UnicodeCodePointLength.Count(message) > 600)
            {
                throw ProtocolError(
                    "invalid_error_message",
                    "JSON-RPC error message exceeds 600 characters.");
            }

            JToken? data = error.Property("data", StringComparison.Ordinal) == null
                ? null
                : error["data"]!.DeepClone();
            return new AddinJsonRpcError((int)codeValue, message, data);
        }

        private static string? ReadResponseId(JObject envelope)
        {
            JProperty? property = envelope.Property("id", StringComparison.Ordinal);
            if (property == null)
            {
                throw ProtocolError(
                    "missing_response_id",
                    "JSON-RPC response id is required.");
            }

            if (property.Value.Type == JTokenType.Null)
            {
                return null;
            }

            if (property.Value.Type != JTokenType.String)
            {
                throw ProtocolError(
                    "invalid_response_id",
                    "JSON-RPC response id must be a string or null.");
            }

            return property.Value.Value<string>();
        }

        private static void ValidateErrorId(int errorCode, string? id)
        {
            if (errorCode == -32700)
            {
                if (id != null)
                {
                    throw ProtocolError(
                        "invalid_parse_error_id",
                        "A JSON-RPC parse error id must be null.");
                }

                return;
            }

            if (errorCode == -32601 ||
                errorCode == -32602 ||
                errorCode == -32603)
            {
                ValidateRequestId(id, allowNull: false);
                return;
            }

            // Invalid request may not recover an id.
            ValidateRequestId(id, allowNull: true);
        }

        private static void RequireJsonRpcVersion(JObject envelope)
        {
            JToken? version = envelope["jsonrpc"];
            if (version == null ||
                version.Type != JTokenType.String ||
                !string.Equals(
                    version.Value<string>(),
                    "2.0",
                    StringComparison.Ordinal))
            {
                throw ProtocolError(
                    "unsupported_jsonrpc_version",
                    "The add-in loopback JSON-RPC version must be exactly '2.0'.");
            }
        }

        private static void RequireExactProperties(
            JObject value,
            string label,
            params string[] expected)
        {
            var names = new HashSet<string>(expected, StringComparer.Ordinal);
            int count = 0;
            foreach (JProperty property in value.Properties())
            {
                count++;
                if (!names.Contains(property.Name))
                {
                    throw ProtocolError(
                        "unexpected_" + label.Replace(' ', '_') + "_property",
                        "Unexpected " + label + " property '" + property.Name + "'.");
                }
            }

            if (count != names.Count)
            {
                throw ProtocolError(
                    "invalid_" + label.Replace(' ', '_') + "_shape",
                    "The " + label + " does not contain its exact required properties.");
            }

            foreach (string name in names)
            {
                if (value.Property(name, StringComparison.Ordinal) == null)
                {
                    throw ProtocolError(
                        "invalid_" + label.Replace(' ', '_') + "_shape",
                        "The " + label + " is missing '" + name + "'.");
                }
            }
        }

        private static string ReadRequiredString(JObject value, string propertyName)
        {
            JToken? token = value[propertyName];
            string? text = token?.Type == JTokenType.String
                ? token.Value<string>()
                : null;
            if (token == null ||
                token.Type != JTokenType.String ||
                string.IsNullOrEmpty(text))
            {
                throw ProtocolError(
                    "invalid_" + propertyName,
                    "JSON-RPC '" + propertyName + "' must be a non-empty string.");
            }

            return text!;
        }

        private static void ValidateRequestId(string? id, bool allowNull)
        {
            if (id == null)
            {
                if (allowNull)
                {
                    return;
                }

                throw ProtocolError(
                    "invalid_request_id",
                    "JSON-RPC id must be a non-empty string.");
            }

            if (id.Length == 0 || UnicodeCodePointLength.Count(id) > 128)
            {
                throw ProtocolError(
                    "invalid_request_id",
                    "JSON-RPC id must contain 1 through 128 characters.");
            }
        }

        private static void ValidateMethod(string method)
        {
            if (method == null || !MethodPattern.IsMatch(method))
            {
                throw ProtocolError(
                    "invalid_method",
                    "JSON-RPC method must match ^[a-z][a-z0-9_]{0,127}$.");
            }
        }

        private static AddinJsonRpcProtocolException ProtocolError(
            string code,
            string message)
        {
            return new AddinJsonRpcProtocolException(code, message);
        }
    }
}
