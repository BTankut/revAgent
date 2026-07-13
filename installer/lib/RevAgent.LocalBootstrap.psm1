Set-StrictMode -Version Latest

function New-RevAgentLocalBootstrapCompilerTemp {
    $windowsRoot = [IO.Directory]::GetParent([Environment]::SystemDirectory).FullName
    $windowsTemp = [IO.Path]::GetFullPath((Join-Path $windowsRoot 'Temp')).TrimEnd('\')
    if (-not [IO.Directory]::Exists($windowsTemp)) { throw "Canonical Windows Temp was not found: $windowsTemp" }
    $tempRootItem = Get-Item -LiteralPath $windowsTemp -Force
    $tempRootLinkType = if ($tempRootItem.PSObject.Properties['LinkType']) { [string]$tempRootItem.LinkType } else { '' }
    if (($tempRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($tempRootLinkType)) {
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
    $path = Join-Path $windowsTemp ('revagent-bootstrap-compiler-' + [Guid]::NewGuid().ToString('N'))
    try {
        $aclCreateOverload = [IO.Directory].GetMethods() | Where-Object {
            $_.Name -eq 'CreateDirectory' -and $_.GetParameters().Count -eq 2 -and $_.GetParameters()[1].ParameterType -eq [Security.AccessControl.DirectorySecurity]
        } | Select-Object -First 1
        if ($null -ne $aclCreateOverload) {
            [void]$aclCreateOverload.Invoke($null, [object[]]@([string]$path, [Security.AccessControl.DirectorySecurity]$security))
        }
        elseif ($elevated) {
            throw 'Production local bootstrap requires Windows PowerShell with ACL-at-create directory support.'
        }
        else {
            [void][IO.Directory]::CreateDirectory($path)
            [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo](Get-Item -LiteralPath $path -Force), $security)
        }
        $item = Get-Item -LiteralPath $path -Force
        $itemLinkType = if ($item.PSObject.Properties['LinkType']) { [string]$item.LinkType } else { '' }
        $acl = Get-Acl -LiteralPath $path
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not [string]::IsNullOrWhiteSpace($itemLinkType) -or
            -not $acl.AreAccessRulesProtected -or
            -not [string]::Equals([string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value, [string]$ownerSid.Value, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Secure local-bootstrap compiler TEMP attestation failed: $path"
        }
        return $path
    }
    catch {
        if ([IO.Directory]::Exists($path)) { [IO.Directory]::Delete($path, $true) }
        throw
    }
}

$localBootstrapOriginalTemp = $env:TEMP
$localBootstrapOriginalTmp = $env:TMP
$localBootstrapCompilerTemp = New-RevAgentLocalBootstrapCompilerTemp
try {
$env:TEMP = $localBootstrapCompilerTemp
$env:TMP = $localBootstrapCompilerTemp
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
    private struct FILETIME { public uint LowDateTime; public uint HighDateTime; }

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

    public static uint GetLinkCount(SafeFileHandle handle) { return Read(handle).NumberOfLinks; }

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

function Open-RevAgentBootstrapDirectoryGuard {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $handle = $null
    try {
        $handle = [RevAgent.PrestageNativeFileInfo]::OpenDirectoryNoDeleteShare($fullPath)
        $attributes = [uint32][RevAgent.PrestageNativeFileInfo]::GetAttributes($handle)
        if (($attributes -band [uint32][IO.FileAttributes]::Directory) -eq 0 -or
            ($attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "bootstrap_parent_not_protected: guarded product path is not an ordinary directory: $fullPath"
        }
        return [pscustomobject]@{
            Path = $fullPath
            Handle = $handle
            Identity = [string][RevAgent.PrestageNativeFileInfo]::GetIdentity($handle)
        }
    }
    catch {
        if ($null -ne $handle) { $handle.Dispose() }
        throw
    }
}

function Assert-RevAgentBootstrapDirectoryGuardPath {
    param(
        [Parameter(Mandatory = $true)][object]$Guard,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not [string]::Equals([string]$Guard.Path, $fullPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "bootstrap_parent_not_protected: guarded product-root path changed. expected=$($Guard.Path) actual=$fullPath"
    }
    $pathHandle = $null
    try {
        # Guard.Handle deliberately omits FILE_SHARE_DELETE. The second open proves
        # that this pathname still resolves to the exact object whose rename/delete
        # is blocked while ACL migration is in progress.
        $pathHandle = [RevAgent.PrestageNativeFileInfo]::OpenDirectoryNoDeleteShare($fullPath)
        $attributes = [uint32][RevAgent.PrestageNativeFileInfo]::GetAttributes($pathHandle)
        if (($attributes -band [uint32][IO.FileAttributes]::Directory) -eq 0 -or
            ($attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "bootstrap_parent_not_protected: guarded product path became a link or non-directory: $fullPath"
        }
        $pathIdentity = [string][RevAgent.PrestageNativeFileInfo]::GetIdentity($pathHandle)
        if (-not [string]::Equals($pathIdentity, [string]$Guard.Identity, [StringComparison]::Ordinal)) {
            throw "bootstrap_parent_not_protected: guarded product-root identity changed. path=$fullPath expected=$($Guard.Identity) actual=$pathIdentity"
        }
        return $pathIdentity
    }
    finally { if ($null -ne $pathHandle) { $pathHandle.Dispose() } }
}
}
finally {
    $env:TEMP = $localBootstrapOriginalTemp
    $env:TMP = $localBootstrapOriginalTmp
    if ([IO.Directory]::Exists($localBootstrapCompilerTemp)) { [IO.Directory]::Delete($localBootstrapCompilerTemp, $true) }
}

function Set-RevAgentBootstrapDacl {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$SetAdministratorsOwner)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $acl = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    if ($SetAdministratorsOwner) { $acl.SetOwner([Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")) }
    foreach ($entry in @(
            [pscustomobject]@{ Sid = "S-1-5-18"; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
            [pscustomobject]@{ Sid = "S-1-5-32-544"; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
            [pscustomobject]@{ Sid = "S-1-5-32-545"; Rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute }
        )) {
        $inheritance = if ($item.PSIsContainer) {
            [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        }
        else { [Security.AccessControl.InheritanceFlags]::None }
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new([string]$entry.Sid),
            [Security.AccessControl.FileSystemRights]$entry.Rights,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow)
        [void]$acl.AddAccessRule($rule)
    }

    if ($item.PSIsContainer) {
        if ("System.IO.FileSystemAclExtensions" -as [type]) {
            [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]$item, [Security.AccessControl.DirectorySecurity]$acl)
        }
        else { ([IO.DirectoryInfo]$item).SetAccessControl([Security.AccessControl.DirectorySecurity]$acl) }
    }
    else {
        if ("System.IO.FileSystemAclExtensions" -as [type]) {
            [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]$item, [Security.AccessControl.FileSecurity]$acl)
        }
        else { ([IO.FileInfo]$item).SetAccessControl([Security.AccessControl.FileSecurity]$acl) }
    }
}

function Assert-RevAgentBootstrapLinkSafe {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$Recurse)
    $fullPath = [IO.Path]::GetFullPath($Path)
    $cursor = $fullPath
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) { throw "Bootstrap path contains a filesystem link: $cursor" }
            if (-not $item.PSIsContainer) {
                $fsutil = Join-Path ([Environment]::SystemDirectory) "fsutil.exe"
                $links = @(& $fsutil hardlink list $item.FullName 2>&1 | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
                if ($LASTEXITCODE -ne 0 -or $links.Count -ne 1) { throw "Bootstrap source must have exactly one hardlink reference: $($item.FullName)" }
            }
        }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
    if ($Recurse -and (Test-Path -LiteralPath $fullPath -PathType Container)) {
        foreach ($item in Get-ChildItem -LiteralPath $fullPath -Recurse -Force -ErrorAction Stop) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) { throw "Bootstrap tree contains a filesystem link: $($item.FullName)" }
        }
    }
}

function Get-RevAgentBootstrapSha256Hex {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "") }
    finally { $algorithm.Dispose() }
}

function Read-RevAgentBootstrapSourceEvidence {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [long]$MaxBytes = 33554432
    )

    if ($MaxBytes -lt 1 -or $MaxBytes -gt [int]::MaxValue) { throw "Invalid bootstrap source byte bound: $MaxBytes" }
    Assert-RevAgentBootstrapLinkSafe -Path $Path
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Bootstrap source was not found: $Path" }
    $fullPath = [IO.Path]::GetFullPath($Path)
    $stream = $null
    try {
        $stream = [IO.FileStream]::new($fullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $linkCount = [uint32][RevAgent.PrestageNativeFileInfo]::GetLinkCount($stream.SafeFileHandle)
        if ($linkCount -ne 1) { throw "Bootstrap source must have exactly one hardlink reference. path=$fullPath linkCount=$linkCount" }
        $identity = [RevAgent.PrestageNativeFileInfo]::GetIdentity($stream.SafeFileHandle)
        Assert-RevAgentBootstrapLinkSafe -Path $fullPath
        if ($stream.Length -le 0 -or $stream.Length -gt $MaxBytes) { throw "Bootstrap source size is outside the bounded 1..$MaxBytes byte policy. path=$fullPath size=$($stream.Length)" }
        $bytes = New-Object byte[] ([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { throw "Bootstrap source ended before its declared length: $fullPath" }
            $offset += $read
        }
        if ($stream.ReadByte() -ne -1) { throw "Bootstrap source grew while it was being read: $fullPath" }
        return [pscustomobject]@{
            Path = $fullPath
            Bytes = $bytes
            Sha256 = Get-RevAgentBootstrapSha256Hex -Bytes $bytes
            Identity = $identity
            Length = $bytes.Length
        }
    }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Assert-RevAgentBootstrapSourceUnchanged {
    param([Parameter(Mandatory = $true)][object]$Evidence)
    $current = Read-RevAgentBootstrapSourceEvidence -Path ([string]$Evidence.Path)
    if (-not [string]::Equals([string]$current.Identity, [string]$Evidence.Identity, [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$current.Sha256, [string]$Evidence.Sha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Bootstrap source changed identity or content after authenticated verification: $($Evidence.Path)"
    }
}

function Assert-RevAgentBootstrapParentProtected {
    param([Parameter(Mandatory = $true)][string]$Path)

    Assert-RevAgentBootstrapLinkSafe -Path $Path
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw "bootstrap_parent_not_protected: bootstrap parent is not a directory: $Path" }
    $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    $ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -notin @("S-1-5-18", "S-1-5-32-544")) {
        throw "bootstrap_parent_not_protected: bootstrap parent must be owned by SYSTEM or Administrators: $($item.FullName)"
    }
    if (-not $acl.AreAccessRulesProtected) {
        throw "bootstrap_parent_not_protected: bootstrap parent DACL must be protected from inheritance: $($item.FullName)"
    }

    # Do not OR aggregate Modify/FullControl values into the probe mask: those
    # aggregates also contain read/execute bits and would misclassify the
    # intentional BUILTIN\Users ReadAndExecute grant as writable. Full/Modify
    # ACEs are still caught through their atomic Write/Delete bits.
    $writeMask = [Security.AccessControl.FileSystemRights]::Write -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        $sid = [string]$rule.IdentityReference.Value
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            $sid -notin @("S-1-5-18", "S-1-5-32-544") -and
            (($rule.FileSystemRights -band $writeMask) -ne 0)) {
            throw "bootstrap_parent_not_protected: bootstrap parent grants write-capable access to a non-administrator principal. path=$($item.FullName) principal=$sid rights=$($rule.FileSystemRights)"
        }
    }
}

function Assert-RevAgentBootstrapSharedAncestorSafe {
    param([Parameter(Mandatory = $true)][string]$Path)

    Assert-RevAgentBootstrapLinkSafe -Path $Path
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw "bootstrap_parent_not_protected: shared bootstrap ancestor is not a directory: $Path" }
    $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    $ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -notin @('S-1-5-18', 'S-1-5-32-544')) {
        throw "bootstrap_parent_not_protected: shared bootstrap ancestor must be owned by SYSTEM or Administrators: $($item.FullName)"
    }

    # DPE can be shared by other products and legacy installs may intentionally
    # allow create-only access. What must never be delegated is the ability to
    # delete/rename an existing product child or change ownership/DACLs.
    $dangerousMask = [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        $sid = [string]$rule.IdentityReference.Value
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            $sid -notin @('S-1-5-18', 'S-1-5-32-544') -and
            (($rule.FileSystemRights -band $dangerousMask) -ne 0)) {
            throw "bootstrap_parent_not_protected: shared ancestor grants delete/ACL/owner capability to a non-administrator principal. path=$($item.FullName) principal=$sid rights=$($rule.FileSystemRights)"
        }
    }
    return $item.FullName
}

function Initialize-RevAgentProtectedProductRoot {
    param(
        [Parameter(Mandatory = $true)][string]$SharedParent,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $safeParent = Assert-RevAgentBootstrapSharedAncestorSafe -Path $SharedParent
    $path = [IO.Path]::GetFullPath((Join-Path $safeParent $Name)).TrimEnd('\')
    Assert-RevAgentBootstrapLinkSafe -Path $path
    $wasExisting = Test-Path -LiteralPath $path
    if (-not $wasExisting) {
        $parentInfo = [IO.DirectoryInfo](Get-Item -LiteralPath $safeParent -Force)
        $security = [Security.AccessControl.DirectorySecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        $security.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        foreach ($entry in @(
                [pscustomobject]@{ Sid = 'S-1-5-18'; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
                [pscustomobject]@{ Sid = 'S-1-5-32-544'; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
                [pscustomobject]@{ Sid = 'S-1-5-32-545'; Rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute }
            )) {
            [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                    [Security.Principal.SecurityIdentifier]::new([string]$entry.Sid),
                    [Security.AccessControl.FileSystemRights]$entry.Rights,
                    $inheritance,
                    [Security.AccessControl.PropagationFlags]::None,
                    [Security.AccessControl.AccessControlType]::Allow))
        }
        [void]$parentInfo.CreateSubdirectory($Name, $security)
    }

    $guard = $null
    try {
        # This no-FILE_SHARE_DELETE handle is the migration boundary. A legacy
        # standard-user Modify/Delete ACE cannot rename the validated directory
        # and substitute a different path target between owner validation and
        # Set-Acl. FILE_FLAG_OPEN_REPARSE_POINT also makes a raced junction visible
        # as the guarded object instead of following it.
        $guard = Open-RevAgentBootstrapDirectoryGuard -Path $path
        [void](Assert-RevAgentBootstrapDirectoryGuardPath -Guard $guard -Path $path)
        $existing = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if (-not $existing.PSIsContainer) { throw "bootstrap_parent_not_protected: product root is not a directory: $path" }
        $existingAcl = Get-Acl -LiteralPath $path -ErrorAction Stop
        $existingOwner = [string]$existingAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($existingOwner -notin @('S-1-5-18', 'S-1-5-32-544')) {
            throw "bootstrap_parent_not_protected: refusing to migrate a product root with an untrusted owner. path=$path owner=$existingOwner"
        }
        # For an existing directory this is the authenticated elevated one-time
        # migration from the legacy user-writable revAgent root. The same operation
        # reattests an ACL-at-create result so a create race cannot be mistaken for
        # a protected product root. Descendant user-state grants are recreated later
        # by the split machine/user installer.
        Set-RevAgentBootstrapDacl -Path $path -SetAdministratorsOwner

        [void](Assert-RevAgentBootstrapDirectoryGuardPath -Guard $guard -Path $path)
        Assert-RevAgentBootstrapLinkSafe -Path $path
        Assert-RevAgentBootstrapParentProtected -Path $path
        return $path
    }
    finally { if ($null -ne $guard -and $null -ne $guard.Handle) { $guard.Handle.Dispose() } }
}

function New-RevAgentProtectedBootstrapDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Name
    )

    Assert-RevAgentBootstrapLinkSafe -Path $Parent
    $parentItem = Get-Item -LiteralPath $Parent -Force -ErrorAction Stop
    if (-not $parentItem.PSIsContainer) { throw "bootstrap_parent_not_protected: protected bootstrap ancestor is not a directory: $Parent" }
    $path = Join-Path $parentItem.FullName $Name
    Assert-RevAgentBootstrapLinkSafe -Path $path
    if (-not (Test-Path -LiteralPath $path)) {
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner([Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"))
        foreach ($entry in @(
                [pscustomobject]@{ Sid = "S-1-5-18"; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
                [pscustomobject]@{ Sid = "S-1-5-32-544"; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
                [pscustomobject]@{ Sid = "S-1-5-32-545"; Rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute }
            )) {
            [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                    [Security.Principal.SecurityIdentifier]::new([string]$entry.Sid),
                    [Security.AccessControl.FileSystemRights]$entry.Rights,
                    ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
                    [Security.AccessControl.PropagationFlags]::None,
                    [Security.AccessControl.AccessControlType]::Allow))
        }
        [void]$parentItem.CreateSubdirectory($Name, $acl)
    }
    Assert-RevAgentBootstrapLinkSafe -Path $path
    Assert-RevAgentBootstrapParentProtected -Path $path
    return (Get-Item -LiteralPath $path -Force -ErrorAction Stop).FullName
}

function Install-RevAgentLocalBootstrap {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BootstrapRoot,
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [Parameter(Mandatory = $true)][string]$BootstrapScriptPath,
        [Parameter(Mandatory = $true)][string]$LauncherPath,
        [Parameter(Mandatory = $true)][string]$GuiPath,
        [Parameter(Mandatory = $true)][string]$DistributionIntegrityModulePath,
        [Parameter(Mandatory = $true)][string]$SourceFreeMigrationModulePath,
        [Parameter(Mandatory = $true)][string]$ReleaseSnapshotModulePath,
        [Parameter(Mandatory = $true)][string]$PrivilegedSnapshotUpdatePath,
        [Parameter(Mandatory = $true)][string]$TrustedKeysPath,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$ExpectedSourceHashes,
        [Parameter(Mandatory = $true)][object]$AuthenticatedRelease,
        [Parameter(Mandatory = $true)][string]$SourceAuthenticationMethod,
        [switch]$ConfirmIndependentlyAuthenticatedSource,
        [switch]$AllowTestRoot
    )

    if (-not $ConfirmIndependentlyAuthenticatedSource) {
        throw "Local bootstrap installation requires -ConfirmIndependentlyAuthenticatedSource."
    }
    if ($null -eq $AuthenticatedRelease -or
        -not [bool]$AuthenticatedRelease.signatureVerified -or
        [long]$AuthenticatedRelease.releaseSequence -le 0 -or
        [long]$AuthenticatedRelease.highestAcceptedReleaseSequence -lt [long]$AuthenticatedRelease.releaseSequence -or
        [long]$AuthenticatedRelease.minimumAcceptedReleaseSequence -gt [long]$AuthenticatedRelease.releaseSequence) {
        throw 'Local bootstrap installation requires valid independently authenticated release-sequence evidence.'
    }
    $authenticatedChannel = [string]$AuthenticatedRelease.channel
    if ($authenticatedChannel -notin @('stable', 'pilot')) { throw "Authenticated bootstrap release channel is not allowed: $authenticatedChannel" }
    $pilotPolicy = if ($AuthenticatedRelease.PSObject.Properties['pilotPolicy']) { $AuthenticatedRelease.pilotPolicy } else { $null }
    if ($authenticatedChannel -eq 'pilot') {
        if ($null -eq $pilotPolicy -or [int]$pilotPolicy.schemaVersion -ne 1) {
            throw 'Pilot bootstrap evidence requires pilotPolicy schemaVersion 1.'
        }
        $allowedMachines = @($pilotPolicy.allowedMachineNames | ForEach-Object { ([string]$_).Trim().ToUpperInvariant() })
        $machineName = [Environment]::MachineName.Trim().ToUpperInvariant()
        if ($allowedMachines.Count -eq 0 -or $allowedMachines -notcontains $machineName) {
            throw "pilot_machine_not_allowed: authenticated pilot bootstrap does not authorize this computer: $machineName"
        }
    }
    elseif ($null -ne $pilotPolicy) { throw 'Stable bootstrap evidence must not contain pilotPolicy.' }
    if (-not [string]::Equals([IO.Path]::GetFullPath([string]$AuthenticatedRelease.root).TrimEnd('\'), [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Authenticated release evidence root does not match ReleaseRoot.'
    }
    if (-not $AllowTestRoot) {
        $canonicalReleaseRoot = [IO.Path]::GetFullPath('\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy').TrimEnd('\')
        if (-not [string]::Equals([IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\'), $canonicalReleaseRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Production bootstrap release root must be the canonical NAS root: $canonicalReleaseRoot"
        }
    }
    foreach ($hashName in @('channelManifestSha256', 'releaseManifestSha256', 'packageSha256')) {
        if ([string]$AuthenticatedRelease.$hashName -notmatch '^[A-Fa-f0-9]{64}$') {
            throw "Authenticated release evidence contains an invalid $hashName."
        }
    }
    $BootstrapRoot = [IO.Path]::GetFullPath($BootstrapRoot).TrimEnd("\")
    $canonicalBootstrapRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) "DPE\revAgent\bootstrap"
    if (-not $AllowTestRoot -and -not [string]::Equals($BootstrapRoot, [IO.Path]::GetFullPath($canonicalBootstrapRoot).TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
        throw "BootstrapRoot must be the canonical protected machine root: $canonicalBootstrapRoot"
    }
    if (-not $AllowTestRoot) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw "Canonical local bootstrap installation requires an elevated administrator process."
        }
    }

    $sources = [ordered]@{
        bootstrap = [IO.Path]::GetFullPath($BootstrapScriptPath)
        launcher = [IO.Path]::GetFullPath($LauncherPath)
        updaterGui = [IO.Path]::GetFullPath($GuiPath)
        distributionIntegrity = [IO.Path]::GetFullPath($DistributionIntegrityModulePath)
        sourceFreeMigration = [IO.Path]::GetFullPath($SourceFreeMigrationModulePath)
        releaseSnapshot = [IO.Path]::GetFullPath($ReleaseSnapshotModulePath)
        privilegedSnapshotUpdate = [IO.Path]::GetFullPath($PrivilegedSnapshotUpdatePath)
        trustedKeys = [IO.Path]::GetFullPath($TrustedKeysPath)
    }
    $sourceEvidence = [ordered]@{}
    foreach ($entry in $sources.GetEnumerator()) {
        if (-not $ExpectedSourceHashes.Contains($entry.Key) -or [string]::IsNullOrWhiteSpace([string]$ExpectedSourceHashes[$entry.Key])) { throw "Expected source SHA-256 is required for '$($entry.Key)'." }
        Assert-RevAgentBootstrapLinkSafe -Path $entry.Value
        if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) { throw "Bootstrap source '$($entry.Key)' was not found: $($entry.Value)" }
        $item = Get-Item -LiteralPath $entry.Value -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) {
            throw "Bootstrap source '$($entry.Key)' is a filesystem link: $($entry.Value)"
        }
        $evidence = Read-RevAgentBootstrapSourceEvidence -Path $entry.Value
        if (-not [string]::Equals([string]$evidence.Sha256, [string]$ExpectedSourceHashes[$entry.Key], [StringComparison]::OrdinalIgnoreCase)) { throw "Bootstrap source '$($entry.Key)' did not match independently authenticated SHA-256 evidence." }
        $sourceEvidence[$entry.Key] = $evidence
    }

    # Guard the complete destination chain before the first destination write. This
    # prevents a preplanted parent junction from redirecting an elevated prestage.
    Assert-RevAgentBootstrapLinkSafe -Path $BootstrapRoot
    $parent = Split-Path -Parent $BootstrapRoot
    if ($AllowTestRoot) {
        Assert-RevAgentBootstrapLinkSafe -Path $parent
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        Assert-RevAgentBootstrapLinkSafe -Path $parent
    }
    else {
        $commonApplicationData = [IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)).TrimEnd("\")
        Assert-RevAgentBootstrapLinkSafe -Path $commonApplicationData
        $dpeRoot = Join-Path $commonApplicationData 'DPE'
        if (-not (Test-Path -LiteralPath $dpeRoot -PathType Container)) {
            throw "bootstrap_shared_ancestor_not_prestaged: the shared DPE ancestor must be created by the supervised elevated prestage block before bootstrap installation: $dpeRoot"
        }
        else {
            $dpeRoot = Assert-RevAgentBootstrapSharedAncestorSafe -Path $dpeRoot
        }
        $protectedParent = Initialize-RevAgentProtectedProductRoot -SharedParent $dpeRoot -Name 'revAgent'
        if (-not [string]::Equals([IO.Path]::GetFullPath($parent).TrimEnd("\"), [IO.Path]::GetFullPath($protectedParent).TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
            throw "bootstrap_parent_not_protected: canonical bootstrap parent resolution changed unexpectedly. expected=$parent actual=$protectedParent"
        }
        Assert-RevAgentBootstrapParentProtected -Path $parent
    }
    if (Test-Path -LiteralPath $BootstrapRoot) { Assert-RevAgentBootstrapLinkSafe -Path $BootstrapRoot -Recurse }
    $staging = Join-Path $parent (".bootstrap-stage-{0}" -f [Guid]::NewGuid().ToString("N"))
    $backup = Join-Path $parent (".bootstrap-previous-{0}" -f [Guid]::NewGuid().ToString("N"))
    try {
        if ($AllowTestRoot) { New-Item -ItemType Directory -Path $staging -Force | Out-Null }
        else {
            $stageAcl = [Security.AccessControl.DirectorySecurity]::new()
            $stageAcl.SetAccessRuleProtection($true, $false)
            $stageAcl.SetOwner([Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"))
            foreach ($sid in @("S-1-5-18", "S-1-5-32-544")) {
                [void]$stageAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
            }
            [void]([IO.DirectoryInfo]::new($parent).CreateSubdirectory((Split-Path -Leaf $staging), $stageAcl))
        }
        New-Item -ItemType Directory -Path (Join-Path $staging "lib"), (Join-Path $staging "config") -Force | Out-Null
        $destinations = [ordered]@{
            bootstrap = "Start-revAgent-Update.ps1"
            launcher = "Start-revAgent-Update.cmd"
            updaterGui = "Install-revAgent-Updater-GUI.ps1"
            distributionIntegrity = "lib\RevAgent.DistributionIntegrity.psm1"
            sourceFreeMigration = "lib\RevAgent.SourceFreeMigration.psm1"
            releaseSnapshot = "lib\RevAgent.ReleaseSnapshot.psm1"
            privilegedSnapshotUpdate = "Invoke-revAgent-PrivilegedSnapshotUpdate.ps1"
            trustedKeys = "config\release-trusted-keys.json"
        }
        $fileEvidence = [ordered]@{}
        foreach ($role in $destinations.Keys) {
            $destination = Join-Path $staging $destinations[$role]
            [IO.File]::WriteAllBytes($destination, [byte[]]$sourceEvidence[$role].Bytes)
            if (-not [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash, [string]$ExpectedSourceHashes[$role], [StringComparison]::OrdinalIgnoreCase)) { throw "Bootstrap source '$role' changed during authenticated copy." }
            Assert-RevAgentBootstrapSourceUnchanged -Evidence $sourceEvidence[$role]
            $fileEvidence[$role] = [ordered]@{
                relativePath = $destinations[$role]
                sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash
            }
        }
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $state = [ordered]@{
            schemaVersion = 1
            app = "revAgent"
            bootstrapRoot = $BootstrapRoot
            releaseRoot = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd("\")
            release = [ordered]@{
                channel = [string]$AuthenticatedRelease.channel
                version = [string]$AuthenticatedRelease.version
                releaseSequence = [long]$AuthenticatedRelease.releaseSequence
                minimumAcceptedReleaseSequence = [long]$AuthenticatedRelease.minimumAcceptedReleaseSequence
                highestAcceptedReleaseSequence = [long]$AuthenticatedRelease.highestAcceptedReleaseSequence
                channelManifestSha256 = [string]$AuthenticatedRelease.channelManifestSha256
                releaseManifestSha256 = [string]$AuthenticatedRelease.releaseManifestSha256
                packageSha256 = [string]$AuthenticatedRelease.packageSha256
                signatureVerified = $true
                pilotPolicy = $pilotPolicy
            }
            installedAtUtc = [DateTime]::UtcNow.ToString("o")
            installedBy = [ordered]@{ name = [string]$identity.Name; sid = [string]$identity.User.Value }
            sourceAuthentication = [ordered]@{
                method = $SourceAuthenticationMethod
                independentlyAuthenticated = $true
                operatorConfirmed = $true
            }
            files = $fileEvidence
        }
        $stateBytes = [Text.UTF8Encoding]::new($false).GetBytes(($state | ConvertTo-Json -Depth 10))
        [IO.File]::WriteAllBytes((Join-Path $staging "bootstrap-state.json"), $stateBytes)

        if (Test-Path -LiteralPath $BootstrapRoot) { Move-Item -LiteralPath $BootstrapRoot -Destination $backup }
        Move-Item -LiteralPath $staging -Destination $BootstrapRoot
        $orderedItems = @(Get-ChildItem -LiteralPath $BootstrapRoot -Recurse -Force) + @(Get-Item -LiteralPath $BootstrapRoot -Force)
        foreach ($item in @($orderedItems | Sort-Object { $_.FullName.Length } -Descending)) { Set-RevAgentBootstrapDacl -Path $item.FullName -SetAdministratorsOwner:(-not $AllowTestRoot) }
        if (Test-Path -LiteralPath $backup) { Assert-RevAgentBootstrapLinkSafe -Path $backup -Recurse; Remove-Item -LiteralPath $backup -Recurse -Force }
        return Get-Content -Raw -LiteralPath (Join-Path $BootstrapRoot "bootstrap-state.json") | ConvertFrom-Json
    }
    catch {
        if ((-not (Test-Path -LiteralPath $BootstrapRoot)) -and (Test-Path -LiteralPath $backup)) {
            Move-Item -LiteralPath $backup -Destination $BootstrapRoot -ErrorAction SilentlyContinue
        }
        throw
    }
    finally {
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Export-ModuleMember -Function Install-RevAgentLocalBootstrap
