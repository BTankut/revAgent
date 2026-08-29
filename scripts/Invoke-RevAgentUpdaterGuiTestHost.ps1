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
    [ValidateSet('Valid', 'Malformed', 'Missing', 'ExistingTarget')][string]$AuthorityMode = 'Valid',
    [string]$PoisonMachineRootEnvironment = '',
    [string]$PoisonWindowsRootEnvironment = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Protect-RevAgentOwnedFixtureRoot {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($identity.User)
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in @($identity.User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    }
    if ('System.IO.FileSystemAclExtensions' -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]$item, $acl) }
    else { ([IO.DirectoryInfo]$item).SetAccessControl($acl) }
}

$modulePath = Join-Path $PSScriptRoot 'RevAgent.TestFixtureAuthority.psm1'
if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf)) {
    throw "Test fixture authority module was not found beside the GUI test host: $modulePath"
}
if (-not (Test-Path -LiteralPath $GuiScriptPath -PathType Leaf)) {
    throw "Updater GUI test target was not found: $GuiScriptPath"
}
$guiCommand = Get-Command -Name ([IO.Path]::GetFullPath($GuiScriptPath)) -CommandType ExternalScript -ErrorAction Stop

if (@(Get-Module -Name 'RevAgent.TestFixtureAuthority').Count -ne 0) { throw 'fixture_authority_module_preloaded' }
$fixtureModule = Import-Module -Name $modulePath -Force -PassThru -ErrorAction Stop
if ($null -eq $fixtureModule -or -not [string]::Equals([IO.Path]::GetFullPath([string]$fixtureModule.Path), [IO.Path]::GetFullPath($modulePath), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'fixture_authority_module_identity_refused'
}
Protect-RevAgentOwnedFixtureRoot -Path $FixtureRoot
$authority = $null
$guiExitCode = 0
$savedPoisonedEnvironment = @{}
try {
    $authority = if ($AuthorityMode -in @('Valid', 'ExistingTarget')) {
        $collisionName = if ($AuthorityMode -eq 'ExistingTarget') { 'gui-startup-existing-target.log' } else { '' }
        if ($AuthorityMode -eq 'ExistingTarget') { [IO.File]::WriteAllText((Join-Path $LogDirectory $collisionName), 'must-remain-unchanged', [Text.UTF8Encoding]::new($false)) }
        New-RevAgentGuiLogFixtureAuthority -FixtureRoot $FixtureRoot -LogDirectory $LogDirectory -CollisionLogNameForTest $collisionName
    }
    elseif ($AuthorityMode -eq 'Malformed') {
        [pscustomobject]@{ purpose = 'GuiStartupFailureLog'; fixtureRoot = $FixtureRoot }
    }
    else { $null }
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
    if (-not [string]::IsNullOrWhiteSpace($PoisonWindowsRootEnvironment)) {
        [void][Environment]::SystemDirectory
        foreach ($name in @('WINDIR', 'SystemRoot')) {
            $savedPoisonedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $PoisonWindowsRootEnvironment, 'Process')
        }
    }
    $global:LASTEXITCODE = 0
    & $guiCommand @arguments
    $guiExitCode = [int]$LASTEXITCODE
}
finally {
    foreach ($name in @($savedPoisonedEnvironment.Keys)) { [Environment]::SetEnvironmentVariable($name, $savedPoisonedEnvironment[$name], 'Process') }
    if ($null -ne $authority -and $authority -is [IDisposable]) { $authority.Dispose() }
}

if ($guiExitCode -ne 0) { exit $guiExitCode }
$global:LASTEXITCODE = 0
