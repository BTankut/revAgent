using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;

namespace RevAgent.Bridge.AddinLoopback;

internal sealed record WindowsFileAccessRuleEvidence(
    string Sid,
    uint Rights,
    bool IsAllow,
    bool IsInheritOnly);

internal sealed record WindowsFileAclEvidence(
    string OwnerSid,
    bool DiscretionaryAclPresent,
    IReadOnlyList<WindowsFileAccessRuleEvidence> AccessRules);

internal interface IWindowsFileTrustInspector
{
    string GetFullPath(string path);

    bool FileExists(string path);

    FileAttributes GetAttributes(string path);

    WindowsFileAclEvidence ReadAcl(string path, bool isDirectory);
}

internal interface IWindowsAuthenticodeTrustVerifier
{
    void Verify(string imagePath);
}

internal interface IWindowsPublisherReader
{
    string ReadPublisherName(string imagePath);
}

internal interface IWinTrustNative
{
    int Invoke(
        string imagePath,
        uint uiChoice,
        uint revocationChecks,
        uint stateAction,
        uint providerFlags,
        ref IntPtr stateData);
}

internal sealed class WindowsRevitImageTrustVerifier
    : IWindowsRevitImageTrustVerifier
{
    private const uint GenericAll = 0x10000000;
    private const uint GenericWrite = 0x40000000;

    // Native FILE_* / standard rights values are kept numeric so the policy
    // itself remains platform-neutral and can be unit-tested off Windows.
    private const uint DangerousFileSystemRights =
        GenericAll |
        GenericWrite |
        0x00000002 | // FILE_WRITE_DATA
        0x00000004 | // FILE_APPEND_DATA
        0x00000010 | // FILE_WRITE_EA
        0x00000100 | // FILE_WRITE_ATTRIBUTES
        0x00000040 | // FILE_DELETE_CHILD
        0x00010000 | // DELETE
        0x00040000 | // WRITE_DAC
        0x00080000;  // WRITE_OWNER

    private static readonly HashSet<string> TrustedOwnerSids =
        new(StringComparer.Ordinal)
        {
            "S-1-5-18",
            "S-1-5-32-544",
            "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
        };
    private static readonly HashSet<string> TrustedPublisherNames =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "Autodesk, Inc.",
            "Autodesk, Inc",
        };

    private readonly IWindowsFileTrustInspector _fileInspector;
    private readonly IWindowsAuthenticodeTrustVerifier _authenticodeVerifier;
    private readonly IWindowsPublisherReader _publisherReader;
    private readonly Func<bool> _isWindows;

    internal WindowsRevitImageTrustVerifier()
        : this(
            new WindowsFileTrustInspector(),
            new WindowsAuthenticodeTrustVerifier(new WinTrustNative()),
            new WindowsPublisherReader(),
            OperatingSystem.IsWindows)
    {
    }

    internal WindowsRevitImageTrustVerifier(
        IWindowsFileTrustInspector fileInspector,
        IWindowsAuthenticodeTrustVerifier authenticodeVerifier,
        IWindowsPublisherReader publisherReader,
        Func<bool> isWindows)
    {
        _fileInspector = fileInspector ??
            throw new ArgumentNullException(nameof(fileInspector));
        _authenticodeVerifier = authenticodeVerifier ??
            throw new ArgumentNullException(nameof(authenticodeVerifier));
        _publisherReader = publisherReader ??
            throw new ArgumentNullException(nameof(publisherReader));
        _isWindows = isWindows ??
            throw new ArgumentNullException(nameof(isWindows));
    }

    public void Verify(string imagePath, string trustedProgramFilesRoot)
    {
        if (!_isWindows())
        {
            throw Failure(
                "revit_process_image_trust_unavailable",
                "Revit executable trust verification is available only on Windows.");
        }

        string canonicalImagePath;
        string canonicalRoot;
        try
        {
            canonicalImagePath = _fileInspector.GetFullPath(imagePath);
            canonicalRoot = Path.TrimEndingDirectorySeparator(
                _fileInspector.GetFullPath(trustedProgramFilesRoot));
        }
        catch (Exception exception) when (
            exception is ArgumentException ||
            exception is NotSupportedException ||
            exception is PathTooLongException)
        {
            throw Failure(
                "revit_process_image_path_untrusted",
                "The Revit executable path could not be canonicalized.",
                exception);
        }

        if (!IsPathInsideRoot(canonicalImagePath, canonicalRoot) ||
            !string.Equals(
                Path.GetFileName(canonicalImagePath),
                "Revit.exe",
                StringComparison.OrdinalIgnoreCase) ||
            !_fileInspector.FileExists(canonicalImagePath))
        {
            throw Failure(
                "revit_process_image_path_untrusted",
                "The Revit executable is not a regular file below the trusted Program Files root.");
        }

        VerifyPathChain(canonicalImagePath, canonicalRoot);
        _authenticodeVerifier.Verify(canonicalImagePath);
        VerifyPublisher(canonicalImagePath);
    }

    private void VerifyPathChain(
        string canonicalImagePath,
        string canonicalRoot)
    {
        var paths = new Stack<string>();
        paths.Push(canonicalImagePath);
        DirectoryInfo? directory =
            new FileInfo(canonicalImagePath).Directory;
        while (directory != null)
        {
            paths.Push(directory.FullName);
            if (string.Equals(
                    Path.TrimEndingDirectorySeparator(directory.FullName),
                    canonicalRoot,
                    StringComparison.OrdinalIgnoreCase))
            {
                break;
            }

            directory = directory.Parent;
        }

        if (directory == null)
        {
            throw Failure(
                "revit_process_image_path_untrusted",
                "The Revit executable path does not reach the trusted Program Files root.");
        }

        foreach (string path in paths)
        {
            FileAttributes attributes;
            try
            {
                attributes = _fileInspector.GetAttributes(path);
            }
            catch (Exception exception) when (
                exception is IOException ||
                exception is UnauthorizedAccessException)
            {
                throw Failure(
                    "revit_process_image_acl_unavailable",
                    "A Revit executable path ACL could not be read.",
                    exception);
            }

            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw Failure(
                    "revit_process_image_path_untrusted",
                    "The trusted Revit executable path must not contain reparse points.");
            }

            VerifyAcl(
                path,
                (attributes & FileAttributes.Directory) != 0);
        }
    }

    private void VerifyAcl(string path, bool isDirectory)
    {
        WindowsFileAclEvidence evidence;
        try
        {
            evidence = _fileInspector.ReadAcl(path, isDirectory);
        }
        catch (Exception exception) when (
            exception is IOException ||
            exception is UnauthorizedAccessException ||
            exception is System.Security.SecurityException)
        {
            throw Failure(
                "revit_process_image_acl_unavailable",
                "A Revit executable path ACL could not be read.",
                exception);
        }

        if (!TrustedOwnerSids.Contains(evidence.OwnerSid))
        {
            throw Failure(
                "revit_process_image_owner_untrusted",
                "A Revit executable path object has an untrusted owner.");
        }

        if (!evidence.DiscretionaryAclPresent)
        {
            throw Failure(
                "revit_process_image_acl_untrusted",
                "A Revit executable path object has no discretionary ACL.");
        }

        foreach (WindowsFileAccessRuleEvidence rule in evidence.AccessRules)
        {
            if (!rule.IsAllow ||
                TrustedOwnerSids.Contains(rule.Sid) ||
                (string.Equals(
                     rule.Sid,
                     "S-1-3-0",
                     StringComparison.Ordinal) &&
                 rule.IsInheritOnly))
            {
                continue;
            }

            if ((rule.Rights & DangerousFileSystemRights) != 0)
            {
                throw Failure(
                    "revit_process_image_acl_untrusted",
                    "A non-administrative principal can modify the Revit executable path.");
            }
        }
    }

    private static bool IsPathInsideRoot(
        string candidate,
        string root) =>
        candidate.StartsWith(
            root + Path.DirectorySeparatorChar,
            StringComparison.OrdinalIgnoreCase);

    private void VerifyPublisher(string imagePath)
    {
        string publisherName;
        try
        {
            publisherName = _publisherReader.ReadPublisherName(imagePath);
        }
        catch (Exception exception)
        {
            throw Failure(
                "revit_process_image_signature_unavailable",
                "The Revit executable signer certificate could not be read.",
                exception);
        }

        if (!TrustedPublisherNames.Contains(publisherName))
        {
            throw Failure(
                "revit_process_image_publisher_untrusted",
                "The Revit executable signer is not the allowlisted Autodesk publisher.");
        }
    }

    private static AddinProcessAttestationException Failure(
        string code,
        string message,
        Exception? innerException = null) =>
        new(code, message, innerException);
}

internal sealed class WindowsFileTrustInspector
    : IWindowsFileTrustInspector
{
    public string GetFullPath(string path) => Path.GetFullPath(path);

    public bool FileExists(string path) => File.Exists(path);

    public FileAttributes GetAttributes(string path) =>
        File.GetAttributes(path);

    [SupportedOSPlatform("windows")]
    public WindowsFileAclEvidence ReadAcl(string path, bool isDirectory)
    {
        FileSystemSecurity security = isDirectory
            ? new DirectoryInfo(path).GetAccessControl(
                AccessControlSections.Owner |
                AccessControlSections.Access)
            : new FileInfo(path).GetAccessControl(
                AccessControlSections.Owner |
                AccessControlSections.Access);

        IdentityReference? owner =
            security.GetOwner(typeof(SecurityIdentifier));
        string ownerSid = owner is SecurityIdentifier securityIdentifier
            ? securityIdentifier.Value
            : string.Empty;
        var rawSecurityDescriptor = new RawSecurityDescriptor(
            security.GetSecurityDescriptorBinaryForm(),
            offset: 0);
        bool daclPresent =
            (rawSecurityDescriptor.ControlFlags &
             ControlFlags.DiscretionaryAclPresent) != 0 &&
            rawSecurityDescriptor.DiscretionaryAcl != null;

        var evidence = new List<WindowsFileAccessRuleEvidence>();
        AuthorizationRuleCollection rules = security.GetAccessRules(
            includeExplicit: true,
            includeInherited: true,
            typeof(SecurityIdentifier));
        foreach (AuthorizationRule authorizationRule in rules)
        {
            if (authorizationRule is not FileSystemAccessRule rule ||
                rule.IdentityReference is not SecurityIdentifier sid)
            {
                continue;
            }

            evidence.Add(
                new WindowsFileAccessRuleEvidence(
                    sid.Value,
                    unchecked((uint)rule.FileSystemRights),
                    rule.AccessControlType == AccessControlType.Allow,
                    (rule.PropagationFlags &
                     PropagationFlags.InheritOnly) != 0));
        }

        return new WindowsFileAclEvidence(
            ownerSid,
            daclPresent,
            evidence);
    }
}

internal sealed class WindowsAuthenticodeTrustVerifier
    : IWindowsAuthenticodeTrustVerifier
{
    internal const uint WinTrustUiNone = 2;
    internal const uint WinTrustRevokeWholeChain = 1;
    internal const uint WinTrustStateActionVerify = 1;
    internal const uint WinTrustStateActionClose = 2;
    internal const uint WinTrustRevocationCheckChainExcludeRoot = 0x80;
    internal const uint WinTrustCacheOnlyUrlRetrieval = 0x1000;

    private readonly IWinTrustNative _native;

    internal WindowsAuthenticodeTrustVerifier(IWinTrustNative native)
    {
        _native = native ?? throw new ArgumentNullException(nameof(native));
    }

    public void Verify(string imagePath)
    {
        IntPtr stateData = IntPtr.Zero;
        try
        {
            int trustResult = _native.Invoke(
                imagePath,
                WinTrustUiNone,
                WinTrustRevokeWholeChain,
                WinTrustStateActionVerify,
                WinTrustRevocationCheckChainExcludeRoot |
                    WinTrustCacheOnlyUrlRetrieval,
                ref stateData);
            if (trustResult != 0)
            {
                throw new AddinProcessAttestationException(
                    "revit_process_image_signature_untrusted",
                    "Windows did not validate the Revit executable Authenticode signature.",
                    new InvalidOperationException(
                        "WinVerifyTrust HRESULT: 0x" +
                        trustResult.ToString(
                            "X8",
                            CultureInfo.InvariantCulture)));
            }
        }
        finally
        {
            if (stateData != IntPtr.Zero)
            {
                _ = _native.Invoke(
                    imagePath,
                    WinTrustUiNone,
                    WinTrustRevokeWholeChain,
                    WinTrustStateActionClose,
                    WinTrustRevocationCheckChainExcludeRoot |
                        WinTrustCacheOnlyUrlRetrieval,
                    ref stateData);
            }
        }
    }
}

internal sealed class WindowsPublisherReader : IWindowsPublisherReader
{
    [SupportedOSPlatform("windows")]
    public string ReadPublisherName(string imagePath)
    {
        using X509Certificate certificate =
            X509Certificate.CreateFromSignedFile(imagePath);
        using var certificate2 = new X509Certificate2(certificate);
        return certificate2.GetNameInfo(
            X509NameType.SimpleName,
            forIssuer: false);
    }
}

internal sealed class WinTrustNative : IWinTrustNative
{
    private const uint WinTrustChoiceFile = 1;
    private static readonly Guid GenericVerifyV2Action =
        new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

    [SupportedOSPlatform("windows")]
    public int Invoke(
        string imagePath,
        uint uiChoice,
        uint revocationChecks,
        uint stateAction,
        uint providerFlags,
        ref IntPtr stateData)
    {
        var fileInfo = new WinTrustFileInfo
        {
            StructSize = checked((uint)Marshal.SizeOf<WinTrustFileInfo>()),
            FilePath = imagePath,
            FileHandle = IntPtr.Zero,
            KnownSubject = IntPtr.Zero,
        };
        IntPtr fileInfoPointer = Marshal.AllocCoTaskMem(
            Marshal.SizeOf<WinTrustFileInfo>());
        Marshal.StructureToPtr(fileInfo, fileInfoPointer, false);
        var trustData = new WinTrustData
        {
            StructSize = checked((uint)Marshal.SizeOf<WinTrustData>()),
            UiChoice = uiChoice,
            RevocationChecks = revocationChecks,
            UnionChoice = WinTrustChoiceFile,
            FileInfo = fileInfoPointer,
            StateAction = stateAction,
            StateData = stateData,
            ProviderFlags = providerFlags,
        };

        try
        {
            Guid action = GenericVerifyV2Action;
            int result = WinVerifyTrust(
                new IntPtr(-1),
                ref action,
                ref trustData);
            stateData = trustData.StateData;
            return result;
        }
        finally
        {
            Marshal.DestroyStructure<WinTrustFileInfo>(fileInfoPointer);
            Marshal.FreeCoTaskMem(fileInfoPointer);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustFileInfo
    {
        internal uint StructSize;

        [MarshalAs(UnmanagedType.LPWStr)]
        internal string? FilePath;

        internal IntPtr FileHandle;
        internal IntPtr KnownSubject;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustData
    {
        internal uint StructSize;
        internal IntPtr PolicyCallbackData;
        internal IntPtr SipClientData;
        internal uint UiChoice;
        internal uint RevocationChecks;
        internal uint UnionChoice;
        internal IntPtr FileInfo;
        internal uint StateAction;
        internal IntPtr StateData;
        internal IntPtr UrlReference;
        internal uint ProviderFlags;
        internal uint UiContext;
    }

    [DllImport(
        "wintrust.dll",
        ExactSpelling = true,
        SetLastError = true)]
    private static extern int WinVerifyTrust(
        IntPtr windowHandle,
        ref Guid actionId,
        ref WinTrustData trustData);
}
