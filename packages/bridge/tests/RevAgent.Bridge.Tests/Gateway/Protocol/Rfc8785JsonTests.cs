using System.Text.Json;
using System.Text.Json.Nodes;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Protocol;

public sealed class Rfc8785JsonTests
{
    [Fact]
    public void FrozenParameterVectorsMatchCanonicalTextAndDigest()
    {
        using JsonDocument fixture =
            RbpFixtureReader.Load("params-digest.json");
        int count = 0;
        foreach (JsonElement vector in fixture.RootElement
                     .GetProperty("vectors")
                     .EnumerateArray())
        {
            JsonElement parameters = vector.GetProperty("params");
            Assert.Equal(
                vector.GetProperty("canonical").GetString(),
                Rfc8785Json.Canonicalize(parameters));
            Assert.Equal(
                vector.GetProperty("digest").GetString(),
                Rfc8785Json.MakeParametersDigest(parameters));
            count++;
        }

        Assert.Equal(5, count);
    }

    [Fact]
    public void FrozenBatchDigestVectorsMatchExactly()
    {
        using JsonDocument fixture =
            RbpFixtureReader.Load("batch-digest.json");
        int count = 0;
        foreach (JsonElement vector in fixture.RootElement
                     .GetProperty("vectors")
                     .EnumerateArray())
        {
            Assert.Equal(
                vector.GetProperty("digest").GetString(),
                Rfc8785Json.MakeBatchDigest(
                    RbpBatchDigestInput.Parse(
                        vector.GetProperty("input"))));
            count++;
        }

        Assert.Equal(2, count);
    }

    [Fact]
    public void BatchProjectionExcludesRawParamsAndUnknownFields()
    {
        using JsonDocument fixture =
            RbpFixtureReader.Load("batch-digest.json");
        JsonElement input = fixture.RootElement
            .GetProperty("vectors")[0]
            .GetProperty("input");
        JsonObject fullPayload =
            JsonNode.Parse(input.GetRawText())?.AsObject() ??
            throw new InvalidDataException("Batch vector is not an object.");
        JsonObject firstStep = fullPayload["steps"]?[0]?.AsObject() ??
                               throw new InvalidDataException(
                                   "Batch vector step is missing.");
        firstStep["params"] = new JsonObject
        {
            ["ignored"] = 1,
        };
        firstStep["display"] = new JsonObject
        {
            ["task_name"] = "ignored",
        };
        firstStep["future_step_field"] = "ignored";
        fullPayload["batch_digest"] = "ignored";
        fullPayload["future_batch_field"] = "ignored";

        string baseline = MakeBatchDigest(fullPayload);
        firstStep["params"] = new JsonObject
        {
            ["ignored"] = 2,
        };
        firstStep["display"]!["task_name"] = "still-ignored";
        fullPayload["future_batch_field"] = "still-ignored";
        Assert.Equal(baseline, MakeBatchDigest(fullPayload));

        firstStep["method"] = "inspect_sheet_text";
        Assert.NotEqual(baseline, MakeBatchDigest(fullPayload));
    }

    [Fact]
    public void BatchProjectionBindsAtomicPolicyScopeClearanceAndStepOmission()
    {
        using JsonDocument fixture =
            RbpFixtureReader.Load("batch-digest.json");
        JsonObject baselinePayload = JsonNode.Parse(
            fixture.RootElement
                .GetProperty("vectors")[0]
                .GetProperty("input")
                .GetRawText())?.AsObject() ??
            throw new InvalidDataException("Batch vector is not an object.");
        JsonObject firstStep =
            baselinePayload["steps"]?[0]?.AsObject() ??
            throw new InvalidDataException("Batch vector step is missing.");
        JsonObject secondStep =
            JsonNode.Parse(firstStep.ToJsonString())?.AsObject() ??
            throw new InvalidDataException("Batch vector step is invalid.");
        secondStep["invocation_id"] =
            "0197a3c2-0000-7000-8000-000000000022";
        secondStep["method"] = "inspect_sheet_text";
        JsonArray steps = baselinePayload["steps"]?.AsArray() ??
                          throw new InvalidDataException(
                              "Batch vector steps are missing.");
        steps.Add(secondStep);
        string baseline = MakeBatchDigest(baselinePayload);

        AssertDigestChanges(
            baselinePayload,
            baseline,
            payload => payload["atomic"] = true);
        AssertDigestChanges(
            baselinePayload,
            baseline,
            payload => payload["steps"]![0]!["policy"]!["decision"] =
                "changed");
        AssertDigestChanges(
            baselinePayload,
            baseline,
            payload => payload["steps"]![0]!["mutation_scope"] =
                new JsonObject
                {
                    ["kind"] = "session",
                });
        AssertDigestChanges(
            baselinePayload,
            baseline,
            payload => payload["recovery_clearances"] =
                new JsonArray(
                    new JsonObject
                    {
                        ["hold_id"] = "vh:test",
                    }));
        AssertDigestChanges(
            baselinePayload,
            baseline,
            payload => payload["steps"]!.AsArray().RemoveAt(1));
    }

    [Fact]
    public void ImmutableEnvelopeDigestExcludesOnlyAcknowledgementAndTimestamp()
    {
        using JsonDocument firstPayload =
            JsonDocument.Parse("""{"b":1,"a":2}""");
        var original = new RbpDataEnvelopeSnapshot(
            "invoke",
            "0197a3c2-0000-7000-8000-000000000001",
            "rs_fixture",
            4,
            firstPayload.RootElement.Clone(),
            Acknowledgement: 2,
            Timestamp: "2026-07-22T12:00:00Z");
        string digest = Rfc8785Json.ImmutableEnvelopeDigest(original);
        RbpDataEnvelopeSnapshot refreshed = original.Snapshot(
            acknowledgement: 3,
            replaceAcknowledgement: true,
            timestamp: "2026-07-22T12:01:00Z",
            replaceTimestamp: true);

        Assert.Equal(
            digest,
            Rfc8785Json.ImmutableEnvelopeDigest(refreshed));

        using JsonDocument changedPayload =
            JsonDocument.Parse("""{"b":1,"a":3}""");
        Assert.NotEqual(
            digest,
            Rfc8785Json.ImmutableEnvelopeDigest(
                original with
                {
                    Payload = changedPayload.RootElement.Clone(),
                }));
        Assert.NotEqual(
            digest,
            Rfc8785Json.ImmutableEnvelopeDigest(
                original with
                {
                    Sequence = 5,
                }));
        Assert.NotEqual(
            digest,
            Rfc8785Json.ImmutableEnvelopeDigest(
                original with
                {
                    Type = "result",
                }));
        Assert.NotEqual(
            digest,
            Rfc8785Json.ImmutableEnvelopeDigest(
                original with
                {
                    Id = "0197a3c2-0000-7000-8000-000000000002",
                }));
        Assert.NotEqual(
            digest,
            Rfc8785Json.ImmutableEnvelopeDigest(
                original with
                {
                    Rsid = "rs_other",
                }));
        Assert.NotEqual(
            digest,
            Rfc8785Json.ImmutableEnvelopeDigest(
                original with
                {
                    Version = 2,
                }));
    }

    [Fact]
    public void InvalidUnicodeAndNonJsonNumbersFailClosed()
    {
        using JsonDocument unpairedSurrogate =
            JsonDocument.Parse("""{"bad":"\ud800"}""");
        RbpFrameException invalidUnicode =
            Assert.Throws<RbpFrameException>(
            () => Rfc8785Json.Canonicalize(
                unpairedSurrogate.RootElement));
        Assert.Equal(
            RbpFrameErrorCode.InvalidEnvelope,
            invalidUnicode.Code);
        Assert.Equal("/bad", invalidUnicode.Path);

        using JsonDocument invalidProperty =
            JsonDocument.Parse("""{"\ud800":1}""");
        RbpFrameException invalidPropertyName =
            Assert.Throws<RbpFrameException>(
                () => Rfc8785Json.Canonicalize(
                    invalidProperty.RootElement));
        Assert.Equal("/", invalidPropertyName.Path);

        using JsonDocument invalidNestedArray =
            JsonDocument.Parse("""{"values":["ok","\udc00"]}""");
        RbpFrameException invalidNestedValue =
            Assert.Throws<RbpFrameException>(
                () => Rfc8785Json.Canonicalize(
                    invalidNestedArray.RootElement));
        Assert.Equal("/values/1", invalidNestedValue.Path);

        Assert.ThrowsAny<JsonException>(
            () => JsonDocument.Parse("""{"bad":NaN}"""));
        Assert.ThrowsAny<JsonException>(
            () => JsonDocument.Parse("""{"bad":Infinity}"""));
    }

    [Theory]
    [InlineData("""{"bad":1e400}""")]
    [InlineData("""{"bad":-1e400}""")]
    public void JsonValidNonFiniteNumbersFailBeforeCanonicalization(
        string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);

        RbpFrameException exception = Assert.Throws<RbpFrameException>(
            () => Rfc8785Json.Canonicalize(document.RootElement));

        Assert.Equal(RbpFrameErrorCode.InvalidEnvelope, exception.Code);
        Assert.Equal("/bad", exception.Path);
    }

    [Fact]
    public void DirectCanonicalizationRejectsDuplicateKeysAtAnyDepth()
    {
        using JsonDocument duplicate =
            JsonDocument.Parse(
                """{"outer":[{"same":1,"same":2}]}""");

        RbpFrameException exception = Assert.Throws<RbpFrameException>(
            () => Rfc8785Json.Sha256Digest(duplicate.RootElement));

        Assert.Equal(RbpFrameErrorCode.DuplicateKey, exception.Code);
        Assert.Equal("/outer/0/same", exception.Path);
    }

    [Fact]
    public void BatchProjectionRejectsDuplicatesEvenInsideExcludedRawParams()
    {
        using JsonDocument duplicate = JsonDocument.Parse(
            """
            {
              "atomic": false,
              "batch_id": "batch",
              "recovery_clearances": [],
              "steps": [{
                "invocation_id": "invocation",
                "method": "inspect_schedules",
                "mutating": false,
                "mutation_scope": null,
                "params": {"same": 1, "same": 2},
                "params_digest": "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
                "policy": {
                  "class": "auto",
                  "confirmation_id": null,
                  "decision": "auto"
                }
              }],
              "timeout_ms": 120000
            }
            """);

        RbpFrameException exception = Assert.Throws<RbpFrameException>(
            () => RbpBatchDigestInput.Parse(duplicate.RootElement));
        Assert.Equal(RbpFrameErrorCode.DuplicateKey, exception.Code);
        Assert.Equal("/steps/0/params/same", exception.Path);
    }

    [Fact]
    public void FrozenBatchCardinalityAndTimeoutBoundsFailClosed()
    {
        using JsonDocument fixture =
            RbpFixtureReader.Load("batch-digest.json");
        JsonObject baseline = JsonNode.Parse(
            fixture.RootElement
                .GetProperty("vectors")[0]
                .GetProperty("input")
                .GetRawText())?.AsObject() ??
            throw new InvalidDataException("Batch vector is not an object.");

        JsonObject emptySteps =
            JsonNode.Parse(baseline.ToJsonString())?.AsObject() ??
            throw new InvalidDataException("Batch vector is not an object.");
        emptySteps["steps"] = new JsonArray();
        using JsonDocument emptyStepsDocument =
            JsonDocument.Parse(emptySteps.ToJsonString());
        RbpFrameException emptyStepsException =
            Assert.Throws<RbpFrameException>(
                () => RbpBatchDigestInput.Parse(
                    emptyStepsDocument.RootElement));
        Assert.Equal(
            RbpFrameErrorCode.InvalidEnvelope,
            emptyStepsException.Code);
        Assert.Equal("/steps", emptyStepsException.Path);

        JsonObject zeroTimeout =
            JsonNode.Parse(baseline.ToJsonString())?.AsObject() ??
            throw new InvalidDataException("Batch vector is not an object.");
        zeroTimeout["timeout_ms"] = 0;
        using JsonDocument zeroTimeoutDocument =
            JsonDocument.Parse(zeroTimeout.ToJsonString());
        RbpFrameException zeroTimeoutException =
            Assert.Throws<RbpFrameException>(
                () => RbpBatchDigestInput.Parse(
                    zeroTimeoutDocument.RootElement));
        Assert.Equal(
            RbpFrameErrorCode.InvalidEnvelope,
            zeroTimeoutException.Code);
        Assert.Equal("/timeout_ms", zeroTimeoutException.Path);
    }

    private static string MakeBatchDigest(JsonObject payload)
    {
        using JsonDocument document =
            JsonDocument.Parse(payload.ToJsonString());
        return Rfc8785Json.MakeBatchDigest(
            RbpBatchDigestInput.Parse(document.RootElement));
    }

    private static void AssertDigestChanges(
        JsonObject baselinePayload,
        string baselineDigest,
        Action<JsonObject> mutate)
    {
        JsonObject changed =
            JsonNode.Parse(baselinePayload.ToJsonString())?.AsObject() ??
            throw new InvalidDataException("Batch vector is not an object.");
        mutate(changed);
        Assert.NotEqual(baselineDigest, MakeBatchDigest(changed));
    }
}
