using System.Reflection;
using System.Text.Json;
using Xunit;

namespace RevAgent.Bridge.RealWorkerHost.Tests;

public sealed class RecoveryObservationResultTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PreservesExactC39ShapeAndScopesExtraFieldsToGenuineMode(bool genuine)
    {
        Type program = Assembly.Load("RevAgent.Bridge.RealWorkerHost")
            .GetType("RevAgent.Bridge.RealWorkerHost.Program", true)!;
        object result = program.GetMethod("RecoveryObservationResult", BindingFlags.Static | BindingFlags.NonPublic)!
            .Invoke(null, [genuine, Array.Empty<object>(), Array.Empty<object>(), false, 7L, true, 1, 4])!;
        using JsonDocument json = JsonDocument.Parse(JsonSerializer.Serialize(result));
        string[] expected = genuine
            ? ["observations", "reconnectWatchObservations", "routeRebindProofGranted",
                "connectionGeneration", "hasActiveConnection", "activeSessionCount", "lifecyclePhase"]
            : ["observations", "reconnectWatchObservations", "routeRebindProofGranted"];
        Assert.Equal(expected.Order(), json.RootElement.EnumerateObject().Select(property => property.Name).Order());
        Assert.Equal(JsonValueKind.Array, json.RootElement.GetProperty("observations").ValueKind);
        Assert.Equal(JsonValueKind.Array, json.RootElement.GetProperty("reconnectWatchObservations").ValueKind);
        Assert.False(json.RootElement.GetProperty("routeRebindProofGranted").GetBoolean());
        if (genuine)
        {
            Assert.Equal(7, json.RootElement.GetProperty("connectionGeneration").GetInt64());
            Assert.True(json.RootElement.GetProperty("hasActiveConnection").GetBoolean());
            Assert.Equal(1, json.RootElement.GetProperty("activeSessionCount").GetInt32());
            Assert.Equal(4, json.RootElement.GetProperty("lifecyclePhase").GetInt32());
        }
    }
}
