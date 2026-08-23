using System.Globalization;
using System.Text;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed class RbpHelloFactoryTests
{
    [Fact]
    public void ExplicitHelloUsesFrozenVersionAndImplementedCapabilitiesOnly()
    {
        DateTimeOffset now = DateTimeOffset.Parse(
            "2026-07-26T06:30:00.000Z",
            CultureInfo.InvariantCulture);
        var credential = new RbpDeviceCredential(
            "device-01",
            "secret-device-token",
            $"sha256:{new string('0', 64)}");
        var profile = new RbpHelloProfile(
            "0.1.0-test",
            "fixture-host",
            "Windows test",
            new[] { "0.1.0-addin" });
        var factory = new RbpHelloFactory(
            new FixedTimeProvider(now),
            new ZeroRandomSource());

        RbpEnvelope created = factory.Create(credential, profile);
        byte[] encoded = RbpEnvelopeCodec.Encode(created);
        RbpEnvelope decoded = RbpEnvelopeCodec.Decode(encoded);

        Assert.Null(decoded.Version);
        Assert.Equal("hello", decoded.Type);
        Assert.Null(decoded.Rsid);
        Assert.Null(decoded.Sequence);
        Assert.Null(decoded.Acknowledgement);
        Assert.Equal("2026-07-26T06:30:00.000Z", decoded.Timestamp);
        RbpHelloPayload hello =
            Assert.IsType<RbpHelloPayload>(decoded.Hello);
        Assert.Equal("device-01", hello.DeviceId);
        Assert.Empty(hello.Capabilities);
        Assert.Equal(
            $"sha256:{new string('0', 64)}",
            hello.Machine.Fingerprint);
        Assert.DoesNotContain(
            "secret-device-token",
            Encoding.UTF8.GetString(encoded),
            StringComparison.Ordinal);
    }

    [Fact]
    public void ProductionProfileDeclaresTheImplementedJournalCapabilityOnly()
    {
        var profile = RbpHelloProfile.Production(
            "0.1.0-test",
            Array.Empty<string>());

        Assert.Equal(new[] { "journal_v1" }, profile.Capabilities);
        Assert.DoesNotContain("chunked_results", profile.Capabilities);
        Assert.DoesNotContain("artifact_result_v1", profile.Capabilities);
        Assert.DoesNotContain("partial_progress", profile.Capabilities);
    }

    [Theory]
    [InlineData("chunked_results")]
    [InlineData("artifact_result_v1")]
    [InlineData("partial_progress")]
    [InlineData("batch_atomic")]
    [InlineData("doc_context_cached_v1")]
    public void HelloRejectsCarrierAndSessionCapabilityMixing(string capability)
    {
        Assert.Throws<ArgumentException>(
            () => new RbpHelloProfile(
                "0.1.0-test",
                "fixture-host",
                "Windows test",
                Array.Empty<string>(),
                new[] { capability }));
    }

    [Fact]
    public void HelloMayDeclareImplementedStreamableHttpWhenRequested()
    {
        var profile = RbpHelloProfile.Production(
            "0.1.0-test",
            Array.Empty<string>(),
            new[] { "journal_v1", "transport_streamable_http" });

        Assert.Equal(
            new[] { "journal_v1", "transport_streamable_http" },
            profile.Capabilities);
    }

    [Fact]
    public void CredentialTextNeverRendersTheToken()
    {
        var credential = new RbpDeviceCredential(
            "device-01",
            "never-log-this-token",
            $"sha256:{new string('0', 64)}");

        Assert.DoesNotContain(
            "never-log-this-token",
            credential.ToString(),
            StringComparison.Ordinal);
        Assert.Contains("[REDACTED]", credential.ToString());
    }

    private sealed class FixedTimeProvider : TimeProvider
    {
        private readonly DateTimeOffset _now;

        internal FixedTimeProvider(DateTimeOffset now)
        {
            _now = now;
        }

        public override DateTimeOffset GetUtcNow() => _now;
    }

    private sealed class ZeroRandomSource : IRbpRandomSource
    {
        public void Fill(Span<byte> destination)
        {
            destination.Clear();
        }

        public double NextUnitInterval() => 0;
    }
}
