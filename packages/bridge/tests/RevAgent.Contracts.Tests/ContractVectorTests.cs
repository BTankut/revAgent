using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevAgent.Contracts.Rbp;

namespace RevAgent.Contracts.Tests;

public sealed class ContractVectorTests
{
    [Fact]
    public void SharedDisplayVectorMapsExactlyWithoutMutatingFunctionalParams()
    {
        var vectors = LoadVectors();
        var displayVector = Assert.IsType<JObject>(vectors["display"]);
        var envelope = Assert.IsType<JObject>(displayVector["rbpEnvelope"]);
        var payload = Assert.IsType<JObject>(envelope["payload"]);
        var display = RbpDisplay.Parse(
            Assert.IsType<JObject>(payload["display"]));
        var functionalParams = Assert.IsType<JObject>(
            displayVector["functionalParams"]);
        var original = functionalParams.DeepClone();

        var mapped = DisplayParameterMapper.Map(functionalParams, display);

        Assert.True(JToken.DeepEquals(
            displayVector["expectedAddinParams"],
            mapped));
        Assert.True(JToken.DeepEquals(original, functionalParams));
        Assert.Contains(
            "future_display_field",
            display.UnknownProperties.Keys);
        Assert.Null(mapped["future_display_field"]);
    }

    [Fact]
    public void SharedOmittedDisplayVectorMapsNoKnownSideChannelValues()
    {
        var vectors = LoadVectors();
        var displayVector = Assert.IsType<JObject>(vectors["displayOmitted"]);
        var envelope = Assert.IsType<JObject>(displayVector["rbpEnvelope"]);
        var payload = Assert.IsType<JObject>(envelope["payload"]);
        var display = RbpDisplay.Parse(
            Assert.IsType<JObject>(payload["display"]));
        var functionalParams = Assert.IsType<JObject>(
            displayVector["functionalParams"]);

        var mapped = DisplayParameterMapper.Map(functionalParams, display);

        Assert.True(JToken.DeepEquals(
            displayVector["expectedAddinParams"],
            mapped));
        Assert.False(display.HasTaskName);
        Assert.False(display.HasWrapperAction);
        Assert.False(display.HasLogicalToolName);
        Assert.False(display.HasParentTaskName);
        Assert.False(display.HasParentTaskId);
        Assert.False(display.HasSuppressTaskStatusWindow);
        Assert.Contains(
            "future_display_field",
            display.UnknownProperties.Keys);
    }

    [Fact]
    public void SharedDocumentContextVectorsMapToFrozenRbpPayloads()
    {
        var vectors = LoadVectors();
        var contexts = Assert.IsType<JArray>(vectors["documentContexts"]);

        foreach (var vector in contexts.OfType<JObject>())
        {
            var addinResponse = Assert.IsType<JObject>(vector["addinResponse"]);
            var parsed = AddinDocumentContextParser.ParseResponse(
                addinResponse.ToString(Formatting.None));
            var actual = DocumentContextMapper.ToNormalizedJObject(parsed.Context);
            var rbpEnvelope = Assert.IsType<JObject>(vector["rbpEnvelope"]);
            var expected = Assert.IsType<JObject>(rbpEnvelope["payload"]);

            Assert.True(
                JToken.DeepEquals(expected, actual),
                $"Document-context vector mismatch: {vector.Value<string>("name")}");
            Assert.Null(actual.SelectToken("active_view.documentId"));
            Assert.Null(actual["capturedAtUtc"]);
            Assert.Null(actual["revision"]);
            Assert.Null(actual["cacheState"]);
            Assert.Null(actual["unavailableReason"]);
        }
    }

    [Fact]
    public void SharedNegativeDocumentContextVectorsFailClosed()
    {
        var vectors = LoadVectors();
        var negatives = Assert.IsType<JArray>(vectors["negativeAddinResponses"]);

        foreach (var vector in negatives.OfType<JObject>())
        {
            var response = Assert.IsType<JObject>(vector["response"]);
            Assert.Throws<RbpContractException>(
                () => AddinDocumentContextParser.ParseResponse(
                    response.ToString(Formatting.None)));
        }
    }

    private static JObject LoadVectors()
    {
        var path = Path.Combine(
            FindRepositoryRoot(),
            "packages",
            "bridge",
            "test-fixtures",
            "mapping",
            "contract-vectors.json");
        using var textReader = File.OpenText(path);
        using var jsonReader = new JsonTextReader(textReader)
        {
            DateParseHandling = DateParseHandling.None,
            FloatParseHandling = FloatParseHandling.Decimal,
        };
        return JObject.Load(jsonReader);
    }

    private static string FindRepositoryRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "AGENTS.md"))
                && Directory.Exists(Path.Combine(current.FullName, "packages", "protocol")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate the revAgent repository root.");
    }
}
