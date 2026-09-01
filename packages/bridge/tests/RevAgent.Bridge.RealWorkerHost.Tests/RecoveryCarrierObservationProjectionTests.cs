using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Xunit;

namespace RevAgent.Bridge.RealWorkerHost.Tests;

public sealed class RecoveryCarrierObservationProjectionTests
{
    private const string Digest =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public void TestHostRingRetainsOnlyBoundedOrderedHashOnlyRows()
    {
        Type ringType = HostAssembly.GetType(
            "RevAgent.Bridge.RealWorkerHost.Program+RecoveryCarrierObservationRing",
            throwOnError: true)!;
        object ring = Activator.CreateInstance(ringType,
            BindingFlags.Instance | BindingFlags.NonPublic,
            binder: null, args: new object[] { 2, 4096 }, culture: null)!;
        MethodInfo observe = ringType.GetMethod("Observe",
            BindingFlags.Instance | BindingFlags.Public)!;
        MethodInfo snapshot = ringType.GetMethod("Snapshot",
            BindingFlags.Instance | BindingFlags.NonPublic)!;
        for (long ordinal = 1; ordinal <= 3; ordinal++)
        {
            observe.Invoke(ring, new[] { Observation("Write", ordinal) });
        }

        object[] rows = Assert.IsType<object[]>(snapshot.Invoke(ring, null));
        Assert.Equal(2, rows.Length);
        string json = JsonSerializer.Serialize(rows);
        using JsonDocument document = JsonDocument.Parse(json);
        Assert.Equal(2L, document.RootElement[0].GetProperty("ordinal").GetInt64());
        Assert.Equal(3L, document.RootElement[1].GetProperty("ordinal").GetInt64());
        Assert.Equal(Digest, document.RootElement[0].GetProperty("outerDigest").GetString());
        Assert.True(document.RootElement[0].TryGetProperty("routeAuthorityCheckpoint", out _));
        Assert.True(document.RootElement[0].TryGetProperty("connectionDigest", out _));
        Assert.True(document.RootElement[0].TryGetProperty("causalOrdinal", out _));
        Assert.DoesNotContain("payload", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("rsid", json, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ProductionSinkIsClosedNoOp()
    {
        Type sinkType = BridgeAssembly.GetType(
            "RevAgent.Bridge.Gateway.Connection.RbpRecoveryCarrierObservationSink",
            throwOnError: true)!;
        object sink = sinkType.GetProperty("None",
            BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
        MethodInfo observe = sinkType.GetMethod("Observe",
            BindingFlags.Instance | BindingFlags.Public)!;

        Exception? exception = Record.Exception(() =>
            observe.Invoke(sink, new[] { Observation("Acknowledged", 1) }));
        Assert.Null(exception);
    }

    [Fact]
    public void RecoveryIdentityUsesTheTypedC39ObservationDomain()
    {
        Type type = BridgeAssembly.GetType(
            "RevAgent.Bridge.Gateway.Connection.RbpRecoveryCarrierObservation",
            throwOnError: true)!;
        MethodInfo hash = type.GetMethod("HashRecoveryId",
            BindingFlags.Static | BindingFlags.NonPublic)!;
        const string recoveryId = "0197a3c2-0000-7000-8000-000000000901";
        string actual = Assert.IsType<string>(hash.Invoke(null,
            new object[] { recoveryId }));
        string expected = "sha256:" + Convert.ToHexString(SHA256.HashData(
            Encoding.UTF8.GetBytes(
                "revagent/c39-carrier-observation/v1\0" + recoveryId)))
            .ToLowerInvariant();
        string wrongDomain = "sha256:" + Convert.ToHexString(SHA256.HashData(
            Encoding.UTF8.GetBytes(recoveryId))).ToLowerInvariant();
        Assert.Equal(expected, actual);
        Assert.NotEqual(wrongDomain, actual);
    }

    [Fact]
    public void ReconnectRingProjectsOnlyOrderedHashRows()
    {
        Type ringType = HostAssembly.GetType(
            "RevAgent.Bridge.RealWorkerHost.Program+ReconnectObservationRing",
            throwOnError: true)!;
        object ring = Activator.CreateInstance(ringType,
            BindingFlags.Instance | BindingFlags.NonPublic, null,
            new object[] { 2, 4096 }, null)!;
        Type phaseType = BridgeAssembly.GetType(
            "RevAgent.Bridge.Gateway.Connection.RbpReconnectObservationPhase",
            throwOnError: true)!;
        Type observationType = BridgeAssembly.GetType(
            "RevAgent.Bridge.Gateway.Connection.RbpReconnectObservation",
            throwOnError: true)!;
        MethodInfo observe = ringType.GetMethod("Observe")!;
        MethodInfo snapshot = ringType.GetMethod("Snapshot",
            BindingFlags.Instance | BindingFlags.NonPublic)!;
        foreach (var item in new[] { ("ResumeAcknowledgementApplied", 1L), ("WatcherStarted", 2L), ("WatcherStarted", 3L) })
        {
            object observation = Activator.CreateInstance(observationType,
                Enum.Parse(phaseType, item.Item1), 2L, item.Item2,
                Digest, Digest, Digest, null, false, 0L)!;
            observe.Invoke(ring, new[] { observation });
        }
        const string rawConnection = "raw-connection-sentinel";
        object invalidObservation = Activator.CreateInstance(observationType,
            Enum.Parse(phaseType, "WatcherStarted"), 2L, 4L,
            Digest, Digest, rawConnection, null, false, 0L)!;
        observe.Invoke(ring, new[] { invalidObservation });
        object[] rows = Assert.IsType<object[]>(snapshot.Invoke(ring, null));
        using JsonDocument json = JsonDocument.Parse(JsonSerializer.Serialize(rows));
        Assert.Equal(2, json.RootElement.GetArrayLength());
        Assert.Equal(2L, json.RootElement[0].GetProperty("ordinal").GetInt64());
        Assert.Equal("watcher_started", json.RootElement[0].GetProperty("phase").GetString());
        Assert.True(json.RootElement[0].TryGetProperty("routeAuthorityCheckpoint", out _));
        Assert.True(json.RootElement[0].TryGetProperty("causalOrdinal", out _));
        Assert.DoesNotContain("rsid\"", json.RootElement.GetRawText());
        Assert.DoesNotContain(rawConnection, json.RootElement.GetRawText());
    }

    [Fact]
    public void CausalProjectionKeepsProoflessRowsNullAndNeverRendersRawAuthorityValues()
    {
        const string rawConnection = "019f9add-7a83-7d11-a6a9-d2f8108c0098";
        const string rawProof = "019f9add-7a83-7d12-a6a9-d2f8108c0099";
        const string rawContext = "sensitive-context";
        Type type = BridgeAssembly.GetType(
            "RevAgent.Bridge.Gateway.Connection.RbpRecoveryCarrierObservation",
            throwOnError: true)!;
        Type phaseType = BridgeAssembly.GetType(
            "RevAgent.Bridge.Gateway.Connection.RbpRecoveryCarrierObservationPhase",
            throwOnError: true)!;
        object proofless = Activator.CreateInstance(type, new object?[]
        {
            Enum.Parse(phaseType, "RestartResend"), Digest, 6L, Digest, 2L,
            null, Digest, false, 12L,
        })!;
        Type ringType = HostAssembly.GetType(
            "RevAgent.Bridge.RealWorkerHost.Program+RecoveryCarrierObservationRing",
            throwOnError: true)!;
        object ring = Activator.CreateInstance(ringType,
            BindingFlags.Instance | BindingFlags.NonPublic,
            binder: null, args: new object[] { 4, 4096 }, culture: null)!;
        MethodInfo observe = ringType.GetMethod("Observe")!;
        observe.Invoke(ring, new[] { proofless });
        // Exercise the real typed-digest rejection boundary with actual raw
        // inputs, not absent literals that never entered the observer.
        foreach (string raw in new[] { rawConnection, rawProof, rawContext })
        {
            object rejected = Activator.CreateInstance(type, new object?[]
            {
                Enum.Parse(phaseType, "RestartResend"), raw, 7L, Digest, 3L,
                null, Digest, false, 13L,
            })!;
            observe.Invoke(ring, new[] { rejected });
        }
        MethodInfo snapshot = ringType.GetMethod("Snapshot", BindingFlags.Instance | BindingFlags.NonPublic)!;
        object[] rows = Assert.IsType<object[]>(snapshot.Invoke(ring, null));
        Assert.Single(rows);
        string json = JsonSerializer.Serialize(rows);
        Assert.Contains("\"routeAuthorityCheckpoint\":null", json, StringComparison.Ordinal);
        Assert.Contains("\"causalOrdinal\":12", json, StringComparison.Ordinal);
        Assert.DoesNotContain(rawConnection, json, StringComparison.Ordinal);
        Assert.DoesNotContain(rawProof, json, StringComparison.Ordinal);
        Assert.DoesNotContain(rawContext, json, StringComparison.Ordinal);
    }

    private static object Observation(string phase, long ordinal)
    {
        Type type = BridgeAssembly.GetType(
            "RevAgent.Bridge.Gateway.Connection.RbpRecoveryCarrierObservation",
            throwOnError: true)!;
        Type phaseType = BridgeAssembly.GetType(
            "RevAgent.Bridge.Gateway.Connection.RbpRecoveryCarrierObservationPhase",
            throwOnError: true)!;
        return Activator.CreateInstance(type, new object[]
        {
            Enum.Parse(phaseType, phase), Digest, ordinal, Digest, ordinal,
            null!, null!, false, 0L,
        })!;
    }

    private static Assembly HostAssembly => Assembly.Load("RevAgent.Bridge.RealWorkerHost");

    private static Assembly BridgeAssembly => Assembly.Load("revagent-bridge");
}
