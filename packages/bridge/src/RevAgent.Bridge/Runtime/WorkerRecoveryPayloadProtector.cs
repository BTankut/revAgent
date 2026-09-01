using System.Security.Cryptography;
using System.Text;
using RevAgent.Bridge.Gateway.Storage;

namespace RevAgent.Bridge.Runtime;

/// <summary>
/// Production-only C39 protector.  It deliberately has a distinct DPAPI
/// purpose from enrollment and resume material, even though all are bound to
/// the same Windows machine authority.
/// </summary>
internal sealed class WorkerRecoveryPayloadProtector : IRbpRecoveryPayloadProtector
{
    internal const string ProtectionScheme = "dpapi_local_machine:rbp_recovery_v7";
    private static readonly byte[] Purpose = Encoding.UTF8.GetBytes(
        "revAgent/rbp/correlated-recovery-payload/v7");

    internal static WorkerRecoveryPayloadProtector CreateProduction() => new();

    public RbpProtectedRecoveryPayload Protect(ReadOnlySpan<byte> plaintext)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException();
        }
        try
        {
            return new RbpProtectedRecoveryPayload(
                ProtectionScheme,
                ProtectedData.Protect(
                    plaintext.ToArray(), Purpose, DataProtectionScope.LocalMachine));
        }
        catch (Exception exception) when (
            exception is CryptographicException or PlatformNotSupportedException)
        {
            throw new CryptographicException("Recovery-payload protection failed.", exception);
        }
    }

    public byte[] Unprotect(RbpProtectedRecoveryPayload protectedPayload)
    {
        ArgumentNullException.ThrowIfNull(protectedPayload);
        if (!string.Equals(protectedPayload.ProtectionScheme, ProtectionScheme,
                StringComparison.Ordinal))
        {
            throw new CryptographicException("Recovery-payload scheme is invalid.");
        }
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException();
        }
        try
        {
            return ProtectedData.Unprotect(
                protectedPayload.CopyCiphertext(), Purpose,
                DataProtectionScope.LocalMachine);
        }
        catch (Exception exception) when (
            exception is CryptographicException or PlatformNotSupportedException)
        {
            throw new CryptographicException("Recovery-payload unprotection failed.", exception);
        }
    }
}
