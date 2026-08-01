using System.Security.Cryptography;
using System.Text;
using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Runtime;

/// <summary>
/// The production resume-token protector the worker installs into the journal
/// store.
/// </summary>
/// <remarks>
/// <para>
/// P3-T4b deliberately shipped the journal with an injected protection
/// contract and no production provider, so a resume token could never reach
/// SQLite in plaintext. P3-T8 landed the machine-scoped DPAPI primitive
/// (<see cref="WindowsLocalMachineCredentialProtector"/>) for the credential
/// store; this adapter reuses that exact primitive so the resume token is
/// protected by the same machine-scoped authority as the device credential,
/// under the same <c>dpapi_local_machine</c> scheme tag.
/// </para>
/// <para>
/// Unprotect refuses any row whose recorded scheme is not the scheme this
/// protector owns. A scheme mismatch means the ciphertext was written by a
/// different protector, and guessing would either surface a wrong token or
/// leak the difference between "wrong key" and "wrong scheme"; refusing keeps
/// the session unresumable, which is the fail-closed outcome.
/// </para>
/// </remarks>
internal sealed class WorkerResumeTokenProtector : IRbpResumeTokenProtector
{
    internal const string ProtectionScheme =
        WindowsLocalMachineCredentialProtector.ProtectionScheme;

    private readonly IBridgeCredentialProtector _protector;

    internal WorkerResumeTokenProtector(IBridgeCredentialProtector protector)
    {
        _protector = protector ??
            throw new ArgumentNullException(nameof(protector));
    }

    internal static WorkerResumeTokenProtector CreateProduction() =>
        new(new WindowsLocalMachineCredentialProtector());

    public RbpProtectedResumeToken Protect(string plaintextToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(plaintextToken);
        byte[] plaintext = Encoding.UTF8.GetBytes(plaintextToken);
        try
        {
            return new RbpProtectedResumeToken(
                ProtectionScheme,
                _protector.Protect(plaintext));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    public string Unprotect(RbpProtectedResumeToken protectedToken)
    {
        ArgumentNullException.ThrowIfNull(protectedToken);
        if (!string.Equals(
                protectedToken.ProtectionScheme,
                ProtectionScheme,
                StringComparison.Ordinal))
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.ProtectionFailure,
                "The stored resume token uses an unknown protection scheme.");
        }

        byte[] plaintext = _protector.Unprotect(
            protectedToken.CopyCiphertext());
        try
        {
            return Encoding.UTF8.GetString(plaintext);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }
}
