using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace RevAgent.Bridge.Gateway.Connection;

internal interface IRbpCredentialClaimInvalidator
{
    void InvalidateActiveCredential();
}

/// <summary>
/// Binds the credential pair that authenticated the current connection to the
/// exact enrolled fingerprint claim emitted by hello and session_register.
/// </summary>
/// <remarks>
/// The binding digest is process-local comparison material only. It is never
/// written or logged and does not turn the fingerprint into proof of hardware
/// possession: a copied token plus copied claim remains indistinguishable.
/// </remarks>
internal sealed class RbpCredentialClaimBinding :
    IRbpEnrollmentStateProvider,
    IRbpCredentialClaimInvalidator
{
    private static readonly Regex FingerprintPattern = new(
        "^sha256:[0-9a-f]{64}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    private readonly object _sync = new();
    private readonly IRbpEnrollmentStateProvider _inner;
    private string? _activeBindingDigest;
    private string? _activeClaim;
    private string? _invalidatedBindingDigest;

    internal RbpCredentialClaimBinding(IRbpEnrollmentStateProvider inner)
    {
        _inner = inner ?? throw new ArgumentNullException(nameof(inner));
    }

    public async ValueTask<RbpEnrollmentSnapshot> ReadAsync(
        CancellationToken cancellationToken = default)
    {
        RbpEnrollmentSnapshot snapshot;
        try
        {
            snapshot = await _inner.ReadAsync(cancellationToken)
                .ConfigureAwait(false);
        }
        catch (ArgumentException)
        {
            // A legacy or malformed unbound credential must re-enroll. Do not
            // guess, normalize, or derive a replacement claim at runtime.
            return RbpEnrollmentSnapshot.NotReady(
                RbpEnrollmentStatus.EnrollmentRequired,
                "credential_claim_invalid");
        }

        if (snapshot.Status != RbpEnrollmentStatus.Ready ||
            snapshot.Credential is not { } credential)
        {
            return snapshot;
        }

        string digest = credential.CredentialBindingDigest;
        lock (_sync)
        {
            if (_invalidatedBindingDigest is not null &&
                FixedTimeEquals(_invalidatedBindingDigest, digest))
            {
                return RbpEnrollmentSnapshot.NotReady(
                    RbpEnrollmentStatus.Invalid,
                    "credential_revoked");
            }

            _activeBindingDigest = digest;
            _activeClaim = credential.MachineFingerprint;
            if (_invalidatedBindingDigest is not null)
            {
                // A different persisted credential pair is an explicit
                // rotation. Only that transition may clear the process-local
                // invalidation latch.
                _invalidatedBindingDigest = null;
            }
        }

        return snapshot;
    }

    internal string RequireSessionClaim(
        string deviceId,
        string deviceToken,
        string machineFingerprint)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(deviceId);
        ArgumentException.ThrowIfNullOrWhiteSpace(deviceToken);
        if (!FingerprintPattern.IsMatch(machineFingerprint))
        {
            throw CredentialMismatch(
                "The enrolled session fingerprint claim is malformed.");
        }

        string candidateDigest = RbpDeviceCredential.CreateBindingDigest(
            deviceId,
            deviceToken,
            machineFingerprint);
        lock (_sync)
        {
            if (_activeBindingDigest is null ||
                _activeClaim is null ||
                (_invalidatedBindingDigest is not null &&
                 FixedTimeEquals(
                     _invalidatedBindingDigest,
                     candidateDigest)) ||
                !FixedTimeEquals(_activeBindingDigest, candidateDigest) ||
                !FixedTimeEquals(_activeClaim, machineFingerprint))
            {
                throw CredentialMismatch(
                    "The session credential claim does not match the " +
                    "credential pair used by the active hello.");
            }

            return _activeClaim;
        }
    }

    public void InvalidateActiveCredential()
    {
        lock (_sync)
        {
            if (_activeBindingDigest is not null)
            {
                _invalidatedBindingDigest = _activeBindingDigest;
            }

            _activeBindingDigest = null;
            _activeClaim = null;
        }
    }

    private static bool FixedTimeEquals(string left, string right)
    {
        byte[] leftBytes = Encoding.UTF8.GetBytes(left);
        byte[] rightBytes = Encoding.UTF8.GetBytes(right);
        try
        {
            return leftBytes.Length == rightBytes.Length &&
                   CryptographicOperations.FixedTimeEquals(
                       leftBytes,
                       rightBytes);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(leftBytes);
            CryptographicOperations.ZeroMemory(rightBytes);
        }
    }

    private static RbpGatewayTransportException CredentialMismatch(
        string message) =>
        new(RbpGatewayFailureKind.Authorization, message, closeCode: 4403);
}
