<#
.SYNOPSIS
    Simple GUI for installing or updating the Revit MCP workstation package.
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
$script:ActiveProcess = $null
$script:ActiveLogPath = ""
$script:LastLogLength = -1

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

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "Revit MCP Installer"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(820, 560)
$form.MinimumSize = New-Object System.Drawing.Size(700, 460)

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = "Fill"
$root.ColumnCount = 1
$root.RowCount = 5
$root.Padding = New-Object System.Windows.Forms.Padding(12)
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
$form.Controls.Add($root)

$title = New-Object System.Windows.Forms.Label
$title.Text = "Revit MCP kurulum ve guncelleme"
$title.Font = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$root.Controls.Add($title, 0, 0)

$details = New-Object System.Windows.Forms.Label
$details.Text = "Kanal: $ChannelManifestPath`r`nKurulum: $InstallRoot"
$details.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$details.AutoSize = $true
$details.Margin = New-Object System.Windows.Forms.Padding(0, 8, 0, 8)
$root.Controls.Add($details, 0, 1)

$statusPanel = New-Object System.Windows.Forms.TableLayoutPanel
$statusPanel.Dock = "Fill"
$statusPanel.ColumnCount = 2
$statusPanel.RowCount = 1
$statusPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$statusPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 180))) | Out-Null
$root.Controls.Add($statusPanel, 0, 2)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = "Hazir."
$statusLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$statusLabel.AutoSize = $true
$statusPanel.Controls.Add($statusLabel, 0, 0)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Dock = "Fill"
$progress.Style = "Blocks"
$statusPanel.Controls.Add($progress, 1, 0)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Dock = "Fill"
$logBox.Multiline = $true
$logBox.ScrollBars = "Both"
$logBox.WordWrap = $false
$logBox.ReadOnly = $true
$logBox.Font = New-Object System.Drawing.Font("Consolas", 9)
$root.Controls.Add($logBox, 0, 3)

$buttonPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$buttonPanel.Dock = "Fill"
$buttonPanel.FlowDirection = "LeftToRight"
$buttonPanel.AutoSize = $true
$buttonPanel.Margin = New-Object System.Windows.Forms.Padding(0, 10, 0, 0)
$root.Controls.Add($buttonPanel, 0, 4)

$runButton = New-Object System.Windows.Forms.Button
$runButton.Text = "Kur / Guncelle"
$runButton.Width = 130
$runButton.Height = 32
$buttonPanel.Controls.Add($runButton)

$versionButton = New-Object System.Windows.Forms.Button
$versionButton.Text = "Surum kontrol"
$versionButton.Width = 120
$versionButton.Height = 32
$buttonPanel.Controls.Add($versionButton)

$openLogsButton = New-Object System.Windows.Forms.Button
$openLogsButton.Text = "Log klasoru"
$openLogsButton.Width = 110
$openLogsButton.Height = 32
$buttonPanel.Controls.Add($openLogsButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = "Kapat"
$closeButton.Width = 90
$closeButton.Height = 32
$buttonPanel.Controls.Add($closeButton)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 700

function Set-ButtonsEnabled {
    param([bool]$Enabled)
    $runButton.Enabled = $Enabled
    $versionButton.Enabled = $Enabled
    $closeButton.Enabled = $Enabled
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
            $statusLabel.Text = "Islem tamamlandi. Log: $script:ActiveLogPath"
            [System.Windows.Forms.MessageBox]::Show(
                "Islem tamamlandi.`r`nLog: $script:ActiveLogPath",
                "Revit MCP Installer",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
        }
        else {
            $statusLabel.Text = "Hata olustu. Log: $script:ActiveLogPath"
            [System.Windows.Forms.MessageBox]::Show(
                "Kurulum/guncelleme hata ile bitti.`r`nLog: $script:ActiveLogPath",
                "Revit MCP Installer",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
        }
    }
})

$runButton.Add_Click({
    if (-not (Test-Path -LiteralPath $installerPath)) {
        [System.Windows.Forms.MessageBox]::Show("Installer bulunamadi:`r`n$installerPath", "Revit MCP Installer") | Out-Null
        return
    }
    if (-not (Test-Path -LiteralPath $ChannelManifestPath)) {
        [System.Windows.Forms.MessageBox]::Show("Stable kanal dosyasi bulunamadi:`r`n$ChannelManifestPath", "Revit MCP Installer") | Out-Null
        return
    }

    $script:ActiveLogPath = New-RunLogPath
    $script:LastLogLength = -1
    $logBox.Text = "Kurulum/guncelleme basliyor...`r`nLog: $script:ActiveLogPath`r`n"
    $statusLabel.Text = "Calisiyor. Log: $script:ActiveLogPath"
    $progress.Style = "Marquee"
    Set-ButtonsEnabled -Enabled $false

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
        "-LogPath", $script:ActiveLogPath
    )

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
        $statusLabel.Text = "Baslatilamadi. Log: $script:ActiveLogPath"
        [System.Windows.Forms.MessageBox]::Show(
            "PowerShell baslatilamadi.`r`n$($_.Exception.Message)`r`nLog: $script:ActiveLogPath",
            "Revit MCP Installer",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    }
})

$versionButton.Add_Click({
    if (-not (Test-Path -LiteralPath $localVersionTool)) {
        $logBox.Text = "Surum kontrol araci henuz kurulu degil.`r`nOnce Kur / Guncelle calistirin."
        return
    }

    try {
        $output = & $powershellPath -NoProfile -ExecutionPolicy Bypass -File $localVersionTool -ConfigPath $configPath 2>&1 | Out-String
        $logBox.Text = $output
        $statusLabel.Text = "Surum kontrol tamamlandi."
    }
    catch {
        $logBox.Text = "Surum kontrol hata verdi:`r`n$($_.Exception.Message)"
        $statusLabel.Text = "Surum kontrol hata verdi."
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
            "Islem devam ediyor. Bitmeden kapatmayin.`r`nLog: $script:ActiveLogPath",
            "Revit MCP Installer",
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
            "Islem devam ediyor. Bitmeden kapatmayin.`r`nLog: $script:ActiveLogPath",
            "Revit MCP Installer",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    }
})

[void][System.Windows.Forms.Application]::Run($form)
