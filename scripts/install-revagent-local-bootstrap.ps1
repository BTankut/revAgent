[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [Parameter(Mandatory = $true)][string]$ReleaseRoot,
    [Parameter(Mandatory = $true)][string]$TrustedKeysPath,
    [Parameter(Mandatory = $true)][string]$ExpectedHashesPath,
    [string]$BootstrapRoot = "",
    [switch]$ConfirmIndependentlyAuthenticatedSource,
    [switch]$AllowTestRoot,
    [scriptblock]$ModuleStageTestHook = $null
)

$ErrorActionPreference = "Stop"
$systemDirectory = [Environment]::SystemDirectory
$trustedModuleRoots = @((Join-Path $PSHOME "Modules"), (Join-Path $systemDirectory "WindowsPowerShell\v1.0\Modules")) | Where-Object { [IO.Directory]::Exists($_) } | Select-Object -Unique
$env:PSModulePath = [string]::Join([IO.Path]::PathSeparator, [string[]]$trustedModuleRoots)
foreach ($moduleName in @("Microsoft.PowerShell.Management", "Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Security")) {
    $manifest = Join-Path $PSHOME ("Modules\{0}\{0}.psd1" -f $moduleName)
    if (-not [IO.File]::Exists($manifest)) { throw "Required trusted PowerShell module was not found: $manifest" }
    Microsoft.PowerShell.Core\Import-Module -Name $manifest -Force -ErrorAction Stop
}

function New-RevAgentPrestageCompilerTemp {
    $windowsRoot = [IO.Directory]::GetParent([Environment]::SystemDirectory).FullName
    $windowsTemp = [IO.Path]::GetFullPath((Join-Path $windowsRoot 'Temp')).TrimEnd('\')
    if (-not [IO.Directory]::Exists($windowsTemp)) { throw "Canonical Windows Temp was not found: $windowsTemp" }
    $tempRootItem = Get-Item -LiteralPath $windowsTemp -Force
    if (($tempRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$tempRootItem.LinkType)) {
        throw "Canonical Windows Temp is a filesystem link: $windowsTemp"
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $ownerSid = if ($elevated) { [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544') } else { $identity.User }
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($ownerSid)
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $allowedSids = @('S-1-5-18', 'S-1-5-32-544')
    if (-not $elevated) { $allowedSids += [string]$identity.User.Value }
    foreach ($sid in @($allowedSids | Select-Object -Unique)) {
        [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new($sid),
                [Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    $path = Join-Path $windowsTemp ('revagent-prestage-compiler-' + [Guid]::NewGuid().ToString('N'))
    try {
        $aclCreateOverload = [IO.Directory].GetMethods() | Where-Object {
            $_.Name -eq 'CreateDirectory' -and $_.GetParameters().Count -eq 2 -and $_.GetParameters()[1].ParameterType -eq [Security.AccessControl.DirectorySecurity]
        } | Select-Object -First 1
        if ($null -ne $aclCreateOverload) {
            [void]$aclCreateOverload.Invoke($null, [object[]]@([string]$path, [Security.AccessControl.DirectorySecurity]$security))
        }
        elseif ($elevated) {
            throw 'Production prestage requires Windows PowerShell with ACL-at-create directory support.'
        }
        else {
            [void][IO.Directory]::CreateDirectory($path)
            [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo](Get-Item -LiteralPath $path -Force), $security)
        }
        $item = Get-Item -LiteralPath $path -Force
        $acl = Get-Acl -LiteralPath $path
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not $acl.AreAccessRulesProtected -or
            -not [string]::Equals([string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value, [string]$ownerSid.Value, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Secure prestage compiler TEMP attestation failed: $path"
        }
        return $path
    }
    catch {
        if ([IO.Directory]::Exists($path)) { [IO.Directory]::Delete($path, $true) }
        throw
    }
}

$prestageOriginalTemp = $env:TEMP
$prestageOriginalTmp = $env:TMP
$prestageCompilerTemp = New-RevAgentPrestageCompilerTemp
try {
$env:TEMP = $prestageCompilerTemp
$env:TMP = $prestageCompilerTemp
if (-not ("RevAgent.PrestageNativeFileInfo" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent
{
public static class PrestageNativeFileInfo
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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out BY_HANDLE_FILE_INFORMATION information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint GENERIC_READ = 0x80000000;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;

    private static BY_HANDLE_FILE_INFORMATION Read(SafeFileHandle handle)
    {
        if (handle == null || handle.IsInvalid) throw new ArgumentException("A valid file handle is required.", "handle");
        BY_HANDLE_FILE_INFORMATION information;
        if (!GetFileInformationByHandle(handle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return information;
    }

    public static uint GetLinkCount(SafeFileHandle handle)
    {
        return Read(handle).NumberOfLinks;
    }

    public static uint GetAttributes(SafeFileHandle handle) { return Read(handle).FileAttributes; }

    public static SafeFileHandle OpenDirectoryNoDeleteShare(string path)
    {
        SafeFileHandle handle = CreateFileW(
            path,
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            IntPtr.Zero);
        if (handle == null || handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            if (handle != null) handle.Dispose();
            throw new Win32Exception(error, "Could not open the exact directory without FILE_SHARE_DELETE: " + path);
        }
        return handle;
    }

    public static string GetIdentity(SafeFileHandle handle)
    {
        BY_HANDLE_FILE_INFORMATION information = Read(handle);
        return String.Format("{0:X8}:{1:X8}{2:X8}", information.VolumeSerialNumber, information.FileIndexHigh, information.FileIndexLow);
    }
}
}
'@
}
}
finally {
    $env:TEMP = $prestageOriginalTemp
    $env:TMP = $prestageOriginalTmp
    if ([IO.Directory]::Exists($prestageCompilerTemp)) { [IO.Directory]::Delete($prestageCompilerTemp, $true) }
}

function Assert-RevAgentPrestagePathNoLinks {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$RequireLeaf)

    $fullPath = [IO.Path]::GetFullPath($Path)
    $cursor = $fullPath
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            $linkType = if ($item.PSObject.Properties["LinkType"]) { [string]$item.LinkType } else { "" }
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) {
                throw "Authenticated prestage path contains a filesystem link/reparse component: $cursor"
            }
        }
        $parentPath = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parentPath) -or $parentPath -eq $cursor) { break }
        $cursor = $parentPath
    }
    if ($RequireLeaf -and -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Required authenticated prestage file was not found: $fullPath"
    }
    return $fullPath
}

function Test-RevAgentTrustedPrestageOwnerSid {
    param([string]$Sid)
    return $Sid -in @(
        "S-1-5-18",
        "S-1-5-32-544",
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
    )
}

function Test-RevAgentBootstrapRightsAllowMutation {
    param([Parameter(Mandatory = $true)][Security.AccessControl.FileSystemRights]$Rights)

    # Keep this mask to atomic mutation rights. Modify and FullControl also
    # contain read/execute/synchronize bits and would reject a safe read-only
    # evidence ACE. Their actual mutation capabilities remain covered below.
    $leafDangerMask = [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    return (([int64]$Rights -band [int64]$leafDangerMask) -ne 0)
}

function Assert-RevAgentExpectedEvidenceAclChain {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = Assert-RevAgentPrestagePathNoLinks -Path $Path -RequireLeaf
    $leaf = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    $leafAcl = Get-Acl -LiteralPath $leaf.FullName -ErrorAction Stop
    $leafOwner = [string]$leafAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (-not (Test-RevAgentTrustedPrestageOwnerSid -Sid $leafOwner)) {
        throw "Authenticated hash evidence must be owned by SYSTEM, Administrators, or TrustedInstaller: $fullPath"
    }
    foreach ($rule in $leafAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        $sid = [string]$rule.IdentityReference.Value
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            -not (Test-RevAgentTrustedPrestageOwnerSid -Sid $sid) -and
            (Test-RevAgentBootstrapRightsAllowMutation -Rights $rule.FileSystemRights)) {
            throw "Authenticated hash evidence grants write/delete-capable access to an untrusted principal. path=$fullPath principal=$sid rights=$($rule.FileSystemRights)"
        }
    }

    $directoryDangerMask = [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    $cursor = Split-Path -Parent $fullPath
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        $directoryAcl = Get-Acl -LiteralPath $cursor -ErrorAction Stop
        $ownerSid = [string]$directoryAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if (-not (Test-RevAgentTrustedPrestageOwnerSid -Sid $ownerSid)) {
            throw "Authenticated hash evidence ancestor has an untrusted owner. path=$cursor owner=$ownerSid"
        }
        foreach ($rule in $directoryAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            $sid = [string]$rule.IdentityReference.Value
            $inheritOnly = (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)
            if (-not $inheritOnly -and
                $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                -not (Test-RevAgentTrustedPrestageOwnerSid -Sid $sid) -and
                (($rule.FileSystemRights -band $directoryDangerMask) -ne 0)) {
                throw "Authenticated hash evidence ancestor grants delete/ACL-capable access to an untrusted principal. path=$cursor principal=$sid rights=$($rule.FileSystemRights)"
            }
        }
        $parentPath = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parentPath) -or $parentPath -eq $cursor) { break }
        $cursor = $parentPath
    }
}

function Get-RevAgentSha256Hex {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "") }
    finally { $algorithm.Dispose() }
}

function Read-RevAgentPrestageBoundedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [long]$MaxBytes = 33554432
    )

    if ($MaxBytes -lt 1 -or $MaxBytes -gt [int]::MaxValue) { throw "Invalid authenticated prestage byte bound: $MaxBytes" }
    $fullPath = Assert-RevAgentPrestagePathNoLinks -Path $Path -RequireLeaf
    $stream = $null
    try {
        $stream = [IO.FileStream]::new($fullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $linkCount = [uint32][RevAgent.PrestageNativeFileInfo]::GetLinkCount($stream.SafeFileHandle)
        if ($linkCount -ne 1) { throw "Authenticated prestage input must have exactly one hardlink reference. path=$fullPath linkCount=$linkCount" }
        $identity = [RevAgent.PrestageNativeFileInfo]::GetIdentity($stream.SafeFileHandle)
        [void](Assert-RevAgentPrestagePathNoLinks -Path $fullPath -RequireLeaf)
        if ($stream.Length -le 0 -or $stream.Length -gt $MaxBytes) {
            throw "Authenticated prestage input size is outside the bounded 1..$MaxBytes byte policy. path=$fullPath size=$($stream.Length)"
        }
        $bytes = New-Object byte[] ([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { throw "Authenticated prestage input ended before its declared length: $fullPath" }
            $offset += $read
        }
        if ($stream.ReadByte() -ne -1) { throw "Authenticated prestage input grew while it was being read: $fullPath" }
        return [pscustomobject]@{
            Path = $fullPath
            Bytes = $bytes
            Sha256 = Get-RevAgentSha256Hex -Bytes $bytes
            Identity = $identity
            Length = $bytes.Length
        }
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Assert-RevAgentPrestageFileUnchanged {
    param(
        [Parameter(Mandatory = $true)][object]$Evidence,
        [long]$MaxBytes = 33554432
    )
    $current = Read-RevAgentPrestageBoundedFile -Path ([string]$Evidence.Path) -MaxBytes $MaxBytes
    if (-not [string]::Equals([string]$current.Identity, [string]$Evidence.Identity, [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$current.Sha256, [string]$Evidence.Sha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Authenticated prestage input changed identity or content after verification: $($Evidence.Path)"
    }
}

function New-RevAgentPrestageAdminDirectorySecurity {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"))
    foreach ($sid in @("S-1-5-18", "S-1-5-32-544")) {
        [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new($sid),
                [Security.AccessControl.FileSystemRights]::FullControl,
                ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    return $acl
}

function Assert-RevAgentPrestageAdminDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    [void](Assert-RevAgentPrestagePathNoLinks -Path $Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw "bootstrap_parent_not_protected: prestage path is not a directory: $Path" }
    $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    $ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -notin @("S-1-5-18", "S-1-5-32-544") -or -not $acl.AreAccessRulesProtected) {
        throw "bootstrap_parent_not_protected: prestage directory owner/DACL is not protected: $($item.FullName)"
    }
    # Use atomic mutation bits. Modify/FullControl are aggregate values that
    # also contain read/execute bits and would misclassify an intentional
    # BUILTIN\Users ReadAndExecute grant as writable.
    $writeMask = [Security.AccessControl.FileSystemRights]::Write -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        $sid = [string]$rule.IdentityReference.Value
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $sid -notin @("S-1-5-18", "S-1-5-32-544") -and (($rule.FileSystemRights -band $writeMask) -ne 0)) {
            throw "bootstrap_parent_not_protected: prestage directory is writable by a non-administrator principal. path=$($item.FullName) principal=$sid"
        }
    }
}

function Assert-RevAgentPrestageSharedAncestorSafe {
    param([Parameter(Mandatory = $true)][string]$Path)

    [void](Assert-RevAgentPrestagePathNoLinks -Path $Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw "bootstrap_parent_not_protected: shared prestage ancestor is not a directory: $Path" }
    $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    $ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -notin @("S-1-5-18", "S-1-5-32-544")) {
        throw "bootstrap_parent_not_protected: shared prestage ancestor must be owned by SYSTEM or Administrators: $($item.FullName)"
    }

    # DPE is a shared product ancestor and can intentionally inherit/create
    # access. It must not delegate deletion/rename of an existing child or
    # ownership/DACL changes to a non-administrator principal.
    $dangerousMask = [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        $sid = [string]$rule.IdentityReference.Value
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            $sid -notin @("S-1-5-18", "S-1-5-32-544") -and
            (($rule.FileSystemRights -band $dangerousMask) -ne 0)) {
            throw "bootstrap_parent_not_protected: shared prestage ancestor grants delete/ACL/owner capability to a non-administrator principal. path=$($item.FullName) principal=$sid rights=$($rule.FileSystemRights)"
        }
    }
}

function Get-RevAgentPrestageParent {
    param([Parameter(Mandatory = $true)][string]$BootstrapPath, [switch]$TestRoot)
    [void](Assert-RevAgentPrestagePathNoLinks -Path $BootstrapPath)
    $parentPath = Split-Path -Parent ([IO.Path]::GetFullPath($BootstrapPath).TrimEnd("\"))
    if ($TestRoot) {
        [void](Assert-RevAgentPrestagePathNoLinks -Path $parentPath)
        New-Item -ItemType Directory -Path $parentPath -Force | Out-Null
        [void](Assert-RevAgentPrestagePathNoLinks -Path $parentPath)
        return $parentPath
    }

    $commonApplicationData = [IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)).TrimEnd("\")
    $cursor = $commonApplicationData
    [void](Assert-RevAgentPrestagePathNoLinks -Path $cursor)
    foreach ($name in @("DPE", "revAgent")) {
        $candidate = Join-Path $cursor $name
        [void](Assert-RevAgentPrestagePathNoLinks -Path $candidate)
        if (-not (Test-Path -LiteralPath $candidate)) {
            if ([string]::Equals($name, "DPE", [StringComparison]::Ordinal)) {
                throw "bootstrap_shared_ancestor_not_prestaged: the shared DPE ancestor must be created by the supervised elevated prestage block: $candidate"
            }
            [void]([IO.DirectoryInfo]::new($cursor).CreateSubdirectory($name, (New-RevAgentPrestageAdminDirectorySecurity)))
        }
        if ([string]::Equals($name, "DPE", [StringComparison]::Ordinal)) {
            Assert-RevAgentPrestageSharedAncestorSafe -Path $candidate
        }
        else {
            Assert-RevAgentPrestageAdminDirectory -Path $candidate
        }
        $cursor = $candidate
    }
    if (-not [string]::Equals([IO.Path]::GetFullPath($parentPath).TrimEnd("\"), [IO.Path]::GetFullPath($cursor).TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
        throw "bootstrap_parent_not_protected: canonical prestage parent mismatch. expected=$parentPath actual=$cursor"
    }
    return $cursor
}

function Set-RevAgentPrestageAdminFileDacl {
    param([Parameter(Mandatory = $true)][string]$Path)
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"))
    foreach ($sid in @("S-1-5-18", "S-1-5-32-544")) {
        [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new($sid),
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.AccessControlType]::Allow))
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ("System.IO.FileSystemAclExtensions" -as [type]) {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]$item, $acl)
    }
    else { ([IO.FileInfo]$item).SetAccessControl($acl) }
}

if (-not $ConfirmIndependentlyAuthenticatedSource) { throw "Administrator prestage requires -ConfirmIndependentlyAuthenticatedSource." }
if ($null -ne $ModuleStageTestHook -and -not $AllowTestRoot) { throw "ModuleStageTestHook is available only with -AllowTestRoot." }
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
if ([string]::IsNullOrWhiteSpace($BootstrapRoot)) { $BootstrapRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) "DPE\revAgent\bootstrap" }
[void](Assert-RevAgentPrestagePathNoLinks -Path $PSCommandPath -RequireLeaf)
if (-not $AllowTestRoot) {
    $canonicalPrestageInstaller = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) "DPE\revAgent\prestage\install-revagent-local-bootstrap.ps1"))
    if (-not [string]::Equals([IO.Path]::GetFullPath($PSCommandPath), $canonicalPrestageInstaller, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Administrator prestage installer must already be staged at the protected canonical path '$canonicalPrestageInstaller'. Never elevate the repo-side copy."
    }
    Assert-RevAgentExpectedEvidenceAclChain -Path $PSCommandPath
}
[void](Assert-RevAgentPrestagePathNoLinks -Path $RepoRoot)
if (-not $AllowTestRoot) { Assert-RevAgentExpectedEvidenceAclChain -Path $ExpectedHashesPath }
$expectedEvidence = Read-RevAgentPrestageBoundedFile -Path $ExpectedHashesPath -MaxBytes 65536
$strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
$expectedDocument = $strictUtf8.GetString([byte[]]$expectedEvidence.Bytes) | ConvertFrom-Json
Assert-RevAgentPrestageFileUnchanged -Evidence $expectedEvidence -MaxBytes 65536
if ([int]$expectedDocument.schemaVersion -ne 1 -or
    -not [string]::Equals([string]$expectedDocument.app, "revAgent", [StringComparison]::Ordinal) -or
    -not [string]::Equals([string]$expectedDocument.evidenceType, "bootstrap-prestage", [StringComparison]::Ordinal) -or
    -not [bool]$expectedDocument.release.signatureVerified -or
    [long]$expectedDocument.release.releaseSequence -le 0 -or
    [long]$expectedDocument.release.highestAcceptedReleaseSequence -lt [long]$expectedDocument.release.releaseSequence -or
    [long]$expectedDocument.release.minimumAcceptedReleaseSequence -gt [long]$expectedDocument.release.releaseSequence) {
    throw "Authenticated prestage evidence does not satisfy the revAgent bootstrap-prestage schema/version/signature contract."
}
$selfEvidence = Read-RevAgentPrestageBoundedFile -Path $PSCommandPath -MaxBytes 1048576
if ([string]::IsNullOrWhiteSpace([string]$expectedDocument.localBootstrapInstallerScript) -or
    -not [string]::Equals([string]$selfEvidence.Sha256, [string]$expectedDocument.localBootstrapInstallerScript, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Protected prestage installer does not match independently authenticated SHA-256 evidence."
}
Assert-RevAgentPrestageFileUnchanged -Evidence $selfEvidence -MaxBytes 1048576
$expected = [ordered]@{}
foreach ($property in $expectedDocument.sources.PSObject.Properties) { $expected[$property.Name] = [string]$property.Value }
$modulePath = Join-Path $RepoRoot "installer\lib\RevAgent.LocalBootstrap.psm1"
[void](Assert-RevAgentPrestagePathNoLinks -Path $modulePath -RequireLeaf)
$moduleEvidence = Read-RevAgentPrestageBoundedFile -Path $modulePath
if (-not [string]::Equals([string]$moduleEvidence.Sha256, [string]$expectedDocument.localBootstrapInstallerModule, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Local bootstrap installer module does not match independently authenticated SHA-256 evidence."
}
$prestageParent = Get-RevAgentPrestageParent -BootstrapPath $BootstrapRoot -TestRoot:$AllowTestRoot
$moduleStageRoot = Join-Path $prestageParent (".bootstrap-module-stage-{0}" -f [Guid]::NewGuid().ToString("N"))
$stagedModulePath = Join-Path $moduleStageRoot "RevAgent.LocalBootstrap.psm1"
try {
    if ($AllowTestRoot) { New-Item -ItemType Directory -Path $moduleStageRoot -ErrorAction Stop | Out-Null }
    else {
        [void]([IO.DirectoryInfo]::new($prestageParent).CreateSubdirectory((Split-Path -Leaf $moduleStageRoot), (New-RevAgentPrestageAdminDirectorySecurity)))
        Assert-RevAgentPrestageAdminDirectory -Path $moduleStageRoot
    }
    [void](Assert-RevAgentPrestagePathNoLinks -Path $stagedModulePath)
    $stageStream = $null
    try {
        $stageStream = [IO.File]::Open($stagedModulePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stageStream.Write([byte[]]$moduleEvidence.Bytes, 0, [int]$moduleEvidence.Length)
        $stageStream.Flush($true)
    }
    finally { if ($null -ne $stageStream) { $stageStream.Dispose() } }
    if (-not $AllowTestRoot) { Set-RevAgentPrestageAdminFileDacl -Path $stagedModulePath }
    $stagedEvidence = Read-RevAgentPrestageBoundedFile -Path $stagedModulePath
    if (-not [string]::Equals([string]$stagedEvidence.Sha256, [string]$moduleEvidence.Sha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Protected staged local-bootstrap module hash mismatch."
    }
    if ($null -ne $ModuleStageTestHook) { & $ModuleStageTestHook $modulePath }
    Assert-RevAgentPrestageFileUnchanged -Evidence $moduleEvidence
    Import-Module $stagedModulePath -Force
    Install-RevAgentLocalBootstrap `
        -BootstrapRoot $BootstrapRoot `
        -ReleaseRoot $ReleaseRoot `
        -BootstrapScriptPath (Join-Path $RepoRoot "installer\nas\Start-revAgent-Update.ps1") `
        -LauncherPath (Join-Path $RepoRoot "installer\nas\Start-revAgent-Update.cmd") `
        -GuiPath (Join-Path $RepoRoot "installer\nas\Install-revAgent-Updater-GUI.ps1") `
        -DistributionIntegrityModulePath (Join-Path $RepoRoot "installer\lib\RevAgent.DistributionIntegrity.psm1") `
        -PermissionsModulePath (Join-Path $RepoRoot "installer\lib\RevAgent.Permissions.psm1") `
        -SourceFreeMigrationModulePath (Join-Path $RepoRoot "installer\lib\RevAgent.SourceFreeMigration.psm1") `
        -ReleaseSnapshotModulePath (Join-Path $RepoRoot "installer\lib\RevAgent.ReleaseSnapshot.psm1") `
        -PrivilegedSnapshotUpdatePath (Join-Path $RepoRoot "installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1") `
        -TrustedKeysPath $TrustedKeysPath `
        -ExpectedSourceHashes $expected `
        -AuthenticatedRelease $expectedDocument.release `
        -SourceAuthenticationMethod "coordinator-admin-independent-prestage" `
        -ConfirmIndependentlyAuthenticatedSource `
        -AllowTestRoot:$AllowTestRoot
}
finally {
    if (Test-Path -LiteralPath $moduleStageRoot) { Remove-Item -LiteralPath $moduleStageRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
