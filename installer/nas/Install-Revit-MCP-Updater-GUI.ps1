<#
.SYNOPSIS
    Legacy compatibility wrapper for the revAgent updater GUI.
#>

[CmdletBinding()]
param(
    [string]$ChannelManifestPath = "",
    [string]$InstallRoot = "",
    [switch]$SmokeTest
)

$ErrorActionPreference = "Stop"
$target = Join-Path $PSScriptRoot "Install-revAgent-Updater-GUI.ps1"
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw "revAgent GUI script was not found: $target"
}

$arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $target)
if (-not [string]::IsNullOrWhiteSpace($ChannelManifestPath)) {
    $arguments += @("-ChannelManifestPath", $ChannelManifestPath)
}
if (-not [string]::IsNullOrWhiteSpace($InstallRoot)) {
    $arguments += @("-InstallRoot", $InstallRoot)
}
if ($SmokeTest) {
    $arguments += "-SmokeTest"
}

& (Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe") @arguments
if ($null -ne $LASTEXITCODE) {
    exit $LASTEXITCODE
}
exit 0
