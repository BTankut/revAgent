<#
.SYNOPSIS
    Enforce the zero-allowlist TypeScript @ts-nocheck policy.

.DESCRIPTION
    TypeScript source files under the runtime and Revit API docs MCP packages
    must stay checked by default. The allowlist is intentionally empty; adding
    @ts-nocheck requires a deliberate policy change in the same review.
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

$allowedNoCheck = @()

$allowSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($path in $allowedNoCheck) {
    [void]$allowSet.Add($path)
}

$sourceRoots = @(
    "installer\runtime-mcp-server\src",
    "installer\revit-api-docs-mcp\src"
)

$strictConfigPaths = @(
    "installer\runtime-mcp-server\tsconfig.json",
    "installer\revit-api-docs-mcp\tsconfig.json"
)

foreach ($configPath in $strictConfigPaths) {
    $fullConfigPath = Join-Path $RepoRoot $configPath
    if (-not (Test-Path -LiteralPath $fullConfigPath -PathType Leaf)) {
        throw "TypeScript config was not found: $fullConfigPath"
    }

    $config = Get-Content -Raw -LiteralPath $fullConfigPath | ConvertFrom-Json
    $compilerOptions = $config.compilerOptions
    if ($compilerOptions.strict -ne $true) {
        throw "TypeScript strict:true is required in $configPath."
    }

    foreach ($maskedOption in @("noImplicitAny", "useUnknownInCatchVariables")) {
        $property = $compilerOptions.PSObject.Properties[$maskedOption]
        if ($null -ne $property -and $property.Value -eq $false) {
            throw "TypeScript strict:true must not be masked by $maskedOption:false in $configPath."
        }
    }
}

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
    throw "TypeScript @ts-nocheck usage is not allowed by the current zero-allowlist policy. Remove it or make an explicit policy change: $($newNoCheck -join ', ')"
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
