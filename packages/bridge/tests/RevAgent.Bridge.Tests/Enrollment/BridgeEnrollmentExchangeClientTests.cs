using System.Net;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

public sealed class BridgeEnrollmentExchangeClientTests
{
    private const string EnrollmentTokenValue =
        "exchange-enroll-token-0123456789ABCDEFGHIJKLMNOPQRSTUV";
    private const string IssuedDeviceToken =
        "issued-device-token-0123456789ABCDEFGHIJKLMNOPQRSTUVWX";
    private static readonly string MachineFingerprint =
        "sha256:" + new string('a', 64);
    private static readonly Uri Endpoint =
        new("https://gateway.revagent.example/bridge/v1/enroll");

    [Fact]
    public void CreateEnrollmentEndpoint_DerivesHttpsEnrollFromWss()
    {
        Uri derived = BridgeEnrollmentExchangeClient.CreateEnrollmentEndpoint(
            new Uri("wss://gateway.revagent.example:8443/bridge/v1"));

        Assert.Equal(
            "https://gateway.revagent.example:8443/bridge/v1/enroll",
            derived.AbsoluteUri);
        Assert.Throws<ArgumentException>(
            () => BridgeEnrollmentExchangeClient.CreateEnrollmentEndpoint(
                new Uri("https://gateway.revagent.example/bridge/v1")));
        Assert.Throws<ArgumentException>(
            () => BridgeEnrollmentExchangeClient.CreateEnrollmentEndpoint(
                new Uri("wss://gateway.revagent.example/bridge/v2")));
    }

    [Fact]
    public void Constructor_RequiresAbsoluteHttpsEndpoint()
    {
        Assert.Throws<ArgumentException>(
            () => new BridgeEnrollmentExchangeClient(
                new Uri("http://gateway.revagent.example/bridge/v1/enroll")));
    }

    [Fact]
    public async Task SuccessfulExchange_SendsExactContractAndIssuesCredential()
    {
        var handler = new ScriptedHandler(
            JsonResponse(
                HttpStatusCode.OK,
                $$"""
                {"device_id":"device-77","device_token":"{{IssuedDeviceToken}}"}
                """));
        BridgeEnrollmentExchangeClient client = CreateClient(handler);
        using BridgeEnrollmentToken token =
            BridgeEnrollmentToken.Parse(EnrollmentTokenValue);

        using BridgeIssuedDeviceCredential issued =
            await client.ExchangeAsync(token, MachineFingerprint);

        Assert.Equal("device-77", issued.DeviceId);
        Assert.Equal(IssuedDeviceToken, issued.DeviceToken.Reveal());
        Assert.True(token.IsConsumed);
        Assert.Equal(Endpoint, handler.LastRequestUri);
        Assert.Equal(
            "application/json",
            handler.LastContentType);
        using JsonDocument request = JsonDocument.Parse(handler.LastBody!);
        Assert.Equal(
            EnrollmentTokenValue,
            request.RootElement
                .GetProperty("enrollment_token")
                .GetString());
        Assert.Equal(
            MachineFingerprint,
            request.RootElement
                .GetProperty("machine_fingerprint")
                .GetString());
        Assert.Equal(2, request.RootElement.EnumerateObject().Count());
        Assert.DoesNotContain(
            IssuedDeviceToken,
            issued.ToString(),
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(
        401,
        (int)BridgeCredentialUnavailableErrorCode.EnrollmentTokenRejected)]
    [InlineData(
        403,
        (int)BridgeCredentialUnavailableErrorCode.EnrollmentDenied)]
    [InlineData(
        409,
        (int)BridgeCredentialUnavailableErrorCode.EnrollmentTokenReused)]
    [InlineData(
        500,
        (int)BridgeCredentialUnavailableErrorCode
            .EnrollmentEndpointUnavailable)]
    [InlineData(
        503,
        (int)BridgeCredentialUnavailableErrorCode
            .EnrollmentEndpointUnavailable)]
    [InlineData(
        302,
        (int)BridgeCredentialUnavailableErrorCode
            .EnrollmentProtocolViolation)]
    public async Task RejectionStatuses_MapToFailClosedClasses(
        int statusCode,
        int expectedErrorCode)
    {
        var handler = new ScriptedHandler(
            JsonResponse(
                (HttpStatusCode)statusCode,
                """{"error":"rejected"}"""));
        BridgeEnrollmentExchangeClient client = CreateClient(handler);
        using BridgeEnrollmentToken token =
            BridgeEnrollmentToken.Parse(EnrollmentTokenValue);

        BridgeCredentialUnavailableException exception =
            await Assert.ThrowsAsync<BridgeCredentialUnavailableException>(
                () => client.ExchangeAsync(token, MachineFingerprint));

        Assert.Equal(
            (BridgeCredentialUnavailableErrorCode)expectedErrorCode,
            exception.ErrorCode);
        Assert.DoesNotContain(
            EnrollmentTokenValue,
            exception.ToString(),
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("not json at all")]
    [InlineData("""{"device_id":"device-77"}""")]
    [InlineData("""{"device_id":"device-77","device_token":42}""")]
    [InlineData(
        """
        {"device_id":"device-77","device_token":"short","extra":true}
        """)]
    public async Task MalformedSuccessBodies_FailClosedAsProtocolViolations(
        string body)
    {
        var handler = new ScriptedHandler(
            JsonResponse(HttpStatusCode.OK, body));
        BridgeEnrollmentExchangeClient client = CreateClient(handler);
        using BridgeEnrollmentToken token =
            BridgeEnrollmentToken.Parse(EnrollmentTokenValue);

        BridgeCredentialUnavailableException exception =
            await Assert.ThrowsAsync<BridgeCredentialUnavailableException>(
                () => client.ExchangeAsync(token, MachineFingerprint));

        Assert.Equal(
            BridgeCredentialUnavailableErrorCode.EnrollmentProtocolViolation,
            exception.ErrorCode);
    }

    [Fact]
    public async Task NetworkFailure_IsClassifiedUnavailableWithoutLeaks()
    {
        var handler = new ScriptedHandler(
            new HttpRequestException("socket refused"));
        BridgeEnrollmentExchangeClient client = CreateClient(handler);
        using BridgeEnrollmentToken token =
            BridgeEnrollmentToken.Parse(EnrollmentTokenValue);

        BridgeCredentialUnavailableException exception =
            await Assert.ThrowsAsync<BridgeCredentialUnavailableException>(
                () => client.ExchangeAsync(token, MachineFingerprint));

        Assert.Equal(
            BridgeCredentialUnavailableErrorCode
                .EnrollmentEndpointUnavailable,
            exception.ErrorCode);
        Assert.Null(exception.InnerException);
        Assert.DoesNotContain(
            EnrollmentTokenValue,
            exception.ToString(),
            StringComparison.Ordinal);
    }

    private static BridgeEnrollmentExchangeClient CreateClient(
        ScriptedHandler handler) =>
        new(Endpoint, () => handler);

    private static HttpResponseMessage JsonResponse(
        HttpStatusCode status,
        string body) =>
        new(status)
        {
            Content = new StringContent(
                body,
                Encoding.UTF8,
                "application/json"),
        };

    private sealed class ScriptedHandler : HttpMessageHandler
    {
        private readonly HttpResponseMessage? _response;
        private readonly Exception? _exception;

        internal ScriptedHandler(HttpResponseMessage response)
        {
            _response = response;
        }

        internal ScriptedHandler(Exception exception)
        {
            _exception = exception;
        }

        internal Uri? LastRequestUri { get; private set; }

        internal string? LastContentType { get; private set; }

        internal string? LastBody { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            LastRequestUri = request.RequestUri;
            LastContentType =
                request.Content?.Headers.ContentType?.MediaType;
            LastBody = request.Content is null
                ? null
                : await request.Content
                    .ReadAsStringAsync(cancellationToken);
            if (_exception is not null)
            {
                throw _exception;
            }

            return _response!;
        }
    }
}
