<#
.SYNOPSIS
    Enable the repository's optional local Git hooks.

.DESCRIPTION
    This script configures Git to read hooks from .githooks. It is opt-in and
    does not change CI enforcement; GitHub branch protection remains the real
    server-side gate.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

$hooksPath = Join-Path $RepoRoot ".githooks"
if (-not (Test-Path -LiteralPath $hooksPath -PathType Container)) {
    throw "Git hooks folder was not found: $hooksPath"
}

Push-Location $RepoRoot
try {
    git config core.hooksPath .githooks
}
finally {
    Pop-Location
}

Write-Host "Local Git hooks enabled with core.hooksPath=.githooks" -ForegroundColor Green
