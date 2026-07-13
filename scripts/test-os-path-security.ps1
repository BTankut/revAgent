<#
.SYNOPSIS
    Verify OS-root and secure-temp trust boundaries under poisoned process state.

.DESCRIPTION
    The updater crosses a UAC boundary and must not derive machine paths from
    inherited, user-controlled environment variables. These tests run without
    elevation and combine executable fixtures, poisoned process variables, and
    source-order assertions so the elevated path cannot silently regress to
    environment-derived roots or a user TEMP/TMP directory.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param([object]$Actual, [object]$Expected, [string]$Message)
    if ($Actual -ne $Expected) { throw "$Message Expected '$Expected', got '$Actual'." }
}

function Assert-ThrowsLike {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    $caught = $null
    try { & $Action }
    catch { $caught = $_ }
    if ($null -eq $caught) { throw "$Message Expected an exception." }
    if (-not ([string]$caught.Exception.Message -match $Pattern)) {
        throw "$Message Unexpected exception: $($caught.Exception.Message)"
    }
}

function Get-Text {
    param([string]$RelativePath)
    return [IO.File]::ReadAllText((Join-Path $RepoRoot $RelativePath))
}

function Assert-OrderedText {
    param(
        [string]$Text,
        [string]$Earlier,
        [string]$Later,
        [string]$Message
    )
    $earlierIndex = $Text.IndexOf($Earlier, [StringComparison]::OrdinalIgnoreCase)
    $laterIndex = $Text.IndexOf($Later, [StringComparison]::OrdinalIgnoreCase)
    if ($earlierIndex -lt 0 -or $laterIndex -lt 0 -or $earlierIndex -ge $laterIndex) {
        throw "$Message earlier='$Earlier' later='$Later'"
    }
}

$systemDirectory = [Environment]::SystemDirectory
$canonicalProgramData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
$canonicalProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$canonicalInstallRoot = Join-Path $canonicalProgramData "DPE\revAgent"
$guiPath = Join-Path $RepoRoot "installer\nas\Install-revAgent-Updater-GUI.ps1"
$channelFixture = Join-Path $RepoRoot "README.md"
$codexModulePath = Join-Path $RepoRoot "installer\lib\RevAgent.CodexRegistration.psm1"
$secureTempModulePath = Join-Path $RepoRoot "installer\lib\RevAgent.SecureTemp.psm1"
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("revagent-os-path-security-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

$poisonNames = @(
    "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "CommonProgramFiles",
    "CommonProgramFiles(x86)", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemDrive", "OS"
)
$savedEnvironment = @{}
foreach ($name in $poisonNames + @("WINDIR", "SystemRoot", "TEMP", "TMP", "PATH", "PSModulePath")) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
$savedEnvironment["PSModulePath"] = [Environment]::GetEnvironmentVariable("PSModulePath", "Process")

try {
    Write-Host "Test SpecialFolder/SystemDirectory roots ignore inherited environment poisoning"
    $poisonRoot = Join-Path $tempRoot "poison"
    foreach ($name in $poisonNames) {
        [Environment]::SetEnvironmentVariable($name, (Join-Path $poisonRoot ($name -replace '[^A-Za-z0-9]', '_')), "Process")
    }
    $env:OS = "not-windows"

    Assert-Equal ([Environment]::SystemDirectory) $systemDirectory "SystemDirectory changed after environment poisoning."
    Assert-Equal ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) $canonicalProgramFiles "Program Files Known Folder changed after environment poisoning."
    Assert-Equal ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) $canonicalProgramData "ProgramData Known Folder changed after environment poisoning."

    $guiOutput = (& $guiPath -ChannelManifestPath $channelFixture -SmokeTest 6>&1 | Out-String)
    Assert-True ($guiOutput -match [regex]::Escape("Install  : $canonicalInstallRoot")) "GUI smoke test did not keep the canonical ProgramData install root under poisoned environment variables. Output: $guiOutput"
    Assert-True ($guiOutput -notmatch [regex]::Escape($poisonRoot)) "GUI smoke test exposed a poisoned machine root. Output: $guiOutput"
    Assert-ThrowsLike -Action {
        & $guiPath -ChannelManifestPath $channelFixture -InstallRoot (Join-Path $poisonRoot "DPE\revAgent") -SmokeTest | Out-Null
    } -Pattern "InstallRoot must be the canonical revAgent machine root" -Message "GUI must reject an environment-poisoned InstallRoot."

    Write-Host "Test copied GUI fails canonical-origin guard before bootstrap-selected module import"
    $copiedGuiRoot = Join-Path $tempRoot "copied-gui"
    $copiedGuiPath = Join-Path $copiedGuiRoot "Install-revAgent-Updater-GUI.ps1"
    $copiedStatePath = Join-Path $copiedGuiRoot "bootstrap-state.json"
    $copiedPoisonModule = Join-Path $copiedGuiRoot "poison-source-free.psm1"
    $copiedPoisonMarker = Join-Path $tempRoot "copied-gui-module-loaded.txt"
    New-Item -ItemType Directory -Path $copiedGuiRoot -Force | Out-Null
    Copy-Item -LiteralPath $guiPath -Destination $copiedGuiPath -Force
    [IO.File]::WriteAllText($copiedPoisonModule, '[IO.File]::WriteAllText($env:REVAGENT_GUI_PREIMPORT_MARKER, "loaded")', [Text.UTF8Encoding]::new($false))
    $poisonHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $copiedPoisonModule).Hash
    [IO.File]::WriteAllText($copiedStatePath, (@{
                sourceAuthentication = @{ independentlyAuthenticated = $true; operatorConfirmed = $true }
                files = @{
                    updaterGui = @{ relativePath = 'Install-revAgent-Updater-GUI.ps1'; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $copiedGuiPath).Hash }
                    sourceFreeMigration = @{ relativePath = 'poison-source-free.psm1'; sha256 = $poisonHash }
                }
            } | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $env:REVAGENT_GUI_PREIMPORT_MARKER = $copiedPoisonMarker
    Assert-ThrowsLike -Action {
        & $copiedGuiPath -ChannelManifestPath $channelFixture -BootstrapStatePath $copiedStatePath | Out-Null
    } -Pattern "protected local bootstrap before module import" -Message "Copied GUI must fail before loading its attacker-selected module."
    Assert-True (-not (Test-Path -LiteralPath $copiedPoisonMarker)) "Copied GUI executed a bootstrap-selected module before canonical-origin rejection."
    Remove-Item Env:\REVAGENT_GUI_PREIMPORT_MARKER -ErrorAction SilentlyContinue

    Remove-Module RevAgent.CodexRegistration -Force -ErrorAction SilentlyContinue
    Import-Module $codexModulePath -Force
    $elevationBefore = Test-RevAgentProcessElevated
    $env:OS = "definitely-not-windows"
    Assert-Equal (Test-RevAgentProcessElevated) $elevationBefore "Elevation detection must not depend on the OS environment variable."

    Write-Host "Test a copied signed Node under poisoned ProgramFiles is audited but never executed"
    $canonicalNode = Join-Path $canonicalProgramFiles "nodejs\node.exe"
    Assert-True (Test-Path -LiteralPath $canonicalNode -PathType Leaf) "The canonical Program Files Node runtime is required for this security fixture."
    $poisonedNode = Join-Path $poisonRoot "ProgramFiles\nodejs\node.exe"
    New-Item -ItemType Directory -Path (Split-Path -Parent $poisonedNode) -Force | Out-Null
    Copy-Item -LiteralPath $canonicalNode -Destination $poisonedNode -Force
    $nodeResolution = Resolve-RevAgentNodeRuntime -ExplicitPath $poisonedNode
    $poisonedCandidate = @($nodeResolution.candidates | Where-Object {
            [string]::Equals([string]$_.path, $poisonedNode, [StringComparison]::OrdinalIgnoreCase)
        }) | Select-Object -First 1
    Assert-True ($null -ne $poisonedCandidate) "Poisoned copied-Node fixture was not audited."
    Assert-True (-not [bool]$poisonedCandidate.systemManaged -and -not [bool]$poisonedCandidate.ready) "A signed executable under a poisoned ProgramFiles variable became executable/ready."
    Assert-Equal $poisonedCandidate.versionProbeExitCode -1 "Poisoned Node must not receive a version execution probe."
    Assert-True ([bool]$nodeResolution.selected.systemManaged) "Selected Node must remain system managed."
    Assert-True ([string]$nodeResolution.selected.path -notmatch [regex]::Escape($poisonRoot)) "Selected Node came from the poisoned root."

    Write-Host "Test WINDIR/SystemRoot poisoning fails closed without redirecting the canonical host path"
    $fakeWindows = Join-Path $poisonRoot "Windows"
    $env:WINDIR = $fakeWindows
    $env:SystemRoot = $fakeWindows
    $rootPoisonError = $null
    try {
        & $guiPath -ChannelManifestPath $channelFixture -SmokeTest | Out-Null
    }
    catch {
        $rootPoisonError = [string]$_.Exception.Message
    }
    finally {
        [Environment]::SetEnvironmentVariable("WINDIR", $savedEnvironment["WINDIR"], "Process")
        [Environment]::SetEnvironmentVariable("SystemRoot", $savedEnvironment["SystemRoot"], "Process")
    }
    if (-not [string]::IsNullOrWhiteSpace($rootPoisonError)) {
        Assert-True ($rootPoisonError -match [regex]::Escape($systemDirectory)) "Root-poisoning failure did not cite the canonical SystemDirectory host. Error: $rootPoisonError"
        Assert-True ($rootPoisonError -notmatch [regex]::Escape($fakeWindows)) "Root-poisoning redirected the GUI to the attacker Windows root. Error: $rootPoisonError"
    }

    Write-Host "Test secure machine TEMP/TMP contract and pre-import ordering"
    Remove-Module RevAgent.SecureTemp -Force -ErrorAction SilentlyContinue
    Import-Module $secureTempModulePath -Force
    $userTemp = Join-Path $tempRoot "user-temp\revAgent-elevated-attacker"
    New-Item -ItemType Directory -Path $userTemp -Force | Out-Null
    Assert-True (-not (Test-RevAgentSecureMachineTempPath -Path $userTemp)) "User-writable TEMP fixture passed the machine-temp trust predicate."
    if (-not (Test-RevitMcpSecureTempAdministrator)) {
        Assert-ThrowsLike -Action { Initialize-RevAgentSecureMachineTemp | Out-Null } -Pattern "requires an elevated process" -Message "Unelevated secure machine-temp initialization must fail closed."
    }

    $entrypoints = @(
        [pscustomobject]@{ Path = "installer\nas\update-from-nas.ps1"; Root = '$nasLibRoot' },
        [pscustomobject]@{ Path = "installer\nas\install-updater-task.ps1"; Root = '$nasLibRoot' },
        [pscustomobject]@{ Path = "installer\install-self-contained.ps1"; Root = '$installerLibRoot'; Protected = $true }
    )
    foreach ($entrypoint in $entrypoints) {
        $text = Get-Text $entrypoint.Path
        $importCommand = if ([bool]$entrypoint.Protected) { 'Import-RevAgentProtectedInstallerModule -Path (Join-Path ' } else { 'Import-Module (Join-Path ' }
        $secureImport = $importCommand + $entrypoint.Root + ' "RevAgent.SecureTemp.psm1")'
        $permissionsImport = $importCommand + $entrypoint.Root + ' "RevAgent.Permissions.psm1")'
        Assert-OrderedText -Text $text -Earlier $secureImport -Later $permissionsImport -Message "$($entrypoint.Path) must import SecureTemp before the Add-Type permissions module."
        Assert-OrderedText -Text $text -Earlier "Initialize-RevAgentSecureMachineTemp" -Later $permissionsImport -Message "$($entrypoint.Path) must initialize secure TEMP/TMP before importing permissions code."
    }
    $secureTempText = Get-Text "installer\lib\RevAgent.SecureTemp.psm1"
    Assert-True ($secureTempText -notmatch '(?im)^\s*Add-Type\b') "SecureTemp must remain a pure pre-Add-Type bootstrap module."

    Write-Host "Test elevated canonical Revit add-in path rejects reparse components"
    $selfContainedPath = Join-Path $RepoRoot "installer\install-self-contained.ps1"
    $safeAddinAncestor = Join-Path $tempRoot "safe-addin-ancestor"
    $outsideAddinTarget = Join-Path $tempRoot "outside-addin-target"
    New-Item -ItemType Directory -Path $safeAddinAncestor, $outsideAddinTarget -Force | Out-Null
    $safeMissingAddinPath = Join-Path $safeAddinAncestor "Autodesk\Revit\Addins\2022"
    $safeAddinOutput = (& $selfContainedPath -AddinPathSecuritySmokeTest $safeMissingAddinPath 6>&1 | Out-String)
    Assert-True ($safeAddinOutput -match '"action":"addin-path-security-smoke-test"') "Safe missing add-in path did not pass the read-only link check. Output: $safeAddinOutput"
    Assert-True (-not (Test-Path -LiteralPath $safeMissingAddinPath)) "Read-only add-in path smoke test created the missing destination."

    $addinJunction = Join-Path $safeAddinAncestor "redirected-addins"
    New-Item -ItemType Junction -Path $addinJunction -Target $outsideAddinTarget | Out-Null
    Assert-ThrowsLike -Action {
        & $selfContainedPath -AddinPathSecuritySmokeTest (Join-Path $addinJunction "2022") | Out-Null
    } -Pattern "reparse point or filesystem link" -Message "Canonical add-in destination must reject a planted parent junction."
    [System.IO.Directory]::Delete($addinJunction, $false)
    Assert-True (Test-Path -LiteralPath $outsideAddinTarget -PathType Container) "Add-in junction rejection damaged its external target."

    $selfContainedText = Get-Text "installer\install-self-contained.ps1"
    Assert-OrderedText -Text $selfContainedText -Earlier "Assert-RevAgentCanonicalAddinPathLinkSafe -Path `$addinRoot" -Later "Repair-RevAgentManagedInstallPermissions -IncludeExistingPayloadTrees" -Message "Self-contained installer must reject add-in reparse components before its first managed permission mutation."
    Assert-True ($selfContainedText -match '(?s)Invoke-RevAgentManagedPermissionRepair -Targets \$targets.*Assert-RevAgentCanonicalAddinPathLinkSafe -Path \$addinRoot') "Self-contained installer must revalidate the canonical add-in path after permission-driven creation."
    Assert-True ($selfContainedText -match '(?s)New-Item -ItemType Directory -Path \$addinRoot -Force.*Assert-RevAgentCanonicalAddinPathLinkSafe -Path \$addinRoot') "Self-contained installer must revalidate the canonical add-in path after explicit creation."

    Write-Host "Test self-contained restricted-token CreateNew/append native probe"
    $nativeTypeMatch = [regex]::Match($selfContainedText, "(?s)Add-Type -TypeDefinition @'\r?\n(?<code>.*?)\r?\n'@")
    Assert-True $nativeTypeMatch.Success "Self-contained protected-origin native type definition was not found."
    if (-not ("RevAgent.ProtectedInstallerOriginNative" -as [type])) {
        Add-Type -TypeDefinition $nativeTypeMatch.Groups['code'].Value
    }
    $nativeProbeFile = Join-Path $tempRoot "native-probe-existing.ps1"
    [IO.File]::WriteAllText($nativeProbeFile, "# probe", [Text.UTF8Encoding]::new($false))
    $nativeProbe = [RevAgent.ProtectedInstallerOriginNative]::ProbeRestrictedWrite($tempRoot, $nativeProbeFile)
    Assert-True ([bool]$nativeProbe.CreateNewAllowed) "Restricted-token probe did not detect effective CreateNew access in the user-writable fixture."
    Assert-True ([bool]$nativeProbe.AppendAllowed) "Restricted-token probe did not detect effective append access in the user-writable fixture."
    $readOnlyProbeRoot = Join-Path $tempRoot "restricted-read-only"
    $readOnlyProbeFile = Join-Path $readOnlyProbeRoot "existing.ps1"
    New-Item -ItemType Directory -Path $readOnlyProbeRoot -Force | Out-Null
    [IO.File]::WriteAllText($readOnlyProbeFile, "# read only probe", [Text.UTF8Encoding]::new($false))
    $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $readOnlyFileAcl = [Security.AccessControl.FileSecurity]::new()
    $readOnlyFileAcl.SetAccessRuleProtection($true, $false)
    [void]$readOnlyFileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentUserSid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, [Security.AccessControl.AccessControlType]::Allow))
    if ("System.IO.FileSystemAclExtensions" -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($readOnlyProbeFile), $readOnlyFileAcl) }
    else { ([IO.FileInfo]::new($readOnlyProbeFile)).SetAccessControl($readOnlyFileAcl) }
    $readOnlyDirectoryAcl = [Security.AccessControl.DirectorySecurity]::new()
    $readOnlyDirectoryAcl.SetAccessRuleProtection($true, $false)
    [void]$readOnlyDirectoryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $currentUserSid,
            [Security.AccessControl.FileSystemRights]::ReadAndExecute,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow))
    if ("System.IO.FileSystemAclExtensions" -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($readOnlyProbeRoot), $readOnlyDirectoryAcl) }
    else { ([IO.DirectoryInfo]::new($readOnlyProbeRoot)).SetAccessControl($readOnlyDirectoryAcl) }
    $readOnlyNativeProbe = [RevAgent.ProtectedInstallerOriginNative]::ProbeRestrictedWrite($readOnlyProbeRoot, $readOnlyProbeFile)
    Assert-True (-not [bool]$readOnlyNativeProbe.CreateNewAllowed) "Restricted-token probe incorrectly reported CreateNew access on a protected read-only fixture."
    Assert-True (-not [bool]$readOnlyNativeProbe.AppendAllowed) "Restricted-token probe incorrectly reported append access on a protected read-only fixture."
    $restoreAcl = [Security.AccessControl.DirectorySecurity]::new()
    $restoreAcl.SetAccessRuleProtection($true, $false)
    [void]$restoreAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $currentUserSid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow))
    if ("System.IO.FileSystemAclExtensions" -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($readOnlyProbeRoot), $restoreAcl) }
    else { ([IO.DirectoryInfo]::new($readOnlyProbeRoot)).SetAccessControl($restoreAcl) }

    Write-Host "Test launcher and source code do not derive privileged roots from environment variables"
    $criticalFiles = @(
        "installer\nas\Install-revAgent-Updater-GUI.ps1",
        "installer\nas\Invoke-revAgent-CodexUserIntegration.ps1",
        "installer\nas\update-from-nas.ps1",
        "installer\nas\install-updater-task.ps1",
        "installer\install-self-contained.ps1",
        "installer\lib\RevAgent.CodexRegistration.psm1",
        "installer\lib\RevAgent.HiddenLauncher.psm1",
        "installer\lib\RevAgent.Permissions.psm1"
    )
    foreach ($criticalFile in $criticalFiles) {
        $text = Get-Text $criticalFile
        Assert-True ($text -notmatch '(?i)\$env:(WINDIR|SystemRoot|ProgramFiles|ProgramData|CommonProgramFiles|USERPROFILE|LOCALAPPDATA|APPDATA|SystemDrive|OS)\b') "$criticalFile still derives a privileged root or platform decision from an inherited environment variable."
    }
    $guiText = Get-Text "installer\nas\Install-revAgent-Updater-GUI.ps1"
    $permissionsText = Get-Text "installer\lib\RevAgent.Permissions.psm1"
    foreach ($profileBindingText in @($guiText, $permissionsText)) {
        Assert-True ($profileBindingText -match 'GetPathRoot\(\[Environment\]::SystemDirectory\)' -and $profileBindingText -match '\(\?i\)%SystemDrive%') "ProfileImagePath normalization must derive SystemDrive only from canonical SystemDirectory."
        Assert-True ($profileBindingText -match 'unsupported environment token') "ProfileImagePath normalization must fail closed on non-SystemDrive environment tokens."
    }
    foreach ($commandWriter in @(
            "installer\nas\update-from-nas.ps1",
            "installer\nas\install-updater-task.ps1",
            "installer\install-self-contained.ps1"
        )) {
        $writerText = Get-Text $commandWriter
        Assert-True ($writerText -notmatch '(?im)^\s*"powershell\.exe\s+-NoProfile') "$commandWriter still emits a PATH-resolved PowerShell helper command."
        Assert-True ($writerText -match '(?i)%__APPDIR__%WindowsPowerShell\\v1\.0\\powershell\.exe') "$commandWriter does not emit helper commands through cmd.exe __APPDIR__."
    }
    foreach ($launcher in @(
            "installer\nas\Install-Revit-MCP-Updater-GUI.cmd",
            "installer\nas\Install-revAgent-Updater-GUI.cmd",
            "installer\nas\Install-revAgent-Updater.cmd",
            "installer\nas\Revit MCP Updater STABLE.cmd",
            "installer\nas\revAgent Updater STABLE.cmd"
        )) {
        $launcherText = Get-Text $launcher
        Assert-True ($launcherText -match '(?i)%__APPDIR__%WindowsPowerShell\\v1\.0\\powershell\.exe') "$launcher does not pin Windows PowerShell through the cmd.exe __APPDIR__ root."
    }
}
finally {
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable([string]$name, [string]$savedEnvironment[$name], "Process")
    }
    Remove-Module RevAgent.CodexRegistration -Force -ErrorAction SilentlyContinue
    Remove-Module RevAgent.SecureTemp -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\REVAGENT_GUI_PREIMPORT_MARKER -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "OS path and secure-temp security tests passed." -ForegroundColor Green
