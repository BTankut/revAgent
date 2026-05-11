Set-StrictMode -Version Latest

function Resolve-RevitMcpReleasePath {
    param(
        [string]$Path,
        [string]$BaseDirectory
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }

    $expanded = [Environment]::ExpandEnvironmentVariables($Path)
    if ([System.IO.Path]::IsPathRooted($expanded)) {
        return $expanded
    }

    return Join-Path $BaseDirectory $expanded
}

function Resolve-RevitMcpPackageLayout {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,
        [object]$ReleaseManifest = $null
    )

    $installerCandidates = [System.Collections.Generic.List[string]]::new()
    if ($ReleaseManifest -and $ReleaseManifest.installer -and $ReleaseManifest.installer.entryPoint) {
        $installerCandidates.Add([string]$ReleaseManifest.installer.entryPoint)
    }
    foreach ($candidate in @(
            "installer\install-self-contained.ps1",
            "kurulum\install-self-contained.ps1"
        )) {
        if (-not $installerCandidates.Contains($candidate)) {
            $installerCandidates.Add($candidate)
        }
    }

    foreach ($installerRelative in $installerCandidates) {
        $installerPath = Join-Path $Root $installerRelative
        if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
            continue
        }

        $installerRelativeRoot = Split-Path -Parent $installerRelative
        $docsCandidates = [System.Collections.Generic.List[string]]::new()
        if ($ReleaseManifest -and $ReleaseManifest.installer -and $ReleaseManifest.installer.docsServerPath) {
            $docsCandidates.Add([string]$ReleaseManifest.installer.docsServerPath)
        }
        $defaultDocs = Join-Path $installerRelativeRoot "revit-api-docs-mcp"
        if (-not $docsCandidates.Contains($defaultDocs)) {
            $docsCandidates.Add($defaultDocs)
        }
        foreach ($legacyDocs in @("installer\revit-api-docs-mcp", "kurulum\revit-api-docs-mcp")) {
            if (-not $docsCandidates.Contains($legacyDocs)) {
                $docsCandidates.Add($legacyDocs)
            }
        }

        foreach ($docsRelative in $docsCandidates) {
            $docsPath = Join-Path $Root $docsRelative
            if (Test-Path -LiteralPath (Join-Path $docsPath "package.json") -PathType Leaf) {
                return [ordered]@{
                    installerRelativePath = $installerRelative
                    docsServerRelativePath = $docsRelative
                }
            }
        }
    }

    throw "Extracted package does not look like revit-mcp-skill: $Root"
}

function Expand-RevitMcpReleaseArchive {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ZipPath,
        [Parameter(Mandatory = $true)]
        [string]$DestinationPath
    )

    if (Test-Path -LiteralPath $DestinationPath) {
        Remove-Item -LiteralPath $DestinationPath -Recurse -Force
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $DestinationPath) -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    New-Item -ItemType Directory -Path $DestinationPath -Force | Out-Null

    $destinationRoot = [System.IO.Path]::GetFullPath($DestinationPath).TrimEnd("\") + "\"
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        foreach ($entry in $archive.Entries) {
            $entryName = $entry.FullName.Replace("/", "\")
            while ($entryName.StartsWith("\")) {
                $entryName = $entryName.Substring(1)
            }
            if ([string]::IsNullOrWhiteSpace($entryName)) {
                continue
            }

            $targetPath = [System.IO.Path]::GetFullPath((Join-Path $DestinationPath $entryName))
            if (-not $targetPath.StartsWith($destinationRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Archive entry points outside the extraction directory: $($entry.FullName)"
            }

            if ($entry.FullName.EndsWith("/") -or $entry.FullName.EndsWith("\")) {
                New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
                continue
            }

            $targetDir = Split-Path -Parent $targetPath
            if (-not [string]::IsNullOrWhiteSpace($targetDir)) {
                New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
            }

            $sourceStream = $entry.Open()
            try {
                $targetStream = [System.IO.File]::Open($targetPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                try {
                    $sourceStream.CopyTo($targetStream)
                }
                finally {
                    $targetStream.Dispose()
                }
            }
            finally {
                $sourceStream.Dispose()
            }
        }
    }
    finally {
        $archive.Dispose()
    }
}

Export-ModuleMember -Function `
    Resolve-RevitMcpReleasePath, `
    Resolve-RevitMcpPackageLayout, `
    Expand-RevitMcpReleaseArchive
