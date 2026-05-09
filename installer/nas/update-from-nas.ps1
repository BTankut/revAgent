<#
.SYNOPSIS
    Update a workstation from a NAS-hosted Revit MCP channel manifest.

.DESCRIPTION
    Reads channels\stable.json from the NAS, compares it with the local
    installed state, verifies the package hash, replaces the managed local
    package copy, runs the self-contained installer, refreshes npm dependencies,
    and writes a machine report.
#>

[CmdletBinding()]
param(
    [string]$ConfigPath = "",
    [string]$ChannelManifestPath = "",
    [string]$InstallRoot = "",
    [string]$WorkRoot = "",
    [string]$PackageTarget = "",
    [string]$ServerTarget = "",
    [string]$WorkspaceAgentsTarget = "",
    [string]$RevitInstallRoot = "",
    [ValidateSet("2022")]
    [string]$RevitVersion = "2022",
    [string[]]$LegacyServerTargets = @(),
    [string]$ReportsRoot = "",
    [switch]$Force,
    [switch]$AuditOnly,
    [switch]$SkipNpmInstall,
    [switch]$SkipCodexMcpRegistration,
    [switch]$SkipCodexUserIntegration,
    [string]$LogPath = "",
    [switch]$NotifyUser,
    [switch]$NoNotifyUser,
    [ValidateRange(15, 10080)]
    [int]$NotificationThrottleMinutes = 240,
    [switch]$AllowReplaceGitPackageTarget
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$updaterVersion = "0.1.0"
$script:RevitMcpTranscriptStarted = $false
$script:RevitMcpLogPath = ""
$script:PreviousTranscriptActive = $env:REVIT_MCP_TRANSCRIPT_ACTIVE
$script:PreviousLogPath = $env:REVIT_MCP_LOG_PATH

function Initialize-RevitMcpTranscript {
    param(
        [string]$PreferredWorkRoot,
        [string]$RequestedLogPath,
        [string]$Prefix
    )

    if ($env:REVIT_MCP_TRANSCRIPT_ACTIVE -eq "1") {
        $script:RevitMcpLogPath = $env:REVIT_MCP_LOG_PATH
        return
    }

    $path = $RequestedLogPath
    if ([string]::IsNullOrWhiteSpace($path)) {
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $logRoot = Join-Path $PreferredWorkRoot "logs"
        $path = Join-Path $logRoot ("{0}-{1}.log" -f $Prefix, $stamp)
    }

    try {
        $logDir = Split-Path -Parent $path
        if (-not [string]::IsNullOrWhiteSpace($logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }
    }
    catch {
        $path = Join-Path $env:TEMP ("revit-mcp-{0}-{1}.log" -f $Prefix, (Get-Date -Format "yyyyMMdd-HHmmss"))
    }

    try {
        Start-Transcript -Path $path -Append | Out-Null
        $script:RevitMcpTranscriptStarted = $true
        $script:RevitMcpLogPath = $path
        $env:REVIT_MCP_TRANSCRIPT_ACTIVE = "1"
        $env:REVIT_MCP_LOG_PATH = $path
        Write-Host "Update log      : $path" -ForegroundColor Green
    }
    catch {
        $script:RevitMcpLogPath = $path
        Write-Warning "Could not start update transcript: $($_.Exception.Message). Intended log path: $path"
    }
}

function Complete-RevitMcpTranscript {
    if ($script:RevitMcpTranscriptStarted) {
        try {
            Stop-Transcript | Out-Null
        }
        catch {}
    }

    if ($null -eq $script:PreviousTranscriptActive) {
        Remove-Item Env:\REVIT_MCP_TRANSCRIPT_ACTIVE -ErrorAction SilentlyContinue
    }
    else {
        $env:REVIT_MCP_TRANSCRIPT_ACTIVE = $script:PreviousTranscriptActive
    }

    if ($null -eq $script:PreviousLogPath) {
        Remove-Item Env:\REVIT_MCP_LOG_PATH -ErrorAction SilentlyContinue
    }
    else {
        $env:REVIT_MCP_LOG_PATH = $script:PreviousLogPath
    }
}

function Import-UpdaterConfig {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Config file was not found: $Path"
    }

    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Resolve-ReleasePath {
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

function Resolve-PackageLayout {
    param(
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

function Expand-ReleaseArchive {
    param(
        [string]$ZipPath,
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

function Assert-ManagedDirectoryTarget {
    param(
        [string]$Path,
        [string[]]$ExpectedLeafNames
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
    $leaf = Split-Path -Leaf $fullPath
    $leafOk = $false
    foreach ($expectedLeaf in $ExpectedLeafNames) {
        if ([string]::Equals($leaf, $expectedLeaf, [System.StringComparison]::OrdinalIgnoreCase)) {
            $leafOk = $true
            break
        }
    }
    if (-not $leafOk) {
        throw "Refusing to replace managed package target because the leaf folder is not one of '$($ExpectedLeafNames -join ", ")': $fullPath"
    }

    $blocked = @(
        [System.IO.Path]::GetPathRoot($fullPath).TrimEnd("\"),
        [System.IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd("\"),
        [System.IO.Path]::GetFullPath($env:APPDATA).TrimEnd("\"),
        [System.IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd("\")
    )

    foreach ($candidate in $blocked) {
        if ([string]::Equals($fullPath, $candidate, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to replace broad directory target: $fullPath"
        }
    }

    return $fullPath
}

function Resolve-RequiredCommand {
    param(
        [string]$Name,
        [string[]]$Candidates = @()
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    foreach ($candidate in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
        if (Test-Path -LiteralPath $expanded -PathType Leaf) {
            return $expanded
        }
    }

    throw "Required command '$Name' was not found. Install it or add it to PATH, then run the updater again."
}

function Resolve-RevitInstallRoot {
    param(
        [string]$RequestedRoot,
        [string]$Version
    )

    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in @(
            $RequestedRoot,
            $env:REVIT_INSTALL_ROOT,
            (Join-Path ${env:ProgramFiles} "Autodesk\Revit $Version"),
            (Join-Path ${env:ProgramFiles} "Autodesk\Revit$Version"),
            (Join-Path ${env:ProgramFiles(x86)} "Autodesk\Revit $Version")
        )) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $candidates.Add($candidate)
        }
    }
    foreach ($registryRoot in @(
            "HKLM:\SOFTWARE\Autodesk\Revit\$Version",
            "HKLM:\SOFTWARE\Autodesk\Revit\Autodesk Revit $Version",
            "HKLM:\SOFTWARE\WOW6432Node\Autodesk\Revit\$Version",
            "HKLM:\SOFTWARE\WOW6432Node\Autodesk\Revit\Autodesk Revit $Version"
        )) {
        if (-not (Test-Path -LiteralPath $registryRoot)) { continue }
        try {
            $item = Get-ItemProperty -LiteralPath $registryRoot -ErrorAction Stop
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

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $full = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($candidate)).TrimEnd("\")
        if (-not $seen.Add($full)) { continue }
        if ((Test-Path -LiteralPath $full -PathType Container) -and
            (Test-Path -LiteralPath (Join-Path $full "Revit.exe")) -and
            (Test-Path -LiteralPath (Join-Path $full "RevitAPI.dll"))) {
            return $full
        }
    }

    throw "Revit $Version install directory could not be found. Checked: $($seen.ToArray() -join '; ')"
}

function Invoke-External {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory
    )

    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$FilePath failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

function Get-InstalledState {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    try {
        return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        Write-Warning "Installed state is not valid JSON and will be ignored: $Path"
        return $null
    }
}

function Write-JsonFile {
    param(
        [string]$Path,
        [object]$Value
    )

    $dir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Get-VersionLabel {
    param([string]$Version)

    if ([string]::IsNullOrWhiteSpace($Version)) {
        return "not installed"
    }

    return $Version
}

function Get-JsonPropertyValue {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object -or [string]::IsNullOrWhiteSpace($Name)) {
        return $null
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($property) {
        return $property.Value
    }

    return $null
}

function Get-ComponentByKey {
    param(
        [object]$Manifest,
        [string]$Key
    )

    $components = Get-JsonPropertyValue -Object $Manifest -Name "components"
    if ($null -eq $components) {
        return $null
    }

    return Get-JsonPropertyValue -Object $components -Name $Key
}

function Get-ComponentSha256 {
    param([object]$Component)

    $sha = Get-JsonPropertyValue -Object $Component -Name "sha256"
    if ($null -eq $sha) {
        return ""
    }

    return [string]$sha
}

function Get-ComponentPath {
    param([object]$Component)

    $path = Get-JsonPropertyValue -Object $Component -Name "path"
    if ($null -eq $path) {
        return ""
    }

    return [string]$path
}

function Get-RelativeFileSha256OrNull {
    param(
        [string]$Root,
        [string]$RelativePath
    )

    if ([string]::IsNullOrWhiteSpace($Root) -or [string]::IsNullOrWhiteSpace($RelativePath)) {
        return ""
    }

    $candidate = Join-Path $Root $RelativePath
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash
    }

    return ""
}

function Get-InstalledReleaseManifest {
    param(
        [object]$InstalledState,
        [string]$PackageTarget
    )

    if ($InstalledState) {
        $stateComponents = Get-JsonPropertyValue -Object $InstalledState -Name "components"
        if ($stateComponents) {
            return [pscustomobject][ordered]@{
                components = $stateComponents
                updatePolicy = Get-JsonPropertyValue -Object $InstalledState -Name "updatePolicy"
            }
        }

        $manifestPath = [string](Get-JsonPropertyValue -Object $InstalledState -Name "manifestPath")
        if (-not [string]::IsNullOrWhiteSpace($manifestPath) -and (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            try {
                return Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
            }
            catch {
                Write-Warning "Installed release manifest is not valid JSON and will be ignored: $manifestPath"
            }
        }
    }

    $localReleaseInfoPath = Join-Path $PackageTarget "release-info.json"
    if (Test-Path -LiteralPath $localReleaseInfoPath -PathType Leaf) {
        try {
            $localReleaseInfo = Get-Content -Raw -LiteralPath $localReleaseInfoPath | ConvertFrom-Json
            $localComponents = Get-JsonPropertyValue -Object $localReleaseInfo -Name "components"
            if ($localComponents) {
                return [pscustomobject][ordered]@{
                    components = $localComponents
                    updatePolicy = Get-JsonPropertyValue -Object $localReleaseInfo -Name "updatePolicy"
                }
            }
        }
        catch {}
    }

    return $null
}

function Get-InstalledComponentSha256 {
    param(
        [string]$Key,
        [object]$TargetComponent,
        [object]$InstalledManifest,
        [string]$PackageTarget
    )

    $installedComponent = Get-ComponentByKey -Manifest $InstalledManifest -Key $Key
    $installedSha = Get-ComponentSha256 -Component $installedComponent
    if (-not [string]::IsNullOrWhiteSpace($installedSha)) {
        return $installedSha
    }

    $relativePath = Get-ComponentPath -Component $TargetComponent
    $installedSha = Get-RelativeFileSha256OrNull -Root $PackageTarget -RelativePath $relativePath
    if (-not [string]::IsNullOrWhiteSpace($installedSha)) {
        return $installedSha
    }

    if ($relativePath.StartsWith("installer\", [System.StringComparison]::OrdinalIgnoreCase)) {
        $legacyRelativePath = "kurulum\" + $relativePath.Substring("installer\".Length)
        return Get-RelativeFileSha256OrNull -Root $PackageTarget -RelativePath $legacyRelativePath
    }

    if ($relativePath.StartsWith("kurulum\", [System.StringComparison]::OrdinalIgnoreCase)) {
        $canonicalRelativePath = "installer\" + $relativePath.Substring("kurulum\".Length)
        return Get-RelativeFileSha256OrNull -Root $PackageTarget -RelativePath $canonicalRelativePath
    }

    return ""
}

function Get-ActualRevitPayloadPathMapping {
    param(
        [string]$RelativePath,
        [string]$InstallRoot,
        [string]$RevitVersion
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        return [pscustomobject][ordered]@{
            isMapped = $false
            shouldCompare = $false
            paths = @()
        }
    }

    $normalizedPath = $RelativePath.Replace("/", "\")
    if ($normalizedPath.StartsWith("kurulum\", [System.StringComparison]::OrdinalIgnoreCase)) {
        $normalizedPath = "installer\" + $normalizedPath.Substring("kurulum\".Length)
    }

    if ([string]::Equals($normalizedPath, "installer\revit-plugin\mcp-servers-for-revit.addin", [System.StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject][ordered]@{
            isMapped = $true
            shouldCompare = $false
            paths = @()
        }
    }

    $paths = [System.Collections.Generic.List[string]]::new()
    $pluginPrefix = "installer\revit-plugin\revit_mcp_plugin\"
    if ($normalizedPath.StartsWith($pluginPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $suffix = $normalizedPath.Substring($pluginPrefix.Length)
        [void]$paths.Add((Join-Path $InstallRoot ("revit-plugin\revit_mcp_plugin\" + $suffix)))
        return [pscustomobject][ordered]@{
            isMapped = $true
            shouldCompare = $true
            paths = @($paths.ToArray())
        }
    }

    $commandPayloadPrefix = "installer\command-payload\"
    if ($normalizedPath.StartsWith($commandPayloadPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $suffix = $normalizedPath.Substring($commandPayloadPrefix.Length)
        $runtimePrefix = "runtime\$RevitVersion\"
        if ($suffix.StartsWith($runtimePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            $runtimeSuffix = $suffix.Substring($runtimePrefix.Length)
            [void]$paths.Add((Join-Path $InstallRoot ("commands\CommandSet\$RevitVersion\" + $runtimeSuffix)))
            [void]$paths.Add((Join-Path $InstallRoot ("revit-plugin\revit_mcp_plugin\Commands\RevitMCPCommandSet\$RevitVersion\" + $runtimeSuffix)))
        }
        else {
            [void]$paths.Add((Join-Path $InstallRoot ("commands\CommandSet\$RevitVersion\" + $suffix)))
            [void]$paths.Add((Join-Path $InstallRoot ("commands\CommandSet\" + $suffix)))
            [void]$paths.Add((Join-Path $InstallRoot ("revit-plugin\revit_mcp_plugin\Commands\RevitMCPCommandSet\$RevitVersion\" + $suffix)))
            [void]$paths.Add((Join-Path $InstallRoot ("revit-plugin\revit_mcp_plugin\Commands\RevitMCPCommandSet\" + $suffix)))
        }

        return [pscustomobject][ordered]@{
            isMapped = $true
            shouldCompare = $true
            paths = @($paths.ToArray())
        }
    }

    return [pscustomobject][ordered]@{
        isMapped = $false
        shouldCompare = $false
        paths = @()
    }
}

function Test-RevitPayloadComponentPath {
    param([string]$RelativePath)

    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        return $false
    }

    foreach ($prefix in @(
            "installer\revit-plugin\",
            "installer\command-payload\",
            "kurulum\revit-plugin\",
            "kurulum\command-payload\"
        )) {
        if ($RelativePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    return $false
}

function Get-RevitClosedRequiredKeys {
    param([object]$Manifest)

    $keys = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $policy = Get-JsonPropertyValue -Object $Manifest -Name "updatePolicy"
    $configuredKeys = Get-JsonPropertyValue -Object $policy -Name "revitClosedRequiredComponentKeys"
    foreach ($key in @($configuredKeys)) {
        if ([string]::IsNullOrWhiteSpace([string]$key)) { continue }
        if ($seen.Add([string]$key)) {
            [void]$keys.Add([string]$key)
        }
    }

    if ($keys.Count -eq 0) {
        $components = Get-JsonPropertyValue -Object $Manifest -Name "components"
        if ($components) {
            foreach ($property in $components.PSObject.Properties) {
                $componentPath = Get-ComponentPath -Component $property.Value
                if ((Test-RevitPayloadComponentPath -RelativePath $componentPath) -and $seen.Add($property.Name)) {
                    [void]$keys.Add($property.Name)
                }
            }
        }
    }

    foreach ($fallbackKey in @(
            "revitPlugin",
            "commandSet",
            "revitAddinManifest",
            "revitPluginNewtonsoft",
            "revitPluginSdk",
            "revitCommandRegistry",
            "revitCommandSet",
            "revitCommandSetConfig"
        )) {
        if ($seen.Add($fallbackKey)) {
            [void]$keys.Add($fallbackKey)
        }
    }

    return $keys.ToArray()
}

function Get-RevitPayloadChanges {
    param(
        [object]$TargetManifest,
        [object]$InstalledManifest,
        [string]$PackageTarget,
        [string]$InstallRoot,
        [string]$RevitVersion
    )

    $changes = [System.Collections.Generic.List[object]]::new()
    if ($null -eq $TargetManifest) {
        return $changes.ToArray()
    }

    foreach ($key in Get-RevitClosedRequiredKeys -Manifest $TargetManifest) {
        $targetComponent = Get-ComponentByKey -Manifest $TargetManifest -Key $key
        if ($null -eq $targetComponent) {
            continue
        }

        $targetSha = Get-ComponentSha256 -Component $targetComponent
        if ([string]::IsNullOrWhiteSpace($targetSha)) {
            continue
        }

        $componentPath = Get-ComponentPath -Component $targetComponent
        $actualMapping = Get-ActualRevitPayloadPathMapping -RelativePath $componentPath -InstallRoot $InstallRoot -RevitVersion $RevitVersion
        if ($actualMapping.isMapped) {
            if (-not $actualMapping.shouldCompare) {
                continue
            }

            $mismatchedPaths = [System.Collections.Generic.List[string]]::new()
            foreach ($actualPath in @($actualMapping.paths)) {
                $actualSha = ""
                if (Test-Path -LiteralPath $actualPath -PathType Leaf) {
                    $actualSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $actualPath).Hash
                }

                if (-not [string]::Equals($actualSha, $targetSha, [System.StringComparison]::OrdinalIgnoreCase)) {
                    [void]$mismatchedPaths.Add($actualPath)
                }
            }

            if ($mismatchedPaths.Count -eq 0) {
                continue
            }

            [void]$changes.Add([pscustomobject][ordered]@{
                    key = $key
                    path = $componentPath
                    oldSha = "actual mismatch: " + ($mismatchedPaths.ToArray() -join "; ")
                    newSha = $targetSha
                })
            continue
        }

        $installedSha = Get-InstalledComponentSha256 -Key $key -TargetComponent $targetComponent -InstalledManifest $InstalledManifest -PackageTarget $PackageTarget
        if ([string]::Equals($installedSha, $targetSha, [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
        }

        [void]$changes.Add([pscustomobject][ordered]@{
                key = $key
                path = $componentPath
                oldSha = $installedSha
                newSha = $targetSha
            })
    }

    return $changes.ToArray()
}

function Write-UpdateReport {
    param(
        [string]$Status,
        [string]$Message,
        [object]$Channel,
        [object]$InstalledState,
        [string]$PreviousVersion = "",
        [string]$InstalledVersion = "",
        [string]$LocalReportPath,
        [string]$RemoteReportsRoot
    )

    $targetReportVersion = if ($Channel) { [string]$Channel.version } else { $null }
    $previousReportVersion = if (-not [string]::IsNullOrWhiteSpace($PreviousVersion)) {
        $PreviousVersion
    }
    elseif ($InstalledState) {
        [string]$InstalledState.version
    }
    else {
        $null
    }
    $installedReportVersion = if (-not [string]::IsNullOrWhiteSpace($InstalledVersion)) {
        $InstalledVersion
    }
    elseif ($InstalledState) {
        [string]$InstalledState.version
    }
    else {
        $null
    }
    $transition = if ($targetReportVersion) {
        "{0} -> {1}" -f (Get-VersionLabel $previousReportVersion), $targetReportVersion
    }
    else {
        $null
    }

    $report = [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        updaterVersion = $updaterVersion
        status = $Status
        message = $Message
        computerName = $env:COMPUTERNAME
        userName = $env:USERNAME
        atUtc = (Get-Date).ToUniversalTime().ToString("o")
        channel = if ($Channel) { $Channel.channel } else { $null }
        previousVersion = $previousReportVersion
        targetVersion = $targetReportVersion
        installedVersion = $installedReportVersion
        versionTransition = $transition
        paths = [ordered]@{
            installRoot = $InstallRoot
            packageTarget = $PackageTarget
            serverTarget = $ServerTarget
            workRoot = $WorkRoot
            revitInstallRoot = $RevitInstallRoot
            channelManifestPath = $ChannelManifestPath
            logPath = $script:RevitMcpLogPath
        }
    }

    Write-JsonFile -Path $LocalReportPath -Value $report

    if (-not [string]::IsNullOrWhiteSpace($RemoteReportsRoot)) {
        try {
            New-Item -ItemType Directory -Path $RemoteReportsRoot -Force | Out-Null
            $safeUser = ($env:USERNAME -replace '[\\/:*?"<>|]', "_")
            $safeComputer = ($env:COMPUTERNAME -replace '[\\/:*?"<>|]', "_")
            $remotePath = Join-Path $RemoteReportsRoot ("{0}_{1}.json" -f $safeComputer, $safeUser)
            Write-JsonFile -Path $remotePath -Value $report
        }
        catch {
            Write-Warning "Could not write remote report: $($_.Exception.Message)"
        }
    }
}

function Get-NotificationState {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    try {
        return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Test-ShouldNotifyUser {
    param(
        [string]$StatePath,
        [string]$Key,
        [int]$ThrottleMinutes
    )

    if (-not $NotifyUser) {
        return $false
    }

    $state = Get-NotificationState -Path $StatePath
    if ($null -eq $state) {
        return $true
    }

    $lastKey = [string](Get-JsonPropertyValue -Object $state -Name "key")
    $lastAtUtc = [string](Get-JsonPropertyValue -Object $state -Name "lastAtUtc")
    if (-not [string]::Equals($lastKey, $Key, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    if ([string]::IsNullOrWhiteSpace($lastAtUtc)) {
        return $true
    }

    try {
        $lastAt = [datetime]::Parse($lastAtUtc).ToUniversalTime()
        return (((Get-Date).ToUniversalTime() - $lastAt).TotalMinutes -ge $ThrottleMinutes)
    }
    catch {
        return $true
    }
}

function Show-UserNotification {
    param(
        [string]$Title,
        [string]$Message,
        [string]$Key,
        [string]$Icon = "Information"
    )

    $statePath = Join-Path $WorkRoot "notification-state.json"
    if (-not (Test-ShouldNotifyUser -StatePath $statePath -Key $Key -ThrottleMinutes $NotificationThrottleMinutes)) {
        return
    }

    $state = [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        key = $Key
        title = $Title
        message = $Message
        lastAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }
    Write-JsonFile -Path $statePath -Value $state

    try {
        Add-Type -AssemblyName System.Windows.Forms
        $messageBoxIcon = [System.Windows.Forms.MessageBoxIcon]::Information
        if ([string]::Equals($Icon, "Warning", [System.StringComparison]::OrdinalIgnoreCase)) {
            $messageBoxIcon = [System.Windows.Forms.MessageBoxIcon]::Warning
        }
        elseif ([string]::Equals($Icon, "Error", [System.StringComparison]::OrdinalIgnoreCase)) {
            $messageBoxIcon = [System.Windows.Forms.MessageBoxIcon]::Error
        }

        [System.Windows.Forms.MessageBox]::Show(
            $Message,
            $Title,
            [System.Windows.Forms.MessageBoxButtons]::OK,
            $messageBoxIcon) | Out-Null
    }
    catch {
        Write-Warning "Could not show user notification: $($_.Exception.Message)"
    }
}

$config = Import-UpdaterConfig -Path $ConfigPath
if ($config) {
    if ([string]::IsNullOrWhiteSpace($ChannelManifestPath) -and $config.channelManifestPath) { $ChannelManifestPath = [string]$config.channelManifestPath }
    if ($config.installRoot) { $InstallRoot = [string]$config.installRoot }
    if ($config.workRoot) { $WorkRoot = [string]$config.workRoot }
    if ($config.packageTarget) { $PackageTarget = [string]$config.packageTarget }
    if ($config.serverTarget) { $ServerTarget = [string]$config.serverTarget }
    if ($config.workspaceAgentsTarget) { $WorkspaceAgentsTarget = [string]$config.workspaceAgentsTarget }
    if ($config.revitInstallRoot) { $RevitInstallRoot = [string]$config.revitInstallRoot }
    if ($config.revitVersion) { $RevitVersion = [string]$config.revitVersion }
    if ($config.legacyServerTargets) { $LegacyServerTargets = @($config.legacyServerTargets) }
    if ($config.reportsRoot) { $ReportsRoot = [string]$config.reportsRoot }
    if ($config.skipNpmInstall) { $SkipNpmInstall = $true }
    if ($config.skipCodexMcpRegistration) { $SkipCodexMcpRegistration = $true }
    if ($config.skipCodexUserIntegration) { $SkipCodexUserIntegration = $true }
    if ($config.notifyUser -and -not $NoNotifyUser) { $NotifyUser = $true }
    if ($config.notificationThrottleMinutes) { $NotificationThrottleMinutes = [int]$config.notificationThrottleMinutes }
    if ([string]::IsNullOrWhiteSpace($LogPath) -and $config.updateLogPath) { $LogPath = [string]$config.updateLogPath }
}

if ($NoNotifyUser) {
    $NotifyUser = $false
}

if ([string]::IsNullOrWhiteSpace($ChannelManifestPath)) {
    throw "ChannelManifestPath is required. Pass it directly or through -ConfigPath."
}

$programDataRoot = if ([string]::IsNullOrWhiteSpace($env:ProgramData)) { "C:\ProgramData" } else { $env:ProgramData }
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $programDataRoot "DPE\RevitMCP"
}
if ([string]::IsNullOrWhiteSpace($WorkRoot)) {
    $WorkRoot = Join-Path $InstallRoot "updater"
}
if ([string]::IsNullOrWhiteSpace($PackageTarget)) {
    $PackageTarget = Join-Path $InstallRoot "package"
}
if ([string]::IsNullOrWhiteSpace($ServerTarget)) {
    $ServerTarget = Join-Path $InstallRoot "runtime"
}

Initialize-RevitMcpTranscript -PreferredWorkRoot $WorkRoot -RequestedLogPath $LogPath -Prefix "update"

$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$WorkRoot = [System.IO.Path]::GetFullPath($WorkRoot)
$PackageTarget = Assert-ManagedDirectoryTarget -Path $PackageTarget -ExpectedLeafNames @("package", "revit-mcp-skill")
$ServerTarget = [System.IO.Path]::GetFullPath($ServerTarget)
$RevitInstallRoot = Resolve-RevitInstallRoot -RequestedRoot $RevitInstallRoot -Version $RevitVersion
$statePath = Join-Path $WorkRoot "installed.json"
$localReportPath = Join-Path $WorkRoot "last-update-report.json"
$cacheRoot = Join-Path $WorkRoot "cache"
$stagingRoot = Join-Path $WorkRoot "staging"
$backupRoot = Join-Path $WorkRoot "backups"
New-Item -ItemType Directory -Path $cacheRoot, $stagingRoot, $backupRoot -Force | Out-Null

$channelDir = Split-Path -Parent $ChannelManifestPath
if ([string]::IsNullOrWhiteSpace($ReportsRoot)) {
    $releaseRootGuess = Split-Path -Parent $channelDir
    $ReportsRoot = Join-Path $releaseRootGuess "reports"
}

$installedState = Get-InstalledState -Path $statePath
$channel = $null

try {
    if (-not (Test-Path -LiteralPath $ChannelManifestPath)) {
        throw "Channel manifest was not found: $ChannelManifestPath"
    }

    $channel = Get-Content -Raw -LiteralPath $ChannelManifestPath | ConvertFrom-Json
    if ($channel.app -ne "revit-mcp-skill") {
        throw "Channel manifest app is not revit-mcp-skill: $ChannelManifestPath"
    }
    if ([string]::IsNullOrWhiteSpace($channel.version)) {
        throw "Channel manifest does not contain a version: $ChannelManifestPath"
    }

    $targetVersion = [string]$channel.version
    $targetSha = [string]$channel.sha256
    $packagePath = Resolve-ReleasePath -Path ([string]$channel.packagePath) -BaseDirectory $channelDir
    $releaseManifest = $null
    $releaseManifestPath = Resolve-ReleasePath -Path ([string]$channel.manifestPath) -BaseDirectory $channelDir
    if (-not [string]::IsNullOrWhiteSpace($releaseManifestPath) -and (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf)) {
        $releaseManifest = Get-Content -Raw -LiteralPath $releaseManifestPath | ConvertFrom-Json
    }

    if ([string]::IsNullOrWhiteSpace($packagePath)) {
        throw "Channel manifest does not contain packagePath: $ChannelManifestPath"
    }
    if (-not (Test-Path -LiteralPath $packagePath)) {
        throw "Package was not found: $packagePath"
    }

    $installedVersion = if ($installedState) { [string]$installedState.version } else { "" }
    $installedSha = if ($installedState) { [string]$installedState.packageSha256 } else { "" }
    $installedVersionLabel = Get-VersionLabel $installedVersion

    Write-Host "Channel version  : $targetVersion"
    Write-Host "Installed version: $installedVersionLabel"
    Write-Host "Version change   : $installedVersionLabel -> $targetVersion"
    Write-Host "Package          : $packagePath"

    $installedManifest = Get-InstalledReleaseManifest -InstalledState $installedState -PackageTarget $PackageTarget
    $revitPayloadChanges = @(Get-RevitPayloadChanges -TargetManifest $releaseManifest -InstalledManifest $installedManifest -PackageTarget $PackageTarget -InstallRoot $InstallRoot -RevitVersion $RevitVersion)
    $releaseComponents = Get-JsonPropertyValue -Object $releaseManifest -Name "components"
    $requiresRevitClosed = ($null -eq $releaseManifest) -or ($null -eq $releaseComponents) -or ($revitPayloadChanges.Count -gt 0)
    $skipRevitPayloadInstall = $false
    $revitChangeLabels = @($revitPayloadChanges | ForEach-Object {
            if (-not [string]::IsNullOrWhiteSpace([string]$_.path)) {
                [string]$_.path
            }
            else {
                [string]$_.key
            }
        })
    $isPackageCurrent = ($installedVersion -eq $targetVersion -and $installedSha -eq $targetSha)

    if (-not $Force -and $isPackageCurrent -and -not $requiresRevitClosed) {
        $message = "Already up to date."
        Write-Host $message -ForegroundColor Green
        Write-UpdateReport -Status "current" -Message $message -Channel $channel -InstalledState $installedState -PreviousVersion $installedVersion -InstalledVersion $installedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
        return
    }
    elseif ($isPackageCurrent -and $revitPayloadChanges.Count -gt 0) {
        Write-Warning "Package version is current, but installed Revit add-in/command files do not match the package. A Revit payload repair is required."
    }

    if ($AuditOnly) {
        $message = if ($isPackageCurrent -and $revitPayloadChanges.Count -gt 0) {
            "Revit payload repair required for current version: $targetVersion"
        }
        else {
            "Update available: $installedVersionLabel -> $targetVersion"
        }
        Write-Host $message -ForegroundColor Yellow
        Write-UpdateReport -Status "update-available" -Message $message -Channel $channel -InstalledState $installedState -PreviousVersion $installedVersion -InstalledVersion $installedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
        Show-UserNotification -Title "Revit MCP update available" -Message $message -Key ("update-available|{0}" -f $targetVersion) -Icon "Information"
        return
    }

    if ($requiresRevitClosed) {
        Write-Host "Revit payload    : changed or unknown; Revit must be closed before applying this update." -ForegroundColor Yellow
        if ($revitChangeLabels.Count -gt 0) {
            Write-Host ("Changed Revit files: {0}" -f (($revitChangeLabels | Select-Object -First 8) -join "; "))
            if ($revitChangeLabels.Count -gt 8) {
                Write-Host ("Changed Revit files: +{0} more" -f ($revitChangeLabels.Count - 8))
            }
        }
    }
    else {
        Write-Host "Revit payload    : unchanged; Revit can stay open." -ForegroundColor Green
    }

    $runningRevit = Get-Process -Name "Revit" -ErrorAction SilentlyContinue
    if ($runningRevit -and $requiresRevitClosed) {
        $message = "Update requires Revit to be closed because Revit add-in/command files changed. Save and synchronize your model, close Revit, then run the updater again."
        if ($revitChangeLabels.Count -gt 0) {
            $message += " Changed files: " + (($revitChangeLabels | Select-Object -First 6) -join "; ")
            if ($revitChangeLabels.Count -gt 6) {
                $message += ("; +{0} more" -f ($revitChangeLabels.Count - 6))
            }
        }
        Write-Warning $message
        Write-UpdateReport -Status "deferred-revit-close-required" -Message $message -Channel $channel -InstalledState $installedState -PreviousVersion $installedVersion -InstalledVersion $installedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
        Show-UserNotification -Title "Revit MCP update requires Revit to close" -Message ($message + "`r`n`r`nLog: " + $script:RevitMcpLogPath) -Key ("deferred-revit-close-required|{0}" -f $targetVersion) -Icon "Warning"
        return
    }
    elseif ($runningRevit) {
        $skipRevitPayloadInstall = $true
        Write-Warning "Revit is running, but this update does not change Revit add-in/command files. Non-Revit files will be updated without touching the active Revit payload."
    }

    if ((Test-Path -LiteralPath (Join-Path $PackageTarget ".git")) -and -not $AllowReplaceGitPackageTarget) {
        throw "PackageTarget is a git working tree. Refusing to replace it without -AllowReplaceGitPackageTarget: $PackageTarget"
    }

    $cachedPackage = Join-Path $cacheRoot ("revit-mcp-skill-{0}.zip" -f $targetVersion)
    Copy-Item -LiteralPath $packagePath -Destination $cachedPackage -Force

    $actualSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $cachedPackage).Hash
    if (-not [string]::IsNullOrWhiteSpace($targetSha) -and $actualSha -ne $targetSha) {
        throw "Package hash mismatch. Expected $targetSha but got $actualSha"
    }

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $extractRoot = Join-Path $stagingRoot ("extract-" + $targetVersion + "-" + $stamp)
    Expand-ReleaseArchive -ZipPath $cachedPackage -DestinationPath $extractRoot

    $packageLayout = Resolve-PackageLayout -Root $extractRoot -ReleaseManifest $releaseManifest

    if (Test-Path -LiteralPath $PackageTarget) {
        $backupPath = Join-Path $backupRoot ("revit-mcp-skill.backup-" + $stamp)
        Move-Item -LiteralPath $PackageTarget -Destination $backupPath
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $PackageTarget) -Force | Out-Null
    Move-Item -LiteralPath $extractRoot -Destination $PackageTarget

    $installer = Join-Path $PackageTarget $packageLayout.installerRelativePath
    $docsServerPath = Join-Path $PackageTarget $packageLayout.docsServerRelativePath
    $installArgs = @{
        RevitVersion = $RevitVersion
        InstallRoot = $InstallRoot
        ServerTarget = $ServerTarget
        RevitInstallRoot = $RevitInstallRoot
    }
    if (-not [string]::IsNullOrWhiteSpace($WorkspaceAgentsTarget)) {
        $installArgs["WorkspaceAgentsTarget"] = $WorkspaceAgentsTarget
    }
    if ($LegacyServerTargets.Count -gt 0) {
        $installArgs["LegacyServerTargets"] = $LegacyServerTargets
    }
    if ($SkipCodexUserIntegration) {
        $installArgs["SkipCodexUserIntegration"] = $true
    }
    if ($skipRevitPayloadInstall) {
        $installArgs["SkipRevitPayloadInstall"] = $true
    }

    & $installer @installArgs

    if (-not $SkipNpmInstall) {
        $npmPath = Resolve-RequiredCommand -Name "npm.cmd" -Candidates @(
            (Join-Path ${env:ProgramFiles} "nodejs\npm.cmd"),
            (Join-Path ${env:ProgramFiles(x86)} "nodejs\npm.cmd")
        )
        $powershellPath = Resolve-RequiredCommand -Name "powershell" -Candidates @(
            (Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe")
        )

        Invoke-External -FilePath $npmPath -Arguments @("install", "--omit=dev") -WorkingDirectory $ServerTarget

        Invoke-External -FilePath $npmPath -Arguments @("install", "--omit=dev") -WorkingDirectory $docsServerPath

        $docsCachePath = Join-Path $InstallRoot ("state\revit-api-docs\cache\revit-api-docs-{0}.json" -f $RevitVersion)
        Invoke-External -FilePath $powershellPath -Arguments @(
            "-ExecutionPolicy", "Bypass",
            "-File", (Join-Path $docsServerPath "scripts\build-index.ps1"),
            "-RevitRoot", $RevitInstallRoot,
            "-OutputPath", $docsCachePath
        ) -WorkingDirectory $docsServerPath
    }

    if (-not $SkipCodexMcpRegistration) {
        $codexPath = Resolve-RequiredCommand -Name "codex.cmd" -Candidates @(
            (Join-Path $env:APPDATA "npm\codex.cmd")
        )
        $nodePath = Resolve-RequiredCommand -Name "node.exe" -Candidates @(
            (Join-Path ${env:ProgramFiles} "nodejs\node.exe"),
            (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
        )
        try {
            & $codexPath mcp remove revit-mcp 2>$null | Out-Null
        }
        catch {}
        try {
            & $codexPath mcp remove revit-api-docs 2>$null | Out-Null
        }
        catch {}

        Invoke-External -FilePath $codexPath -Arguments @("mcp", "add", "revit-mcp", "--", $nodePath, (Join-Path $ServerTarget "build\index.js")) -WorkingDirectory $WorkRoot
        Invoke-External -FilePath $codexPath -Arguments @("mcp", "add", "revit-api-docs", "--", $nodePath, (Join-Path $docsServerPath "build\index.js")) -WorkingDirectory $WorkRoot
    }

    $newState = [ordered]@{
        schemaVersion = 1
        app = "revit-mcp-skill"
        version = $targetVersion
        channel = $channel.channel
        installedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        packageSha256 = $actualSha
        packagePath = $packagePath
        manifestPath = $channel.manifestPath
        components = if ($releaseManifest) { $releaseManifest.components } else { $null }
        updatePolicy = if ($releaseManifest) { $releaseManifest.updatePolicy } else { $null }
        revitPayloadChanged = [bool]$requiresRevitClosed
        revitPayloadSkipped = [bool]$skipRevitPayloadInstall
        revitPayloadChangedComponents = @($revitPayloadChanges | ForEach-Object { [string]$_.key })
        updaterVersion = $updaterVersion
        skipCodexUserIntegration = [bool]$SkipCodexUserIntegration
        paths = [ordered]@{
            installRoot = $InstallRoot
            packageTarget = $PackageTarget
            serverTarget = $ServerTarget
            workRoot = $WorkRoot
            revitInstallRoot = $RevitInstallRoot
            channelManifestPath = $ChannelManifestPath
        }
    }
    $updateMessage = "Updated: $installedVersionLabel -> $targetVersion."
    Write-JsonFile -Path $statePath -Value $newState
    Write-UpdateReport -Status "updated" -Message $updateMessage -Channel $channel -InstalledState $newState -PreviousVersion $installedVersion -InstalledVersion $targetVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
    Write-Host $updateMessage -ForegroundColor Green
    Show-UserNotification -Title "Revit MCP updated" -Message ($updateMessage + "`r`n`r`nInstalled version: " + $targetVersion) -Key ("updated|{0}" -f $targetVersion) -Icon "Information"
}
catch {
    $message = $_.Exception.Message
    $failedVersion = if ($installedState) { [string]$installedState.version } else { "" }
    Write-UpdateReport -Status "failed" -Message $message -Channel $channel -InstalledState $installedState -PreviousVersion $failedVersion -InstalledVersion $failedVersion -LocalReportPath $localReportPath -RemoteReportsRoot $ReportsRoot
    Write-Host ""
    Write-Host "Revit MCP update failed: $message" -ForegroundColor Red
    if (-not [string]::IsNullOrWhiteSpace($script:RevitMcpLogPath)) {
        Write-Host "Update log: $script:RevitMcpLogPath" -ForegroundColor Yellow
    }
    throw
}
finally {
    Complete-RevitMcpTranscript
}
