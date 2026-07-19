<#
.SYNOPSIS
    Check whether a revAgent stable channel is ready for signed fail-closed rollout.

.DESCRIPTION
    This preflight is read-only. It verifies the stable channel and release
    manifest with the existing distribution-integrity helper in enforce mode,
    checks package hash consistency, requires positive releaseSequence metadata,
    and scans the release root for obvious private signing material.

    It does not publish to NAS, generate keys, modify updater config, or enable
    enforcement.
#>

[CmdletBinding()]
param(
    [string]$ReleaseRoot = "",
    [string]$ChannelManifestPath = "",
    [string]$TrustedKeysPath = "",
    [long]$HighestAcceptedReleaseSequence = 0,
    [switch]$AllowRollback,
    [switch]$ReportOnly,
    [switch]$OutputJson,
    [ValidateSet("releaseRoot", "activeRelease")]
    [string]$ArtifactScanScope = "releaseRoot",
    [switch]$RequirePublishedSurface,
    [Parameter(DontShow = $true)]
    [switch]$SkipPublishedSurface,
    [Parameter(DontShow = $true)]
    [switch]$AllowTestSigningIdentity,
    [Parameter(DontShow = $true)]
    [switch]$AllowLegacyMissingNodeMsi,
    [Parameter(DontShow = $true)]
    [scriptblock]$ManagedPublishedLeafAfterOpenTestHook = $null,
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$integrityModule = Import-Module (Join-Path $RepoRoot "installer\lib\RevAgent.DistributionIntegrity.psm1") -Force -PassThru
$integrityCommand = $integrityModule.ExportedCommands['Test-RevAgentReleaseDistributionIntegrity']
if ($null -eq $integrityCommand) {
    throw 'Pinned distribution-integrity module did not export Test-RevAgentReleaseDistributionIntegrity.'
}
$publicKeyFingerprintCommand = $integrityModule.ExportedCommands['Get-RevAgentPublicKeyFingerprint']
if ($null -eq $publicKeyFingerprintCommand) {
    throw 'Pinned distribution-integrity module did not export Get-RevAgentPublicKeyFingerprint.'
}

$productionSigningKeyId = 'revagent-prod-rsa-2026q3'
$productionSigningFingerprint = '32F8BD0B4E905BB58606FB226459C09A6AE2CFC10A4E94203566FE4ADD7BBE33'
$canonicalProductionReleaseRoot = [System.IO.Path]::GetFullPath('\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy').TrimEnd('\', '/')
$nodeMsiRelativePath = 'external\node-v24.14.1-x64.msi'
$nodeMsiSha256 = 'FD8BA3E8262738959CAD50E6F6E71D689EAB7DD09FC7231B51D78ABE7852D4EC'
$nodeMsiSizeBytes = [long]32387072
$nodeMsiSignerSubject = 'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US'
$managedPublishedLeafMaxBytes = [long](4 * 1024 * 1024)
if ($null -ne $ManagedPublishedLeafAfterOpenTestHook -and -not $AllowTestSigningIdentity) {
    throw 'ManagedPublishedLeafAfterOpenTestHook is limited to disposable test-signing roots.'
}

if (-not ('RevAgent.ReadinessManagedLeafGuard' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace RevAgent
{
    public sealed class ReadinessManagedLeafRead
    {
        public byte[] Bytes { get; private set; }
        public string Sha256 { get; private set; }
        public string Identity { get; private set; }
        public uint LinkCount { get; private set; }
        public long Length { get; private set; }

        internal ReadinessManagedLeafRead(byte[] bytes, string sha256, string identity, uint linkCount, long length)
        {
            Bytes = bytes;
            Sha256 = sha256;
            Identity = identity;
            LinkCount = linkCount;
            Length = length;
        }
    }

    public sealed class ReadinessManagedLeafGuard : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME
        {
            public uint LowDateTime;
            public uint HighDateTime;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION
        {
            public uint FileAttributes;
            public FILETIME CreationTime;
            public FILETIME LastAccessTime;
            public FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle file,
            out BY_HANDLE_FILE_INFORMATION information);

        private const uint FILE_READ_ATTRIBUTES = 0x00000080;
        private const uint GENERIC_READ = 0x80000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_SEQUENTIAL_SCAN = 0x08000000;

        private readonly List<SafeFileHandle> directoryHandles;
        private readonly FileStream stream;
        private readonly string fullPath;
        private readonly string identity;
        private readonly long length;
        private bool disposed;

        public string FullPath { get { return fullPath; } }
        public string Identity { get { return identity; } }
        public long Length { get { return length; } }

        private ReadinessManagedLeafGuard(List<SafeFileHandle> directoryHandles, FileStream stream, string fullPath, string identity, long length)
        {
            this.directoryHandles = directoryHandles;
            this.stream = stream;
            this.fullPath = fullPath;
            this.identity = identity;
            this.length = length;
        }

        private static SafeFileHandle OpenExact(string path, uint access, uint share, uint flags, string kind)
        {
            SafeFileHandle handle = CreateFileW(path, access, share, IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
            if (handle == null || handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                if (handle != null) handle.Dispose();
                throw new Win32Exception(error, "Could not open exact managed published " + kind + ": " + path);
            }
            return handle;
        }

        private static BY_HANDLE_FILE_INFORMATION ReadInformation(SafeFileHandle handle)
        {
            if (handle == null || handle.IsInvalid) throw new ArgumentException("A valid managed published-surface handle is required.", "handle");
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return information;
        }

        private static string FormatIdentity(BY_HANDLE_FILE_INFORMATION information)
        {
            return String.Format("{0:X8}:{1:X8}{2:X8}", information.VolumeSerialNumber, information.FileIndexHigh, information.FileIndexLow);
        }

        private static long GetLength(BY_HANDLE_FILE_INFORMATION information)
        {
            return ((long)information.FileSizeHigh << 32) | (long)information.FileSizeLow;
        }

        private static void AssertDirectory(string path, SafeFileHandle handle)
        {
            BY_HANDLE_FILE_INFORMATION information = ReadInformation(handle);
            if ((information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                throw new InvalidDataException("managed_leaf_reparse_path: " + path);
            if ((information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0)
                throw new InvalidDataException("managed_leaf_non_directory_ancestor: " + path);
        }

        private static void AssertOrdinarySingleLinkLeaf(string path, BY_HANDLE_FILE_INFORMATION information)
        {
            if ((information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                throw new InvalidDataException("managed_leaf_reparse_path: " + path);
            if ((information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0)
                throw new InvalidDataException("managed_leaf_not_file: " + path);
            if (information.NumberOfLinks != 1)
                throw new InvalidDataException("managed_leaf_hardlink: path=" + path + " linkCount=" + information.NumberOfLinks);
        }

        public static ReadinessManagedLeafGuard Open(string releaseRoot, string relativePath, long maxBytes)
        {
            if (String.IsNullOrWhiteSpace(releaseRoot)) throw new ArgumentException("Release root is required.", "releaseRoot");
            if (String.IsNullOrWhiteSpace(relativePath) || Path.IsPathRooted(relativePath)) throw new ArgumentException("A non-rooted managed relative path is required.", "relativePath");
            if (maxBytes < 1 || maxBytes > Int32.MaxValue) throw new ArgumentOutOfRangeException("maxBytes");

            string fullRoot = Path.GetFullPath(releaseRoot);
            string rootPath = Path.GetPathRoot(fullRoot);
            while (fullRoot.Length > rootPath.Length && (fullRoot.EndsWith("\\", StringComparison.Ordinal) || fullRoot.EndsWith("/", StringComparison.Ordinal)))
                fullRoot = fullRoot.Substring(0, fullRoot.Length - 1);
            string[] parts = relativePath.Split(new char[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) throw new ArgumentException("Managed relative path has no leaf.", "relativePath");
            foreach (string part in parts)
            {
                if (part == "." || part == "..") throw new InvalidDataException("managed_leaf_path_escape: " + relativePath);
            }
            string fullPath = Path.GetFullPath(Path.Combine(fullRoot, relativePath));
            string prefix = fullRoot + Path.DirectorySeparatorChar;
            if (!fullPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("managed_leaf_path_escape: " + relativePath);

            List<SafeFileHandle> directoryHandles = new List<SafeFileHandle>();
            FileStream stream = null;
            try
            {
                string cursor = fullRoot;
                SafeFileHandle rootHandle = OpenExact(cursor, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, "root");
                directoryHandles.Add(rootHandle);
                AssertDirectory(cursor, rootHandle);
                for (int index = 0; index < parts.Length - 1; index++)
                {
                    cursor = Path.Combine(cursor, parts[index]);
                    SafeFileHandle directoryHandle = OpenExact(cursor, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, "directory");
                    directoryHandles.Add(directoryHandle);
                    AssertDirectory(cursor, directoryHandle);
                }

                SafeFileHandle leafHandle = OpenExact(fullPath, GENERIC_READ, FILE_SHARE_READ, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, "leaf");
                BY_HANDLE_FILE_INFORMATION leafInformation;
                try
                {
                    leafInformation = ReadInformation(leafHandle);
                    AssertOrdinarySingleLinkLeaf(fullPath, leafInformation);
                    long leafLength = GetLength(leafInformation);
                    if (leafLength < 0 || leafLength > maxBytes)
                        throw new InvalidDataException("managed_leaf_size_out_of_bounds: path=" + fullPath + " size=" + leafLength + " maxBytes=" + maxBytes);
                    stream = new FileStream(leafHandle, FileAccess.Read, 65536, false);
                    leafHandle = null;
                    ReadinessManagedLeafGuard guard = new ReadinessManagedLeafGuard(directoryHandles, stream, fullPath, FormatIdentity(leafInformation), leafLength);
                    guard.AssertStillNamed();
                    directoryHandles = null;
                    stream = null;
                    return guard;
                }
                finally
                {
                    if (leafHandle != null) leafHandle.Dispose();
                }
            }
            catch
            {
                if (stream != null) stream.Dispose();
                if (directoryHandles != null)
                {
                    for (int index = directoryHandles.Count - 1; index >= 0; index--) directoryHandles[index].Dispose();
                }
                throw;
            }
        }

        private void AssertStillNamed()
        {
            BY_HANDLE_FILE_INFORMATION heldInformation = ReadInformation(stream.SafeFileHandle);
            AssertOrdinarySingleLinkLeaf(fullPath, heldInformation);
            if (!String.Equals(FormatIdentity(heldInformation), identity, StringComparison.Ordinal) || GetLength(heldInformation) != length)
                throw new InvalidDataException("managed_leaf_identity_mismatch: " + fullPath);

            using (SafeFileHandle pathHandle = OpenExact(fullPath, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_FLAG_OPEN_REPARSE_POINT, "identity check"))
            {
                BY_HANDLE_FILE_INFORMATION pathInformation = ReadInformation(pathHandle);
                AssertOrdinarySingleLinkLeaf(fullPath, pathInformation);
                if (!String.Equals(FormatIdentity(pathInformation), identity, StringComparison.Ordinal) || GetLength(pathInformation) != length)
                    throw new InvalidDataException("managed_leaf_identity_mismatch: " + fullPath);
            }
        }

        public ReadinessManagedLeafRead ReadBounded()
        {
            if (disposed) throw new ObjectDisposedException("ReadinessManagedLeafGuard");
            AssertStillNamed();
            if (stream.Length != length) throw new InvalidDataException("managed_leaf_identity_mismatch: " + fullPath);
            stream.Position = 0;
            byte[] bytes = new byte[(int)length];
            int offset = 0;
            while (offset < bytes.Length)
            {
                int read = stream.Read(bytes, offset, bytes.Length - offset);
                if (read <= 0) throw new EndOfStreamException("managed_leaf_unexpected_end: " + fullPath);
                offset += read;
            }
            if (stream.ReadByte() != -1) throw new InvalidDataException("managed_leaf_grew_during_read: " + fullPath);
            AssertStillNamed();
            using (SHA256 algorithm = SHA256.Create())
            {
                string sha256 = BitConverter.ToString(algorithm.ComputeHash(bytes)).Replace("-", "");
                return new ReadinessManagedLeafRead(bytes, sha256, identity, 1, length);
            }
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            stream.Dispose();
            for (int index = directoryHandles.Count - 1; index >= 0; index--) directoryHandles[index].Dispose();
        }
    }
}
'@
}

function Read-RevAgentJsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    return Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json
}

function ConvertFrom-RevAgentJsonBytes {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $offset = if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) { 3 } else { 0 }
    return $strictUtf8.GetString($Bytes, $offset, $Bytes.Length - $offset) | ConvertFrom-Json
}

function Read-RevAgentManagedPublishedLeaf {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][long]$MaxBytes
    )

    $fullPath = [IO.Path]::GetFullPath((Join-Path $ReleaseRoot $RelativePath))
    $guard = $null
    try {
        $guard = [RevAgent.ReadinessManagedLeafGuard]::Open($ReleaseRoot, $RelativePath, $MaxBytes)
        if ($null -ne $ManagedPublishedLeafAfterOpenTestHook) {
            & $ManagedPublishedLeafAfterOpenTestHook $fullPath $RelativePath
        }
        $read = $guard.ReadBounded()
        return [pscustomobject][ordered]@{
            path = $fullPath
            present = $true
            safe = $true
            reason = ''
            error = ''
            bytes = [byte[]]$read.Bytes
            sha256 = [string]$read.Sha256
            identity = [string]$read.Identity
            linkCount = [uint32]$read.LinkCount
            length = [long]$read.Length
            maxBytes = [long]$MaxBytes
        }
    }
    catch {
        $message = [string]$_.Exception.Message
        $present = [IO.File]::Exists($fullPath)
        $observedLinkCount = if ($message -match 'managed_leaf_hardlink:.*linkCount=([0-9]+)') { [uint32]$Matches[1] } else { [uint32]0 }
        $reason = if (-not $present) {
            'published_surface_file_missing'
        }
        elseif ($message -match 'managed_leaf_reparse_path') {
            'published_surface_reparse_path'
        }
        elseif ($message -match 'managed_leaf_hardlink') {
            'published_surface_hardlink'
        }
        elseif ($message -match 'managed_leaf_identity_mismatch') {
            'published_surface_identity_mismatch'
        }
        elseif ($message -match 'managed_leaf_size_out_of_bounds') {
            'published_surface_size_out_of_bounds'
        }
        else {
            'published_surface_unsafe_leaf'
        }
        return [pscustomobject][ordered]@{
            path = $fullPath
            present = [bool]$present
            safe = $false
            reason = $reason
            error = $message
            bytes = $null
            sha256 = ''
            identity = ''
            linkCount = $observedLinkCount
            length = [long]0
            maxBytes = [long]$MaxBytes
        }
    }
    finally {
        if ($null -ne $guard) { $guard.Dispose() }
    }
}

function Get-RevAgentBytesSha256 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '') }
    finally { $algorithm.Dispose() }
}

function Get-RevAgentPublishedStableLauncherBytes {
    param([Parameter(Mandatory = $true)][string]$PublishedReleaseRoot)

    $releaseRootFullPath = [IO.Path]::GetFullPath($PublishedReleaseRoot).TrimEnd('\', '/')
    if ($releaseRootFullPath -match '[\r\n"]') {
        throw 'Published stable launcher release root contains unsupported command-file characters.'
    }
    $templatePath = Join-Path $RepoRoot 'installer\nas\revAgent Updater STABLE.cmd'
    if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) {
        throw "Published stable launcher template was not found: $templatePath"
    }
    $templateBytes = [IO.File]::ReadAllBytes($templatePath)
    $templateText = [Text.Encoding]::ASCII.GetString($templateBytes)
    if (-not [Linq.Enumerable]::SequenceEqual([byte[]]$templateBytes, [byte[]][Text.Encoding]::ASCII.GetBytes($templateText))) {
        throw 'Published stable launcher template must contain ASCII bytes only.'
    }
    $canonicalRootLine = 'set "RELEASE_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"'
    if ([regex]::Matches($templateText, [regex]::Escape($canonicalRootLine)).Count -ne 1) {
        throw 'Published stable launcher template must contain exactly one canonical RELEASE_ROOT assignment.'
    }
    return [Text.Encoding]::ASCII.GetBytes($templateText.Replace($canonicalRootLine, ('set "RELEASE_ROOT={0}"' -f $releaseRootFullPath)))
}

function Resolve-RevAgentReleasePath {
    param(
        [string]$Path,
        [string]$BaseDirectory
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $BaseDirectory $Path))
}

function Add-RevAgentReadinessCheck {
    param(
        [System.Collections.Generic.List[object]]$Checks,
        [string]$Name,
        [bool]$Success,
        [string]$Message,
        [string]$Path = "",
        [string]$Reason = ""
    )

    $Checks.Add([pscustomobject][ordered]@{
            name = $Name
            success = $Success
            reason = $Reason
            message = $Message
            path = $Path
        }) | Out-Null
}

function Read-RevAgentTrustedKeys {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Trusted release key file was not found: $Path"
    }

    $document = Read-RevAgentJsonFile -Path $Path
    $property = $document.PSObject.Properties["trustedKeys"]
    if ($property) {
        return $property.Value
    }
    return $document
}

function Find-RevAgentPrivateSigningMaterial {
    param([string]$Root)

    if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root -PathType Container)) {
        return @()
    }

    $findings = [System.Collections.Generic.List[object]]::new()
    $namePattern = '(?i)(private.*key|signing.*private|release.*private|\.pfx$|\.p12$|\.pem$|\.key$)'
    $textExtensions = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($extension in @(".json", ".xml", ".pem", ".key", ".txt", ".md", ".ps1", ".psm1", ".cmd", ".vbs", ".config")) {
        [void]$textExtensions.Add($extension)
    }

    Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
        if ($_.Name -match $namePattern) {
            $findings.Add([object]([pscustomobject][ordered]@{
                    path = $_.FullName
                    reason = "suspicious_private_key_filename"
                })) | Out-Null
            return
        }

        if (-not $textExtensions.Contains($_.Extension)) {
            return
        }

        try {
            $content = Get-Content -Raw -LiteralPath $_.FullName -Encoding UTF8 -ErrorAction Stop
            if ($content -match '-----BEGIN [A-Z ]*PRIVATE KEY-----' -or
                ($content -match '<RSAKeyValue>' -and $content -match '<P>' -and $content -match '<Q>' -and $content -match '<D>')) {
                $findings.Add([object]([pscustomobject][ordered]@{
                        path = $_.FullName
                        reason = "private_key_content"
                    })) | Out-Null
            }
        }
        catch {
            return
        }
    }

    return @($findings.ToArray())
}

function New-RevAgentReleaseArtifactFinding {
    param(
        [string]$Path,
        [string]$Reason,
        [string]$Container = ""
    )

    return [pscustomobject][ordered]@{
        path = $Path
        reason = $Reason
        container = $Container
    }
}

function Get-RevAgentForbiddenReleaseArtifactReason {
    param(
        [string]$RelativePath,
        [switch]$InsideUserPackage
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        return ""
    }

    $normalized = $RelativePath.Replace("/", "\").TrimStart("\")
    $parts = @($normalized -split '[\\/]+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($parts.Count -eq 0) {
        return ""
    }

    $leaf = [string]$parts[$parts.Count - 1]
    $extension = [System.IO.Path]::GetExtension($leaf).ToLowerInvariant()
    if ($extension -in @(".cs", ".csproj", ".sln", ".ts", ".tsx", ".pdb", ".mdb", ".map")) {
        return "source_or_debug_artifact"
    }

    if ($leaf -match '(?i)(private.*key|signing.*private|release.*private|license.*private|seat.*secret|license.*secret|\.pfx$|\.p12$|\.pem$|\.key$)') {
        return "secret_or_private_key_artifact_name"
    }

    if ($leaf -match '(?i)(^tsconfig(\..*)?\.json$|^\.eslintrc|^eslint\.config\.|^vite\.config\.|^vitest\.config\.|^rollup\.config\.|^webpack\.config\.|^jest\.config\.|^revit-payload-manifest\.json$)') {
        return "developer_manifest_artifact"
    }

    if ($leaf -match '(?i)(\.test\.js$|\.guard-test\.js$)') {
        return "developer_test_artifact"
    }

    if ($InsideUserPackage -and $leaf -in @("publish-nas-release.ps1", "promote-nas-release.ps1")) {
        return "developer_publish_tool_in_user_package"
    }

    $isAdminAddonToolsPath = $parts.Count -ge 2 -and
        [string]::Equals([string]$parts[0], "tools", [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$parts[1], "addons", [System.StringComparison]::OrdinalIgnoreCase)

    $blockedDirectoryNames = @(".git", ".github", ".githooks", ".tmp", "src", "docs", "evals", "references", "dashboard", "addons")
    $directoryParts = @()
    if ($parts.Count -gt 1) {
        $directoryParts = @($parts[0..($parts.Count - 2)])
    }
    foreach ($part in $directoryParts) {
        $allowedAdminAddonPart = $isAdminAddonToolsPath -and (
            [string]::Equals($part, "addons", [System.StringComparison]::OrdinalIgnoreCase) -or
            [string]::Equals($part, "dashboard", [System.StringComparison]::OrdinalIgnoreCase)
        )
        if ($part -in $blockedDirectoryNames -and -not $allowedAdminAddonPart) {
            return "developer_directory_artifact"
        }
    }

    if ($InsideUserPackage -and $parts.Count -gt 1 -and [string]::Equals([string]$parts[0], "scripts", [System.StringComparison]::OrdinalIgnoreCase)) {
        return "root_scripts_directory_in_user_package"
    }

    return ""
}

function Test-RevAgentPathUnderRoot {
    param(
        [string]$Path,
        [string]$Root
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\", "/")
    $rootFullPath = [System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
    return [string]::Equals($fullPath, $rootFullPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($rootFullPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Find-RevAgentReleaseArtifactFindings {
    param(
        [string]$Root,
        [string[]]$ScanPaths = @()
    )

    if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root -PathType Container)) {
        return @()
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $rootFullName = (Get-Item -LiteralPath $Root).FullName.TrimEnd("\", "/")
    $rootPrefix = $rootFullName + [System.IO.Path]::DirectorySeparatorChar
    $findings = [System.Collections.Generic.List[object]]::new()
    $filesToScan = [System.Collections.Generic.List[object]]::new()

    if ($ScanPaths -and $ScanPaths.Count -gt 0) {
        foreach ($scanPath in $ScanPaths) {
            if ([string]::IsNullOrWhiteSpace($scanPath) -or -not (Test-RevAgentPathUnderRoot -Path $scanPath -Root $rootFullName)) {
                continue
            }
            if (Test-Path -LiteralPath $scanPath -PathType Container) {
                Get-ChildItem -LiteralPath $scanPath -Recurse -File -Force | ForEach-Object {
                    $filesToScan.Add([object]$_) | Out-Null
                }
            }
            elseif (Test-Path -LiteralPath $scanPath -PathType Leaf) {
                $filesToScan.Add([object](Get-Item -LiteralPath $scanPath)) | Out-Null
            }
        }
    }
    else {
        Get-ChildItem -LiteralPath $rootFullName -Recurse -File -Force | ForEach-Object {
            $filesToScan.Add([object]$_) | Out-Null
        }
    }

    $filesToScan.ToArray() | ForEach-Object {
        $relative = $_.FullName.Substring($rootPrefix.Length).Replace("/", "\")
        $reason = Get-RevAgentForbiddenReleaseArtifactReason -RelativePath $relative
        if (-not [string]::IsNullOrWhiteSpace($reason)) {
            $findings.Add([object](New-RevAgentReleaseArtifactFinding -Path $relative -Reason $reason)) | Out-Null
        }

        if (-not [string]::Equals($_.Extension, ".zip", [System.StringComparison]::OrdinalIgnoreCase)) {
            return
        }

        try {
            $archive = [System.IO.Compression.ZipFile]::OpenRead($_.FullName)
            try {
                foreach ($entry in $archive.Entries) {
                    if ([string]::IsNullOrWhiteSpace($entry.Name)) {
                        continue
                    }

                    $entryPath = $entry.FullName.Replace("/", "\")
                    $entryReason = Get-RevAgentForbiddenReleaseArtifactReason -RelativePath $entryPath -InsideUserPackage
                    if (-not [string]::IsNullOrWhiteSpace($entryReason)) {
                        $findings.Add([object](New-RevAgentReleaseArtifactFinding -Path ("{0}!{1}" -f $relative, $entryPath) -Reason $entryReason -Container $relative)) | Out-Null
                    }
                }
            }
            finally {
                $archive.Dispose()
            }
        }
        catch {
            $findings.Add([object](New-RevAgentReleaseArtifactFinding -Path $relative -Reason "zip_read_failed")) | Out-Null
        }
    }

    return @($findings.ToArray())
}

if ([string]::IsNullOrWhiteSpace($ChannelManifestPath)) {
    if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
        throw "Pass -ReleaseRoot or -ChannelManifestPath."
    }
    $ChannelManifestPath = Join-Path $ReleaseRoot "channels\stable.json"
}

$ChannelManifestPath = [System.IO.Path]::GetFullPath($ChannelManifestPath)
$channelDir = Split-Path -Parent $ChannelManifestPath
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = Split-Path -Parent $channelDir
}
$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)

if ($RequirePublishedSurface -and $SkipPublishedSurface) {
    throw 'RequirePublishedSurface and SkipPublishedSurface are mutually exclusive.'
}
if ($SkipPublishedSurface -and -not $AllowLegacyMissingNodeMsi) {
    throw 'SkipPublishedSurface is limited to the authenticated existing-channel baseline repair path.'
}
$canonicalPublishedSurface = [string]::Equals($ReleaseRoot.TrimEnd('\', '/'), $canonicalProductionReleaseRoot, [StringComparison]::OrdinalIgnoreCase)
$publishedSurfaceRequired = [bool]$RequirePublishedSurface -or ($canonicalPublishedSurface -and -not $SkipPublishedSurface)

if ($AllowTestSigningIdentity) {
    $temporaryRootPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
    if ($ReleaseRoot.StartsWith("\\", [System.StringComparison]::Ordinal) -or
        -not $ReleaseRoot.StartsWith($temporaryRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'AllowTestSigningIdentity is limited to disposable local release roots below TEMP.'
    }
}

$checks = [System.Collections.Generic.List[object]]::new()

Add-RevAgentReadinessCheck -Checks $checks -Name "channel_manifest_present" -Success (Test-Path -LiteralPath $ChannelManifestPath -PathType Leaf) -Message "Stable channel manifest must exist." -Path $ChannelManifestPath
if (-not (Test-Path -LiteralPath $ChannelManifestPath -PathType Leaf)) {
    $report = [pscustomobject][ordered]@{
        success = $false
        readyForEnforce = $false
        reason = "channel_manifest_missing"
        releaseRoot = $ReleaseRoot
        channelManifestPath = $ChannelManifestPath
        checks = @($checks.ToArray())
    }
    if ($OutputJson) { $report | ConvertTo-Json -Depth 12 } else { $report }
    if (-not $ReportOnly) { throw "Signed stable readiness failed: channel manifest was not found." }
    return
}

$channel = Read-RevAgentJsonFile -Path $ChannelManifestPath
$releaseManifestPath = Resolve-RevAgentReleasePath -Path ([string]$channel.manifestPath) -BaseDirectory $channelDir
$packagePath = Resolve-RevAgentReleasePath -Path ([string]$channel.packagePath) -BaseDirectory $channelDir
$channelSignaturePath = Get-RevAgentDetachedSignaturePath -ContentPath $ChannelManifestPath
$releaseManifestSignaturePath = if ([string]::IsNullOrWhiteSpace($releaseManifestPath)) { "" } else { Get-RevAgentDetachedSignaturePath -ContentPath $releaseManifestPath }

Add-RevAgentReadinessCheck -Checks $checks -Name "release_manifest_present" -Success (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf) -Message "Release manifest must exist." -Path $releaseManifestPath
Add-RevAgentReadinessCheck -Checks $checks -Name "channel_signature_present" -Success (Test-Path -LiteralPath $channelSignaturePath -PathType Leaf) -Message "Stable channel detached signature must exist." -Path $channelSignaturePath
Add-RevAgentReadinessCheck -Checks $checks -Name "release_manifest_signature_present" -Success (Test-Path -LiteralPath $releaseManifestSignaturePath -PathType Leaf) -Message "Release manifest detached signature must exist." -Path $releaseManifestSignaturePath
Add-RevAgentReadinessCheck -Checks $checks -Name "package_present" -Success (Test-Path -LiteralPath $packagePath -PathType Leaf) -Message "Release ZIP must exist." -Path $packagePath

$trustedKeys = Read-RevAgentTrustedKeys -Path $TrustedKeysPath
$trustedKeyMap = ConvertTo-RevAgentTrustedKeyMap -TrustedKeys $trustedKeys
Add-RevAgentReadinessCheck -Checks $checks -Name "trusted_release_keys_present" -Success ($trustedKeyMap.Count -gt 0) -Message "At least one trusted public release key must be supplied." -Path $TrustedKeysPath

if ($AllowTestSigningIdentity) {
    $productionIdentityPresent = $trustedKeyMap.ContainsKey($productionSigningKeyId)
    foreach ($trustedKey in @($trustedKeyMap.Values)) {
        if ($productionIdentityPresent -or $null -eq $trustedKey) { continue }
        try {
            $computedFingerprint = & $publicKeyFingerprintCommand -PublicKeyXml ([string]$trustedKey.publicKeyXml)
            if ([string]::Equals([string]$computedFingerprint, $productionSigningFingerprint, [System.StringComparison]::OrdinalIgnoreCase)) {
                $productionIdentityPresent = $true
            }
        }
        catch {
            # Signature verification below remains authoritative for malformed
            # test keys. This branch only prevents the production key from ever
            # entering the test-only external-dependency path.
        }
    }
    if ($productionIdentityPresent) {
        throw 'AllowTestSigningIdentity cannot be used with the production signing identity.'
    }
}

$publishedSurfaceEvidence = [pscustomobject][ordered]@{
    required = [bool]$publishedSurfaceRequired
    mode = if ($RequirePublishedSurface) { 'required-explicit' } elseif ($canonicalPublishedSurface -and -not $SkipPublishedSurface) { 'required-canonical-production' } elseif ($SkipPublishedSurface) { 'skipped-internal-baseline-repair' } else { 'not-required' }
    success = $true
    managedFiles = @()
    unexpectedCommandFiles = @()
    trustedKeys = $null
}
if ($publishedSurfaceRequired) {
    $repoNasRoot = Join-Path $RepoRoot 'installer\nas'
    $expectedPublishedFiles = [Collections.Generic.List[object]]::new()
    $stableLauncherBytes = Get-RevAgentPublishedStableLauncherBytes -PublishedReleaseRoot $ReleaseRoot
    foreach ($launcherName in @('revAgent Updater STABLE.cmd', 'Revit MCP Updater STABLE.cmd')) {
        $expectedPublishedFiles.Add([pscustomobject]@{
                relativePath = (Join-Path 'tools' $launcherName)
                expectedBytes = $stableLauncherBytes
                source = 'stable-launcher-template'
            }) | Out-Null
    }
    foreach ($toolName in @('Refresh-revAgent-LocalBootstrap-STABLE.cmd', 'Refresh-revAgent-LocalBootstrap-STABLE.ps1')) {
        $sourcePath = Join-Path $repoNasRoot $toolName
        $expectedPublishedFiles.Add([pscustomobject]@{
                relativePath = (Join-Path 'tools' $toolName)
                expectedBytes = [IO.File]::ReadAllBytes($sourcePath)
                source = $sourcePath
            }) | Out-Null
    }
    $publishedTrustedKeysRelativePath = 'tools\config\release-trusted-keys.json'
    $expectedPublishedFiles.Add([pscustomobject]@{
            relativePath = $publishedTrustedKeysRelativePath
            expectedBytes = [IO.File]::ReadAllBytes($TrustedKeysPath)
            source = $TrustedKeysPath
        }) | Out-Null
    $legacyLauncherNames = @(
        'Install-revAgent-Updater-GUI.cmd',
        'Install-Revit-MCP-Updater-GUI.cmd',
        'Install-revAgent-Updater.cmd',
        'Install-Revit-MCP-Updater.cmd'
    )
    foreach ($legacyLauncherName in $legacyLauncherNames) {
        $sourcePath = Join-Path $repoNasRoot $legacyLauncherName
        $sourceBytes = [IO.File]::ReadAllBytes($sourcePath)
        foreach ($relativePath in @((Join-Path 'tools' $legacyLauncherName), $legacyLauncherName)) {
            $expectedPublishedFiles.Add([pscustomobject]@{
                    relativePath = $relativePath
                    expectedBytes = $sourceBytes
                    source = $sourcePath
                }) | Out-Null
        }
    }

    $managedFileEvidence = [Collections.Generic.List[object]]::new()
    $managedLeafReads = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($expectedFile in $expectedPublishedFiles.ToArray()) {
        $relativePath = [string]$expectedFile.relativePath
        $publishedPath = [IO.Path]::GetFullPath((Join-Path $ReleaseRoot $relativePath))
        $expectedSha256 = Get-RevAgentBytesSha256 -Bytes ([byte[]]$expectedFile.expectedBytes)
        $leafRead = Read-RevAgentManagedPublishedLeaf -ReleaseRoot $ReleaseRoot -RelativePath $relativePath -MaxBytes $managedPublishedLeafMaxBytes
        $managedLeafReads[$relativePath] = $leafRead
        $present = [bool]$leafRead.present
        $pathSafe = [bool]$leafRead.safe
        $actualSha256 = [string]$leafRead.sha256
        $hashMatches = $pathSafe -and [string]::Equals($actualSha256, $expectedSha256, [StringComparison]::OrdinalIgnoreCase)
        $checkSlug = (($relativePath -replace '[^A-Za-z0-9]+', '_').Trim('_')).ToLowerInvariant()
        Add-RevAgentReadinessCheck -Checks $checks -Name ("published_surface_{0}_present" -f $checkSlug) -Success $present -Reason $(if ($present) { '' } else { 'published_surface_file_missing' }) -Message "Exact managed published-surface file must exist." -Path $publishedPath
        Add-RevAgentReadinessCheck -Checks $checks -Name ("published_surface_{0}_safe_leaf" -f $checkSlug) -Success $pathSafe -Reason $(if ($pathSafe) { '' } else { [string]$leafRead.reason }) -Message "Exact managed published-surface file must be a bounded ordinary single-link leaf reached through a no-reparse held-handle path." -Path $publishedPath
        Add-RevAgentReadinessCheck -Checks $checks -Name ("published_surface_{0}_sha256" -f $checkSlug) -Success $hashMatches -Reason $(if ($hashMatches) { '' } elseif (-not $pathSafe) { [string]$leafRead.reason } elseif ($present) { 'published_surface_hash_mismatch' } else { 'published_surface_file_missing' }) -Message "Exact managed published-surface file must match its verified publisher source." -Path $publishedPath
        $managedFileEvidence.Add([pscustomobject][ordered]@{
                relativePath = $relativePath
                path = $publishedPath
                source = [string]$expectedFile.source
                present = [bool]$present
                safe = [bool]$pathSafe
                reason = [string]$leafRead.reason
                error = [string]$leafRead.error
                identity = [string]$leafRead.identity
                linkCount = [uint32]$leafRead.linkCount
                length = [long]$leafRead.length
                maxBytes = [long]$leafRead.maxBytes
                expectedSha256 = $expectedSha256
                actualSha256 = $actualSha256
                sha256Matches = [bool]$hashMatches
            }) | Out-Null
    }

    $releaseRootPrefix = $ReleaseRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $actualCommandRelativePaths = [Collections.Generic.List[string]]::new()
    foreach ($commandFile in @(Get-ChildItem -LiteralPath $ReleaseRoot -File -Filter '*.cmd' -ErrorAction SilentlyContinue)) {
        $actualCommandRelativePaths.Add($commandFile.FullName.Substring($releaseRootPrefix.Length)) | Out-Null
    }
    $publishedToolsRoot = Join-Path $ReleaseRoot 'tools'
    if (Test-Path -LiteralPath $publishedToolsRoot -PathType Container) {
        foreach ($commandFile in @(Get-ChildItem -LiteralPath $publishedToolsRoot -Recurse -File -Filter '*.cmd' -ErrorAction SilentlyContinue)) {
            $actualCommandRelativePaths.Add($commandFile.FullName.Substring($releaseRootPrefix.Length)) | Out-Null
        }
    }
    $expectedCommandRelativePaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($expectedFile in $expectedPublishedFiles.ToArray()) {
        if ([string]::Equals([IO.Path]::GetExtension([string]$expectedFile.relativePath), '.cmd', [StringComparison]::OrdinalIgnoreCase)) {
            [void]$expectedCommandRelativePaths.Add([string]$expectedFile.relativePath)
        }
    }
    $unexpectedCommandFiles = @($actualCommandRelativePaths.ToArray() | Where-Object { -not $expectedCommandRelativePaths.Contains([string]$_) } | Sort-Object -Unique)
    Add-RevAgentReadinessCheck -Checks $checks -Name 'published_surface_no_unmanaged_cmd_entry_points' -Success ($unexpectedCommandFiles.Count -eq 0) -Reason $(if ($unexpectedCommandFiles.Count -eq 0) { '' } else { 'unmanaged_cmd_entry_point' }) -Message 'Published stable surface may expose only the exact managed CMD entry-point list.' -Path $ReleaseRoot

    $publishedTrustedKeysEvidence = @($managedFileEvidence.ToArray() | Where-Object { [string]::Equals([string]$_.relativePath, $publishedTrustedKeysRelativePath, [StringComparison]::OrdinalIgnoreCase) })[0]
    $publishedKeyIdentityOk = $false
    $publishedKeyIdentityError = ''
    if ($null -ne $publishedTrustedKeysEvidence -and [bool]$publishedTrustedKeysEvidence.safe) {
        try {
            $publishedTrustedKeysRead = $managedLeafReads[$publishedTrustedKeysRelativePath]
            $publishedKeyDocument = ConvertFrom-RevAgentJsonBytes -Bytes ([byte[]]$publishedTrustedKeysRead.bytes)
            $publishedKeyProperty = $publishedKeyDocument.PSObject.Properties['trustedKeys']
            $publishedKeyValues = if ($publishedKeyProperty) { $publishedKeyProperty.Value } else { $publishedKeyDocument }
            $publishedKeyMap = ConvertTo-RevAgentTrustedKeyMap -TrustedKeys $publishedKeyValues
            if ($AllowTestSigningIdentity) {
                $publishedKeyIdentityOk = [bool]$publishedTrustedKeysEvidence.sha256Matches -and $publishedKeyMap.Count -eq $trustedKeyMap.Count -and $publishedKeyMap.Count -gt 0
            }
            else {
                $publishedProperties = @($publishedKeyDocument.trustedKeys.PSObject.Properties)
                if ($publishedProperties.Count -eq 1 -and [string]::Equals([string]$publishedProperties[0].Name, $productionSigningKeyId, [StringComparison]::Ordinal)) {
                    $publishedKey = $publishedProperties[0].Value
                    $computedFingerprint = & $publicKeyFingerprintCommand -PublicKeyXml ([string]$publishedKey.publicKeyXml)
                    $publishedKeyIdentityOk = [string]::Equals([string]$publishedKey.algorithm, 'RS256', [StringComparison]::Ordinal) -and
                        [string]::Equals([string]$publishedKey.publicKeyFingerprint, $productionSigningFingerprint, [StringComparison]::OrdinalIgnoreCase) -and
                        [string]::Equals([string]$computedFingerprint, $productionSigningFingerprint, [StringComparison]::OrdinalIgnoreCase)
                }
            }
        }
        catch { $publishedKeyIdentityError = $_.Exception.Message }
    }
    Add-RevAgentReadinessCheck -Checks $checks -Name 'published_surface_trusted_key_identity' -Success $publishedKeyIdentityOk -Reason $(if ($publishedKeyIdentityOk) { '' } else { 'published_trusted_key_identity_invalid' }) -Message $(if ($AllowTestSigningIdentity) { 'Published test trusted keys must exactly match the verified disposable fixture document.' } else { "Published trusted keys must contain exactly the pinned '$productionSigningKeyId' production identity and fingerprint." }) -Path (Join-Path $ReleaseRoot $publishedTrustedKeysRelativePath)

    $publishedSurfaceEvidence = [pscustomobject][ordered]@{
        required = $true
        success = $false
        managedFiles = @($managedFileEvidence.ToArray())
        unexpectedCommandFiles = @($unexpectedCommandFiles)
        trustedKeys = [pscustomobject][ordered]@{
            path = Join-Path $ReleaseRoot $publishedTrustedKeysRelativePath
            keyId = if ($AllowTestSigningIdentity) { '' } else { $productionSigningKeyId }
            fingerprint = if ($AllowTestSigningIdentity) { '' } else { $productionSigningFingerprint }
            identityValid = [bool]$publishedKeyIdentityOk
            error = $publishedKeyIdentityError
        }
    }
}

$releaseManifest = $null
if (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf) {
    $releaseManifest = Read-RevAgentJsonFile -Path $releaseManifestPath
}

$integrity = & $integrityCommand `
    -ChannelPath $ChannelManifestPath `
    -Channel $channel `
    -ReleaseManifestPath $releaseManifestPath `
    -ReleaseManifest $releaseManifest `
    -TrustedKeys $trustedKeyMap `
    -Policy "enforce" `
    -HighestAcceptedReleaseSequence $HighestAcceptedReleaseSequence `
    -AllowRollback:$AllowRollback
Add-RevAgentReadinessCheck -Checks $checks -Name "enforce_mode_signature_verification" -Success ([bool]$integrity.success) -Reason ([string]$integrity.reason) -Message ([string]$integrity.message)

$releaseSequenceOk = $false
try {
    $releaseSequenceOk = ([long]$channel.releaseSequence -gt 0 -and [long]$releaseManifest.releaseSequence -eq [long]$channel.releaseSequence)
}
catch {
    $releaseSequenceOk = $false
}
Add-RevAgentReadinessCheck -Checks $checks -Name "positive_release_sequence" -Success $releaseSequenceOk -Message "Signed stable rollout requires matching positive releaseSequence in channel and release manifest."

$packageHashOk = $false
if (Test-Path -LiteralPath $packagePath -PathType Leaf) {
    $actualHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash
    $channelHash = [string]$channel.sha256
    $manifestHash = ""
    if ($releaseManifest -and $releaseManifest.package) {
        $manifestHash = [string]$releaseManifest.package.sha256
    }
    $packageHashOk = [string]::Equals($actualHash, $channelHash, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals($actualHash, $manifestHash, [System.StringComparison]::OrdinalIgnoreCase)
}
Add-RevAgentReadinessCheck -Checks $checks -Name "package_sha256_matches_signed_metadata" -Success $packageHashOk -Message "Release ZIP SHA256 must match channel.sha256 and manifest.package.sha256." -Path $packagePath

$nodeMsiMetadata = $null
if ($null -ne $releaseManifest -and $releaseManifest.PSObject.Properties['externalDependencies']) {
    $externalDependencies = $releaseManifest.externalDependencies
    if ($null -ne $externalDependencies -and $externalDependencies.PSObject.Properties['nodeMsi']) {
        $nodeMsiMetadata = $externalDependencies.nodeMsi
    }
}
$nodeMsiMetadataPresent = $null -ne $nodeMsiMetadata
$legacyNodeMsiChannel = ([string]$channel.channel).Trim().ToLowerInvariant()
$legacyNodeMsiChannelAllowed = $legacyNodeMsiChannel -in @('stable', 'pilot')
$legacyNodeMsiCanonicalChannelPath = if ($legacyNodeMsiChannelAllowed) {
    [System.IO.Path]::GetFullPath((Join-Path $ReleaseRoot ("channels\{0}.json" -f $legacyNodeMsiChannel)))
}
else { '' }
$legacyNodeMsiActiveBaselineContext =
    [string]::Equals($ArtifactScanScope, 'activeRelease', [System.StringComparison]::Ordinal) -and
    $legacyNodeMsiChannelAllowed -and
    [string]::Equals($ChannelManifestPath, $legacyNodeMsiCanonicalChannelPath, [System.StringComparison]::OrdinalIgnoreCase)
if ($AllowLegacyMissingNodeMsi -and -not $legacyNodeMsiActiveBaselineContext) {
    throw 'AllowLegacyMissingNodeMsi is limited to an exact existing signed stable/pilot active-channel baseline.'
}
$legacyNodeMsiBaselineAccepted = $AllowLegacyMissingNodeMsi -and $legacyNodeMsiActiveBaselineContext -and -not $nodeMsiMetadataPresent
$legacyNodeReason = if ($legacyNodeMsiBaselineAccepted) { 'legacy_signed_active_channel_baseline_without_node_sidecar' } else { '' }
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_signed_metadata_present" -Success ($nodeMsiMetadataPresent -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiMetadataPresent) { "" } else { "node_msi_metadata_missing" }) -Message "New signed releases must contain externalDependencies.nodeMsi; only an exact already-active signed stable/pilot baseline may omit it during transition."

$nodeMsiSchemaOk = $false
$nodeMsiRelativePathValue = ""
$nodeMsiSha256Value = ""
$nodeMsiSizeValue = [long]0
$nodeMsiSizeParsed = $false
$nodeMsiSignerValue = ""
$nodeMsiSignedAuthenticodeStatus = ""
if ($nodeMsiMetadataPresent) {
    try { $nodeMsiSchemaOk = [int]$nodeMsiMetadata.schemaVersion -eq 1 } catch { $nodeMsiSchemaOk = $false }
    $nodeMsiRelativePathValue = [string]$nodeMsiMetadata.relativePath
    $nodeMsiSha256Value = ([string]$nodeMsiMetadata.sha256).Trim().ToUpperInvariant()
    $nodeMsiSizeParsed = [long]::TryParse([string]$nodeMsiMetadata.sizeBytes, [ref]$nodeMsiSizeValue)
    $nodeMsiSignerValue = [string]$nodeMsiMetadata.signerSubject
    $nodeMsiSignedAuthenticodeStatus = [string]$nodeMsiMetadata.authenticodeStatus
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_schema_version" -Success ($nodeMsiSchemaOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiSchemaOk) { "" } else { "node_msi_schema_invalid" }) -Message "externalDependencies.nodeMsi.schemaVersion must equal 1."

$nodeMsiRelativeSyntaxOk = $nodeMsiMetadataPresent -and
    -not [string]::IsNullOrWhiteSpace($nodeMsiRelativePathValue) -and
    -not [System.IO.Path]::IsPathRooted($nodeMsiRelativePathValue) -and
    $nodeMsiRelativePathValue.IndexOf(':') -lt 0 -and
    $nodeMsiRelativePathValue -notmatch '(^|[\\/])\.\.?([\\/]|$)' -and
    [string]::Equals($nodeMsiRelativePathValue, $nodeMsiRelativePath, [System.StringComparison]::Ordinal)
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_relative_path" -Success ($nodeMsiRelativeSyntaxOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiRelativeSyntaxOk) { "" } else { "node_msi_relative_path_invalid" }) -Message "Node.js MSI relativePath must be the exact release-owned relative path '$nodeMsiRelativePath'."

$nodeMsiShaMetadataOk = if ($AllowTestSigningIdentity) {
    $nodeMsiSha256Value -match '^[A-F0-9]{64}$'
}
else {
    [string]::Equals($nodeMsiSha256Value, $nodeMsiSha256, [System.StringComparison]::Ordinal)
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_sha256_metadata" -Success ($nodeMsiShaMetadataOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiShaMetadataOk) { "" } else { "node_msi_sha256_metadata_invalid" }) -Message $(if ($AllowTestSigningIdentity) { "Test Node.js MSI metadata must contain one SHA-256 value." } else { "Production Node.js MSI metadata must contain the pinned SHA-256." })

$nodeMsiSizeMetadataOk = if ($AllowTestSigningIdentity) {
    $nodeMsiSizeParsed -and $nodeMsiSizeValue -gt 0 -and $nodeMsiSizeValue -le 268435456
}
else {
    $nodeMsiSizeParsed -and $nodeMsiSizeValue -eq $nodeMsiSizeBytes
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_size_metadata" -Success ($nodeMsiSizeMetadataOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiSizeMetadataOk) { "" } else { "node_msi_size_metadata_invalid" }) -Message $(if ($AllowTestSigningIdentity) { "Test Node.js MSI metadata must contain one bounded positive size." } else { "Production Node.js MSI metadata must contain the pinned sizeBytes value." })

$nodeMsiSignerMetadataOk = if ($AllowTestSigningIdentity) {
    -not [string]::IsNullOrWhiteSpace($nodeMsiSignerValue)
}
else {
    [string]::Equals($nodeMsiSignerValue, $nodeMsiSignerSubject, [System.StringComparison]::Ordinal)
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_signer_metadata" -Success ($nodeMsiSignerMetadataOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiSignerMetadataOk) { "" } else { "node_msi_signer_metadata_invalid" }) -Message $(if ($AllowTestSigningIdentity) { "Test Node.js MSI metadata must identify its fixture signer." } else { "Production Node.js MSI metadata must identify the pinned OpenJS signer subject." })

$nodeMsiAuthenticodeMetadataOk = if ($AllowTestSigningIdentity) {
    [string]::Equals($nodeMsiSignedAuthenticodeStatus, 'TestBypass', [System.StringComparison]::Ordinal)
}
else {
    [string]::Equals($nodeMsiSignedAuthenticodeStatus, 'Valid', [System.StringComparison]::Ordinal)
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_authenticode_metadata" -Success ($nodeMsiAuthenticodeMetadataOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiAuthenticodeMetadataOk) { "" } else { "node_msi_authenticode_metadata_invalid" }) -Message $(if ($AllowTestSigningIdentity) { "Test Node.js MSI metadata must explicitly state TestBypass." } else { "Production Node.js MSI metadata must explicitly state Valid Authenticode status." })

$releaseDirectory = if ([string]::IsNullOrWhiteSpace($releaseManifestPath)) { "" } else { [System.IO.Path]::GetFullPath((Split-Path -Parent $releaseManifestPath)) }
$releaseVersion = [string]$channel.version
$expectedReleaseDirectory = ""
$releaseDirectoryOk = $false
if (-not [string]::IsNullOrWhiteSpace($releaseVersion) -and
    $releaseVersion.IndexOfAny([char[]]@('\', '/', ':')) -lt 0) {
    try {
        $expectedReleaseDirectory = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $ReleaseRoot 'releases') $releaseVersion))
        $releaseDirectoryOk = -not [string]::IsNullOrWhiteSpace($releaseDirectory) -and
            (Test-RevAgentPathUnderRoot -Path $releaseDirectory -Root $ReleaseRoot) -and
            [string]::Equals($releaseDirectory, $expectedReleaseDirectory, [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch { $releaseDirectoryOk = $false }
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_release_directory" -Success $releaseDirectoryOk -Reason $(if ($releaseDirectoryOk) { "" } else { "node_msi_release_directory_invalid" }) -Message "The signed manifest and Node.js MSI must be rooted in the exact versioned release directory." -Path $releaseDirectory

$nodeMsiPath = ""
$nodeMsiPathOk = $false
if ($releaseDirectoryOk -and $nodeMsiRelativeSyntaxOk) {
    try {
        $nodeMsiPath = [System.IO.Path]::GetFullPath((Join-Path $releaseDirectory $nodeMsiRelativePathValue))
        $expectedNodeMsiPath = [System.IO.Path]::GetFullPath((Join-Path $expectedReleaseDirectory $nodeMsiRelativePath))
        $nodeMsiPathOk = (Test-RevAgentPathUnderRoot -Path $nodeMsiPath -Root $releaseDirectory) -and
            [string]::Equals($nodeMsiPath, $expectedNodeMsiPath, [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch { $nodeMsiPathOk = $false }
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_release_path_binding" -Success ($nodeMsiPathOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiPathOk) { "" } else { "node_msi_release_path_binding_invalid" }) -Message "Node.js MSI metadata must resolve to the exact release-owned dependency path." -Path $nodeMsiPath

$nodeMsiFilePresent = $nodeMsiPathOk -and (Test-Path -LiteralPath $nodeMsiPath -PathType Leaf)
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_file_present" -Success ($nodeMsiFilePresent -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiFilePresent) { "" } else { "node_msi_file_missing" }) -Message "The signed Node.js MSI dependency must exist for every new release." -Path $nodeMsiPath

$nodeMsiActualSize = [long]0
$nodeMsiActualSha256 = ""
$nodeMsiActualSizeOk = $false
$nodeMsiActualSha256Ok = $false
$nodeMsiAuthenticodeStatus = "NotChecked"
$nodeMsiActualSignerSubject = ""
$nodeMsiAuthenticodeOk = $false
$nodeMsiAuthenticodeSignerOk = $false
if ($nodeMsiFilePresent) {
    try {
        $nodeMsiActualSize = [long](Get-Item -LiteralPath $nodeMsiPath -Force -ErrorAction Stop).Length
        $nodeMsiActualSizeOk = $nodeMsiSizeMetadataOk -and $nodeMsiActualSize -eq $nodeMsiSizeValue
        $nodeMsiActualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodeMsiPath -ErrorAction Stop).Hash.ToUpperInvariant()
        $nodeMsiActualSha256Ok = $nodeMsiShaMetadataOk -and [string]::Equals($nodeMsiActualSha256, $nodeMsiSha256Value, [System.StringComparison]::Ordinal)
        if ($AllowTestSigningIdentity) {
            $nodeMsiAuthenticodeStatus = "TestBypass"
            $nodeMsiActualSignerSubject = $nodeMsiSignerValue
            $nodeMsiAuthenticodeOk = $true
            $nodeMsiAuthenticodeSignerOk = $nodeMsiSignerMetadataOk
        }
        else {
            $nodeMsiSignature = Get-AuthenticodeSignature -LiteralPath $nodeMsiPath
            $nodeMsiAuthenticodeStatus = if ($null -eq $nodeMsiSignature) { "Unavailable" } else { [string]$nodeMsiSignature.Status }
            $nodeMsiActualSignerSubject = if ($null -eq $nodeMsiSignature -or $null -eq $nodeMsiSignature.SignerCertificate) { "" } else { [string]$nodeMsiSignature.SignerCertificate.Subject }
            $nodeMsiAuthenticodeOk = $null -ne $nodeMsiSignature -and $nodeMsiSignature.Status -eq [System.Management.Automation.SignatureStatus]::Valid
            $nodeMsiAuthenticodeSignerOk = $nodeMsiAuthenticodeOk -and [string]::Equals($nodeMsiActualSignerSubject, $nodeMsiSignerSubject, [System.StringComparison]::Ordinal)
        }
    }
    catch {
        $nodeMsiAuthenticodeStatus = "ReadFailed"
    }
}
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_size_matches_signed_metadata" -Success ($nodeMsiActualSizeOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiActualSizeOk) { "" } else { "node_msi_size_mismatch" }) -Message "Node.js MSI size must match the signed manifest metadata." -Path $nodeMsiPath
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_sha256_matches_signed_metadata" -Success ($nodeMsiActualSha256Ok -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiActualSha256Ok) { "" } else { "node_msi_sha256_mismatch" }) -Message "Node.js MSI SHA-256 must match the signed manifest metadata." -Path $nodeMsiPath
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_authenticode_valid" -Success ($nodeMsiAuthenticodeOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiAuthenticodeOk) { $(if ($AllowTestSigningIdentity) { "test_signing_identity_bypass" } else { "" }) } else { "node_msi_authenticode_invalid" }) -Message $(if ($AllowTestSigningIdentity) { "Authenticode verification is bypassed only for a disposable TEMP test-signing fixture." } else { "Production Node.js MSI must have a valid Authenticode signature." }) -Path $nodeMsiPath
Add-RevAgentReadinessCheck -Checks $checks -Name "node_msi_authenticode_signer" -Success ($nodeMsiAuthenticodeSignerOk -or $legacyNodeMsiBaselineAccepted) -Reason $(if ($legacyNodeMsiBaselineAccepted) { $legacyNodeReason } elseif ($nodeMsiAuthenticodeSignerOk) { $(if ($AllowTestSigningIdentity) { "test_signing_identity_bypass" } else { "" }) } else { "node_msi_authenticode_signer_mismatch" }) -Message $(if ($AllowTestSigningIdentity) { "Test fixture signer metadata is accepted only for a disposable TEMP test-signing fixture." } else { "Production Node.js MSI Authenticode signer must be the pinned OpenJS subject." }) -Path $nodeMsiPath

$nodeMsiReadiness = [pscustomobject][ordered]@{
    testSigningIdentity = [bool]$AllowTestSigningIdentity
    legacyBaselineAccepted = [bool]$legacyNodeMsiBaselineAccepted
    relativePath = $nodeMsiRelativePathValue
    path = $nodeMsiPath
    signedSha256 = $nodeMsiSha256Value
    actualSha256 = $nodeMsiActualSha256
    signedSizeBytes = $nodeMsiSizeValue
    actualSizeBytes = $nodeMsiActualSize
    signedSignerSubject = $nodeMsiSignerValue
    signedAuthenticodeStatus = $nodeMsiSignedAuthenticodeStatus
    actualSignerSubject = $nodeMsiActualSignerSubject
    authenticodeStatus = $nodeMsiAuthenticodeStatus
}

$privateMaterial = @(Find-RevAgentPrivateSigningMaterial -Root $ReleaseRoot)
Add-RevAgentReadinessCheck -Checks $checks -Name "no_private_signing_material_in_release_root" -Success ($privateMaterial.Count -eq 0) -Reason $(if ($privateMaterial.Count -eq 0) { "" } else { "private_signing_material_detected" }) -Message "Release root must not contain private signing material." -Path $ReleaseRoot

$artifactScanPaths = @()
if ([string]::Equals($ArtifactScanScope, "activeRelease", [System.StringComparison]::OrdinalIgnoreCase)) {
    if (-not [string]::IsNullOrWhiteSpace($releaseManifestPath) -and (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf)) {
        $artifactScanPaths += (Split-Path -Parent $releaseManifestPath)
    }
    $toolsPath = Join-Path $ReleaseRoot "tools"
    if (Test-Path -LiteralPath $toolsPath -PathType Container) {
        $artifactScanPaths += $toolsPath
    }
}
$artifactFindings = @(Find-RevAgentReleaseArtifactFindings -Root $ReleaseRoot -ScanPaths $artifactScanPaths)
$artifactCheckPath = if ($artifactScanPaths.Count -gt 0) { ($artifactScanPaths -join ";") } else { $ReleaseRoot }
Add-RevAgentReadinessCheck -Checks $checks -Name "no_source_or_developer_artifacts_in_release_root" -Success ($artifactFindings.Count -eq 0) -Reason $(if ($artifactFindings.Count -eq 0) { "" } else { "source_or_developer_artifacts_detected" }) -Message "Release root and release ZIP must not contain source, source maps, debug symbols, developer manifests, private key names, or license secret names." -Path $artifactCheckPath

$failedChecks = @($checks.ToArray() | Where-Object { -not [bool]$_.success })
$publishedSurfaceFailures = @($failedChecks | Where-Object { [string]$_.name -like 'published_surface_*' })
$publishedSurfaceEvidence.success = (-not [bool]$publishedSurfaceRequired) -or $publishedSurfaceFailures.Count -eq 0
$ready = $failedChecks.Count -eq 0
$report = [pscustomobject][ordered]@{
    success = $ready
    readyForEnforce = $ready
    reason = if ($ready) { "ready" } else { "readiness_checks_failed" }
    releaseRoot = $ReleaseRoot
    channelManifestPath = $ChannelManifestPath
    releaseManifestPath = $releaseManifestPath
    packagePath = $packagePath
    trustedKeysPath = $TrustedKeysPath
    trustedKeyCount = $trustedKeyMap.Count
    releaseSequence = if ($channel.PSObject.Properties["releaseSequence"]) { [long]$channel.releaseSequence } else { 0 }
    minimumAcceptedReleaseSequence = if ($channel.PSObject.Properties["minimumAcceptedReleaseSequence"]) { [long]$channel.minimumAcceptedReleaseSequence } else { 0 }
    integrity = $integrity
    nodeMsi = $nodeMsiReadiness
    privateMaterialFindings = $privateMaterial
    artifactScanScope = $ArtifactScanScope
    publishedSurface = $publishedSurfaceEvidence
    artifactScanPaths = @($artifactScanPaths)
    artifactFindings = $artifactFindings
    checks = @($checks.ToArray())
}

if ($OutputJson) {
    $report | ConvertTo-Json -Depth 16
}
else {
    $report
}

if (-not $ready -and -not $ReportOnly) {
    $failedNames = ($failedChecks | ForEach-Object { $_.name }) -join ", "
    throw "Signed stable readiness failed: $failedNames"
}
