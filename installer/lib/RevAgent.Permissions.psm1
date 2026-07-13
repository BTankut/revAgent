Set-StrictMode -Version Latest

if (-not ("RevAgent.PermissionNativeFileInfo" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent {
    public static class PermissionNativeFileInfo {
        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle hFile,
            out BY_HANDLE_FILE_INFORMATION fileInformation);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool RemoveDirectoryW(string pathName);

        public static uint GetLinkCount(string path) {
            using (var stream = new System.IO.FileStream(
                path,
                System.IO.FileMode.Open,
                System.IO.FileAccess.Read,
                System.IO.FileShare.ReadWrite | System.IO.FileShare.Delete)) {
                BY_HANDLE_FILE_INFORMATION info;
                if (!GetFileInformationByHandle(stream.SafeFileHandle, out info)) {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
                return info.NumberOfLinks;
            }
        }

        public static void RemoveDirectoryLink(string path) {
            if (!RemoveDirectoryW(path)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
        }
    }
}
"@
}

if (-not ("RevAgent.AccountNativeInfo" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace RevAgent {
    public sealed class AccountLookupResult {
        public string AccountName { get; set; }
        public string Name { get; set; }
        public string Domain { get; set; }
        public int SidType { get; set; }
    }

    public static class AccountNativeInfo {
        private const int ErrorInsufficientBuffer = 122;

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool LookupAccountSid(
            string systemName,
            byte[] sid,
            StringBuilder name,
            ref uint nameLength,
            StringBuilder domainName,
            ref uint domainNameLength,
            out int sidType);

        public static AccountLookupResult Lookup(string sidValue) {
            SecurityIdentifier sid = new SecurityIdentifier(sidValue);
            byte[] binarySid = new byte[sid.BinaryLength];
            sid.GetBinaryForm(binarySid, 0);

            uint nameLength = 0;
            uint domainLength = 0;
            int sidType;
            LookupAccountSid(null, binarySid, null, ref nameLength, null, ref domainLength, out sidType);
            int error = Marshal.GetLastWin32Error();
            if (error != ErrorInsufficientBuffer) {
                throw new Win32Exception(error, "LookupAccountSid size probe failed.");
            }

            StringBuilder name = new StringBuilder((int)Math.Max(1, nameLength));
            StringBuilder domain = new StringBuilder((int)Math.Max(1, domainLength));
            if (!LookupAccountSid(null, binarySid, name, ref nameLength, domain, ref domainLength, out sidType)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "LookupAccountSid failed.");
            }

            string accountName = domain.Length == 0 ? name.ToString() : domain + "\\" + name;
            return new AccountLookupResult {
                AccountName = accountName,
                Name = name.ToString(),
                Domain = domain.ToString(),
                SidType = sidType
            };
        }
    }
}
"@
}

function Test-RevitMcpAdministrator {
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
        return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
}

function New-RevitMcpPermissionTarget {
    param(
        [string]$Path,
        [string]$Label,
        [ValidateSet("Directory", "File")]
        [string]$Kind = "Directory",
        [switch]$CreateDirectory,
        [switch]$Recurse
    )

    return [pscustomobject]@{
        Path = $Path
        Label = $Label
        Kind = $Kind
        CreateDirectory = [bool]$CreateDirectory
        Recurse = [bool]$Recurse
    }
}

function Get-RevitMcpManagedPermissionTargets {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,
        [Parameter(Mandatory = $true)]
        [string]$WorkRoot,
        [Parameter(Mandatory = $true)]
        [string]$PackageTarget,
        [Parameter(Mandatory = $true)]
        [string]$ServerTarget,
        [string]$AllUsersAddinRoot = "",
        [string]$RevitVersion = "2022",
        [switch]$IncludeExistingPayloadTrees
    )

    $targets = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in @(
            @{ Path = $InstallRoot; Label = "revAgent install root" },
            @{ Path = $WorkRoot; Label = "updater work root" },
            @{ Path = $PackageTarget; Label = "package target" },
            @{ Path = $ServerTarget; Label = "runtime target" },
            @{ Path = (Join-Path $InstallRoot "revit-plugin"); Label = "Revit addin payload root" },
            @{ Path = (Join-Path $InstallRoot "commands"); Label = "Revit command payload root" },
            @{ Path = (Join-Path $InstallRoot "codex"); Label = "Codex payload root" },
            @{ Path = (Join-Path $InstallRoot "state"); Label = "state root" },
            @{ Path = (Join-Path $WorkRoot "logs"); Label = "updater logs root" },
            @{ Path = (Join-Path $WorkRoot "cache"); Label = "updater cache root" },
            @{ Path = (Join-Path $WorkRoot "staging"); Label = "updater staging root" },
            @{ Path = (Join-Path $WorkRoot "reports"); Label = "updater reports root" },
            @{ Path = (Join-Path $WorkRoot "config"); Label = "updater config root" }
        )) {
        $targets.Add((New-RevitMcpPermissionTarget -Path $entry.Path -Label $entry.Label -CreateDirectory))
    }
    $targets.Add((New-RevitMcpPermissionTarget -Path (Join-Path $WorkRoot "lib") -Label "updater lib root" -CreateDirectory -Recurse))

    if (-not [string]::IsNullOrWhiteSpace($AllUsersAddinRoot)) {
        $targets.Add((New-RevitMcpPermissionTarget -Path $AllUsersAddinRoot -Label "Revit $RevitVersion addin root" -CreateDirectory))
        $targets.Add((New-RevitMcpPermissionTarget -Path (Join-Path $AllUsersAddinRoot "revAgent.addin") -Label "revAgent add-in manifest" -Kind File))
        $targets.Add((New-RevitMcpPermissionTarget -Path (Join-Path $AllUsersAddinRoot "mcp-servers-for-revit.addin") -Label "legacy revAgent add-in manifest" -Kind File))
    }

    foreach ($fileName in @(
            "Run-revAgent-Update-Hidden.vbs",
            "last-update-report.json",
            "installed.json",
            "updater-config.json",
            "update-from-nas.ps1",
            "show-installed-version.ps1",
            "install-updater-task.ps1",
            "migrate-source-free-install.ps1",
            "Invoke-revAgent-CodexUserIntegration.ps1",
            "Update-revAgent-Now.cmd",
            "Show-revAgent-Version.cmd",
            "auto-update-loop.ps1",
            "config\release-trusted-keys.json"
        )) {
        $targets.Add((New-RevitMcpPermissionTarget -Path (Join-Path $WorkRoot $fileName) -Label "updater file $fileName" -Kind File))
    }

    if ($IncludeExistingPayloadTrees) {
        foreach ($entry in @(
                @{ Path = (Join-Path $InstallRoot "revit-plugin\revAgentPlugin"); Label = "existing Revit addin payload" },
                @{ Path = (Join-Path $InstallRoot "revit-plugin\revit_mcp_plugin"); Label = "legacy Revit addin payload" },
                @{ Path = (Join-Path $InstallRoot "commands\CommandSet"); Label = "existing Revit command payload" },
                @{ Path = $ServerTarget; Label = "existing runtime payload" },
                @{ Path = (Join-Path $InstallRoot "codex\skills\revAgent"); Label = "existing Codex skill payload" }
            )) {
            $targets.Add((New-RevitMcpPermissionTarget -Path $entry.Path -Label $entry.Label -Recurse))
        }
    }

    return $targets.ToArray()
}

function Grant-RevitMcpManagedPathAccess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [string]$Label = "managed path",
        [string]$Principal = "",
        [switch]$CreateDirectory,
        [switch]$Recurse
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return
    }
    if (-not (Test-RevitMcpAdministrator)) {
        return
    }

    try {
        if ($CreateDirectory) {
            New-Item -ItemType Directory -Path $Path -Force | Out-Null
        }
        elseif (-not (Test-Path -LiteralPath $Path)) {
            return
        }

        $identity = $Principal
        if ([string]::IsNullOrWhiteSpace($identity)) {
            # Machine payload trees are administrator-owned. Never infer the
            # split-token interactive account here, because that would make
            # updater scripts/modules executable by an elevated process while
            # still writable by the unelevated user.
            $identity = "*S-1-5-32-544"
        }
        if ([string]::IsNullOrWhiteSpace($identity)) {
            return
        }

        $grant = if ($Recurse -or $CreateDirectory) { "${identity}:(OI)(CI)M" } else { "${identity}:M" }
        $arguments = @($Path, "/grant", $grant, "/C")
        if ($Recurse) {
            $arguments += "/T"
        }

        $icacls = Join-Path ([Environment]::SystemDirectory) "icacls.exe"
        if (-not (Test-Path -LiteralPath $icacls -PathType Leaf)) {
            throw "icacls.exe was not found at the trusted Windows path: $icacls"
        }
        Write-Host "Permission repair: $Label"
        & $icacls @arguments 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not grant write access to $identity for $Label ($Path). icacls exit code: $LASTEXITCODE"
        }
    }
    catch {
        Write-Warning "Could not grant write access for $Label (${Path}): $($_.Exception.Message)"
    }
}

function Resolve-RevitMcpProfileListImagePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProfileImagePath
    )

    if ([string]::IsNullOrWhiteSpace($ProfileImagePath)) {
        throw "ProfileImagePath is empty."
    }
    $systemDrive = [System.IO.Path]::GetPathRoot([Environment]::SystemDirectory).TrimEnd('\')
    if ([string]::IsNullOrWhiteSpace($systemDrive)) {
        throw "Canonical Windows system drive could not be resolved from SystemDirectory."
    }
    $expanded = [regex]::Replace($ProfileImagePath.Trim(), '(?i)%SystemDrive%', $systemDrive)
    if ($expanded -match '%[^%]+%') {
        throw "ProfileImagePath contains an unsupported environment token: $ProfileImagePath"
    }
    if (-not [System.IO.Path]::IsPathRooted($expanded)) {
        throw "ProfileImagePath must resolve to an absolute path: $ProfileImagePath"
    }
    return [System.IO.Path]::GetFullPath($expanded).TrimEnd('\')
}

function Resolve-RevitMcpInteractiveUserBinding {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetInteractiveUser,
        [Parameter(Mandatory = $true)]
        [string]$TargetInteractiveUserSid,
        [Parameter(Mandatory = $true)]
        [string]$TargetUserProfileRoot,
        [string]$ProfileListRegistryRoot = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList',
        [scriptblock]$AccountLookupOverride = $null
    )

    foreach ($required in @(
            @{ Name = 'TargetInteractiveUser'; Value = $TargetInteractiveUser },
            @{ Name = 'TargetInteractiveUserSid'; Value = $TargetInteractiveUserSid },
            @{ Name = 'TargetUserProfileRoot'; Value = $TargetUserProfileRoot }
        )) {
        if ([string]::IsNullOrWhiteSpace([string]$required.Value)) {
            throw "$($required.Name) is required for the elevated interactive-user binding."
        }
    }

    try {
        $sid = [System.Security.Principal.SecurityIdentifier]::new($TargetInteractiveUserSid.Trim())
    }
    catch {
        throw "TargetInteractiveUserSid is not a valid Windows SID: $TargetInteractiveUserSid"
    }
    if (-not $sid.IsAccountSid()) {
        throw "TargetInteractiveUserSid must be an account SID, not a broad or service identity: $($sid.Value)"
    }

    $isWellKnown = $false
    foreach ($wellKnownType in [Enum]::GetValues([System.Security.Principal.WellKnownSidType])) {
        try {
            if ($sid.IsWellKnown($wellKnownType)) {
                $isWellKnown = $true
                break
            }
        }
        catch {
            # Some framework versions expose sentinel enum values that cannot
            # be passed to IsWellKnown. They do not describe a concrete SID.
        }
    }
    if ($isWellKnown) {
        throw "TargetInteractiveUserSid must not be a well-known or broad identity: $($sid.Value)"
    }

    $account = if ($null -ne $AccountLookupOverride) {
        & $AccountLookupOverride $sid.Value
    }
    else {
        $translated = $sid.Translate([System.Security.Principal.NTAccount]).Value
        $native = [RevAgent.AccountNativeInfo]::Lookup($sid.Value)
        if ([int]$native.SidType -ne 1) {
            throw "TargetInteractiveUserSid resolves to a non-user account type ($($native.SidType)): $($sid.Value)"
        }
        if (-not [string]::Equals([string]$translated, [string]$native.AccountName, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "TargetInteractiveUserSid account resolution was inconsistent. NTAccount='$translated' native='$($native.AccountName)'."
        }
        [pscustomobject]@{
            AccountName = [string]$translated
            SidType = 'User'
        }
    }
    if ($null -eq $account -or [string]::IsNullOrWhiteSpace([string]$account.AccountName)) {
        throw "TargetInteractiveUserSid could not be resolved to an NTAccount user: $($sid.Value)"
    }
    $sidType = [string]$account.SidType
    if (-not ([string]::Equals($sidType, 'User', [System.StringComparison]::OrdinalIgnoreCase) -or $sidType -eq '1')) {
        throw "TargetInteractiveUserSid resolves to a non-user account type ($sidType): $($sid.Value)"
    }
    $resolvedAccount = [string]$account.AccountName
    if (-not [string]::Equals($resolvedAccount, $TargetInteractiveUser.Trim(), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Interactive user account mismatch. SID $($sid.Value) resolves to '$resolvedAccount', not '$TargetInteractiveUser'."
    }

    $profileKey = Join-Path $ProfileListRegistryRoot $sid.Value
    try {
        $profileValue = (Get-ItemProperty -LiteralPath $profileKey -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath
    }
    catch {
        throw "Interactive user SID has no readable ProfileList binding: SID=$($sid.Value) key=$profileKey"
    }
    if ([string]::IsNullOrWhiteSpace([string]$profileValue)) {
        throw "Interactive user ProfileList binding has an empty ProfileImagePath: SID=$($sid.Value)"
    }
    $resolvedProfile = Resolve-RevitMcpProfileListImagePath -ProfileImagePath ([string]$profileValue)
    if ($TargetUserProfileRoot -match '%[^%]+%') {
        throw "TargetUserProfileRoot must be the absolute path captured before elevation and must not contain environment tokens: $TargetUserProfileRoot"
    }
    if (-not [System.IO.Path]::IsPathRooted($TargetUserProfileRoot)) {
        throw "TargetUserProfileRoot must be the absolute path captured before elevation: $TargetUserProfileRoot"
    }
    $expectedProfile = [System.IO.Path]::GetFullPath($TargetUserProfileRoot).TrimEnd('\')
    if (-not [string]::Equals($resolvedProfile, $expectedProfile, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Interactive user profile mismatch. ProfileList resolves SID $($sid.Value) to '$resolvedProfile', not '$expectedProfile'."
    }
    if (-not (Test-Path -LiteralPath $resolvedProfile -PathType Container)) {
        throw "Interactive user ProfileList directory was not found: SID=$($sid.Value) path=$resolvedProfile"
    }

    return [pscustomobject][ordered]@{
        UserName = $resolvedAccount
        Sid = $sid.Value
        ProfileRoot = $resolvedProfile
        SidType = 'User'
        ProfileListKey = $profileKey
    }
}

function Assert-RevitMcpManagedTreeLinkSafe {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")
    if (-not (Test-Path -LiteralPath $fullRoot)) {
        return $fullRoot
    }

    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($fullRoot)
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing managed execution tree containing a reparse point: $($item.FullName)"
        }
        if (-not $item.PSIsContainer) {
            $linkCount = [int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($item.FullName)
            if ($linkCount -ne 1) {
                throw "Refusing managed execution tree containing a hard-linked file (link count $linkCount): $($item.FullName)"
            }
            continue
        }

        foreach ($childPath in [System.IO.Directory]::EnumerateFileSystemEntries($item.FullName)) {
            $child = Get-Item -LiteralPath $childPath -Force -ErrorAction Stop
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing managed execution tree containing a reparse point: $($child.FullName)"
            }
            if ($child.PSIsContainer) {
                $pending.Push($child.FullName)
            }
            else {
                $linkCount = [int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($child.FullName)
                if ($linkCount -ne 1) {
                    throw "Refusing managed execution tree containing a hard-linked file (link count $linkCount): $($child.FullName)"
                }
            }
        }
    }
    return $fullRoot
}

function Assert-RevitMcpImmutableSecurityTree {
    param([Parameter(Mandatory = $true)][string]$Root)
    $fullRoot = Assert-RevitMcpManagedTreeLinkSafe -Root $Root
    if (-not (Test-Path -LiteralPath $fullRoot -PathType Container)) { throw "Immutable revAgent security root was not found: $fullRoot" }
    $trustedOwners = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    $writeMask = [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($item in @((Get-Item -LiteralPath $fullRoot -Force)) + @(Get-ChildItem -LiteralPath $fullRoot -Recurse -Force -ErrorAction Stop)) {
        $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
        $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -notin $trustedOwners) { throw "Immutable revAgent security item has an untrusted owner. path=$($item.FullName) owner=$owner" }
        if (-not $acl.AreAccessRulesProtected) { throw "Immutable revAgent security item must keep a protected DACL: $($item.FullName)" }
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            $sid = [string]$rule.IdentityReference.Value
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $sid -notin $trustedOwners -and (($rule.FileSystemRights -band $writeMask) -ne 0)) {
                throw "Immutable revAgent security item grants write/delete/ACL capability to an untrusted principal. path=$($item.FullName) principal=$sid"
            }
        }
    }
    return $fullRoot
}

function Protect-RevitMcpManagedExecutionTree {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,
        [string]$InteractivePrincipal = "",
        [string[]]$ManagedReparsePaths = @()
    )

    if (-not (Test-RevitMcpAdministrator)) {
        throw "Protecting the revAgent machine execution tree requires administrator rights."
    }

    $root = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\")
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        New-Item -ItemType Directory -Path $root -Force | Out-Null
    }

    $icacls = Join-Path ([Environment]::SystemDirectory) "icacls.exe"
    if (-not (Test-Path -LiteralPath $icacls -PathType Leaf)) {
        throw "icacls.exe was not found: $icacls"
    }

    # Replace, rather than subtract from, the root DACL. This removes writable
    # Everyone, Authenticated Users, custom-group, CREATOR OWNER, and stale
    # interactive-user ACEs that an allowlist of known principals would miss.
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $usersSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($administratorsSid)
    $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow))
    $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($administratorsSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow))
    $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($usersSid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, $inheritance, $propagation, $allow))
    $fileSecurity = [System.Security.AccessControl.FileSecurity]::new()
    $fileSecurity.SetAccessRuleProtection($true, $false)
    $fileSecurity.SetOwner($administratorsSid)
    $fileSecurity.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $allow))
    $fileSecurity.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($administratorsSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $allow))
    $fileSecurity.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($usersSid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, $allow))

    $immutableSecurityRoots = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($leaf in @('bootstrap', 'execution-snapshots', 'broker-state')) {
        $candidate = Join-Path $root $leaf
        if (Test-Path -LiteralPath $candidate -PathType Container) {
            [void](Assert-RevitMcpImmutableSecurityTree -Root $candidate)
            [void]$immutableSecurityRoots.Add([System.IO.Path]::GetFullPath($candidate).TrimEnd('\'))
        }
    }

    # Prior releases intentionally created these two cache-backed node_modules
    # junctions. Unlink only those exact leaves without following their target;
    # all other reparse points remain a hard failure.
    $allowedManagedReparse = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in @(
            (Join-Path $root 'runtime\node_modules'),
            (Join-Path $root 'package\installer\revit-api-docs-mcp\node_modules'),
            (Join-Path $root 'revit-mcp-skill\installer\revit-api-docs-mcp\node_modules')
        ) + @($ManagedReparsePaths)) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            [void]$allowedManagedReparse.Add([System.IO.Path]::GetFullPath($candidate).TrimEnd('\'))
        }
    }

    # Lock directory creation/deletion top-down before any recursive icacls
    # call. Once each parent is protected, a user cannot race a new junction or
    # hardlink into a directory that has already been inspected.
    $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing managed execution root that is a reparse point: $root"
    }
    Set-Acl -LiteralPath $root -AclObject $security -ErrorAction Stop
    $pendingDirectories = [System.Collections.Generic.Stack[string]]::new()
    $pendingDirectories.Push($root)
    while ($pendingDirectories.Count -gt 0) {
        $directory = $pendingDirectories.Pop()
        foreach ($childPath in [System.IO.Directory]::EnumerateFileSystemEntries($directory)) {
            $child = Get-Item -LiteralPath $childPath -Force -ErrorAction Stop
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                $fullChild = [System.IO.Path]::GetFullPath($child.FullName).TrimEnd('\')
                $linkType = if ($child.PSObject.Properties['LinkType']) { [string]$child.LinkType } else { '' }
                if ($child.PSIsContainer -and $linkType -eq 'Junction' -and $allowedManagedReparse.Contains($fullChild)) {
                    [RevAgent.PermissionNativeFileInfo]::RemoveDirectoryLink($fullChild)
                    if (Test-Path -LiteralPath $fullChild) {
                        throw "Managed npm junction could not be unlinked safely: $fullChild"
                    }
                    Write-Host "Removed prior-version managed npm junction before ACL lockdown: $fullChild" -ForegroundColor Yellow
                    continue
                }
                throw "Refusing managed execution tree containing a reparse point: $($child.FullName)"
            }
            if ($child.PSIsContainer) {
                if ($immutableSecurityRoots.Contains([System.IO.Path]::GetFullPath($child.FullName).TrimEnd('\'))) {
                    [void](Assert-RevitMcpImmutableSecurityTree -Root $child.FullName)
                    continue
                }
                Set-Acl -LiteralPath $child.FullName -AclObject $security -ErrorAction Stop
                $pendingDirectories.Push($child.FullName)
            }
            else {
                $linkCount = [int][RevAgent.PermissionNativeFileInfo]::GetLinkCount($child.FullName)
                if ($linkCount -ne 1) {
                    throw "Refusing managed execution tree containing a hard-linked file (link count $linkCount): $($child.FullName)"
                }
                Set-Acl -LiteralPath $child.FullName -AclObject $fileSecurity -ErrorAction Stop
            }
        }
    }

    # Directory topology is now locked. Reject every remaining reparse point
    # and any pre-existing hardlink before recursive owner/ACL normalization.
    [void](Assert-RevitMcpManagedTreeLinkSafe -Root $root)

    & $icacls $root "/setowner" "*S-1-5-32-544" "/T" "/C" "/Q" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to secure revAgent execution-tree ownership (icacls exit $LASTEXITCODE): $root"
    }

    # Normalize descendants to inherit only the protected root ACL. Do not
    # reset the root itself, which would re-import ProgramData's create/write
    # ACE for BUILTIN\Users.
    foreach ($child in @(Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue)) {
        if ($child.PSIsContainer -and $immutableSecurityRoots.Contains([System.IO.Path]::GetFullPath($child.FullName).TrimEnd('\'))) {
            [void](Assert-RevitMcpImmutableSecurityTree -Root $child.FullName)
            continue
        }
        & $icacls $child.FullName "/reset" "/T" "/C" "/Q" | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to normalize revAgent descendant ACLs (icacls exit $LASTEXITCODE): $($child.FullName)"
        }
    }

    [void](Assert-RevitMcpManagedTreeLinkSafe -Root $root)
    foreach ($immutableRoot in $immutableSecurityRoots) { [void](Assert-RevitMcpImmutableSecurityTree -Root $immutableRoot) }

    return $root
}

function Grant-RevitMcpUserStateAccess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorkRoot,
        [string]$InstallRoot = "",
        [Parameter(Mandatory = $true)]
        [string]$InteractivePrincipal
    )

    if (-not (Test-RevitMcpAdministrator)) {
        throw "Granting revAgent user-state access requires administrator rights."
    }
    if ([string]::IsNullOrWhiteSpace($InteractivePrincipal)) {
        throw "InteractivePrincipal is required for the revAgent user-state ACL."
    }

    if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
        $InstallRoot = Split-Path -Parent ([System.IO.Path]::GetFullPath($WorkRoot))
    }
    $roots = @(
        (Join-Path $WorkRoot "logs"),
        (Join-Path $WorkRoot "user-state"),
        (Join-Path $InstallRoot "state"),
        (Join-Path $InstallRoot "addons\usage-intelligence\state"),
        (Join-Path $InstallRoot "addons\dashboard\state")
    )
    foreach ($root in $roots) {
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        Grant-RevitMcpManagedPathAccess -Path $root -Label "revAgent user-writable state" -Principal $InteractivePrincipal -CreateDirectory -Recurse
    }
    return $roots
}

function Invoke-RevitMcpManagedPermissionRepair {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Targets,
        [string]$Principal = ""
    )

    foreach ($target in $Targets) {
        Grant-RevitMcpManagedPathAccess `
            -Path ([string]$target.Path) `
            -Label ([string]$target.Label) `
            -Principal $Principal `
            -CreateDirectory:([bool]$target.CreateDirectory) `
            -Recurse:([bool]$target.Recurse)
    }
}

$revAgentFunctionAliases = @{
    "Resolve-RevAgentInteractiveUserBinding" = "Resolve-RevitMcpInteractiveUserBinding"
    "Get-RevAgentManagedPermissionTargets" = "Get-RevitMcpManagedPermissionTargets"
    "Grant-RevAgentManagedPathAccess" = "Grant-RevitMcpManagedPathAccess"
    "Invoke-RevAgentManagedPermissionRepair" = "Invoke-RevitMcpManagedPermissionRepair"
    "New-RevAgentPermissionTarget" = "New-RevitMcpPermissionTarget"
    "Protect-RevAgentManagedExecutionTree" = "Protect-RevitMcpManagedExecutionTree"
    "Grant-RevAgentUserStateAccess" = "Grant-RevitMcpUserStateAccess"
    "Assert-RevAgentManagedTreeLinkSafe" = "Assert-RevitMcpManagedTreeLinkSafe"
    "Test-RevAgentAdministrator" = "Test-RevitMcpAdministrator"
}
foreach ($aliasPair in $revAgentFunctionAliases.GetEnumerator()) {
    Set-Alias -Name $aliasPair.Key -Value $aliasPair.Value
}

Export-ModuleMember -Function `
    Test-RevitMcpAdministrator, `
    Resolve-RevitMcpInteractiveUserBinding, `
    Assert-RevitMcpManagedTreeLinkSafe, `
    New-RevitMcpPermissionTarget, `
    Get-RevitMcpManagedPermissionTargets, `
    Grant-RevitMcpManagedPathAccess, `
    Invoke-RevitMcpManagedPermissionRepair, `
    Protect-RevitMcpManagedExecutionTree, `
    Grant-RevitMcpUserStateAccess
Export-ModuleMember -Alias @($revAgentFunctionAliases.Keys)
