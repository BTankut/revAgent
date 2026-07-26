using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;

namespace RevAgent.Bridge.Bootstrap.Enrollment;

internal interface IBridgeCredentialAccessControl
{
    void EnsureProtectedDirectory(string directoryPath);

    BridgePathEntryKind ClassifyPath(string path);

    IDisposable PinProtectedDirectory(string directoryPath);

    void VerifyNonReparsePath(string path);

    void ProtectFile(string filePath);

    void VerifyProtectedDirectory(string directoryPath);

    void VerifyProtectedFile(string filePath);

    BridgeFileIdentity GetProtectedFileIdentity(string filePath);

    BridgeProtectedFileRead ReadProtectedFile(
        string filePath,
        int maximumBytes);
}

internal enum BridgeCredentialAclPrincipal
{
    LocalSystem,
    BuiltinAdministrators,
    BridgeService,
}

internal enum BridgeCredentialAclRights
{
    FullControl,
    Modify,
}

internal sealed record BridgeCredentialAclRule(
    BridgeCredentialAclPrincipal Principal,
    BridgeCredentialAclRights Rights,
    bool InheritToChildren);

internal static class BridgeCredentialAclPolicy
{
    internal const BridgeCredentialAclPrincipal OwnerPrincipal =
        BridgeCredentialAclPrincipal.LocalSystem;

    private static readonly IReadOnlyList<BridgeCredentialAclRule>
        ProtectedDirectoryRules =
            Array.AsReadOnly<BridgeCredentialAclRule>(
            [
                new(
                    BridgeCredentialAclPrincipal.LocalSystem,
                    BridgeCredentialAclRights.FullControl,
                    InheritToChildren: true),
                new(
                    BridgeCredentialAclPrincipal.BuiltinAdministrators,
                    BridgeCredentialAclRights.FullControl,
                    InheritToChildren: true),
                new(
                    BridgeCredentialAclPrincipal.BridgeService,
                    BridgeCredentialAclRights.Modify,
                    InheritToChildren: true),
            ]);

    private static readonly IReadOnlyList<BridgeCredentialAclRule>
        ProtectedFileRules =
            Array.AsReadOnly<BridgeCredentialAclRule>(
            [
                new(
                    BridgeCredentialAclPrincipal.LocalSystem,
                    BridgeCredentialAclRights.FullControl,
                    InheritToChildren: false),
                new(
                    BridgeCredentialAclPrincipal.BuiltinAdministrators,
                    BridgeCredentialAclRights.FullControl,
                    InheritToChildren: false),
                new(
                    BridgeCredentialAclPrincipal.BridgeService,
                    BridgeCredentialAclRights.Modify,
                    InheritToChildren: false),
            ]);

    internal static IReadOnlyList<BridgeCredentialAclRule> DirectoryRules =>
        ProtectedDirectoryRules;

    internal static IReadOnlyList<BridgeCredentialAclRule> FileRules =>
        ProtectedFileRules;
}

[SupportedOSPlatform("windows")]
internal sealed class WindowsBridgeCredentialAccessControl :
    IBridgeCredentialAccessControl
{
    private readonly Func<BridgeCredentialAclPrincipal, SecurityIdentifier>
        _principalResolver;
    private readonly IBridgeRestorePrivilege _restorePrivilege;
    private readonly IBridgeCredentialFileSystem _fileSystem;

    internal WindowsBridgeCredentialAccessControl()
        : this(
            ResolveProductionPrincipal,
            new WindowsBridgeRestorePrivilege(),
            new BridgeCredentialFileSystem())
    {
    }

    internal WindowsBridgeCredentialAccessControl(
        Func<BridgeCredentialAclPrincipal, SecurityIdentifier> principalResolver)
        : this(
            principalResolver,
            new WindowsBridgeRestorePrivilege(),
            new BridgeCredentialFileSystem())
    {
    }

    internal WindowsBridgeCredentialAccessControl(
        Func<BridgeCredentialAclPrincipal, SecurityIdentifier> principalResolver,
        IBridgeRestorePrivilege restorePrivilege,
        IBridgeCredentialFileSystem fileSystem)
    {
        ArgumentNullException.ThrowIfNull(principalResolver);
        ArgumentNullException.ThrowIfNull(restorePrivilege);
        ArgumentNullException.ThrowIfNull(fileSystem);
        _principalResolver = principalResolver;
        _restorePrivilege = restorePrivilege;
        _fileSystem = fileSystem;
    }

    public void EnsureProtectedDirectory(string directoryPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(directoryPath);
        if (!OperatingSystem.IsWindows())
        {
            throw UnsupportedPlatform();
        }

        ExecuteAclOperation(
            () => _restorePrivilege.Run(
                () => EnsureProtectedDirectoryWindows(directoryPath)),
            "The bridge credential directory ACL could not be enforced.");
    }

    public BridgePathEntryKind ClassifyPath(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        if (!OperatingSystem.IsWindows())
        {
            throw UnsupportedPlatform();
        }

        return ExecuteAclOperation(
            () => _fileSystem.Classify(path),
            "The bridge credential path could not be classified.");
    }

    public IDisposable PinProtectedDirectory(string directoryPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(directoryPath);
        if (!OperatingSystem.IsWindows())
        {
            throw UnsupportedPlatform();
        }

        return ExecuteAclOperation(
            () =>
            {
                IDisposable pin = _fileSystem.PinDirectory(directoryPath);
                try
                {
                    VerifyDirectoryWindowsCore(directoryPath);
                    return pin;
                }
                catch
                {
                    pin.Dispose();
                    throw;
                }
            },
            "The bridge credential directory could not be pinned.");
    }

    public void ProtectFile(string filePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        if (!OperatingSystem.IsWindows())
        {
            throw UnsupportedPlatform();
        }

        ExecuteAclOperation(
            () => _restorePrivilege.Run(() => ProtectFileWindows(filePath)),
            "The bridge credential file ACL could not be enforced.");
    }

    public void VerifyProtectedDirectory(string directoryPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(directoryPath);
        if (!OperatingSystem.IsWindows())
        {
            throw UnsupportedPlatform();
        }

        ExecuteAclOperation(
            () => VerifyDirectoryWindows(directoryPath),
            "The bridge credential directory ACL is not the protected policy.");
    }

    public void VerifyProtectedFile(string filePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        if (!OperatingSystem.IsWindows())
        {
            throw UnsupportedPlatform();
        }

        ExecuteAclOperation(
            () => VerifyFileWindows(filePath),
            "The bridge credential file ACL is not the protected policy.");
    }

    public BridgeFileIdentity GetProtectedFileIdentity(string filePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        if (!OperatingSystem.IsWindows())
        {
            throw UnsupportedPlatform();
        }

        return ExecuteAclOperation(
            () =>
            {
                using IBridgeFilePin pin = _fileSystem.PinFile(filePath);
                VerifyFileWindowsCore(filePath);
                return pin.Identity;
            },
            "The protected bridge credential file identity could not be " +
            "verified.");
    }

    public BridgeProtectedFileRead ReadProtectedFile(
        string filePath,
        int maximumBytes)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        if (maximumBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        }

        if (!OperatingSystem.IsWindows())
        {
            throw UnsupportedPlatform();
        }

        return ExecuteAclOperation(
            () =>
            {
                using IBridgeFilePin pin = _fileSystem.PinFile(filePath);
                VerifyFileWindowsCore(filePath);
                BridgeProtectedFileRead read =
                    _fileSystem.ReadBoundedFile(filePath, maximumBytes);
                if (read.Identity != pin.Identity)
                {
                    CryptographicOperations.ZeroMemory(read.Content);
                    throw new InvalidDataException(
                        "The protected bridge credential file identity " +
                        "changed while it was read.");
                }

                return read;
            },
            "The protected bridge credential file could not be read from a " +
            "verified handle.");
    }

    [SupportedOSPlatform("windows")]
    private void EnsureProtectedDirectoryWindows(string directoryPath)
    {
        string fullPath = Path.GetFullPath(directoryPath);
        BridgePathEntryKind kind = _fileSystem.Classify(fullPath);
        if (kind == BridgePathEntryKind.File)
        {
            throw new InvalidDataException(
                "The bridge credential directory path is a file.");
        }

        var directory = new DirectoryInfo(fullPath);
        if (kind == BridgePathEntryKind.Directory &&
            HasExpectedSecurity(
                directory.GetAccessControl(
                    AccessControlSections.Access |
                    AccessControlSections.Owner),
                BridgeCredentialAclPolicy.DirectoryRules))
        {
            return;
        }

        if (kind == BridgePathEntryKind.Missing)
        {
            string parentPath =
                Path.GetDirectoryName(fullPath) ??
                throw new InvalidDataException(
                    "The bridge credential directory has no parent.");
            using IDisposable parentPin = _fileSystem.PinDirectory(parentPath);
            _ = Directory.CreateDirectory(fullPath);
        }

        using IDisposable pin = _fileSystem.PinDirectory(fullPath);
        directory.SetAccessControl(
            BuildDirectorySecurity(BridgeCredentialAclPolicy.DirectoryRules));
        VerifyDirectoryWindowsCore(fullPath);
    }

    public void VerifyNonReparsePath(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        if (!OperatingSystem.IsWindows())
        {
            throw UnsupportedPlatform();
        }

        ExecuteAclOperation(
            () => VerifyNonReparsePathWindows(path),
            "The bridge credential path crosses a reparse point.");
    }

    [SupportedOSPlatform("windows")]
    private void ProtectFileWindows(string filePath)
    {
        string fullPath = Path.GetFullPath(filePath);
        if (_fileSystem.Classify(fullPath) != BridgePathEntryKind.File)
        {
            throw new FileNotFoundException(
                "The protected bridge credential file does not exist.",
                fullPath);
        }

        using IBridgeFilePin pin = _fileSystem.PinFile(fullPath);
        var file = new FileInfo(fullPath);
        if (HasExpectedSecurity(
                file.GetAccessControl(
                    AccessControlSections.Access |
                    AccessControlSections.Owner),
                BridgeCredentialAclPolicy.FileRules))
        {
            return;
        }

        file.SetAccessControl(
            BuildFileSecurity(BridgeCredentialAclPolicy.FileRules));
        VerifyFileWindowsCore(fullPath);
        if (_fileSystem.GetFileIdentity(fullPath) != pin.Identity)
        {
            throw new InvalidDataException(
                "The bridge credential file identity changed while its ACL " +
                "was enforced.");
        }
    }

    [SupportedOSPlatform("windows")]
    private void VerifyDirectoryWindows(string directoryPath)
    {
        using IDisposable pin = _fileSystem.PinDirectory(directoryPath);
        VerifyDirectoryWindowsCore(directoryPath);
    }

    [SupportedOSPlatform("windows")]
    private void VerifyDirectoryWindowsCore(string directoryPath)
    {
        var directory = new DirectoryInfo(directoryPath);
        DirectorySecurity security = directory.GetAccessControl(
            AccessControlSections.Access | AccessControlSections.Owner);
        VerifySecurity(
            security,
            BridgeCredentialAclPolicy.DirectoryRules);
    }

    [SupportedOSPlatform("windows")]
    private void VerifyFileWindows(string filePath)
    {
        using IBridgeFilePin pin = _fileSystem.PinFile(filePath);
        VerifyFileWindowsCore(filePath);
    }

    [SupportedOSPlatform("windows")]
    private void VerifyFileWindowsCore(string filePath)
    {
        var file = new FileInfo(filePath);
        FileSecurity security = file.GetAccessControl(
            AccessControlSections.Access | AccessControlSections.Owner);
        VerifySecurity(security, BridgeCredentialAclPolicy.FileRules);
    }

    [SupportedOSPlatform("windows")]
    private DirectorySecurity BuildDirectorySecurity(
        IReadOnlyList<BridgeCredentialAclRule> rules)
    {
        var security = new DirectorySecurity();
        security.SetOwner(
            _principalResolver(BridgeCredentialAclPolicy.OwnerPrincipal));
        security.SetAccessRuleProtection(
            isProtected: true,
            preserveInheritance: false);
        foreach (BridgeCredentialAclRule rule in rules)
        {
            security.AddAccessRule(
                new FileSystemAccessRule(
                    _principalResolver(rule.Principal),
                    MapRights(rule.Rights),
                    rule.InheritToChildren
                        ? InheritanceFlags.ContainerInherit |
                          InheritanceFlags.ObjectInherit
                        : InheritanceFlags.None,
                    PropagationFlags.None,
                    AccessControlType.Allow));
        }

        return security;
    }

    [SupportedOSPlatform("windows")]
    private FileSecurity BuildFileSecurity(
        IReadOnlyList<BridgeCredentialAclRule> rules)
    {
        var security = new FileSecurity();
        security.SetOwner(
            _principalResolver(BridgeCredentialAclPolicy.OwnerPrincipal));
        security.SetAccessRuleProtection(
            isProtected: true,
            preserveInheritance: false);
        foreach (BridgeCredentialAclRule rule in rules)
        {
            security.AddAccessRule(
                new FileSystemAccessRule(
                    _principalResolver(rule.Principal),
                    MapRights(rule.Rights),
                    InheritanceFlags.None,
                    PropagationFlags.None,
                    AccessControlType.Allow));
        }

        return security;
    }

    [SupportedOSPlatform("windows")]
    private void VerifySecurity(
        FileSystemSecurity security,
        IReadOnlyList<BridgeCredentialAclRule> expectedRules)
    {
        if (!HasExpectedSecurity(security, expectedRules))
        {
            throw new InvalidDataException(
                "The bridge credential owner or ACL is not the protected policy.");
        }
    }

    [SupportedOSPlatform("windows")]
    private bool HasExpectedSecurity(
        FileSystemSecurity security,
        IReadOnlyList<BridgeCredentialAclRule> expectedRules)
    {
        if (!security.AreAccessRulesProtected ||
            !Equals(
                security.GetOwner(typeof(SecurityIdentifier)),
                _principalResolver(
                    BridgeCredentialAclPolicy.OwnerPrincipal)))
        {
            return false;
        }

        var actual = security
            .GetAccessRules(
                includeExplicit: true,
                includeInherited: true,
                typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .Select(ToComparableRule)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        var expected = expectedRules
            .Select(
                rule => ToComparableRule(
                    new FileSystemAccessRule(
                        _principalResolver(rule.Principal),
                        MapRights(rule.Rights),
                        rule.InheritToChildren
                            ? InheritanceFlags.ContainerInherit |
                              InheritanceFlags.ObjectInherit
                            : InheritanceFlags.None,
                        PropagationFlags.None,
                        AccessControlType.Allow)))
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        return actual.SequenceEqual(expected, StringComparer.Ordinal);
    }

    [SupportedOSPlatform("windows")]
    private void VerifyNonReparsePathWindows(string path)
    {
        string fullPath = Path.GetFullPath(path);
        BridgePathEntryKind kind = _fileSystem.Classify(fullPath);
        if (kind == BridgePathEntryKind.Directory)
        {
            using IDisposable pin = _fileSystem.PinDirectory(fullPath);
            return;
        }

        if (kind == BridgePathEntryKind.File)
        {
            using IBridgeFilePin pin = _fileSystem.PinFile(fullPath);
            return;
        }

        string? current = Path.GetDirectoryName(fullPath);
        while (current is not null &&
               _fileSystem.Classify(current) == BridgePathEntryKind.Missing)
        {
            current = Path.GetDirectoryName(current);
        }

        if (current is null)
        {
            throw new InvalidDataException(
                "The bridge credential path has no existing ancestor.");
        }

        using IDisposable ancestorPin = _fileSystem.PinDirectory(current);
    }

    [SupportedOSPlatform("windows")]
    private static SecurityIdentifier ResolveProductionPrincipal(
        BridgeCredentialAclPrincipal principal)
    {
        return principal switch
        {
            BridgeCredentialAclPrincipal.LocalSystem =>
                new SecurityIdentifier(
                    WellKnownSidType.LocalSystemSid,
                    domainSid: null),
            BridgeCredentialAclPrincipal.BuiltinAdministrators =>
                new SecurityIdentifier(
                    WellKnownSidType.BuiltinAdministratorsSid,
                    domainSid: null),
            BridgeCredentialAclPrincipal.BridgeService =>
                (SecurityIdentifier)new NTAccount(
                        BridgeInstallLayout.ServiceAccount)
                    .Translate(typeof(SecurityIdentifier)),
            _ => throw new ArgumentOutOfRangeException(nameof(principal)),
        };
    }

    private static string ToComparableRule(FileSystemAccessRule rule)
    {
        string identity = rule.IdentityReference.Value;
        return string.Join(
            "|",
            identity,
            ((int)rule.FileSystemRights).ToString(
                System.Globalization.CultureInfo.InvariantCulture),
            ((int)rule.InheritanceFlags).ToString(
                System.Globalization.CultureInfo.InvariantCulture),
            ((int)rule.PropagationFlags).ToString(
                System.Globalization.CultureInfo.InvariantCulture),
            ((int)rule.AccessControlType).ToString(
                System.Globalization.CultureInfo.InvariantCulture),
            rule.IsInherited ? "inherited" : "explicit");
    }

    private static FileSystemRights MapRights(
        BridgeCredentialAclRights rights) =>
        rights switch
        {
            BridgeCredentialAclRights.FullControl =>
                FileSystemRights.FullControl,
            BridgeCredentialAclRights.Modify =>
                FileSystemRights.Modify,
            _ => throw new ArgumentOutOfRangeException(nameof(rights)),
        };

    private static BridgeCredentialStoreException UnsupportedPlatform() =>
        new(
            BridgeCredentialStoreErrorCode.UnsupportedPlatform,
            "The production bridge credential ACL requires Windows.");

    private static void ExecuteAclOperation(Action operation, string message)
    {
        try
        {
            operation();
        }
        catch (BridgeCredentialStoreException)
        {
            throw;
        }
        catch (Exception exception)
            when (exception is IOException or
                  InvalidDataException or
                  UnauthorizedAccessException or
                  IdentityNotMappedException or
                  System.Security.SecurityException or
                  PlatformNotSupportedException)
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.AccessControlFailure,
                message,
                exception);
        }
    }

    private static T ExecuteAclOperation<T>(
        Func<T> operation,
        string message)
    {
        try
        {
            return operation();
        }
        catch (BridgeCredentialStoreException)
        {
            throw;
        }
        catch (Exception exception)
            when (exception is IOException or
                  InvalidDataException or
                  UnauthorizedAccessException or
                  IdentityNotMappedException or
                  System.Security.SecurityException or
                  PlatformNotSupportedException)
        {
            throw new BridgeCredentialStoreException(
                BridgeCredentialStoreErrorCode.AccessControlFailure,
                message,
                exception);
        }
    }
}
