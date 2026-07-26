using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RevAgent.Bridge.Gateway.Protocol;

internal static class RbpEnvelopeCodec
{
    private const int ProtocolVersion = 1;
    private const int HeartbeatIntervalMilliseconds = 15_000;
    private static readonly UTF8Encoding StrictUtf8 = new(
        encoderShouldEmitUTF8Identifier: false,
        throwOnInvalidBytes: true);
    private static readonly Regex UuidV7Pattern = new(
        "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\z",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex CapabilityPattern = new(
        "^[a-z][a-z0-9_]{0,127}\\z",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex Sha256Pattern = new(
        "^sha256:[0-9a-f]{64}\\z",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex Rfc3339Pattern = new(
        "^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:" +
        "[0-9]{2}(?:\\.[0-9]+)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})\\z",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly HashSet<string> PreNegotiationTypes =
        new(StringComparer.Ordinal)
        {
            "hello",
            "hello_ack",
        };
    private static readonly HashSet<string> ControlTypes =
        new(StringComparer.Ordinal)
        {
            "session_register",
            "session_registered",
            "session_resume",
            "resume_ack",
            "session_unregister",
            "heartbeat",
            "heartbeat_ack",
            "manifest_check",
            "manifest_info",
            "goodbye",
        };
    private static readonly HashSet<string> DataTypes =
        new(StringComparer.Ordinal)
        {
            "invoke",
            "invoke_batch",
            "result",
            "partial",
            "cancel",
            "doc_context_update",
        };
    private static readonly HashSet<string> KnownEnvelopeProperties =
        new(StringComparer.Ordinal)
        {
            "v",
            "type",
            "id",
            "rsid",
            "seq",
            "ack",
            "ts",
            "payload",
        };

    internal static RbpEnvelope Decode(
        ReadOnlyMemory<byte> frame,
        RbpWireMessageKind messageKind = RbpWireMessageKind.Text)
    {
        if (messageKind != RbpWireMessageKind.Text)
        {
            throw new RbpFrameException(
                RbpFrameErrorCode.BinaryFrame,
                "RBP accepts text messages only.");
        }

        if (frame.Length > RbpProtocolLimits.MaximumWireFrameBytes)
        {
            throw TooLarge(
                "/",
                frame.Length,
                RbpProtocolLimits.MaximumWireFrameBytes);
        }

        ReadOnlySpan<byte> bytes = frame.Span;
        if (bytes.Length >= 3 &&
            bytes[0] == 0xef &&
            bytes[1] == 0xbb &&
            bytes[2] == 0xbf)
        {
            throw new RbpFrameException(
                RbpFrameErrorCode.Utf8Bom,
                "RBP JSON must be UTF-8 without a byte-order mark.");
        }

        string text;
        try
        {
            text = StrictUtf8.GetString(bytes);
        }
        catch (DecoderFallbackException exception)
        {
            throw new RbpFrameException(
                RbpFrameErrorCode.InvalidUtf8,
                "RBP frame is not valid UTF-8.",
                innerException: exception);
        }

        try
        {
            RejectDuplicateKeys(bytes);
        }
        catch (DuplicateJsonKeyException exception)
        {
            throw new RbpFrameException(
                RbpFrameErrorCode.DuplicateKey,
                $"Duplicate JSON object key '{exception.Key}' is not allowed.",
                innerException: exception);
        }
        catch (JsonException exception)
        {
            throw new RbpFrameException(
                RbpFrameErrorCode.InvalidJson,
                "RBP frame is not valid JSON.",
                innerException: exception);
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(
                text,
                new JsonDocumentOptions
                {
                    AllowTrailingCommas = false,
                    CommentHandling = JsonCommentHandling.Disallow,
                    MaxDepth = 64,
                });
        }
        catch (JsonException exception)
        {
            throw new RbpFrameException(
                RbpFrameErrorCode.InvalidJson,
                "RBP frame is not one complete JSON value.",
                innerException: exception);
        }

        using (document)
        {
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw InvalidEnvelope("/", "RBP frame root must be an object.");
            }

            RbpEnvelope envelope = ParseEnvelope(root);
            EnforceFrameLimits(frame.Length, envelope);
            RbpPayloadValidator.ValidateKnown(root, envelope);
            return envelope;
        }
    }

    internal static byte[] Encode(RbpEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            if (envelope.Version is { } version)
            {
                writer.WriteNumber("v", version);
            }

            writer.WriteString("type", envelope.Type);
            writer.WriteString("id", envelope.Id);
            if (envelope.Rsid is not null)
            {
                writer.WriteString("rsid", envelope.Rsid);
            }

            if (envelope.Sequence is { } sequence)
            {
                writer.WriteNumber("seq", sequence);
            }

            if (envelope.Acknowledgement is { } acknowledgement)
            {
                writer.WriteNumber("ack", acknowledgement);
            }

            writer.WriteString("ts", envelope.Timestamp);
            writer.WritePropertyName("payload");
            envelope.Payload.WriteTo(writer);
            foreach ((string name, JsonElement value) in
                     envelope.AdditionalProperties)
            {
                if (KnownEnvelopeProperties.Contains(name))
                {
                    throw new InvalidOperationException(
                        $"Additional RBP property '{name}' collides with a " +
                        "known envelope property.");
                }

                writer.WritePropertyName(name);
                value.WriteTo(writer);
            }

            writer.WriteEndObject();
        }

        byte[] encoded = stream.ToArray();
        _ = Decode(encoded);
        return encoded;
    }

    private static RbpEnvelope ParseEnvelope(JsonElement root)
    {
        string type = RequiredString(
            root,
            "type",
            string.Empty,
            1,
            int.MaxValue);
        string id = RequiredString(root, "id", string.Empty, 1, 36);
        if (!UuidV7Pattern.IsMatch(id))
        {
            throw InvalidEnvelope("/id", "RBP id must be a lower-case UUIDv7.");
        }

        string timestamp = RequiredString(root, "ts", string.Empty, 1, 256);
        if (!IsRfc3339Timestamp(timestamp))
        {
            throw InvalidEnvelope("/ts", "RBP ts must be an RFC 3339 date-time.");
        }

        if (!root.TryGetProperty("payload", out JsonElement payload) ||
            payload.ValueKind != JsonValueKind.Object)
        {
            throw InvalidEnvelope("/payload", "RBP payload must be an object.");
        }

        (RbpEnvelopeScope scope, RbpEnvelopeDisposition disposition) =
            ClassifyScope(root, type);
        bool hasVersion = root.TryGetProperty("v", out JsonElement versionValue);
        bool hasRsid = root.TryGetProperty("rsid", out JsonElement rsidValue);
        bool hasSequence = root.TryGetProperty("seq", out JsonElement sequenceValue);
        bool hasAcknowledgement =
            root.TryGetProperty("ack", out JsonElement acknowledgementValue);

        int? version = null;
        string? rsid = null;
        long? sequence = null;
        long? acknowledgement = null;
        switch (scope)
        {
            case RbpEnvelopeScope.PreNegotiation:
                if (hasVersion || hasRsid || hasSequence || hasAcknowledgement)
                {
                    throw InvalidEnvelope(
                        "/",
                        "Pre-negotiation envelopes must omit v, rsid, seq, and ack.");
                }

                break;
            case RbpEnvelopeScope.Control:
                version = ReadProtocolVersion(hasVersion, versionValue);
                if (hasRsid || hasSequence || hasAcknowledgement)
                {
                    throw InvalidEnvelope(
                        "/",
                        "Control envelopes must omit rsid, seq, and ack.");
                }

                break;
            case RbpEnvelopeScope.Data:
                version = ReadProtocolVersion(hasVersion, versionValue);
                rsid = ReadRsid(hasRsid, rsidValue);
                sequence = ReadSafeInteger(
                    sequenceValue,
                    "/seq",
                    minimum: 1,
                    required: hasSequence);
                if (hasAcknowledgement)
                {
                    acknowledgement = ReadSafeInteger(
                        acknowledgementValue,
                        "/ack",
                        minimum: 0,
                        required: true);
                }

                break;
            default:
                throw new InvalidOperationException(
                    $"Unsupported RBP envelope scope '{scope}'.");
        }

        RbpHelloPayload? hello = null;
        RbpHelloAckPayload? helloAck = null;
        if (string.Equals(type, "hello", StringComparison.Ordinal))
        {
            hello = ParseHello(payload);
        }
        else if (string.Equals(type, "hello_ack", StringComparison.Ordinal))
        {
            helloAck = ParseHelloAck(payload);
        }
        else if (string.Equals(type, "session_register", StringComparison.Ordinal))
        {
            RejectSessionAuthorityClaims(payload);
        }

        var additional = new Dictionary<string, JsonElement>(
            StringComparer.Ordinal);
        foreach (JsonProperty property in root.EnumerateObject())
        {
            if (!KnownEnvelopeProperties.Contains(property.Name))
            {
                additional.Add(property.Name, property.Value.Clone());
            }
        }

        return new RbpEnvelope(
            version,
            type,
            id,
            timestamp,
            payload.Clone(),
            scope,
            rsid,
            sequence,
            acknowledgement,
            hello,
            helloAck,
            disposition,
            RbpEnvelope.FreezeAdditionalProperties(additional));
    }

    private static (
        RbpEnvelopeScope Scope,
        RbpEnvelopeDisposition Disposition) ClassifyScope(
        JsonElement root,
        string type)
    {
        if (PreNegotiationTypes.Contains(type))
        {
            return (
                RbpEnvelopeScope.PreNegotiation,
                RbpEnvelopeDisposition.Known);
        }

        if (ControlTypes.Contains(type))
        {
            return (
                RbpEnvelopeScope.Control,
                RbpEnvelopeDisposition.Known);
        }

        if (DataTypes.Contains(type))
        {
            return (
                RbpEnvelopeScope.Data,
                RbpEnvelopeDisposition.Known);
        }

        if (string.Equals(type, "error", StringComparison.Ordinal))
        {
            return (
                root.TryGetProperty("rsid", out _)
                    ? RbpEnvelopeScope.Data
                    : RbpEnvelopeScope.Control,
                RbpEnvelopeDisposition.Known);
        }

        bool hasRsid = root.TryGetProperty("rsid", out _);
        bool hasSequence = root.TryGetProperty("seq", out _);
        bool hasAcknowledgement = root.TryGetProperty("ack", out _);
        if (!hasRsid && !hasSequence && !hasAcknowledgement)
        {
            return (
                RbpEnvelopeScope.Control,
                RbpEnvelopeDisposition.Unsupported);
        }

        if (hasRsid && hasSequence)
        {
            return (
                RbpEnvelopeScope.Data,
                RbpEnvelopeDisposition.Unsupported);
        }

        throw InvalidEnvelope(
            "/",
            "An unknown RBP/1 type must have either a complete data " +
            "sequence shape or no session sequence fields.");
    }

    private static int ReadProtocolVersion(
        bool hasVersion,
        JsonElement value)
    {
        long version = ReadSafeInteger(
            value,
            "/v",
            minimum: ProtocolVersion,
            required: hasVersion);
        if (version != ProtocolVersion)
        {
            throw InvalidEnvelope("/v", "RBP message version must be 1.");
        }

        return ProtocolVersion;
    }

    private static string ReadRsid(bool hasRsid, JsonElement value)
    {
        if (!hasRsid || value.ValueKind != JsonValueKind.String)
        {
            throw InvalidEnvelope("/rsid", "Data envelopes require an rsid.");
        }

        string rsid = value.GetString() ?? string.Empty;
        int length = CodePointLength(rsid);
        if (length is < 1 or > 256)
        {
            throw InvalidEnvelope(
                "/rsid",
                "RBP rsid must contain between 1 and 256 Unicode code points.");
        }

        return rsid;
    }

    private static long ReadSafeInteger(
        JsonElement value,
        string path,
        long minimum,
        bool required)
    {
        if (!required)
        {
            throw InvalidEnvelope(path, $"{path} is required.");
        }

        if (!TryReadJsonInteger(value, out long integer) ||
            integer < minimum ||
            integer > RbpProtocolLimits.MaximumSafeInteger)
        {
            throw InvalidEnvelope(
                path,
                $"{path} must be an integer from {minimum} through " +
                $"{RbpProtocolLimits.MaximumSafeInteger}.");
        }

        return integer;
    }

    private static bool TryReadJsonInteger(JsonElement value, out long integer)
    {
        return RbpJsonNumber.TryReadExactInt64(value, out integer);
    }

    private static RbpHelloPayload ParseHello(JsonElement payload)
    {
        long minimumProtocol = RequiredInteger(
            payload,
            "min_protocol",
            "/payload",
            1,
            1);
        long maximumProtocol = RequiredInteger(
            payload,
            "max_protocol",
            "/payload",
            1,
            1);
        IReadOnlyList<string> capabilities = RequiredCapabilities(
            payload,
            "capabilities",
            "/payload");
        string bridgeVersion = RequiredString(
            payload,
            "bridge_version",
            "/payload",
            1,
            128);
        string deviceId = RequiredString(
            payload,
            "device_id",
            "/payload",
            1,
            4096);
        JsonElement machine = RequiredObject(payload, "machine", "/payload");
        string hostname = RequiredString(
            machine,
            "hostname",
            "/payload/machine",
            1,
            4096);
        string operatingSystem = RequiredString(
            machine,
            "os",
            "/payload/machine",
            1,
            4096);
        string? fingerprint = OptionalString(
            machine,
            "fingerprint",
            "/payload/machine",
            1,
            4096);
        if (fingerprint != null && !Sha256Pattern.IsMatch(fingerprint))
        {
            throw InvalidEnvelope(
                "/payload/machine/fingerprint",
                "Machine fingerprint must be a lower-case sha256 digest.");
        }

        IReadOnlyList<string> addinVersions = RequiredUniqueStrings(
            payload,
            "addin_versions",
            "/payload",
            1,
            128);

        return new RbpHelloPayload(
            checked((int)minimumProtocol),
            checked((int)maximumProtocol),
            capabilities,
            bridgeVersion,
            deviceId,
            new RbpMachineHello(hostname, operatingSystem, fingerprint),
            addinVersions);
    }

    private static RbpHelloAckPayload ParseHelloAck(JsonElement payload)
    {
        int protocol = checked((int)RequiredInteger(
            payload,
            "protocol",
            "/payload",
            1,
            1));
        string connectionId = RequiredString(
            payload,
            "connection_id",
            "/payload",
            1,
            4096);
        IReadOnlyList<string> capabilities = RequiredCapabilities(
            payload,
            "granted_capabilities",
            "/payload");
        int heartbeat = checked((int)RequiredInteger(
            payload,
            "heartbeat_interval_ms",
            "/payload",
            HeartbeatIntervalMilliseconds,
            HeartbeatIntervalMilliseconds));
        JsonElement limits = RequiredObject(payload, "limits", "/payload");
        var parsedLimits = new RbpHelloLimits(
            checked((int)RequiredInteger(
                limits,
                "max_params_bytes",
                "/payload/limits",
                1,
                RbpProtocolLimits.MaximumInvocationParametersBytes)),
            checked((int)RequiredInteger(
                limits,
                "max_result_bytes",
                "/payload/limits",
                1,
                RbpProtocolLimits.MaximumInlineResultBytes)),
            checked((int)RequiredInteger(
                limits,
                "max_partial_bytes",
                "/payload/limits",
                1,
                RbpProtocolLimits.MaximumPartialBytes)));
        JsonElement manifest = RequiredObject(payload, "manifest", "/payload");
        var parsedManifest = new RbpHelloManifest(
            RequiredString(
                manifest,
                "latest_bridge_version",
                "/payload/manifest",
                1,
                128),
            RequiredString(
                manifest,
                "manifest_url",
                "/payload/manifest",
                1,
                4096));

        return new RbpHelloAckPayload(
            protocol,
            connectionId,
            capabilities,
            heartbeat,
            parsedLimits,
            parsedManifest);
    }

    private static void RejectSessionAuthorityClaims(JsonElement payload)
    {
        foreach (string name in new[]
                 {
                     "tenant_id",
                     "user_id",
                     "seat_id",
                     "principal",
                     "seat",
                 })
        {
            if (payload.TryGetProperty(name, out _))
            {
                throw InvalidEnvelope(
                    "/payload/" + name,
                    "session_register cannot claim Gateway-owned authority.");
            }
        }
    }

    private static void EnforceFrameLimits(
        int frameBytes,
        RbpEnvelope envelope)
    {
        if ((envelope.Scope == RbpEnvelopeScope.PreNegotiation ||
             envelope.Scope == RbpEnvelopeScope.Control) &&
            frameBytes > RbpProtocolLimits.MaximumControlFrameBytes)
        {
            throw TooLarge(
                "/",
                frameBytes,
                RbpProtocolLimits.MaximumControlFrameBytes);
        }

        if (string.Equals(
                envelope.Type,
                "doc_context_update",
                StringComparison.Ordinal) &&
            frameBytes > RbpProtocolLimits.MaximumDocumentContextFrameBytes)
        {
            throw TooLarge(
                "/",
                frameBytes,
                RbpProtocolLimits.MaximumDocumentContextFrameBytes);
        }

        if (string.Equals(envelope.Type, "invoke", StringComparison.Ordinal))
        {
            EnforceElementLimit(
                envelope.Payload,
                "params",
                "/payload/params",
                RbpProtocolLimits.MaximumInvocationParametersBytes);
        }
        else if (string.Equals(
                     envelope.Type,
                     "invoke_batch",
                     StringComparison.Ordinal) &&
                 envelope.Payload.TryGetProperty(
                     "steps",
                     out JsonElement steps) &&
                 steps.ValueKind == JsonValueKind.Array)
        {
            int index = 0;
            foreach (JsonElement step in steps.EnumerateArray())
            {
                if (step.ValueKind == JsonValueKind.Object)
                {
                    EnforceElementLimit(
                        step,
                        "params",
                        $"/payload/steps/{index}/params",
                        RbpProtocolLimits.MaximumInvocationParametersBytes);
                }

                index++;
            }
        }

        if (string.Equals(envelope.Type, "result", StringComparison.Ordinal))
        {
            EnforceResultLimits(envelope.Payload);
        }
        else if (string.Equals(
                     envelope.Type,
                     "partial",
                     StringComparison.Ordinal))
        {
            EnforcePartialLimit(envelope.Payload);
        }
    }

    private static void EnforceResultLimits(JsonElement payload)
    {
        if (!payload.TryGetProperty("kind", out JsonElement kindValue) ||
            kindValue.ValueKind != JsonValueKind.String)
        {
            return;
        }

        string? kind = kindValue.GetString();
        if (string.Equals(kind, "invocation", StringComparison.Ordinal))
        {
            long actual = 0;
            bool hasSizeEvidence = false;
            if (payload.TryGetProperty("result", out JsonElement result))
            {
                actual = RawUtf8Length(result);
                hasSizeEvidence = true;
            }

            if (payload.TryGetProperty("total_size", out _))
            {
                long declaredBytes = ReadDeclaredResultSize(
                    payload,
                    "total_size",
                    "/payload/total_size");
                actual = AddWithoutOverflow(actual, declaredBytes);
                hasSizeEvidence = true;
            }

            if (payload.TryGetProperty(
                    "artifacts",
                    out JsonElement artifacts))
            {
                if (artifacts.ValueKind != JsonValueKind.Array ||
                    artifacts.GetArrayLength() is < 1 or > 16)
                {
                    throw InvalidEnvelope(
                        "/payload/artifacts",
                        "RBP artifact descriptors must be an array of 1 " +
                        "through 16 items.");
                }

                int artifactIndex = 0;
                foreach (JsonElement artifact in artifacts.EnumerateArray())
                {
                    string artifactPath =
                        $"/payload/artifacts/{artifactIndex}";
                    if (artifact.ValueKind != JsonValueKind.Object)
                    {
                        throw InvalidEnvelope(
                            artifactPath,
                            "RBP artifact descriptor must be an object.");
                    }

                    long bytes = ReadDeclaredResultSize(
                        artifact,
                        "total_size",
                        artifactPath + "/total_size");
                    actual = AddWithoutOverflow(actual, bytes);
                    hasSizeEvidence = true;
                    artifactIndex++;
                }
            }

            if (hasSizeEvidence &&
                actual > RbpProtocolLimits.MaximumInlineResultBytes)
            {
                throw TooLarge(
                    "/payload/result",
                    actual,
                    RbpProtocolLimits.MaximumInlineResultBytes);
            }

            return;
        }

        if (!payload.TryGetProperty("steps", out JsonElement steps) ||
            steps.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        int index = 0;
        foreach (JsonElement step in steps.EnumerateArray())
        {
            if (step.ValueKind == JsonValueKind.Object)
            {
                EnforceElementLimit(
                    step,
                    "result",
                    $"/payload/steps/{index}/result",
                    RbpProtocolLimits.MaximumInlineResultBytes);
            }

            index++;
        }
    }

    private static void EnforcePartialLimit(JsonElement payload)
    {
        if (!payload.TryGetProperty("kind", out JsonElement kind) ||
            kind.ValueKind != JsonValueKind.String ||
            !string.Equals(
                kind.GetString(),
                "chunk",
                StringComparison.Ordinal) ||
            !payload.TryGetProperty("data", out JsonElement data) ||
            data.ValueKind != JsonValueKind.String)
        {
            return;
        }

        string encoded = data.GetString() ?? string.Empty;
        long decodedBytes = DecodedBase64Length(encoded);
        if (decodedBytes > RbpProtocolLimits.MaximumPartialBytes)
        {
            throw TooLarge(
                "/payload/data",
                decodedBytes,
                RbpProtocolLimits.MaximumPartialBytes);
        }
    }

    private static long DecodedBase64Length(string value)
    {
        if (value.Length == 0 || value.Length % 4 != 0)
        {
            throw InvalidEnvelope(
                "/payload/data",
                "RBP chunk data must be padded RFC 4648 Base64.");
        }

        int padding = value.EndsWith("==", StringComparison.Ordinal)
            ? 2
            : value.EndsWith('=') ? 1 : 0;
        int dataLength = value.Length - padding;
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            bool expectedPadding = index >= dataLength;
            bool isAlphabet =
                character is >= 'A' and <= 'Z' or
                    >= 'a' and <= 'z' or
                    >= '0' and <= '9' or
                    '+' or '/';
            if ((expectedPadding && character != '=') ||
                (!expectedPadding && !isAlphabet))
            {
                throw InvalidEnvelope(
                    "/payload/data",
                    "RBP chunk data must be padded RFC 4648 Base64 " +
                    "without whitespace.");
            }
        }

        return checked(((long)value.Length / 4 * 3) - padding);
    }

    private static long AddWithoutOverflow(long left, long right)
    {
        return left > long.MaxValue - right
            ? long.MaxValue
            : left + right;
    }

    private static long ReadDeclaredResultSize(
        JsonElement owner,
        string propertyName,
        string path)
    {
        if (!owner.TryGetProperty(
                propertyName,
                out JsonElement value) ||
            !TryReadJsonInteger(value, out long bytes) ||
            bytes < 0)
        {
            throw InvalidEnvelope(
                path,
                "Declared RBP result size must be a non-negative integer.");
        }

        if (bytes > RbpProtocolLimits.MaximumInlineResultBytes)
        {
            throw TooLarge(
                path,
                bytes,
                RbpProtocolLimits.MaximumInlineResultBytes);
        }

        return bytes;
    }

    private static void EnforceElementLimit(
        JsonElement owner,
        string propertyName,
        string path,
        int limit)
    {
        if (!owner.TryGetProperty(propertyName, out JsonElement value))
        {
            return;
        }

        int actual = RawUtf8Length(value);
        if (actual > limit)
        {
            throw TooLarge(path, actual, limit);
        }
    }

    private static int RawUtf8Length(JsonElement value)
    {
        return StrictUtf8.GetByteCount(value.GetRawText());
    }

    private static IReadOnlyList<string> RequiredCapabilities(
        JsonElement owner,
        string name,
        string parentPath)
    {
        IReadOnlyList<string> capabilities = RequiredUniqueStrings(
            owner,
            name,
            parentPath,
            1,
            128);
        foreach (string capability in capabilities)
        {
            if (!CapabilityPattern.IsMatch(capability))
            {
                throw InvalidEnvelope(
                    $"{parentPath}/{name}",
                    $"Capability '{capability}' is not a valid RBP capability.");
            }
        }

        return capabilities;
    }

    private static IReadOnlyList<string> RequiredUniqueStrings(
        JsonElement owner,
        string name,
        string parentPath,
        int minimumLength,
        int maximumLength)
    {
        if (!owner.TryGetProperty(name, out JsonElement value) ||
            value.ValueKind != JsonValueKind.Array)
        {
            throw InvalidEnvelope(
                $"{parentPath}/{name}",
                $"{name} must be an array.");
        }

        var values = new List<string>();
        var unique = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonElement item in value.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
            {
                throw InvalidEnvelope(
                    $"{parentPath}/{name}",
                    $"{name} must contain strings only.");
            }

            string text = item.GetString() ?? string.Empty;
            int length = CodePointLength(text);
            if (length < minimumLength || length > maximumLength)
            {
                throw InvalidEnvelope(
                    $"{parentPath}/{name}",
                    $"{name} contains a string outside its length bounds.");
            }

            if (!unique.Add(text))
            {
                throw InvalidEnvelope(
                    $"{parentPath}/{name}",
                    $"{name} must not contain duplicate values.");
            }

            values.Add(text);
        }

        return values.AsReadOnly();
    }

    private static JsonElement RequiredObject(
        JsonElement owner,
        string name,
        string parentPath)
    {
        if (!owner.TryGetProperty(name, out JsonElement value) ||
            value.ValueKind != JsonValueKind.Object)
        {
            throw InvalidEnvelope(
                $"{parentPath}/{name}",
                $"{name} must be an object.");
        }

        return value;
    }

    private static string RequiredString(
        JsonElement owner,
        string name,
        string parentPath,
        int minimumLength,
        int maximumLength)
    {
        string? value = OptionalString(
            owner,
            name,
            parentPath,
            minimumLength,
            maximumLength);
        return value ??
               throw InvalidEnvelope(
                   $"{parentPath}/{name}",
                   $"{name} is required.");
    }

    private static string? OptionalString(
        JsonElement owner,
        string name,
        string parentPath,
        int minimumLength,
        int maximumLength)
    {
        if (!owner.TryGetProperty(name, out JsonElement value))
        {
            return null;
        }

        if (value.ValueKind != JsonValueKind.String)
        {
            throw InvalidEnvelope(
                $"{parentPath}/{name}",
                $"{name} must be a string.");
        }

        string text = value.GetString() ?? string.Empty;
        int length = CodePointLength(text);
        if (length < minimumLength || length > maximumLength)
        {
            throw InvalidEnvelope(
                $"{parentPath}/{name}",
                $"{name} contains {length} Unicode code points; expected " +
                $"{minimumLength} through {maximumLength}.");
        }

        return text;
    }

    private static long RequiredInteger(
        JsonElement owner,
        string name,
        string parentPath,
        long minimum,
        long maximum)
    {
        if (!owner.TryGetProperty(name, out JsonElement value) ||
            !TryReadJsonInteger(value, out long result) ||
            result < minimum ||
            result > maximum)
        {
            throw InvalidEnvelope(
                $"{parentPath}/{name}",
                $"{name} must be an integer from {minimum} through {maximum}.");
        }

        return result;
    }

    private static int CodePointLength(string value)
    {
        return value.EnumerateRunes().Count();
    }

    private static bool IsRfc3339Timestamp(string value)
    {
        if (!Rfc3339Pattern.IsMatch(value))
        {
            return false;
        }

        return DateTimeOffset.TryParse(
            value,
            CultureInfo.InvariantCulture,
            DateTimeStyles.RoundtripKind,
            out _);
    }

    private static void RejectDuplicateKeys(ReadOnlySpan<byte> bytes)
    {
        var reader = new Utf8JsonReader(
            bytes,
            isFinalBlock: true,
            state: default);
        var objectKeys = new Stack<HashSet<string>>();
        while (reader.Read())
        {
            switch (reader.TokenType)
            {
                case JsonTokenType.StartObject:
                    objectKeys.Push(new HashSet<string>(StringComparer.Ordinal));
                    break;
                case JsonTokenType.EndObject:
                    objectKeys.Pop();
                    break;
                case JsonTokenType.PropertyName:
                    string key = reader.GetString() ??
                                 throw new JsonException(
                                     "JSON property name cannot be null.");
                    if (objectKeys.Count == 0 || !objectKeys.Peek().Add(key))
                    {
                        throw new DuplicateJsonKeyException(key);
                    }

                    break;
            }
        }
    }

    private static RbpFrameException InvalidEnvelope(
        string path,
        string message)
    {
        return new RbpFrameException(
            RbpFrameErrorCode.InvalidEnvelope,
            message,
            path);
    }

    private static RbpFrameException TooLarge(
        string path,
        long actualBytes,
        long limitBytes)
    {
        return new RbpFrameException(
            RbpFrameErrorCode.FrameTooLarge,
            $"{path} is {actualBytes} UTF-8 bytes; limit is {limitBytes}.",
            path,
            actualBytes: actualBytes,
            limitBytes: limitBytes);
    }

    private sealed class DuplicateJsonKeyException : Exception
    {
        internal DuplicateJsonKeyException(string key)
            : base($"Duplicate JSON key '{key}'.")
        {
            Key = key;
        }

        internal string Key { get; }
    }
}
