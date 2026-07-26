using System.Security.Cryptography;
using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

public sealed class WindowsLocalMachineCredentialProtectorTests
{
    [Fact]
    public void ProtectionScheme_IsPinned()
    {
        Assert.Equal(
            "dpapi_local_machine",
            WindowsLocalMachineCredentialProtector.ProtectionScheme);
    }

    [Fact]
    public void LocalMachineDpapi_RoundTripsOnWindows()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        byte[] plaintext = RandomNumberGenerator.GetBytes(64);
        var protector = new WindowsLocalMachineCredentialProtector();
        byte[] protectedBytes = protector.Protect(plaintext);
        byte[] roundTrip = protector.Unprotect(protectedBytes);
        try
        {
            Assert.NotEqual(plaintext, protectedBytes);
            Assert.Equal(plaintext, roundTrip);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
            CryptographicOperations.ZeroMemory(protectedBytes);
            CryptographicOperations.ZeroMemory(roundTrip);
        }
    }
}
