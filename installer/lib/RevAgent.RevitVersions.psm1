Set-StrictMode -Version Latest

function Get-RevitMcpRepoRootFromModule {
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
}

function Get-RevitMcpVersionMatrixPath {
    param([string]$RepoRoot = "")

    $candidates = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($RepoRoot)) {
        $candidates.Add((Join-Path $RepoRoot "config\revit-versions.json"))
    }
    else {
        $moduleRepoRoot = Get-RevitMcpRepoRootFromModule
        foreach ($candidate in @(
                (Join-Path $moduleRepoRoot "config\revit-versions.json"),
                (Join-Path (Split-Path -Parent $PSScriptRoot) "config\revit-versions.json"),
                (Join-Path $PSScriptRoot "..\config\revit-versions.json"),
                (Join-Path $PSScriptRoot "..\..\package\config\revit-versions.json")
            )) {
            $candidates.Add($candidate)
        }
    }

    foreach ($candidate in $candidates) {
        $full = [System.IO.Path]::GetFullPath($candidate)
        if (Test-Path -LiteralPath $full -PathType Leaf) {
            return $full
        }
    }

    return [System.IO.Path]::GetFullPath($candidates[0])
}

function Get-RevitMcpVersionMatrix {
    param([string]$RepoRoot = "")

    $path = Get-RevitMcpVersionMatrixPath -RepoRoot $RepoRoot
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Revit version matrix was not found: $path"
    }

    return Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
}

function Get-RevitMcpVersionConfig {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Version,
        [string]$RepoRoot = ""
    )

    $matrix = Get-RevitMcpVersionMatrix -RepoRoot $RepoRoot
    $property = $matrix.versions.PSObject.Properties[$Version]
    if (-not $property) {
        $known = ($matrix.versions.PSObject.Properties.Name | Sort-Object) -join ", "
        throw "Unsupported Revit version '$Version'. Known versions: $known"
    }

    return $property.Value
}

function Expand-RevitMcpVersionPattern {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Pattern,
        [Parameter(Mandatory = $true)]
        [string]$Version
    )

    $value = $Pattern.Replace("{version}", $Version)
    return [Environment]::ExpandEnvironmentVariables($value)
}

function Get-RevitMcpRegistryInstallCandidates {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Version,
        [string]$RepoRoot = ""
    )

    $config = Get-RevitMcpVersionConfig -Version $Version -RepoRoot $RepoRoot
    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($pattern in @($config.registryRoots)) {
        $root = Expand-RevitMcpVersionPattern -Pattern ([string]$pattern) -Version $Version
        if (-not (Test-Path -LiteralPath $root)) { continue }
        try {
            $item = Get-ItemProperty -LiteralPath $root -ErrorAction Stop
            foreach ($name in @("InstallationLocation", "InstallLocation", "InstallDir", "ProductInstallPath")) {
                if ($item.PSObject.Properties.Name -contains $name) {
                    $value = [string]$item.$name
                    if (-not [string]::IsNullOrWhiteSpace($value)) {
                        $candidates.Add($value)
                    }
                }
            }
        }
        catch {}
    }

    return $candidates.ToArray()
}

function Get-RevitMcpInstallRootCandidates {
    param(
        [string]$RequestedRoot = "",
        [Parameter(Mandatory = $true)]
        [string]$Version,
        [string]$RepoRoot = ""
    )

    $config = Get-RevitMcpVersionConfig -Version $Version -RepoRoot $RepoRoot
    $candidates = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($RequestedRoot)) {
        $candidates.Add($RequestedRoot)
    }
    foreach ($pattern in @($config.installRootCandidatePatterns)) {
        $candidate = Expand-RevitMcpVersionPattern -Pattern ([string]$pattern) -Version $Version
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and $candidate -notmatch '^%[^%]+%') {
            $candidates.Add($candidate)
        }
    }
    foreach ($candidate in Get-RevitMcpRegistryInstallCandidates -Version $Version -RepoRoot $RepoRoot) {
        $candidates.Add($candidate)
    }

    return @($candidates.ToArray() | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
}

function Resolve-RevitMcpInstallRoot {
    param(
        [string]$RequestedRoot = "",
        [Parameter(Mandatory = $true)]
        [string]$Version,
        [string]$RepoRoot = "",
        [switch]$RequireXmlDocs
    )

    $checked = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in Get-RevitMcpInstallRootCandidates -RequestedRoot $RequestedRoot -Version $Version -RepoRoot $RepoRoot) {
        $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
        if (-not [System.IO.Path]::IsPathRooted($expanded)) { continue }
        $full = [System.IO.Path]::GetFullPath($expanded).TrimEnd("\")
        $checked.Add($full)
        $requiredFiles = @("Revit.exe", "RevitAPI.dll")
        if ($RequireXmlDocs) {
            $requiredFiles += "RevitAPI.xml"
        }
        $missing = @($requiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $full $_) -PathType Leaf) })
        if ((Test-Path -LiteralPath $full -PathType Container) -and $missing.Count -eq 0) {
            Write-Host "Revit $Version found: $full"
            return $full
        }
    }

    throw "Revit $Version install directory could not be found. Checked: $($checked.ToArray() -join '; ')"
}

function Assert-RevitMcpInstallerPayloadAvailable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Version,
        [string]$RepoRoot = ""
    )

    if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
        $RepoRoot = Get-RevitMcpRepoRootFromModule
    }
    $config = Get-RevitMcpVersionConfig -Version $Version -RepoRoot $RepoRoot
    if (-not [bool]$config.installerPayloadAvailable) {
        throw "Revit $Version is known in config/revit-versions.json, but this branch does not bundle installer payload artifacts for that version. Build and validate the payload first, then set installerPayloadAvailable for that version."
    }

    $payload = $config.payload
    $requiredPaths = @(
        [string]$payload.installerPluginPath,
        [string]$payload.commandPayloadPath,
        [string]$payload.commandRuntimePath,
        [string]$payload.runtimeMcpPath
    )
    foreach ($relative in $requiredPaths) {
        $fullPath = Join-Path $RepoRoot $relative
        if (-not (Test-Path -LiteralPath $fullPath)) {
            throw "Revit $Version installer payload is marked available, but required path is missing: $fullPath"
        }
    }
}

$revAgentFunctionAliases = @{
    "Assert-RevAgentInstallerPayloadAvailable" = "Assert-RevitMcpInstallerPayloadAvailable"
    "Expand-RevAgentVersionPattern" = "Expand-RevitMcpVersionPattern"
    "Get-RevAgentInstallRootCandidates" = "Get-RevitMcpInstallRootCandidates"
    "Get-RevAgentRegistryInstallCandidates" = "Get-RevitMcpRegistryInstallCandidates"
    "Get-RevAgentVersionConfig" = "Get-RevitMcpVersionConfig"
    "Get-RevAgentVersionMatrix" = "Get-RevitMcpVersionMatrix"
    "Get-RevAgentVersionMatrixPath" = "Get-RevitMcpVersionMatrixPath"
    "Resolve-RevAgentInstallRoot" = "Resolve-RevitMcpInstallRoot"
}
foreach ($aliasPair in $revAgentFunctionAliases.GetEnumerator()) {
    Set-Alias -Name $aliasPair.Key -Value $aliasPair.Value
}

Export-ModuleMember -Function `
    Get-RevitMcpVersionMatrixPath, `
    Get-RevitMcpVersionMatrix, `
    Get-RevitMcpVersionConfig, `
    Expand-RevitMcpVersionPattern, `
    Get-RevitMcpInstallRootCandidates, `
    Get-RevitMcpRegistryInstallCandidates, `
    Resolve-RevitMcpInstallRoot, `
    Assert-RevitMcpInstallerPayloadAvailable
Export-ModuleMember -Alias @($revAgentFunctionAliases.Keys)
