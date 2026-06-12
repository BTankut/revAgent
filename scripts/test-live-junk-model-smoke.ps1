<#
.SYNOPSIS
    Run optional live Revit junk-model smoke checks through runtime tools.

.DESCRIPTION
    This gate is intentionally not part of test-all or CI. It requires Revit
    with revAgent loaded, an active junk/test model, and at least one MEP target
    element. It exercises parameter set/restore when safe, schedule body write
    guarding, safe-code guarding, focus, view export, coordination export, and
    cleanup.
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

$runtimeRoot = Join-Path $RepoRoot "installer\runtime-mcp-server"
$scriptPath = Join-Path $runtimeRoot "scripts\live-junk-model-smoke.mjs"
$registerPath = Join-Path $runtimeRoot "build\tools\register.js"

if (-not (Test-Path -LiteralPath $registerPath -PathType Leaf)) {
    throw "Runtime build output was not found: $registerPath. Run npm test or npm run build in installer\runtime-mcp-server first."
}

Push-Location $runtimeRoot
try {
    node $scriptPath
    if ($LASTEXITCODE -ne 0) {
        throw "Live junk-model smoke failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
