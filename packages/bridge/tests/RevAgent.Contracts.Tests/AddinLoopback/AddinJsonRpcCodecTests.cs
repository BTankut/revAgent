using System;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.AddinLoopback;
using Xunit;

namespace RevAgent.Contracts.Tests.AddinLoopback
{
    public sealed class AddinJsonRpcCodecTests
    {
        [Fact]
        public void SerializesExactRequestEnvelopeWithoutMutatingParams()
        {
            var parameters = new JObject
            {
                ["value"] = 3
            };

            byte[] payload = AddinJsonRpcCodec.SerializeRequest(
                "invocation-1",
                "get_ui_state",
                parameters);
            parameters["later"] = true;

            Assert.Equal(
                "{\"jsonrpc\":\"2.0\",\"id\":\"invocation-1\",\"method\":\"get_ui_state\",\"params\":{\"value\":3}}",
                Encoding.UTF8.GetString(payload));
        }

        [Fact]
        public void ParsesExactRequestAndClonesParams()
        {
            byte[] payload = Encoding.UTF8.GetBytes(
                "{\"jsonrpc\":\"2.0\",\"id\":\"invocation-2\",\"method\":\"mcp_status\",\"params\":{}}");

            AddinJsonRpcRequest request = AddinJsonRpcCodec.ParseRequest(payload);

            Assert.Equal("invocation-2", request.Id);
            Assert.Equal("mcp_status", request.Method);
            Assert.Empty(request.Params.Properties());
        }

        [Fact]
        public void ParsesCorrelatedSuccessWithResultContractVersionTwo()
        {
            byte[] payload = Encoding.UTF8.GetBytes(
                "{\"jsonrpc\":\"2.0\",\"id\":\"invocation-3\",\"result\":{\"resultContractVersion\":2,\"success\":true}}");

            AddinJsonRpcResponse response = AddinJsonRpcCodec.ParseResponse(
                payload,
                "invocation-3");

            Assert.True(response.IsSuccess);
            Assert.Equal(2, response.ResultContractVersion);
            Assert.Null(response.Error);
            Assert.Equal(payload, response.RawPayload);
            Assert.NotSame(payload, response.RawPayload);
        }

        [Fact]
        public void OrdinaryResultNumbersKeepLegacyDoubleExponentSemantics()
        {
            byte[] payload = Encoding.UTF8.GetBytes(
                "{\"jsonrpc\":\"2.0\",\"id\":\"wide-number\",\"result\":{\"resultContractVersion\":2,\"large\":1e100,\"small\":1e-100,\"fraction\":1.25}}");

            AddinJsonRpcResponse response =
                AddinJsonRpcCodec.ParseResponse(payload, "wide-number");

            Assert.Equal(JTokenType.Float, response.Result!["large"]!.Type);
            Assert.Equal(1e100, response.Result["large"]!.Value<double>());
            Assert.Equal(1e-100, response.Result["small"]!.Value<double>());
            Assert.Equal(1.25d, response.Result["fraction"]!.Value<double>());
        }

        [Fact]
        public void RejectsContractIntegerRoundedByBinaryFloatingPoint()
        {
            byte[] payload = Encoding.UTF8.GetBytes(
                "{\"jsonrpc\":\"2.0\",\"id\":\"rounded\",\"result\":{\"resultContractVersion\":2.00000000000000001}}");

            AddinJsonRpcProtocolException error =
                Assert.Throws<AddinJsonRpcProtocolException>(
                    () => AddinJsonRpcCodec.ParseResponse(
                        payload,
                        "rounded"));

            Assert.Equal("unsupported_result_contract_version", error.Code);
        }

        [Fact]
        public void ParsesCorrelatedStandardError()
        {
            byte[] payload = Encoding.UTF8.GetBytes(
                "{\"jsonrpc\":\"2.0\",\"id\":\"invocation-4\",\"error\":{\"code\":-32603,\"message\":\"failed\",\"data\":{\"retry\":false}}}");

            AddinJsonRpcResponse response = AddinJsonRpcCodec.ParseResponse(
                payload,
                "invocation-4");

            Assert.False(response.IsSuccess);
            Assert.Equal(-32603, response.Error!.Code);
            Assert.Equal("failed", response.Error.Message);
            Assert.False(response.Error.Data!.Value<bool>("retry"));
        }

        [Fact]
        public void UncorrelatedParserAcceptsNullParseErrorId()
        {
            byte[] payload = Encoding.UTF8.GetBytes(
                "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32700,\"message\":\"Invalid JSON\"}}");

            AddinJsonRpcResponse response = AddinJsonRpcCodec.ParseResponse(payload);

            Assert.Null(response.Id);
            Assert.Equal(-32700, response.Error!.Code);
        }

        [Fact]
        public void CorrelatedParserRejectsNullErrorId()
        {
            byte[] payload = Encoding.UTF8.GetBytes(
                "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32600,\"message\":\"oversized\"}}");

            AddinJsonRpcProtocolException error =
                Assert.Throws<AddinJsonRpcProtocolException>(
                    () => AddinJsonRpcCodec.ParseResponse(payload, "invocation-5"));

            Assert.Equal("response_id_mismatch", error.Code);
        }

        [Fact]
        public void RejectsResponseIdMismatchOrdinally()
        {
            byte[] payload = Encoding.UTF8.GetBytes(
                "{\"jsonrpc\":\"2.0\",\"id\":\"INVOCATION\",\"result\":{\"resultContractVersion\":2}}");

            AddinJsonRpcProtocolException error =
                Assert.Throws<AddinJsonRpcProtocolException>(
                    () => AddinJsonRpcCodec.ParseResponse(payload, "invocation"));

            Assert.Equal("response_id_mismatch", error.Code);
        }

        [Theory]
        [InlineData(
            "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"result\":{}}",
            "unsupported_result_contract_version")]
        [InlineData(
            "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"result\":{\"resultContractVersion\":1}}",
            "unsupported_result_contract_version")]
        [InlineData(
            "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"result\":{\"resultContractVersion\":2.1}}",
            "unsupported_result_contract_version")]
        [InlineData(
            "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"result\":{\"resultContractVersion\":2},\"error\":{\"code\":-32603,\"message\":\"x\"}}",
            "invalid_response_shape")]
        [InlineData(
            "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"result\":{\"resultContractVersion\":2},\"extra\":true}",
            "unexpected_success_response_property")]
        [InlineData(
            "{\"jsonrpc\":\"1.0\",\"id\":\"x\",\"result\":{\"resultContractVersion\":2}}",
            "unsupported_jsonrpc_version")]
        public void RejectsInvalidSuccessResponses(string json, string expectedCode)
        {
            AddinJsonRpcProtocolException error =
                Assert.Throws<AddinJsonRpcProtocolException>(
                    () => AddinJsonRpcCodec.ParseResponse(
                        Encoding.UTF8.GetBytes(json)));

            Assert.Equal(expectedCode, error.Code);
        }

        [Theory]
        [InlineData("2.0")]
        [InlineData("2e0")]
        public void AcceptsMathematicallyIntegralResultContractVersion(string number)
        {
            byte[] payload = Encoding.UTF8.GetBytes(
                "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"result\":{\"resultContractVersion\":" +
                number +
                "}}");

            AddinJsonRpcResponse response =
                AddinJsonRpcCodec.ParseResponse(payload, "x");

            Assert.True(response.IsSuccess);
            Assert.Equal(2, response.ResultContractVersion);
        }

        [Theory]
        [InlineData(
            "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"error\":{\"code\":-32000,\"message\":\"x\"}}",
            "unsupported_error_code")]
        [InlineData(
            "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"error\":{\"code\":-32700,\"message\":\"x\"}}",
            "invalid_parse_error_id")]
        [InlineData(
            "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"x\"}}",
            "invalid_request_id")]
        [InlineData(
            "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"error\":{\"code\":-32603,\"message\":\"\"}}",
            "invalid_message")]
        [InlineData(
            "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"error\":{\"code\":-32603,\"message\":\"x\",\"extra\":true}}",
            "unexpected_error_property")]
        [InlineData(
            "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"error\":{\"code\":-32603.1,\"message\":\"x\"}}",
            "invalid_error_code")]
        public void RejectsInvalidErrorResponses(string json, string expectedCode)
        {
            AddinJsonRpcProtocolException error =
                Assert.Throws<AddinJsonRpcProtocolException>(
                    () => AddinJsonRpcCodec.ParseResponse(
                        Encoding.UTF8.GetBytes(json)));

            Assert.Equal(expectedCode, error.Code);
        }

        [Theory]
        [InlineData("-32603.0")]
        [InlineData("-3.2603e4")]
        public void AcceptsMathematicallyIntegralErrorCode(string number)
        {
            byte[] payload = Encoding.UTF8.GetBytes(
                "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"error\":{\"code\":" +
                number +
                ",\"message\":\"failed\"}}");

            AddinJsonRpcResponse response =
                AddinJsonRpcCodec.ParseResponse(payload, "x");

            Assert.Equal(-32603, response.Error!.Code);
        }

        [Theory]
        [InlineData(
            "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"method\":\"mcp_status\",\"params\":{},\"extra\":true}",
            "unexpected_request_property")]
        [InlineData(
            "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"method\":\"McpStatus\",\"params\":{}}",
            "invalid_method")]
        [InlineData(
            "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"method\":\"mcp_status\",\"params\":[]}",
            "invalid_request_params")]
        [InlineData(
            "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"id\":\"y\",\"method\":\"mcp_status\",\"params\":{}}",
            "duplicate_property")]
        public void RejectsInvalidRequests(string json, string expectedCode)
        {
            Exception error = Assert.ThrowsAny<Exception>(
                () => AddinJsonRpcCodec.ParseRequest(
                    Encoding.UTF8.GetBytes(json)));

            string actualCode = error is AddinJsonRpcProtocolException protocol
                ? protocol.Code
                : ((StrictJsonException)error).Code;
            Assert.Equal(expectedCode, actualCode);
        }

        [Fact]
        public void RequestIdBoundaryIsOneThrough128Characters()
        {
            AddinJsonRpcCodec.SerializeRequest(
                new string('x', 128),
                "mcp_status",
                new JObject());

            AddinJsonRpcProtocolException empty =
                Assert.Throws<AddinJsonRpcProtocolException>(
                    () => AddinJsonRpcCodec.SerializeRequest(
                        string.Empty,
                        "mcp_status",
                        new JObject()));
            AddinJsonRpcProtocolException longId =
                Assert.Throws<AddinJsonRpcProtocolException>(
                    () => AddinJsonRpcCodec.SerializeRequest(
                        new string('x', 129),
                        "mcp_status",
                        new JObject()));

            Assert.Equal("invalid_request_id", empty.Code);
            Assert.Equal("invalid_request_id", longId.Code);
        }

        [Fact]
        public void RequestIdMaxLengthCountsUnicodeCodePoints()
        {
            string acceptedId = string.Concat(
                Enumerable.Repeat("\U0001F600", 128));
            byte[] payload = AddinJsonRpcCodec.SerializeRequest(
                acceptedId,
                "mcp_status",
                new JObject());

            AddinJsonRpcRequest request = AddinJsonRpcCodec.ParseRequest(payload);
            Assert.Equal(acceptedId, request.Id);

            string rejectedId = string.Concat(
                Enumerable.Repeat("\U0001F600", 129));
            AddinJsonRpcProtocolException error =
                Assert.Throws<AddinJsonRpcProtocolException>(
                    () => AddinJsonRpcCodec.SerializeRequest(
                        rejectedId,
                        "mcp_status",
                        new JObject()));

            Assert.Equal("invalid_request_id", error.Code);
        }

        [Fact]
        public void ErrorMessageMaxLengthCountsSixHundredUnicodeCodePoints()
        {
            string acceptedMessage = string.Concat(
                Enumerable.Repeat("\U0001F600", 600));
            var acceptedEnvelope = new JObject
            {
                ["jsonrpc"] = "2.0",
                ["id"] = "unicode-message",
                ["error"] = new JObject
                {
                    ["code"] = -32603,
                    ["message"] = acceptedMessage,
                },
            };

            AddinJsonRpcResponse response = AddinJsonRpcCodec.ParseResponse(
                Encoding.UTF8.GetBytes(acceptedEnvelope.ToString(Formatting.None)));
            Assert.Equal(acceptedMessage, response.Error!.Message);

            string rejectedMessage = string.Concat(
                Enumerable.Repeat("\U0001F600", 601));
            acceptedEnvelope["error"]!["message"] = rejectedMessage;
            AddinJsonRpcProtocolException error =
                Assert.Throws<AddinJsonRpcProtocolException>(
                    () => AddinJsonRpcCodec.ParseResponse(
                        Encoding.UTF8.GetBytes(
                            acceptedEnvelope.ToString(Formatting.None))));

            Assert.Equal("invalid_error_message", error.Code);
        }
    }
}
