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

function Get-RevAgentBootstrapDirectoryIdentity {
    param([Parameter(Mandatory = $true)][string]$Path)

    $guard = Open-RevAgentBootstrapDirectoryGuard -Path $Path
    try { return [string]$guard.Identity }
    finally { if ($null -ne $guard -and $null -ne $guard.Handle) { $guard.Handle.Dispose() } }
}

function Assert-RevAgentBootstrapItemAclReady {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$RequireAdministratorsOwner
    )

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    if (-not $acl.AreAccessRulesProtected) {
        throw "Bootstrap commit candidate has an inherited DACL: $($item.FullName)"
    }
    if ($RequireAdministratorsOwner) {
        $ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if (-not [string]::Equals($ownerSid, 'S-1-5-32-544', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Bootstrap commit candidate is not owned by BUILTIN\Administrators: $($item.FullName)"
        }
    }

    $requiredRights = [ordered]@{
        'S-1-5-18' = [Security.AccessControl.FileSystemRights]::FullControl
        'S-1-5-32-544' = [Security.AccessControl.FileSystemRights]::FullControl
        'S-1-5-32-545' = [Security.AccessControl.FileSystemRights]::ReadAndExecute
    }
    $seen = @{}
    $writeMask = [Security.AccessControl.FileSystemRights]::Write -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        $sid = [string]$rule.IdentityReference.Value
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or -not $requiredRights.Contains($sid)) {
            throw "Bootstrap commit candidate has an unexpected access rule. path=$($item.FullName) principal=$sid type=$($rule.AccessControlType) rights=$($rule.FileSystemRights)"
        }
        if ($rule.IsInherited) {
            throw "Bootstrap commit candidate has an inherited access rule: $($item.FullName)"
        }
        if ($sid -eq 'S-1-5-32-545' -and (($rule.FileSystemRights -band $writeMask) -ne 0)) {
            throw "Bootstrap commit candidate grants write-capable access to BUILTIN\Users: $($item.FullName)"
        }
        $required = [Security.AccessControl.FileSystemRights]$requiredRights[$sid]
        if (($rule.FileSystemRights -band $required) -ne $required) {
            throw "Bootstrap commit candidate lacks required access. path=$($item.FullName) principal=$sid required=$required actual=$($rule.FileSystemRights)"
        }
        $seen[$sid] = $true
    }
    foreach ($sid in $requiredRights.Keys) {
        if (-not $seen.ContainsKey($sid)) {
            throw "Bootstrap commit candidate is missing the required access rule for ${sid}: $($item.FullName)"
        }
    }
}

function Assert-RevAgentBootstrapPrivateTransactionRoot {
    param([Parameter(Mandatory = $true)][string]$Path)

    Assert-RevAgentBootstrapLinkSafe -Path $Path
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw "Bootstrap transaction root is not a directory: $Path" }
    $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    $ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (-not $acl.AreAccessRulesProtected -or -not [string]::Equals($ownerSid, 'S-1-5-32-544', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Bootstrap transaction root is not protected and Administrators-owned: $($item.FullName)"
    }
    $seen = @{}
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        $sid = [string]$rule.IdentityReference.Value
        if ($rule.IsInherited -or
            $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $sid -notin @('S-1-5-18', 'S-1-5-32-544') -or
            (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) {
            throw "Bootstrap transaction root grants unexpected access. path=$($item.FullName) principal=$sid rights=$($rule.FileSystemRights)"
        }
        $seen[$sid] = $true
    }
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        if (-not $seen.ContainsKey($sid)) { throw "Bootstrap transaction root is missing required full control for ${sid}: $($item.FullName)" }
    }
}

function Grant-RevAgentBootstrapTestCleanupAccess {
    param([Parameter(Mandatory = $true)][string]$Root)

    if (-not (Test-Path -LiteralPath $Root)) { return }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $items = @(Get-ChildItem -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue) + @(Get-Item -LiteralPath $Root -Force)
    foreach ($item in @($items | Sort-Object { $_.FullName.Length })) {
        try {
            $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
            $inheritance = if ($item.PSIsContainer) {
                [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
            }
            else { [Security.AccessControl.InheritanceFlags]::None }
            $rule = [Security.AccessControl.FileSystemAccessRule]::new(
                $currentSid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow)
            $acl.SetAccessRule($rule)
            if ($item.PSIsContainer) {
                if ('System.IO.FileSystemAclExtensions' -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]$item, [Security.AccessControl.DirectorySecurity]$acl) }
                else { ([IO.DirectoryInfo]$item).SetAccessControl([Security.AccessControl.DirectorySecurity]$acl) }
            }
            else {
                if ('System.IO.FileSystemAclExtensions' -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]$item, [Security.AccessControl.FileSecurity]$acl) }
                else { ([IO.FileInfo]$item).SetAccessControl([Security.AccessControl.FileSecurity]$acl) }
            }
        }
        catch { }
    }
}

function Assert-RevAgentBootstrapTreeReadyForCommit {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Destinations,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$ExpectedSourceHashes,
        [switch]$RequireAdministratorsOwner
    )

    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    Assert-RevAgentBootstrapLinkSafe -Path $fullRoot -Recurse
    if (-not (Test-Path -LiteralPath $fullRoot -PathType Container)) {
        throw "Bootstrap commit candidate root was not found: $fullRoot"
    }

    $expectedRelativePaths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [void]$expectedRelativePaths.Add('lib')
    [void]$expectedRelativePaths.Add('config')
    [void]$expectedRelativePaths.Add('bootstrap-state.json')
    foreach ($relativePath in $Destinations.Values) { [void]$expectedRelativePaths.Add(([string]$relativePath).Replace('/', '\')) }

    $items = @(Get-ChildItem -LiteralPath $fullRoot -Recurse -Force -ErrorAction Stop)
    foreach ($item in $items) {
        $relativePath = $item.FullName.Substring($fullRoot.Length).TrimStart('\')
        if (-not $expectedRelativePaths.Contains($relativePath)) {
            throw "Bootstrap commit candidate contains an unexpected item: $relativePath"
        }
    }
    if ($items.Count -ne $expectedRelativePaths.Count) {
        $actualRelativePaths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($item in $items) { [void]$actualRelativePaths.Add($item.FullName.Substring($fullRoot.Length).TrimStart('\')) }
        $missing = @($expectedRelativePaths | Where-Object { -not $actualRelativePaths.Contains($_) })
        throw "Bootstrap commit candidate is incomplete. missing=$($missing -join ',')"
    }

    foreach ($item in @($items | Sort-Object { $_.FullName.Length } -Descending) + @(Get-Item -LiteralPath $fullRoot -Force -ErrorAction Stop)) {
        Assert-RevAgentBootstrapItemAclReady -Path $item.FullName -RequireAdministratorsOwner:$RequireAdministratorsOwner
        if (-not $item.PSIsContainer) { Assert-RevAgentBootstrapLinkSafe -Path $item.FullName }
    }
    foreach ($role in $Destinations.Keys) {
        $path = Join-Path $fullRoot ([string]$Destinations[$role])
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Bootstrap commit candidate is missing '$role': $path" }
        $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path -ErrorAction Stop).Hash
        if (-not [string]::Equals($actualHash, [string]$ExpectedSourceHashes[$role], [StringComparison]::OrdinalIgnoreCase)) {
            throw "Bootstrap commit candidate '$role' does not match authenticated SHA-256 evidence."
        }
    }

    $statePath = Join-Path $fullRoot 'bootstrap-state.json'
    $stateItem = Get-Item -LiteralPath $statePath -Force -ErrorAction Stop
    if ($stateItem.Length -le 0 -or $stateItem.Length -gt 1048576) {
        throw "Bootstrap commit candidate state is outside the bounded 1..1048576 byte policy: $statePath"
    }
    $installedState = Get-Content -Raw -LiteralPath $statePath -ErrorAction Stop | ConvertFrom-Json
    if ([int]$installedState.schemaVersion -ne 1 -or -not [string]::Equals([string]$installedState.app, 'revAgent', [StringComparison]::Ordinal)) {
        throw "Bootstrap commit candidate state contract is invalid: $statePath"
    }
    foreach ($role in $Destinations.Keys) {
        $fileState = $installedState.files.$role
        if ($null -eq $fileState -or
            -not [string]::Equals([string]$fileState.relativePath, [string]$Destinations[$role], [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals([string]$fileState.sha256, [string]$ExpectedSourceHashes[$role], [StringComparison]::OrdinalIgnoreCase)) {
            throw "Bootstrap commit candidate state does not bind authenticated file '$role'."
        }
    }
    return $installedState
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
        $inheritOnly = ($null -ne $rule.PSObject.Properties['PropagationFlags'] -and
            (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0))
        if (-not $inheritOnly -and
            $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
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

function Resolve-RevAgentLocalBootstrapDesktopShortcutRoot {
    param([string]$DesktopShortcutRoot, [switch]$AllowTestRoot)

    if (-not [string]::IsNullOrWhiteSpace($DesktopShortcutRoot)) {
        return [IO.Path]::GetFullPath($DesktopShortcutRoot).TrimEnd("\")
    }
    if ($AllowTestRoot) { return "" }
    $desktopRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory)
    if ([string]::IsNullOrWhiteSpace($desktopRoot) -and -not [string]::IsNullOrWhiteSpace($env:PUBLIC)) {
        $desktopRoot = Join-Path $env:PUBLIC "Desktop"
    }
    if ([string]::IsNullOrWhiteSpace($desktopRoot)) { return "" }
    return [IO.Path]::GetFullPath($desktopRoot).TrimEnd("\")
}

function Set-RevAgentLocalBootstrapDesktopShortcut {
    param(
        [string]$DesktopShortcutRoot,
        [Parameter(Mandatory = $true)][string]$BootstrapRoot,
        [switch]$AllowTestRoot
    )

    $workingDirectory = [IO.Path]::GetFullPath($BootstrapRoot).TrimEnd("\")
    $targetPath = Join-Path $workingDirectory "Start-revAgent-Update.cmd"
    $shortcutRoot = Resolve-RevAgentLocalBootstrapDesktopShortcutRoot -DesktopShortcutRoot $DesktopShortcutRoot -AllowTestRoot:$AllowTestRoot
    $shortcutName = "revAgent Updater.lnk"
    $shortcutPath = if ([string]::IsNullOrWhiteSpace($shortcutRoot)) { "" } else { Join-Path $shortcutRoot $shortcutName }
    $result = [ordered]@{
        schemaVersion = 1
        name = $shortcutName
        attempted = $false
        success = $false
        shortcutRoot = $shortcutRoot
        path = $shortcutPath
        targetPath = $targetPath
        workingDirectory = $workingDirectory
        reason = ""
    }
    if ([string]::IsNullOrWhiteSpace($shortcutRoot)) {
        $result.reason = if ($AllowTestRoot) { "test_root_shortcut_root_not_requested" } else { "desktop_shortcut_root_unavailable" }
        return [pscustomobject]$result
    }

    $result.attempted = $true
    try {
        Assert-RevAgentBootstrapLinkSafe -Path $shortcutRoot
        if (-not (Test-Path -LiteralPath $shortcutRoot -PathType Container)) {
            New-Item -ItemType Directory -Path $shortcutRoot -Force | Out-Null
        }
        Assert-RevAgentBootstrapLinkSafe -Path $shortcutRoot
        if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
            throw "Protected local bootstrap launcher was not found: $targetPath"
        }

        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $targetPath
        $shortcut.WorkingDirectory = $workingDirectory
        $shortcut.Description = "Open the revAgent updater GUI through the protected local bootstrap."
        $shortcut.Save()

        $verifiedShortcut = $shell.CreateShortcut($shortcutPath)
        if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
            throw "Desktop shortcut was not created: $shortcutPath"
        }
        if (-not [string]::Equals([IO.Path]::GetFullPath([string]$verifiedShortcut.TargetPath), [IO.Path]::GetFullPath($targetPath), [StringComparison]::OrdinalIgnoreCase)) {
            throw "Desktop shortcut target verification failed: $shortcutPath"
        }
        if (-not [string]::Equals([IO.Path]::GetFullPath([string]$verifiedShortcut.WorkingDirectory).TrimEnd("\"), $workingDirectory, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Desktop shortcut working-directory verification failed: $shortcutPath"
        }
        $result.success = $true
        $result.reason = "created_or_updated"
    }
    catch {
        $result.reason = [string]$_.Exception.Message
        Write-Warning ("revAgent desktop updater shortcut could not be created: {0}" -f $result.reason)
    }
    return [pscustomobject]$result
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
        [Parameter(Mandatory = $true)][string]$PermissionsModulePath,
        [Parameter(Mandatory = $true)][string]$SourceFreeMigrationModulePath,
        [Parameter(Mandatory = $true)][string]$ReleaseSnapshotModulePath,
        [Parameter(Mandatory = $true)][string]$PrivilegedSnapshotUpdatePath,
        [Parameter(Mandatory = $true)][string]$TrustedKeysPath,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$ExpectedSourceHashes,
        [Parameter(Mandatory = $true)][object]$AuthenticatedRelease,
        [Parameter(Mandatory = $true)][string]$SourceAuthenticationMethod,
        [string]$DesktopShortcutRoot = "",
        [switch]$ConfirmIndependentlyAuthenticatedSource,
        [switch]$AllowTestRoot,
        [Parameter(DontShow = $true)][scriptblock]$BeforeCommitTestHook = $null,
        [Parameter(DontShow = $true)][scriptblock]$BackupCleanupTestHook = $null
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
        permissions = [IO.Path]::GetFullPath($PermissionsModulePath)
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
    $previousBootstrapPathExists = Test-Path -LiteralPath $BootstrapRoot
    if ($previousBootstrapPathExists) {
        Assert-RevAgentBootstrapLinkSafe -Path $BootstrapRoot -Recurse
        if (-not (Test-Path -LiteralPath $BootstrapRoot -PathType Container)) {
            throw "Existing bootstrap root is not a directory: $BootstrapRoot"
        }
    }
    # Candidate and prior roots stay below an unlistable fixed container and one
    # random transaction child. Windows users normally hold bypass-traverse, so a
    # random directory directly below the listable product root would still leak
    # its GUID. Here users cannot enumerate the private container to learn the
    # exact random path needed to open/pin either rename target.
    $transactionParent = Join-Path $parent '.bootstrap-transactions'
    $transactionRoot = Join-Path $transactionParent ([Guid]::NewGuid().ToString("N"))
    $staging = Join-Path $transactionRoot 'candidate'
    $backup = Join-Path $transactionRoot 'previous'
    $hadPreviousBootstrap = $previousBootstrapPathExists
    $previousBootstrapIdentity = if ($hadPreviousBootstrap) { Get-RevAgentBootstrapDirectoryIdentity -Path $BootstrapRoot } else { '' }
    $commitComplete = $false
    try {
        if ($AllowTestRoot) {
            if (-not (Test-Path -LiteralPath $transactionParent -PathType Container)) {
                New-Item -ItemType Directory -Path $transactionParent -ErrorAction Stop | Out-Null
            }
            New-Item -ItemType Directory -Path $transactionRoot -ErrorAction Stop | Out-Null
            New-Item -ItemType Directory -Path $staging -ErrorAction Stop | Out-Null
        }
        else {
            $transactionAcl = [Security.AccessControl.DirectorySecurity]::new()
            $transactionAcl.SetAccessRuleProtection($true, $false)
            $transactionAcl.SetOwner([Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"))
            foreach ($sid in @("S-1-5-18", "S-1-5-32-544")) {
                [void]$transactionAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
            }
            if (-not (Test-Path -LiteralPath $transactionParent -PathType Container)) {
                $transactionParentItem = [IO.DirectoryInfo]::new($parent).CreateSubdirectory((Split-Path -Leaf $transactionParent), $transactionAcl)
            }
            else { $transactionParentItem = [IO.DirectoryInfo](Get-Item -LiteralPath $transactionParent -Force -ErrorAction Stop) }
            Assert-RevAgentBootstrapPrivateTransactionRoot -Path $transactionParentItem.FullName
            if (Test-Path -LiteralPath $transactionRoot) { throw "Bootstrap transaction root already exists: $transactionRoot" }
            $transactionItem = $transactionParentItem.CreateSubdirectory((Split-Path -Leaf $transactionRoot), $transactionAcl)
            Assert-RevAgentBootstrapPrivateTransactionRoot -Path $transactionItem.FullName
            [void]$transactionItem.CreateSubdirectory('candidate', $transactionAcl)
        }
        New-Item -ItemType Directory -Path (Join-Path $staging "lib"), (Join-Path $staging "config") -Force | Out-Null
        $destinations = [ordered]@{
            bootstrap = "Start-revAgent-Update.ps1"
            launcher = "Start-revAgent-Update.cmd"
            updaterGui = "Install-revAgent-Updater-GUI.ps1"
            distributionIntegrity = "lib\RevAgent.DistributionIntegrity.psm1"
            permissions = "lib\RevAgent.Permissions.psm1"
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

        # A standard user must never observe a half-hardened canonical tree. Apply
        # and attest every ACL, expected file, hash, and state binding while the
        # candidate is still outside the canonical pathname.
        $orderedItems = @(Get-ChildItem -LiteralPath $staging -Recurse -Force) + @(Get-Item -LiteralPath $staging -Force)
        foreach ($item in @($orderedItems | Sort-Object { $_.FullName.Length } -Descending)) {
            Set-RevAgentBootstrapDacl -Path $item.FullName -SetAdministratorsOwner:(-not $AllowTestRoot)
        }
        $installedState = Assert-RevAgentBootstrapTreeReadyForCommit `
            -Root $staging `
            -Destinations $destinations `
            -ExpectedSourceHashes $ExpectedSourceHashes `
            -RequireAdministratorsOwner:(-not $AllowTestRoot)

        if ($hadPreviousBootstrap) { Move-Item -LiteralPath $BootstrapRoot -Destination $backup -ErrorAction Stop }
        if ($null -ne $BeforeCommitTestHook) { & $BeforeCommitTestHook $staging $backup }
        Move-Item -LiteralPath $staging -Destination $BootstrapRoot
        # Promotion of the already-attested candidate is the commit boundary.
        # Any later failure leaves that healthy canonical root in place.
        $commitComplete = $true
        [void](Assert-RevAgentBootstrapTreeReadyForCommit `
                -Root $BootstrapRoot `
                -Destinations $destinations `
                -ExpectedSourceHashes $ExpectedSourceHashes `
                -RequireAdministratorsOwner:(-not $AllowTestRoot))

        # Once the canonical tree has passed its post-swap attestation it is the
        # committed good root. A locked/deletion-resistant prior root is only
        # deferred cleanup; it must never roll a healthy new root back.
        $backupCleanup = [ordered]@{
            attempted = $false
            success = $true
            deferred = $false
            path = $backup
            warning = ''
        }
        if (Test-Path -LiteralPath $backup) {
            $backupCleanup.attempted = $true
            try {
                if ($null -ne $BackupCleanupTestHook) { & $BackupCleanupTestHook $backup }
                Assert-RevAgentBootstrapLinkSafe -Path $backup -Recurse
                Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop
                if (Test-Path -LiteralPath $backup) { throw "Previous bootstrap root still exists after cleanup: $backup" }
            }
            catch {
                $backupCleanup.success = $false
                $backupCleanup.deferred = $true
                $backupCleanup.warning = [string]$_.Exception.Message
                Write-Warning ("Committed local bootstrap is healthy, but prior-root cleanup was deferred. path={0} reason={1}" -f $backup, $backupCleanup.warning)
            }
        }
        $desktopShortcut = Set-RevAgentLocalBootstrapDesktopShortcut -DesktopShortcutRoot $DesktopShortcutRoot -BootstrapRoot $BootstrapRoot -AllowTestRoot:$AllowTestRoot
        $installedState | Add-Member -NotePropertyName "desktopShortcut" -NotePropertyValue $desktopShortcut -Force
        $installedState | Add-Member -NotePropertyName "backupCleanup" -NotePropertyValue ([pscustomobject]$backupCleanup) -Force
        return $installedState
    }
    catch {
        $installFailure = $_
        if (-not $commitComplete) {
            try {
                if ($hadPreviousBootstrap) {
                    if (Test-Path -LiteralPath $backup -PathType Container) {
                        if (Test-Path -LiteralPath $BootstrapRoot) {
                            throw "Canonical bootstrap root unexpectedly exists before previous-root restore: $BootstrapRoot"
                        }
                        Move-Item -LiteralPath $backup -Destination $BootstrapRoot -ErrorAction Stop
                    }
                    if (-not (Test-Path -LiteralPath $BootstrapRoot -PathType Container)) {
                        throw "Previous bootstrap root is missing after rollback: $BootstrapRoot"
                    }
                    Assert-RevAgentBootstrapLinkSafe -Path $BootstrapRoot -Recurse
                    $restoredIdentity = Get-RevAgentBootstrapDirectoryIdentity -Path $BootstrapRoot
                    if (-not [string]::Equals($restoredIdentity, $previousBootstrapIdentity, [StringComparison]::Ordinal)) {
                        throw "Previous bootstrap root identity was not restored. expected=$previousBootstrapIdentity actual=$restoredIdentity"
                    }
                }
                elseif (Test-Path -LiteralPath $BootstrapRoot) {
                    Assert-RevAgentBootstrapLinkSafe -Path $BootstrapRoot -Recurse
                    Remove-Item -LiteralPath $BootstrapRoot -Recurse -Force -ErrorAction Stop
                    if (Test-Path -LiteralPath $BootstrapRoot) { throw "Uncommitted bootstrap root still exists after rollback: $BootstrapRoot" }
                }
            }
            catch {
                $rollbackFailure = $_
                throw "Local bootstrap pre-commit failure could not restore the canonical root. installError=$($installFailure.Exception.Message) rollbackError=$($rollbackFailure.Exception.Message)"
            }
        }
        throw $installFailure
    }
    finally {
        if (Test-Path -LiteralPath $staging) {
            if ($AllowTestRoot) { Grant-RevAgentBootstrapTestCleanupAccess -Root $staging }
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        }
        if ((Test-Path -LiteralPath $transactionRoot -PathType Container) -and -not (Test-Path -LiteralPath $backup)) {
            Remove-Item -LiteralPath $transactionRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Export-ModuleMember -Function Install-RevAgentLocalBootstrap
