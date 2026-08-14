using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Enrollment;

internal interface IBridgeEnrollmentArtifactLease : IDisposable
{
    byte[] ReadBounded(int maximumBytes);

    bool DeleteAndProveAbsent();
}

internal interface IBridgeEnrollmentArtifactSource
{
    IBridgeEnrollmentArtifactLease Open(string filePath);
}

internal sealed class BridgeEnrollmentArtifactSourceException : Exception
{
    internal BridgeEnrollmentArtifactSourceException(
        string errorCode,
        bool sourceAbsent,
        Exception? innerException = null)
        : base("The protected enrollment artifact source was refused.", innerException)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(errorCode);
        ErrorCode = errorCode;
        SourceAbsent = sourceAbsent;
    }

    internal string ErrorCode { get; }

    internal bool SourceAbsent { get; }
}

internal sealed record BridgeEnrollmentArtifactConsumerResult(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("action")] string Action,
    [property: JsonPropertyName("contractVersion")] string ContractVersion,
    [property: JsonPropertyName("artifactContractVersion")] string ArtifactContractVersion,
    [property: JsonPropertyName("reEnrollAttempted")] bool ReEnrollAttempted,
    [property: JsonPropertyName("reEnrollSucceeded")] bool ReEnrollSucceeded,
    [property: JsonPropertyName("sourceAbsent")] bool SourceAbsent,
    [property: JsonPropertyName("error")] string? Error)
{
    [JsonIgnore]
    internal int ExitCode => Ok
        ? 0
        : string.Equals(Error, "cleanup_uncertain", StringComparison.Ordinal)
            ? 79
            : 78;
}

/// <summary>
/// Consumes the A2-transferred M4 enrollment artifact without placing its
/// token in argv, environment, output, exceptions, logs, or retained evidence.
/// The existing coordinator remains the sole owner of exchange and credential
/// persistence semantics. This class owns only bounded file validation,
/// in-memory handoff, and positive source cleanup.
/// </summary>
internal sealed class BridgeEnrollmentArtifactConsumer
{
    internal const string Action = "consume_bridge_enrollment_artifact";
    internal const string ContractVersion =
        "revagent.bridge-enrollment-file-consumer/v1";
    internal const string ArtifactContractVersion =
        "revagent.m4-enrollment-artifact/v1";
    internal const int MaximumArtifactBytes = 4096;

    private const long MaximumJavaScriptSafeInteger = 9_007_199_254_740_991;
    private static readonly TimeSpan MinimumRemainingLifetime =
        TimeSpan.FromSeconds(50);
    private static readonly TimeSpan MaximumRemainingLifetime =
        TimeSpan.FromHours(24) + TimeSpan.FromSeconds(5);

    private readonly IBridgeEnrollmentArtifactSource _source;
    private readonly Func<
        BridgeEnrollmentToken,
        CancellationToken,
        Task> _reEnroll;
    private readonly TimeProvider _timeProvider;

    internal BridgeEnrollmentArtifactConsumer(
        IBridgeEnrollmentArtifactSource source,
        Func<BridgeEnrollmentToken, CancellationToken, Task> reEnroll,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(reEnroll);
        _source = source;
        _reEnroll = reEnroll;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    internal async Task<BridgeEnrollmentArtifactConsumerResult> ConsumeAsync(
        string filePath,
        CancellationToken cancellationToken = default) =>
        await ConsumeCoreAsync(
                filePath,
                refuseAmbiguousSecretSource: false,
                cancellationToken)
            .ConfigureAwait(false);

    internal async Task<BridgeEnrollmentArtifactConsumerResult>
        RefuseAmbiguousSecretSourceAsync(
            string filePath,
            CancellationToken cancellationToken = default) =>
        await ConsumeCoreAsync(
                filePath,
                refuseAmbiguousSecretSource: true,
                cancellationToken)
            .ConfigureAwait(false);

    private async Task<BridgeEnrollmentArtifactConsumerResult>
        ConsumeCoreAsync(
            string filePath,
            bool refuseAmbiguousSecretSource,
            CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);

        IBridgeEnrollmentArtifactLease? lease = null;
        byte[]? content = null;
        BridgeEnrollmentToken? token = null;
        var reEnrollAttempted = false;
        var reEnrollSucceeded = false;
        var sourceAbsent = false;
        string? error = null;

        try
        {
            lease = _source.Open(filePath);
            if (refuseAmbiguousSecretSource)
            {
                error = "ambiguous_secret_source";
            }
            else
            {
                content = lease.ReadBounded(MaximumArtifactBytes);
                token = ParseArtifact(content, _timeProvider.GetUtcNow());

                // The secret-bearing file must be gone before any Gateway or
                // credential-store mutation becomes possible. An uncertain
                // cleanup therefore blocks the coordinator factory itself.
                sourceAbsent = DeleteAndClose(ref lease);
                if (!sourceAbsent)
                {
                    error = "cleanup_uncertain";
                    return CreateResult(
                        reEnrollAttempted,
                        reEnrollSucceeded,
                        sourceAbsent,
                        error);
                }

                CryptographicOperations.ZeroMemory(content);
                content = null;

                cancellationToken.ThrowIfCancellationRequested();
                reEnrollAttempted = true;
                await _reEnroll(token, cancellationToken)
                    .ConfigureAwait(false);
                reEnrollSucceeded = true;
            }
        }
        catch (BridgeEnrollmentArtifactSourceException exception)
        {
            error = exception.ErrorCode;
            sourceAbsent = exception.SourceAbsent;
        }
        catch (BridgeEnrollmentArtifactValidationException exception)
        {
            error = exception.ErrorCode;
        }
        catch (BridgeCredentialUnavailableException exception)
        {
            error = ToDiagnosticCode(exception.ErrorCode.ToString());
        }
        catch (BridgeCredentialStoreException exception)
        {
            error = "store_" + ToDiagnosticCode(exception.ErrorCode.ToString());
        }
        catch (OperationCanceledException)
        {
            error = "operation_cancelled";
        }
        catch
        {
            error = "operation_failed";
        }
        finally
        {
            token?.Dispose();
            if (content is not null)
            {
                CryptographicOperations.ZeroMemory(content);
            }

            if (lease is not null)
            {
                sourceAbsent = DeleteAndClose(ref lease);
                if (!sourceAbsent)
                {
                    reEnrollSucceeded = false;
                    error = "cleanup_uncertain";
                }
            }
        }

        return CreateResult(
            reEnrollAttempted,
            reEnrollSucceeded,
            sourceAbsent,
            error);
    }

    private static BridgeEnrollmentArtifactConsumerResult CreateResult(
        bool reEnrollAttempted,
        bool reEnrollSucceeded,
        bool sourceAbsent,
        string? error)
    {
        bool ok = reEnrollSucceeded && sourceAbsent && error is null;
        return new BridgeEnrollmentArtifactConsumerResult(
            ok,
            Action,
            ContractVersion,
            ArtifactContractVersion,
            reEnrollAttempted,
            reEnrollSucceeded,
            sourceAbsent,
            error);
    }

    private static bool DeleteAndClose(
        ref IBridgeEnrollmentArtifactLease? lease)
    {
        IBridgeEnrollmentArtifactLease owned = lease ??
            throw new InvalidOperationException(
                "The enrollment artifact lease is missing.");
        lease = null;
        var absent = false;
        try
        {
            absent = owned.DeleteAndProveAbsent();
        }
        catch
        {
            absent = false;
        }

        try
        {
            owned.Dispose();
        }
        catch
        {
            absent = false;
        }

        return absent;
    }

    private static BridgeEnrollmentToken ParseArtifact(
        ReadOnlySpan<byte> content,
        DateTimeOffset now)
    {
        ReadOnlySpan<byte> enrollmentToken = default;
        long expiresAtMs = 0;
        var seen = 0;
        try
        {
            var reader = new Utf8JsonReader(
                content,
                new JsonReaderOptions
                {
                    AllowTrailingCommas = false,
                    CommentHandling = JsonCommentHandling.Disallow,
                    MaxDepth = 4,
                });
            if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject)
            {
                throw InvalidArtifact("artifact_invalid_schema");
            }

            var ended = false;
            while (reader.Read())
            {
                if (reader.TokenType == JsonTokenType.EndObject)
                {
                    ended = true;
                    break;
                }

                if (reader.TokenType != JsonTokenType.PropertyName)
                {
                    throw InvalidArtifact("artifact_invalid_schema");
                }

                if (reader.ValueIsEscaped)
                {
                    throw InvalidArtifact("artifact_invalid_schema");
                }

                int field;
                if (reader.ValueTextEquals("contractVersion"u8))
                {
                    field = 1;
                }
                else if (reader.ValueTextEquals("enrollmentToken"u8))
                {
                    field = 2;
                }
                else if (reader.ValueTextEquals("expiresAtMs"u8))
                {
                    field = 4;
                }
                else
                {
                    throw InvalidArtifact("artifact_invalid_schema");
                }

                if ((seen & field) != 0)
                {
                    throw InvalidArtifact("artifact_duplicate_field");
                }

                seen |= field;
                if (!reader.Read())
                {
                    throw InvalidArtifact("artifact_invalid_schema");
                }

                switch (field)
                {
                    case 1 when reader.TokenType == JsonTokenType.String &&
                                     !reader.ValueIsEscaped &&
                                     reader.ValueTextEquals(
                                         ArtifactContractVersion):
                        break;
                    case 2 when reader.TokenType == JsonTokenType.String &&
                                     !reader.ValueIsEscaped:
                        enrollmentToken = reader.ValueSpan;
                        break;
                    case 4 when reader.TokenType == JsonTokenType.Number &&
                                     IsCanonicalPositiveInteger(
                                         reader.ValueSpan) &&
                                     reader.TryGetInt64(out expiresAtMs):
                        break;
                    default:
                        throw InvalidArtifact("artifact_invalid_schema");
                }
            }

            if (!ended || seen != 7 || reader.Read())
            {
                throw InvalidArtifact("artifact_invalid_schema");
            }
        }
        catch (JsonException exception)
        {
            throw InvalidArtifact("artifact_invalid_json", exception);
        }

        if (expiresAtMs <= 0 ||
            expiresAtMs > MaximumJavaScriptSafeInteger)
        {
            throw InvalidArtifact("artifact_invalid_schema");
        }

        long nowMs = now.ToUnixTimeMilliseconds();
        long minimumExpiry = checked(
            nowMs + (long)MinimumRemainingLifetime.TotalMilliseconds);
        if (expiresAtMs < minimumExpiry)
        {
            throw InvalidArtifact(
                expiresAtMs <= nowMs
                    ? "artifact_expired"
                    : "artifact_expiry_too_close");
        }

        long maximumExpiry = checked(
            nowMs + (long)MaximumRemainingLifetime.TotalMilliseconds);
        if (expiresAtMs > maximumExpiry)
        {
            throw InvalidArtifact("artifact_expiry_refused");
        }

        try
        {
            return BridgeEnrollmentToken.ParseUtf8(enrollmentToken);
        }
        catch (ArgumentException exception)
        {
            throw InvalidArtifact("artifact_invalid_token", exception);
        }
    }

    private static bool IsCanonicalPositiveInteger(ReadOnlySpan<byte> value)
    {
        if (value.IsEmpty ||
            (value.Length > 1 && value[0] == (byte)'0'))
        {
            return false;
        }

        foreach (byte character in value)
        {
            if (character is < (byte)'0' or > (byte)'9')
            {
                return false;
            }
        }

        return true;
    }

    private static string ToDiagnosticCode(string pascalCase)
    {
        var characters = new List<char>(pascalCase.Length + 8);
        foreach (char character in pascalCase)
        {
            if (char.IsUpper(character) && characters.Count > 0)
            {
                characters.Add('_');
            }

            characters.Add(char.ToLowerInvariant(character));
        }

        return new string(characters.ToArray());
    }

    private static BridgeEnrollmentArtifactValidationException InvalidArtifact(
        string errorCode,
        Exception? innerException = null) =>
        new(errorCode, innerException);
}

internal sealed class BridgeEnrollmentArtifactValidationException : Exception
{
    internal BridgeEnrollmentArtifactValidationException(
        string errorCode,
        Exception? innerException = null)
        : base("The enrollment artifact was refused.", innerException)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(errorCode);
        ErrorCode = errorCode;
    }

    internal string ErrorCode { get; }
}
