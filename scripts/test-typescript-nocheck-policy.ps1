<#
.SYNOPSIS
    Enforce the current TypeScript @ts-nocheck debt boundary.

.DESCRIPTION
    Existing unchecked files are kept in an explicit allowlist so the current
    runtime can keep shipping while the boundary shrinks. New TypeScript source
    files under the MCP packages must not introduce @ts-nocheck unless this
    allowlist is deliberately changed in the same review.
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

$allowedNoCheck = @(
    "installer\revit-api-docs-mcp\src\utils\docIndex.ts",
    "installer\runtime-mcp-server\src\database\service.ts",
    "installer\runtime-mcp-server\src\utils\ConnectionManager.ts",
    "installer\runtime-mcp-server\src\utils\revitToolHelpers.ts",
    "installer\runtime-mcp-server\src\utils\SocketClient.ts",
    "installer\runtime-mcp-server\src\utils\telemetry.ts"
)

$allowSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($path in $allowedNoCheck) {
    [void]$allowSet.Add($path)
}

$sourceRoots = @(
    "installer\runtime-mcp-server\src",
    "installer\revit-api-docs-mcp\src"
)

$actualNoCheck = [System.Collections.Generic.List[string]]::new()
foreach ($sourceRoot in $sourceRoots) {
    $fullRoot = Join-Path $RepoRoot $sourceRoot
    if (-not (Test-Path -LiteralPath $fullRoot -PathType Container)) {
        throw "TypeScript source root was not found: $fullRoot"
    }

    Get-ChildItem -LiteralPath $fullRoot -Recurse -File -Filter "*.ts" |
        Sort-Object FullName |
        ForEach-Object {
            $relative = $_.FullName.Substring($RepoRoot.Length + 1)
            if ((Get-Content -Raw -LiteralPath $_.FullName) -match '@ts-nocheck') {
                [void]$actualNoCheck.Add($relative)
            }
        }
}

$newNoCheck = @($actualNoCheck | Where-Object { -not $allowSet.Contains($_) })
if ($newNoCheck.Count -gt 0) {
    throw "New TypeScript @ts-nocheck usage is not allowed. Remove it or deliberately update the shrinking allowlist: $($newNoCheck -join ', ')"
}

$actualSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($path in $actualNoCheck) {
    [void]$actualSet.Add($path)
}

$staleAllowlist = @($allowedNoCheck | Where-Object { -not $actualSet.Contains($_) })
if ($staleAllowlist.Count -gt 0) {
    throw "The @ts-nocheck allowlist contains files that are now checked. Remove these allowlist entries: $($staleAllowlist -join ', ')"
}

Write-Host "TypeScript @ts-nocheck policy passed. Allowed unchecked files: $($actualNoCheck.Count)." -ForegroundColor Green
