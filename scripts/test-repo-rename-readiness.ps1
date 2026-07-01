<#
.SYNOPSIS
    Validate active repository surfaces are ready for the revAgent repo rename.
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
$normalizedRepoRoot = $RepoRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)

$skipDirectories = @(
    ".git",
    "node_modules",
    "docs\_retired",
    "installer\runtime-mcp-server\node_modules",
    "installer\revit-api-docs-mcp\node_modules"
)
$skipExtensions = @(
    ".dll",
    ".exe",
    ".msi",
    ".pdb",
    ".zip"
)

function Test-RevAgentSkippedPath {
    param([string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $relative = $fullPath
    if ($fullPath.StartsWith($normalizedRepoRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        $relative = $fullPath.Substring($normalizedRepoRoot.Length + 1)
    }
    $extension = [System.IO.Path]::GetExtension($fullPath)
    if ($skipExtensions -contains $extension) {
        return $true
    }
    if ($relative -match '(^|\\)(bin|obj)(\\|$)') {
        return $true
    }
    foreach ($skip in $skipDirectories) {
        if ($relative -eq $skip -or $relative.StartsWith($skip + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Get-RevAgentRelativePath {
    param([string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith($normalizedRepoRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $fullPath.Substring($normalizedRepoRoot.Length + 1)
    }
    return $fullPath
}

$files = @(
    Get-ChildItem -LiteralPath $RepoRoot -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { -not (Test-RevAgentSkippedPath -Path $_.FullName) }
)

$blockedTexts = @(
    "BTankut/revit-mcp-skill",
    "github.com/BTankut/revit-mcp-skill",
    "C:\Projects\revit-mcp-skill",
    "C:\Users\BT\Projects\revit-mcp-skill"
)

$findings = [System.Collections.Generic.List[string]]::new()
foreach ($file in $files) {
    $relative = Get-RevAgentRelativePath -Path $file.FullName
    if ($relative -eq "scripts\test-repo-rename-readiness.ps1") {
        continue
    }

    try {
        $content = Get-Content -Raw -LiteralPath $file.FullName -Encoding UTF8
    }
    catch {
        continue
    }
    if ($null -eq $content) {
        continue
    }

    foreach ($blockedText in $blockedTexts) {
        if ($content.Contains($blockedText)) {
            [void]$findings.Add(("{0}: contains '{1}'" -f $relative, $blockedText))
        }
    }
}

foreach ($path in @("README.md", "docs\DEVELOPER_RUNBOOK.md")) {
    $fullPath = Join-Path $RepoRoot $path
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        continue
    }
    $lineNumber = 0
    foreach ($line in Get-Content -LiteralPath $fullPath -Encoding UTF8) {
        $lineNumber++
        if ($line -match '^revit-mcp-skill[\\/]') {
            [void]$findings.Add(("{0}:{1}: repo layout root should use revAgent/" -f $path, $lineNumber))
        }
    }
}

if ($findings.Count -gt 0) {
    throw ("Repository rename readiness failed:`n{0}" -f ($findings -join "`n"))
}

Write-Host "Repository rename readiness tests passed." -ForegroundColor Green
