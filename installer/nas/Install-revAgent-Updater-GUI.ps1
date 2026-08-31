<#
.SYNOPSIS
    Simple GUI for installing or updating the revAgent standard user package.
#>

[CmdletBinding()]
param(
    [string]$ChannelManifestPath = "",
    [string]$InstallRoot = "",
    [string]$BootstrapStatePath = "",
    [switch]$SmokeTest,
    [switch]$ModulePathSecuritySmokeTest,
    [Parameter(DontShow = $true)][switch]$PreWindowBootstrapSmokeTest,
    [Parameter(DontShow = $true)][switch]$SuppressStartupFailureDialogForTest,
    [Parameter(DontShow = $true)][string]$TestStartupFailureMessage = "",
    [Parameter(DontShow = $true)][object]$TestFixtureAuthority = $null,
    [Parameter(DontShow = $true)][object]$TestFixtureModuleInfo = $null,
    [Parameter(DontShow = $true)][object]$TestFixtureHostProvenance = $null
)

if ("$($ExecutionContext.SessionState.LanguageMode)" -ne 'FullLanguage') {
    Write-Host "revAgent updater cannot run: PowerShell is in $($ExecutionContext.SessionState.LanguageMode) mode."
    Write-Host "This is typically caused by Smart App Control or a WDAC/AppLocker policy on this machine."
    Write-Host "Ask IT to exempt/sign the revAgent deployment scripts or disable Smart App Control, then retry."
    exit 78
}

$ErrorActionPreference = "Stop"
$script:GuiStartupCompleted = $false
$script:ExpectedFixtureHostSha256 = '2c6ab614fc33c1bed2e878c8f3a6c6fcfdc10176aa7470b0703f49519c3d646c'
$script:ExpectedFixtureModuleSha256 = 'b21d81ae3ad015b82535ce449454b89ad5cc2fc1d8c9cd0a47820c4a5d6293cc'

function Get-RevAgentTestFixtureOwnership {
    param(
        [Parameter(Mandatory = $true)][object]$Authority,
        [Parameter(Mandatory = $true)][object]$ModuleInfo,
        [Parameter(Mandatory = $true)][object]$HostProvenance
    )

    if ($null -eq $ModuleInfo -or $null -eq $HostProvenance -or
        $ModuleInfo -isnot [Management.Automation.PSModuleInfo] -or
        $ModuleInfo.ModuleType -ne [Management.Automation.ModuleType]::Script -or
        -not [string]::Equals([string]$ModuleInfo.Name, 'RevAgent.TestFixtureAuthority', [StringComparison]::Ordinal) -or
        [IO.Path]::GetFileName([string]$ModuleInfo.Path) -ne 'RevAgent.TestFixtureAuthority.psm1') {
        throw 'revagent_test_fixture_authority_provenance_refused'
    }
    $ownership = $ModuleInfo.SessionState.PSVariable.GetValue('RevAgentFixtureOwnership')
    $authorityType = $ModuleInfo.SessionState.PSVariable.GetValue('RevAgentFixtureAuthorityType')
    $assemblyLocation = try { [string]$Authority.GetType().Assembly.Location } catch { '__unavailable__' }
    $binding = [Reflection.BindingFlags]'Instance,NonPublic'
    $ownershipNonce = if ($null -ne $ownership) { $ownership.GetType().GetField('nonce', $binding).GetValue($ownership) } else { $null }
    $exactAuthorityType = $null -ne $authorityType -and [object]::ReferenceEquals($Authority.GetType(), $authorityType)
    $authorityNonceValid = $exactAuthorityType -and $null -ne $ownershipNonce -and [bool]$Authority.GetType().GetMethod('OwnsNonce', $binding).Invoke($Authority, @($ownershipNonce))
    $authorityProvenanceValid = $exactAuthorityType -and [bool]$Authority.GetType().GetMethod('MatchesProvenance', $binding).Invoke($Authority, @($ModuleInfo, $HostProvenance, 'GuiStartupFailureLog'))
    if ($null -eq $ownership -or $null -eq $authorityType -or -not $ownership.GetType().IsPublic -or -not $ownership.GetType().IsSealed -or
        -not [object]::ReferenceEquals($ownership.ModuleInfo, $ModuleInfo) -or
        -not [object]::ReferenceEquals($Authority.GetType(), $authorityType) -or
        -not [object]::ReferenceEquals($Authority.GetType().Assembly, $ownership.ImplementationAssembly) -or
        -not [object]::ReferenceEquals($Authority.GetType().Module, $ownership.ImplementationModule) -or
        -not [object]::ReferenceEquals($ownership.AuthorityType, $authorityType) -or
        $ownership.ModuleVersionId -ne $Authority.GetType().Module.ModuleVersionId -or
        -not [string]::Equals([string]$ownership.ModuleSha256, $script:ExpectedFixtureModuleSha256, [StringComparison]::OrdinalIgnoreCase) -or
        [bool]$ownership.AssemblyIsDynamic -ne [bool]$Authority.GetType().Assembly.IsDynamic -or -not [string]::IsNullOrEmpty($assemblyLocation) -or
        -not [bool]$HostProvenance.VerifyConsumer($script:ExpectedFixtureHostSha256, $script:ExpectedFixtureModuleSha256, $ModuleInfo, 'Gui') -or
        -not $authorityNonceValid -or -not $authorityProvenanceValid) {
        throw 'revagent_test_fixture_authority_provenance_refused'
    }
    $sameTypes = @([AppDomain]::CurrentDomain.GetAssemblies() | ForEach-Object { $_.GetType($Authority.GetType().FullName, $false, $false) } | Where-Object { $null -ne $_ })
    $legacyTypes = @([AppDomain]::CurrentDomain.GetAssemblies() | ForEach-Object { $_.GetType('RevAgent.TestFixtures.RevAgentTestFixtureAuthority', $false, $false) } | Where-Object { $null -ne $_ })
    if ($sameTypes.Count -ne 1 -or $legacyTypes.Count -ne 0) { throw 'revagent_test_fixture_authority_provenance_refused' }
    return $ownership
}

function Write-RevAgentGuiStartupFailure {
    param([Parameter(Mandatory = $true)][Management.Automation.ErrorRecord]$ErrorRecord)

    $logPath = ""
    $logWriteError = ""
    $fixtureLease = $null
    try {
        if ($null -ne $TestFixtureAuthority) {
            if (-not ($SmokeTest -or $PreWindowBootstrapSmokeTest -or $SuppressStartupFailureDialogForTest -or -not [string]::IsNullOrWhiteSpace($TestStartupFailureMessage))) {
                throw 'Test fixture authority is accepted only by explicit smoke/test modes.'
            }
            [void](Get-RevAgentTestFixtureOwnership -Authority $TestFixtureAuthority -ModuleInfo $TestFixtureModuleInfo -HostProvenance $TestFixtureHostProvenance)
            $fixtureLease = $TestFixtureAuthority.ConsumeGuiStartupFailureLog()
        }
        else {
            $localAppDataRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
            if ([string]::IsNullOrWhiteSpace($localAppDataRoot)) { throw 'Windows LocalApplicationData could not be resolved.' }
            $logDirectory = [IO.Path]::Combine($localAppDataRoot, 'DPE', 'revAgent', 'logs')
            [void][IO.Directory]::CreateDirectory($logDirectory)
        }
        $lines = [System.Collections.Generic.List[string]]::new()
        [void]$lines.Add('revAgent GUI startup failure')
        [void]$lines.Add('timestampUtc=' + [DateTime]::UtcNow.ToString('o'))
        [void]$lines.Add('languageMode=' + [string]$ExecutionContext.SessionState.LanguageMode)
        [void]$lines.Add('psVersion=' + [string]$PSVersionTable.PSVersion)
        [void]$lines.Add('psEdition=' + [string]$PSVersionTable.PSEdition)
        $clrVersion = if ($PSVersionTable.ContainsKey('CLRVersion')) { [string]$PSVersionTable.CLRVersion } else { [string][Environment]::Version }
        [void]$lines.Add('clrVersion=' + $clrVersion)
        [void]$lines.Add('error=' + [string]$ErrorRecord)
        [void]$lines.Add('category=' + [string]$ErrorRecord.CategoryInfo)
        [void]$lines.Add('position=' + [string]$ErrorRecord.InvocationInfo.PositionMessage)
        [void]$lines.Add('scriptStackTrace=' + [string]$ErrorRecord.ScriptStackTrace)
        if ($null -ne $ErrorRecord.Exception) { [void]$lines.Add('exception=' + $ErrorRecord.Exception.ToString()) }
        if ($null -ne $TestFixtureAuthority) {
            $logPath = [string]$fixtureLease.WriteStartupFailureLog($lines.ToArray())
        }
        else {
            $logName = 'gui-startup-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff') + '-' + [Guid]::NewGuid().ToString('N') + '.log'
            $logPath = [IO.Path]::Combine($logDirectory, $logName)
            [IO.File]::WriteAllLines($logPath, $lines.ToArray(), [Text.UTF8Encoding]::new($false))
        }
    }
    catch {
        $logWriteError = $_.Exception.Message
        $logPath = ""
    }
    finally {
        if ($null -ne $fixtureLease) { $fixtureLease.Dispose() }
        if ($null -ne $TestFixtureAuthority -and $TestFixtureAuthority -is [IDisposable]) { $TestFixtureAuthority.Dispose() }
    }

    $summary = if ([string]::IsNullOrWhiteSpace($logPath)) {
        "revAgent could not start the updater window. Startup error: $ErrorRecord"
    }
    else {
        "revAgent could not start the updater window. Diagnostic log: $logPath"
    }
    if (-not [string]::IsNullOrWhiteSpace($logWriteError)) { $summary += " Log write error: $logWriteError" }
    try { [Console]::Error.WriteLine($summary) } catch { }
    if (-not $SmokeTest -and -not $PreWindowBootstrapSmokeTest -and -not $SuppressStartupFailureDialogForTest -and [string]::IsNullOrWhiteSpace($TestStartupFailureMessage)) {
        try {
            [void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')
            [void][System.Windows.Forms.MessageBox]::Show(
                $summary,
                'revAgent startup error',
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Error)
        }
        catch { }
    }
    return $logPath
}

$fixtureAuthorityPreflightError = ''
try {
    $fixtureTupleCount = @(@($TestFixtureAuthority, $TestFixtureModuleInfo, $TestFixtureHostProvenance) | Where-Object { $null -ne $_ }).Count
    if ($fixtureTupleCount -ne 0 -and $fixtureTupleCount -ne 3) {
        $fixtureAuthorityPreflightError = 'revagent_test_fixture_authority_provenance_refused'
    }
    if ($null -ne $TestFixtureAuthority) {
        if (-not ($SmokeTest -or $PreWindowBootstrapSmokeTest -or $SuppressStartupFailureDialogForTest -or -not [string]::IsNullOrWhiteSpace($TestStartupFailureMessage))) {
            $fixtureAuthorityPreflightError = 'revagent_test_fixture_authority_mode_refused'
        }
        elseif ([string]::IsNullOrWhiteSpace($fixtureAuthorityPreflightError)) {
            [void](Get-RevAgentTestFixtureOwnership -Authority $TestFixtureAuthority -ModuleInfo $TestFixtureModuleInfo -HostProvenance $TestFixtureHostProvenance)
        }
    }
    elseif (-not [string]::IsNullOrWhiteSpace($TestStartupFailureMessage)) {
        $fixtureAuthorityPreflightError = 'revagent_test_fixture_authority_required'
    }
}
catch { $fixtureAuthorityPreflightError = $_.Exception.Message }
if (-not [string]::IsNullOrWhiteSpace($fixtureAuthorityPreflightError)) {
    try { [Console]::Error.WriteLine($fixtureAuthorityPreflightError) } catch { }
    exit 1
}

trap {
    $startupError = $_
    if (-not $script:GuiStartupCompleted) {
        [void](Write-RevAgentGuiStartupFailure -ErrorRecord $startupError)
        exit 1
    }
    throw $startupError
}

$scriptDir = $PSScriptRoot
$osSystemDirectory = [Environment]::SystemDirectory
$osProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$osProgramFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)

function Resolve-RevAgentTrustedArchiveManifest {
    param(
        [Parameter(Mandatory = $true)][string]$PsHomeModulesRoot,
        [Parameter(Mandatory = $true)][string[]]$ProgramFilesModuleRoots
    )

    $searchedPaths = [System.Collections.Generic.List[string]]::new()
    $psHomeManifest = [System.IO.Path]::Combine($PsHomeModulesRoot, 'Microsoft.PowerShell.Archive', 'Microsoft.PowerShell.Archive.psd1')
    [void]$searchedPaths.Add($psHomeManifest)
    if ([System.IO.File]::Exists($psHomeManifest)) {
        return [System.IO.Path]::GetFullPath($psHomeManifest)
    }

    foreach ($moduleRoot in @($ProgramFilesModuleRoots | Select-Object -Unique)) {
        if ([string]::IsNullOrWhiteSpace($moduleRoot)) { continue }
        $fullModuleRoot = [System.IO.Path]::GetFullPath($moduleRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
        $archiveRoot = [System.IO.Path]::Combine($fullModuleRoot, 'Microsoft.PowerShell.Archive')
        $directManifest = [System.IO.Path]::Combine($archiveRoot, 'Microsoft.PowerShell.Archive.psd1')
        [void]$searchedPaths.Add($directManifest)
        if (-not [System.IO.Directory]::Exists($fullModuleRoot)) { continue }
        if (([System.IO.File]::GetAttributes($fullModuleRoot) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Trusted PowerShell module root is a reparse point: $fullModuleRoot"
        }
        if (-not [System.IO.Directory]::Exists($archiveRoot)) { continue }
        if (([System.IO.File]::GetAttributes($archiveRoot) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Trusted PowerShell Archive module root is a reparse point: $archiveRoot"
        }
        if ([System.IO.File]::Exists($directManifest)) { return $directManifest }

        $versionedManifests = [System.Collections.Generic.List[object]]::new()
        foreach ($versionDirectory in [System.IO.Directory]::EnumerateDirectories($archiveRoot)) {
            if (([System.IO.File]::GetAttributes($versionDirectory) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Trusted PowerShell Archive version directory is a reparse point: $versionDirectory"
            }
            $parsedVersion = $null
            if (-not [version]::TryParse([System.IO.Path]::GetFileName($versionDirectory), [ref]$parsedVersion)) { continue }
            $manifest = [System.IO.Path]::Combine($versionDirectory, 'Microsoft.PowerShell.Archive.psd1')
            [void]$searchedPaths.Add($manifest)
            if ([System.IO.File]::Exists($manifest)) {
                [void]$versionedManifests.Add([pscustomobject]@{ Version = $parsedVersion; Path = $manifest })
            }
        }
        $selected = @($versionedManifests | Sort-Object Version -Descending | Select-Object -First 1)
        if ($selected.Count -eq 1) { return [string]$selected[0].Path }
    }

    throw "Required built-in PowerShell Archive module manifest was not found. Searched paths: $([string]::Join('; ', $searchedPaths.ToArray()))"
}

function Initialize-GuiTrustedPowerShellModules {
    # The RunAs child inherits this process environment. Sanitize it here and
    # require each child entrypoint to repeat the same bootstrap independently.
    $candidateRoots = [System.Collections.Generic.List[string]]::new()
    $archiveProgramFilesRoots = [System.Collections.Generic.List[string]]::new()
    [void]$candidateRoots.Add([System.IO.Path]::Combine($PSHOME, 'Modules'))
    [void]$candidateRoots.Add([System.IO.Path]::Combine($osSystemDirectory, 'WindowsPowerShell', 'v1.0', 'Modules'))
    foreach ($programFilesRoot in @($osProgramFiles, $osProgramFilesX86)) {
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
    $scheduledTasksManifest = [System.IO.Path]::Combine($osSystemDirectory, 'WindowsPowerShell', 'v1.0', 'Modules', 'ScheduledTasks', 'ScheduledTasks.psd1')
    if (-not [System.IO.File]::Exists($scheduledTasksManifest)) { throw "Required ScheduledTasks module manifest was not found: $scheduledTasksManifest" }
    Microsoft.PowerShell.Core\Import-Module -Name $scheduledTasksManifest -Force -ErrorAction Stop
    return $env:PSModulePath
}

$script:RevAgentTrustedPowerShellModulePath = Initialize-GuiTrustedPowerShellModules
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
if (-not [string]::IsNullOrWhiteSpace($TestStartupFailureMessage)) {
    throw "revAgent GUI startup test failure: $TestStartupFailureMessage"
}

# Refuse an elevated or copied GUI before reading bootstrap-selected paths or
# importing any local product module. The supported launcher always starts the
# GUI as the original unelevated user from the protected ProgramData bootstrap;
# only the later machine child crosses UAC.
$earlyGuiIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$earlyGuiPrincipal = [System.Security.Principal.WindowsPrincipal]::new($earlyGuiIdentity)
if ($earlyGuiPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "The revAgent updater GUI refuses elevated execution before local bootstrap module import. Start revAgent Updater STABLE.cmd normally."
}
if (-not $SmokeTest -and -not $PreWindowBootstrapSmokeTest) {
    $earlyGuiProgramData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    if ([string]::IsNullOrWhiteSpace($earlyGuiProgramData)) { throw "Windows CommonApplicationData could not be resolved before GUI module import." }
    $earlyCanonicalGuiPath = [System.IO.Path]::GetFullPath((Join-Path $earlyGuiProgramData "DPE\revAgent\bootstrap\Install-revAgent-Updater-GUI.ps1"))
    $earlyActualGuiPath = [System.IO.Path]::GetFullPath($PSCommandPath)
    if (-not [string]::Equals($earlyActualGuiPath, $earlyCanonicalGuiPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Updater GUI must run from the protected local bootstrap before module import. expected=$earlyCanonicalGuiPath actual=$earlyActualGuiPath"
    }
}
elseif ($PreWindowBootstrapSmokeTest) {
    $testRootPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $earlyActualGuiPath = [IO.Path]::GetFullPath($PSCommandPath)
    if (-not $earlyActualGuiPath.StartsWith($testRootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "PreWindowBootstrapSmokeTest is limited to a disposable path below the current TEMP directory."
    }
}

$powershellPath = Join-Path $osSystemDirectory "WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $powershellPath -PathType Leaf)) {
    throw "Canonical Windows PowerShell host was not found: $powershellPath"
}
$powershellSignature = Get-AuthenticodeSignature -LiteralPath $powershellPath
$expectedPowerShellSigner = "CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US"
if ($powershellSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
    -not [string]::Equals([string]$powershellSignature.SignerCertificate.Subject, $expectedPowerShellSigner, [System.StringComparison]::Ordinal)) {
    throw "Canonical Windows PowerShell host signature is not trusted: $powershellPath"
}
if ([string]::IsNullOrWhiteSpace($ChannelManifestPath)) {
    if ($SmokeTest) { $ChannelManifestPath = Join-Path (Split-Path -Parent $scriptDir) "channels\stable.json" }
    else { throw "The protected local GUI requires an explicit signed ChannelManifestPath from Start-revAgent-Update.ps1." }
}
$channelDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($ChannelManifestPath))
$releaseRoot = if ($SmokeTest) { Split-Path -Parent $scriptDir } else { [IO.Path]::GetFullPath((Split-Path -Parent $channelDirectory)).TrimEnd("\") }
$installerPath = if ($SmokeTest) { Join-Path $scriptDir "install-updater-task.ps1" } else { "" }

$programDataRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
if ([string]::IsNullOrWhiteSpace($programDataRoot)) { throw "Windows CommonApplicationData could not be resolved." }
$canonicalInstallRoot = Join-Path $programDataRoot "DPE\revAgent"
$legacyInstallRoot = Join-Path $programDataRoot "DPE\RevitMCP"
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = $canonicalInstallRoot
}
elseif (-not [string]::Equals([System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\'), [System.IO.Path]::GetFullPath($canonicalInstallRoot).TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "InstallRoot must be the canonical revAgent machine root: $canonicalInstallRoot"
}
$InstallRoot = [System.IO.Path]::GetFullPath($canonicalInstallRoot)

$workRoot = Join-Path $InstallRoot "updater"
$packageTarget = Join-Path $InstallRoot "package"
$serverTarget = Join-Path $InstallRoot "runtime"
$configPath = Join-Path $workRoot "updater-config.json"
$legacyConfigPath = Join-Path $legacyInstallRoot "updater\updater-config.json"
$localVersionTool = Join-Path $workRoot "show-installed-version.ps1"
$script:GuiPrivilegedSnapshotBrokerPath = ""
$script:GuiReleaseSnapshotModulePath = ""
$script:GuiDistributionIntegrityModulePath = ""
$script:GuiTrustedKeysPath = ""
$script:GuiNewReleaseInboxCommand = $null
if (-not $SmokeTest) {
    if ([string]::IsNullOrWhiteSpace($BootstrapStatePath)) { throw "Protected local GUI requires BootstrapStatePath." }
    $expectedBootstrapStatePath = Join-Path $scriptDir "bootstrap-state.json"
    if (-not [string]::Equals([IO.Path]::GetFullPath($BootstrapStatePath), [IO.Path]::GetFullPath($expectedBootstrapStatePath), [StringComparison]::OrdinalIgnoreCase)) {
        throw "BootstrapStatePath must be the protected state beside the local GUI: $expectedBootstrapStatePath"
    }
    $script:GuiBootstrapState = Get-Content -Raw -LiteralPath $BootstrapStatePath | ConvertFrom-Json
    if (-not [bool]$script:GuiBootstrapState.sourceAuthentication.independentlyAuthenticated -or -not [bool]$script:GuiBootstrapState.sourceAuthentication.operatorConfirmed) {
        throw "Local GUI bootstrap state does not prove independently authenticated prestage."
    }
    $script:GuiChannel = [string]$script:GuiBootstrapState.release.channel
    if ($script:GuiChannel -notin @('stable', 'pilot')) { throw "Protected GUI bootstrap state contains an unsupported channel: $($script:GuiChannel)" }
    $expectedGuiChannelPath = [IO.Path]::GetFullPath((Join-Path ([string]$script:GuiBootstrapState.releaseRoot) "channels\$($script:GuiChannel).json"))
    if (-not [string]::Equals([IO.Path]::GetFullPath($ChannelManifestPath), $expectedGuiChannelPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Protected GUI channel path does not match the bootstrap state channel. expected=$expectedGuiChannelPath actual=$ChannelManifestPath"
    }
    foreach ($role in @("updaterGui", "distributionIntegrity", "permissions", "sourceFreeMigration", "releaseSnapshot", "privilegedSnapshotUpdate", "trustedKeys")) {
        $evidence = $script:GuiBootstrapState.files.$role
        if ($null -eq $evidence -or [string]::IsNullOrWhiteSpace([string]$evidence.relativePath) -or [string]::IsNullOrWhiteSpace([string]$evidence.sha256)) {
            throw "Protected local GUI bootstrap state is missing required file evidence: $role"
        }
        $localPath = Join-Path $scriptDir ([string]$evidence.relativePath)
        if (-not [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $localPath).Hash, [string]$evidence.sha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Protected local GUI bootstrap hash mismatch: $role"
        }
    }
    $localSourceFreeMigrationModule = Join-Path $scriptDir ([string]$script:GuiBootstrapState.files.sourceFreeMigration.relativePath)
    Import-Module $localSourceFreeMigrationModule -Force
    $script:GuiReleaseSnapshotModulePath = Join-Path $scriptDir ([string]$script:GuiBootstrapState.files.releaseSnapshot.relativePath)
    $releaseSnapshotModule = Import-Module $script:GuiReleaseSnapshotModulePath -Force -PassThru
    $script:GuiNewReleaseInboxCommand = Get-Command ("{0}\New-RevAgentAuthenticatedReleaseInbox" -f $releaseSnapshotModule.Name) -ErrorAction Stop
    $script:GuiPrivilegedSnapshotBrokerPath = Join-Path $scriptDir ([string]$script:GuiBootstrapState.files.privilegedSnapshotUpdate.relativePath)
    $script:GuiDistributionIntegrityModulePath = Join-Path $scriptDir ([string]$script:GuiBootstrapState.files.distributionIntegrity.relativePath)
    $script:GuiTrustedKeysPath = Join-Path $scriptDir ([string]$script:GuiBootstrapState.files.trustedKeys.relativePath)
}
if ($PreWindowBootstrapSmokeTest) {
    [pscustomobject][ordered]@{
        success = $true
        action = 'pre-window-bootstrap-smoke-test'
        bootstrapStatePath = [IO.Path]::GetFullPath($BootstrapStatePath)
        channelManifestPath = [IO.Path]::GetFullPath($ChannelManifestPath)
        sourceFreeMigrationModule = [IO.Path]::GetFullPath($localSourceFreeMigrationModule)
        releaseSnapshotModule = [IO.Path]::GetFullPath($script:GuiReleaseSnapshotModulePath)
        trustedKeysPath = [IO.Path]::GetFullPath($script:GuiTrustedKeysPath)
    } | ConvertTo-Json -Compress
    return
}
$script:ActiveProcess = $null
$script:ActiveLogPath = ""
$script:ActiveBrokerLogPath = ""
$script:LastLogLength = -1
$script:ActivePhase = ""
$script:ActivePhaseResultPath = ""
$script:PendingUserPhaseComponentKey = ""
$script:PendingUserPhaseArguments = @()
$script:PendingUserPhaseResultPath = ""
$script:PendingUserLogPath = ""
$script:ActiveInboxRoot = ""

function Resolve-GuiProfileListImagePath {
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

$interactiveIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$interactiveUserName = [string]$interactiveIdentity.Name
$interactiveUserSid = [string]$interactiveIdentity.User.Value
$interactiveProfileRegistryPath = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$interactiveUserSid"
$interactiveProfileRegistryValue = (Get-ItemProperty -LiteralPath $interactiveProfileRegistryPath -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath
$interactiveUserProfileRoot = Resolve-GuiProfileListImagePath -ProfileImagePath ([string]$interactiveProfileRegistryValue)
if (-not (Test-Path -LiteralPath $interactiveUserProfileRoot -PathType Container)) {
    throw "Interactive user profile from ProfileList was not found: SID=$interactiveUserSid path=$interactiveUserProfileRoot"
}
$interactiveCodexHome = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) { "" } else { [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($env:CODEX_HOME)) }
$productTagline = "Your AI agent inside Revit."
$productFooter = "revAgent  |  " + [char]0x00A9 + " 2026 Baris Tankut  |  All rights reserved."

function Join-CommandLine {
    param([string[]]$Arguments)

    $escaped = foreach ($argument in $Arguments) {
        if ($null -eq $argument) {
            '""'
        }
        elseif ($argument -match '[\s"]') {
            '"' + ($argument -replace '"', '\"') + '"'
        }
        else {
            $argument
        }
    }

    return ($escaped -join " ")
}

function New-RunLogPath {
    param([ValidateSet("broker", "machine", "user")][string]$Phase = "machine")

    $logsRoot = Join-Path $workRoot $(if ($Phase -in @("broker", "machine")) { "machine-logs" } else { "logs" })
    # On first install the unelevated GUI may not yet have permission to create
    # ProgramData\DPE\revAgent. Each phase creates its own managed log directory;
    # machine logs stay read-only to the interactive user, user logs are writable.
    return (Join-Path $logsRoot ("gui-{0}-{1}-{2}.log" -f $Phase, (Get-Date -Format "yyyyMMdd-HHmmss"), [guid]::NewGuid().ToString("N")))
}

function Test-IsAdministrator {
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
}

function Read-JsonFile {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    try {
        return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Read-GuiUpdaterConfig {
    $config = Read-JsonFile -Path $configPath
    if ($config) {
        return $config
    }
    return Read-JsonFile -Path $legacyConfigPath
}

function Get-JsonPropertyString {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object -or [string]::IsNullOrWhiteSpace($Name)) {
        return ""
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return ""
    }

    return [string]$property.Value
}

function Get-CodexInstructionPolicyForGui {
    $config = Read-GuiUpdaterConfig
    $policy = Get-JsonPropertyString -Object $config -Name "codexInstructionPolicy"
    if ([string]::IsNullOrWhiteSpace($policy) -and -not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_CODEX_INSTRUCTION_POLICY)) {
        $policy = [string]$env:REVIT_MCP_CODEX_INSTRUCTION_POLICY
    }
    if ([string]::IsNullOrWhiteSpace($policy)) {
        $policy = "managed-user-pack"
    }

    $normalized = $policy.Trim().ToLowerInvariant()
    if ($normalized -notin @("managed-user-pack", "preserve-local")) {
        return "managed-user-pack"
    }

    return $normalized
}

function Get-MachineRoleForGui {
    $config = Read-GuiUpdaterConfig
    $role = Get-JsonPropertyString -Object $config -Name "machineRole"
    if ([string]::IsNullOrWhiteSpace($role) -and -not [string]::IsNullOrWhiteSpace($env:REVIT_MCP_MACHINE_ROLE)) {
        $role = [string]$env:REVIT_MCP_MACHINE_ROLE
    }

    return $role
}

function Get-PackageDescriptionForGui {
    $policy = Get-CodexInstructionPolicyForGui
    $role = Get-MachineRoleForGui
    if ([string]::Equals($policy, "preserve-local", [System.StringComparison]::OrdinalIgnoreCase)) {
        $roleLabel = if ([string]::IsNullOrWhiteSpace($role)) { "developer" } else { $role.Trim() }
        return "Release track: managed`r`nDeveloper machine ($roleLabel)`r`nCodex instructions: preserve local"
    }

    return "Release track: managed`r`nStandard user package"
}

function Get-SourceFreeMigrationArtifactsForGui {
    $preserveLocalCodexInstructions = [string]::Equals((Get-CodexInstructionPolicyForGui), "preserve-local", [System.StringComparison]::OrdinalIgnoreCase)
    return @(Get-RevAgentSourceFreeArtifactInventory `
            -InstallRoot $InstallRoot `
            -PackageTarget $packageTarget `
            -ServerTarget $serverTarget `
            -PreserveLocalCodexInstructions:$preserveLocalCodexInstructions)
}

function Confirm-SourceFreeMigrationForGui {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Artifacts
    )

    $sample = @($Artifacts |
            Select-Object -First 6 |
            ForEach-Object { "- {0}: {1}" -f [string]$_.rootLabel, [string]$_.relativePath })
    $sampleText = if ($sample.Count -gt 0) { "`r`n`r`nExamples:`r`n" + ($sample -join "`r`n") } else { "" }
    $message = "Source-free migration is required before install/update.`r`n`r`nFound $($Artifacts.Count) managed source/developer artifact item(s). revAgent can run the one-time migration update now. After it succeeds, this machine will use the normal stable update path and migration will not run again while the inventory stays clean.`r`n`r`nContinue with source-free migration and update?$sampleText"

    $statusLabel.Text = "Migration required."
    $logBox.Text = $message + "`r`n"
    $choice = [System.Windows.Forms.MessageBox]::Show(
        $message,
        "revAgent source-free migration required",
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning)
    return ($choice -eq [System.Windows.Forms.DialogResult]::Yes)
}

function Get-VersionNumericParts {
    param([string]$Version)

    if ([string]::IsNullOrWhiteSpace($Version)) {
        return $null
    }

    $baseVersion = ($Version -split '-', 2)[0]
    $parts = @()
    foreach ($part in ($baseVersion -split '\.')) {
        if ($part -notmatch '^\d+$') {
            break
        }
        $parts += [int64]$part
    }

    if ($parts.Count -eq 0) {
        return $null
    }

    return $parts
}

function Compare-RevAgentVersion {
    param(
        [string]$Left,
        [string]$Right
    )

    if ([string]::Equals($Left, $Right, [System.StringComparison]::OrdinalIgnoreCase)) {
        return 0
    }

    $leftParts = @(Get-VersionNumericParts -Version $Left)
    $rightParts = @(Get-VersionNumericParts -Version $Right)
    if ($leftParts.Count -gt 0 -and $rightParts.Count -gt 0) {
        $max = [Math]::Max($leftParts.Count, $rightParts.Count)
        for ($i = 0; $i -lt $max; $i++) {
            $leftValue = if ($i -lt $leftParts.Count) { $leftParts[$i] } else { -1 }
            $rightValue = if ($i -lt $rightParts.Count) { $rightParts[$i] } else { -1 }
            if ($leftValue -ne $rightValue) {
                return [Math]::Sign($leftValue - $rightValue)
            }
        }
    }

    return [System.StringComparer]::OrdinalIgnoreCase.Compare($Left, $Right)
}

function Get-ChannelStatus {
    $installed = Read-JsonFile -Path (Join-Path $workRoot "installed.json")
    if (-not $installed) {
        $installed = Read-JsonFile -Path (Join-Path $legacyInstallRoot "updater\installed.json")
    }
    $channel = Read-JsonFile -Path $ChannelManifestPath
    $installedVersion = if ($installed -and $installed.version) { [string]$installed.version } else { "" }
    $channelVersion = if ($channel -and $channel.version) { [string]$channel.version } else { "" }

    if ($null -eq $channel -or [string]::IsNullOrWhiteSpace($channelVersion)) {
        return [pscustomobject]@{
            Code = "channel-missing"
            InstalledVersion = $installedVersion
            ChannelVersion = $channelVersion
            UpdateEnabled = $false
            RestoreEnabled = $false
            UpdateButtonText = "Update"
            SourceFreeMigrationRequired = $false
            SourceFreeMigrationArtifactCount = 0
            StatusText = "Release manifest could not be read."
        }
    }

    $sourceFreeArtifacts = @(Get-SourceFreeMigrationArtifactsForGui)
    if ($sourceFreeArtifacts.Count -gt 0) {
        return [pscustomobject]@{
            Code = "source-free-migration-required"
            InstalledVersion = $installedVersion
            ChannelVersion = $channelVersion
            UpdateEnabled = $true
            RestoreEnabled = $false
            UpdateButtonText = "Migrate"
            SourceFreeMigrationRequired = $true
            SourceFreeMigrationArtifactCount = $sourceFreeArtifacts.Count
            StatusText = "Source-free migration required before update: $($sourceFreeArtifacts.Count) managed source/developer artifact item(s)."
        }
    }

    if ([string]::IsNullOrWhiteSpace($installedVersion)) {
        return [pscustomobject]@{
            Code = "not-installed"
            InstalledVersion = $installedVersion
            ChannelVersion = $channelVersion
            UpdateEnabled = $true
            RestoreEnabled = $false
            UpdateButtonText = "Install"
            SourceFreeMigrationRequired = $false
            SourceFreeMigrationArtifactCount = 0
            StatusText = "Not installed. Release can be installed: $channelVersion"
        }
    }

    if ([string]::Equals($installedVersion, $channelVersion, [System.StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject]@{
            Code = "current"
            InstalledVersion = $installedVersion
            ChannelVersion = $channelVersion
            UpdateEnabled = $false
            RestoreEnabled = $true
            UpdateButtonText = "Update"
            SourceFreeMigrationRequired = $false
            SourceFreeMigrationArtifactCount = 0
            StatusText = "Current: $installedVersion. Install/repair is available."
        }
    }

    $comparison = Compare-RevAgentVersion -Left $installedVersion -Right $channelVersion
    if ($comparison -lt 0) {
        return [pscustomobject]@{
            Code = "update-available"
            InstalledVersion = $installedVersion
            ChannelVersion = $channelVersion
            UpdateEnabled = $true
            RestoreEnabled = $true
            UpdateButtonText = "Update"
            SourceFreeMigrationRequired = $false
            SourceFreeMigrationArtifactCount = 0
            StatusText = "Update available: $installedVersion -> $channelVersion"
        }
    }

    return [pscustomobject]@{
        Code = "restore-available"
        InstalledVersion = $installedVersion
        ChannelVersion = $channelVersion
        UpdateEnabled = $false
        RestoreEnabled = $true
        UpdateButtonText = "Update"
        SourceFreeMigrationRequired = $false
        SourceFreeMigrationArtifactCount = 0
        StatusText = "Installed version differs from or is newer than the release target. Install/repair is available: $installedVersion -> $channelVersion"
    }
}

if ($SmokeTest) {
    if (-not (Test-Path -LiteralPath $installerPath)) {
        throw "Installer script was not found: $installerPath"
    }
    if (-not (Test-Path -LiteralPath $ChannelManifestPath)) {
        throw "Channel manifest was not found: $ChannelManifestPath"
    }

    Write-Host "GUI smoke test OK"
    Write-Host "Installer: $installerPath"
    Write-Host "Channel  : $ChannelManifestPath"
    Write-Host "Install  : $InstallRoot"
    return
}

if (Test-IsAdministrator) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "For security, the revAgent updater GUI must run as the normal interactive user.`r`n`r`nClose this elevated window and start revAgent Updater STABLE.cmd normally. The GUI will request administrator permission only for the machine update phase.",
        "revAgent",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    throw "The revAgent updater GUI refuses to run elevated."
}

function Test-GuiPathUnderRoot {
    param([string]$Path, [string]$Root)

    if ([string]::IsNullOrWhiteSpace($Path) -or [string]::IsNullOrWhiteSpace($Root)) {
        return $false
    }
    try {
        $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
        $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")
        return [string]::Equals($fullPath, $fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
            $fullPath.StartsWith($fullRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch {
        return $false
    }
}

function Assert-GuiTrustedPathComponents {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$GuardRoot
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullGuardRoot = [System.IO.Path]::GetFullPath($GuardRoot).TrimEnd("\")
    if (-not (Test-GuiPathUnderRoot -Path $fullPath -Root $fullGuardRoot)) {
        throw "Trusted release path escaped its canonical root. Path=$fullPath Root=$fullGuardRoot"
    }

    $cursor = $fullPath
    while (-not [string]::IsNullOrWhiteSpace($cursor) -and
        (Test-GuiPathUnderRoot -Path $cursor -Root $fullGuardRoot)) {
        if (-not (Test-Path -LiteralPath $cursor)) {
            throw "Trusted release path component does not exist: $cursor"
        }
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Trusted release path contains a reparse point: $($item.FullName)"
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) {
            throw "Trusted release path contains a filesystem link: $($item.FullName) ($($item.LinkType))"
        }
        if ([string]::Equals($cursor.TrimEnd("\"), $fullGuardRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or
            [string]::Equals($parent, $cursor, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $cursor = $parent
    }

    return $fullPath
}

function Assert-GuiProtectedLocalPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$GuardRoot,
        [switch]$RequireLeaf
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullRoot = [System.IO.Path]::GetFullPath($GuardRoot).TrimEnd("\")
    if ($fullPath.StartsWith("\\", [System.StringComparison]::Ordinal)) { throw "Protected execution path must be local, not UNC: $fullPath" }
    [void](Assert-GuiTrustedPathComponents -Path $fullPath -GuardRoot $fullRoot)
    $trustedWriters = @("S-1-5-18", "S-1-5-32-544")
    $writeMask = [System.Security.AccessControl.FileSystemRights]::WriteData -bor
        [System.Security.AccessControl.FileSystemRights]::AppendData -bor
        [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    $cursor = $fullPath
    while (Test-GuiPathUnderRoot -Path $cursor -Root $fullRoot) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        $acl = Get-Acl -LiteralPath $cursor -ErrorAction Stop
        $ownerSid = [string]$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
        if ($ownerSid -notin $trustedWriters) {
            throw "Protected local execution path owner is not trusted: $cursor owner=$ownerSid"
        }
        if ([string]::Equals($cursor.TrimEnd("\"), $fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -and -not $acl.AreAccessRulesProtected) {
            throw "Protected local execution root DACL must be protected from inheritance: $cursor"
        }
        foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
                $trustedWriters -notcontains [string]$rule.IdentityReference.Value -and
                (($rule.FileSystemRights -band $writeMask) -ne 0)) {
                throw "Protected local execution path grants write/delete access to an untrusted principal. path=$cursor principal=$($rule.IdentityReference.Value) rights=$($rule.FileSystemRights)"
            }
        }
        if ([string]::Equals($cursor.TrimEnd("\"), $fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = Split-Path -Parent $cursor
    }
    if ($RequireLeaf) {
        $leaf = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
        if ($leaf.PSIsContainer) { throw "Protected local execution path must be a file: $fullPath" }
        $fsutil = Join-Path $osSystemDirectory "fsutil.exe"
        $links = @(& $fsutil hardlink list $fullPath 2>&1 | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        if ($LASTEXITCODE -ne 0 -or $links.Count -ne 1) { throw "Protected local execution file must have exactly one hardlink reference: $fullPath" }
    }
    return $fullPath
}

function Assert-GuiProtectedSnapshotBroker {
    $evidence = $script:GuiBootstrapState.files.privilegedSnapshotUpdate
    $expectedPath = [System.IO.Path]::GetFullPath((Join-Path $scriptDir "Invoke-revAgent-PrivilegedSnapshotUpdate.ps1"))
    $actualPath = [System.IO.Path]::GetFullPath($script:GuiPrivilegedSnapshotBrokerPath)
    if (-not [string]::Equals($actualPath, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([System.IO.Path]::GetFullPath((Join-Path $scriptDir ([string]$evidence.relativePath))), $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Privileged update broker must be the exact protected local bootstrap file: $expectedPath"
    }
    [void](Assert-GuiProtectedLocalPath -Path $actualPath -GuardRoot $scriptDir -RequireLeaf)
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $actualPath).Hash
    if (-not [string]::Equals($actualHash, [string]$evidence.sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Protected privileged update broker hash mismatch."
    }
    return $actualPath
}

function Resolve-GuiSnapshotUserEntrypoint {
    param(
        [Parameter(Mandatory = $true)][object]$PhaseResult,
        [Parameter(Mandatory = $true)][ValidateSet("updater", "updaterTaskInstaller")][string]$ComponentKey
    )

    $executionSnapshot = $PhaseResult.executionSnapshot
    if ($null -eq $executionSnapshot) { throw "Privileged snapshot broker phase result is missing executionSnapshot." }
    foreach ($field in @("snapshotRoot", "statePath", "targetRelativePath", "targetSha256", "targetComponentKey")) {
        if ($null -eq $executionSnapshot.PSObject.Properties[$field] -or [string]::IsNullOrWhiteSpace([string]$executionSnapshot.$field)) {
            throw "Privileged snapshot broker phase result is missing executionSnapshot.$field."
        }
    }
    $snapshotRoot = [System.IO.Path]::GetFullPath([string]$executionSnapshot.snapshotRoot).TrimEnd("\")
    $statePath = [System.IO.Path]::GetFullPath([string]$executionSnapshot.statePath)
    $entrypointPath = [System.IO.Path]::GetFullPath((Join-Path $snapshotRoot ([string]$executionSnapshot.targetRelativePath)))
    if ($snapshotRoot.StartsWith("\\", [System.StringComparison]::Ordinal) -or
        $statePath.StartsWith("\\", [System.StringComparison]::Ordinal) -or
        $entrypointPath.StartsWith("\\", [System.StringComparison]::Ordinal)) {
        throw "Snapshot machine/user execution paths must be local; UNC execution is forbidden."
    }
    if (-not (Test-GuiPathUnderRoot -Path $statePath -Root $snapshotRoot) -or -not (Test-GuiPathUnderRoot -Path $entrypointPath -Root $snapshotRoot)) {
        throw "Snapshot phase result paths escaped the authenticated local snapshot root."
    }
    [void](Assert-GuiProtectedLocalPath -Path $statePath -GuardRoot $snapshotRoot -RequireLeaf)
    [void](Assert-GuiProtectedLocalPath -Path $entrypointPath -GuardRoot $snapshotRoot -RequireLeaf)
    $snapshotState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if ([int]$snapshotState.schemaVersion -ne 1 -or
        -not [string]::Equals([string]$snapshotState.stateType, "authenticated-release-snapshot", [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$snapshotState.transportTrust, "signed_local_snapshot", [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([System.IO.Path]::GetFullPath([string]$snapshotState.snapshotRoot).TrimEnd("\"), $snapshotRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Local execution snapshot state contract is invalid."
    }
    $component = $snapshotState.components.$ComponentKey
    if ($null -eq $component) { throw "Local execution snapshot state is missing component '$ComponentKey'." }
    $expectedPackagePath = if ($ComponentKey -eq "updater") { "installer\nas\update-from-nas.ps1" } else { "installer\nas\install-updater-task.ps1" }
    $expectedSnapshotPath = [System.IO.Path]::GetFullPath((Join-Path $snapshotRoot ([string]$component.snapshotRelativePath)))
    if (-not [string]::Equals(([string]$component.path).Replace("/", "\"), $expectedPackagePath, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$executionSnapshot.targetComponentKey, $ComponentKey, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$executionSnapshot.targetRelativePath, [string]$component.snapshotRelativePath, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($entrypointPath, $expectedSnapshotPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$executionSnapshot.targetSha256, [string]$component.sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Local snapshot user entrypoint does not match its signed component binding."
    }
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $entrypointPath).Hash
    if (-not [string]::Equals($actualHash, [string]$component.sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Local snapshot user entrypoint hash mismatch."
    }
    return $entrypointPath
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "revAgent"
$form.ShowInTaskbar = $true
$form.MinimizeBox = $true
$form.MaximizeBox = $true
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::Sizable
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(820, 560)
$form.MinimumSize = New-Object System.Drawing.Size(700, 460)

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = "Fill"
$root.ColumnCount = 1
$root.RowCount = 7
$root.Padding = New-Object System.Windows.Forms.Padding(12)
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$form.Controls.Add($root)

$title = New-Object System.Windows.Forms.Label
$title.Text = "revAgent install and update"
$title.Font = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$root.Controls.Add($title, 0, 0)

$tagline = New-Object System.Windows.Forms.Label
$tagline.Text = $productTagline
$tagline.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$tagline.ForeColor = [System.Drawing.Color]::FromArgb(80, 80, 80)
$tagline.AutoSize = $true
$tagline.Margin = New-Object System.Windows.Forms.Padding(0, 2, 0, 8)
$root.Controls.Add($tagline, 0, 1)

$details = New-Object System.Windows.Forms.Label
$details.Text = Get-PackageDescriptionForGui
$details.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$details.AutoSize = $true
$details.Margin = New-Object System.Windows.Forms.Padding(0, 8, 0, 8)
$root.Controls.Add($details, 0, 2)

$statusPanel = New-Object System.Windows.Forms.TableLayoutPanel
$statusPanel.Dock = "Top"
$statusPanel.AutoSize = $true
$statusPanel.AutoSizeMode = "GrowAndShrink"
$statusPanel.ColumnCount = 2
$statusPanel.RowCount = 1
$statusPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$statusPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 170))) | Out-Null
$statusPanel.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.Controls.Add($statusPanel, 0, 3)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = "Ready."
$statusLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$statusLabel.AutoSize = $true
$statusPanel.Controls.Add($statusLabel, 0, 0)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Dock = "None"
$progress.Style = "Blocks"
$progress.Width = 160
$progress.Height = 10
$progress.Margin = New-Object System.Windows.Forms.Padding(0, 5, 0, 0)
$progress.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Right
$statusPanel.Controls.Add($progress, 1, 0)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Dock = "Fill"
$logBox.Multiline = $true
$logBox.ScrollBars = "Both"
$logBox.WordWrap = $false
$logBox.ReadOnly = $true
$logBox.Font = New-Object System.Drawing.Font("Consolas", 9)
$root.Controls.Add($logBox, 0, 4)

$buttonPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$buttonPanel.Dock = "Fill"
$buttonPanel.FlowDirection = "LeftToRight"
$buttonPanel.AutoSize = $true
$buttonPanel.Margin = New-Object System.Windows.Forms.Padding(0, 10, 0, 0)
$root.Controls.Add($buttonPanel, 0, 5)

$runButton = New-Object System.Windows.Forms.Button
$runButton.Text = "Install/Update"
$runButton.Width = 110
$runButton.Height = 32
$buttonPanel.Controls.Add($runButton)

$restoreButton = New-Object System.Windows.Forms.Button
$restoreButton.Text = "Install/Repair"
$restoreButton.Width = 120
$restoreButton.Height = 32
$buttonPanel.Controls.Add($restoreButton)

$versionButton = New-Object System.Windows.Forms.Button
$versionButton.Text = "Version Check"
$versionButton.Width = 120
$versionButton.Height = 32
$buttonPanel.Controls.Add($versionButton)

$openLogsButton = New-Object System.Windows.Forms.Button
$openLogsButton.Text = "Open Log"
$openLogsButton.Width = 110
$openLogsButton.Height = 32
$buttonPanel.Controls.Add($openLogsButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = "Close"
$closeButton.Width = 90
$closeButton.Height = 32
$buttonPanel.Controls.Add($closeButton)

$footer = New-Object System.Windows.Forms.Label
$footer.Text = $productFooter
$footer.Font = New-Object System.Drawing.Font("Segoe UI", 8)
$footer.ForeColor = [System.Drawing.Color]::FromArgb(100, 100, 100)
$footer.AutoSize = $true
$footer.Margin = New-Object System.Windows.Forms.Padding(0, 10, 0, 0)
$root.Controls.Add($footer, 0, 6)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 700

function Set-ButtonsEnabled {
    param([bool]$Enabled)
    if (-not $Enabled) {
        $runButton.Enabled = $false
        $restoreButton.Enabled = $false
        $versionButton.Enabled = $false
        $closeButton.Enabled = $false
        return
    }

    $status = Get-ChannelStatus
    $runButton.Text = $status.UpdateButtonText
    $runButton.Enabled = [bool]$status.UpdateEnabled
    $restoreButton.Enabled = [bool]$status.RestoreEnabled
    $versionButton.Enabled = $true
    $closeButton.Enabled = $true
    $statusLabel.Text = [string]$status.StatusText
}

function Add-InteractiveContextArguments {
    param([string[]]$Arguments)

    $result = @($Arguments)
    foreach ($entry in @(
            [pscustomobject]@{ Name = "TargetInteractiveUser"; Value = $interactiveUserName },
            [pscustomobject]@{ Name = "TargetInteractiveUserSid"; Value = $interactiveUserSid },
            [pscustomobject]@{ Name = "TargetUserProfileRoot"; Value = $interactiveUserProfileRoot },
            [pscustomobject]@{ Name = "TargetCodexHome"; Value = $interactiveCodexHome }
        )) {
        if (-not [string]::IsNullOrWhiteSpace([string]$entry.Value)) {
            $result += @("-$($entry.Name)", [string]$entry.Value)
        }
    }
    return $result
}

function New-GuiPhaseResultPath {
    param([ValidateSet("machine", "user")][string]$Phase)

    $stateRoot = Join-Path $workRoot $(if ($Phase -eq "machine") { "machine-state" } else { "user-state" })
    $runId = [guid]::NewGuid().ToString("N")
    return Join-Path $stateRoot ("gui-{0}-phase-{1}.json" -f $Phase, $runId)
}

function Read-GuiPhaseResult {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Read-GuiLogTail {
    param(
        [string]$Path,
        [int]$MaxCharacters = 4000
    )

    $text = Read-LogFileText -Path $Path
    if ($text.Length -le $MaxCharacters) { return $text }
    return $text.Substring($text.Length - $MaxCharacters)
}

function Open-GuiLogSnapshot {
    $parts = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($script:ActiveBrokerLogPath)) {
        [void]$parts.Add("=== Protected broker ===`r`nPath: $script:ActiveBrokerLogPath`r`n$(Read-GuiLogTail -Path $script:ActiveBrokerLogPath -MaxCharacters 120000)")
    }
    if (-not [string]::IsNullOrWhiteSpace($script:ActiveLogPath)) {
        [void]$parts.Add("=== Active phase ===`r`nPath: $script:ActiveLogPath`r`n$(Read-GuiLogTail -Path $script:ActiveLogPath -MaxCharacters 180000)")
    }

    $snapshotText = [string]::Join("`r`n`r`n", $parts.ToArray())
    if ([string]::IsNullOrWhiteSpace($snapshotText)) {
        $snapshotText = "No active revAgent GUI log has been created yet.`r`n`r`nUpdater root: $workRoot`r`n"
    }

    $snapshotRoot = Join-Path ([System.IO.Path]::GetTempPath()) "revAgent-gui-log-snapshots"
    New-Item -ItemType Directory -Path $snapshotRoot -Force | Out-Null
    $snapshotPath = Join-Path $snapshotRoot ("revAgent-gui-log-{0}.txt" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
    [System.IO.File]::WriteAllText($snapshotPath, $snapshotText, [System.Text.Encoding]::UTF8)

    $notepad = Join-Path ([Environment]::SystemDirectory) "notepad.exe"
    if (Test-Path -LiteralPath $notepad -PathType Leaf) {
        Start-Process -FilePath $notepad -ArgumentList @($snapshotPath) | Out-Null
    }
    else {
        Start-Process -FilePath $snapshotPath | Out-Null
    }
}

function Remove-GuiAuthenticatedInbox {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    $allowedRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'DPE\revAgent\release-inbox')).TrimEnd('\')
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not (Test-GuiPathUnderRoot -Path $fullPath -Root $allowedRoot) -or
        [IO.Path]::GetFileName($fullPath) -notmatch '^[a-f0-9]{32}$') {
        throw "Refusing release inbox cleanup outside the exact user-local inbox pattern: $fullPath"
    }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) { return $false }
    $cursor = $fullPath
    while (Test-GuiPathUnderRoot -Path $cursor -Root $allowedRoot) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        $linkType = if ($item.PSObject.Properties['LinkType']) { [string]$item.LinkType } else { '' }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) {
            throw "Refusing release inbox cleanup through a filesystem link: $cursor"
        }
        if ([string]::Equals($cursor.TrimEnd('\'), $allowedRoot, [StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = Split-Path -Parent $cursor
    }
    foreach ($item in Get-ChildItem -LiteralPath $fullPath -Recurse -Force -ErrorAction Stop) {
        $linkType = if ($item.PSObject.Properties['LinkType']) { [string]$item.LinkType } else { '' }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not [string]::IsNullOrWhiteSpace($linkType)) {
            throw "Refusing release inbox cleanup because it contains a filesystem link: $($item.FullName)"
        }
    }
    [IO.Directory]::Delete($fullPath, $true)
    if ([IO.Directory]::Exists($fullPath)) { throw "Release inbox cleanup was incomplete: $fullPath" }
    return $true
}

function Start-GuiPhaseProcess {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$Elevated
    )

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        throw "Phase script was not found: $ScriptPath"
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $powershellPath
    $psi.Arguments = Join-CommandLine -Arguments $Arguments
    # Never let either the UAC broker or the unelevated continuation inherit a
    # user-writable/NAS current directory into native DLL search. The phase
    # scripts receive absolute paths and do not depend on the caller CWD.
    $psi.WorkingDirectory = Split-Path -Parent $powershellPath
    if ($Elevated) {
        $psi.UseShellExecute = $true
        $psi.Verb = "runas"
        $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    }
    else {
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    [void]$process.Start()
    return $process
}

function Start-InstallerOperation {
    param([ValidateSet("update", "restore")] [string]$Operation)

    if (-not (Test-Path -LiteralPath $script:GuiPrivilegedSnapshotBrokerPath -PathType Leaf)) {
        [System.Windows.Forms.MessageBox]::Show("The protected local update broker was not found. Repeat the administrator bootstrap prestage.", "revAgent") | Out-Null
        return
    }
    if (-not (Test-Path -LiteralPath $ChannelManifestPath)) {
        [System.Windows.Forms.MessageBox]::Show("Release manifest was not found.", "revAgent") | Out-Null
        return
    }

    $status = Get-ChannelStatus
    $sourceFreeArtifacts = @(Get-SourceFreeMigrationArtifactsForGui)
    $runSourceFreeMigration = ($sourceFreeArtifacts.Count -gt 0)
    if ($runSourceFreeMigration) {
        if (-not (Confirm-SourceFreeMigrationForGui -Artifacts $sourceFreeArtifacts)) {
            Set-ButtonsEnabled -Enabled $true
            return
        }
        $Operation = "update"
    }

    if ($Operation -eq "update" -and -not [bool]$status.UpdateEnabled) {
        [System.Windows.Forms.MessageBox]::Show("No update is available.`r`n`r`n$($status.StatusText)", "revAgent") | Out-Null
        Set-ButtonsEnabled -Enabled $true
        return
    }

    if ($Operation -eq "restore") {
        $message = "Install/Repair performs a canonical revAgent rebaseline from the signed release target.`r`n`r`nIt replaces managed package/runtime/update payloads and removes only positively identified legacy revAgent surfaces. Current revAgent Codex instructions, project data, spatial data, logs, telemetry, and add-ons are preserved. Retired RevitMCP logs and other unrecognized legacy-root children are also left in place for operator review.`r`n`r`nInstalled: $($status.InstalledVersion)`r`nRelease: $($status.ChannelVersion)`r`n`r`nContinue?"
        $choice = [System.Windows.Forms.MessageBox]::Show(
            $message,
            "revAgent Install/Repair",
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Warning)
        if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) {
            return
        }
    }

    $script:ActiveLogPath = New-RunLogPath -Phase "machine"
    $script:ActiveBrokerLogPath = New-RunLogPath -Phase "broker"
    $userLogPath = New-RunLogPath -Phase "user"
    $script:LastLogLength = -1
    $codexInstructionPolicy = Get-CodexInstructionPolicyForGui
    $machineRole = Get-MachineRoleForGui
    $operationMethod = if ($runSourceFreeMigration) {
        "source-free-migration"
    }
    elseif ($Operation -eq "restore") {
        if ([string]::IsNullOrWhiteSpace($status.InstalledVersion)) { "gui-install" } else { "gui-install-repair" }
    }
    elseif ([string]::IsNullOrWhiteSpace($status.InstalledVersion)) {
        "gui-install"
    }
    else {
        "gui-update"
    }
    $operationLabel = if ($operationMethod -eq "source-free-migration") { "Source-free migration" } elseif ($operationMethod -eq "gui-install-repair") { "Install/repair" } elseif ($operationMethod -eq "gui-install") { "Install" } else { "Update" }
    $logBox.Text = "$operationLabel starting...`r`nWaiting for administrator approval and protected broker startup...`r`n"
    $statusLabel.Text = "Running."
    $progress.Style = "Marquee"
    Set-ButtonsEnabled -Enabled $false

    $useDirectUpdate = ($Operation -eq "update" -and
        (-not [string]::IsNullOrWhiteSpace($status.InstalledVersion) -or $runSourceFreeMigration))

    $machinePhaseResultPath = New-GuiPhaseResultPath -Phase "machine"
    $userPhaseResultPath = New-GuiPhaseResultPath -Phase "user"

    if ($useDirectUpdate) {
        $machineArguments = @(
            "-InstallRoot", $InstallRoot,
            "-WorkRoot", $workRoot,
            "-PackageTarget", $packageTarget,
            "-ServerTarget", $serverTarget,
            "-NoNotifyUser",
            "-OperationMethod", $operationMethod,
            "-LogPath", $script:ActiveLogPath
        )
        $userArguments = @(
            "-InstallRoot", $InstallRoot,
            "-WorkRoot", $workRoot,
            "-PackageTarget", $packageTarget,
            "-ServerTarget", $serverTarget,
            "-NoNotifyUser",
            "-AllowManualCodexSetup",
            "-OperationMethod", $operationMethod,
            "-LogPath", $userLogPath
        )
        $machineComponentKey = "updater"
        $userComponentKey = "updater"
    }
    else {
        $machineArguments = @(
            "-InstallRoot", $InstallRoot,
            "-WorkRoot", $workRoot,
            "-PackageTarget", $packageTarget,
            "-ServerTarget", $serverTarget,
            "-RunNow",
            "-OperationMethod", $operationMethod,
            "-LogPath", $script:ActiveLogPath
        )
        $userArguments = @(
            "-InstallRoot", $InstallRoot,
            "-WorkRoot", $workRoot,
            "-PackageTarget", $packageTarget,
            "-ServerTarget", $serverTarget,
            "-OperationMethod", $operationMethod,
            "-LogPath", $userLogPath
        )
        $machineComponentKey = "updaterTaskInstaller"
        $userComponentKey = "updaterTaskInstaller"
    }
    $machineArguments += @("-CodexInstructionPolicy", $codexInstructionPolicy)
    $userArguments += @("-CodexInstructionPolicy", $codexInstructionPolicy)
    if (-not [string]::IsNullOrWhiteSpace($machineRole)) {
        $machineArguments += @("-MachineRole", $machineRole)
        $userArguments += @("-MachineRole", $machineRole)
    }
    if ($Operation -eq "restore") {
        $machineArguments += "-ForceUpdate"
    }
    if ($runSourceFreeMigration) {
        $machineArguments += "-SourceFreeMigration"
    }
    $machineArguments = Add-InteractiveContextArguments -Arguments $machineArguments
    $userArguments = Add-InteractiveContextArguments -Arguments $userArguments

    try {
        $brokerPath = Assert-GuiProtectedSnapshotBroker
        $highestAcceptedReleaseSequence = [long]0
        $installedState = Read-JsonFile -Path (Join-Path $workRoot "installed.json")
        if ($null -ne $installedState) {
            foreach ($value in @($installedState.releaseSequence, $installedState.highestAcceptedReleaseSequence, $installedState.distributionIntegrity.highestAcceptedReleaseSequence)) {
                $candidate = [long]0
                if ($null -ne $value -and [long]::TryParse([string]$value, [ref]$candidate)) { $highestAcceptedReleaseSequence = [Math]::Max($highestAcceptedReleaseSequence, $candidate) }
            }
        }
        $inbox = & $script:GuiNewReleaseInboxCommand `
            -ReleaseRoot $releaseRoot `
            -Channel $script:GuiChannel `
            -TrustedKeysPath $script:GuiTrustedKeysPath `
            -IntegrityModulePath $script:GuiDistributionIntegrityModulePath `
            -HighestAcceptedReleaseSequence $highestAcceptedReleaseSequence
        if ($null -eq $inbox -or [string]::IsNullOrWhiteSpace([string]$inbox.inboxRoot)) { throw "Signed release inbox acquisition did not return an authenticated local inbox." }
        $script:ActiveInboxRoot = [string]$inbox.inboxRoot
        $targetArgumentJson = ConvertTo-Json -InputObject @($machineArguments) -Compress
        $targetArgumentsBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($targetArgumentJson))
        $brokerArguments = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $brokerPath,
            "-Target", $machineComponentKey,
            "-Channel", $script:GuiChannel,
            "-InboxPath", [string]$inbox.inboxRoot,
            "-BrokerLogPath", $script:ActiveBrokerLogPath,
            "-TargetArgumentsBase64", $targetArgumentsBase64,
            "-PhaseResultPath", $machinePhaseResultPath,
            "-TargetInteractiveUserSid", $interactiveUserSid,
            "-TargetUserProfileRoot", $interactiveUserProfileRoot
        )
        $script:ActiveProcess = Start-GuiPhaseProcess -ScriptPath $brokerPath -Arguments $brokerArguments -Elevated
        $script:ActivePhase = "machine"
        $script:ActivePhaseResultPath = $machinePhaseResultPath
        $script:PendingUserPhaseComponentKey = $userComponentKey
        $script:PendingUserPhaseArguments = @($userArguments)
        $script:PendingUserPhaseResultPath = $userPhaseResultPath
        $script:PendingUserLogPath = $userLogPath
        $statusLabel.Text = "Machine update running with administrator permission."
        $timer.Start()
    }
    catch {
        if (-not [string]::IsNullOrWhiteSpace($script:ActiveInboxRoot)) {
            try { [void](Remove-GuiAuthenticatedInbox -Path $script:ActiveInboxRoot) } catch {}
            $script:ActiveInboxRoot = ''
        }
        $progress.Style = "Blocks"
        Set-ButtonsEnabled -Enabled $true
        $statusLabel.Text = "Could not start."
        [System.Windows.Forms.MessageBox]::Show(
            "The administrator-only machine update could not be started.`r`n$($_.Exception.Message)",
            "revAgent",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    }
}

function Read-LogFileText {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return ""
    }

    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $reader = New-Object System.IO.StreamReader($stream)
            try {
                return $reader.ReadToEnd()
            }
            finally {
                $reader.Dispose()
            }
        }
        finally {
            $stream.Dispose()
        }
    }
    catch {
        return ""
    }
}

function Refresh-LogBox {
    if ([string]::IsNullOrWhiteSpace($script:ActiveLogPath) -and [string]::IsNullOrWhiteSpace($script:ActiveBrokerLogPath)) {
        return
    }

    $brokerText = Read-GuiLogTail -Path $script:ActiveBrokerLogPath -MaxCharacters 80000
    $phaseText = Read-GuiLogTail -Path $script:ActiveLogPath -MaxCharacters 170000
    $parts = [System.Collections.Generic.List[string]]::new()
    if ($brokerText.Length -gt 0) {
        [void]$parts.Add("=== Protected broker ===`r`n$brokerText")
    }
    if ($phaseText.Length -gt 0) {
        [void]$parts.Add("=== Active phase ===`r`n$phaseText")
    }
    $text = [string]::Join("`r`n", $parts.ToArray())
    if ($text.Length -eq 0) {
        return
    }

    if ($text.Length -gt 250000) {
        $text = $text.Substring($text.Length - 250000)
    }

    if ($text.Length -ne $script:LastLogLength) {
        $script:LastLogLength = $text.Length
        $logBox.Text = $text
        $logBox.SelectionStart = $logBox.TextLength
        $logBox.ScrollToCaret()
    }
}

$timer.Add_Tick({
    Refresh-LogBox

    if ($null -ne $script:ActiveProcess -and $script:ActiveProcess.HasExited) {
        $timer.Stop()
        Refresh-LogBox
        $exitCode = $script:ActiveProcess.ExitCode
        $completedPhase = $script:ActivePhase
        $phaseResult = Read-GuiPhaseResult -Path $script:ActivePhaseResultPath
        $script:ActiveProcess.Dispose()
        $script:ActiveProcess = $null

        if ($completedPhase -eq 'machine' -and -not [string]::IsNullOrWhiteSpace($script:ActiveInboxRoot)) {
            try {
                if (Remove-GuiAuthenticatedInbox -Path $script:ActiveInboxRoot) {
                    $logBox.AppendText("Authenticated user inbox consumed and removed.`r`n")
                }
            }
            catch {
                $logBox.AppendText("Warning: authenticated user inbox cleanup was deferred: $($_.Exception.Message)`r`n")
            }
            finally { $script:ActiveInboxRoot = '' }
        }

        if ($completedPhase -eq "machine" -and
            $exitCode -eq 0 -and
            $null -ne $phaseResult -and
            [bool]$phaseResult.continueUserPhase) {
            try {
                $verifiedUserPhasePath = Resolve-GuiSnapshotUserEntrypoint -PhaseResult $phaseResult -ComponentKey $script:PendingUserPhaseComponentKey
                $snapshotRoot = [System.IO.Path]::GetFullPath([string]$phaseResult.executionSnapshot.snapshotRoot).TrimEnd("\")
                $snapshotStatePath = [System.IO.Path]::GetFullPath([string]$phaseResult.executionSnapshot.statePath)
                $snapshotState = Get-Content -Raw -LiteralPath $snapshotStatePath | ConvertFrom-Json
                if (-not [string]::Equals([string]$snapshotState.release.channel, $script:GuiChannel, [System.StringComparison]::Ordinal)) {
                    throw "Authenticated snapshot channel does not match the protected GUI channel."
                }
                $snapshotChannelRelativePath = [string]$snapshotState.release.channelManifestRelativePath
                if (-not [string]::Equals($snapshotChannelRelativePath, "channels\$($script:GuiChannel).json", [System.StringComparison]::OrdinalIgnoreCase)) {
                    throw "Authenticated snapshot channel relative path is not the exact state-bound channel path."
                }
                $snapshotChannelPath = [System.IO.Path]::GetFullPath((Join-Path $snapshotRoot $snapshotChannelRelativePath))
                if (-not (Test-GuiPathUnderRoot -Path $snapshotChannelPath -Root $snapshotRoot) -or -not (Test-Path -LiteralPath $snapshotChannelPath -PathType Leaf)) {
                    throw "The authenticated local snapshot channel manifest was not found at its exact path."
                }
                [void](Assert-GuiProtectedLocalPath -Path $snapshotChannelPath -GuardRoot $snapshotRoot -RequireLeaf)
                if (-not [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $snapshotChannelPath).Hash, [string]$snapshotState.release.channelManifestSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
                    throw "Authenticated snapshot channel manifest hash does not match snapshot state."
                }
                $userPhaseArguments = @(
                    "-NoProfile",
                    "-ExecutionPolicy", "Bypass",
                    "-File", $verifiedUserPhasePath,
                    "-ChannelManifestPath", $snapshotChannelPath,
                    "-ExecutionSnapshotStatePath", $snapshotStatePath,
                    "-UserPhaseOnly",
                    "-PhaseResultPath", $script:PendingUserPhaseResultPath
                ) + @($script:PendingUserPhaseArguments)
                if ([string]::Equals($script:PendingUserPhaseComponentKey, "updater", [System.StringComparison]::Ordinal)) {
                    $userPhaseArguments += @("-MachinePhaseResultPath", [System.IO.Path]::GetFullPath($script:ActivePhaseResultPath))
                }
                $script:ActiveProcess = Start-GuiPhaseProcess `
                    -ScriptPath $verifiedUserPhasePath `
                    -Arguments $userPhaseArguments
                $script:ActivePhase = "user"
                $script:ActivePhaseResultPath = $script:PendingUserPhaseResultPath
                $script:ActiveLogPath = $script:PendingUserLogPath
                $script:LastLogLength = -1
                $statusLabel.Text = "Machine update completed; user Codex integration is running unelevated."
                if (-not $logBox.Text.EndsWith("`r`n")) {
                    $logBox.AppendText("`r`n")
                }
                $logBox.AppendText("Machine phase completed. Starting unelevated user integration...`r`n")
                $timer.Start()
                return
            }
            catch {
                $exitCode = 1
                $phaseResult = $null
                if (-not $logBox.Text.EndsWith("`r`n")) {
                    $logBox.AppendText("`r`n")
                }
                $logBox.AppendText("Could not start unelevated user integration: $($_.Exception.Message)`r`n")
            }
        }

        $progress.Style = "Blocks"
        Set-ButtonsEnabled -Enabled $true

        $phaseSucceeded = ($exitCode -eq 0 -and
            $null -ne $phaseResult -and
            [bool]$phaseResult.success)
        if ($completedPhase -eq "user" -and $phaseSucceeded) {
            $statusLabel.Text = "Operation completed."
            if (-not $logBox.Text.EndsWith("`r`n")) {
                $logBox.AppendText("`r`n")
            }
            $logBox.AppendText("Operation completed.`r`n")
            [System.Windows.Forms.MessageBox]::Show(
                "Operation completed.",
                "revAgent",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
        }
        else {
            $resultMessage = if ($null -ne $phaseResult -and -not [string]::IsNullOrWhiteSpace([string]$phaseResult.message)) {
                [string]$phaseResult.message
            }
            elseif (-not [string]::IsNullOrWhiteSpace((Read-GuiLogTail -Path $script:ActiveBrokerLogPath -MaxCharacters 1200))) {
                (Read-GuiLogTail -Path $script:ActiveBrokerLogPath -MaxCharacters 1200).Trim()
            }
            elseif ($exitCode -eq 0) {
                "The phase did not produce a valid completion result."
            }
            else {
                "The phase exited with code $exitCode."
            }
            $statusLabel.Text = if ($null -ne $phaseResult -and [string]$phaseResult.status -eq "blocked") { "Operation deferred." } else { "An error occurred." }
            if (-not $logBox.Text.EndsWith("`r`n")) {
                $logBox.AppendText("`r`n")
            }
            $logBox.AppendText("Install/update did not complete: $resultMessage`r`nUse Open Log for diagnostic details.`r`n")
            [System.Windows.Forms.MessageBox]::Show(
                "Install/update did not complete.`r`n`r`n$resultMessage`r`n`r`nUse Open Log for diagnostic details.",
                "revAgent",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                $(if ($null -ne $phaseResult -and [string]$phaseResult.status -eq "blocked") { [System.Windows.Forms.MessageBoxIcon]::Warning } else { [System.Windows.Forms.MessageBoxIcon]::Error })) | Out-Null
        }
    }
})

$runButton.Add_Click({
    Start-InstallerOperation -Operation "update"
})

$restoreButton.Add_Click({
    Start-InstallerOperation -Operation "restore"
})

$versionButton.Add_Click({
    if (-not (Test-Path -LiteralPath $localVersionTool)) {
        $logBox.Text = "Version check tool is not installed yet.`r`nRun Install/Update first."
        return
    }

    try {
        $output = & $powershellPath -NoProfile -ExecutionPolicy Bypass -File $localVersionTool -ConfigPath $configPath 2>&1 | Out-String
        $logBox.Text = $output
        $statusLabel.Text = "Version check completed."
    }
    catch {
        $logBox.Text = "Version check failed:`r`n$($_.Exception.Message)"
        $statusLabel.Text = "Version check failed."
    }
})

$openLogsButton.Add_Click({
    try {
        Open-GuiLogSnapshot
    }
    catch {
        [System.Windows.Forms.MessageBox]::Show(
            "The revAgent GUI log snapshot could not be opened.`r`n$($_.Exception.Message)",
            "revAgent",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    }
})

$closeButton.Add_Click({
    if ($null -ne $script:ActiveProcess -and -not $script:ActiveProcess.HasExited) {
        [System.Windows.Forms.MessageBox]::Show(
            "An operation is still running. Do not close before it finishes.",
            "revAgent",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
        return
    }
    $form.Close()
})

$form.Add_FormClosing({
    if ($null -ne $script:ActiveProcess -and -not $script:ActiveProcess.HasExited) {
        $_.Cancel = $true
        [System.Windows.Forms.MessageBox]::Show(
            "An operation is still running. Do not close before it finishes.",
            "revAgent",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    }
})

Set-ButtonsEnabled -Enabled $true

$form.Add_Shown({ $script:GuiStartupCompleted = $true })
[void][System.Windows.Forms.Application]::Run($form)
