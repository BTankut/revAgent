function New-McpPackageWorkCopy {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageRoot,

        [Parameter(Mandatory = $true)]
        [string]$PackageRelativePath
    )

    if (-not (Test-Path -LiteralPath $PackageRoot -PathType Container)) {
        throw "MCP package root was not found for ${PackageRelativePath}: $PackageRoot"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot "package-lock.json") -PathType Leaf)) {
        throw "package-lock.json was not found for $PackageRelativePath; cannot restore deterministic npm dependencies."
    }

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-mcp-package-test-" + [Guid]::NewGuid().ToString("N"))
    $packageName = Split-Path -Leaf $PackageRelativePath
    $workRoot = Join-Path $tempRoot $packageName
    New-Item -ItemType Directory -Path $workRoot -Force | Out-Null

    $excludedNames = @{
        "node_modules" = $true
        ".package-lock.json" = $true
    }

    Get-ChildItem -Force -LiteralPath $PackageRoot |
        Where-Object { -not $excludedNames.ContainsKey($_.Name) } |
        ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $workRoot -Recurse -Force
        }

    return [pscustomobject]@{
        SourceRoot = $PackageRoot
        PackageRoot = $workRoot
        TempRoot = $tempRoot
        RelativePath = $PackageRelativePath
    }
}

function Remove-McpPackageWorkCopy {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [object]$WorkCopy
    )

    $tempRoot = [string]$WorkCopy.TempRoot
    if (-not [string]::IsNullOrWhiteSpace($tempRoot) -and (Test-Path -LiteralPath $tempRoot)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

function Invoke-McpPackageCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageName,

        [Parameter(Mandatory = $true)]
        [string]$PackageRoot,

        [string]$RepoRoot = "",

        [Parameter(Mandatory = $true)]
        [scriptblock]$Command
    )

    Write-Host "== $PackageName ==" -ForegroundColor Cyan
    $previousRepoRoot = $env:REVIT_MCP_REPO_ROOT
    Push-Location $PackageRoot
    try {
        if (-not [string]::IsNullOrWhiteSpace($RepoRoot)) {
            $env:REVIT_MCP_REPO_ROOT = $RepoRoot
        }
        & $Command
        if ($LASTEXITCODE -ne 0) {
            throw "$PackageName command failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
        if ($null -eq $previousRepoRoot) {
            Remove-Item Env:\REVIT_MCP_REPO_ROOT -ErrorAction SilentlyContinue
        }
        else {
            $env:REVIT_MCP_REPO_ROOT = $previousRepoRoot
        }
    }
}

function Invoke-McpPackageNpmCi {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageName,

        [Parameter(Mandatory = $true)]
        [string]$PackageRoot,

        [Parameter(Mandatory = $true)]
        [string]$PackageRelativePath
    )

    if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot "package-lock.json") -PathType Leaf)) {
        throw "package-lock.json was not found for $PackageRelativePath; cannot restore deterministic npm dependencies."
    }

    Invoke-McpPackageCommand -PackageName "$PackageName dependencies" -PackageRoot $PackageRoot -Command {
        npm ci
    }
}

function Get-McpPackageTscPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageRoot,

        [Parameter(Mandatory = $true)]
        [string]$PackageRelativePath
    )

    $tscCandidates = @(
        (Join-Path $PackageRoot "node_modules\.bin\tsc.cmd"),
        (Join-Path $PackageRoot "node_modules\.bin\tsc")
    )
    $tscPath = @($tscCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }) | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($tscPath)) {
        throw "TypeScript compiler was not found under $PackageRoot\node_modules\.bin after npm ci for $PackageRelativePath."
    }
    return $tscPath
}

Export-ModuleMember -Function `
    New-McpPackageWorkCopy, `
    Remove-McpPackageWorkCopy, `
    Invoke-McpPackageCommand, `
    Invoke-McpPackageNpmCi, `
    Get-McpPackageTscPath
