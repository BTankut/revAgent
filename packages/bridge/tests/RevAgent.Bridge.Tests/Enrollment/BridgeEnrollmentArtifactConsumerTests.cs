using System.Text;
using System.Text.Json;
using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

public sealed class BridgeEnrollmentArtifactConsumerTests
{
    private const string SyntheticToken =
        "SYNTHETIC-ENROLLMENT-HEAD__MIDDLE__TAIL-0123456789";
    private static readonly DateTimeOffset Now =
        DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_000);

    [Fact]
    public async Task Success_ProvesAbsenceBeforeTheSingleCoordinatorCall()
    {
        var lease = new FakeLease(ValidArtifact(), deleteResult: true);
        var calls = 0;
        var consumer = CreateConsumer(
            lease,
            (token, _) =>
            {
                Assert.True(lease.DeleteCalled);
                Assert.True(lease.DisposeCalled);
                Assert.Equal(SyntheticToken, token.ConsumeForExchange());
                calls++;
                return Task.CompletedTask;
            });

        BridgeEnrollmentArtifactConsumerResult result =
            await consumer.ConsumeAsync(ArtifactPath());

        Assert.True(result.Ok);
        Assert.Equal(0, result.ExitCode);
        Assert.True(result.SourceAbsent);
        Assert.True(result.ReEnrollAttempted);
        Assert.True(result.ReEnrollSucceeded);
        Assert.Equal(1, calls);
        Assert.All(lease.Content, value => Assert.Equal(0, value));
        AssertValueFree(result);
    }

    [Fact]
    public async Task CleanupUncertain_BlocksCoordinatorAndUsesExit79()
    {
        var lease = new FakeLease(ValidArtifact(), deleteResult: false);
        var calls = 0;
        var consumer = CreateConsumer(
            lease,
            (_, _) =>
            {
                calls++;
                return Task.CompletedTask;
            });

        BridgeEnrollmentArtifactConsumerResult result =
            await consumer.ConsumeAsync(ArtifactPath());

        Assert.False(result.Ok);
        Assert.Equal(79, result.ExitCode);
        Assert.Equal("cleanup_uncertain", result.Error);
        Assert.False(result.ReEnrollAttempted);
        Assert.Equal(0, calls);
        Assert.True(lease.DeleteCalled);
        Assert.True(lease.DisposeCalled);
        AssertValueFree(result);
    }

    [Theory]
    [InlineData("{}", "artifact_invalid_schema")]
    [InlineData("[]", "artifact_invalid_schema")]
    [InlineData("{\"contractVersion\":\"revagent.m4-enrollment-artifact/v1\",\"contractVersion\":\"revagent.m4-enrollment-artifact/v1\",\"enrollmentToken\":\"SYNTHETIC-ENROLLMENT-HEAD__MIDDLE__TAIL-0123456789\",\"expiresAtMs\":1800000060000}", "artifact_duplicate_field")]
    [InlineData("{\"contractVersion\":\"revagent.m4-enrollment-artifact/v1\",\"enrollmentToken\":\"short\",\"expiresAtMs\":1800000060000}", "artifact_invalid_token")]
    [InlineData("{\"contractVersion\":\"revagent.m4-enrollment-artifact/v1\",\"enrollmentToken\":\"SYNTHETIC-ENROLLMENT-HEAD__MIDDLE__TAIL-0123456789\",\"expiresAtMs\":1800000000000}", "artifact_expired")]
    [InlineData("{\"contractVersion\":\"revagent.m4-enrollment-artifact/v1\",\"enrollmentToken\":\"SYNTHETIC-ENROLLMENT-HEAD__MIDDLE__TAIL-0123456789\",\"expiresAtMs\":1800000005000}", "artifact_expiry_too_close")]
    [InlineData("{\"contractVersion\":\"revagent.m4-enrollment-artifact/v1\",\"enrollmentToken\":\"SYNTHETIC-ENROLLMENT-HEAD__MIDDLE__TAIL-0123456789\",\"expiresAtMs\":1800086410000}", "artifact_expiry_refused")]
    [InlineData("{\"contractVersion\":\"revagent.m4-enrollment-artifact/v1\",\"enrollmentToken\":\"SYNTHETIC-ENROLLMENT-HEAD__MIDDLE__TAIL-0123456789\",\"expiresAtMs\":1.80000006e12}", "artifact_invalid_schema")]
    [InlineData("{\"contractVersion\":\"revagent.m4-enrollment-artifact/v1\",\"enrollmentToken\":\"SYNTHETIC-ENROLLMENT-HEAD__MIDDLE__TAIL-0123456789\",\"expiresAtMs\":1800000060000.0}", "artifact_invalid_schema")]
    [InlineData("{\"contractVersion\":\"revagent.m4-enrollment-artifact/v1\",\"enrollmentToken\":\"SYNTHETIC-ENROLLMENT-HEAD__MIDDLE__TAIL-0123456789\",\"expiresAtMs\":1800000060000,\"extra\":true}", "artifact_invalid_schema")]
    public async Task InvalidArtifact_IsValueFreeAndStillRemoved(
        string json,
        string expectedError)
    {
        var lease = new FakeLease(Encoding.UTF8.GetBytes(json), true);
        var calls = 0;
        var consumer = CreateConsumer(
            lease,
            (_, _) =>
            {
                calls++;
                return Task.CompletedTask;
            });

        BridgeEnrollmentArtifactConsumerResult result =
            await consumer.ConsumeAsync(ArtifactPath());

        Assert.Equal(expectedError, result.Error);
        Assert.Equal(78, result.ExitCode);
        Assert.True(result.SourceAbsent);
        Assert.Equal(0, calls);
        Assert.True(lease.DeleteCalled);
        AssertValueFree(result);
    }

    [Fact]
    public async Task CoordinatorFailure_DoesNotExposeSecretOrFragments()
    {
        var lease = new FakeLease(ValidArtifact(), true);
        var consumer = CreateConsumer(
            lease,
            (_, _) => throw new InvalidOperationException(SyntheticToken));

        BridgeEnrollmentArtifactConsumerResult result =
            await consumer.ConsumeAsync(ArtifactPath());

        Assert.Equal("operation_failed", result.Error);
        Assert.True(result.SourceAbsent);
        Assert.True(result.ReEnrollAttempted);
        Assert.False(result.ReEnrollSucceeded);
        AssertValueFree(result);
    }

    [Fact]
    public async Task MissingSource_RemainsValueFreeAndDoesNotCallCoordinator()
    {
        var calls = 0;
        var source = new ThrowingSource(
            new BridgeEnrollmentArtifactSourceException(
                "artifact_missing",
                sourceAbsent: true,
                new IOException(SyntheticToken)));
        var consumer = new BridgeEnrollmentArtifactConsumer(
            source,
            (_, _) =>
            {
                calls++;
                return Task.CompletedTask;
            },
            new FixedTimeProvider(Now));

        BridgeEnrollmentArtifactConsumerResult result =
            await consumer.ConsumeAsync(ArtifactPath());

        Assert.Equal("artifact_missing", result.Error);
        Assert.True(result.SourceAbsent);
        Assert.Equal(0, calls);
        AssertValueFree(result);
    }

    [Fact]
    public async Task AmbientLegacyTokenRefusal_RemovesOwnedArtifactWithoutReadingIt()
    {
        var lease = new FakeLease(ValidArtifact(), deleteResult: true);
        var calls = 0;
        var consumer = CreateConsumer(
            lease,
            (_, _) =>
            {
                calls++;
                return Task.CompletedTask;
            });

        BridgeEnrollmentArtifactConsumerResult result =
            await consumer.RefuseAmbiguousSecretSourceAsync(ArtifactPath());

        Assert.Equal("ambiguous_secret_source", result.Error);
        Assert.Equal(78, result.ExitCode);
        Assert.True(result.SourceAbsent);
        Assert.False(result.ReEnrollAttempted);
        Assert.Equal(0, calls);
        Assert.False(lease.ReadCalled);
        Assert.True(lease.DeleteCalled);
        Assert.True(lease.DisposeCalled);
        AssertValueFree(result);
    }

    private static BridgeEnrollmentArtifactConsumer CreateConsumer(
        FakeLease lease,
        Func<BridgeEnrollmentToken, CancellationToken, Task> reEnroll) =>
        new(new FakeSource(lease), reEnroll, new FixedTimeProvider(Now));

    private static byte[] ValidArtifact() => Encoding.UTF8.GetBytes(
        "{\"contractVersion\":\"revagent.m4-enrollment-artifact/v1\"," +
        $"\"enrollmentToken\":\"{SyntheticToken}\"," +
        "\"expiresAtMs\":1800000600000}\n");

    private static string ArtifactPath() =>
        Path.Combine(Path.GetTempPath(), "enrollment.json");

    private static void AssertValueFree(
        BridgeEnrollmentArtifactConsumerResult result)
    {
        string serialized = JsonSerializer.Serialize(result);
        Assert.DoesNotContain(SyntheticToken, serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("SYNTHETIC-ENROLLMENT-HEAD", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("MIDDLE", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("TAIL-0123456789", serialized, StringComparison.Ordinal);
    }

    private sealed class FakeSource(FakeLease lease) :
        IBridgeEnrollmentArtifactSource
    {
        public IBridgeEnrollmentArtifactLease Open(string filePath) => lease;
    }

    private sealed class ThrowingSource(Exception exception) :
        IBridgeEnrollmentArtifactSource
    {
        public IBridgeEnrollmentArtifactLease Open(string filePath) =>
            throw exception;
    }

    private sealed class FakeLease : IBridgeEnrollmentArtifactLease
    {
        private readonly bool _deleteResult;

        internal FakeLease(byte[] content, bool deleteResult)
        {
            Content = content;
            _deleteResult = deleteResult;
        }

        internal byte[] Content { get; }
        internal bool DeleteCalled { get; private set; }
        internal bool DisposeCalled { get; private set; }
        internal bool ReadCalled { get; private set; }

        public byte[] ReadBounded(int maximumBytes)
        {
            ReadCalled = true;
            Assert.InRange(Content.Length, 1, maximumBytes);
            return Content;
        }

        public bool DeleteAndProveAbsent()
        {
            DeleteCalled = true;
            return _deleteResult;
        }

        public void Dispose() => DisposeCalled = true;
    }

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) :
        TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
