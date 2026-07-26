using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Protocol;

public sealed class RbpEnvelopeCodecTests
{
    private static readonly HashSet<string> StructuralNegativeVectors =
        new(StringComparer.Ordinal)
        {
            "hello_rejects_negotiated_version",
            "hello_ack_rejects_negotiated_version",
            "hello_ack_rejects_nonstandard_heartbeat_interval",
            "post_negotiation_control_requires_version",
            "post_negotiation_control_rejects_other_version",
            "post_negotiation_data_requires_version",
            "post_negotiation_data_rejects_other_version",
            "control_rejects_rsid",
            "control_rejects_seq",
            "control_rejects_ack",
            "data_requires_rsid",
            "data_requires_seq",
            "unsafe_seq",
            "session_register_authority_spoof",
        };

    [Fact]
    public void EveryFrozenPositiveEnvelopeHasAValidV1OuterShape()
    {
        using JsonDocument fixture =
            RbpFixtureReader.Load("envelopes.json");
        JsonElement positives =
            fixture.RootElement.GetProperty("positive");

        int count = 0;
        foreach (JsonElement vector in positives.EnumerateArray())
        {
            RbpEnvelope envelope = RbpEnvelopeCodec.Decode(
                RbpFixtureReader.MaterializePositive(vector));

            Assert.Equal(
                vector.GetProperty("type").GetString(),
                envelope.Type);
            Assert.Equal(JsonValueKind.Object, envelope.Payload.ValueKind);
            Assert.Equal(
                RbpEnvelopeDisposition.Known,
                envelope.Disposition);

            RbpEnvelope roundTrip = RbpEnvelopeCodec.Decode(
                RbpEnvelopeCodec.Encode(envelope));
            Assert.Equal(envelope.Type, roundTrip.Type);
            Assert.Equal(envelope.Scope, roundTrip.Scope);
            Assert.Equal(
                envelope.Payload.GetRawText(),
                roundTrip.Payload.GetRawText());
            count++;
        }

        Assert.Equal(37, count);
    }

    [Fact]
    public void FrozenStructuralAndHandshakeNegativesFailClosed()
    {
        using JsonDocument fixture =
            RbpFixtureReader.Load("envelopes.json");
        int count = 0;
        foreach (JsonElement vector in fixture.RootElement
                     .GetProperty("negative")
                     .EnumerateArray())
        {
            string name =
                vector.GetProperty("name").GetString() ??
                throw new InvalidDataException("Vector name is null.");
            if (!StructuralNegativeVectors.Contains(name))
            {
                continue;
            }

            RbpFrameException exception = Assert.Throws<RbpFrameException>(
                () => RbpEnvelopeCodec.Decode(
                    RbpFixtureReader.MaterializeNegative(
                        fixture.RootElement,
                        vector)));
            Assert.Equal(RbpFrameErrorCode.InvalidEnvelope, exception.Code);
            count++;
        }

        Assert.Equal(StructuralNegativeVectors.Count, count);
    }

    [Fact]
    public void StrictBoundaryRejectsBinaryBomInvalidUtf8DuplicateAndTrailing()
    {
        byte[] valid = ValidHeartbeat();
        Assert.Equal(
            RbpFrameErrorCode.BinaryFrame,
            Assert.Throws<RbpFrameException>(
                    () => RbpEnvelopeCodec.Decode(
                        valid,
                        RbpWireMessageKind.Binary))
                .Code);

        byte[] bom = new byte[valid.Length + 3];
        new byte[] { 0xef, 0xbb, 0xbf }.CopyTo(bom, 0);
        valid.CopyTo(bom, 3);
        Assert.Equal(
            RbpFrameErrorCode.Utf8Bom,
            Assert.Throws<RbpFrameException>(
                    () => RbpEnvelopeCodec.Decode(bom))
                .Code);

        Assert.Equal(
            RbpFrameErrorCode.InvalidUtf8,
            Assert.Throws<RbpFrameException>(
                    () => RbpEnvelopeCodec.Decode(
                        new byte[] { 0xc3, 0x28 }))
                .Code);
        foreach (byte[] invalidUtf8 in new[]
                 {
                     new byte[] { 0xc0, 0xaf },
                     new byte[] { 0xed, 0xa0, 0x80 },
                 })
        {
            Assert.Equal(
                RbpFrameErrorCode.InvalidUtf8,
                Assert.Throws<RbpFrameException>(
                        () => RbpEnvelopeCodec.Decode(invalidUtf8))
                    .Code);
        }

        byte[] duplicate = Encoding.UTF8.GetBytes(
            """
            {"v":1,"type":"heartbeat","id":"0197a3c2-0000-7000-8000-000000000001","ts":"2026-07-22T12:00:00Z","payload":{"x":1,"x":2}}
            """);
        Assert.Equal(
            RbpFrameErrorCode.DuplicateKey,
            Assert.Throws<RbpFrameException>(
                    () => RbpEnvelopeCodec.Decode(duplicate))
                .Code);

        byte[] trailing = Encoding.UTF8.GetBytes(
            Encoding.UTF8.GetString(valid) + "{}");
        Assert.Equal(
            RbpFrameErrorCode.InvalidJson,
            Assert.Throws<RbpFrameException>(
                    () => RbpEnvelopeCodec.Decode(trailing))
                .Code);
    }

    [Theory]
    [InlineData(9_007_199_254_740_991, true)]
    [InlineData(9_007_199_254_740_992, false)]
    public void SequenceUsesTheFrozenJsonSafeIntegerBoundary(
        long sequence,
        bool accepted)
    {
        JsonObject envelope = RbpFixtureReader.CreateEnvelope(
            "invoke",
            new JsonObject(),
            data: true);
        envelope["seq"] = sequence;
        byte[] bytes = RbpFixtureReader.Serialize(envelope);

        if (accepted)
        {
            Assert.Equal(sequence, RbpEnvelopeCodec.Decode(bytes).Sequence);
        }
        else
        {
            RbpFrameException exception = Assert.Throws<RbpFrameException>(
                () => RbpEnvelopeCodec.Decode(bytes));
            Assert.Equal(RbpFrameErrorCode.InvalidEnvelope, exception.Code);
            Assert.Equal("/seq", exception.Path);
        }
    }

    [Fact]
    public void UnknownTopLevelFieldsAreRetainedWithoutChangingTheTypedShape()
    {
        JsonObject envelope = RbpFixtureReader.CreateEnvelope(
            "heartbeat",
            new JsonObject(),
            data: false);
        envelope["future_extension"] = new JsonObject
        {
            ["enabled"] = true,
        };

        RbpEnvelope decoded = RbpEnvelopeCodec.Decode(
            RbpFixtureReader.Serialize(envelope));

        JsonElement extension =
            Assert.Contains("future_extension", decoded.AdditionalProperties);
        Assert.True(extension.GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public void UnknownV1TypesSurviveOnlyWithCompleteControlOrDataShape()
    {
        JsonObject control = RbpFixtureReader.CreateEnvelope(
            "future_control",
            new JsonObject(),
            data: false);
        RbpEnvelope decodedControl = RbpEnvelopeCodec.Decode(
            RbpFixtureReader.Serialize(control));
        Assert.Equal(
            RbpEnvelopeDisposition.Unsupported,
            decodedControl.Disposition);
        Assert.Equal(RbpEnvelopeScope.Control, decodedControl.Scope);

        JsonObject data = RbpFixtureReader.CreateEnvelope(
            "future_data",
            new JsonObject(),
            data: true);
        RbpEnvelope decodedData = RbpEnvelopeCodec.Decode(
            RbpFixtureReader.Serialize(data));
        Assert.Equal(
            RbpEnvelopeDisposition.Unsupported,
            decodedData.Disposition);
        Assert.Equal(RbpEnvelopeScope.Data, decodedData.Scope);

        data.Remove("ack");
        Assert.Equal(
            RbpEnvelopeDisposition.Unsupported,
            RbpEnvelopeCodec.Decode(
                    RbpFixtureReader.Serialize(data))
                .Disposition);

        control.Remove("v");
        Assert.Throws<RbpFrameException>(
            () => RbpEnvelopeCodec.Decode(
                RbpFixtureReader.Serialize(control)));

        foreach (string missing in new[] { "rsid", "seq" })
        {
            JsonObject mixed = RbpFixtureReader.CreateEnvelope(
                "future_data",
                new JsonObject(),
                data: true);
            mixed.Remove(missing);
            Assert.Throws<RbpFrameException>(
                () => RbpEnvelopeCodec.Decode(
                    RbpFixtureReader.Serialize(mixed)));
        }

        JsonObject acknowledgementOnly =
            RbpFixtureReader.CreateEnvelope(
                "future_control",
                new JsonObject(),
                data: false);
        acknowledgementOnly["ack"] = 0;
        Assert.Throws<RbpFrameException>(
            () => RbpEnvelopeCodec.Decode(
                RbpFixtureReader.Serialize(acknowledgementOnly)));
    }

    [Theory]
    [InlineData("2026-07-22T12:34:56Z", true)]
    [InlineData("2026-07-22T12:34:56.123456+03:00", true)]
    [InlineData("2026-07-22t12:34:56.1z", true)]
    [InlineData("2026-07-22T12:34Z", false)]
    [InlineData("2026-07-22 12:34:56Z", false)]
    [InlineData("2026-02-30T12:34:56Z", false)]
    public void TimestampRequiresAnRfc3339FullTime(
        string timestamp,
        bool accepted)
    {
        JsonObject envelope = RbpFixtureReader.CreateEnvelope(
            "heartbeat",
            new JsonObject(),
            data: false);
        envelope["ts"] = timestamp;
        byte[] bytes = RbpFixtureReader.Serialize(envelope);

        if (accepted)
        {
            Assert.Equal(
                timestamp,
                RbpEnvelopeCodec.Decode(bytes).Timestamp);
        }
        else
        {
            RbpFrameException exception = Assert.Throws<RbpFrameException>(
                () => RbpEnvelopeCodec.Decode(bytes));
            Assert.Equal(RbpFrameErrorCode.InvalidEnvelope, exception.Code);
            Assert.Equal("/ts", exception.Path);
        }
    }

    [Fact]
    public void FrozenFrameLimitValuesAndExactBoundariesAreEnforced()
    {
        using JsonDocument fixture =
            RbpFixtureReader.Load("frame-limits.json");
        JsonElement root = fixture.RootElement;
        AssertLimitVector(
            root,
            "invocation_params",
            RbpProtocolLimits.MaximumInvocationParametersBytes);
        AssertLimitVector(
            root,
            "inline_result",
            RbpProtocolLimits.MaximumInlineResultBytes);
        AssertLimitVector(
            root,
            "control_frame",
            RbpProtocolLimits.MaximumControlFrameBytes);
        AssertLimitVector(
            root,
            "doc_context_update_frame",
            RbpProtocolLimits.MaximumDocumentContextFrameBytes);

        AssertParameterSize(
            RbpProtocolLimits.MaximumInvocationParametersBytes,
            accepted: true);
        AssertParameterSize(
            RbpProtocolLimits.MaximumInvocationParametersBytes + 1,
            accepted: false);
        AssertResultSize(
            RbpProtocolLimits.MaximumInlineResultBytes,
            accepted: true);
        AssertResultSize(
            RbpProtocolLimits.MaximumInlineResultBytes + 1,
            accepted: false);
        AssertChunkedTerminalSize(
            RbpProtocolLimits.MaximumInlineResultBytes,
            accepted: true);
        AssertChunkedTerminalSize(
            RbpProtocolLimits.MaximumInlineResultBytes + 1,
            accepted: false);
        AssertArtifactAggregateSize(
            RbpProtocolLimits.MaximumInlineResultBytes,
            accepted: true);
        AssertArtifactAggregateSize(
            RbpProtocolLimits.MaximumInlineResultBytes + 1,
            accepted: false);
        AssertArtifactCount(16, accepted: true);
        AssertArtifactCount(17, accepted: false);
        AssertArtifactDeclaredSize(
            RbpProtocolLimits.MaximumInlineResultBytes,
            accepted: false);
        AssertArtifactDeclaredSize(
            RbpProtocolLimits.MaximumInlineResultBytes + 1,
            accepted: false,
            expectedPath: "/payload/artifacts/0/total_size");
        AssertPartialSize(
            RbpProtocolLimits.MaximumPartialBytes,
            accepted: true);
        AssertPartialSize(
            RbpProtocolLimits.MaximumPartialBytes + 1,
            accepted: false);
        AssertWholeFrameSize(
            "heartbeat",
            data: false,
            RbpProtocolLimits.MaximumControlFrameBytes,
            accepted: true);
        AssertWholeFrameSize(
            "heartbeat",
            data: false,
            RbpProtocolLimits.MaximumControlFrameBytes + 1,
            accepted: false);
        AssertWholeFrameSize(
            "doc_context_update",
            data: true,
            RbpProtocolLimits.MaximumDocumentContextFrameBytes,
            accepted: true);
        AssertWholeFrameSize(
            "doc_context_update",
            data: true,
            RbpProtocolLimits.MaximumDocumentContextFrameBytes + 1,
            accepted: false);
    }

    private static byte[] ValidHeartbeat()
    {
        return RbpFixtureReader.Serialize(
            RbpFixtureReader.CreateEnvelope(
                "heartbeat",
                new JsonObject
                {
                    ["sent_at"] = "2026-07-22T12:00:00Z",
                },
                data: false));
    }

    private static void AssertLimitVector(
        JsonElement root,
        string name,
        int expected)
    {
        JsonElement vector = root.GetProperty(name);
        Assert.Equal(expected, vector.GetProperty("limit_bytes").GetInt32());
        Assert.Equal(expected, vector.GetProperty("accepted_bytes").GetInt32());
        Assert.Equal(
            expected + 1,
            vector.GetProperty("rejected_bytes").GetInt32());
    }

    private static void AssertParameterSize(int rawBytes, bool accepted)
    {
        JsonObject envelope = RbpFixtureReader.CreateEnvelope(
            "invoke",
            new JsonObject
            {
                ["params"] = new string('a', rawBytes - 2),
            },
            data: true);
        AssertDecodeOutcome(
            RbpFixtureReader.Serialize(envelope),
            accepted,
            "/payload/params");
    }

    private static void AssertResultSize(int rawBytes, bool accepted)
    {
        JsonObject envelope = RbpFixtureReader.CreateEnvelope(
            "result",
            new JsonObject
            {
                ["kind"] = "invocation",
                ["result"] = new string('a', rawBytes - 2),
            },
            data: true);
        AssertDecodeOutcome(
            RbpFixtureReader.Serialize(envelope),
            accepted,
            "/payload/result");
    }

    private static void AssertChunkedTerminalSize(
        int declaredBytes,
        bool accepted)
    {
        JsonObject envelope = RbpFixtureReader.CreateEnvelope(
            "result",
            new JsonObject
            {
                ["kind"] = "invocation",
                ["chunked"] = true,
                ["total_size"] = declaredBytes,
            },
            data: true);
        AssertDecodeOutcome(
            RbpFixtureReader.Serialize(envelope),
            accepted,
            "/payload/total_size");
    }

    private static void AssertArtifactAggregateSize(
        int aggregateBytes,
        bool accepted)
    {
        const int structuredResultBytes = 2;
        JsonObject envelope = RbpFixtureReader.CreateEnvelope(
            "result",
            new JsonObject
            {
                ["kind"] = "invocation",
                ["result"] = new JsonObject(),
                ["chunked"] = true,
                ["artifacts"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["total_size"] =
                            aggregateBytes - structuredResultBytes,
                    },
                },
            },
            data: true);
        AssertDecodeOutcome(
            RbpFixtureReader.Serialize(envelope),
            accepted,
            "/payload/result");
    }

    private static void AssertArtifactCount(int count, bool accepted)
    {
        var artifacts = new JsonArray();
        for (int index = 0; index < count; index++)
        {
            artifacts.Add(
                new JsonObject
                {
                    ["total_size"] = 0,
                });
        }

        JsonObject envelope = RbpFixtureReader.CreateEnvelope(
            "result",
            new JsonObject
            {
                ["kind"] = "invocation",
                ["result"] = new JsonObject(),
                ["chunked"] = true,
                ["artifacts"] = artifacts,
            },
            data: true);
        byte[] bytes = RbpFixtureReader.Serialize(envelope);
        if (accepted)
        {
            Assert.NotNull(RbpEnvelopeCodec.Decode(bytes));
        }
        else
        {
            RbpFrameException exception =
                Assert.Throws<RbpFrameException>(
                    () => RbpEnvelopeCodec.Decode(bytes));
            Assert.Equal(
                RbpFrameErrorCode.InvalidEnvelope,
                exception.Code);
            Assert.Equal("/payload/artifacts", exception.Path);
        }
    }

    private static void AssertArtifactDeclaredSize(
        int declaredBytes,
        bool accepted,
        string expectedPath = "/payload/result")
    {
        JsonObject envelope = RbpFixtureReader.CreateEnvelope(
            "result",
            new JsonObject
            {
                ["kind"] = "invocation",
                ["result"] = new JsonObject(),
                ["chunked"] = true,
                ["artifacts"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["total_size"] = declaredBytes,
                    },
                },
            },
            data: true);
        AssertDecodeOutcome(
            RbpFixtureReader.Serialize(envelope),
            accepted,
            expectedPath);
    }

    private static void AssertPartialSize(
        int decodedBytes,
        bool accepted)
    {
        JsonObject envelope = RbpFixtureReader.CreateEnvelope(
            "partial",
            new JsonObject
            {
                ["kind"] = "chunk",
                ["data"] = Convert.ToBase64String(
                    new byte[decodedBytes]),
            },
            data: true);
        AssertDecodeOutcome(
            RbpFixtureReader.Serialize(envelope),
            accepted,
            "/payload/data");
    }

    private static void AssertWholeFrameSize(
        string type,
        bool data,
        int rawBytes,
        bool accepted)
    {
        JsonObject envelope = RbpFixtureReader.CreateEnvelope(
            type,
            new JsonObject
            {
                ["padding"] = string.Empty,
            },
            data);
        int baseLength = RbpFixtureReader.Serialize(envelope).Length;
        envelope["payload"]!["padding"] =
            new string('a', rawBytes - baseLength);
        byte[] bytes = RbpFixtureReader.Serialize(envelope);
        Assert.Equal(rawBytes, bytes.Length);
        AssertDecodeOutcome(bytes, accepted, "/");
    }

    private static void AssertDecodeOutcome(
        byte[] bytes,
        bool accepted,
        string expectedPath)
    {
        if (accepted)
        {
            Assert.NotNull(RbpEnvelopeCodec.Decode(bytes));
            return;
        }

        RbpFrameException exception = Assert.Throws<RbpFrameException>(
            () => RbpEnvelopeCodec.Decode(bytes));
        Assert.Equal(RbpFrameErrorCode.FrameTooLarge, exception.Code);
        Assert.Equal(expectedPath, exception.Path);
        Assert.NotNull(exception.ActualBytes);
        Assert.NotNull(exception.LimitBytes);
        Assert.True(exception.ActualBytes > exception.LimitBytes);
    }
}
