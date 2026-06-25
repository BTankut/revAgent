Set-StrictMode -Version Latest

function Get-RevitMcpSourceFreeManagedRoots {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,

        [string]$PackageTarget = "",

        [string]$ServerTarget = "",

        [string]$UserProfileRoot = "",

        [switch]$PreserveLocalCodexInstructions,

        [switch]$SkipCodexUserIntegration,

        [switch]$SkipBackups
    )

    $roots = [System.Collections.Generic.List[object]]::new()

    if ([string]::IsNullOrWhiteSpace($PackageTarget)) {
        $PackageTarget = Join-Path $InstallRoot "package"
    }
    if ([string]::IsNullOrWhiteSpace($ServerTarget)) {
        $ServerTarget = Join-Path $InstallRoot "runtime"
    }
    if ([string]::IsNullOrWhiteSpace($UserProfileRoot)) {
        $UserProfileRoot = $env:USERPROFILE
    }

    $roots.Add([pscustomobject]@{ Label = "managed package"; Path = $PackageTarget; Kind = "package" })
    $roots.Add([pscustomobject]@{ Label = "runtime MCP server"; Path = $ServerTarget; Kind = "runtime" })

    if (-not $PreserveLocalCodexInstructions) {
        $roots.Add([pscustomobject]@{ Label = "machine Codex skill"; Path = (Join-Path $InstallRoot "codex\skills\revit-mcp"); Kind = "codexSkill" })

        if ((-not $SkipCodexUserIntegration) -and -not [string]::IsNullOrWhiteSpace($UserProfileRoot)) {
            $roots.Add([pscustomobject]@{ Label = "user Codex skill"; Path = (Join-Path $UserProfileRoot ".codex\skills\revit-mcp"); Kind = "codexSkill" })
        }
    }

    if (-not $SkipBackups) {
        $backupRoot = Join-Path $InstallRoot "updater\backups"
        if (Test-Path -LiteralPath $backupRoot -PathType Container) {
            Get-ChildItem -LiteralPath $backupRoot -Directory -Filter "revit-mcp-skill.backup-*" -ErrorAction SilentlyContinue |
                ForEach-Object {
                    $roots.Add([pscustomobject]@{ Label = "updater package backup"; Path = $_.FullName; Kind = "backup" })
                }
        }
    }

    return @($roots.ToArray())
}

function Get-RevitMcpSourceFreePathParts {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return @()
    }

    return @($Path -split '[\\/]' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Get-RevitMcpSourceFreeRelativePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
    $pathFull = [System.IO.Path]::GetFullPath($Path)
    if ($pathFull.Length -le $rootFull.Length) {
        return ""
    }

    return $pathFull.Substring($rootFull.Length).TrimStart([char[]]@('\', '/')).Replace("/", "\")
}

function Test-RevitMcpSourceFreeIgnoredPath {
    param([string]$RelativePath)

    foreach ($part in Get-RevitMcpSourceFreePathParts -Path $RelativePath) {
        if ($part -ieq "node_modules" -or $part -ieq "dependencies") {
            return $true
        }
    }

    return $false
}

function Test-RevitMcpSourceFreeAllowedDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [System.IO.DirectoryInfo]$Directory
    )

    $relative = Get-RevitMcpSourceFreeRelativePath -Root $Root -Path $Directory.FullName
    $parts = @(Get-RevitMcpSourceFreePathParts -Path $relative)
    return (
        $parts.Count -eq 3 -and
        $parts[0] -ieq "installer" -and
        $parts[1] -ieq "revit-api-docs-mcp" -and
        $parts[2] -ieq "scripts"
    )
}

function Test-RevitMcpSourceFreePathUnderAnyDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [string[]]$Directories
    )

    if ($null -eq $Directories -or $Directories.Count -eq 0) {
        return $false
    }

    $pathFull = [System.IO.Path]::GetFullPath($Path)
    foreach ($directory in $Directories) {
        $directoryFull = [System.IO.Path]::GetFullPath($directory).TrimEnd("\", "/") + "\"
        if ($pathFull.StartsWith($directoryFull, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    return $false
}

function Assert-RevitMcpSourceFreeCleanupTarget {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
    $pathFull = [System.IO.Path]::GetFullPath($Path)
    $rootPrefix = $rootFull + "\"

    if (-not $pathFull.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing source-free cleanup outside managed root '$rootFull': $pathFull"
    }
    if ([string]::Equals($pathFull.TrimEnd("\", "/"), $rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing source-free cleanup of broad managed root: $pathFull"
    }

    return $pathFull
}

function Get-RevitMcpSourceFreeArtifactInventory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,

        [string]$PackageTarget = "",

        [string]$ServerTarget = "",

        [string]$UserProfileRoot = "",

        [switch]$PreserveLocalCodexInstructions,

        [switch]$SkipCodexUserIntegration,

        [switch]$SkipBackups
    )

    $blockedDirectoryNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @("src", "docs", "references", "evals", "dashboard", "scripts", ".github", ".githooks", ".tmp")) {
        [void]$blockedDirectoryNames.Add($name)
    }

    $blockedFileExtensions = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($extension in @(".cs", ".csproj", ".sln", ".ts", ".tsx", ".pdb", ".mdb", ".map")) {
        [void]$blockedFileExtensions.Add($extension)
    }

    $artifacts = [System.Collections.Generic.List[object]]::new()
    foreach ($rootInfo in Get-RevitMcpSourceFreeManagedRoots -InstallRoot $InstallRoot -PackageTarget $PackageTarget -ServerTarget $ServerTarget -UserProfileRoot $UserProfileRoot -PreserveLocalCodexInstructions:$PreserveLocalCodexInstructions -SkipCodexUserIntegration:$SkipCodexUserIntegration -SkipBackups:$SkipBackups) {
        $rootPath = [string]$rootInfo.Path
        if ([string]::IsNullOrWhiteSpace($rootPath) -or -not (Test-Path -LiteralPath $rootPath -PathType Container)) {
            continue
        }

        $rootFull = [System.IO.Path]::GetFullPath($rootPath)
        $blockedDirectories = [System.Collections.Generic.List[string]]::new()

        Get-ChildItem -LiteralPath $rootFull -Recurse -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object {
                $relative = Get-RevitMcpSourceFreeRelativePath -Root $rootFull -Path $_.FullName
                $blockedDirectoryNames.Contains($_.Name) -and
                -not (Test-RevitMcpSourceFreeIgnoredPath -RelativePath $relative) -and
                -not (Test-RevitMcpSourceFreeAllowedDirectory -Root $rootFull -Directory $_)
            } |
            Sort-Object { $_.FullName.Length } |
            ForEach-Object {
                $relative = Get-RevitMcpSourceFreeRelativePath -Root $rootFull -Path $_.FullName
                $blockedDirectories.Add($_.FullName)
                $artifacts.Add([pscustomobject]@{
                    rootLabel = [string]$rootInfo.Label
                    rootKind = [string]$rootInfo.Kind
                    rootPath = $rootFull
                    kind = "directory"
                    reason = "source_or_developer_directory"
                    relativePath = $relative
                    path = $_.FullName
                })
            }

        Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force -ErrorAction SilentlyContinue |
            Where-Object {
                $relative = Get-RevitMcpSourceFreeRelativePath -Root $rootFull -Path $_.FullName
                -not (Test-RevitMcpSourceFreeIgnoredPath -RelativePath $relative) -and
                -not (Test-RevitMcpSourceFreePathUnderAnyDirectory -Path $_.FullName -Directories @($blockedDirectories.ToArray())) -and
                (
                    $blockedFileExtensions.Contains($_.Extension) -or
                    $_.Name -like "*.test.js" -or
                    $_.Name -like "*.guard-test.js" -or
                    $_.Name -like "*.test.mjs" -or
                    $_.Name -ieq "tsconfig.json"
                )
            } |
            ForEach-Object {
                $relative = Get-RevitMcpSourceFreeRelativePath -Root $rootFull -Path $_.FullName
                $artifacts.Add([pscustomobject]@{
                    rootLabel = [string]$rootInfo.Label
                    rootKind = [string]$rootInfo.Kind
                    rootPath = $rootFull
                    kind = "file"
                    reason = "source_or_developer_file"
                    relativePath = $relative
                    path = $_.FullName
                })
            }
    }

    return @($artifacts.ToArray() | Sort-Object rootLabel, relativePath)
}

function Invoke-RevitMcpSourceFreeArtifactCleanup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,

        [string]$PackageTarget = "",

        [string]$ServerTarget = "",

        [string]$UserProfileRoot = "",

        [switch]$PreserveLocalCodexInstructions,

        [switch]$SkipCodexUserIntegration,

        [switch]$SkipBackups,

        [switch]$Commit
    )

    $artifacts = @(Get-RevitMcpSourceFreeArtifactInventory -InstallRoot $InstallRoot -PackageTarget $PackageTarget -ServerTarget $ServerTarget -UserProfileRoot $UserProfileRoot -PreserveLocalCodexInstructions:$PreserveLocalCodexInstructions -SkipCodexUserIntegration:$SkipCodexUserIntegration -SkipBackups:$SkipBackups)
    $removed = [System.Collections.Generic.List[object]]::new()
    $failed = [System.Collections.Generic.List[object]]::new()

    if ($Commit) {
        foreach ($artifact in @($artifacts | Sort-Object { [string]$_.path } -Descending)) {
            try {
                $safePath = Assert-RevitMcpSourceFreeCleanupTarget -Path ([string]$artifact.path) -Root ([string]$artifact.rootPath)
                if (Test-Path -LiteralPath $safePath) {
                    if ([string]$artifact.kind -eq "directory") {
                        Remove-Item -LiteralPath $safePath -Recurse -Force -ErrorAction Stop
                    }
                    else {
                        Remove-Item -LiteralPath $safePath -Force -ErrorAction Stop
                    }
                }
                $removed.Add($artifact)
            }
            catch {
                $failed.Add([pscustomobject]@{
                    path = [string]$artifact.path
                    relativePath = [string]$artifact.relativePath
                    rootLabel = [string]$artifact.rootLabel
                    error = $_.Exception.Message
                })
            }
        }
    }

    $remaining = @(if ($Commit) {
            Get-RevitMcpSourceFreeArtifactInventory -InstallRoot $InstallRoot -PackageTarget $PackageTarget -ServerTarget $ServerTarget -UserProfileRoot $UserProfileRoot -PreserveLocalCodexInstructions:$PreserveLocalCodexInstructions -SkipCodexUserIntegration:$SkipCodexUserIntegration -SkipBackups:$SkipBackups
        }
        else {
            $artifacts
        })

    return [pscustomobject][ordered]@{
        mode = if ($Commit) { "commit" } else { "dryRun" }
        success = ($failed.Count -eq 0 -and $remaining.Count -eq 0)
        codexInstructionCleanupSkipped = [bool]$PreserveLocalCodexInstructions
        artifactCount = $artifacts.Count
        removedCount = $removed.Count
        failedCount = $failed.Count
        remainingCount = $remaining.Count
        artifacts = @($artifacts)
        removed = @($removed.ToArray())
        failed = @($failed.ToArray())
        remaining = @($remaining)
    }
}

Export-ModuleMember -Function `
    Get-RevitMcpSourceFreeManagedRoots, `
    Get-RevitMcpSourceFreeArtifactInventory, `
    Invoke-RevitMcpSourceFreeArtifactCleanup
