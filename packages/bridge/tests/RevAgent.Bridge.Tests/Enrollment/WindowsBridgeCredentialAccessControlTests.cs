using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Tests.Enrollment;

[SupportedOSPlatform("windows")]
public sealed class WindowsBridgeCredentialAccessControlTests
{
    [Fact]
    public void MutationFailsClosedWhenRestorePrivilegeCannotBeScoped()
    {
        string rootPath = NewTestRoot();
        string filePath = Path.Combine(rootPath, "credential.dpapi");
        try
        {
            _ = Directory.CreateDirectory(rootPath);
            File.WriteAllBytes(filePath, [1, 2, 3]);
            var privilege = new RejectingRestorePrivilege();
            var accessControl = new WindowsBridgeCredentialAccessControl(
                principal => ResolveTestPrincipal(
                    principal,
                    new SecurityIdentifier(
                        WellKnownSidType.BuiltinUsersSid,
                        domainSid: null)),
                privilege,
                new BridgeCredentialFileSystem());

            BridgeCredentialStoreException exception =
                Assert.Throws<BridgeCredentialStoreException>(
                    () => accessControl.ProtectFile(filePath));

            Assert.Equal(
                BridgeCredentialStoreErrorCode.AccessControlFailure,
                exception.ErrorCode);
            Assert.Equal(1, privilege.RunCalls);
        }
        finally
        {
            DeleteTestRoot(rootPath);
        }
    }

    [Fact]
    public void DirectoryWithNonSystemOwner_IsRejected()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string rootPath = NewTestRoot();
        try
        {
            _ = Directory.CreateDirectory(rootPath);
            SecurityIdentifier bridgeService =
                ApplyExpectedPolicyWithNonSystemOwner(
                    new DirectoryInfo(rootPath));
            var accessControl = new WindowsBridgeCredentialAccessControl(
                principal => ResolveTestPrincipal(
                    principal,
                    bridgeService));

            BridgeCredentialStoreException exception =
                Assert.Throws<BridgeCredentialStoreException>(
                    () => accessControl.VerifyProtectedDirectory(rootPath));

            Assert.Equal(
                BridgeCredentialStoreErrorCode.AccessControlFailure,
                exception.ErrorCode);
        }
        finally
        {
            DeleteTestRoot(rootPath);
        }
    }

    [Fact]
    public void FileWithNonSystemOwner_IsRejected()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string rootPath = NewTestRoot();
        string filePath = Path.Combine(rootPath, "device-credential.dpapi");
        try
        {
            _ = Directory.CreateDirectory(rootPath);
            File.WriteAllBytes(filePath, [1, 2, 3]);
            SecurityIdentifier bridgeService =
                ApplyExpectedPolicyWithNonSystemOwner(
                    new FileInfo(filePath));
            var accessControl = new WindowsBridgeCredentialAccessControl(
                principal => ResolveTestPrincipal(
                    principal,
                    bridgeService));

            BridgeCredentialStoreException exception =
                Assert.Throws<BridgeCredentialStoreException>(
                    () => accessControl.VerifyProtectedFile(filePath));

            Assert.Equal(
                BridgeCredentialStoreErrorCode.AccessControlFailure,
                exception.ErrorCode);
        }
        finally
        {
            DeleteTestRoot(rootPath);
        }
    }

    [Fact]
    public void DirectoryReparsePointAnywhereInPath_IsRejected()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        string rootPath = NewTestRoot();
        string targetPath = Path.Combine(rootPath, "target");
        string linkPath = Path.Combine(rootPath, "redirect");
        try
        {
            _ = Directory.CreateDirectory(targetPath);
            _ = Directory.CreateSymbolicLink(linkPath, targetPath);
            var accessControl = new WindowsBridgeCredentialAccessControl();

            BridgeCredentialStoreException exception =
                Assert.Throws<BridgeCredentialStoreException>(
                    () => accessControl.VerifyNonReparsePath(
                        Path.Combine(linkPath, "credentials", "enrollment.lock")));

            Assert.Equal(
                BridgeCredentialStoreErrorCode.AccessControlFailure,
                exception.ErrorCode);
        }
        finally
        {
            if (Directory.Exists(linkPath))
            {
                Directory.Delete(linkPath);
            }

            DeleteTestRoot(rootPath);
        }
    }

    [SupportedOSPlatform("windows")]
    private static SecurityIdentifier ApplyExpectedPolicyWithNonSystemOwner(
        FileSystemInfo fileSystemInfo)
    {
        var system = new SecurityIdentifier(
            WellKnownSidType.LocalSystemSid,
            domainSid: null);
        var administrators = new SecurityIdentifier(
            WellKnownSidType.BuiltinAdministratorsSid,
            domainSid: null);
        FileSystemSecurity existing = fileSystemInfo switch
        {
            DirectoryInfo directory => directory.GetAccessControl(
                AccessControlSections.Owner),
            FileInfo file => file.GetAccessControl(
                AccessControlSections.Owner),
            _ => throw new ArgumentOutOfRangeException(
                nameof(fileSystemInfo)),
        };
        var existingOwner =
            (SecurityIdentifier?)existing.GetOwner(
                typeof(SecurityIdentifier)) ??
            throw new InvalidOperationException(
                "The test filesystem object has no owner.");
        SecurityIdentifier nonSystemOwner = Equals(existingOwner, system)
            ? administrators
            : existingOwner;
        SecurityIdentifier bridgeService = SelectTestServicePrincipal(
            system,
            administrators);
        FileSystemSecurity security = fileSystemInfo switch
        {
            DirectoryInfo => new DirectorySecurity(),
            FileInfo => new FileSecurity(),
            _ => throw new ArgumentOutOfRangeException(
                nameof(fileSystemInfo)),
        };
        security.SetOwner(nonSystemOwner);
        security.SetAccessRuleProtection(
            isProtected: true,
            preserveInheritance: false);
        AddExpectedRule(
            security,
            system,
            FileSystemRights.FullControl,
            fileSystemInfo is DirectoryInfo);
        AddExpectedRule(
            security,
            administrators,
            FileSystemRights.FullControl,
            fileSystemInfo is DirectoryInfo);
        AddExpectedRule(
            security,
            bridgeService,
            FileSystemRights.Modify,
            fileSystemInfo is DirectoryInfo);
        switch (fileSystemInfo)
        {
            case DirectoryInfo directory:
                directory.SetAccessControl((DirectorySecurity)security);
                break;
            case FileInfo file:
                file.SetAccessControl((FileSecurity)security);
                break;
        }

        return bridgeService;
    }

    [SupportedOSPlatform("windows")]
    private static SecurityIdentifier SelectTestServicePrincipal(
        SecurityIdentifier system,
        SecurityIdentifier administrators)
    {
        SecurityIdentifier? currentUser = WindowsIdentity.GetCurrent().User;
        if (currentUser is not null &&
            !Equals(currentUser, system) &&
            !Equals(currentUser, administrators))
        {
            return currentUser;
        }

        return new SecurityIdentifier(
            WellKnownSidType.BuiltinUsersSid,
            domainSid: null);
    }

    [SupportedOSPlatform("windows")]
    private static SecurityIdentifier ResolveTestPrincipal(
        BridgeCredentialAclPrincipal principal,
        SecurityIdentifier bridgeService) =>
        principal switch
        {
            BridgeCredentialAclPrincipal.LocalSystem =>
                new SecurityIdentifier(
                    WellKnownSidType.LocalSystemSid,
                    domainSid: null),
            BridgeCredentialAclPrincipal.BuiltinAdministrators =>
                new SecurityIdentifier(
                    WellKnownSidType.BuiltinAdministratorsSid,
                    domainSid: null),
            BridgeCredentialAclPrincipal.BridgeService => bridgeService,
            _ => throw new ArgumentOutOfRangeException(nameof(principal)),
        };

    [SupportedOSPlatform("windows")]
    private static void AddExpectedRule(
        FileSystemSecurity security,
        SecurityIdentifier principal,
        FileSystemRights rights,
        bool inheritToChildren)
    {
        security.AddAccessRule(
            new FileSystemAccessRule(
                principal,
                rights,
                inheritToChildren
                    ? InheritanceFlags.ContainerInherit |
                      InheritanceFlags.ObjectInherit
                    : InheritanceFlags.None,
                PropagationFlags.None,
                AccessControlType.Allow));
    }

    private static string NewTestRoot() =>
        Path.Combine(
            Path.GetTempPath(),
            "revagent-bridge-acl-tests-" + Guid.NewGuid().ToString("N"));

    private static void DeleteTestRoot(string rootPath)
    {
        if (Directory.Exists(rootPath))
        {
            Directory.Delete(rootPath, recursive: true);
        }
    }

    private sealed class RejectingRestorePrivilege :
        IBridgeRestorePrivilege
    {
        internal int RunCalls { get; private set; }

        public void Run(Action action)
        {
            RunCalls++;
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.AccessControlFailure,
                "Injected missing SeRestorePrivilege.");
        }
    }
}
