using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace RevAgent.Bridge.Bootstrap.Enrollment;

internal interface IBridgeRestorePrivilege
{
    void Run(Action action);
}

[SupportedOSPlatform("windows")]
internal sealed class WindowsBridgeRestorePrivilege : IBridgeRestorePrivilege
{
    private const uint TokenDuplicate = 0x0002;
    private const uint TokenImpersonate = 0x0004;
    private const uint TokenQuery = 0x0008;
    private const uint TokenAdjustPrivileges = 0x0020;
    private const uint SePrivilegeEnabled = 0x00000002;
    private const int ErrorNotAllAssigned = 1300;

    public void Run(Action action)
    {
        ArgumentNullException.ThrowIfNull(action);
        if (!OperatingSystem.IsWindows())
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.UnsupportedPlatform,
                "The bridge credential owner policy requires Windows.");
        }

        try
        {
            if (!OpenProcessToken(
                    GetCurrentProcess(),
                    TokenDuplicate | TokenQuery,
                    out SafeAccessTokenHandle processToken))
            {
                throw NewWin32Exception();
            }

            using (processToken)
            {
                if (!DuplicateTokenEx(
                        processToken,
                        TokenQuery |
                        TokenAdjustPrivileges |
                        TokenImpersonate,
                        IntPtr.Zero,
                        SecurityImpersonationLevel.SecurityImpersonation,
                        TokenType.TokenImpersonation,
                        out SafeAccessTokenHandle privilegedToken))
                {
                    throw NewWin32Exception();
                }

                using (privilegedToken)
                {
                    EnableAndRun(privilegedToken, action);
                }
            }
        }
        catch (BridgeCredentialStoreException)
        {
            throw;
        }
        catch (Exception exception)
            when (exception is Win32Exception or
                  UnauthorizedAccessException or
                  System.Security.SecurityException)
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.AccessControlFailure,
                "SeRestorePrivilege could not be enabled for the scoped " +
                "bridge credential owner operation.",
                exception);
        }
    }

    private static void EnableAndRun(
        SafeAccessTokenHandle token,
        Action action)
    {
        if (!LookupPrivilegeValue(
                systemName: null,
                "SeRestorePrivilege",
                out Luid restorePrivilege))
        {
            throw NewWin32Exception();
        }

        var requested = new TokenPrivileges
        {
            PrivilegeCount = 1,
            Privileges = new LuidAndAttributes
            {
                Luid = restorePrivilege,
                Attributes = SePrivilegeEnabled,
            },
        };
        Marshal.SetLastPInvokeError(0);
        if (!AdjustTokenPrivileges(
                token,
                disableAllPrivileges: false,
                ref requested,
                Marshal.SizeOf<TokenPrivileges>(),
                out TokenPrivileges previous,
                out _))
        {
            throw NewWin32Exception();
        }

        int enableError = Marshal.GetLastPInvokeError();
        if (enableError == ErrorNotAllAssigned)
        {
            throw new Win32Exception(
                enableError,
                "SeRestorePrivilege is not present in the caller token.");
        }

        if (enableError != 0)
        {
            throw new Win32Exception(enableError);
        }

        try
        {
            WindowsIdentity.RunImpersonated(token, action);
        }
        finally
        {
            Marshal.SetLastPInvokeError(0);
            if (!RestoreTokenPrivileges(
                    token,
                    disableAllPrivileges: false,
                    ref previous,
                    bufferLength: 0,
                    previousState: IntPtr.Zero,
                    returnLength: IntPtr.Zero))
            {
                throw new BridgeCredentialStoreException(
                    BridgeCredentialStoreErrorCode.AccessControlFailure,
                    "SeRestorePrivilege could not be restored after the " +
                    "bridge credential owner operation.",
                    NewWin32Exception());
            }

            int restoreError = Marshal.GetLastPInvokeError();
            if (restoreError != 0)
            {
                throw new BridgeCredentialStoreException(
                    BridgeCredentialStoreErrorCode.AccessControlFailure,
                    "SeRestorePrivilege restoration returned an error.",
                    new Win32Exception(restoreError));
            }
        }
    }

    private static Win32Exception NewWin32Exception() =>
        new(Marshal.GetLastPInvokeError());

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid
    {
        internal uint LowPart;
        internal int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LuidAndAttributes
    {
        internal Luid Luid;
        internal uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenPrivileges
    {
        internal uint PrivilegeCount;
        internal LuidAndAttributes Privileges;
    }

    private enum SecurityImpersonationLevel
    {
        SecurityAnonymous,
        SecurityIdentification,
        SecurityImpersonation,
        SecurityDelegation,
    }

    private enum TokenType
    {
        TokenPrimary = 1,
        TokenImpersonation,
    }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport(
        "advapi32.dll",
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(
        IntPtr processHandle,
        uint desiredAccess,
        out SafeAccessTokenHandle tokenHandle);

    [DllImport(
        "advapi32.dll",
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateTokenEx(
        SafeAccessTokenHandle existingToken,
        uint desiredAccess,
        IntPtr tokenAttributes,
        SecurityImpersonationLevel impersonationLevel,
        TokenType tokenType,
        out SafeAccessTokenHandle newToken);

    [DllImport(
        "advapi32.dll",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool LookupPrivilegeValue(
        string? systemName,
        string name,
        out Luid luid);

    [DllImport(
        "advapi32.dll",
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AdjustTokenPrivileges(
        SafeAccessTokenHandle token,
        [MarshalAs(UnmanagedType.Bool)] bool disableAllPrivileges,
        ref TokenPrivileges newState,
        int bufferLength,
        out TokenPrivileges previousState,
        out int returnLength);

    [DllImport(
        "advapi32.dll",
        EntryPoint = "AdjustTokenPrivileges",
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RestoreTokenPrivileges(
        SafeAccessTokenHandle token,
        [MarshalAs(UnmanagedType.Bool)] bool disableAllPrivileges,
        ref TokenPrivileges newState,
        int bufferLength,
        IntPtr previousState,
        IntPtr returnLength);
}
