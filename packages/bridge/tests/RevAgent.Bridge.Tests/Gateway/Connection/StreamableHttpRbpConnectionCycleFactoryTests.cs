using System.Net;
using System.Security.Authentication;
using System.Text;
using RevAgent.Bridge.Gateway.Connection;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed class StreamableHttpRbpConnectionCycleFactoryTests
{
    [Fact]
    public async Task EnrollmentFailureDoesNotCreateHttpClient()
    {
        var clients = new CountingClientFactory();
        var factory = new StreamableHttpRbpConnectionCycleFactory(
            new EnrollmentRequiredStateProvider(),
            new[] { RbpTransportCapabilities.StreamableHttp },
            clients);

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => factory.OpenAsync(
                    StreamableHttpRbpConnectionCycleTests.Endpoint(),
                    StreamableHttpRbpConnectionCycleTests.Profile()));

        Assert.Equal(
            RbpGatewayFailureKind.EnrollmentRequired,
            exception.Kind);
        Assert.Equal(0, clients.CreateCount);
    }

    [Fact]
    public async Task UndeclaredFallbackFailsBeforeEnrollmentOrNetwork()
    {
        var clients = new CountingClientFactory();
        var factory = new StreamableHttpRbpConnectionCycleFactory(
            new EnrollmentRequiredStateProvider(),
            new[] { RbpTransportCapabilities.StreamableHttp },
            clients);
        var profile = new RbpHelloProfile(
            "0.1.0-test",
            "host",
            "Windows",
            Array.Empty<string>(),
            Array.Empty<string>());

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => factory.OpenAsync(
                    StreamableHttpRbpConnectionCycleTests.Endpoint(),
                    profile));

        Assert.Equal(RbpGatewayFailureKind.Protocol, exception.Kind);
        Assert.Equal(0, clients.CreateCount);
    }

    [Fact]
    public async Task UnprovisionedFallbackFailsBeforeEnrollmentOrNetwork()
    {
        var clients = new CountingClientFactory();
        var factory = new StreamableHttpRbpConnectionCycleFactory(
            new FixedEnrollmentProvider(
                StreamableHttpRbpConnectionCycleTests.Credential()),
            Array.Empty<string>(),
            clients);

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => factory.OpenAsync(
                    StreamableHttpRbpConnectionCycleTests.Endpoint(),
                    StreamableHttpRbpConnectionCycleTests.Profile()));

        Assert.Equal(RbpGatewayFailureKind.Protocol, exception.Kind);
        Assert.Equal(0, clients.CreateCount);
    }

    [Theory]
    [InlineData("https://127.0.0.1/bridge/v1")]
    [InlineData("https://[::1]/bridge/v1")]
    [InlineData("https://gateway.revagent.example/other")]
    [InlineData("wss://gateway.revagent.example/bridge/v1")]
    [InlineData("https://gateway.revagent.example/bridge/v1?x=1")]
    public async Task EndpointMustUseExactHttpsDnsAuthority(
        string endpoint)
    {
        var handler = new ScriptedHttpMessageHandler(
            (_, _) => Task.FromResult(
                new HttpResponseMessage(HttpStatusCode.InternalServerError)));
        var factory = Factory(handler);

        await Assert.ThrowsAsync<ArgumentException>(
            () => factory.OpenAsync(
                new Uri(endpoint),
                StreamableHttpRbpConnectionCycleTests.Profile()));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task MissingConnectionHeaderFailsClosed()
    {
        var handler = new ScriptedHttpMessageHandler(
            (_, _) =>
            {
                var response =
                    new HttpResponseMessage(HttpStatusCode.Created)
                    {
                        Content = new ByteArrayContent(
                            StreamableHttpRbpConnectionCycleTests.HelloAck(
                                "conn-test")),
                    };
                return Task.FromResult(response);
            });

        RbpGatewayTransportException exception =
            await OpenFailureAsync(handler);

        Assert.Equal(RbpGatewayFailureKind.Protocol, exception.Kind);
    }

    [Fact]
    public async Task DuplicateConnectionHeaderFailsClosed()
    {
        var handler = new ScriptedHttpMessageHandler(
            (_, _) =>
            {
                HttpResponseMessage response =
                    StreamableHttpResponses.Created(
                        "conn-test",
                        StreamableHttpRbpConnectionCycleTests.HelloAck(
                            "conn-test"));
                response.Headers.Remove("RBP-Connection-Id");
                response.Headers.TryAddWithoutValidation(
                    "RBP-Connection-Id",
                    new[] { "conn-test", "conn-other" });
                return Task.FromResult(response);
            });

        RbpGatewayTransportException exception =
            await OpenFailureAsync(handler);

        Assert.Equal(RbpGatewayFailureKind.Protocol, exception.Kind);
    }

    [Fact]
    public async Task HeaderAndHelloConnectionIdsMustMatchExactly()
    {
        var handler = new ScriptedHttpMessageHandler(
            (_, _) => Task.FromResult(
                StreamableHttpResponses.Created(
                    "conn-header",
                    StreamableHttpRbpConnectionCycleTests.HelloAck(
                        "conn-body"))));

        RbpGatewayTransportException exception =
            await OpenFailureAsync(handler);

        Assert.Equal(RbpGatewayFailureKind.Protocol, exception.Kind);
    }

    [Fact]
    public async Task FallbackHelloAckMustGrantCapability()
    {
        var handler = new ScriptedHttpMessageHandler(
            (_, _) => Task.FromResult(
                StreamableHttpResponses.Created(
                    "conn-test",
                    StreamableHttpRbpConnectionCycleTests.HelloAck(
                        "conn-test",
                        grantFallback: false))));

        RbpGatewayTransportException exception =
            await OpenFailureAsync(handler);

        Assert.Equal(RbpGatewayFailureKind.Protocol, exception.Kind);
    }

    [Theory]
    [InlineData(false, true, true)]
    [InlineData(true, false, true)]
    [InlineData(true, true, false)]
    public async Task FallbackRejectsWhenAnyCapabilityAuthorityIsAbsent(
        bool provisioned,
        bool declared,
        bool granted)
    {
        var handler = new ScriptedHttpMessageHandler(
            (_, _) => Task.FromResult(
                StreamableHttpResponses.Created(
                    "conn-test",
                    StreamableHttpRbpConnectionCycleTests.HelloAck(
                        "conn-test",
                        grantFallback: granted))));
        var factory = new StreamableHttpRbpConnectionCycleFactory(
            new FixedEnrollmentProvider(
                StreamableHttpRbpConnectionCycleTests.Credential()),
            provisioned
                ? new[] { RbpTransportCapabilities.StreamableHttp }
                : Array.Empty<string>(),
            new FixedHttpClientFactory(handler));
        var profile = new RbpHelloProfile(
            "0.1.0-test",
            "host",
            "Windows",
            Array.Empty<string>(),
            declared
                ? new[] { RbpTransportCapabilities.StreamableHttp }
                : Array.Empty<string>());

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => factory.OpenAsync(
                    StreamableHttpRbpConnectionCycleTests.Endpoint(),
                    profile));

        Assert.Equal(RbpGatewayFailureKind.Protocol, exception.Kind);
        if (!provisioned || !declared)
        {
            Assert.Empty(handler.Requests);
        }
        else
        {
            Assert.Single(handler.Requests);
        }
    }

    [Fact]
    public async Task FallbackDeniesAWithdrawnTransportCapabilityAfterGrant()
    {
        var events = new PushSseStream();
        int requestNumber = 0;
        var handler = new ScriptedHttpMessageHandler(
            (_, _) => Task.FromResult(
                Interlocked.Increment(ref requestNumber) == 1
                    ? StreamableHttpResponses.Created(
                        "conn-test",
                        StreamableHttpRbpConnectionCycleTests.HelloAck(
                            "conn-test"))
                    : StreamableHttpResponses.Events(events)));
        var factory = Factory(handler);

        await using (IRbpConnectionCycle granted = await factory.OpenAsync(
                         StreamableHttpRbpConnectionCycleTests.Endpoint(),
                         StreamableHttpRbpConnectionCycleTests.Profile()))
        {
            Assert.Contains(
                RbpTransportCapabilities.StreamableHttp,
                granted.Acknowledgement.GrantedCapabilities);
        }

        int requestCountBeforeWithdrawal = handler.Requests.Count;
        var withdrawn = new RbpHelloProfile(
            "0.1.0-test",
            "fixture-host",
            "Windows test",
            Array.Empty<string>());
        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => factory.OpenAsync(
                    StreamableHttpRbpConnectionCycleTests.Endpoint(),
                    withdrawn));

        Assert.Equal(RbpGatewayFailureKind.Protocol, exception.Kind);
        Assert.Equal(requestCountBeforeWithdrawal, handler.Requests.Count);
        events.Dispose();
    }

    [Fact]
    public async Task OpaqueConnectionIdIsOneEscapedPathSegment()
    {
        const string connectionId = "opaque/segment with space";
        var events = new PushSseStream();
        int requestNumber = 0;
        var handler = new ScriptedHttpMessageHandler(
            (_, _) =>
            {
                if (Interlocked.Increment(ref requestNumber) == 1)
                {
                    return Task.FromResult(
                        StreamableHttpResponses.Created(
                            connectionId,
                            StreamableHttpRbpConnectionCycleTests.HelloAck(
                                connectionId)));
                }

                return Task.FromResult(
                    StreamableHttpResponses.Events(events));
            });

        await using IRbpConnectionCycle cycle =
            await Factory(handler).OpenAsync(
                StreamableHttpRbpConnectionCycleTests.Endpoint(),
                StreamableHttpRbpConnectionCycleTests.Profile());

        RecordedHttpRequest eventsRequest =
            Assert.Single(handler.Requests.Skip(1));
        Assert.Contains(
            "/opaque%2Fsegment%20with%20space/events",
            eventsRequest.Uri.AbsoluteUri,
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(401, (int)RbpGatewayFailureKind.Authentication)]
    [InlineData(403, (int)RbpGatewayFailureKind.Authorization)]
    [InlineData(408, (int)RbpGatewayFailureKind.Network)]
    [InlineData(429, (int)RbpGatewayFailureKind.Network)]
    [InlineData(502, (int)RbpGatewayFailureKind.Network)]
    [InlineData(503, (int)RbpGatewayFailureKind.Network)]
    [InlineData(504, (int)RbpGatewayFailureKind.Network)]
    [InlineData(200, (int)RbpGatewayFailureKind.Protocol)]
    [InlineData(204, (int)RbpGatewayFailureKind.Protocol)]
    [InlineData(302, (int)RbpGatewayFailureKind.Protocol)]
    public async Task CreateStatusUsesFrozenOpeningClassification(
        int status,
        int expectedKind)
    {
        var handler = new ScriptedHttpMessageHandler(
            (_, _) => Task.FromResult(
                new HttpResponseMessage((HttpStatusCode)status)));

        RbpGatewayTransportException exception =
            await OpenFailureAsync(handler);

        Assert.Equal(
            (RbpGatewayFailureKind)expectedKind,
            exception.Kind);
        Assert.False(exception.FallbackEligible);
        Assert.NotNull(exception.OpeningContext);
        Assert.Equal(
            RbpOpeningBinding.HttpSse,
            exception.OpeningContext.Binding);
        Assert.True(Guid.TryParse(exception.OpeningContext.CorrelationId, out _));
    }

    [Fact]
    public async Task Create426CarriesOnlyFrozenVersionWindow()
    {
        var handler = new ScriptedHttpMessageHandler(
            (_, _) => Task.FromResult(
                new HttpResponseMessage(HttpStatusCode.UpgradeRequired)
                {
                    Content = new StringContent(
                        """
                        {"min_protocol":2,"max_protocol":3,"manifest_url":"/bridge/update/manifest"}
                        """,
                        Encoding.UTF8,
                        "application/json"),
                }));

        RbpGatewayTransportException exception =
            await OpenFailureAsync(handler);

        Assert.Equal(RbpGatewayFailureKind.Version, exception.Kind);
        Assert.Equal(2, exception.VersionWindow!.MinimumProtocol);
        Assert.True(exception.RetryPaused);
    }

    [Fact]
    public async Task Unreadable426BodyStillPausesAsVersion()
    {
        var handler = new ScriptedHttpMessageHandler(
            (_, _) => Task.FromResult(
                new HttpResponseMessage(HttpStatusCode.UpgradeRequired)
                {
                    Content =
                        new StreamContent(new ThrowingReadStream()),
                }));

        RbpGatewayTransportException exception =
            await OpenFailureAsync(handler);

        Assert.Equal(RbpGatewayFailureKind.Version, exception.Kind);
        Assert.Null(exception.VersionWindow);
        Assert.True(exception.RetryPaused);
    }

    [Fact]
    public async Task UnreadableSuccessfulCreateBodyIsProtocol()
    {
        var handler = new ScriptedHttpMessageHandler(
            (_, _) =>
            {
                var response =
                    new HttpResponseMessage(HttpStatusCode.Created)
                    {
                        Content =
                            new StreamContent(new ThrowingReadStream()),
                    };
                response.Headers.TryAddWithoutValidation(
                    "RBP-Connection-Id",
                    "conn-test");
                return Task.FromResult(response);
            });

        RbpGatewayTransportException exception =
            await OpenFailureAsync(handler);

        Assert.Equal(RbpGatewayFailureKind.Protocol, exception.Kind);
    }

    [Fact]
    public async Task RetryAfterIsBoundedOnFallbackHttpFailure()
    {
        var handler = new ScriptedHttpMessageHandler(
            (_, _) =>
            {
                var response =
                    new HttpResponseMessage(
                        HttpStatusCode.ServiceUnavailable);
                response.Headers.TryAddWithoutValidation(
                    "Retry-After",
                    "7");
                return Task.FromResult(response);
            });

        DateTimeOffset before = DateTimeOffset.UtcNow;
        RbpGatewayTransportException exception =
            await OpenFailureAsync(handler);
        DateTimeOffset after = DateTimeOffset.UtcNow;

        Assert.Equal(
            RbpRetryAfterDisposition.Accepted,
            exception.RetryAfterDisposition);
        Assert.InRange(
            exception.RetryNotBeforeUtc!.Value,
            before.AddSeconds(7),
            after.AddSeconds(7));
    }

    [Fact]
    public async Task TlsFailureIsTerminalTrustAndNeverDowngradeEligible()
    {
        var handler = new ScriptedHttpMessageHandler(
            (_, _) => throw new HttpRequestException(
                HttpRequestError.SecureConnectionError,
                "certificate rejected",
                new AuthenticationException("untrusted")));

        RbpGatewayTransportException exception =
            await OpenFailureAsync(handler);

        Assert.Equal(RbpGatewayFailureKind.Trust, exception.Kind);
        Assert.True(exception.RetryPaused);
        Assert.False(exception.FallbackEligible);
    }

    [Theory]
    [InlineData("application/json", null)]
    [InlineData("text/event-stream", "gzip")]
    public async Task EventsMustBeUntransformedEventStream(
        string mediaType,
        string? encoding)
    {
        var stream = new PushSseStream();
        int requestNumber = 0;
        var handler = new ScriptedHttpMessageHandler(
            (_, _) =>
            {
                if (Interlocked.Increment(ref requestNumber) == 1)
                {
                    return Task.FromResult(
                        StreamableHttpResponses.Created(
                            "conn-test",
                            StreamableHttpRbpConnectionCycleTests.HelloAck(
                                "conn-test")));
                }

                var response =
                    new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StreamContent(stream),
                    };
                response.Content.Headers.ContentType =
                    new System.Net.Http.Headers.MediaTypeHeaderValue(
                        mediaType);
                if (encoding is not null)
                {
                    response.Content.Headers.ContentEncoding.Add(encoding);
                }

                return Task.FromResult(response);
            });

        RbpGatewayTransportException exception =
            await OpenFailureAsync(handler);

        Assert.Equal(RbpGatewayFailureKind.Protocol, exception.Kind);
        stream.Dispose();
    }

    [Theory]
    [InlineData(404)]
    [InlineData(410)]
    public async Task ExpiredConnectionBeforeEventsEndsCycle(int status)
    {
        int requestNumber = 0;
        var handler = new ScriptedHttpMessageHandler(
            (_, _) =>
            {
                if (Interlocked.Increment(ref requestNumber) == 1)
                {
                    return Task.FromResult(
                        StreamableHttpResponses.Created(
                            "conn-test",
                            StreamableHttpRbpConnectionCycleTests.HelloAck(
                                "conn-test")));
                }

                return Task.FromResult(
                    new HttpResponseMessage((HttpStatusCode)status));
            });

        RbpGatewayTransportException exception =
            await OpenFailureAsync(handler);

        Assert.Equal(
            RbpGatewayFailureKind.RemoteClosed,
            exception.Kind);
    }

    [Fact]
    public async Task EventsAuthorizationFailureIsNotHelloCorrelated()
    {
        int requestNumber = 0;
        var handler = new ScriptedHttpMessageHandler(
            (_, _) =>
            {
                if (Interlocked.Increment(ref requestNumber) == 1)
                {
                    return Task.FromResult(
                        StreamableHttpResponses.Created(
                            "conn-test",
                            StreamableHttpRbpConnectionCycleTests.HelloAck(
                                "conn-test")));
                }

                return Task.FromResult(
                    new HttpResponseMessage(HttpStatusCode.Forbidden));
            });

        RbpGatewayTransportException exception =
            await OpenFailureAsync(handler);

        Assert.Equal(RbpGatewayFailureKind.Authorization, exception.Kind);
        Assert.Equal(403, exception.StatusCode);
        Assert.Null(exception.OpeningContext);
    }

    [Fact]
    public void ProductionClientUsesSystemProxyAndMachineTrustDefaults()
    {
        using SocketsHttpHandler handler =
            SystemProxyRbpHttpClientFactory.CreateHandler();

        Assert.True(handler.UseProxy);
        Assert.Null(handler.Proxy);
        Assert.False(handler.AllowAutoRedirect);
        Assert.False(handler.UseCookies);
        Assert.Equal(
            DecompressionMethods.None,
            handler.AutomaticDecompression);
        Assert.Null(
            handler.SslOptions.RemoteCertificateValidationCallback);
    }

    private static StreamableHttpRbpConnectionCycleFactory Factory(
        HttpMessageHandler handler) =>
        new(
            new FixedEnrollmentProvider(
                StreamableHttpRbpConnectionCycleTests.Credential()),
            new[] { RbpTransportCapabilities.StreamableHttp },
            new FixedHttpClientFactory(handler));

    private static async Task<RbpGatewayTransportException>
        OpenFailureAsync(HttpMessageHandler handler) =>
        await Assert.ThrowsAsync<RbpGatewayTransportException>(
            () => Factory(handler).OpenAsync(
                StreamableHttpRbpConnectionCycleTests.Endpoint(),
                StreamableHttpRbpConnectionCycleTests.Profile()));

    private sealed class CountingClientFactory : IRbpHttpClientFactory
    {
        internal int CreateCount { get; private set; }

        public HttpClient Create()
        {
            CreateCount++;
            throw new InvalidOperationException("Not expected.");
        }
    }
}
