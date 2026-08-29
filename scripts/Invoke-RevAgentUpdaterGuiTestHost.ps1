<#
.SYNOPSIS
    Test-only same-process host for the updater GUI fixture authority.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$GuiScriptPath,
    [Parameter(Mandatory = $true)][string]$FixtureRoot,
    [Parameter(Mandatory = $true)][string]$LogDirectory,
    [string]$ChannelManifestPath = '',
    [string]$InstallRoot = '',
    [string]$BootstrapStatePath = '',
    [switch]$SmokeTest,
    [switch]$ModulePathSecuritySmokeTest,
    [switch]$PreWindowBootstrapSmokeTest,
    [switch]$SuppressStartupFailureDialogForTest,
    [string]$TestStartupFailureMessage = '',
    [ValidateSet('Valid', 'Malformed')][string]$AuthorityMode = 'Valid',
    [string]$PoisonMachineRootEnvironment = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$modulePath = Join-Path $PSScriptRoot 'RevAgent.TestFixtureAuthority.psm1'
if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf)) {
    throw "Test fixture authority module was not found beside the GUI test host: $modulePath"
}
if (-not (Test-Path -LiteralPath $GuiScriptPath -PathType Leaf)) {
    throw "Updater GUI test target was not found: $GuiScriptPath"
}

Import-Module -Name $modulePath -Force -ErrorAction Stop
$authority = $null
$guiExitCode = 0
$savedPoisonedEnvironment = @{}
try {
    $authority = if ($AuthorityMode -eq 'Valid') {
        New-RevAgentGuiLogFixtureAuthority -FixtureRoot $FixtureRoot -LogDirectory $LogDirectory
    }
    else {
        [pscustomobject]@{ purpose = 'GuiStartupFailureLog'; fixtureRoot = $FixtureRoot }
    }
    $arguments = @{
        ChannelManifestPath = $ChannelManifestPath
        InstallRoot = $InstallRoot
        BootstrapStatePath = $BootstrapStatePath
        TestFixtureAuthority = $authority
    }
    if ($SmokeTest) { $arguments.SmokeTest = $true }
    if ($ModulePathSecuritySmokeTest) { $arguments.ModulePathSecuritySmokeTest = $true }
    if ($PreWindowBootstrapSmokeTest) { $arguments.PreWindowBootstrapSmokeTest = $true }
    if ($SuppressStartupFailureDialogForTest) { $arguments.SuppressStartupFailureDialogForTest = $true }
    if (-not [string]::IsNullOrWhiteSpace($TestStartupFailureMessage)) { $arguments.TestStartupFailureMessage = $TestStartupFailureMessage }
    if (-not [string]::IsNullOrWhiteSpace($PoisonMachineRootEnvironment)) {
        # Match the production process shape: canonical roots are resolved from
        # Windows before an inherited-variable poisoning attempt occurs.
        [void][Environment]::SystemDirectory
        foreach ($folder in @([Environment+SpecialFolder]::ProgramFiles, [Environment+SpecialFolder]::ProgramFilesX86, [Environment+SpecialFolder]::CommonApplicationData)) {
            [void][Environment]::GetFolderPath($folder)
        }
        foreach ($name in @('ProgramFiles','ProgramFiles(x86)','ProgramData','CommonProgramFiles','CommonProgramFiles(x86)','USERPROFILE','LOCALAPPDATA','APPDATA','SystemDrive','OS')) {
            $savedPoisonedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, (Join-Path $PoisonMachineRootEnvironment ($name -replace '[^A-Za-z0-9]', '_')), 'Process')
        }
        $env:OS = 'not-windows'
    }
    $global:LASTEXITCODE = 0
    & $GuiScriptPath @arguments
    $guiExitCode = [int]$LASTEXITCODE
}
finally {
    foreach ($name in @($savedPoisonedEnvironment.Keys)) { [Environment]::SetEnvironmentVariable($name, $savedPoisonedEnvironment[$name], 'Process') }
    if ($null -ne $authority -and $authority -is [IDisposable]) { $authority.Dispose() }
}

if ($guiExitCode -ne 0) { exit $guiExitCode }
$global:LASTEXITCODE = 0
