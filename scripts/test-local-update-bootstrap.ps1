[CmdletBinding()]
param([string]$RepoRoot = "")

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

function Invoke-ExpectBootstrapFailure {
    param([string]$Pattern, [string]$Message)
    $caught = $null
    try {
        & (Join-Path $bootstrapRoot "Start-revAgent-Update.ps1") `
            -BootstrapRoot $bootstrapRoot `
            -ChannelManifestPath (Join-Path $fakeRelease "channels\stable.json") `
            -VerificationOnly `
            -AllowTestRoot | Out-Null
    }
    catch { $caught = $_ }
    Assert-True ($null -ne $caught -and [string]$caught.Exception.Message -match $Pattern) $Message
}

function Restore-TestAcl {
    param([string]$Path, [string]$Sddl, [switch]$Directory)
    $acl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetSecurityDescriptorSddlForm($Sddl, [Security.AccessControl.AccessControlSections]::Access)
    if ($Directory -and ("System.IO.FileSystemAclExtensions" -as [type])) {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo](Get-Item -LiteralPath $Path -Force), $acl)
    }
    elseif (-not $Directory -and ("System.IO.FileSystemAclExtensions" -as [type])) {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo](Get-Item -LiteralPath $Path -Force), $acl)
    }
    elseif ($Directory) { ([IO.DirectoryInfo](Get-Item -LiteralPath $Path -Force)).SetAccessControl($acl) }
    else { ([IO.FileInfo](Get-Item -LiteralPath $Path -Force)).SetAccessControl($acl) }
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ("revagent-local-bootstrap-test-" + [Guid]::NewGuid().ToString("N"))
$bootstrapRoot = Join-Path $temp "bootstrap"
$desktopShortcutRoot = Join-Path $temp "desktop"
$fakeRelease = Join-Path $temp "revAgent-deploy"
$expectedPath = Join-Path $temp "expected.json"
$junctionParent = Join-Path $temp "preplanted-parent"
$junctionTarget = Join-Path $temp "preplanted-target"
$evidenceJunction = Join-Path $temp "evidence-parent"
$evidenceTarget = Join-Path $temp "evidence-target"
$trustedKeys = "C:\ProgramData\DPE\revAgent\updater\config\release-trusted-keys.json"
if (-not (Test-Path -LiteralPath $trustedKeys -PathType Leaf)) { throw "Local public trusted-key fixture was not found: $trustedKeys" }
$sources = [ordered]@{
    bootstrap = Join-Path $RepoRoot "installer\nas\Start-revAgent-Update.ps1"
    launcher = Join-Path $RepoRoot "installer\nas\Start-revAgent-Update.cmd"
    updaterGui = Join-Path $RepoRoot "installer\nas\Install-revAgent-Updater-GUI.ps1"
    distributionIntegrity = Join-Path $RepoRoot "installer\lib\RevAgent.DistributionIntegrity.psm1"
    permissions = Join-Path $RepoRoot "installer\lib\RevAgent.Permissions.psm1"
    sourceFreeMigration = Join-Path $RepoRoot "installer\lib\RevAgent.SourceFreeMigration.psm1"
    releaseSnapshot = Join-Path $RepoRoot "installer\lib\RevAgent.ReleaseSnapshot.psm1"
    privilegedSnapshotUpdate = Join-Path $RepoRoot "installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1"
    trustedKeys = $trustedKeys
}
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
    $runtimeSmoke = & (Join-Path $RepoRoot "installer\nas\Start-revAgent-Update.ps1") -RuntimePathSmokeTest
    Assert-True ([bool]$runtimeSmoke.success -and [IO.Path]::IsPathRooted([string]$runtimeSmoke.powershellPath) -and (Test-Path -LiteralPath $runtimeSmoke.powershellPath -PathType Leaf)) "Bootstrap runtime path smoke test failed."
    $expectedRuntimeDirectory = Split-Path -Parent (Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe")
    Assert-True (-not [bool]$runtimeSmoke.useShellExecute -and [bool]$runtimeSmoke.createNoWindow) "Bootstrap GUI runtime must use direct process creation with no console window."
    Assert-True ([string]::Equals([string]$runtimeSmoke.workingDirectory, $expectedRuntimeDirectory, [StringComparison]::OrdinalIgnoreCase)) "Bootstrap GUI runtime does not use the trusted Windows PowerShell working directory."
    Assert-True ([string]$runtimeSmoke.arguments -match '-STA\s+-NoProfile\s+-WindowStyle\s+Hidden' -and [string]$runtimeSmoke.arguments -match '"C:\\Program Files\\revAgent Bootstrap Smoke\\Install-revAgent-Updater-GUI\.ps1"') "Bootstrap GUI runtime smoke test did not preserve the exact hidden STA argument contract."
    Assert-True ([string]::IsNullOrWhiteSpace([string]$runtimeSmoke.verb) -and [string]::IsNullOrWhiteSpace([string]$runtimeSmoke.userName) -and [string]::IsNullOrWhiteSpace([string]$runtimeSmoke.domain) -and -not [bool]$runtimeSmoke.hasPassword) "Bootstrap GUI runtime must preserve the current interactive token without a verb or alternate credentials."
    Assert-True (-not [bool]$runtimeSmoke.redirectStandardInput -and -not [bool]$runtimeSmoke.redirectStandardOutput -and -not [bool]$runtimeSmoke.redirectStandardError -and [string]$runtimeSmoke.stderrRedirectionMode -eq 'direct_file') "Production bootstrap GUI runtime must leave ProcessStartInfo pipes closed and use direct-file startup stderr redirection."

    Write-Host "Test GUI pre-window failure log and nonzero exit"
    $windowsPowerShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $guiStartupMarker = 'gui-startup-fixture-' + [Guid]::NewGuid().ToString('N')
    $guiLogDirectory = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'DPE\revAgent\logs'
    $guiLogsBefore = @{}
    if (Test-Path -LiteralPath $guiLogDirectory -PathType Container) {
        Get-ChildItem -LiteralPath $guiLogDirectory -Filter 'gui-startup-*.log' -File | ForEach-Object { $guiLogsBefore[$_.FullName] = $true }
    }
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $guiFailureOutput = @(& $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'installer\nas\Install-revAgent-Updater-GUI.ps1') -TestStartupFailureMessage $guiStartupMarker 2>&1 | ForEach-Object { [string]$_ })
        $guiFailureExitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    $newGuiStartupLogs = @(Get-ChildItem -LiteralPath $guiLogDirectory -Filter 'gui-startup-*.log' -File | Where-Object { -not $guiLogsBefore.ContainsKey($_.FullName) })
    Assert-True ($guiFailureExitCode -ne 0) "Injected GUI pre-window startup failure returned success."
    Assert-True ($newGuiStartupLogs.Count -eq 1) "Injected GUI pre-window startup failure did not create exactly one diagnostic log."
    $guiStartupLogText = Get-Content -Raw -LiteralPath $newGuiStartupLogs[0].FullName
    Assert-True ($guiStartupLogText -match [regex]::Escape($guiStartupMarker) -and $guiStartupLogText -match 'languageMode=FullLanguage' -and $guiStartupLogText -match 'psVersion=') "GUI startup diagnostic log is missing failure/runtime evidence."
    Assert-True ((@($guiFailureOutput) -join ' | ') -match [regex]::Escape($newGuiStartupLogs[0].FullName)) "GUI startup stderr did not disclose the diagnostic log path."
    Remove-Item -LiteralPath $newGuiStartupLogs[0].FullName -Force

    Write-Host "Test bootstrap captures quick GUI stderr and exit code"
    $bootstrapSourcePath = Join-Path $RepoRoot 'installer\nas\Start-revAgent-Update.ps1'
    $bootstrapTokens = $null
    $bootstrapParseErrors = $null
    $bootstrapAst = [Management.Automation.Language.Parser]::ParseFile($bootstrapSourcePath, [ref]$bootstrapTokens, [ref]$bootstrapParseErrors)
    Assert-True (@($bootstrapParseErrors).Count -eq 0) "Bootstrap source did not parse for launch-failure coverage."
    $launchFunctionNames = @('New-RevAgentGuiLaunchStderrLogPath', 'Write-RevAgentGuiLaunchFailureLog', 'Show-RevAgentGuiLaunchFailure', 'Start-RevAgentBootstrapGuiProcess')
    $launchFunctionAsts = @($bootstrapAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $launchFunctionNames }, $true))
    Assert-True ($launchFunctionAsts.Count -eq $launchFunctionNames.Count) "Bootstrap GUI launch-failure functions could not be loaded for executable coverage."
    $launchFunctionSource = @($launchFunctionAsts | ForEach-Object { $_.Extent.Text }) -join "`r`n`r`n"
    $launchModule = New-Module -ScriptBlock ([scriptblock]::Create($launchFunctionSource))
    $quickFailureScript = Join-Path $temp 'gui-quick-failure.ps1'
    $quickFailureMarker = 'quick-gui-stderr-' + [Guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($quickFailureScript, "[Console]::Error.WriteLine('$quickFailureMarker'); exit 23", [Text.UTF8Encoding]::new($false))
    $quickFailureStartInfo = [Diagnostics.ProcessStartInfo]::new()
    $quickFailureStartInfo.FileName = $windowsPowerShell
    $quickFailureStartInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $quickFailureScript + '"'
    $quickFailureStartInfo.UseShellExecute = $false
    $quickFailureStartInfo.CreateNoWindow = $true
    $quickFailureStartInfo.RedirectStandardError = $false
    $quickFailureStartInfo.WorkingDirectory = Split-Path -Parent $windowsPowerShell
    $stderrLogsBefore = @{}
    if (Test-Path -LiteralPath $guiLogDirectory -PathType Container) {
        Get-ChildItem -LiteralPath $guiLogDirectory -Filter 'gui-launch-stderr-*.log' -File | ForEach-Object { $stderrLogsBefore[$_.FullName] = $true }
    }
    $quickFailureCaught = $null
    try {
        & $launchModule { Start-RevAgentBootstrapGuiProcess -StartInfo $args[0] -StartupWaitMilliseconds 5000 -SuppressNotification } $quickFailureStartInfo
    }
    catch { $quickFailureCaught = $_ }
    $newStderrLogs = @(Get-ChildItem -LiteralPath $guiLogDirectory -Filter 'gui-launch-stderr-*.log' -File | Where-Object { -not $stderrLogsBefore.ContainsKey($_.FullName) })
    Assert-True ($null -ne $quickFailureCaught -and [string]$quickFailureCaught.Exception.Message -match 'code 23') "Bootstrap did not propagate the quick GUI startup exit code."
    Assert-True ($newStderrLogs.Count -eq 1) "Bootstrap quick GUI failure did not create exactly one stderr diagnostic log."
    $quickFailureLogText = Get-Content -Raw -LiteralPath $newStderrLogs[0].FullName
    Assert-True ($quickFailureLogText -match [regex]::Escape($quickFailureMarker) -and $quickFailureLogText -match 'exitCode=23') "Bootstrap GUI stderr log is missing exit/stderr evidence."
    Remove-Item -LiteralPath $newStderrLogs[0].FullName -Force

    Write-Host "Test long-lived GUI stderr survives bootstrap-parent exit without a pipe"
    $longLivedMarkerPath = Join-Path $temp ('gui-long-lived-' + [Guid]::NewGuid().ToString('N') + '.marker')
    $longLivedGatePath = Join-Path $temp ('gui-long-lived-' + [Guid]::NewGuid().ToString('N') + '.gate')
    $longLivedMarker = 'long-lived-gui-stderr-' + [Guid]::NewGuid().ToString('N')
    $writerTemplate = @'
$gateDeadline = [DateTime]::UtcNow.AddSeconds(20)
while (-not [IO.File]::Exists('__GATE_PATH__') -and [DateTime]::UtcNow -lt $gateDeadline) { Start-Sleep -Milliseconds 50 }
if (-not [IO.File]::Exists('__GATE_PATH__')) { exit 31 }
$chunk = 'x' * 8192
for ($index = 0; $index -lt 512; $index++) { [Console]::Error.Write($chunk) }
[Console]::Error.WriteLine('__STDERR_MARKER__')
[IO.File]::WriteAllText('__MARKER_PATH__', 'complete', [Text.UTF8Encoding]::new($false))
'@
    $writerSource = $writerTemplate.Replace('__STDERR_MARKER__', $longLivedMarker)
    $writerSource = $writerSource.Replace('__MARKER_PATH__', $longLivedMarkerPath.Replace("'", "''"))
    $writerSource = $writerSource.Replace('__GATE_PATH__', $longLivedGatePath.Replace("'", "''"))
    $encodedWriter = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($writerSource))
    $longLivedHarnessPath = Join-Path $temp 'gui-long-lived-parent.ps1'
    $harnessTemplate = @'
__LAUNCH_FUNCTIONS__
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = '__WINDOWS_POWERSHELL__'
$startInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand __WRITER_COMMAND__'
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardError = $false
$startInfo.WorkingDirectory = '__WINDOWS_POWERSHELL_ROOT__'
Start-RevAgentBootstrapGuiProcess -StartInfo $startInfo -StartupWaitMilliseconds 100 -SuppressNotification
'@
    $harnessSource = $harnessTemplate.Replace('__LAUNCH_FUNCTIONS__', $launchFunctionSource)
    $harnessSource = $harnessSource.Replace('__WINDOWS_POWERSHELL__', $windowsPowerShell.Replace("'", "''"))
    $harnessSource = $harnessSource.Replace('__WINDOWS_POWERSHELL_ROOT__', (Split-Path -Parent $windowsPowerShell).Replace("'", "''"))
    $harnessSource = $harnessSource.Replace('__WRITER_COMMAND__', $encodedWriter)
    [IO.File]::WriteAllText($longLivedHarnessPath, $harnessSource, [Text.UTF8Encoding]::new($false))

    $longLivedLogsBefore = @{}
    if (Test-Path -LiteralPath $guiLogDirectory -PathType Container) {
        Get-ChildItem -LiteralPath $guiLogDirectory -Filter 'gui-launch-stderr-*.log' -File | ForEach-Object { $longLivedLogsBefore[$_.FullName] = $true }
    }
    $longLivedParentStartInfo = [Diagnostics.ProcessStartInfo]::new()
    $longLivedParentStartInfo.FileName = $windowsPowerShell
    $longLivedParentStartInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $longLivedHarnessPath + '"'
    $longLivedParentStartInfo.UseShellExecute = $false
    $longLivedParentStartInfo.CreateNoWindow = $true
    $longLivedParentStartInfo.RedirectStandardOutput = $false
    $longLivedParentStartInfo.RedirectStandardError = $false
    $longLivedParentStartInfo.WorkingDirectory = Split-Path -Parent $windowsPowerShell
    $longLivedParent = [Diagnostics.Process]::Start($longLivedParentStartInfo)
    Assert-True ($null -ne $longLivedParent) "Long-lived GUI bootstrap parent did not start."
    try {
        [void]$longLivedParent.Handle
        Assert-True ($longLivedParent.WaitForExit(5000)) "Long-lived GUI bootstrap parent did not exit after transferring stderr ownership to the child log."
        Assert-True ($longLivedParent.ExitCode -eq 0) "Long-lived GUI bootstrap parent returned a failure. exitCode=$($longLivedParent.ExitCode)"
    }
    finally {
        if (-not $longLivedParent.HasExited) { try { $longLivedParent.Kill() } catch { } }
        $longLivedParent.Dispose()
    }
    Assert-True (-not (Test-Path -LiteralPath $longLivedMarkerPath)) "Long-lived GUI completed before the bootstrap parent exited; the fixture did not prove post-parent stderr ownership."
    [IO.File]::WriteAllText($longLivedGatePath, 'continue', [Text.UTF8Encoding]::new($false))

    $longLivedDeadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not (Test-Path -LiteralPath $longLivedMarkerPath -PathType Leaf) -and [DateTime]::UtcNow -lt $longLivedDeadline) {
        Start-Sleep -Milliseconds 100
    }
    Assert-True (Test-Path -LiteralPath $longLivedMarkerPath -PathType Leaf) "Long-lived GUI blocked after its bootstrap parent exited; direct stderr-file redirection did not drain the full payload."
    $longLivedLogs = @(Get-ChildItem -LiteralPath $guiLogDirectory -Filter 'gui-launch-stderr-*.log' -File | Where-Object { -not $longLivedLogsBefore.ContainsKey($_.FullName) })
    Assert-True ($longLivedLogs.Count -eq 1) "Long-lived GUI launch did not create exactly one direct stderr log."
    $longLivedLogText = [IO.File]::ReadAllText($longLivedLogs[0].FullName)
    Assert-True ($longLivedLogs[0].Length -gt 3000000 -and $longLivedLogText -match [regex]::Escape($longLivedMarker)) "Long-lived GUI direct stderr log is incomplete."
    Remove-Item -LiteralPath $longLivedLogs[0].FullName -Force

    $bootstrapLaunchSource = Get-Content -Raw -LiteralPath $bootstrapSourcePath
    Assert-True ($bootstrapLaunchSource -notmatch 'ReadToEndAsync' -and $bootstrapLaunchSource -match 'Microsoft\.PowerShell\.Management\\Start-Process' -and $bootstrapLaunchSource -match '-RedirectStandardError\s+\$stderrLogPath' -and $bootstrapLaunchSource -match '\[void\]\$guiProcess\.Handle') "Bootstrap GUI launch still owns an orphanable stderr pipe or lacks the direct-file/handle-pin contract."

    Write-Host "Test production GUI launch preserves identity and trusted resolution"
    $probeResultPath = Join-Path $temp ('gui-launch-identity-' + [Guid]::NewGuid().ToString('N') + '.json')
    $probeTemplate = @'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$result = [pscustomobject]@{
    sid = $identity.User.Value
    name = $identity.Name
    isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    processPath = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    workingDirectory = [Environment]::CurrentDirectory
}
[IO.File]::WriteAllText('__PROBE_RESULT_PATH__', ($result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
'@
    $probeScript = $probeTemplate.Replace('__PROBE_RESULT_PATH__', $probeResultPath.Replace("'", "''"))
    $encodedProbe = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probeScript))
    $probeStartInfo = $runtimeSmoke.processStartInfo
    Assert-True ($probeStartInfo -is [Diagnostics.ProcessStartInfo]) "Runtime smoke test did not return its production ProcessStartInfo instance."
    $probeStartInfo.Arguments = "-NoProfile -EncodedCommand $encodedProbe"
    $probeStartInfo.RedirectStandardOutput = $false
    $probeStartInfo.RedirectStandardError = $false
    $poisonRoot = Join-Path $temp "poisoned-launch-resolution"
    New-Item -ItemType Directory -Path $poisonRoot -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path ([Environment]::SystemDirectory) "where.exe") -Destination (Join-Path $poisonRoot "powershell.exe") -Force
    Copy-Item -LiteralPath (Join-Path ([Environment]::SystemDirectory) "where.exe") -Destination (Join-Path $poisonRoot "cmd.exe") -Force
    $originalPath = $env:PATH
    $originalLocation = Get-Location
    try {
        $env:PATH = $poisonRoot
        Set-Location -LiteralPath $poisonRoot
        & $launchModule { Start-RevAgentBootstrapGuiProcess -StartInfo $args[0] -StartupWaitMilliseconds 5000 -SuppressNotification } $probeStartInfo
    }
    finally {
        Set-Location -LiteralPath $originalLocation.Path
        $env:PATH = $originalPath
    }
    Assert-True (Test-Path -LiteralPath $probeResultPath -PathType Leaf) "Production bootstrap GUI launch did not complete its child identity probe."
    $probeResult = Get-Content -Raw -LiteralPath $probeResultPath | ConvertFrom-Json
    $parentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $parentPrincipal = [Security.Principal.WindowsPrincipal]::new($parentIdentity)
    Assert-True ([string]::Equals([string]$probeResult.processPath, [string]$runtimeSmoke.powershellPath, [StringComparison]::OrdinalIgnoreCase)) "Bootstrap GUI child resolved through poisoned PATH instead of the absolute trusted PowerShell executable."
    Assert-True ([string]::Equals([string]$probeResult.workingDirectory, $expectedRuntimeDirectory, [StringComparison]::OrdinalIgnoreCase)) "Bootstrap GUI child inherited a caller-controlled working directory."
    Assert-True ([string]$probeResult.sid -eq [string]$parentIdentity.User.Value -and [string]::Equals([string]$probeResult.name, [string]$parentIdentity.Name, [StringComparison]::OrdinalIgnoreCase)) "Bootstrap GUI child did not preserve the current interactive identity."
    Assert-True ([bool]$probeResult.isAdministrator -eq [bool]$parentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) "Bootstrap GUI child changed the parent token's administrator state."
    Remove-Module $launchModule -Force
    New-Item -ItemType Directory -Path (Join-Path $fakeRelease "channels") -Force | Out-Null
    $hashes = [ordered]@{}
    foreach ($entry in $sources.GetEnumerator()) { $hashes[$entry.Key] = (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.Value).Hash }
    $expected = [ordered]@{
        schemaVersion = 1
        app = "revAgent"
        evidenceType = "bootstrap-prestage"
        release = [ordered]@{
            root = $fakeRelease; channel = 'stable'; version = '2099.01.01.test'
            releaseSequence = 10; minimumAcceptedReleaseSequence = 1; highestAcceptedReleaseSequence = 10
            channelManifestSha256 = ('A' * 64); releaseManifestSha256 = ('B' * 64); packageSha256 = ('C' * 64)
            signatureVerified = $true
        }
        localBootstrapInstallerScript = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1")).Hash
        localBootstrapInstallerModule = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.LocalBootstrap.psm1")).Hash
        sources = $hashes
    }
    [IO.File]::WriteAllText($expectedPath, ($expected | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    $state = & (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1") -RepoRoot $RepoRoot -ReleaseRoot $fakeRelease -TrustedKeysPath $trustedKeys -ExpectedHashesPath $expectedPath -BootstrapRoot $bootstrapRoot -DesktopShortcutRoot $desktopShortcutRoot -ConfirmIndependentlyAuthenticatedSource -AllowTestRoot
    Assert-True ([bool]$state.sourceAuthentication.independentlyAuthenticated) "Prestage state lacks independent-authentication evidence."
    Assert-True (Test-Path -LiteralPath (Join-Path $bootstrapRoot "bootstrap-state.json")) "Protected bootstrap state was not installed."
    Assert-True ((Test-Path -LiteralPath (Join-Path $bootstrapRoot "Start-revAgent-Update.cmd") -PathType Leaf) -and $null -ne $state.files.launcher) "Protected local clickable launcher and its hash evidence were not installed."
    $expectedShortcutPath = Join-Path $desktopShortcutRoot "revAgent Updater.lnk"
    $expectedShortcutTarget = Join-Path $bootstrapRoot "Start-revAgent-Update.cmd"
    Assert-True ([bool]$state.desktopShortcut.success -and (Test-Path -LiteralPath $expectedShortcutPath -PathType Leaf)) "Protected bootstrap install did not create the desktop GUI shortcut."
    Assert-True ([string]::Equals([IO.Path]::GetFullPath([string]$state.desktopShortcut.targetPath), [IO.Path]::GetFullPath($expectedShortcutTarget), [StringComparison]::OrdinalIgnoreCase) -and [string]::Equals([IO.Path]::GetFullPath([string]$state.desktopShortcut.path), [IO.Path]::GetFullPath($expectedShortcutPath), [StringComparison]::OrdinalIgnoreCase)) "Desktop shortcut state does not bind to the protected local launcher."
    $shortcutShell = New-Object -ComObject WScript.Shell
    $shortcut = $shortcutShell.CreateShortcut($expectedShortcutPath)
    Assert-True ([string]::Equals([IO.Path]::GetFullPath([string]$shortcut.TargetPath), [IO.Path]::GetFullPath($expectedShortcutTarget), [StringComparison]::OrdinalIgnoreCase) -and [string]::Equals([IO.Path]::GetFullPath([string]$shortcut.WorkingDirectory).TrimEnd("\"), [IO.Path]::GetFullPath($bootstrapRoot).TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) "Desktop shortcut does not open the protected local bootstrap launcher."
    Assert-True ((Test-Path -LiteralPath (Join-Path $bootstrapRoot "Invoke-revAgent-PrivilegedSnapshotUpdate.ps1") -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $bootstrapRoot "lib\RevAgent.ReleaseSnapshot.psm1") -PathType Leaf)) "Protected snapshot broker/module were not installed."
    $protectedPermissionsPath = Join-Path $bootstrapRoot "lib\RevAgent.Permissions.psm1"
    Assert-True ($null -ne $state.files.permissions -and [string]::Equals([string]$state.files.permissions.relativePath, "lib\RevAgent.Permissions.psm1", [StringComparison]::OrdinalIgnoreCase)) "Protected bootstrap state does not bind the permissions sibling."
    Assert-True ((Test-Path -LiteralPath $protectedPermissionsPath -PathType Leaf) -and [string]::Equals((Get-FileHash -Algorithm SHA256 -LiteralPath $protectedPermissionsPath).Hash, [string]$hashes.permissions, [StringComparison]::OrdinalIgnoreCase)) "Protected permissions sibling is missing or does not match authenticated evidence."

    Write-Host "Test valid protected GUI pre-window bootstrap chain in a fresh PS5 child"
    $fakeStableChannelPath = Join-Path $fakeRelease 'channels\stable.json'
    [IO.File]::WriteAllText($fakeStableChannelPath, '{"channel":"stable"}', [Text.UTF8Encoding]::new($false))
    $protectedGuiPath = Join-Path $bootstrapRoot 'Install-revAgent-Updater-GUI.ps1'
    $protectedStatePath = Join-Path $bootstrapRoot 'bootstrap-state.json'
    $preWindowOutput = @(& $windowsPowerShell `
            -NoLogo `
            -NoProfile `
            -NonInteractive `
            -ExecutionPolicy Bypass `
            -File $protectedGuiPath `
            -ChannelManifestPath $fakeStableChannelPath `
            -BootstrapStatePath $protectedStatePath `
            -PreWindowBootstrapSmokeTest 2>&1 | ForEach-Object { [string]$_ })
    $preWindowExitCode = $LASTEXITCODE
    Assert-True ($preWindowExitCode -eq 0) "Valid protected GUI pre-window PS5 child failed. output=$($preWindowOutput -join ' | ')"
    $preWindowJsonLine = @($preWindowOutput | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1)
    Assert-True ($preWindowJsonLine.Count -eq 1) "Valid protected GUI pre-window PS5 child did not return its smoke result. output=$($preWindowOutput -join ' | ')"
    $preWindowResult = $preWindowJsonLine[0] | ConvertFrom-Json
    Assert-True ([bool]$preWindowResult.success -and [string]$preWindowResult.action -eq 'pre-window-bootstrap-smoke-test') "Valid protected GUI pre-window PS5 result was not successful."
    Assert-True ([string]::Equals([IO.Path]::GetFullPath([string]$preWindowResult.bootstrapStatePath), [IO.Path]::GetFullPath($protectedStatePath), [StringComparison]::OrdinalIgnoreCase)) "GUI pre-window smoke did not parse the exact protected bootstrap state."
    foreach ($loadedPath in @($preWindowResult.permissionsModule, $preWindowResult.sourceFreeMigrationModule, $preWindowResult.releaseSnapshotModule, $preWindowResult.trustedKeysPath)) {
        Assert-True ((Test-Path -LiteralPath ([string]$loadedPath) -PathType Leaf) -and [IO.Path]::GetFullPath([string]$loadedPath).StartsWith([IO.Path]::GetFullPath($bootstrapRoot).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) "GUI pre-window smoke loaded evidence outside the protected fixture bootstrap: $loadedPath"
    }
    Remove-Item -LiteralPath $fakeStableChannelPath -Force

    Write-Host "Test protected SourceFreeMigration dependency closure in fresh PS5 and PS7 processes"
    $protectedMigrationPath = Join-Path $bootstrapRoot "lib\RevAgent.SourceFreeMigration.psm1"
    $missingSiblingRoot = Join-Path $temp "missing-permissions-sibling"
    New-Item -ItemType Directory -Path $missingSiblingRoot -Force | Out-Null
    $missingSiblingMigrationPath = Join-Path $missingSiblingRoot "RevAgent.SourceFreeMigration.psm1"
    Copy-Item -LiteralPath $protectedMigrationPath -Destination $missingSiblingMigrationPath
    $protectedMigrationPathBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($protectedMigrationPath))
    $missingSiblingPathBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($missingSiblingMigrationPath))
    $positiveClosureProbe = @"
`$ErrorActionPreference = 'Stop'
try {
    if ('RevAgent.PermissionNativeFileInfo' -as [type]) { throw 'Fresh dependency probe unexpectedly started with the permissions type loaded.' }
    `$modulePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$protectedMigrationPathBase64'))
    Import-Module -Name `$modulePath -Force -ErrorAction Stop
    if (-not ('RevAgent.PermissionNativeFileInfo' -as [type])) { throw 'Permissions native type was not initialized.' }
    if (`$null -eq (Get-Command Get-RevAgentSourceFreeArtifactInventory -ErrorAction Stop)) { throw 'Source-free inventory command was not exported.' }
    exit 0
}
catch { [Console]::Error.WriteLine(`$_.Exception.ToString()); exit 1 }
"@
    $maskedMissingSiblingProbe = @"
`$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition 'namespace RevAgent { public static class PermissionNativeFileInfo { } }'
    `$modulePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$missingSiblingPathBase64'))
    try {
        Import-Module -Name `$modulePath -Force -ErrorAction Stop
        throw 'A preloaded same-named type masked the missing permissions sibling.'
    }
    catch {
        if (`$_.Exception.Message -notmatch 'requires the sibling permissions module') { throw }
    }
    exit 0
}
catch { [Console]::Error.WriteLine(`$_.Exception.ToString()); exit 1 }
"@
    $closureRuntimes = @((Join-Path ([Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe"))
    $pwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $pwshCommand) { $closureRuntimes += [string]$pwshCommand.Source }
    foreach ($closureRuntime in @($closureRuntimes | Select-Object -Unique)) {
        foreach ($probeCase in @(
                [pscustomobject]@{ Name = "positive"; Script = $positiveClosureProbe },
                [pscustomobject]@{ Name = "masked-missing-sibling"; Script = $maskedMissingSiblingProbe }
            )) {
            $encodedClosureProbe = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([string]$probeCase.Script))
            $closureOutput = & $closureRuntime -NoLogo -NoProfile -NonInteractive -EncodedCommand $encodedClosureProbe 2>&1
            $closureExitCode = $LASTEXITCODE
            Assert-True ($closureExitCode -eq 0) ("Fresh bootstrap dependency closure probe failed. runtime={0} case={1} output={2}" -f $closureRuntime, $probeCase.Name, (@($closureOutput) -join " | "))
        }
    }
    $caught = $null
    try { & (Join-Path $bootstrapRoot "Start-revAgent-Update.ps1") -BootstrapRoot $bootstrapRoot -ChannelManifestPath (Join-Path $fakeRelease "channels\stable.json") -VerificationOnly -AllowTestRoot | Out-Null } catch { $caught = $_ }
    Assert-True ($null -ne $caught -and [string]$caught.Exception.Message -match "Bootstrap path is missing") ("Bootstrap execution did not reach fail-closed signed-channel validation. actual={0}" -f $(if ($null -eq $caught) { '<none>' } else { [string]$caught.Exception.Message }))

    Write-Host "Test foreign bootstrap writer fails closed"
    $bootstrapScriptPath = Join-Path $bootstrapRoot "Start-revAgent-Update.ps1"
    $bootstrapScriptAcl = Get-Acl -LiteralPath $bootstrapScriptPath
    $bootstrapScriptSddl = $bootstrapScriptAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    try {
        [void]$bootstrapScriptAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new("S-1-5-32-546"),
                [Security.AccessControl.FileSystemRights]::WriteData,
                [Security.AccessControl.AccessControlType]::Allow))
        Restore-TestAcl -Path $bootstrapScriptPath -Sddl ($bootstrapScriptAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access))
        Invoke-ExpectBootstrapFailure -Pattern "write-capable access to an untrusted principal" -Message "A foreign standard-user/group writer on the local executable trust anchor was accepted."
    }
    finally { Restore-TestAcl -Path $bootstrapScriptPath -Sddl $bootstrapScriptSddl }

    Write-Host "Test unprotected bootstrap DACL fails closed"
    $bootstrapRootAcl = Get-Acl -LiteralPath $bootstrapRoot
    $bootstrapRootSddl = $bootstrapRootAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    try {
        $bootstrapRootAcl.SetAccessRuleProtection($false, $true)
        Restore-TestAcl -Path $bootstrapRoot -Sddl ($bootstrapRootAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)) -Directory
        Invoke-ExpectBootstrapFailure -Pattern "DACL must be protected from inheritance" -Message "An unprotected local bootstrap DACL was accepted."
    }
    finally { Restore-TestAcl -Path $bootstrapRoot -Sddl $bootstrapRootSddl -Directory }

    Write-Host "Test current and stale signed-component freshness bindings"
    $fakeTools = Join-Path $fakeRelease "tools"
    $fakeManifestRoot = Join-Path $fakeRelease "releases\current"
    New-Item -ItemType Directory -Path $fakeTools, $fakeManifestRoot -Force | Out-Null
    $surfaceFiles = [ordered]@{
        localBootstrap = @("installer\nas\Start-revAgent-Update.ps1", "Start-revAgent-Update.ps1")
        updaterGui = @("installer\nas\Install-revAgent-Updater-GUI.ps1", "Install-revAgent-Updater-GUI.ps1")
        updater = @("installer\nas\update-from-nas.ps1", "update-from-nas.ps1")
        updaterTaskInstaller = @("installer\nas\install-updater-task.ps1", "install-updater-task.ps1")
        installerLibDistributionIntegrity = @("installer\lib\RevAgent.DistributionIntegrity.psm1", "lib\RevAgent.DistributionIntegrity.psm1")
        installerLibSourceFreeMigration = @("installer\lib\RevAgent.SourceFreeMigration.psm1", "lib\RevAgent.SourceFreeMigration.psm1")
        installerLibReleaseSnapshot = @("installer\lib\RevAgent.ReleaseSnapshot.psm1", "lib\RevAgent.ReleaseSnapshot.psm1")
        privilegedSnapshotUpdate = @("installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1", "Invoke-revAgent-PrivilegedSnapshotUpdate.ps1")
        installerLibLocalBootstrap = @("installer\lib\RevAgent.LocalBootstrap.psm1", "lib\RevAgent.LocalBootstrap.psm1")
        installerLibHiddenLauncher = @("installer\lib\RevAgent.HiddenLauncher.psm1", "lib\RevAgent.HiddenLauncher.psm1")
        installerLibScheduledTask = @("installer\lib\RevAgent.ScheduledTask.psm1", "lib\RevAgent.ScheduledTask.psm1")
        installerLibVersions = @("installer\lib\RevAgent.RevitVersions.psm1", "lib\RevAgent.RevitVersions.psm1")
        installerLibPackage = @("installer\lib\RevAgent.Package.psm1", "lib\RevAgent.Package.psm1")
        installerLibUpdatePolicy = @("installer\lib\RevAgent.UpdatePolicy.psm1", "lib\RevAgent.UpdatePolicy.psm1")
        installerLibProxy = @("installer\lib\RevAgent.Proxy.psm1", "lib\RevAgent.Proxy.psm1")
        installerLibLogRetention = @("installer\lib\RevAgent.LogRetention.psm1", "lib\RevAgent.LogRetention.psm1")
        installerLibPermissions = @("installer\lib\RevAgent.Permissions.psm1", "lib\RevAgent.Permissions.psm1")
        installerLibSecureTemp = @("installer\lib\RevAgent.SecureTemp.psm1", "lib\RevAgent.SecureTemp.psm1")
        installerLibCodexRegistration = @("installer\lib\RevAgent.CodexRegistration.psm1", "lib\RevAgent.CodexRegistration.psm1")
        installerLibConfigSync = @("installer\lib\RevAgent.ConfigSync.psm1", "lib\RevAgent.ConfigSync.psm1")
        installerLibReporting = @("installer\lib\RevAgent.Reporting.psm1", "lib\RevAgent.Reporting.psm1")
        installerLibDesktopLauncherCleanup = @("installer\lib\RevAgent.DesktopLauncherCleanup.psm1", "lib\RevAgent.DesktopLauncherCleanup.psm1")
        installerLibLicense = @("installer\lib\RevAgent.License.psm1", "lib\RevAgent.License.psm1")
    }
    $components = [ordered]@{}
    foreach ($surface in $surfaceFiles.GetEnumerator()) {
        $sourcePath = Join-Path $RepoRoot ([string]$surface.Value[0])
        $destinationPath = Join-Path $fakeTools ([string]$surface.Value[1])
        New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
        $components[$surface.Key] = [ordered]@{ path = [string]$surface.Value[0]; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $destinationPath).Hash }
    }
    $components["localBootstrapLauncher"] = [ordered]@{ path = "installer\nas\Start-revAgent-Update.cmd"; sha256 = [string]$state.files.launcher.sha256 }
    $manifestPath = Join-Path $fakeManifestRoot "manifest.json"
    $channelPath = Join-Path $fakeRelease "channels\stable.json"
    [IO.File]::WriteAllText($manifestPath, ([ordered]@{ schemaVersion = 1; app = "revAgent"; components = $components } | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($channelPath, ([ordered]@{ schemaVersion = 1; app = "revAgent"; channel = "stable"; version = "current"; manifestPath = "..\releases\current\manifest.json" } | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))

    $currentCaught = $null
    try { & (Join-Path $bootstrapRoot "Start-revAgent-Update.ps1") -BootstrapRoot $bootstrapRoot -ChannelManifestPath $channelPath -VerificationOnly -AllowTestRoot | Out-Null } catch { $currentCaught = $_ }
    Assert-True ($null -ne $currentCaught -and [string]$currentCaught.Exception.Message -match "packagePath" -and [string]$currentCaught.Exception.Message -notmatch "bootstrap_refresh_required") "Current local bootstrap components did not pass freshness binding before signed package transport validation."

    $components.localBootstrapLauncher.sha256 = ("0" * 64)
    [IO.File]::WriteAllText($manifestPath, ([ordered]@{ schemaVersion = 1; app = "revAgent"; components = $components } | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $staleCaught = $null
    try { & (Join-Path $bootstrapRoot "Start-revAgent-Update.ps1") -BootstrapRoot $bootstrapRoot -ChannelManifestPath $channelPath -VerificationOnly -AllowTestRoot | Out-Null } catch { $staleCaught = $_ }
    Assert-True ($null -ne $staleCaught -and [string]$staleCaught.Exception.Message -match "bootstrap_refresh_required.*launcher") "A stale protected local launcher did not fail closed with bootstrap_refresh_required."

    New-Item -ItemType Directory -Path $junctionTarget -Force | Out-Null
    $junctionMarker = Join-Path $junctionTarget "must-remain-unchanged.txt"
    [IO.File]::WriteAllText($junctionMarker, "unchanged", [Text.UTF8Encoding]::new($false))
    $markerHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $junctionMarker).Hash
    $targetChildrenBefore = @((Get-ChildItem -LiteralPath $junctionTarget -Force | Select-Object -ExpandProperty Name) | Sort-Object)
    New-Item -ItemType Junction -Path $junctionParent -Target $junctionTarget | Out-Null
    $junctionCaught = $null
    try {
        & (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1") -RepoRoot $RepoRoot -ReleaseRoot $fakeRelease -TrustedKeysPath $trustedKeys -ExpectedHashesPath $expectedPath -BootstrapRoot (Join-Path $junctionParent "bootstrap") -ConfirmIndependentlyAuthenticatedSource -AllowTestRoot | Out-Null
    }
    catch { $junctionCaught = $_ }
    Assert-True ($null -ne $junctionCaught -and [string]$junctionCaught.Exception.Message -match "filesystem link") "Preplanted bootstrap parent junction was not rejected before destination writes."
    Assert-True ((Test-Path -LiteralPath $junctionMarker -PathType Leaf) -and (Get-FileHash -Algorithm SHA256 -LiteralPath $junctionMarker).Hash -eq $markerHashBefore) "Preplanted junction target marker changed during rejected bootstrap install."
    $targetChildrenAfter = @((Get-ChildItem -LiteralPath $junctionTarget -Force | Select-Object -ExpandProperty Name) | Sort-Object)
    Assert-True ([string]::Join("|", $targetChildrenAfter) -eq [string]::Join("|", $targetChildrenBefore)) "Rejected bootstrap install wrote files through the preplanted parent junction."
    [IO.Directory]::Delete($junctionParent)

    New-Item -ItemType Directory -Path $evidenceTarget -Force | Out-Null
    $linkedExpectedPath = Join-Path $evidenceTarget "expected.json"
    Copy-Item -LiteralPath $expectedPath -Destination $linkedExpectedPath
    $evidenceHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $linkedExpectedPath).Hash
    New-Item -ItemType Junction -Path $evidenceJunction -Target $evidenceTarget | Out-Null
    $evidenceBootstrapRoot = Join-Path $temp "evidence-junction-bootstrap"
    $evidenceCaught = $null
    try {
        & (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1") -RepoRoot $RepoRoot -ReleaseRoot $fakeRelease -TrustedKeysPath $trustedKeys -ExpectedHashesPath (Join-Path $evidenceJunction "expected.json") -BootstrapRoot $evidenceBootstrapRoot -ConfirmIndependentlyAuthenticatedSource -AllowTestRoot | Out-Null
    }
    catch { $evidenceCaught = $_ }
    Assert-True ($null -ne $evidenceCaught -and [string]$evidenceCaught.Exception.Message -match "filesystem link/reparse component") "Authenticated hash evidence reached through a parent junction was not rejected."
    Assert-True (-not (Test-Path -LiteralPath $evidenceBootstrapRoot)) "Evidence parent-junction rejection occurred after bootstrap destination writes."
    Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $linkedExpectedPath).Hash -eq $evidenceHashBefore) "Rejected evidence parent junction changed its target file."
    [IO.Directory]::Delete($evidenceJunction)

    $swapRepo = Join-Path $temp "swap-repo"
    foreach ($relativeDirectory in @("installer\lib", "installer\nas")) {
        New-Item -ItemType Directory -Path (Join-Path $swapRepo $relativeDirectory) -Force | Out-Null
    }
    foreach ($relativePath in @(
            "installer\lib\RevAgent.LocalBootstrap.psm1",
            "installer\lib\RevAgent.DistributionIntegrity.psm1",
            "installer\lib\RevAgent.Permissions.psm1",
            "installer\lib\RevAgent.SourceFreeMigration.psm1",
            "installer\lib\RevAgent.ReleaseSnapshot.psm1",
            "installer\nas\Start-revAgent-Update.ps1",
            "installer\nas\Start-revAgent-Update.cmd",
            "installer\nas\Install-revAgent-Updater-GUI.ps1",
            "installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1"
        )) {
        Copy-Item -LiteralPath (Join-Path $RepoRoot $relativePath) -Destination (Join-Path $swapRepo $relativePath)
    }
    $swapSources = [ordered]@{
        bootstrap = Join-Path $swapRepo "installer\nas\Start-revAgent-Update.ps1"
        launcher = Join-Path $swapRepo "installer\nas\Start-revAgent-Update.cmd"
        updaterGui = Join-Path $swapRepo "installer\nas\Install-revAgent-Updater-GUI.ps1"
        distributionIntegrity = Join-Path $swapRepo "installer\lib\RevAgent.DistributionIntegrity.psm1"
        permissions = Join-Path $swapRepo "installer\lib\RevAgent.Permissions.psm1"
        sourceFreeMigration = Join-Path $swapRepo "installer\lib\RevAgent.SourceFreeMigration.psm1"
        releaseSnapshot = Join-Path $swapRepo "installer\lib\RevAgent.ReleaseSnapshot.psm1"
        privilegedSnapshotUpdate = Join-Path $swapRepo "installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1"
        trustedKeys = $trustedKeys
    }
    $swapHashes = [ordered]@{}
    foreach ($entry in $swapSources.GetEnumerator()) { $swapHashes[$entry.Key] = (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.Value).Hash }
    $swapModulePath = Join-Path $swapRepo "installer\lib\RevAgent.LocalBootstrap.psm1"
    $swapExpectedPath = Join-Path $temp "swap-expected.json"
    [IO.File]::WriteAllText($swapExpectedPath, ([ordered]@{
                schemaVersion = 1
                app = "revAgent"
                evidenceType = "bootstrap-prestage"
                release = [ordered]@{
                    root = $fakeRelease; channel = 'stable'; version = '2099.01.01.test'
                    releaseSequence = 10; minimumAcceptedReleaseSequence = 1; highestAcceptedReleaseSequence = 10
                    channelManifestSha256 = ('A' * 64); releaseManifestSha256 = ('B' * 64); packageSha256 = ('C' * 64)
                    signatureVerified = $true
                }
                localBootstrapInstallerScript = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1")).Hash
                localBootstrapInstallerModule = (Get-FileHash -Algorithm SHA256 -LiteralPath $swapModulePath).Hash
                sources = $swapHashes
            } | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    $swapBootstrapRoot = Join-Path $temp "swap-bootstrap"
    $swapCaught = $null
    $swapHook = { param($Path) [IO.File]::AppendAllText($Path, "`r`n# deterministic hash-to-import swap") }
    try {
        & (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1") -RepoRoot $swapRepo -ReleaseRoot $fakeRelease -TrustedKeysPath $trustedKeys -ExpectedHashesPath $swapExpectedPath -BootstrapRoot $swapBootstrapRoot -ConfirmIndependentlyAuthenticatedSource -AllowTestRoot -ModuleStageTestHook $swapHook | Out-Null
    }
    catch { $swapCaught = $_ }
    Assert-True ($null -ne $swapCaught -and [string]$swapCaught.Exception.Message -match "changed identity or content after verification") "Hash-to-import module source swap was not rejected after protected staging."
    Assert-True (-not (Test-Path -LiteralPath $swapBootstrapRoot)) "Hash-to-import rejection occurred after bootstrap installation."

    Write-Host "Test legacy developer product-root ACL migration"
    $aclFixtureRoot = Join-Path $temp "legacy-product-root-fixture"
    $aclFixtureShared = Join-Path $aclFixtureRoot "DPE"
    $aclFixtureProduct = Join-Path $aclFixtureShared "revAgent"
    $aclFixtureLinkTarget = Join-Path $aclFixtureRoot "junction-target"
    $aclFixtureLink = Join-Path $aclFixtureShared "linkedAgent"
    $aclFixtureSwap = Join-Path $aclFixtureShared "revAgent-swapped"
    New-Item -ItemType Directory -Path $aclFixtureProduct, $aclFixtureLinkTarget -Force | Out-Null
    New-Item -ItemType Junction -Path $aclFixtureLink -Target $aclFixtureLinkTarget | Out-Null
    $localBootstrapModule = Import-Module (Join-Path $RepoRoot "installer\lib\RevAgent.LocalBootstrap.psm1") -Force -PassThru
    try {
        $aclFixtureResult = & $localBootstrapModule {
            param($SharedPath, $ProductPath, $LinkName, $UntrustedOwnerSid, $SwapPath)

            $script:AclFixtureSharedPath = [IO.Path]::GetFullPath($SharedPath).TrimEnd('\')
            $script:AclFixtureProductPath = [IO.Path]::GetFullPath($ProductPath).TrimEnd('\')
            $script:AclFixtureProductOwner = 'S-1-5-32-544'
            $script:AclFixtureHardened = $false
            $script:AclFixtureHardenCallCount = 0
            $script:AclFixtureRenameBlocked = $false

            function New-AclFixtureRule {
                param([string]$Sid, [Security.AccessControl.FileSystemRights]$Rights)
                return [pscustomobject]@{
                    AccessControlType = [Security.AccessControl.AccessControlType]::Allow
                    IdentityReference = [Security.Principal.SecurityIdentifier]::new($Sid)
                    FileSystemRights = $Rights
                }
            }

            function New-AclFixtureDescriptor {
                param([string]$OwnerSid, [bool]$Protected, [object[]]$Rules)
                $descriptor = [pscustomobject]@{
                    AreAccessRulesProtected = $Protected
                    FixtureOwnerSid = $OwnerSid
                    FixtureRules = @($Rules)
                }
                $descriptor | Add-Member -MemberType ScriptMethod -Name GetOwner -Value {
                    param($TargetType)
                    return [Security.Principal.SecurityIdentifier]::new([string]$this.FixtureOwnerSid)
                }
                $descriptor | Add-Member -MemberType ScriptMethod -Name GetAccessRules -Value {
                    param($IncludeExplicit, $IncludeInherited, $TargetType)
                    return @($this.FixtureRules)
                }
                return $descriptor
            }

            function Get-Acl {
                [CmdletBinding()]
                param([Parameter(Mandatory = $true)][string]$LiteralPath)
                $canonical = [IO.Path]::GetFullPath($LiteralPath).TrimEnd('\')
                if ([string]::Equals($canonical, $script:AclFixtureSharedPath, [StringComparison]::OrdinalIgnoreCase)) {
                    # The shared DPE ancestor may allow create/write data, but it
                    # may not delegate delete, DACL, or ownership capability.
                    return New-AclFixtureDescriptor -OwnerSid 'S-1-5-32-544' -Protected $false -Rules @(
                        (New-AclFixtureRule -Sid 'S-1-5-32-545' -Rights ([Security.AccessControl.FileSystemRights]::Write))
                    )
                }
                if ([string]::Equals($canonical, $script:AclFixtureProductPath, [StringComparison]::OrdinalIgnoreCase)) {
                    if ($script:AclFixtureHardened) {
                        return New-AclFixtureDescriptor -OwnerSid 'S-1-5-32-544' -Protected $true -Rules @(
                            (New-AclFixtureRule -Sid 'S-1-5-32-545' -Rights ([Security.AccessControl.FileSystemRights]::ReadAndExecute))
                        )
                    }
                    return New-AclFixtureDescriptor -OwnerSid $script:AclFixtureProductOwner -Protected $false -Rules @(
                        (New-AclFixtureRule -Sid $UntrustedOwnerSid -Rights ([Security.AccessControl.FileSystemRights]::Modify))
                    )
                }
                Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath
            }

            function Set-RevAgentBootstrapDacl {
                param([Parameter(Mandatory = $true)][string]$Path, [switch]$SetAdministratorsOwner)
                $canonical = [IO.Path]::GetFullPath($Path).TrimEnd('\')
                if (-not [string]::Equals($canonical, $script:AclFixtureProductPath, [StringComparison]::OrdinalIgnoreCase) -or -not $SetAdministratorsOwner) {
                    throw "Fixture observed an unexpected ACL hardening target. path=$canonical"
                }
                $script:AclFixtureHardenCallCount++
                try {
                    Move-Item -LiteralPath $script:AclFixtureProductPath -Destination $SwapPath -ErrorAction Stop
                    Move-Item -LiteralPath $SwapPath -Destination $script:AclFixtureProductPath -ErrorAction Stop
                }
                catch { $script:AclFixtureRenameBlocked = $true }
                $script:AclFixtureHardened = $true
            }

            $identityGuard = Open-RevAgentBootstrapDirectoryGuard -Path $ProductPath
            try { $identityBefore = [string]$identityGuard.Identity }
            finally { $identityGuard.Handle.Dispose() }
            $successPath = Initialize-RevAgentProtectedProductRoot -SharedParent $SharedPath -Name 'revAgent'
            $identityGuard = Open-RevAgentBootstrapDirectoryGuard -Path $ProductPath
            try { $identityAfter = [string]$identityGuard.Identity }
            finally { $identityGuard.Handle.Dispose() }
            $successHardened = $script:AclFixtureHardened
            $successHardenCalls = $script:AclFixtureHardenCallCount

            $script:AclFixtureHardened = $false
            $script:AclFixtureProductOwner = $UntrustedOwnerSid
            $maliciousOwnerError = $null
            try { Initialize-RevAgentProtectedProductRoot -SharedParent $SharedPath -Name 'revAgent' | Out-Null }
            catch { $maliciousOwnerError = [string]$_.Exception.Message }
            $callsAfterMaliciousOwner = $script:AclFixtureHardenCallCount

            $linkError = $null
            try { Initialize-RevAgentProtectedProductRoot -SharedParent $SharedPath -Name $LinkName | Out-Null }
            catch { $linkError = [string]$_.Exception.Message }

            return [pscustomobject]@{
                successPath = $successPath
                successHardened = $successHardened
                successHardenCalls = $successHardenCalls
                renameBlocked = $script:AclFixtureRenameBlocked
                identityBefore = $identityBefore
                identityAfter = $identityAfter
                maliciousOwnerError = $maliciousOwnerError
                callsAfterMaliciousOwner = $callsAfterMaliciousOwner
                linkError = $linkError
            }
        } $aclFixtureShared $aclFixtureProduct 'linkedAgent' ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) $aclFixtureSwap
    }
    finally {
        Remove-Module $localBootstrapModule.Name -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $aclFixtureLink) { [IO.Directory]::Delete($aclFixtureLink) }
    }
    Assert-True ([bool]$aclFixtureResult.successHardened -and [int]$aclFixtureResult.successHardenCalls -eq 1 -and [string]::Equals([IO.Path]::GetFullPath([string]$aclFixtureResult.successPath), [IO.Path]::GetFullPath($aclFixtureProduct), [StringComparison]::OrdinalIgnoreCase)) "A trusted legacy developer product root with a user Modify/Delete ACE was not hardened in place."
    Assert-True ([bool]$aclFixtureResult.renameBlocked -and [string]::Equals([string]$aclFixtureResult.identityBefore, [string]$aclFixtureResult.identityAfter, [StringComparison]::Ordinal)) "Legacy product-root ACL migration did not hold a no-FILE_SHARE_DELETE handle with stable path identity."
    Assert-True ([string]$aclFixtureResult.maliciousOwnerError -match "untrusted owner" -and [int]$aclFixtureResult.callsAfterMaliciousOwner -eq 1) "A product root with an untrusted owner reached ACL mutation."
    Assert-True ([string]$aclFixtureResult.linkError -match "filesystem link") "A product-root junction was not rejected before ACL mutation."

    Write-Host "Test standalone prestage shared-ancestor ACL gate"
    $prestageInstallerPath = Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1"
    $parseTokens = $null
    $parseErrors = $null
    $prestageAst = [Management.Automation.Language.Parser]::ParseFile($prestageInstallerPath, [ref]$parseTokens, [ref]$parseErrors)
    Assert-True (@($parseErrors).Count -eq 0) "Standalone prestage installer did not parse for executable ACL-gate regression coverage."
    $validatorAsts = @($prestageAst.FindAll({
                param($node)
                $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -in @('Assert-RevAgentPrestageAdminDirectory', 'Assert-RevAgentPrestageSharedAncestorSafe')
            }, $true))
    Assert-True ($validatorAsts.Count -eq 2) "Standalone prestage ACL validators could not be loaded for executable regression coverage."
    $validatorModule = New-Module -ScriptBlock ([scriptblock]::Create((@($validatorAsts | ForEach-Object { $_.Extent.Text }) -join "`r`n`r`n")))
    try {
        $validatorResult = & $validatorModule {
            param($FixturePath, $UntrustedSid)

            $script:FixtureOwnerSid = 'S-1-5-32-544'
            $script:FixtureRights = [Security.AccessControl.FileSystemRights]::Write
            $script:FixtureProtected = $false
            $script:FixtureAccessControlType = [Security.AccessControl.AccessControlType]::Allow
            $script:NoLinksCheckCount = 0

            function Assert-RevAgentPrestagePathNoLinks {
                param([Parameter(Mandatory = $true)][string]$Path)
                $script:NoLinksCheckCount++
                return [IO.Path]::GetFullPath($Path)
            }

            function Get-Acl {
                [CmdletBinding()]
                param([Parameter(Mandatory = $true)][string]$LiteralPath)
                $rule = [pscustomobject]@{
                    AccessControlType = $script:FixtureAccessControlType
                    IdentityReference = [Security.Principal.SecurityIdentifier]::new($UntrustedSid)
                    FileSystemRights = $script:FixtureRights
                    IsInherited = $true
                    InheritanceFlags = [Security.AccessControl.InheritanceFlags]::ContainerInherit
                    PropagationFlags = [Security.AccessControl.PropagationFlags]::None
                }
                $descriptor = [pscustomobject]@{
                    AreAccessRulesProtected = $script:FixtureProtected
                    FixtureOwnerSid = $script:FixtureOwnerSid
                    FixtureRules = @($rule)
                }
                $descriptor | Add-Member -MemberType ScriptMethod -Name GetOwner -Value {
                    param($TargetType)
                    return [Security.Principal.SecurityIdentifier]::new([string]$this.FixtureOwnerSid)
                }
                $descriptor | Add-Member -MemberType ScriptMethod -Name GetAccessRules -Value {
                    param($IncludeExplicit, $IncludeInherited, $TargetType)
                    return @($this.FixtureRules)
                }
                return $descriptor
            }

            $safeSharedAccepted = $true
            try { Assert-RevAgentPrestageSharedAncestorSafe -Path $FixturePath }
            catch { $safeSharedAccepted = $false }

            $strictError = $null
            try { Assert-RevAgentPrestageAdminDirectory -Path $FixturePath }
            catch { $strictError = [string]$_.Exception.Message }

            $script:FixtureProtected = $true
            $script:FixtureRights = [Security.AccessControl.FileSystemRights]::ReadAndExecute
            $protectedReadAccepted = $true
            try { Assert-RevAgentPrestageAdminDirectory -Path $FixturePath }
            catch { $protectedReadAccepted = $false }
            $script:FixtureRights = [Security.AccessControl.FileSystemRights]::Write
            $strictWriteError = $null
            try { Assert-RevAgentPrestageAdminDirectory -Path $FixturePath }
            catch { $strictWriteError = [string]$_.Exception.Message }

            $dangerErrors = @{}
            foreach ($right in @(
                    [Security.AccessControl.FileSystemRights]::Delete,
                    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
                    [Security.AccessControl.FileSystemRights]::ChangePermissions,
                    [Security.AccessControl.FileSystemRights]::TakeOwnership,
                    [Security.AccessControl.FileSystemRights]::Modify,
                    [Security.AccessControl.FileSystemRights]::FullControl)) {
                $script:FixtureRights = $right
                try { Assert-RevAgentPrestageSharedAncestorSafe -Path $FixturePath }
                catch { $dangerErrors[[string]$right] = [string]$_.Exception.Message }
            }

            $script:FixtureRights = [Security.AccessControl.FileSystemRights]::Write
            $script:FixtureOwnerSid = $UntrustedSid
            $ownerError = $null
            try { Assert-RevAgentPrestageSharedAncestorSafe -Path $FixturePath }
            catch { $ownerError = [string]$_.Exception.Message }

            $script:FixtureOwnerSid = 'S-1-5-32-544'
            $script:FixtureRights = [Security.AccessControl.FileSystemRights]::FullControl
            $script:FixtureAccessControlType = [Security.AccessControl.AccessControlType]::Deny
            $denyAccepted = $true
            try { Assert-RevAgentPrestageSharedAncestorSafe -Path $FixturePath }
            catch { $denyAccepted = $false }

            return [pscustomobject]@{
                safeSharedAccepted = $safeSharedAccepted
                strictError = $strictError
                protectedReadAccepted = $protectedReadAccepted
                strictWriteError = $strictWriteError
                dangerErrors = $dangerErrors
                ownerError = $ownerError
                denyAccepted = $denyAccepted
                noLinksCheckCount = $script:NoLinksCheckCount
            }
        } $aclFixtureShared ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    }
    finally { Remove-Module $validatorModule.Name -Force -ErrorAction SilentlyContinue }
    Assert-True ([bool]$validatorResult.safeSharedAccepted) "Standalone prestage rejected a trusted, inheritance-enabled shared DPE ancestor with non-admin create/write access."
    Assert-True ([string]$validatorResult.strictError -match 'owner/DACL is not protected') "Standalone prestage no longer keeps the revAgent product-root gate strictly inheritance-protected."
    Assert-True ([bool]$validatorResult.protectedReadAccepted) "Standalone prestage misclassified the protected revAgent root's intentional non-admin read/execute grant as writable."
    Assert-True ([string]$validatorResult.strictWriteError -match 'writable by a non-administrator') "Standalone prestage accepted a protected revAgent root with non-admin write access."
    foreach ($rightName in @('Delete', 'DeleteSubdirectoriesAndFiles', 'ChangePermissions', 'TakeOwnership', 'Modify', 'FullControl')) {
        Assert-True ([string]$validatorResult.dangerErrors[$rightName] -match 'delete/ACL/owner capability') "Standalone prestage shared-ancestor gate accepted dangerous non-admin right '$rightName'."
    }
    Assert-True ([string]$validatorResult.ownerError -match 'must be owned by SYSTEM or Administrators') "Standalone prestage shared-ancestor gate accepted an untrusted owner."
    Assert-True ([bool]$validatorResult.denyAccepted) "Standalone prestage shared-ancestor gate misclassified a non-admin deny ACE as delegated capability."
    Assert-True ([int]$validatorResult.noLinksCheckCount -ge 7) "Standalone prestage ACL validators did not retain the no-link path preflight."

    $sharedAncestorJunctionTarget = Join-Path $temp 'shared-ancestor-junction-target'
    $sharedAncestorJunction = Join-Path $temp 'shared-ancestor-junction'
    New-Item -ItemType Directory -Path $sharedAncestorJunctionTarget -Force | Out-Null
    New-Item -ItemType Junction -Path $sharedAncestorJunction -Target $sharedAncestorJunctionTarget | Out-Null
    $linkValidatorAsts = @($prestageAst.FindAll({
                param($node)
                $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -in @('Assert-RevAgentPrestagePathNoLinks', 'Assert-RevAgentPrestageSharedAncestorSafe')
            }, $true))
    Assert-True ($linkValidatorAsts.Count -eq 2) "Standalone prestage no-link/shared-ancestor validators could not be loaded for executable junction coverage."
    $linkValidatorModule = New-Module -ScriptBlock ([scriptblock]::Create((@($linkValidatorAsts | ForEach-Object { $_.Extent.Text }) -join "`r`n`r`n")))
    $sharedJunctionError = $null
    try {
        try { & $linkValidatorModule { param($Path) Assert-RevAgentPrestageSharedAncestorSafe -Path $Path } $sharedAncestorJunction }
        catch { $sharedJunctionError = [string]$_.Exception.Message }
    }
    finally {
        Remove-Module $linkValidatorModule.Name -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $sharedAncestorJunction) { [IO.Directory]::Delete($sharedAncestorJunction) }
    }
    Assert-True ([string]$sharedJunctionError -match 'filesystem link/reparse component') "Standalone prestage shared-ancestor gate did not reject a DPE-style junction through its real no-link validator."

    $parentAst = @($prestageAst.FindAll({
                param($node)
                $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-RevAgentPrestageParent'
            }, $true))
    Assert-True ($parentAst.Count -eq 1) "Standalone prestage parent resolver could not be loaded for executable routing coverage."
    $parentModule = New-Module -ScriptBlock ([scriptblock]::Create($parentAst[0].Extent.Text))
    try {
        $parentRouting = & $parentModule {
            $script:SharedCalls = @()
            $script:AdminCalls = @()
            $script:MissingDpe = $false
            function Assert-RevAgentPrestagePathNoLinks { param([string]$Path) return [IO.Path]::GetFullPath($Path) }
            function Test-Path {
                [CmdletBinding()]
                param([string]$LiteralPath)
                if ($script:MissingDpe -and [string]::Equals((Split-Path -Leaf $LiteralPath), 'DPE', [StringComparison]::OrdinalIgnoreCase)) { return $false }
                return $true
            }
            function Assert-RevAgentPrestageSharedAncestorSafe { param([string]$Path) $script:SharedCalls += [IO.Path]::GetFullPath($Path) }
            function Assert-RevAgentPrestageAdminDirectory { param([string]$Path) $script:AdminCalls += [IO.Path]::GetFullPath($Path) }
            $common = [IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)).TrimEnd('\')
            $expectedShared = Join-Path $common 'DPE'
            $expectedProduct = Join-Path $expectedShared 'revAgent'
            $resolved = Get-RevAgentPrestageParent -BootstrapPath (Join-Path $expectedProduct 'bootstrap')
            $script:MissingDpe = $true
            $missingDpeError = $null
            try { Get-RevAgentPrestageParent -BootstrapPath (Join-Path $expectedProduct 'bootstrap') | Out-Null }
            catch { $missingDpeError = [string]$_.Exception.Message }
            [pscustomobject]@{
                resolved = $resolved
                expectedShared = $expectedShared
                expectedProduct = $expectedProduct
                sharedCalls = @($script:SharedCalls)
                adminCalls = @($script:AdminCalls)
                missingDpeError = $missingDpeError
            }
        }
    }
    finally { Remove-Module $parentModule.Name -Force -ErrorAction SilentlyContinue }
    Assert-True ($parentRouting.sharedCalls.Count -eq 1 -and [string]::Equals([string]$parentRouting.sharedCalls[0], [string]$parentRouting.expectedShared, [StringComparison]::OrdinalIgnoreCase)) "Standalone prestage parent resolver did not route only the shared DPE ancestor through shared-ancestor validation."
    Assert-True ($parentRouting.adminCalls.Count -eq 1 -and [string]::Equals([string]$parentRouting.adminCalls[0], [string]$parentRouting.expectedProduct, [StringComparison]::OrdinalIgnoreCase)) "Standalone prestage parent resolver did not retain strict validation for the revAgent product root."
    Assert-True ([string]::Equals([string]$parentRouting.resolved, [string]$parentRouting.expectedProduct, [StringComparison]::OrdinalIgnoreCase)) "Standalone prestage parent resolver returned an unexpected product root."
    Assert-True ([string]$parentRouting.missingDpeError -match 'bootstrap_shared_ancestor_not_prestaged') "Standalone production prestage did not fail closed when the shared DPE ancestor was missing."

    $prestageDocText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "docs\BOOTSTRAP_PRESTAGE.md")
    $prestageInstallerSource = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1")
    Write-Host "Test canonical elevated-block shared DPE migration"
    $elevatedBlockMatch = [regex]::Match($prestageDocText, '(?s)## 2\. Fresh elevated Windows PowerShell shell.*?```powershell\r?\n(.*?)\r?\n```')
    Assert-True $elevatedBlockMatch.Success "Canonical elevated prestage block was not found."
    $elevatedBlock = $elevatedBlockMatch.Groups[1].Value
    $docTokens = $null
    $docErrors = $null
    $docAst = [Management.Automation.Language.Parser]::ParseInput($elevatedBlock, [ref]$docTokens, [ref]$docErrors)
    Assert-True (@($docErrors).Count -eq 0) "Canonical elevated prestage block does not parse."

    Write-Host "Test MAXIMUM_ALLOWED parent-only DACL mutation on real NTFS"
    $nativeSourceMatch = [regex]::Match($elevatedBlock, "(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")
    Assert-True $nativeSourceMatch.Success "Canonical elevated prestage native helper source was not found."
    if (-not ('RevAgent.Prestage.DirectoryLockNative' -as [type])) { Add-Type -TypeDefinition $nativeSourceMatch.Groups[1].Value }
    $propagationRoot = Join-Path $temp 'maximum-allowed-propagation'
    $propagationParent = Join-Path $propagationRoot 'DPE'
    $propagationChild = Join-Path $propagationParent 'existing-product'
    $propagationGrandchild = Join-Path $propagationChild 'nested'
    $propagationSibling = Join-Path $propagationParent 'sibling-product'
    New-Item -ItemType Directory -Path $propagationGrandchild, $propagationSibling -Force | Out-Null
    $guestSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-546')
    $probeRule = [Security.AccessControl.FileSystemAccessRule]::new(
        $guestSid,
        [Security.AccessControl.FileSystemRights]::ReadAndExecute,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
    $childBeforeProbe = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $propagationChild).Sddl
    $probeAcl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $propagationParent
    [void]$probeAcl.AddAccessRule($probeRule)
    if ('System.IO.FileSystemAclExtensions' -as [type]) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($propagationParent), $probeAcl) }
    else { ([IO.DirectoryInfo]::new($propagationParent)).SetAccessControl($probeAcl) }
    $childAfterProbe = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $propagationChild).Sddl
    Assert-True ($childAfterProbe -cne $childBeforeProbe) "The inheritable NTFS probe ACE did not first propagate to the existing child."
    $childProbeRules = @((Microsoft.PowerShell.Security\Get-Acl -LiteralPath $propagationChild).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { [string]$_.IdentityReference.Value -eq 'S-1-5-32-546' -and $_.IsInherited })
    Assert-True ($childProbeRules.Count -eq 1) "The existing child did not receive exactly one inherited probe ACE."
    $childSddlBeforeMax = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $propagationChild).Sddl
    $grandchildSddlBeforeMax = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $propagationGrandchild).Sddl
    $siblingSddlBeforeMax = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $propagationSibling).Sddl
    $removeProbeAcl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $propagationParent
    $parentProbeRules = @($removeProbeAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | Where-Object { [string]$_.IdentityReference.Value -eq 'S-1-5-32-546' })
    Assert-True ($parentProbeRules.Count -eq 1) "The parent did not contain exactly one explicit inheritable probe ACE before MAXIMUM_ALLOWED removal."
    $removeProbeAcl.RemoveAccessRuleSpecific($parentProbeRules[0])
    $removeProbeRaw = [Security.AccessControl.RawSecurityDescriptor]::new($removeProbeAcl.GetSecurityDescriptorBinaryForm(), 0)
    $removeProbeDacl = New-Object byte[] $removeProbeRaw.DiscretionaryAcl.BinaryLength
    $removeProbeRaw.DiscretionaryAcl.GetBinaryForm($removeProbeDacl, 0)
    $securityHandle = $null
    try {
        $securityHandle = [RevAgent.Prestage.DirectoryLockNative]::OpenSecurity($propagationParent)
        $verifierHandle = [RevAgent.Prestage.DirectoryLockNative]::OpenVerifier($propagationParent)
        try {
            Assert-True ([string]::Equals([RevAgent.Prestage.DirectoryLockNative]::Identity($securityHandle), [RevAgent.Prestage.DirectoryLockNative]::Identity($verifierHandle), [StringComparison]::Ordinal)) "Share-all identity verifier did not resolve the guarded parent object."
        }
        finally { $verifierHandle.Dispose() }
        $setDaclError = [RevAgent.Prestage.DirectoryLockNative]::SetDaclUnprotected($securityHandle, $removeProbeDacl)
        Assert-True ($setDaclError -eq 0) "MAXIMUM_ALLOWED SetSecurityInfo returned error $setDaclError."
        $verifierHandle = [RevAgent.Prestage.DirectoryLockNative]::OpenVerifier($propagationParent)
        try {
            Assert-True ([string]::Equals([RevAgent.Prestage.DirectoryLockNative]::Identity($securityHandle), [RevAgent.Prestage.DirectoryLockNative]::Identity($verifierHandle), [StringComparison]::Ordinal)) "Guarded parent identity changed after SetSecurityInfo."
        }
        finally { $verifierHandle.Dispose() }
    }
    finally { if ($null -ne $securityHandle) { $securityHandle.Dispose() } }
    $parentAfterMax = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $propagationParent
    $parentProbeAfter = @($parentAfterMax.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { [string]$_.IdentityReference.Value -eq 'S-1-5-32-546' })
    $parentRawAfterMax = [Security.AccessControl.RawSecurityDescriptor]::new($parentAfterMax.GetSecurityDescriptorBinaryForm(), 0)
    Assert-True ($parentProbeAfter.Count -eq 0) "MAXIMUM_ALLOWED parent mutation did not remove the explicit inheritable probe ACE from the parent."
    Assert-True (($parentRawAfterMax.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited) -ne 0 -and -not $parentAfterMax.AreAccessRulesProtected) "MAXIMUM_ALLOWED parent mutation did not retain the unprotected D:AI state."
    Assert-True ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath $propagationChild).Sddl -ceq $childSddlBeforeMax) "MAXIMUM_ALLOWED parent mutation changed existing child SDDL."
    Assert-True ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath $propagationGrandchild).Sddl -ceq $grandchildSddlBeforeMax) "MAXIMUM_ALLOWED parent mutation changed existing grandchild SDDL."
    Assert-True ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath $propagationSibling).Sddl -ceq $siblingSddlBeforeMax) "MAXIMUM_ALLOWED parent mutation changed existing sibling SDDL."

    $docFunctionNames = @(
        'Assert-SafeExistingDirectory', 'Get-AclRuleShape', 'Get-AclRuleShapeFromRule',
        'Get-RawAclAceShape', 'Get-CanonicalSharedDpeRawShapes', 'Get-CanonicalSharedDpeShapes', 'Assert-CanonicalProgramDataCreatorOwner',
        'Get-SharedDpeAclState', 'Test-ExactAclShapes', 'Assert-FinalSharedDpe',
        'Get-CanonicalSharedDpeDaclBytes', 'Initialize-SafeSharedDpe'
    )
    $docFunctionAsts = @($docAst.FindAll({
                param($node)
                $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $docFunctionNames
            }, $true))
    Assert-True ($docFunctionAsts.Count -eq $docFunctionNames.Count) "Canonical elevated shared-DPE functions could not all be loaded for executable tests."

    $docFixtureProgramData = Join-Path $temp 'doc-programdata'
    $docFixtureDpe = Join-Path $docFixtureProgramData 'DPE'
    $docFixtureChild = Join-Path $docFixtureDpe 'existing-product'
    $docFixtureSibling = Join-Path $docFixtureDpe 'sibling-product'
    $docFixtureJunction = Join-Path $temp 'doc-dpe-junction'
    New-Item -ItemType Directory -Path $docFixtureChild, $docFixtureSibling -Force | Out-Null
    New-Item -ItemType Junction -Path $docFixtureJunction -Target $docFixtureDpe | Out-Null
    $docChildMarker = Join-Path $docFixtureChild 'unchanged.txt'
    [IO.File]::WriteAllText($docChildMarker, 'unchanged-child-content', [Text.UTF8Encoding]::new($false))
    $docChildIdentityBefore = '{0}|{1:o}' -f ([IO.DirectoryInfo]$docFixtureChild).FullName, ([IO.DirectoryInfo]$docFixtureChild).CreationTimeUtc
    $docChildAclBefore = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $docFixtureChild).Sddl
    $docChildHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $docChildMarker).Hash
    $docSiblingIdentityBefore = '{0}|{1:o}' -f ([IO.DirectoryInfo]$docFixtureSibling).FullName, ([IO.DirectoryInfo]$docFixtureSibling).CreationTimeUtc
    $docSiblingAclBefore = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $docFixtureSibling).Sddl

    $docMigrationModule = New-Module -ScriptBlock ([scriptblock]::Create((@($docFunctionAsts | ForEach-Object { $_.Extent.Text }) -join "`r`n`r`n")))
    try {
        $docMigrationResult = & $docMigrationModule {
            param($ProgramDataPath, $DpePath, $JunctionPath)

            $script:ProgramDataRoot = [IO.Path]::GetFullPath($ProgramDataPath).TrimEnd('\')
            $script:DpePath = [IO.Path]::GetFullPath($DpePath).TrimEnd('\')
            $script:CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            $script:OtherSid = 'S-1-5-21-111-222-333-444'
            $script:currentIdentity = [pscustomobject]@{ User = [Security.Principal.SecurityIdentifier]::new($script:CurrentSid) }
            $script:trustedOwners = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
            $script:danger = [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
            $script:OwnerWrites = 0
            $script:InheritanceRefreshes = 0
            $script:MutationTargets = @()
            $script:RaceGuard = $false

            $rawFixtureAcl = [Security.AccessControl.DirectorySecurity]::new()
            $rawFixtureAcl.SetSecurityDescriptorSddlForm(('O:{0}G:BUD:AI(A;ID;FA;;;{0})(A;OICIIOID;GA;;;CO)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)(A;CIID;0x116;;;BU)' -f $script:CurrentSid))
            $rawFixture = [Security.AccessControl.RawSecurityDescriptor]::new($rawFixtureAcl.GetSecurityDescriptorBinaryForm(), 0)
            $rawFixtureState = [pscustomobject]@{
                Acl = $rawFixtureAcl
                Raw = $rawFixture
                RawShapes = @($rawFixture.DiscretionaryAcl | ForEach-Object { Get-RawAclAceShape $_ } | Sort-Object)
                DaclPresent = $true
                DaclAutoInherited = $true
            }
            $reconstructedBytes = Get-CanonicalSharedDpeDaclBytes $rawFixtureState $script:CurrentSid
            $reconstructedAcl = [Security.AccessControl.RawAcl]::new([byte[]]$reconstructedBytes, 0)
            $reconstructedShapes = @($reconstructedAcl | ForEach-Object { Get-RawAclAceShape $_ } | Sort-Object)
            $rawReconstruction = [pscustomobject]@{
                ruleCount = $reconstructedAcl.Count
                exactCanonical = Test-ExactAclShapes $reconstructedShapes @(Get-CanonicalSharedDpeRawShapes)
                allInherited = @($reconstructedAcl | Where-Object { (([int]$_.AceFlags -band [int][Security.AccessControl.AceFlags]::Inherited) -eq 0) }).Count -eq 0
            }

            function New-FixtureRule {
                param(
                    [string]$Sid,
                    [Int64]$Rights,
                    [Security.AccessControl.AccessControlType]$Type = [Security.AccessControl.AccessControlType]::Allow,
                    [bool]$Inherited = $true,
                    [Security.AccessControl.InheritanceFlags]$Inheritance = [Security.AccessControl.InheritanceFlags]::None,
                    [Security.AccessControl.PropagationFlags]$Propagation = [Security.AccessControl.PropagationFlags]::None
                )
                return [pscustomobject]@{
                    IdentityReference = [Security.Principal.SecurityIdentifier]::new($Sid)
                    FileSystemRights = [Int64]$Rights
                    AccessControlType = $Type
                    IsInherited = $Inherited
                    InheritanceFlags = $Inheritance
                    PropagationFlags = $Propagation
                }
            }

            function New-CanonicalRules {
                $ciOi = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
                return @(
                    (New-FixtureRule 'S-1-5-18' ([Int64][Security.AccessControl.FileSystemRights]::FullControl) -Inheritance $ciOi),
                    (New-FixtureRule 'S-1-5-32-544' ([Int64][Security.AccessControl.FileSystemRights]::FullControl) -Inheritance $ciOi),
                    (New-FixtureRule 'S-1-3-0' 268435456 -Inheritance $ciOi -Propagation ([Security.AccessControl.PropagationFlags]::InheritOnly)),
                    (New-FixtureRule 'S-1-5-32-545' ([Int64]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)) -Inheritance $ciOi),
                    (New-FixtureRule 'S-1-5-32-545' ([Int64][Security.AccessControl.FileSystemRights]::Write) -Inheritance ([Security.AccessControl.InheritanceFlags]::ContainerInherit))
                )
            }

            function New-LegacyOwnerRule {
                param(
                    [Security.AccessControl.AccessControlType]$Type = [Security.AccessControl.AccessControlType]::Allow,
                    [bool]$Inherited = $true,
                    [Security.AccessControl.InheritanceFlags]$Inheritance = [Security.AccessControl.InheritanceFlags]::None
                )
                return New-FixtureRule $script:CurrentSid ([Int64][Security.AccessControl.FileSystemRights]::FullControl) -Type $Type -Inherited $Inherited -Inheritance $Inheritance
            }

            function New-FixtureAcl {
                param([string]$Owner, [bool]$Protected, [object[]]$Rules)
                $descriptor = [pscustomobject]@{ FixtureOwner = $Owner; AreAccessRulesProtected = $Protected; FixtureRules = @($Rules) }
                $descriptor | Add-Member -MemberType ScriptMethod -Name GetOwner -Value {
                    param($TargetType)
                    return [Security.Principal.SecurityIdentifier]::new([string]$this.FixtureOwner)
                }
                $descriptor | Add-Member -MemberType ScriptMethod -Name GetAccessRules -Value {
                    param($IncludeExplicit, $IncludeInherited, $TargetType)
                    return @($this.FixtureRules | Where-Object { ($_.IsInherited -and $IncludeInherited) -or (-not $_.IsInherited -and $IncludeExplicit) })
                }
                return $descriptor
            }

            $script:ProgramDataAcl = New-FixtureAcl 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464' $false @(
                (New-FixtureRule 'S-1-3-0' 268435456 -Inherited $false -Inheritance ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -Propagation ([Security.AccessControl.PropagationFlags]::InheritOnly))
            )
            $script:DpeOwner = $script:CurrentSid
            $script:DpeProtected = $false
            $script:DpeRules = @((New-CanonicalRules) + (New-LegacyOwnerRule))

            function Get-Acl {
                [CmdletBinding()]
                param([Parameter(Mandatory = $true)][string]$LiteralPath)
                $full = [IO.Path]::GetFullPath($LiteralPath).TrimEnd('\')
                if ([string]::Equals($full, $script:ProgramDataRoot, [StringComparison]::OrdinalIgnoreCase)) { return $script:ProgramDataAcl }
                if ([string]::Equals($full, $script:DpePath, [StringComparison]::OrdinalIgnoreCase)) { return New-FixtureAcl $script:DpeOwner $script:DpeProtected $script:DpeRules }
                return Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath
            }

            function Get-SharedDpeAclState {
                param([string]$Path)
                $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
                if (-not [string]::Equals($full, $script:DpePath, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe shared DPE ancestor: $Path" }
                $acl = New-FixtureAcl $script:DpeOwner $script:DpeProtected $script:DpeRules
                $shapes = @($script:DpeRules | ForEach-Object { Get-AclRuleShapeFromRule $_ } | Sort-Object)
                $canonical = @(Get-CanonicalSharedDpeShapes)
                $legacy = @(Get-CanonicalSharedDpeShapes $script:CurrentSid)
                $rawShapes = if (Test-ExactAclShapes $shapes $canonical) { @(Get-CanonicalSharedDpeRawShapes) }
                    elseif (Test-ExactAclShapes $shapes $legacy) { @(Get-CanonicalSharedDpeRawShapes $script:CurrentSid) }
                    else { @('invalid-fixture-raw-shape') }
                return [pscustomobject]@{
                    Item = [IO.DirectoryInfo]::new($script:DpePath)
                    Acl = $acl
                    Owner = $script:DpeOwner
                    Shapes = $shapes
                    ExplicitCount = @($script:DpeRules | Where-Object { -not $_.IsInherited }).Count
                    Raw = $null
                    RawShapes = $rawShapes
                    DaclPresent = $true
                    DaclAutoInherited = $true
                }
            }
            function Open-DpeSecurityGuard {
                param([string]$Path)
                return [pscustomobject]@{ Path = [IO.Path]::GetFullPath($Path).TrimEnd('\'); Identity = 'stable-dpe'; Handle = [IO.MemoryStream]::new(); SecurityMutation = $true }
            }
            function Assert-DirectoryGuardPath {
                param($Guard, [string]$Path)
                if ($script:RaceGuard) { $script:RaceGuard = $false; throw 'Prestage directory path/handle identity changed: deterministic-race' }
                if (-not [string]::Equals([string]$Guard.Path, [IO.Path]::GetFullPath($Path).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Prestage directory path/handle identity changed: path' }
            }
            function Set-SharedDpeOwnerAdministrators {
                param($Guard)
                $script:OwnerWrites++
                $script:MutationTargets += [IO.Path]::GetFullPath([string]$Guard.Path).TrimEnd('\')
                $script:DpeOwner = 'S-1-5-32-544'
            }
            function Refresh-SharedDpeInheritance {
                param($Guard, $State, [string]$LegacyCreatorSid)
                $script:InheritanceRefreshes++
                $script:MutationTargets += [IO.Path]::GetFullPath([string]$Guard.Path).TrimEnd('\')
                $script:DpeOwner = 'S-1-5-32-544'
                $script:DpeProtected = $false
                $script:DpeRules = @(New-CanonicalRules)
            }

            function Reset-Fixture([string]$Owner, [object[]]$Rules) {
                $script:DpeOwner = $Owner; $script:DpeProtected = $false; $script:DpeRules = @($Rules)
                $script:OwnerWrites = 0; $script:InheritanceRefreshes = 0; $script:MutationTargets = @(); $script:RaceGuard = $false
            }
            function Capture-Error([scriptblock]$Action) { try { & $Action | Out-Null; return '' } catch { return [string]$_.Exception.Message } }

            Reset-Fixture $script:CurrentSid @((New-CanonicalRules) + (New-LegacyOwnerRule))
            $successPath = Initialize-SafeSharedDpe $script:DpePath
            $success = [pscustomobject]@{ path = $successPath; ownerWrites = $script:OwnerWrites; refreshes = $script:InheritanceRefreshes; owner = $script:DpeOwner; ruleCount = $script:DpeRules.Count; targets = @($script:MutationTargets) }

            Reset-Fixture $script:OtherSid @((New-CanonicalRules) + (New-LegacyOwnerRule))
            $wrongOwnerError = Capture-Error { Initialize-SafeSharedDpe $script:DpePath }
            $wrongOwnerMutations = $script:OwnerWrites + $script:InheritanceRefreshes

            Reset-Fixture $script:CurrentSid @((New-CanonicalRules) + (New-LegacyOwnerRule) + (New-FixtureRule $script:CurrentSid ([Int64][Security.AccessControl.FileSystemRights]::Delete) -Inherited $false))
            $extraDangerError = Capture-Error { Initialize-SafeSharedDpe $script:DpePath }
            $extraDangerMutations = $script:OwnerWrites + $script:InheritanceRefreshes

            Reset-Fixture $script:CurrentSid @((New-CanonicalRules) + (New-LegacyOwnerRule) + (New-FixtureRule -Sid $script:CurrentSid -Rights ([Int64][Security.AccessControl.FileSystemRights]::Read) -Type ([Security.AccessControl.AccessControlType]::Deny)))
            $denyError = Capture-Error { Initialize-SafeSharedDpe $script:DpePath }
            $denyMutations = $script:OwnerWrites + $script:InheritanceRefreshes

            Reset-Fixture $script:CurrentSid @((New-CanonicalRules) + (New-LegacyOwnerRule -Inheritance ([Security.AccessControl.InheritanceFlags]::ContainerInherit)))
            $inheritableOwnerError = Capture-Error { Initialize-SafeSharedDpe $script:DpePath }
            $inheritableOwnerMutations = $script:OwnerWrites + $script:InheritanceRefreshes

            Reset-Fixture 'S-1-5-32-544' @(New-CanonicalRules)
            $safePath = Initialize-SafeSharedDpe $script:DpePath
            $safeNoOpMutations = $script:OwnerWrites + $script:InheritanceRefreshes

            Reset-Fixture 'S-1-5-32-544' @((New-CanonicalRules) + (New-LegacyOwnerRule))
            $recoveryPath = Initialize-SafeSharedDpe $script:DpePath
            $recovery = [pscustomobject]@{ path = $recoveryPath; ownerWrites = $script:OwnerWrites; refreshes = $script:InheritanceRefreshes; owner = $script:DpeOwner }

            Reset-Fixture $script:CurrentSid @((New-CanonicalRules) + (New-LegacyOwnerRule))
            $script:RaceGuard = $true
            $raceError = Capture-Error { Initialize-SafeSharedDpe $script:DpePath }
            $raceMutations = $script:OwnerWrites + $script:InheritanceRefreshes

            $junctionError = Capture-Error { Initialize-SafeSharedDpe $JunctionPath }

            return [pscustomobject]@{
                rawReconstruction = $rawReconstruction
                success = $success
                wrongOwnerError = $wrongOwnerError; wrongOwnerMutations = $wrongOwnerMutations
                extraDangerError = $extraDangerError; extraDangerMutations = $extraDangerMutations
                denyError = $denyError; denyMutations = $denyMutations
                inheritableOwnerError = $inheritableOwnerError; inheritableOwnerMutations = $inheritableOwnerMutations
                safePath = $safePath; safeNoOpMutations = $safeNoOpMutations
                recovery = $recovery
                raceError = $raceError; raceMutations = $raceMutations
                junctionError = $junctionError
            }
        } $docFixtureProgramData $docFixtureDpe $docFixtureJunction
    }
    finally {
        Remove-Module $docMigrationModule.Name -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $docFixtureJunction) { [IO.Directory]::Delete($docFixtureJunction) }
    }

    Assert-True ([int]$docMigrationResult.success.ownerWrites -eq 1 -and [int]$docMigrationResult.success.refreshes -eq 1 -and [string]$docMigrationResult.success.owner -eq 'S-1-5-32-544' -and [int]$docMigrationResult.success.ruleCount -eq 5) "Exact NET01 legacy shared-DPE pattern did not complete owner-first inheritance refresh."
    Assert-True ([bool]$docMigrationResult.rawReconstruction.exactCanonical -and [bool]$docMigrationResult.rawReconstruction.allInherited -and [int]$docMigrationResult.rawReconstruction.ruleCount -eq 5) "Raw exact legacy DACL reconstruction did not retain the five canonical inherited ACEs."
    Assert-True (@($docMigrationResult.success.targets | Where-Object { -not [string]::Equals([string]$_, [IO.Path]::GetFullPath($docFixtureDpe).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) }).Count -eq 0) "Legacy shared-DPE migration targeted a child or sibling path."
    Assert-True ([string]$docMigrationResult.wrongOwnerError -match 'exact current-caller' -and [int]$docMigrationResult.wrongOwnerMutations -eq 0) "Wrong legacy owner reached shared-DPE mutation."
    Assert-True ([string]$docMigrationResult.extraDangerError -match 'exact current-caller' -and [int]$docMigrationResult.extraDangerMutations -eq 0) "Extra explicit/dangerous ACE reached shared-DPE mutation."
    Assert-True ([string]$docMigrationResult.denyError -match 'exact current-caller' -and [int]$docMigrationResult.denyMutations -eq 0) "Deny ACE reached shared-DPE mutation."
    Assert-True ([string]$docMigrationResult.inheritableOwnerError -match 'exact current-caller' -and [int]$docMigrationResult.inheritableOwnerMutations -eq 0) "Inheritable legacy owner ACE reached shared-DPE mutation."
    Assert-True ([int]$docMigrationResult.safeNoOpMutations -eq 0 -and [string]::Equals([string]$docMigrationResult.safePath, [IO.Path]::GetFullPath($docFixtureDpe), [StringComparison]::OrdinalIgnoreCase)) "Already-safe shared DPE was not a validation-only no-op."
    Assert-True ([int]$docMigrationResult.recovery.ownerWrites -eq 0 -and [int]$docMigrationResult.recovery.refreshes -eq 1 -and [string]$docMigrationResult.recovery.owner -eq 'S-1-5-32-544') "Interrupted owner-first migration state did not recover through inheritance refresh only."
    Assert-True ([string]$docMigrationResult.raceError -match 'identity changed' -and [int]$docMigrationResult.raceMutations -eq 0) "Shared-DPE guard race reached mutation."
    Assert-True ([string]$docMigrationResult.junctionError -match 'Unsafe shared DPE ancestor') "Canonical elevated shared-DPE migration did not reject a junction."

    $docChildIdentityAfter = '{0}|{1:o}' -f ([IO.DirectoryInfo]$docFixtureChild).FullName, ([IO.DirectoryInfo]$docFixtureChild).CreationTimeUtc
    $docChildAclAfter = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $docFixtureChild).Sddl
    $docChildHashAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $docChildMarker).Hash
    $docSiblingIdentityAfter = '{0}|{1:o}' -f ([IO.DirectoryInfo]$docFixtureSibling).FullName, ([IO.DirectoryInfo]$docFixtureSibling).CreationTimeUtc
    $docSiblingAclAfter = (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $docFixtureSibling).Sddl
    Assert-True ($docChildIdentityAfter -eq $docChildIdentityBefore -and $docChildAclAfter -eq $docChildAclBefore -and $docChildHashAfter -eq $docChildHashBefore) "Legacy shared-DPE migration changed existing child identity, ACL, or content."
    Assert-True ($docSiblingIdentityAfter -eq $docSiblingIdentityBefore -and $docSiblingAclAfter -eq $docSiblingAclBefore) "Legacy shared-DPE migration changed sibling identity or ACL."

    $newSharedDpeAst = @($docAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'New-InheritanceEnabledSharedDpe' }, $true))
    Assert-True ($newSharedDpeAst.Count -eq 1) "Canonical absent-DPE creation function is missing."
    $newSharedDpeText = $newSharedDpeAst[0].Extent.Text
    Assert-True ($elevatedBlock -match 'CreateDirectoryWithSecurityDescriptor' -and $elevatedBlock -match 'CreateDirectoryW' -and $newSharedDpeText -match 'RawSecurityDescriptor' -and $newSharedDpeText -match 'ControlFlags\]::SelfRelative' -and $newSharedDpeText -notmatch 'ControlFlags\]::DiscretionaryAclPresent' -and $newSharedDpeText -notmatch 'CreateSubdirectory') "Absent-DPE path does not use owner-only native ACL-at-create without a supplied DACL."
    Assert-True ($elevatedBlock -notmatch "New-ProtectedChild \$ProgramDataRoot 'DPE'" -and $elevatedBlock -match 'New-InheritanceEnabledSharedDpe \$ProgramDataRoot') "Absent-DPE routing still creates a protected/private DPE ancestor."
    Assert-True ($elevatedBlock -match '(?s)New-InheritanceEnabledSharedDpe \$ProgramDataRoot\s+\$dpeGuard = Open-DpeSecurityGuard \$dpe\s+\$dpe = Initialize-SafeSharedDpe \$dpe \$dpeGuard') "Absent-DPE routing does not revalidate the newly opened shared ancestor while holding the MAXIMUM_ALLOWED guard."
    Assert-True ($nativeSourceMatch.Groups[1].Value -match 'OpenSecurity\(string path\).*0x02000000,3' -and $nativeSourceMatch.Groups[1].Value -match 'OpenVerifier\(string path\).*path,0,7' -and $nativeSourceMatch.Groups[1].Value -match 'SetSecurityInfo\(handle,1,0x00000001' -and $nativeSourceMatch.Groups[1].Value -match 'SetSecurityInfo\(handle,1,0x20000004') "Native shared-DPE helper does not bind MAXIMUM_ALLOWED/share-3 mutation, share-7 identity verification, and owner/DACL calls to the required handle APIs."
    $sharedMutationAsts = @($docAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Set-SharedDpeOwnerAdministrators', 'Refresh-SharedDpeInheritance', 'Initialize-SafeSharedDpe', 'Get-CanonicalSharedDpeDaclBytes') }, $true))
    Assert-True ($sharedMutationAsts.Count -eq 4) "Shared-DPE handle-bound mutation functions are incomplete."
    $sharedMutationText = @($sharedMutationAsts | ForEach-Object { $_.Extent.Text }) -join "`r`n"
    Assert-True ($sharedMutationText -match 'SetOwner\(\$Guard\.Handle' -and $sharedMutationText -match 'SetDaclUnprotected\(\$Guard\.Handle' -and $sharedMutationText -notmatch 'SetAccessControl|SetNamedSecurityInfo|Get-ChildItem|/T') "Shared-DPE migration is not exclusively handle-bound and parent-only."
    $initializeText = [string](@($sharedMutationAsts | Where-Object Name -eq 'Initialize-SafeSharedDpe')[0].Extent.Text)
    Assert-True ($initializeText.IndexOf('Set-SharedDpeOwnerAdministrators $guard', [StringComparison]::Ordinal) -ge 0 -and $initializeText.IndexOf('Refresh-SharedDpeInheritance $guard', [StringComparison]::Ordinal) -gt $initializeText.IndexOf('Set-SharedDpeOwnerAdministrators $guard', [StringComparison]::Ordinal)) "Shared-DPE migration does not set owner before rebuilding inheritance on the same guard handle."
    Assert-True ($prestageInstallerSource -notmatch 'Initialize-RevAgentPrestageSharedAncestor' -and (Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'installer\lib\RevAgent.LocalBootstrap.psm1')) -notmatch 'Initialize-RevAgentBootstrapSharedAncestor') "Persistent wrapper/module gained a legacy shared-DPE mutation authority."
    Assert-True ($prestageInstallerSource -match 'bootstrap_shared_ancestor_not_prestaged' -and (Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'installer\lib\RevAgent.LocalBootstrap.psm1')) -match 'bootstrap_shared_ancestor_not_prestaged') "Production wrapper/module do not fail closed when DPE was not prestaged."

    $productHardenIndex = $prestageDocText.IndexOf('Set-ProtectedProductRootAcl $productPath', [StringComparison]::Ordinal)
    $prestageCreateIndex = $prestageDocText.IndexOf("New-ProtectedChild `$product 'prestage'", [StringComparison]::Ordinal)
    Assert-True ($prestageDocText -match 'exact existing product root \(or prestage child\) may carry the' -and $prestageDocText -match 'Never apply this migration to the shared DPE ancestor') "Manual prestage does not document the exact product-root/prestage legacy ACL migration boundary."
    Assert-True ($productHardenIndex -ge 0 -and $prestageCreateIndex -gt $productHardenIndex) "Manual prestage does not harden the existing product root before creating the protected prestage child."
    Assert-True ($prestageDocText -match 'FILE_SHARE_DELETE' -and $prestageDocText -match 'Assert-DirectoryGuardPath \$guard \$Path' -and $prestageDocText -match 'if \(Test-Path -LiteralPath \$path\) \{ Set-ProtectedProductRootAcl \$path') "Manual prestage does not hold and reverify exact product-root/prestage directory identity during legacy ACL hardening."
    Assert-True ($elevatedBlock -match '\$trustedKeysBytes = Read-VerifiedBytes \$TrustedKeys \(\[string\]\$evidence\.sources\.trustedKeys\) 65536') "Canonical elevated prestage does not bind the NAS trusted-keys bytes to authenticated evidence before local staging."
    Assert-True ($elevatedBlock -match '\$stagedTrustedKeys = Join-Path \$prestage ''release-trusted-keys\.json''' -and $elevatedBlock -match '\[IO\.File\]::WriteAllBytes\(\$stagedTrustedKeys, \$trustedKeysBytes\)' -and $elevatedBlock -match 'foreach \(\$path in @\(\$stagedEvidence, \$stagedInstaller, \$stagedTrustedKeys\)\) \{ Set-AdminOnlyAcl \$path \}') "Canonical elevated prestage does not create and protect a local single-link trusted-keys leaf."
    Assert-True ($elevatedBlock -match '-TrustedKeysPath \$stagedTrustedKeys' -and $elevatedBlock -notmatch '-TrustedKeysPath \$TrustedKeys(?:\s|`)') "Canonical elevated prestage still passes the UNC trusted-keys path into the local hardlink guard."

    $launcher = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\revAgent Updater STABLE.cmd")
    Assert-True ($launcher -match '\[Environment\]::GetFolderPath\(\[Environment\+SpecialFolder\]::CommonApplicationData\)' -and $launcher -notmatch '%ProgramData%' -and $launcher -notmatch 'Install-revAgent-Updater-GUI\.ps1' -and $launcher -match 'Refresh-revAgent-LocalBootstrap-STABLE\.cmd' -and $launcher -match 'call "%REFRESH%"' -and $launcher -match 'set "BOOTSTRAP_EXIT=!ERRORLEVEL!"' -and $launcher -notmatch 'start "revAgent"') "Stable launcher is not canonical-local-bootstrap-only or does not preserve the verified bootstrap result."
    $localLauncherSource = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\Start-revAgent-Update.cmd")
    Assert-True ($localLauncherSource -match '-VerificationOnly' -and $localLauncherSource -match 'RefreshStableIfBound' -and $localLauncherSource -match 'set "BOOTSTRAP=%~dp0Start-revAgent-Update\.ps1"' -and $localLauncherSource -match 'set "BOOTSTRAP_STATE=%~dp0bootstrap-state\.json"' -and $localLauncherSource -match 'Refresh-revAgent-LocalBootstrap-STABLE\.cmd' -and $localLauncherSource -match '--post-refresh' -and $localLauncherSource -match 'exit /b 83' -and $localLauncherSource -match 'set "BOOTSTRAP_EXIT=!ERRORLEVEL!"' -and $localLauncherSource -notmatch 'start "revAgent"') "Desktop local launcher does not bind protected siblings, preserve child results, route stable refresh, and stop a post-refresh retry loop."
    $stableRefreshSource = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'installer\nas\Refresh-revAgent-LocalBootstrap-STABLE.ps1')
    Assert-True ($stableRefreshSource -notmatch "Start-Process\s+-FilePath\s+\`$localLauncher\s+-ArgumentList\s+'--post-refresh'") "Fail-closed NAS bootstrap refresh must not launch the local updater after the trust-required stop."

    Write-Host "Test post-refresh verification failure stops before another NAS refresh"
    $postRefreshProgramData = Join-Path $temp 'post-refresh-programdata'
    $postRefreshBootstrapRoot = Join-Path $postRefreshProgramData 'DPE\revAgent\bootstrap'
    New-Item -ItemType Directory -Path $postRefreshBootstrapRoot -Force | Out-Null
    $postRefreshBootstrap = Join-Path $postRefreshBootstrapRoot 'Start-revAgent-Update.ps1'
    $postRefreshState = Join-Path $postRefreshBootstrapRoot 'bootstrap-state.json'
    $postRefreshLauncher = Join-Path $postRefreshBootstrapRoot 'Start-revAgent-Update.cmd'
    [IO.File]::WriteAllText($postRefreshBootstrap, @'
param([switch]$VerificationOnly)
if ($VerificationOnly) {
    [Console]::Error.WriteLine('post-refresh-verification-fixture')
    exit 1
}
exit 0
'@, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($postRefreshState, '{"release":{"channel":"stable"}}', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllBytes($postRefreshLauncher, [IO.File]::ReadAllBytes((Join-Path $RepoRoot 'installer\nas\Start-revAgent-Update.cmd')))
    $postRefreshStartInfo = [Diagnostics.ProcessStartInfo]::new()
    $postRefreshStartInfo.FileName = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
    $postRefreshStartInfo.Arguments = '/d /c call "' + $postRefreshLauncher + '" --post-refresh'
    $postRefreshStartInfo.WorkingDirectory = $RepoRoot
    $postRefreshStartInfo.UseShellExecute = $false
    $postRefreshStartInfo.CreateNoWindow = $true
    $postRefreshStartInfo.RedirectStandardInput = $true
    $postRefreshStartInfo.RedirectStandardOutput = $true
    $postRefreshStartInfo.RedirectStandardError = $true
    $postRefreshStartInfo.EnvironmentVariables['ProgramData'] = $postRefreshProgramData
    $postRefreshProcess = [Diagnostics.Process]::Start($postRefreshStartInfo)
    try {
        $postRefreshProcess.StandardInput.Close()
        $postRefreshStdout = $postRefreshProcess.StandardOutput.ReadToEnd()
        $postRefreshStderr = $postRefreshProcess.StandardError.ReadToEnd()
        Assert-True ($postRefreshProcess.WaitForExit(15000)) "Post-refresh loop-breaker fixture timed out."
        Assert-True ($postRefreshProcess.ExitCode -eq 83) "Post-refresh verification failure did not use the dedicated loop-breaker exit code. actual=$($postRefreshProcess.ExitCode) stdout=$postRefreshStdout stderr=$postRefreshStderr"
        $postRefreshOutput = $postRefreshStdout + "`n" + $postRefreshStderr
        Assert-True ($postRefreshOutput -match 'verification still fails after a fresh refresh' -and $postRefreshOutput -match 'post-refresh-verification-fixture' -and $postRefreshOutput -match 'another automatic refresh was not started') "Post-refresh loop-breaker did not expose the verification reason and manual-diagnosis guidance. output=$postRefreshOutput"
    }
    finally {
        if (-not $postRefreshProcess.HasExited) { try { $postRefreshProcess.Kill() } catch { } }
        $postRefreshProcess.Dispose()
    }
    $bootstrapSource = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\Start-revAgent-Update.ps1")
    Assert-True ($bootstrapSource -match '\[IO\.FileMode\]::Open' -and $bootstrapSource -match '\[IO\.FileMode\]::Append') "Protected bootstrap must probe both overwrite and append-only effective write access."
    Assert-True ($bootstrapSource -match '\$psi = New-RevAgentBootstrapGuiStartInfo -GuiPath \$guiPath -ChannelPath \$ChannelManifestPath -BootstrapStatePath \$statePath' -and $bootstrapSource -match '(?s)\$startInfo\.UseShellExecute = \$false.*\$startInfo\.CreateNoWindow = \$true.*\$startInfo\.WorkingDirectory = Split-Path -Parent \$powershellPath' -and $bootstrapSource -notmatch '\$startInfo\.WindowStyle\s*=') "Protected bootstrap GUI launch does not use the shared future-safe direct-CreateProcess configuration after release verification."
    $prestageInstallerSource = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1")
    Assert-True ($prestageInstallerSource -match 'Administrator prestage installer must already be staged at the protected canonical path' -and $prestageInstallerSource -match 'localBootstrapInstallerScript' -and $prestageInstallerSource -match 'Protected prestage installer does not match independently authenticated SHA-256 evidence') "Production prestage must reject elevation of the repo-side wrapper and bind the protected staged wrapper to independent evidence."
}
finally {
    if (Test-Path -LiteralPath $junctionParent) {
        try { [IO.Directory]::Delete($junctionParent) } catch { }
    }
    if (Test-Path -LiteralPath $evidenceJunction) {
        try { [IO.Directory]::Delete($evidenceJunction) } catch { }
    }
    if (Test-Path -LiteralPath $bootstrapRoot) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $icacls = Join-Path ([Environment]::SystemDirectory) "icacls.exe"
        & $icacls $bootstrapRoot /grant:r ("*{0}:(OI)(CI)F" -f $identity) /T /C | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not restore recursive test cleanup access on $bootstrapRoot" }
        & $icacls $bootstrapRoot /grant:r ("*{0}:F" -f $identity) /T /C | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not restore protected-leaf test cleanup access on $bootstrapRoot" }
    }
    if (Test-Path -LiteralPath $temp) {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $temp) { throw "Local bootstrap test cleanup left artifacts behind: $temp" }
    }
}
Write-Host "Local protected update bootstrap tests passed." -ForegroundColor Green
