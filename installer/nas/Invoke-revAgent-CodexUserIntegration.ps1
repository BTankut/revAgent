[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [ValidateSet('managed-user-pack', 'preserve-local')]
    [string]$CodexInstructionPolicy = 'managed-user-pack',
    [string]$TargetUserProfileRoot = '',
    [string]$TargetUserSid = '',
    [string]$CodexHome = '',
    [string]$CodexCliPath = '',
    [string]$NodePath = '',
    [string]$RuntimeServerPath = '',
    [string]$DocsServerPath = '',
    [string]$SkillSourcePath = '',
    [string]$AgentsSourcePath = '',
    [string]$ExpectedConfigSha256 = '',
    [switch]$SkipMcpHandshake,
    [switch]$PassThru,
    [switch]$ModulePathSecuritySmokeTest
)

if ("$($ExecutionContext.SessionState.LanguageMode)" -ne 'FullLanguage') {
    Write-Host "revAgent updater cannot run: PowerShell is in $($ExecutionContext.SessionState.LanguageMode) mode."
    Write-Host "This is typically caused by Smart App Control or a WDAC/AppLocker policy on this machine."
    Write-Host "Ask IT to exempt/sign the revAgent deployment scripts or disable Smart App Control, then retry."
    exit 78
}

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RevAgentOsSystemDirectory = [Environment]::SystemDirectory
$script:RevAgentOsProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$script:RevAgentOsProgramFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
$script:RevAgentOsCommonAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)

function Resolve-RevAgentTrustedArchiveManifest {
    param(
        [Parameter(Mandatory = $true)][string]$PsHomeModulesRoot,
        [Parameter(Mandatory = $true)][string[]]$ProgramFilesModuleRoots
    )

    $searchedPaths = [System.Collections.Generic.List[string]]::new()
    $psHomeManifest = [System.IO.Path]::Combine($PsHomeModulesRoot, 'Microsoft.PowerShell.Archive', 'Microsoft.PowerShell.Archive.psd1')
    [void]$searchedPaths.Add($psHomeManifest)
    if ([System.IO.File]::Exists($psHomeManifest)) { return [System.IO.Path]::GetFullPath($psHomeManifest) }

    foreach ($moduleRoot in @($ProgramFilesModuleRoots | Select-Object -Unique)) {
        if ([string]::IsNullOrWhiteSpace($moduleRoot)) { continue }
        $fullModuleRoot = [System.IO.Path]::GetFullPath($moduleRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
        $archiveRoot = [System.IO.Path]::Combine($fullModuleRoot, 'Microsoft.PowerShell.Archive')
        $directManifest = [System.IO.Path]::Combine($archiveRoot, 'Microsoft.PowerShell.Archive.psd1')
        [void]$searchedPaths.Add($directManifest)
        if (-not [System.IO.Directory]::Exists($fullModuleRoot)) { continue }
        if (([System.IO.File]::GetAttributes($fullModuleRoot) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Trusted PowerShell module root is a reparse point: $fullModuleRoot" }
        if (-not [System.IO.Directory]::Exists($archiveRoot)) { continue }
        if (([System.IO.File]::GetAttributes($archiveRoot) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Trusted PowerShell Archive module root is a reparse point: $archiveRoot" }
        if ([System.IO.File]::Exists($directManifest)) { return $directManifest }

        $versionedManifests = [System.Collections.Generic.List[object]]::new()
        foreach ($versionDirectory in [System.IO.Directory]::EnumerateDirectories($archiveRoot)) {
            if (([System.IO.File]::GetAttributes($versionDirectory) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Trusted PowerShell Archive version directory is a reparse point: $versionDirectory" }
            $parsedVersion = $null
            if (-not [version]::TryParse([System.IO.Path]::GetFileName($versionDirectory), [ref]$parsedVersion)) { continue }
            $manifest = [System.IO.Path]::Combine($versionDirectory, 'Microsoft.PowerShell.Archive.psd1')
            [void]$searchedPaths.Add($manifest)
            if ([System.IO.File]::Exists($manifest)) { [void]$versionedManifests.Add([pscustomobject]@{ Version = $parsedVersion; Path = $manifest }) }
        }
        $selected = @($versionedManifests | Sort-Object Version -Descending | Select-Object -First 1)
        if ($selected.Count -eq 1) { return [string]$selected[0].Path }
    }

    throw "Required built-in PowerShell Archive module manifest was not found. Searched paths: $([string]::Join('; ', $searchedPaths.ToArray()))"
}

function Initialize-RevAgentTrustedPowerShellModules {
    # The user phase is unelevated, but its config/skill integrity checks must
    # not autoload a same-name module from Documents or another user root.
    $candidateRoots = [System.Collections.Generic.List[string]]::new()
    $archiveProgramFilesRoots = [System.Collections.Generic.List[string]]::new()
    [void]$candidateRoots.Add([System.IO.Path]::Combine($PSHOME, 'Modules'))
    [void]$candidateRoots.Add([System.IO.Path]::Combine($script:RevAgentOsSystemDirectory, 'WindowsPowerShell', 'v1.0', 'Modules'))
    foreach ($programFilesRoot in @($script:RevAgentOsProgramFiles, $script:RevAgentOsProgramFilesX86)) {
        if ([string]::IsNullOrWhiteSpace($programFilesRoot)) { continue }
        $windowsPowerShellRoot = [System.IO.Path]::Combine($programFilesRoot, 'WindowsPowerShell', 'Modules')
        [void]$candidateRoots.Add($windowsPowerShellRoot)
        [void]$archiveProgramFilesRoots.Add($windowsPowerShellRoot)
        [void]$candidateRoots.Add([System.IO.Path]::Combine($programFilesRoot, 'PowerShell', 'Modules'))
    }

    $trustedRoots = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in $candidateRoots) {
        $fullPath = [System.IO.Path]::GetFullPath($candidate).TrimEnd('\')
        if (-not [System.IO.Directory]::Exists($fullPath) -or -not $seen.Add($fullPath)) { continue }
        if (([System.IO.File]::GetAttributes($fullPath) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Trusted PowerShell module root is a reparse point: $fullPath"
        }
        [void]$trustedRoots.Add($fullPath)
    }
    if ($trustedRoots.Count -eq 0) { throw 'No canonical administrator-owned PowerShell module root was found.' }
    $env:PSModulePath = [string]::Join([System.IO.Path]::PathSeparator, $trustedRoots.ToArray())

    foreach ($moduleName in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security', 'CimCmdlets')) {
        $manifestPath = [System.IO.Path]::Combine($PSHOME, 'Modules', $moduleName, ($moduleName + '.psd1'))
        if (-not [System.IO.File]::Exists($manifestPath)) { throw "Required built-in PowerShell module manifest was not found: $manifestPath" }
        Microsoft.PowerShell.Core\Import-Module -Name $manifestPath -Force -ErrorAction Stop
    }
    $archiveManifestPath = Resolve-RevAgentTrustedArchiveManifest -PsHomeModulesRoot ([System.IO.Path]::Combine($PSHOME, 'Modules')) -ProgramFilesModuleRoots $archiveProgramFilesRoots.ToArray()
    Microsoft.PowerShell.Core\Import-Module -Name $archiveManifestPath -Force -ErrorAction Stop
    return $env:PSModulePath
}

$script:RevAgentTrustedPowerShellModulePath = Initialize-RevAgentTrustedPowerShellModules
if ($ModulePathSecuritySmokeTest) {
    $getAclCommand = Microsoft.PowerShell.Core\Get-Command Get-Acl -CommandType Cmdlet -ErrorAction Stop
    $expandArchiveCommand = Microsoft.PowerShell.Core\Get-Command Expand-Archive -CommandType Function -ErrorAction Stop
    [pscustomobject][ordered]@{
        success = $true
        action = 'module-path-security-smoke-test'
        psModulePath = $env:PSModulePath
        getAclModulePath = [string]$getAclCommand.Module.Path
        expandArchiveModulePath = [string]$expandArchiveCommand.Module.Path
    } | ConvertTo-Json -Compress
    return
}

# This entrypoint is deliberately user-only. Reject elevation before resolving
# or importing the sibling Codex integration module so a repo/Desktop copy can
# never become an administrator code origin.
$earlyUserIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$earlyUserPrincipal = [System.Security.Principal.WindowsPrincipal]::new($earlyUserIdentity)
if ($earlyUserPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Codex user integration must run unelevated before sibling module import. Return to the original interactive user process."
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    if ([string]::IsNullOrWhiteSpace($script:RevAgentOsCommonAppData)) { throw 'Windows CommonApplicationData could not be resolved.' }
    $InstallRoot = [System.IO.Path]::Combine($script:RevAgentOsCommonAppData, 'DPE', 'revAgent')
}

$moduleCandidates = @(
    (Join-Path (Split-Path -Parent $PSScriptRoot) 'lib\RevAgent.CodexRegistration.psm1'),
    (Join-Path $InstallRoot 'package\installer\lib\RevAgent.CodexRegistration.psm1')
)
$modulePath = @($moduleCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)
if ($modulePath.Count -eq 0) {
    throw "revAgent Codex integration module was not found. Checked: $($moduleCandidates -join '; ')"
}
Import-Module $modulePath[0] -Force

$invokeParams = @{
    InstallRoot = $InstallRoot
    CodexInstructionPolicy = $CodexInstructionPolicy
    TargetUserProfileRoot = $TargetUserProfileRoot
    TargetUserSid = $TargetUserSid
    CodexHome = $CodexHome
    CodexCliPath = $CodexCliPath
    NodePath = $NodePath
    RuntimeServerPath = $RuntimeServerPath
    DocsServerPath = $DocsServerPath
    SkillSourcePath = $SkillSourcePath
    AgentsSourcePath = $AgentsSourcePath
    ExpectedConfigSha256 = $ExpectedConfigSha256
    SkipMcpHandshake = $SkipMcpHandshake
}
$result = Invoke-RevAgentCodexUserIntegration @invokeParams
if ($PassThru) { return $result }
$result | ConvertTo-Json -Depth 12
if (-not $result.success) { exit 1 }
