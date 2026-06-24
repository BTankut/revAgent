<#
.SYNOPSIS
    Simple GUI for installing or updating the revAgent workstation package.
#>

[CmdletBinding()]
param(
    [string]$ChannelManifestPath = "",
    [string]$InstallRoot = "",
    [switch]$SmokeTest
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$powershellPath = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$installerPath = Join-Path $scriptDir "install-updater-task.ps1"
if ([string]::IsNullOrWhiteSpace($ChannelManifestPath)) {
    $ChannelManifestPath = Join-Path (Split-Path -Parent $scriptDir) "channels\stable.json"
}

$programDataRoot = if ([string]::IsNullOrWhiteSpace($env:ProgramData)) { "C:\ProgramData" } else { $env:ProgramData }
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $programDataRoot "DPE\RevitMCP"
}

$workRoot = Join-Path $InstallRoot "updater"
$packageTarget = Join-Path $InstallRoot "package"
$serverTarget = Join-Path $InstallRoot "runtime"
$configPath = Join-Path $workRoot "updater-config.json"
$localVersionTool = Join-Path $workRoot "show-installed-version.ps1"
$nasLibRoot = @(
    (Join-Path $scriptDir "lib"),
    (Join-Path (Split-Path -Parent $scriptDir) "lib")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($nasLibRoot)) {
    throw "revAgent updater lib folder was not found beside or above: $scriptDir"
}
Import-Module (Join-Path $nasLibRoot "RevitMcp.SourceFreeMigration.psm1") -Force
$script:ActiveProcess = $null
$script:ActiveLogPath = ""
$script:LastLogLength = -1
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
    $logsRoot = Join-Path $workRoot "logs"
    New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null
    return (Join-Path $logsRoot ("gui-install-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss")))
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

function Get-SourceFreeMigrationArtifactsForGui {
    return @(Get-RevitMcpSourceFreeArtifactInventory `
            -InstallRoot $InstallRoot `
            -PackageTarget $packageTarget `
            -ServerTarget $serverTarget)
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

function Compare-RevitMcpVersion {
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

    $comparison = Compare-RevitMcpVersion -Left $installedVersion -Right $channelVersion
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

function Restart-ElevatedAndExit {
    $arguments = @(
        "-STA",
        "-NoProfile",
        "-WindowStyle", "Hidden",
        "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath,
        "-ChannelManifestPath", $ChannelManifestPath,
        "-InstallRoot", $InstallRoot
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $powershellPath
    $psi.Arguments = Join-CommandLine -Arguments $arguments
    $psi.UseShellExecute = $true
    $psi.Verb = "runas"

    try {
        [System.Diagnostics.Process]::Start($psi) | Out-Null
    }
    catch {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show(
            "Administrator permission is required for installation.`r`n`r`n$($_.Exception.Message)",
            "revAgent",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    }

    exit
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

if (-not (Test-IsAdministrator)) {
    Restart-ElevatedAndExit
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
$details.Text = "Release track: managed`r`nWorkstation package"
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
$openLogsButton.Text = "Log Folder"
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

function Start-InstallerOperation {
    param([ValidateSet("update", "restore")] [string]$Operation)

    if (-not (Test-Path -LiteralPath $installerPath)) {
        [System.Windows.Forms.MessageBox]::Show("Installer was not found.", "revAgent") | Out-Null
        return
    }
    if (-not (Test-Path -LiteralPath $ChannelManifestPath)) {
        [System.Windows.Forms.MessageBox]::Show("Release manifest was not found.", "revAgent") | Out-Null
        return
    }

    $localUpdaterPath = Join-Path $workRoot "update-from-nas.ps1"
    $nasUpdaterPath = Join-Path $PSScriptRoot "update-from-nas.ps1"
    $hasLocalUpdater = Test-Path -LiteralPath $localUpdaterPath -PathType Leaf
    $directUpdaterPath = if ($hasLocalUpdater) { $localUpdaterPath } else { $nasUpdaterPath }
    $status = Get-ChannelStatus
    $sourceFreeArtifacts = @(Get-SourceFreeMigrationArtifactsForGui)
    $runSourceFreeMigration = ($sourceFreeArtifacts.Count -gt 0)
    if ($runSourceFreeMigration) {
        if (-not $hasLocalUpdater) {
            [System.Windows.Forms.MessageBox]::Show("Source-free migration requires the local trusted updater, but it was not found. Run Install/Repair first to bootstrap the local updater.", "revAgent") | Out-Null
            Set-ButtonsEnabled -Enabled $true
            return
        }
        if (-not (Test-Path -LiteralPath $directUpdaterPath -PathType Leaf)) {
            [System.Windows.Forms.MessageBox]::Show("Source-free migration is required, but update-from-nas.ps1 was not found beside the launcher.", "revAgent") | Out-Null
            Set-ButtonsEnabled -Enabled $true
            return
        }
        if (-not (Confirm-SourceFreeMigrationForGui -Artifacts $sourceFreeArtifacts)) {
            Set-ButtonsEnabled -Enabled $true
            return
        }
        $Operation = "update"
    }

    if ($Operation -eq "update" -and -not [string]::IsNullOrWhiteSpace($status.InstalledVersion) -and -not $hasLocalUpdater) {
        [System.Windows.Forms.MessageBox]::Show("This workstation has an installed revAgent package, but the local trusted updater was not found. Use Install/Repair to restore the local updater before normal updates.", "revAgent") | Out-Null
        Set-ButtonsEnabled -Enabled $true
        return
    }

    if ($Operation -eq "update" -and -not [bool]$status.UpdateEnabled) {
        [System.Windows.Forms.MessageBox]::Show("No update is available.`r`n`r`n$($status.StatusText)", "revAgent") | Out-Null
        Set-ButtonsEnabled -Enabled $true
        return
    }

    if ($Operation -eq "restore") {
        $message = "Install/Repair installs the release target package with force.`r`n`r`nInstalled: $($status.InstalledVersion)`r`nRelease: $($status.ChannelVersion)`r`n`r`nContinue?"
        $choice = [System.Windows.Forms.MessageBox]::Show(
            $message,
            "revAgent Install/Repair",
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Warning)
        if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) {
            return
        }
    }

    $script:ActiveLogPath = New-RunLogPath
    $script:LastLogLength = -1
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
    $logBox.Text = "$operationLabel starting...`r`n"
    $statusLabel.Text = "Running."
    $progress.Style = "Marquee"
    Set-ButtonsEnabled -Enabled $false

    $useDirectUpdate = ($Operation -eq "update" -and
        (-not [string]::IsNullOrWhiteSpace($status.InstalledVersion) -or $runSourceFreeMigration)) -and
        $hasLocalUpdater

    if ($useDirectUpdate) {
        $arguments = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $directUpdaterPath,
            "-ChannelManifestPath", $ChannelManifestPath,
            "-InstallRoot", $InstallRoot,
            "-WorkRoot", $workRoot,
            "-PackageTarget", $packageTarget,
            "-ServerTarget", $serverTarget,
            "-NoNotifyUser",
            "-AllowManualCodexSetup",
            "-OperationMethod", $operationMethod,
            "-LogPath", $script:ActiveLogPath
        )
    }
    else {
        $arguments = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $installerPath,
            "-ChannelManifestPath", $ChannelManifestPath,
            "-InstallRoot", $InstallRoot,
            "-WorkRoot", $workRoot,
            "-PackageTarget", $packageTarget,
            "-ServerTarget", $serverTarget,
            "-RunNow",
            "-OperationMethod", $operationMethod,
            "-LogPath", $script:ActiveLogPath
        )
    }
    if ($Operation -eq "restore") {
        $arguments += "-ForceUpdate"
    }
    if ($runSourceFreeMigration) {
        $arguments += "-SourceFreeMigration"
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $powershellPath
    $psi.Arguments = Join-CommandLine -Arguments $arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    try {
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $psi
        [void]$process.Start()
        $script:ActiveProcess = $process
        $timer.Start()
    }
    catch {
        $progress.Style = "Blocks"
        Set-ButtonsEnabled -Enabled $true
        $statusLabel.Text = "Could not start."
        [System.Windows.Forms.MessageBox]::Show(
            "PowerShell could not be started.`r`n$($_.Exception.Message)",
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
    if ([string]::IsNullOrWhiteSpace($script:ActiveLogPath)) {
        return
    }

    $text = Read-LogFileText -Path $script:ActiveLogPath
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
        $script:ActiveProcess.Dispose()
        $script:ActiveProcess = $null
        $progress.Style = "Blocks"
        Set-ButtonsEnabled -Enabled $true

        if ($exitCode -eq 0) {
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
            $statusLabel.Text = "An error occurred."
            if (-not $logBox.Text.EndsWith("`r`n")) {
                $logBox.AppendText("`r`n")
            }
            $logBox.AppendText("Install/update finished with an error. Use Log Folder for diagnostic details.`r`n")
            [System.Windows.Forms.MessageBox]::Show(
                "Install/update finished with an error. Open the log folder for details.",
                "revAgent",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
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
    $logsRoot = Join-Path $workRoot "logs"
    if (-not (Test-Path -LiteralPath $logsRoot)) {
        New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null
    }
    Start-Process explorer.exe $logsRoot
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

[void][System.Windows.Forms.Application]::Run($form)
