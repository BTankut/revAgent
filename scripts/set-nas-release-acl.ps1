<#
.SYNOPSIS
    Preview, seal, or temporarily unseal the canonical revAgent NAS release tree.

.DESCRIPTION
    The normal state removes write-capable allow ACEs from the release root and
    every item below tools, channels, and releases. The reports subtree is
    protected from release-root inheritance and otherwise preserved for the
    evidence writers already authorized by the NAS administrator.

    Unseal is a bounded publish operation. The release-root owner is the default
    publisher. A temporary publisher-only reports probe must prove the active
    filesystem/SMB session maps to that principal before protected ACL changes.
    Unseal then grants Modify only to that publisher and proves real create/delete
    access at the release root. Seal removes that grant recursively and verifies
    the result.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,

    [ValidateSet("Preview", "Seal", "Unseal")]
    [string]$Mode = "Preview",

    [string]$PublisherPrincipal = "",

    [switch]$ConfirmPublisherWrite,

    [switch]$AllowTestRoot,

    [switch]$OutputJson
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd("\", "/")
$canonicalProductionReleaseRoot = [IO.Path]::GetFullPath("\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy").TrimEnd("\", "/")
$publisherPrincipalSource = if ([string]::IsNullOrWhiteSpace($PublisherPrincipal)) { "release_root_owner" } else { "explicit" }
$publisherSessionProbe = $null
$unsealWriteCanary = $null
$reportsRoot = Join-Path $ReleaseRoot "reports"
$requiredProtectedRoots = @(
    $ReleaseRoot,
    (Join-Path $ReleaseRoot "tools"),
    (Join-Path $ReleaseRoot "channels"),
    (Join-Path $ReleaseRoot "releases")
)
$writeMask = [int64]0
foreach ($right in @(
        [Security.AccessControl.FileSystemRights]::WriteData,
        [Security.AccessControl.FileSystemRights]::AppendData,
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes,
        [Security.AccessControl.FileSystemRights]::WriteAttributes,
        [Security.AccessControl.FileSystemRights]::Delete,
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
        [Security.AccessControl.FileSystemRights]::ChangePermissions,
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    )) {
    $writeMask = $writeMask -bor [int64]$right
}

if (-not ("RevAgent.ReleaseAclNative" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevAgent {
    public static class ReleaseAclNative {
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
            SafeFileHandle handle,
            out BY_HANDLE_FILE_INFORMATION information);

        public static uint GetLinkCount(string path) {
            using (var stream = new System.IO.FileStream(
                path,
                System.IO.FileMode.Open,
                System.IO.FileAccess.Read,
                System.IO.FileShare.ReadWrite | System.IO.FileShare.Delete)) {
                BY_HANDLE_FILE_INFORMATION information;
                if (!GetFileInformationByHandle(stream.SafeFileHandle, out information)) {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
                return information.NumberOfLinks;
            }
        }
    }
}
"@
}

function Test-RevAgentPathEqual {
    param([string]$Left, [string]$Right)
    return [string]::Equals(
        [IO.Path]::GetFullPath($Left).TrimEnd("\", "/"),
        [IO.Path]::GetFullPath($Right).TrimEnd("\", "/"),
        [StringComparison]::OrdinalIgnoreCase)
}

function Get-RevAgentPrincipalSid {
    param([Parameter(Mandatory = $true)][string]$Principal)
    try {
        return [string]([Security.Principal.NTAccount]$Principal).Translate([Security.Principal.SecurityIdentifier]).Value
    }
    catch {
        try { return [string]([Security.Principal.SecurityIdentifier]$Principal).Value }
        catch { throw "Could not resolve ACL principal '$Principal' to a SID." }
    }
}

function Get-RevAgentReleaseRootOwnerPrincipal {
    $acl = Get-Acl -LiteralPath $ReleaseRoot -ErrorAction Stop
    $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier])
    if ($null -eq $ownerSid -or [string]::IsNullOrWhiteSpace([string]$ownerSid.Value)) {
        throw "Could not resolve the release-root owner SID for publisher selection: $ReleaseRoot"
    }
    return [string]$ownerSid.Value
}

function Get-RevAgentRuleSid {
    param([Parameter(Mandatory = $true)][object]$Rule)
    try { return [string]$Rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { return [string]$Rule.IdentityReference.Value }
}

function Test-RevAgentRuleWrites {
    param([Parameter(Mandatory = $true)][object]$Rule)
    return $Rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        (([int64]$Rule.FileSystemRights -band $writeMask) -ne 0)
}

function Get-RevAgentTreeItems {
    param([switch]$ExcludeReports)

    if (-not (Test-Path -LiteralPath $ReleaseRoot)) { return @() }
    $items = [Collections.Generic.List[object]]::new()
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($ReleaseRoot)
    while ($pending.Count -gt 0) {
        $path = $pending.Pop()
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($ExcludeReports -and (Test-RevAgentPathEqual -Left $item.FullName -Right $reportsRoot)) { continue }
        $items.Add($item)
        if ($item.PSIsContainer -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
            foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop)) {
                $pending.Push($child.FullName)
            }
        }
    }
    return @($items)
}

function Get-RevAgentTreeSafetyIssues {
    $issues = [Collections.Generic.List[object]]::new()
    foreach ($item in @(Get-RevAgentTreeItems -ExcludeReports)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) {
            $issues.Add([pscustomobject][ordered]@{ path = $item.FullName; reason = "reparse_or_link"; detail = [string]$item.LinkType })
            continue
        }
        if (-not $item.PSIsContainer) {
            try {
                $linkCount = [int][RevAgent.ReleaseAclNative]::GetLinkCount($item.FullName)
                if ($linkCount -ne 1) {
                    $issues.Add([pscustomobject][ordered]@{ path = $item.FullName; reason = "hardlink"; detail = "linkCount=$linkCount" })
                }
            }
            catch {
                $issues.Add([pscustomobject][ordered]@{ path = $item.FullName; reason = "link_count_failed"; detail = $_.Exception.Message })
            }
        }
    }
    if (Test-Path -LiteralPath $reportsRoot) {
        $reportsItem = Get-Item -LiteralPath $reportsRoot -Force -ErrorAction Stop
        if (($reportsItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not [string]::IsNullOrWhiteSpace([string]$reportsItem.LinkType)) {
            $issues.Add([pscustomobject][ordered]@{ path = $reportsItem.FullName; reason = "reparse_or_link"; detail = [string]$reportsItem.LinkType })
        }
    }
    return @($issues)
}

function Get-RevAgentWriteRules {
    param([Parameter(Mandatory = $true)][string]$Path)
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    return @($acl.Access | Where-Object { Test-RevAgentRuleWrites -Rule $_ } | ForEach-Object {
        [pscustomobject][ordered]@{
            path = $Path
            principal = [string]$_.IdentityReference.Value
            sid = Get-RevAgentRuleSid -Rule $_
            rights = [string]$_.FileSystemRights
            inherited = [bool]$_.IsInherited
        }
    })
}

function Set-RevAgentDaclOnly {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Acl
    )

    # Persisting the original security object may include owner/SACL sections
    # and require SeSecurityPrivilege. Clone only DACL/protection bits and use
    # the framework's DACL-only SetAccessControl path.
    $sections = [Security.AccessControl.AccessControlSections]::Access
    $sddl = $Acl.GetSecurityDescriptorSddlForm($sections)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $dacl = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $dacl.SetSecurityDescriptorSddlForm($sddl, $sections)
    try {
        $aclExtensionsType = "System.IO.FileSystemAclExtensions" -as [type]
        if ($null -ne $aclExtensionsType) {
            if ($item.PSIsContainer) {
                [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]$item, [Security.AccessControl.DirectorySecurity]$dacl)
            }
            else {
                [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.FileInfo]$item, [Security.AccessControl.FileSecurity]$dacl)
            }
        }
        elseif ($item.PSIsContainer) {
            ([System.IO.DirectoryInfo]$item).SetAccessControl([Security.AccessControl.DirectorySecurity]$dacl)
        }
        else {
            ([System.IO.FileInfo]$item).SetAccessControl([Security.AccessControl.FileSecurity]$dacl)
        }
    }
    catch { throw "Failed to persist release DACL for '$Path': $($_.Exception.Message) SDDL=$sddl" }
}

function Invoke-RevAgentCreateDeleteCanary {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    $canaryPath = Join-Path $Directory (".revagent-acl-canary-{0}.tmp" -f [Guid]::NewGuid().ToString("N"))
    $stream = $null
    $created = $false
    $deleted = $false
    try {
        $stream = [IO.File]::Open($canaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $created = $true
        $stream.WriteByte(0x52)
    }
    catch {
        throw "$Purpose CreateNew probe failed: $($_.Exception.Message)"
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }

    try {
        [IO.File]::Delete($canaryPath)
        $deleted = -not (Test-Path -LiteralPath $canaryPath)
    }
    catch {
        throw "$Purpose delete probe failed for '$canaryPath': $($_.Exception.Message)"
    }
    if (-not $deleted) { throw "$Purpose delete probe did not remove '$canaryPath'." }

    return [pscustomobject][ordered]@{
        purpose = $Purpose
        created = $created
        deleted = $deleted
        cleaned = -not (Test-Path -LiteralPath $canaryPath)
    }
}

function Test-RevAgentPublisherSessionMapping {
    param(
        [Parameter(Mandatory = $true)][string]$Principal,
        [Parameter(Mandatory = $true)][string]$PrincipalSid
    )

    $probeRoot = Join-Path $reportsRoot (".publisher-session-probe-{0}" -f [Guid]::NewGuid().ToString("N"))
    $probeError = $null
    $probeResult = $null
    try {
        New-Item -ItemType Directory -Path $probeRoot -ErrorAction Stop | Out-Null
        $probeAcl = [Security.AccessControl.DirectorySecurity]::new()
        $probeAcl.SetAccessRuleProtection($true, $false)
        $probeIdentity = [Security.Principal.SecurityIdentifier]::new($PrincipalSid)
        $probeRule = [Security.AccessControl.FileSystemAccessRule]::new(
            $probeIdentity,
            [Security.AccessControl.FileSystemRights]::Modify,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow)
        [void]$probeAcl.AddAccessRule($probeRule)
        Set-RevAgentDaclOnly -Path $probeRoot -Acl $probeAcl

        $probeWriters = @(Get-RevAgentWriteRules -Path $probeRoot)
        $foreignWriters = @($probeWriters | Where-Object { $_.sid -ne $PrincipalSid })
        if ($probeWriters.Count -eq 0 -or $foreignWriters.Count -ne 0) {
            throw "Publisher session probe ACL was not publisher-only."
        }
        $probeResult = Invoke-RevAgentCreateDeleteCanary -Directory $probeRoot -Purpose "Publisher SMB session mapping"
    }
    catch {
        $probeError = $_
    }
    finally {
        if (Test-Path -LiteralPath $probeRoot) {
            try { Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction Stop }
            catch {
                try {
                    # The active filesystem/SMB session created this directory
                    # and therefore owns it even when it did not map to the
                    # candidate publisher. Restore cleanup rights to the
                    # filesystem-reported probe owner, not the local token SID.
                    $cleanupOwnerSid = (Get-Acl -LiteralPath $probeRoot -ErrorAction Stop).GetOwner([Security.Principal.SecurityIdentifier])
                    $cleanupAcl = [Security.AccessControl.DirectorySecurity]::new()
                    $cleanupAcl.SetAccessRuleProtection($true, $false)
                    $cleanupRule = [Security.AccessControl.FileSystemAccessRule]::new(
                        $cleanupOwnerSid,
                        [Security.AccessControl.FileSystemRights]::FullControl,
                        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
                        [Security.AccessControl.PropagationFlags]::None,
                        [Security.AccessControl.AccessControlType]::Allow)
                    [void]$cleanupAcl.AddAccessRule($cleanupRule)
                    Set-RevAgentDaclOnly -Path $probeRoot -Acl $cleanupAcl
                    Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction Stop
                }
                catch {
                    throw "Publisher session probe cleanup failed for '$probeRoot': $($_.Exception.Message)"
                }
            }
        }
    }
    if ($null -ne $probeError) {
        throw "The current filesystem/SMB session did not map to release publisher '$Principal' ($PrincipalSid). $($probeError.Exception.Message)"
    }
    return [pscustomobject][ordered]@{
        publisherPrincipal = $Principal
        publisherSid = $PrincipalSid
        publisherOnlyModify = $true
        createDelete = $probeResult
        cleaned = -not (Test-Path -LiteralPath $probeRoot)
    }
}

function Remove-RevAgentWriteAllowRules {
    param([Parameter(Mandatory = $true)][string]$Path)

    $current = Get-Acl -LiteralPath $Path -ErrorAction Stop
    if ($current.AreAccessRulesProtected -and @($current.Access | Where-Object { Test-RevAgentRuleWrites -Rule $_ }).Count -eq 0) {
        return
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $acl = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($current.Access)) {
        $remaining = [int64]$rule.FileSystemRights
        if (Test-RevAgentRuleWrites -Rule $rule) { $remaining = $remaining -band (-bnot $writeMask) }
        if ($remaining -eq 0) { continue }
        $replacement = [Security.AccessControl.FileSystemAccessRule]::new(
            $rule.IdentityReference,
            [Security.AccessControl.FileSystemRights]$remaining,
            $rule.InheritanceFlags,
            $rule.PropagationFlags,
            $rule.AccessControlType)
        [void]$acl.AddAccessRule($replacement)
    }
    Set-RevAgentDaclOnly -Path $Path -Acl $acl
}

function Add-RevAgentPublisherWriteRule {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Principal
    )

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $inheritance = if ($item.PSIsContainer) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else { [Security.AccessControl.InheritanceFlags]::None }
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $principalSid = Get-RevAgentPrincipalSid -Principal $Principal
    $principalIdentity = [Security.Principal.SecurityIdentifier]::new($principalSid)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $principalIdentity,
        [Security.AccessControl.FileSystemRights]::Modify,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
    Set-RevAgentDaclOnly -Path $Path -Acl $acl
}

function Protect-RevAgentReportsRoot {
    if (-not (Test-Path -LiteralPath $reportsRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $reportsRoot -Force | Out-Null
    }
    $acl = Get-Acl -LiteralPath $reportsRoot -ErrorAction Stop
    if ($acl.AreAccessRulesProtected) { return }
    $acl.SetAccessRuleProtection($true, $true)
    Set-RevAgentDaclOnly -Path $reportsRoot -Acl $acl
}

function Get-RevAgentReleaseAclState {
    $missing = @($requiredProtectedRoots | Where-Object { -not (Test-Path -LiteralPath $_) })
    $safetyIssues = @(Get-RevAgentTreeSafetyIssues)
    $writeRules = [Collections.Generic.List[object]]::new()
    $unprotectedDaclItems = [Collections.Generic.List[string]]::new()
    if ($safetyIssues.Count -eq 0) {
        foreach ($item in @(Get-RevAgentTreeItems -ExcludeReports)) {
            $itemAcl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
            if (-not [bool]$itemAcl.AreAccessRulesProtected) { $unprotectedDaclItems.Add([string]$item.FullName) }
            foreach ($rule in @(Get-RevAgentWriteRules -Path $item.FullName)) { $writeRules.Add($rule) }
        }
    }
    $reportsAcl = if (Test-Path -LiteralPath $reportsRoot) { Get-Acl -LiteralPath $reportsRoot -ErrorAction Stop } else { $null }
    $reportsWriteRules = if ($null -ne $reportsAcl) { @(Get-RevAgentWriteRules -Path $reportsRoot) } else { @() }
    $publisherSid = if ([string]::IsNullOrWhiteSpace($PublisherPrincipal)) { "" } else { Get-RevAgentPrincipalSid -Principal $PublisherPrincipal }
    $foreignWriteRules = if ([string]::IsNullOrWhiteSpace($publisherSid)) { @($writeRules) } else { @($writeRules | Where-Object { $_.sid -ne $publisherSid }) }
    return [pscustomobject][ordered]@{
        success = $true
        action = "nas-release-acl"
        mode = $Mode.ToLowerInvariant()
        releaseRoot = $ReleaseRoot
        safe = @($safetyIssues).Count -eq 0
        sealed = @($missing).Count -eq 0 -and @($safetyIssues).Count -eq 0 -and @($writeRules).Count -eq 0 -and @($unprotectedDaclItems).Count -eq 0
        unsealedForPublisherOnly = -not [string]::IsNullOrWhiteSpace($publisherSid) -and @($writeRules).Count -gt 0 -and @($foreignWriteRules).Count -eq 0
        publisherPrincipal = $PublisherPrincipal
        publisherSid = $publisherSid
        publisherPrincipalSource = $publisherPrincipalSource
        publisherSessionProbe = $publisherSessionProbe
        unsealWriteCanary = $unsealWriteCanary
        missingProtectedRoots = @($missing)
        safetyIssues = @($safetyIssues)
        protectedWriteRules = @($writeRules)
        allProtectedDaclsProtected = @($unprotectedDaclItems).Count -eq 0
        unprotectedDaclItems = @($unprotectedDaclItems)
        reportsPreserved = $null -ne $reportsAcl
        reportsAclProtected = $null -ne $reportsAcl -and [bool]$reportsAcl.AreAccessRulesProtected
        reportsWritableEvidence = @($reportsWriteRules).Count -gt 0
        reportsWriteRules = @($reportsWriteRules)
    }
}

if ($AllowTestRoot) {
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
    if ($ReleaseRoot.StartsWith("\\", [StringComparison]::Ordinal) -or
        -not $ReleaseRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "AllowTestRoot is limited to disposable local fixtures below the current TEMP directory."
    }
}
elseif (-not [string]::Equals($ReleaseRoot, $canonicalProductionReleaseRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "ReleaseRoot must exactly match the canonical production root '$canonicalProductionReleaseRoot'. Pass -AllowTestRoot only for disposable local fixtures."
}

if ($Mode -eq "Preview") {
    if (-not (Test-Path -LiteralPath $ReleaseRoot -PathType Container)) {
        $preview = [pscustomobject][ordered]@{ success = $true; action = "nas-release-acl"; mode = "preview"; releaseRoot = $ReleaseRoot; safe = $true; sealed = $false; unsealedForPublisherOnly = $false; publisherPrincipal = $PublisherPrincipal; publisherSid = ""; publisherPrincipalSource = $publisherPrincipalSource; publisherSessionProbe = $null; unsealWriteCanary = $null; missingProtectedRoots = @($requiredProtectedRoots); safetyIssues = @(); protectedWriteRules = @(); allProtectedDaclsProtected = $false; unprotectedDaclItems = @(); reportsPreserved = $false; reportsAclProtected = $false; reportsWritableEvidence = $false; reportsWriteRules = @() }
    }
    else {
        if ([string]::IsNullOrWhiteSpace($PublisherPrincipal)) { $PublisherPrincipal = Get-RevAgentReleaseRootOwnerPrincipal }
        $preview = Get-RevAgentReleaseAclState
    }
    if ($OutputJson) { $preview | ConvertTo-Json -Depth 12 } else { $preview }
    return
}

if ($Mode -eq "Unseal" -and -not $ConfirmPublisherWrite) {
    throw "Unseal requires -ConfirmPublisherWrite for the approved manual publish window."
}

if (-not (Test-Path -LiteralPath $ReleaseRoot -PathType Container)) {
    if ($Mode -ne "Unseal") { throw "ReleaseRoot was not found: $ReleaseRoot" }
    New-Item -ItemType Directory -Path $ReleaseRoot -Force | Out-Null
}
if ([string]::IsNullOrWhiteSpace($PublisherPrincipal)) {
    $PublisherPrincipal = Get-RevAgentReleaseRootOwnerPrincipal
}
$publisherSid = Get-RevAgentPrincipalSid -Principal $PublisherPrincipal

# Inspect the existing tree before creating any child paths, then inspect it
# again before ACL recursion. This avoids traversing or provisioning through an
# attacker-controlled reparse root and narrows the normal TOCTOU window.
$issues = @(Get-RevAgentTreeSafetyIssues)
if ($issues.Count -gt 0) {
    $summary = @($issues | ForEach-Object { "$($_.reason):$($_.path)" }) -join "; "
    throw "Refusing recursive NAS release ACL mutation because unsafe filesystem links were found. $summary"
}
foreach ($path in $requiredProtectedRoots | Select-Object -Skip 1) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
}
if (-not (Test-Path -LiteralPath $reportsRoot -PathType Container)) { New-Item -ItemType Directory -Path $reportsRoot -Force | Out-Null }

$issues = @(Get-RevAgentTreeSafetyIssues)
if ($issues.Count -gt 0) {
    $summary = @($issues | ForEach-Object { "$($_.reason):$($_.path)" }) -join "; "
    throw "Refusing recursive NAS release ACL mutation because unsafe filesystem links were found. $summary"
}

$publisherSessionProbe = Test-RevAgentPublisherSessionMapping -Principal $PublisherPrincipal -PrincipalSid $publisherSid
Protect-RevAgentReportsRoot
$protectedItems = @(Get-RevAgentTreeItems -ExcludeReports)
if ($Mode -eq "Seal") {
    $orderedItems = @($protectedItems | Sort-Object { $_.FullName.Length } -Descending)
    foreach ($item in $orderedItems) { Remove-RevAgentWriteAllowRules -Path $item.FullName }
    $result = Get-RevAgentReleaseAclState
    if (-not $result.sealed) { throw "NAS release ACL seal verification failed; protected write ACEs remain." }
}
else {
    $orderedItems = @($protectedItems | Sort-Object { $_.FullName.Length })
    foreach ($item in $orderedItems) { Remove-RevAgentWriteAllowRules -Path $item.FullName }
    foreach ($item in $orderedItems) { Add-RevAgentPublisherWriteRule -Path $item.FullName -Principal $PublisherPrincipal }
    $unsealWriteCanary = Invoke-RevAgentCreateDeleteCanary -Directory $ReleaseRoot -Purpose "Unsealed release-root publisher write"
    $result = Get-RevAgentReleaseAclState
    if (-not $result.safe -or -not $result.unsealedForPublisherOnly -or -not $result.allProtectedDaclsProtected -or
        -not [bool]$result.unsealWriteCanary.created -or -not [bool]$result.unsealWriteCanary.deleted) {
        throw "NAS release ACL unseal verification failed; publisher-only ACL or effective write/delete evidence is missing."
    }
}

if ($OutputJson) { $result | ConvertTo-Json -Depth 12 } else { $result }
