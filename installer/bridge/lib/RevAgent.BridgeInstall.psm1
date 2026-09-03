<#
.SYNOPSIS
    Shared primitives for the EU-20/M6 workstation Bridge installer and
    cutover uninstaller (P3-T9/P3-T10, docs/implementation-plan/03-bridge-addin-installer.md).

.DESCRIPTION
    This module intentionally does not duplicate:
      - `installer/lib/RevAgent.DistributionIntegrity.psm1` (RS256 detached
        signature verification, frozen and reused read-only).
      - `installer/lib/RevAgent.Reporting.psm1` (guarded path/atomic-write
        primitives: Get-RevAgentNormalizedFullPath, Assert-RevAgentPathWithinRoot,
        Assert-RevAgentExistingPathNoLink, New-RevAgentGuardedDirectory,
        Write-RevAgentGuardedAtomicBytes).
      - `installer/lib/RevAgent.RevitVersions.psm1` (Resolve-RevitMcpInstallRoot
        Revit-install detection).
      - `installer/lib/RevAgent.CodexRegistration.psm1`
        (Remove-RevitMcpCodexMcpServerConfig for the two managed legacy
        Codex MCP sections).
    It layers new, EU-20-specific logic on top: the P-INST-1 Bridge install/
    state-root layout (mirrors `packages/bridge/src/RevAgent.Bridge.Bootstrap/BridgeInstallLayout.cs`
    field-for-field), the deterministic revAgent.addin manifest for the Bridge
    add-in root (mirrors `installer/install-self-contained.ps1`'s
    `New-RevAgentCanonicalAddinManifestContract`), the M4 enrollment-artifact
    writer (mirrors the exact contract enforced by
    `packages/bridge/src/RevAgent.Bridge/Enrollment/BridgeEnrollmentArtifactConsumer.cs`
    and `WindowsBridgeEnrollmentArtifactSource.cs`), the single guarded
    mutation choke point, and the P-INST-3 uninstall wipe-list/keep-list.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# P-INST-1 layout (mirrors BridgeInstallLayout.cs)
# ---------------------------------------------------------------------------

function Get-RevAgentBridgeLayout {
    [CmdletBinding()]
    param(
        [string]$InstallRoot = (Join-Path $env:ProgramFiles 'revAgent\Bridge'),
        [string]$StateRoot = (Join-Path $env:ProgramData 'revAgent\bridge'),
        [string]$AddinProgramFilesRoot = (Join-Path $env:ProgramFiles 'revAgent\Addin'),
        [string]$RevitAddinsRoot = (Join-Path $env:ProgramData 'Autodesk\Revit\Addins')
    )

    $installRootFull = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    $stateRootFull = [System.IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
    $addinRootFull = [System.IO.Path]::GetFullPath($AddinProgramFilesRoot).TrimEnd('\')
    $revitAddinsRootFull = [System.IO.Path]::GetFullPath($RevitAddinsRoot).TrimEnd('\')
    $credentialDirectory = Join-Path $stateRootFull 'credentials'

    return [pscustomobject][ordered]@{
        InstallRoot            = $installRootFull
        StateRoot               = $stateRootFull
        AddinProgramFilesRoot   = $addinRootFull
        RevitAddinsRoot          = $revitAddinsRootFull
        HostExecutableName      = 'revagent-bridge-host.exe'
        WorkerExecutableName    = 'revagent-bridge.exe'
        ServiceName              = 'revAgentBridge'
        ServiceDisplayName       = 'revAgent Bridge'
        ServiceAccount           = 'LocalSystem'
        HostExecutablePath       = Join-Path $installRootFull 'revagent-bridge-host.exe'
        VersionsRoot             = Join-Path $installRootFull 'versions'
        CurrentWorkerDirectory   = Join-Path (Join-Path $installRootFull 'versions') 'current'
        WorkerExecutablePath     = Join-Path (Join-Path (Join-Path $installRootFull 'versions') 'current') 'revagent-bridge.exe'
        ConfigurationPath        = Join-Path $stateRootFull 'bridge-config.json'
        HostLogDirectory         = Join-Path (Join-Path $stateRootFull 'logs') 'host'
        WorkerLogDirectory       = Join-Path (Join-Path $stateRootFull 'logs') 'worker'
        JournalPath              = Join-Path $stateRootFull 'journal.db'
        CredentialDirectory      = $credentialDirectory
        MachineIdentityPath      = Join-Path $credentialDirectory 'machine-identity.dpapi'
        MachineFingerprintPath   = Join-Path $credentialDirectory 'machine-fingerprint.json'
        DeviceCredentialPath     = Join-Path $credentialDirectory 'device-credential.dpapi'
        AuthDiagnosticPath       = Join-Path $credentialDirectory 'auth-diagnostic.json'
        EnrollmentLockPath       = Join-Path $credentialDirectory 'enrollment.lock'
        BundleExtractionRoot     = Join-Path $stateRootFull 'bundle-extract'
        # New for the installer handoff: the exact file name/location the
        # bridge's WindowsBridgeEnrollmentArtifactSource opens
        # (ExpectedFileName = "enrollment.json").
        EnrollmentArtifactPath   = Join-Path $credentialDirectory 'enrollment.json'
        ReportsDirectory         = Join-Path $stateRootFull 'reports'
    }
}

function Get-RevAgentBridgeAddinLayout {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Layout,
        [Parameter(Mandatory = $true)][string]$RevitVersion
    )

    if ($RevitVersion -notmatch '^[0-9]{4}$') {
        throw "RevitVersion must be a bounded 4-digit year: '$RevitVersion'."
    }

    $addinBinRoot = Join-Path $Layout.AddinProgramFilesRoot $RevitVersion
    $manifestDirectory = Join-Path $Layout.RevitAddinsRoot $RevitVersion
    return [pscustomobject][ordered]@{
        RevitVersion       = $RevitVersion
        AddinBinRoot        = $addinBinRoot
        AssemblyPath         = Join-Path $addinBinRoot 'revAgentPlugin\revAgentPlugin.dll'
        ManifestDirectory    = $manifestDirectory
        ManifestPath         = Join-Path $manifestDirectory 'revAgent.addin'
    }
}

# ---------------------------------------------------------------------------
# Deterministic revAgent.addin manifest
#
# Mirrors installer/install-self-contained.ps1's
# New-RevAgentCanonicalAddinManifestContract (lines ~909-954) byte-for-byte:
# same Name/ClientId/VendorId/FullClassName identity, same UTF8-no-BOM +
# `\n` line-ending construction so the manifest hash is deterministic across
# Windows PowerShell 5.1 and PowerShell 7. Only the assembly path changes,
# because P-INST-1 moves the add-in payload under the new disjoint
# `C:\Program Files\revAgent\Addin\<RevitVersion>\` root. This is a
# deliberate parallel implementation (not a dot-source) because
# install-self-contained.ps1 is a top-level entrypoint script, not an
# importable module, and the legacy installer is reuse-by-convention only,
# never a mutation target for this package.
# ---------------------------------------------------------------------------

function New-RevAgentBridgeAddinManifestContract {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$AssemblyPath
    )

    $canonicalAssemblyPath = [System.IO.Path]::GetFullPath($AssemblyPath)
    $escapedAssembly = [System.Security.SecurityElement]::Escape($canonicalAssemblyPath)
    $content = [string]::Join("`n", @(
            '<?xml version="1.0" encoding="utf-8"?>',
            '<RevitAddIns>',
            '  <AddIn Type="Application">',
            '    <Name>revAgent</Name>',
            "    <Assembly>$escapedAssembly</Assembly>",
            '    <FullClassName>RevAgentPlugin.Core.Application</FullClassName>',
            '    <ClientId>090A4C8C-61DC-426D-87DF-E4BAE0F80EC1</ClientId>',
            '    <VendorId>DPE</VendorId>',
            '    <VendorDescription>DPE internal revAgent add-in</VendorDescription>',
            '  </AddIn>',
            '</RevitAddIns>',
            ''
        ))
    $encoding = [System.Text.UTF8Encoding]::new($false, $true)
    $bytes = $encoding.GetBytes($content)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $sha256 = ([System.BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '')
    }
    finally {
        $algorithm.Dispose()
    }

    return [pscustomobject][ordered]@{
        assemblyPath  = $canonicalAssemblyPath
        clientId       = '090A4C8C-61DC-426D-87DF-E4BAE0F80EC1'
        fullClassName  = 'RevAgentPlugin.Core.Application'
        vendorId       = 'DPE'
        content        = $content
        bytes          = $bytes
        sha256         = $sha256
    }
}

# ---------------------------------------------------------------------------
# Single guarded mutation choke point.
#
# Every machine-mutating action in the installer/uninstaller routes through
# this function. When DryRun is $true, Apply is never invoked -- only a
# 'skipped_dry_run' plan entry is recorded. This is what makes "-WhatIf/dry-run
# performs zero mutations" mechanically true rather than a documentation
# promise: a test can pass an Apply scriptblock that throws, or that
# increments a counter, and assert it never ran under DryRun.
# ---------------------------------------------------------------------------

function Invoke-RevAgentBridgeGuardedMutation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$MutationAction,
        [Parameter(Mandatory = $true)][scriptblock]$Apply,
        [Parameter(Mandatory = $true)][bool]$DryRun,
        [System.Collections.Generic.List[object]]$Steps
    )

    $entry = [ordered]@{
        target = $Target
        action = $MutationAction
        status = 'planned'
        detail = $null
    }

    if ($DryRun) {
        $entry.status = 'skipped_dry_run'
        $record = [pscustomobject]$entry
        if ($null -ne $Steps) { [void]$Steps.Add($record) }
        return $record
    }

    try {
        $result = & $Apply
        $entry.status = 'applied'
        if ($null -ne $result) { $entry.detail = [string]$result }
        $record = [pscustomobject]$entry
        if ($null -ne $Steps) { [void]$Steps.Add($record) }
        return $record
    }
    catch {
        $entry.status = 'failed'
        $entry.detail = $_.Exception.Message
        $record = [pscustomobject]$entry
        if ($null -ne $Steps) { [void]$Steps.Add($record) }
        throw
    }
}

# ---------------------------------------------------------------------------
# P-ENROLL-1 enrollment-token handling + the M4 enrollment-artifact contract.
#
# Field shape, bounds, and error codes mirror
# packages/bridge/src/RevAgent.Bridge.Bootstrap/Enrollment/BridgeEnrollmentToken.cs
# (32..4096 bounded visible-ASCII opaque token) and
# packages/bridge/src/RevAgent.Bridge/Enrollment/BridgeEnrollmentArtifactConsumer.cs
# (contractVersion "revagent.m4-enrollment-artifact/v1", enrollmentToken,
# expiresAtMs; remaining lifetime must be >= 50s and <= 24h+5s at write time
# so the bridge's own independent re-check at consumption time has margin).
# This function fails closed: any out-of-bounds token or expiry throws
# before a single byte is written to disk.
# ---------------------------------------------------------------------------

function Assert-RevAgentBridgeEnrollmentTokenShape {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$EnrollmentToken)

    if ($EnrollmentToken.Length -lt 32 -or $EnrollmentToken.Length -gt 4096) {
        throw "enrollment_token_invalid_length: the enrollment token must be 32-4096 characters."
    }
    foreach ($character in $EnrollmentToken.ToCharArray()) {
        $code = [int]$character
        if ($code -lt 0x21 -or $code -gt 0x7e) {
            throw "enrollment_token_invalid_characters: the enrollment token must be visible ASCII only."
        }
    }
}

function New-RevAgentBridgeEnrollmentArtifactBytes {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$EnrollmentToken,
        [Parameter(Mandatory = $true)][datetime]$ExpiresAtUtc,
        [datetime]$NowUtc = (Get-Date).ToUniversalTime()
    )

    Assert-RevAgentBridgeEnrollmentTokenShape -EnrollmentToken $EnrollmentToken

    $expires = [System.DateTimeOffset]::new($ExpiresAtUtc.ToUniversalTime(), [System.TimeSpan]::Zero)
    $now = [System.DateTimeOffset]::new($NowUtc.ToUniversalTime(), [System.TimeSpan]::Zero)
    $remaining = $expires - $now
    if ($remaining.TotalSeconds -lt 50) {
        throw "enrollment_token_expired_or_too_close: the enrollment token must have at least 50 seconds of remaining lifetime."
    }
    $maximumRemaining = [System.TimeSpan]::FromHours(24) + [System.TimeSpan]::FromSeconds(5)
    if ($remaining -gt $maximumRemaining) {
        throw "enrollment_token_ttl_exceeds_24h: P-ENROLL-1 caps enrollment-token TTL at 24 hours."
    }

    $expiresAtMs = $expires.ToUnixTimeMilliseconds()
    # Deliberately hand-built (not ConvertTo-Json) so the wire bytes are an
    # exact, reviewable match for the bridge's fixed 3-field schema -- no
    # ConvertTo-Json depth/formatting surprises reach a security-critical
    # secret-bearing file.
    $escapedToken = $EnrollmentToken.Replace('\', '\\').Replace('"', '\"')
    $json = '{"contractVersion":"revagent.m4-enrollment-artifact/v1","enrollmentToken":"' + $escapedToken + '","expiresAtMs":' + [string]$expiresAtMs + '}'
    $encoding = [System.Text.UTF8Encoding]::new($false, $true)
    $bytes = $encoding.GetBytes($json)
    if ($bytes.Length -gt 4096) {
        throw "enrollment_artifact_too_large: the enrollment artifact must stay under the bridge's 4096-byte bound."
    }
    return $bytes
}

# ---------------------------------------------------------------------------
# Credential-directory / enrollment-artifact ACL lockdown.
#
# The bridge worker (packages/bridge/src/RevAgent.Bridge/Enrollment/WindowsBridgeEnrollmentArtifactSource.cs
# HasExactNarrowAccess) refuses to read the artifact unless the containing
# directory and file are access-rules-protected (no inheritance), owned by
# the identity that opens them, and carry exactly two explicit FullControl
# Allow ACEs: NT AUTHORITY\SYSTEM and BUILTIN\Administrators (the bridge
# service runs as LocalSystem per BridgeInstallLayout.ServiceAccount, so the
# reading identity's own SID collapses into that SYSTEM entry). Reassigning
# ownership to SYSTEM from an elevated-but-not-SYSTEM installer process
# requires SeRestorePrivilege; rather than hand-rolling
# AdjustTokenPrivileges in PowerShell (the bridge's own
# WindowsRestorePrivilege.cs already owns that natively), this function
# shells out to the standard, auditable `icacls.exe`, which performs the
# same privilege dance under an elevated Administrator token. If icacls
# fails for any reason, this throws -- the guarded mutation records
# 'failed' and the installer aborts rather than leaving a wrongly-ACL'd
# secret-bearing file on disk. The bridge's own independent ACL check is a
# second, fail-closed line of defense even if this were somehow wrong.
# ---------------------------------------------------------------------------

function Set-RevAgentBridgeSystemOnlyAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [scriptblock]$IcaclsInvoker
    )

    if ($null -eq $IcaclsInvoker) {
        $IcaclsInvoker = {
            param([string[]]$Arguments)
            $output = & icacls.exe @Arguments 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw "icacls.exe failed (exit $LASTEXITCODE) for arguments [$($Arguments -join ' ')]: $output"
            }
            return $output
        }
    }

    [void](& $IcaclsInvoker @($Path, '/setowner', 'NT AUTHORITY\SYSTEM', '/Q'))
    [void](& $IcaclsInvoker @($Path, '/inheritance:r', '/Q'))
    [void](& $IcaclsInvoker @($Path, '/grant:r', 'SYSTEM:(F)', '/grant:r', 'BUILTIN\Administrators:(F)', '/Q'))
}

# ---------------------------------------------------------------------------
# Distribution ACL for the install root and the add-in payload/manifest:
# admin-owned (P-INST-1: "binaries in ... (admin-owned)"), protected, with
# SYSTEM+Administrators FullControl plus read-and-execute for interactive
# users -- unlike the credential ACL above, ordinary users must be able to
# read this, because Revit itself (running as the logged-in designer, never
# as SYSTEM) is the process that loads the add-in DLL and parses the
# manifest.
# ---------------------------------------------------------------------------

function Set-RevAgentBridgeDistributionAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [scriptblock]$IcaclsInvoker
    )

    if ($null -eq $IcaclsInvoker) {
        $IcaclsInvoker = {
            param([string[]]$Arguments)
            $output = & icacls.exe @Arguments 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw "icacls.exe failed (exit $LASTEXITCODE) for arguments [$($Arguments -join ' ')]: $output"
            }
            return $output
        }
    }

    [void](& $IcaclsInvoker @($Path, '/inheritance:r', '/Q'))
    [void](& $IcaclsInvoker @(
            $Path,
            '/grant:r', 'SYSTEM:(OI)(CI)F',
            '/grant:r', 'BUILTIN\Administrators:(OI)(CI)F',
            '/grant:r', 'BUILTIN\Users:(OI)(CI)RX',
            '/Q'))
}

# ---------------------------------------------------------------------------
# P-INST-3 rollback anchors (never removed/replaced/rewritten by the
# uninstaller) and the exact uninstall wipe/keep list from the card.
# ---------------------------------------------------------------------------

function Get-RevAgentBridgeRollbackAnchors {
    [CmdletBinding()]
    param([string]$ProgramDataRoot = $env:ProgramData)

    $dpeRevAgentRoot = Join-Path $ProgramDataRoot 'DPE\revAgent'
    return @(
        (Join-Path $dpeRevAgentRoot 'bootstrap'),
        (Join-Path $dpeRevAgentRoot 'prestage\install-revagent-local-bootstrap.ps1'),
        (Join-Path $dpeRevAgentRoot 'updater\config\release-trusted-keys.json')
    )
}

function Get-RevAgentBridgeKeepList {
    [CmdletBinding()]
    param([string]$ProgramDataRoot = $env:ProgramData)

    $anchors = Get-RevAgentBridgeRollbackAnchors -ProgramDataRoot $ProgramDataRoot
    return @($anchors) + @(
        (Join-Path $ProgramDataRoot 'DPE\revAgentOps'),
        (Join-Path $ProgramDataRoot 'DPE\revAgentReleaseSigning'),
        (Join-Path $env:ProgramFiles 'nodejs')
    )
}

function Get-RevAgentBridgeManagedScheduledTaskNames {
    [CmdletBinding()]
    param()

    return @(
        'revAgent Auto Update',
        'Revit MCP Auto Update',
        'revAgent Dashboard Server',
        'revAgent Dashboard Tunnel',
        'revAgent Usage Summary Publish',
        'revAgent Codex Session Context Export'
    )
}

function Get-RevAgentBridgeManagedCodexSectionNames {
    [CmdletBinding()]
    param()

    return @('revAgent', 'revAgent-api-docs')
}

function Get-RevAgentBridgeDirectoryTreeSha256 {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return $null
    }

    $rootFull = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($file in @(Get-ChildItem -LiteralPath $rootFull -File -Recurse -Force | Sort-Object FullName)) {
        $relative = $file.FullName.Substring($rootFull.Length).TrimStart('\').Replace('\', '/')
        $fileHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash
        [void]$lines.Add("$relative`t$fileHash")
    }
    $encoding = [System.Text.UTF8Encoding]::new($false, $true)
    $bytes = $encoding.GetBytes(($lines -join "`n"))
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '')
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-RevAgentBridgeAnchorHashes {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string[]]$Anchors)

    $result = [ordered]@{}
    foreach ($anchor in $Anchors) {
        if (Test-Path -LiteralPath $anchor -PathType Leaf) {
            $result[$anchor] = (Get-FileHash -Algorithm SHA256 -LiteralPath $anchor).Hash
        }
        elseif (Test-Path -LiteralPath $anchor -PathType Container) {
            $result[$anchor] = Get-RevAgentBridgeDirectoryTreeSha256 -Path $anchor
        }
        else {
            $result[$anchor] = $null
        }
    }
    return [pscustomobject]$result
}

# ---------------------------------------------------------------------------
# Recursive wipe planning that structurally cannot select a rollback anchor
# (or anything on the path from Root down to one) for removal: the anchors
# are collected as "keep" first, every ancestor directory of a kept path is
# also implicitly kept, and only paths outside both sets are ever planned
# for deletion. This is the exact mechanism (not merely a filter run after
# the fact) that makes "the uninstaller cannot take ownership of, delete,
# replace, or rewrite these protected rollback anchors" true by
# construction rather than by care.
# ---------------------------------------------------------------------------

function Get-RevAgentBridgeTreeWipePlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string[]]$Anchors = @()
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $plan = [System.Collections.Generic.List[object]]::new()
    if (-not (Test-Path -LiteralPath $rootFull)) {
        return @($plan.ToArray())
    }

    $anchorsFull = @($Anchors | ForEach-Object { [System.IO.Path]::GetFullPath($_).TrimEnd('\') })
    $isKept = {
        param([string]$Path)
        foreach ($anchor in $anchorsFull) {
            if ([string]::Equals($Path, $anchor, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
            if ($anchor.StartsWith($Path + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
            if ($Path.StartsWith($anchor + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
        return $false
    }

    $allItems = @(Get-ChildItem -LiteralPath $rootFull -Recurse -Force -ErrorAction SilentlyContinue)
    $sorted = $allItems | Sort-Object { $_.FullName.Length } -Descending
    foreach ($item in $sorted) {
        $full = $item.FullName
        if (& $isKept $full) {
            $plan.Add([pscustomobject][ordered]@{ path = $full; kind = if ($item.PSIsContainer) { 'directory' } else { 'file' }; disposition = 'kept_anchor' })
        }
        else {
            $plan.Add([pscustomobject][ordered]@{ path = $full; kind = if ($item.PSIsContainer) { 'directory' } else { 'file' }; disposition = 'remove' })
        }
    }

    if (& $isKept $rootFull) {
        $plan.Add([pscustomobject][ordered]@{ path = $rootFull; kind = 'directory'; disposition = 'kept_anchor_ancestor' })
    }
    else {
        $plan.Add([pscustomobject][ordered]@{ path = $rootFull; kind = 'directory'; disposition = 'remove' })
    }

    return @($plan.ToArray())
}

function Invoke-RevAgentBridgeTreeWipePlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object[]]$Plan,
        [Parameter(Mandatory = $true)][bool]$DryRun
    )

    $results = [System.Collections.Generic.List[object]]::new()
    foreach ($item in $Plan) {
        if ($item.disposition -ne 'remove') {
            $results.Add([pscustomobject][ordered]@{ path = $item.path; kind = $item.kind; disposition = $item.disposition })
            continue
        }
        if ($DryRun) {
            $results.Add([pscustomobject][ordered]@{ path = $item.path; kind = $item.kind; disposition = 'would_remove' })
            continue
        }
        try {
            if (Test-Path -LiteralPath $item.path) {
                if ($item.kind -eq 'directory') {
                    # Only ever reached once every kept descendant has already
                    # been excluded from the plan above -- remaining children,
                    # if any, are themselves 'remove' items processed first
                    # because the plan is sorted deepest-path-first.
                    $remainingChildren = @(Get-ChildItem -LiteralPath $item.path -Force -ErrorAction SilentlyContinue)
                    if ($remainingChildren.Count -eq 0) {
                        Remove-Item -LiteralPath $item.path -Force -Recurse:$false -ErrorAction Stop
                    }
                    else {
                        $results.Add([pscustomobject][ordered]@{ path = $item.path; kind = $item.kind; disposition = 'kept_non_empty' })
                        continue
                    }
                }
                else {
                    Remove-Item -LiteralPath $item.path -Force -ErrorAction Stop
                }
            }
            $results.Add([pscustomobject][ordered]@{ path = $item.path; kind = $item.kind; disposition = 'removed' })
        }
        catch {
            $results.Add([pscustomobject][ordered]@{ path = $item.path; kind = $item.kind; disposition = 'failed'; error = $_.Exception.Message })
        }
    }
    return @($results.ToArray())
}

function Get-RevAgentBridgeLegacyRemovalTargets {
    [CmdletBinding()]
    param(
        [string]$ProgramDataRoot = $env:ProgramData,
        [string]$LocalAppDataRoot = $env:LOCALAPPDATA
    )

    return @(
        (Join-Path $ProgramDataRoot 'DPE\revAgent'),
        (Join-Path $ProgramDataRoot 'DPE\RevitMCP'),
        (Join-Path $LocalAppDataRoot 'revit-mcp-plugin')
    )
}

# ---------------------------------------------------------------------------
# Bounded Codex-config edit: structural removal of the exact two managed
# legacy local MCP sections, nothing else. Delegates the actual TOML-section
# surgery to the already-hardened
# installer/lib/RevAgent.CodexRegistration.psm1::Remove-RevitMcpCodexMcpServerConfig
# (reused, not duplicated) and proves byte-identical preservation of every
# other section by diffing before/after with those two sections stripped
# from BOTH sides using the same helper (so any drift anywhere else in the
# file surfaces as a thrown mismatch instead of a silent partial edit).
# ---------------------------------------------------------------------------

function Remove-RevAgentBridgeManagedCodexSections {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][bool]$DryRun
    )

    $sectionNames = Get-RevAgentBridgeManagedCodexSectionNames
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        return [pscustomobject][ordered]@{
            configPath      = $ConfigPath
            existed          = $false
            sectionsRemoved  = @()
            unchangedElsewhere = $true
        }
    }

    $before = Get-Content -Raw -LiteralPath $ConfigPath
    $afterSimulated = $before
    foreach ($name in $sectionNames) {
        $pattern = "(?ms)^\[mcp_servers\.$([regex]::Escape($name))\]\s*.*?(?=^\[|\z)"
        $afterSimulated = [regex]::Replace($afterSimulated, $pattern, '')
    }
    $afterSimulated = [regex]::Replace($afterSimulated, '(\r?\n){3,}', "`r`n`r`n").TrimEnd() + "`r`n"

    $removed = @()
    foreach ($name in $sectionNames) {
        if ($before -match "(?ms)^\[mcp_servers\.$([regex]::Escape($name))\]") {
            $removed += $name
        }
    }

    if ($DryRun) {
        return [pscustomobject][ordered]@{
            configPath          = $ConfigPath
            existed              = $true
            sectionsRemoved      = $removed
            wouldChange          = ($afterSimulated -ne $before)
            unchangedElsewhere   = $true
        }
    }

    foreach ($name in $sectionNames) {
        # Remove-RevitMcpCodexMcpServerConfig -- reused from
        # installer/lib/RevAgent.CodexRegistration.psm1 -- is idempotent and
        # a no-op when the section is already absent.
        [void](Remove-RevitMcpCodexMcpServerConfig -ConfigPath $ConfigPath -Name $name)
    }
    $after = Get-Content -Raw -LiteralPath $ConfigPath

    # Prove the only structural change is the two managed sections: strip
    # them from a copy of $before using the exact same helper and require
    # byte-for-byte equality with $after.
    $beforeWithSectionsStripped = $before
    $tempConfigPath = [System.IO.Path]::GetTempFileName()
    try {
        Set-Content -LiteralPath $tempConfigPath -Value $beforeWithSectionsStripped -Encoding UTF8 -NoNewline
        foreach ($name in $sectionNames) {
            [void](Remove-RevitMcpCodexMcpServerConfig -ConfigPath $tempConfigPath -Name $name)
        }
        $beforeWithSectionsStripped = Get-Content -Raw -LiteralPath $tempConfigPath
    }
    finally {
        Remove-Item -LiteralPath $tempConfigPath -Force -ErrorAction SilentlyContinue
    }

    $unchangedElsewhere = ($after -eq $beforeWithSectionsStripped)
    if (-not $unchangedElsewhere) {
        throw "codex_config_edit_out_of_bounds: the Codex config changed outside the two managed legacy sections; refusing to report success. path=$ConfigPath"
    }

    return [pscustomobject][ordered]@{
        configPath          = $ConfigPath
        existed              = $true
        sectionsRemoved      = $removed
        unchangedElsewhere   = $unchangedElsewhere
    }
}

# ---------------------------------------------------------------------------
# Machine-report emitter (config/bridge-machine-report.schema.json).
# ---------------------------------------------------------------------------

function New-RevAgentBridgeMachineReport {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateSet('install', 'uninstall')][string]$Action,
        [Parameter(Mandatory = $true)][bool]$DryRun,
        [Parameter(Mandatory = $true)][datetime]$StartedAtUtc,
        [Parameter(Mandatory = $true)][datetime]$CompletedAtUtc,
        [Parameter(Mandatory = $true)][ValidateSet('success', 'failed')][string]$Status,
        [string]$Message = '',
        [object[]]$Steps = @(),
        [object]$Install = $null,
        [object]$Uninstall = $null,
        [string[]]$Errors = @()
    )

    return [ordered]@{
        schemaVersion   = 1
        app              = 'revAgent'
        component        = 'bridge'
        action           = $Action
        computerName     = $env:COMPUTERNAME
        userName         = $env:USERNAME
        dryRun           = $DryRun
        status           = $Status
        message          = $Message
        startedAtUtc     = $StartedAtUtc.ToUniversalTime().ToString('o')
        completedAtUtc   = $CompletedAtUtc.ToUniversalTime().ToString('o')
        steps            = @($Steps | ForEach-Object {
                [ordered]@{
                    target = [string]$_.target
                    action = [string]$_.action
                    status = [string]$_.status
                    detail = if ($null -eq $_.detail) { $null } else { [string]$_.detail }
                }
            })
        install          = $Install
        uninstall        = $Uninstall
        errors           = @($Errors)
    }
}

function Write-RevAgentBridgeMachineReport {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Report,
        [Parameter(Mandatory = $true)][string]$ReportsDirectory,
        [Parameter(Mandatory = $true)][bool]$DryRun
    )

    if ($DryRun) {
        return $null
    }

    [void](New-RevAgentGuardedDirectory -Path $ReportsDirectory -GuardRoot $ReportsDirectory)
    $timestamp = ([datetime]::UtcNow).ToString('yyyyMMddTHHmmssZ')
    $fileName = "$($Report.action)-$timestamp.json"
    $path = Join-Path $ReportsDirectory $fileName
    $json = ($Report | ConvertTo-Json -Depth 10)
    $encoding = [System.Text.UTF8Encoding]::new($false, $true)
    [void](Write-RevAgentGuardedAtomicBytes -Path $path -Bytes ($encoding.GetBytes($json)) -GuardRoot $ReportsDirectory)

    $latestPath = Join-Path $ReportsDirectory "$($Report.action)-latest.json"
    [void](Write-RevAgentGuardedAtomicBytes -Path $latestPath -Bytes ($encoding.GetBytes($json)) -GuardRoot $ReportsDirectory)
    return $path
}

Export-ModuleMember -Function `
    Get-RevAgentBridgeLayout, `
    Get-RevAgentBridgeAddinLayout, `
    New-RevAgentBridgeAddinManifestContract, `
    Invoke-RevAgentBridgeGuardedMutation, `
    Assert-RevAgentBridgeEnrollmentTokenShape, `
    New-RevAgentBridgeEnrollmentArtifactBytes, `
    Set-RevAgentBridgeSystemOnlyAcl, `
    Set-RevAgentBridgeDistributionAcl, `
    Get-RevAgentBridgeRollbackAnchors, `
    Get-RevAgentBridgeKeepList, `
    Get-RevAgentBridgeManagedScheduledTaskNames, `
    Get-RevAgentBridgeManagedCodexSectionNames, `
    Get-RevAgentBridgeLegacyRemovalTargets, `
    Get-RevAgentBridgeDirectoryTreeSha256, `
    Get-RevAgentBridgeAnchorHashes, `
    Get-RevAgentBridgeTreeWipePlan, `
    Invoke-RevAgentBridgeTreeWipePlan, `
    Remove-RevAgentBridgeManagedCodexSections, `
    New-RevAgentBridgeMachineReport, `
    Write-RevAgentBridgeMachineReport
