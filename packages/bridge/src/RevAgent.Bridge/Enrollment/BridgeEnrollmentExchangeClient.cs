using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Enrollment;

/// <summary>
/// The device credential issued by a successful enrollment exchange:
/// the Gateway-assigned device id plus the zeroizing device token.
/// </summary>
internal sealed class BridgeIssuedDeviceCredential : IDisposable
{
    internal BridgeIssuedDeviceCredential(
        string deviceId,
        BridgeSecretString deviceToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(deviceId);
        ArgumentNullException.ThrowIfNull(deviceToken);
        if (deviceId.Length > 256)
        {
            throw new ArgumentOutOfRangeException(
                nameof(deviceId),
                "The issued device id must not exceed 256 characters.");
        }

        DeviceId = deviceId;
        DeviceToken = deviceToken;
    }

    internal string DeviceId { get; }

    internal BridgeSecretString DeviceToken { get; }

    public void Dispose() => DeviceToken.Dispose();

    public override string ToString() =>
        $"BridgeIssuedDeviceCredential {{ DeviceId = {DeviceId}, " +
        $"DeviceToken = [redacted] }}";
}

internal interface IBridgeEnrollmentExchangeClient
{
    Task<BridgeIssuedDeviceCredential> ExchangeAsync(
        BridgeEnrollmentToken enrollmentToken,
        string machineFingerprint,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Exchanges a single-use enrollment token for a device token against the
/// Gateway enroll endpoint:
/// <c>POST {enrollment_token, machine_fingerprint}</c> returning
/// <c>{device_id, device_token}</c>. Every rejection — 401, 403,
/// 409 token reuse, 5xx, or a malformed body — is classified fail-closed
/// into <see cref="BridgeCredentialUnavailableErrorCode"/>; no partial
/// success exists and no secret material appears in any failure.
/// </summary>
internal sealed class BridgeEnrollmentExchangeClient :
    IBridgeEnrollmentExchangeClient
{
    private const int MaximumResponseBytes = 64 * 1024;
    private static readonly TimeSpan ExchangeTimeout =
        TimeSpan.FromSeconds(30);

    private readonly Uri _enrollmentEndpoint;
    private readonly Func<HttpMessageHandler> _handlerFactory;

    internal BridgeEnrollmentExchangeClient(
        Uri enrollmentEndpoint,
        Func<HttpMessageHandler>? handlerFactory = null)
    {
        ArgumentNullException.ThrowIfNull(enrollmentEndpoint);
        if (!enrollmentEndpoint.IsAbsoluteUri ||
            !string.Equals(
                enrollmentEndpoint.Scheme,
                Uri.UriSchemeHttps,
                StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException(
                "The enrollment exchange endpoint must be an absolute " +
                "https URI.",
                nameof(enrollmentEndpoint));
        }

        _enrollmentEndpoint = enrollmentEndpoint;
        _handlerFactory =
            handlerFactory ??
            (static () => new HttpClientHandler { UseProxy = false });
    }

    /// <summary>
    /// Derives the enroll endpoint from the configured Gateway WSS
    /// endpoint: <c>wss://host:port/bridge/v1</c> becomes
    /// <c>https://host:port/bridge/v1/enroll</c>.
    /// </summary>
    internal static Uri CreateEnrollmentEndpoint(Uri gatewayUri)
    {
        ArgumentNullException.ThrowIfNull(gatewayUri);
        if (!gatewayUri.IsAbsoluteUri ||
            !string.Equals(
                gatewayUri.Scheme,
                Uri.UriSchemeWss,
                StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(
                gatewayUri.AbsolutePath,
                "/bridge/v1",
                StringComparison.Ordinal))
        {
            throw new ArgumentException(
                "The Gateway endpoint must use the exact " +
                "wss://host/bridge/v1 shape.",
                nameof(gatewayUri));
        }

        return new UriBuilder(gatewayUri)
        {
            Scheme = Uri.UriSchemeHttps,
            Path = "/bridge/v1/enroll",
        }.Uri;
    }

    public async Task<BridgeIssuedDeviceCredential> ExchangeAsync(
        BridgeEnrollmentToken enrollmentToken,
        string machineFingerprint,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(enrollmentToken);
        ArgumentException.ThrowIfNullOrWhiteSpace(machineFingerprint);

        using var client = new HttpClient(_handlerFactory(), disposeHandler: true)
        {
            Timeout = ExchangeTimeout,
        };
        using HttpResponseMessage response = await SendExchangeAsync(
                client,
                enrollmentToken,
                machineFingerprint,
                cancellationToken)
            .ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw ClassifyRejection(response.StatusCode);
        }

        byte[] body;
        try
        {
            body = await ReadBoundedBodyAsync(response, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception exception)
            when (exception is HttpRequestException or IOException)
        {
            throw Unavailable(
                "The enrollment exchange response could not be read.");
        }

        try
        {
            return ParseIssuedCredential(body);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(body);
        }
    }

    private async Task<HttpResponseMessage> SendExchangeAsync(
        HttpClient client,
        BridgeEnrollmentToken enrollmentToken,
        string machineFingerprint,
        CancellationToken cancellationToken)
    {
        byte[]? payload = null;
        try
        {
            payload = SerializeExchangeRequest(
                enrollmentToken,
                machineFingerprint);
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                _enrollmentEndpoint)
            {
                Content = new ByteArrayContent(payload),
            };
            request.Content.Headers.ContentType =
                new MediaTypeHeaderValue("application/json");
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
            when (exception is HttpRequestException or
                  IOException or
                  OperationCanceledException)
        {
            throw Unavailable(
                "The enrollment exchange endpoint could not be reached.");
        }
        finally
        {
            if (payload is not null)
            {
                CryptographicOperations.ZeroMemory(payload);
            }
        }
    }

    private static byte[] SerializeExchangeRequest(
        BridgeEnrollmentToken enrollmentToken,
        string machineFingerprint)
    {
        string tokenValue = enrollmentToken.ConsumeForExchange();
        using var stream = new MemoryStream(capacity: 512);
        using (var writer = new Utf8JsonWriter(
                   stream,
                   new JsonWriterOptions
                   {
                       Indented = false,
                       SkipValidation = false,
                   }))
        {
            writer.WriteStartObject();
            writer.WriteString("enrollment_token", tokenValue);
            writer.WriteString("machine_fingerprint", machineFingerprint);
            writer.WriteEndObject();
            writer.Flush();
        }

        int length = checked((int)stream.Length);
        byte[] backingBuffer = stream.GetBuffer();
        try
        {
            var result = new byte[length];
            backingBuffer.AsSpan(0, length).CopyTo(result);
            return result;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(
                backingBuffer.AsSpan(0, length));
        }
    }

    private static async Task<byte[]> ReadBoundedBodyAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        await using Stream stream = await response.Content
            .ReadAsStreamAsync(cancellationToken)
            .ConfigureAwait(false);
        using var buffered = new MemoryStream(capacity: 1024);
        var chunk = new byte[8 * 1024];
        int read;
        while ((read = await stream.ReadAsync(chunk, cancellationToken)
                   .ConfigureAwait(false)) > 0)
        {
            if (buffered.Length + read > MaximumResponseBytes)
            {
                CryptographicOperations.ZeroMemory(chunk);
                throw Malformed(
                    "The enrollment exchange response exceeds its bound.");
            }

            buffered.Write(chunk.AsSpan(0, read));
        }

        CryptographicOperations.ZeroMemory(chunk);
        int length = checked((int)buffered.Length);
        byte[] backingBuffer = buffered.GetBuffer();
        try
        {
            var result = new byte[length];
            backingBuffer.AsSpan(0, length).CopyTo(result);
            return result;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(
                backingBuffer.AsSpan(0, length));
        }
    }

    private static BridgeIssuedDeviceCredential ParseIssuedCredential(
        ReadOnlySpan<byte> json)
    {
        byte[]? tokenBytes = null;
        try
        {
            var reader = new Utf8JsonReader(
                json,
                new JsonReaderOptions
                {
                    AllowTrailingCommas = false,
                    CommentHandling = JsonCommentHandling.Disallow,
                    MaxDepth = 4,
                });
            if (!reader.Read() ||
                reader.TokenType != JsonTokenType.StartObject)
            {
                throw Malformed(
                    "The enrollment exchange response must be a JSON object.");
            }

            string? deviceId = null;
            int tokenLength = 0;
            while (reader.Read() &&
                   reader.TokenType != JsonTokenType.EndObject)
            {
                if (reader.TokenType != JsonTokenType.PropertyName)
                {
                    throw Malformed(
                        "The enrollment exchange response is invalid.");
                }

                string propertyName =
                    reader.GetString() ??
                    throw Malformed(
                        "The enrollment exchange response is invalid.");
                if (!reader.Read())
                {
                    throw Malformed(
                        "The enrollment exchange response is truncated.");
                }

                switch (propertyName)
                {
                    case "device_id":
                        if (reader.TokenType != JsonTokenType.String ||
                            deviceId is not null)
                        {
                            throw Malformed(
                                "The enrollment exchange device id is " +
                                "invalid.");
                        }

                        deviceId = reader.GetString();
                        break;
                    case "device_token":
                        if (reader.TokenType != JsonTokenType.String ||
                            reader.HasValueSequence ||
                            tokenBytes is not null)
                        {
                            throw Malformed(
                                "The enrollment exchange device token is " +
                                "invalid.");
                        }

                        tokenBytes = new byte[
                            Math.Max(reader.ValueSpan.Length, 1)];
                        tokenLength = reader.CopyString(tokenBytes);
                        break;
                    default:
                        throw Malformed(
                            "The enrollment exchange response contains an " +
                            "unknown property.");
                }
            }

            if (reader.TokenType != JsonTokenType.EndObject ||
                reader.Read() ||
                string.IsNullOrWhiteSpace(deviceId) ||
                tokenBytes is null)
            {
                throw Malformed(
                    "The enrollment exchange response is incomplete.");
            }

            BridgeSecretString? token = null;
            try
            {
                token = new BridgeSecretString(
                    tokenBytes.AsSpan(0, tokenLength));
                var credential = new BridgeIssuedDeviceCredential(
                    deviceId,
                    token);
                token = null;
                return credential;
            }
            finally
            {
                token?.Dispose();
            }
        }
        catch (Exception exception)
            when (exception is JsonException or
                  ArgumentException or
                  ArgumentOutOfRangeException)
        {
            throw Malformed(
                "The enrollment exchange response violates the issued " +
                "credential contract.");
        }
        finally
        {
            if (tokenBytes is not null)
            {
                CryptographicOperations.ZeroMemory(tokenBytes);
            }
        }
    }

    private static BridgeCredentialUnavailableException ClassifyRejection(
        HttpStatusCode status) =>
        (int)status switch
        {
            401 =>
                new BridgeCredentialUnavailableException(
                    BridgeCredentialUnavailableErrorCode
                        .EnrollmentTokenRejected,
                    "The Gateway rejected the enrollment token. Enrollment " +
                    "is blocked until a valid single-use token is issued."),
            403 =>
                new BridgeCredentialUnavailableException(
                    BridgeCredentialUnavailableErrorCode.EnrollmentDenied,
                    "The Gateway denied enrollment for this bridge. " +
                    "Enrollment is blocked until an operator authorizes it."),
            409 =>
                new BridgeCredentialUnavailableException(
                    BridgeCredentialUnavailableErrorCode
                        .EnrollmentTokenReused,
                    "The enrollment token was already used. Single-use " +
                    "tokens cannot be replayed; a fresh token is required."),
            >= 500 and <= 599 =>
                Unavailable(
                    "The Gateway enrollment endpoint failed while " +
                    "exchanging the token."),
            _ => Malformed(
                "The Gateway returned an unexpected enrollment exchange " +
                "status."),
        };

    private static BridgeCredentialUnavailableException Unavailable(
        string message) =>
        new(
            BridgeCredentialUnavailableErrorCode
                .EnrollmentEndpointUnavailable,
            message + " The bridge remains unenrolled.");

    private static BridgeCredentialUnavailableException Malformed(
        string message) =>
        new(
            BridgeCredentialUnavailableErrorCode
                .EnrollmentProtocolViolation,
            message + " The bridge remains unenrolled.");
}
