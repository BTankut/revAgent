using System.Net;
using System.Net.Http.Headers;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed class StreamableHttpRbpConnectionCycleFactory :
    IRbpConnectionCycleFactory
{
    private static readonly IReadOnlyList<int> SupportedProtocols =
        Array.AsReadOnly(new[] { 1 });

    private readonly IRbpEnrollmentStateProvider _enrollment;
    private readonly IRbpHttpClientFactory _clients;
    private readonly RbpHelloFactory _helloFactory;
    private readonly TimeProvider _timeProvider;
    private readonly bool _streamableHttpProvisioned;

    internal StreamableHttpRbpConnectionCycleFactory(
        IRbpEnrollmentStateProvider enrollment,
        IReadOnlyCollection<string> provisionedCapabilities,
        IRbpHttpClientFactory? clients = null,
        RbpHelloFactory? helloFactory = null,
        TimeProvider? timeProvider = null)
    {
        _enrollment = enrollment ??
            throw new ArgumentNullException(nameof(enrollment));
        _clients =
            clients ?? new SystemProxyRbpHttpClientFactory();
        ArgumentNullException.ThrowIfNull(provisionedCapabilities);
        _streamableHttpProvisioned =
            provisionedCapabilities.Contains(
                RbpTransportCapabilities.StreamableHttp,
                StringComparer.Ordinal);
        _timeProvider = timeProvider ?? TimeProvider.System;
        _helloFactory =
            helloFactory ?? new RbpHelloFactory(_timeProvider);
    }

    public RbpConnectionBindingKind BindingKind =>
        RbpConnectionBindingKind.StreamableHttpSse;

    public string ExpectedEndpointScheme => Uri.UriSchemeHttps;

    public async Task<IRbpConnectionCycle> OpenAsync(
        Uri endpoint,
        RbpHelloProfile profile,
        CancellationToken cancellationToken = default)
    {
        RbpConnectionBindingContract.RequireExpectedEndpointScheme(
            endpoint,
            ExpectedEndpointScheme,
            nameof(endpoint));
        ArgumentNullException.ThrowIfNull(profile);
        if (!_streamableHttpProvisioned ||
            !profile.Capabilities.Contains(
                RbpTransportCapabilities.StreamableHttp,
                StringComparer.Ordinal))
        {
            throw new RbpGatewayTransportException(
                RbpGatewayFailureKind.Protocol,
                "The fallback binding is not both provisioned and declared.");
        }

        RbpEnrollmentSnapshot enrollment =
            await _enrollment.ReadAsync(cancellationToken)
                .ConfigureAwait(false);
        if (enrollment.Status != RbpEnrollmentStatus.Ready ||
            enrollment.Credential is not { } credential)
        {
            throw new RbpGatewayTransportException(
                enrollment.Status == RbpEnrollmentStatus.Invalid
                    ? RbpGatewayFailureKind.Authorization
                    : RbpGatewayFailureKind.EnrollmentRequired,
                "The fallback cannot open until enrollment is ready " +
                $"({enrollment.DiagnosticCode}).");
        }

        HttpClient client = _clients.Create() ??
            throw new InvalidOperationException(
                "The fallback HTTP client factory returned null.");
        HttpResponseMessage? eventsResponse = null;
        Stream? eventsStream = null;
        try
        {
            RbpEnvelope hello = _helloFactory.Create(credential, profile);
            string connectionId;
            RbpHelloAckPayload acknowledgement;
            try
            {
                (connectionId, acknowledgement) =
                    await CreateConnectionAsync(
                            client,
                            endpoint,
                            credential,
                            profile,
                            hello,
                            cancellationToken)
                        .ConfigureAwait(false);
            }
            catch (RbpGatewayTransportException exception)
            {
                // Only the create/hello exchange is correlatable to a
                // Gateway opening-refusal observation. A later event-stream
                // attach can fail authorization after hello_ack succeeded;
                // carrying hello.id through that failure would falsely make
                // it look like the same revoked-opening chain.
                throw exception.WithOpeningContext(
                    hello.Id,
                    RbpOpeningBinding.HttpSse);
            }

            (eventsResponse, eventsStream) =
                await OpenEventsAsync(
                        client,
                        endpoint,
                        connectionId,
                        credential,
                        cancellationToken)
                    .ConfigureAwait(false);
            return new StreamableHttpRbpConnectionCycle(
                client,
                eventsResponse,
                eventsStream,
                RbpHttpBindingProtocol.MessagesUri(
                    endpoint,
                    connectionId),
                credential,
                acknowledgement,
                _timeProvider);
        }
        catch
        {
            eventsStream?.Dispose();
            eventsResponse?.Dispose();
            client.Dispose();
            throw;
        }
    }

    private async Task<(string ConnectionId, RbpHelloAckPayload Ack)>
        CreateConnectionAsync(
            HttpClient client,
            Uri endpoint,
            RbpDeviceCredential credential,
            RbpHelloProfile profile,
            RbpEnvelope hello,
            CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            RbpHttpBindingProtocol.CreateConnectionUri(endpoint));
        RbpHttpBindingProtocol.ApplyHttpVersion(request);
        RbpHttpBindingProtocol.ApplyAuthenticatedHeaders(
            request,
            credential);
        request.Headers.TryAddWithoutValidation(
            "X-RBP-Versions",
            string.Join(",", SupportedProtocols));
        request.Headers.Accept.Add(
            new MediaTypeWithQualityHeaderValue("application/json"));
        request.Content =
            new ByteArrayContent(RbpEnvelopeCodec.Encode(hello));
        request.Content.Headers.ContentType =
            new MediaTypeHeaderValue("application/json");

        using HttpResponseMessage response =
            await SendOpeningRequestAsync(
                    client,
                    request,
                    "The fallback connection could not be created.",
                    cancellationToken)
                .ConfigureAwait(false);
        if (response.StatusCode != HttpStatusCode.Created)
        {
            RbpGatewayTransportException failure =
                RbpHttpBindingProtocol.StatusFailure(
                    response,
                    connectionAlreadyCreated: false,
                    _timeProvider.GetUtcNow());
            if (response.StatusCode == HttpStatusCode.UpgradeRequired)
            {
                byte[] versionBody = Array.Empty<byte>();
                Exception? bodyFailure = null;
                try
                {
                    versionBody =
                        await RbpHttpBindingProtocol
                            .ReadBoundedContentAsync(
                                response.Content,
                                RbpProtocolLimits.MaximumControlFrameBytes,
                                cancellationToken)
                            .ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                    when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception exception)
                {
                    bodyFailure = exception;
                }

                failure = new RbpGatewayTransportException(
                    failure.Kind,
                    failure.Message,
                    statusCode: failure.StatusCode,
                    versionWindow:
                        RbpGatewayConnection.ParseVersionWindow(
                            System.Text.Encoding.UTF8.GetString(
                                versionBody)),
                    innerException: bodyFailure is null
                        ? failure
                        : new AggregateException(
                            failure,
                            bodyFailure));
            }

            throw failure;
        }

        string connectionId =
            RbpHttpBindingProtocol.ReadConnectionId(response);
        byte[] body;
        try
        {
            body =
                await RbpHttpBindingProtocol.ReadBoundedContentAsync(
                        response.Content,
                        RbpProtocolLimits.MaximumControlFrameBytes,
                        cancellationToken)
                    .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
            when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (RbpGatewayTransportException exception)
        {
            throw RbpHttpBindingProtocol.Protocol(
                "The successful fallback create response did not contain " +
                "one complete hello_ack body.",
                exception);
        }
        RbpEnvelope opening;
        try
        {
            opening = RbpEnvelopeCodec.Decode(body);
        }
        catch (RbpFrameException exception)
        {
            throw RbpHttpBindingProtocol.Protocol(
                "The fallback create response contained invalid RBP.",
                exception);
        }

        if (!string.Equals(
                opening.Type,
                "hello_ack",
                StringComparison.Ordinal) ||
            opening.HelloAck is not { } acknowledgement)
        {
            throw RbpHttpBindingProtocol.Protocol(
                "The fallback create response did not contain hello_ack.");
        }

        ValidateAcknowledgement(
            acknowledgement,
            connectionId,
            profile);
        return (connectionId, acknowledgement);
    }

    private async Task<(HttpResponseMessage Response, Stream Stream)>
        OpenEventsAsync(
            HttpClient client,
            Uri endpoint,
            string connectionId,
            RbpDeviceCredential credential,
            CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            RbpHttpBindingProtocol.EventsUri(endpoint, connectionId));
        RbpHttpBindingProtocol.ApplyHttpVersion(request);
        RbpHttpBindingProtocol.ApplyAuthenticatedHeaders(
            request,
            credential);
        request.Headers.Accept.Add(
            new MediaTypeWithQualityHeaderValue("text/event-stream"));
        request.Headers.CacheControl =
            new CacheControlHeaderValue
            {
                NoCache = true,
                NoStore = true,
            };

        HttpResponseMessage response =
            await SendOpeningRequestAsync(
                    client,
                    request,
                    "The fallback event stream could not be opened.",
                    cancellationToken)
                .ConfigureAwait(false);
        try
        {
            if (response.StatusCode != HttpStatusCode.OK)
            {
                throw RbpHttpBindingProtocol.StatusFailure(
                    response,
                    connectionAlreadyCreated: true,
                    _timeProvider.GetUtcNow());
            }

            if (!string.Equals(
                    response.Content.Headers.ContentType?.MediaType,
                    "text/event-stream",
                    StringComparison.OrdinalIgnoreCase) ||
                response.Content.Headers.ContentEncoding.Count != 0)
            {
                throw RbpHttpBindingProtocol.Protocol(
                    "The fallback event response is not an untransformed " +
                    "text/event-stream.");
            }

            Stream stream;
            try
            {
                stream =
                    await response.Content
                        .ReadAsStreamAsync(cancellationToken)
                        .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
                when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
                when (exception is HttpRequestException or IOException)
            {
                throw RbpHttpBindingProtocol.RequestFailure(
                    "The fallback event stream body could not be opened.",
                    exception);
            }

            return (response, stream);
        }
        catch
        {
            response.Dispose();
            throw;
        }
    }

    private static async Task<HttpResponseMessage> SendOpeningRequestAsync(
        HttpClient client,
        HttpRequestMessage request,
        string failureMessage,
        CancellationToken cancellationToken)
    {
        try
        {
            return await client.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
            when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
            when (exception is HttpRequestException or IOException)
        {
            throw RbpHttpBindingProtocol.RequestFailure(
                failureMessage,
                exception);
        }
    }

    private static void ValidateAcknowledgement(
        RbpHelloAckPayload acknowledgement,
        string connectionId,
        RbpHelloProfile profile)
    {
        if (acknowledgement.Protocol != 1 ||
            !string.Equals(
                acknowledgement.ConnectionId,
                connectionId,
                StringComparison.Ordinal) ||
            acknowledgement.GrantedCapabilities.Any(
                capability =>
                    !profile.Capabilities.Contains(
                        capability,
                        StringComparer.Ordinal)) ||
            !acknowledgement.GrantedCapabilities.Contains(
                RbpTransportCapabilities.StreamableHttp,
                StringComparer.Ordinal))
        {
            throw RbpHttpBindingProtocol.Protocol(
                "The fallback hello_ack violated protocol, connection-id, " +
                "or capability authority.");
        }
    }
}
