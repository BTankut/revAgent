<#
.SYNOPSIS
    Start the installed revAgent dashboard Cloudflare tunnel.
#>

[CmdletBinding()]
param(
    [string]$AddonRoot = "",
    [string]$CloudflaredExe = "",
    [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($AddonRoot)) {
    $AddonRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$AddonRoot = [System.IO.Path]::GetFullPath($AddonRoot)

if ([string]::IsNullOrWhiteSpace($CloudflaredExe)) {
    $CloudflaredExe = Join-Path $AddonRoot "tunnel\bin\cloudflared.exe"
}
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $AddonRoot "tunnel\config\config.yml"
}

if (-not (Test-Path -LiteralPath $CloudflaredExe -PathType Leaf)) {
    throw "cloudflared.exe was not found: $CloudflaredExe"
}
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Dashboard tunnel config was not found: $ConfigPath"
}

New-Item -ItemType Directory -Path (Join-Path $AddonRoot "tunnel\logs") -Force | Out-Null

& $CloudflaredExe tunnel --config $ConfigPath run
