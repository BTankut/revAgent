<#
.SYNOPSIS
    Validate lightweight eval metadata uses the active revAgent product identity.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

$evalsPath = Join-Path $RepoRoot "evals\evals.json"
if (-not (Test-Path -LiteralPath $evalsPath -PathType Leaf)) {
    throw "Missing eval metadata file: $evalsPath"
}

$evals = Get-Content -Raw -LiteralPath $evalsPath -Encoding UTF8 | ConvertFrom-Json
if ([string]$evals.skill_name -ne "revAgent") {
    throw "evals/evals.json skill_name must be revAgent, got '$($evals.skill_name)'."
}

Write-Host "Eval branding tests passed." -ForegroundColor Green
