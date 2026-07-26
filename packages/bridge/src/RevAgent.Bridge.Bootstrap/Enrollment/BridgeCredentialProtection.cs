using System.Security.Cryptography;

namespace RevAgent.Bridge.Bootstrap.Enrollment;

internal interface IBridgeCredentialProtector
{
    byte[] Protect(byte[] plaintext);

    byte[] Unprotect(byte[] protectedBytes);
}

internal sealed class WindowsLocalMachineCredentialProtector :
    IBridgeCredentialProtector
{
    internal const string ProtectionScheme = "dpapi_local_machine";

    public byte[] Protect(byte[] plaintext)
    {
        ArgumentNullException.ThrowIfNull(plaintext);
        if (!OperatingSystem.IsWindows())
        {
            throw UnsupportedPlatform();
        }

        try
        {
            return ProtectedData.Protect(
                plaintext,
                optionalEntropy: null,
                DataProtectionScope.LocalMachine);
        }
        catch (Exception exception)
            when (exception is CryptographicException or PlatformNotSupportedException)
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.ProtectionFailure,
                "The bridge credential could not be protected with " +
                "machine-scoped Windows DPAPI.",
                exception);
        }
    }

    public byte[] Unprotect(byte[] protectedBytes)
    {
        ArgumentNullException.ThrowIfNull(protectedBytes);
        if (!OperatingSystem.IsWindows())
        {
            throw UnsupportedPlatform();
        }

        try
        {
            return ProtectedData.Unprotect(
                protectedBytes,
                optionalEntropy: null,
                DataProtectionScope.LocalMachine);
        }
        catch (Exception exception)
            when (exception is CryptographicException or PlatformNotSupportedException)
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.ProtectionFailure,
                "The bridge credential could not be unprotected with " +
                "machine-scoped Windows DPAPI.",
                exception);
        }
    }

    private static BridgeCredentialStoreException UnsupportedPlatform() =>
        new(
            BridgeCredentialStoreErrorCode.UnsupportedPlatform,
            "The production bridge credential protector requires Windows.");
}
