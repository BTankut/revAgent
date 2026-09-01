using RevAgent.Bridge.Gateway.Connection;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed class RbpGatewayHandshakeClientTests
{
    private const string ClaimA =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string ClaimB =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    [Fact]
    public async Task EnrollmentRequiredFailsBeforeCreatingAnySocket()
    {
        var binding = new RecordingBinding();
        var client = new RbpGatewayHandshakeClient(
            new EnrollmentRequiredStateProvider(),
            binding);

        RbpGatewayTransportException exception =
            await Assert.ThrowsAsync<RbpGatewayTransportException>(
                () => client.ConnectAsync(
                    new Uri(
                        "wss://gateway.revagent.example/bridge/v1"),
                    new RbpHelloProfile(
                        "0.1.0-test",
                        "host",
                        "Windows",
                        Array.Empty<string>())));

        Assert.Equal(
            RbpGatewayFailureKind.EnrollmentRequired,
            exception.Kind);
        Assert.True(exception.RetryPaused);
        Assert.Equal(0, binding.ConnectCount);
    }

    [Fact]
    public async Task CredentialClaimBindingRejectsDriftAndRevokedPairReuse()
    {
        var enrollment = new MutableEnrollmentProvider(
            Credential("device-01", "token-a", ClaimA));
        var binding = new RbpCredentialClaimBinding(enrollment);

        Assert.Equal(
            RbpEnrollmentStatus.Ready,
            (await binding.ReadAsync()).Status);
        Assert.Equal(
            ClaimA,
            binding.RequireSessionClaim("device-01", "token-a", ClaimA));

        RbpGatewayTransportException tokenMismatch =
            Assert.Throws<RbpGatewayTransportException>(
                () => binding.RequireSessionClaim(
                    "device-01",
                    "copied-token-b",
                    ClaimA));
        Assert.Equal(RbpGatewayFailureKind.Authorization, tokenMismatch.Kind);
        Assert.Equal(4403, tokenMismatch.CloseCode);
        Assert.Throws<RbpGatewayTransportException>(
            () => binding.RequireSessionClaim(
                "device-01",
                "token-a",
                ClaimB));

        // Identical copied token+claim material cannot be distinguished and
        // is deliberately not represented as an anti-cloning guarantee.
        Assert.Equal(
            ClaimA,
            binding.RequireSessionClaim(
                string.Concat("device-", "01"),
                string.Concat("token", "-a"),
                string.Concat("sha256:", new string('a', 64))));

        binding.InvalidateActiveCredential();
        RbpEnrollmentSnapshot refused = await binding.ReadAsync();
        Assert.Equal(RbpEnrollmentStatus.Invalid, refused.Status);
        Assert.Equal("credential_revoked", refused.DiagnosticCode);
        Assert.Throws<RbpGatewayTransportException>(
            () => binding.RequireSessionClaim(
                "device-01",
                "token-a",
                ClaimA));

        // Rotation persists a coherent new token+claim pair before it can
        // become the new hello/session authority.
        enrollment.Snapshot = Credential("device-01", "token-b", ClaimB);
        Assert.Equal(
            RbpEnrollmentStatus.Ready,
            (await binding.ReadAsync()).Status);
        Assert.Equal(
            ClaimB,
            binding.RequireSessionClaim("device-01", "token-b", ClaimB));
    }

    [Theory]
    [InlineData("sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("")]
    public async Task LegacyOrMalformedClaimRequiresReenrollmentWithoutRepair(
        string claim)
    {
        var binding = new RbpCredentialClaimBinding(
            new ThrowingEnrollmentProvider(
                () => Credential("device-01", "token-a", claim)));

        RbpEnrollmentSnapshot snapshot = await binding.ReadAsync();

        Assert.Equal(RbpEnrollmentStatus.EnrollmentRequired, snapshot.Status);
        Assert.Equal("credential_claim_invalid", snapshot.DiagnosticCode);
        Assert.Null(snapshot.Credential);
    }

    private static RbpEnrollmentSnapshot Credential(
        string deviceId,
        string token,
        string claim) =>
        RbpEnrollmentSnapshot.Ready(
            new RbpDeviceCredential(deviceId, token, claim));

    private sealed class RecordingBinding : IRbpGatewayBinding
    {
        internal int ConnectCount { get; private set; }

        public Task<RbpGatewayConnection> ConnectAsync(
            RbpGatewayConnectRequest request,
            CancellationToken cancellationToken = default)
        {
            ConnectCount++;
            throw new InvalidOperationException(
                "The binding must not be reached without enrollment.");
        }
    }

    private sealed class MutableEnrollmentProvider :
        IRbpEnrollmentStateProvider
    {
        internal MutableEnrollmentProvider(RbpEnrollmentSnapshot snapshot)
        {
            Snapshot = snapshot;
        }

        internal RbpEnrollmentSnapshot Snapshot { get; set; }

        public ValueTask<RbpEnrollmentSnapshot> ReadAsync(
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(Snapshot);
        }
    }

    private sealed class ThrowingEnrollmentProvider :
        IRbpEnrollmentStateProvider
    {
        private readonly Func<RbpEnrollmentSnapshot> _read;

        internal ThrowingEnrollmentProvider(Func<RbpEnrollmentSnapshot> read)
        {
            _read = read;
        }

        public ValueTask<RbpEnrollmentSnapshot> ReadAsync(
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(_read());
        }
    }
}
