Set-StrictMode -Version Latest

$script:RevAgentLauncherCandidateExtensions = @(".cmd", ".bat", ".ps1", ".vbs", ".lnk", ".url")
$script:RevAgentLegacyLauncherPatterns = @(
    "Revit MCP Updater STABLE",
    "Install-Revit-MCP",
    "Update-Revit-MCP",
    "Show-Revit-MCP",
    "Run-Revit-MCP",
    "RevitMCP",
    "C:\ProgramData\DPE\RevitMCP",
    "revit-mcp-deploy"
)

function Test-RevAgentTextContainsAny {
    param(
        [string]$Text,
        [string[]]$Patterns
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $false
    }
    foreach ($pattern in $Patterns) {
        if ($Text.IndexOf($pattern, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }
    return $false
}

function Get-RevAgentDefaultDesktopLauncherRoots {
    param([string]$ProfilesRoot = "")

    $paths = [System.Collections.Generic.List[string]]::new()
    $profileRoots = [System.Collections.Generic.List[string]]::new()
    foreach ($folder in @("DesktopDirectory", "CommonDesktopDirectory")) {
        try {
            $specialFolder = [Enum]::Parse([Environment+SpecialFolder], $folder)
            $value = [Environment]::GetFolderPath($specialFolder)
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                [void]$paths.Add($value)
            }
        }
        catch {}
    }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        [void]$paths.Add((Join-Path $env:USERPROFILE "Desktop"))
        [void]$profileRoots.Add($env:USERPROFILE)
    }
    foreach ($oneDriveRoot in @($env:OneDrive, $env:OneDriveCommercial, $env:OneDriveConsumer)) {
        if (-not [string]::IsNullOrWhiteSpace($oneDriveRoot)) {
            [void]$paths.Add((Join-Path $oneDriveRoot "Desktop"))
        }
    }

    if ([string]::IsNullOrWhiteSpace($ProfilesRoot)) {
        if (-not [string]::IsNullOrWhiteSpace($env:SystemDrive)) {
            $ProfilesRoot = Join-Path $env:SystemDrive "Users"
        }
        else {
            $ProfilesRoot = "C:\Users"
        }
    }
    if (Test-Path -LiteralPath $ProfilesRoot -PathType Container) {
        foreach ($profile in @(Get-ChildItem -LiteralPath $ProfilesRoot -Directory -ErrorAction SilentlyContinue)) {
            [void]$profileRoots.Add($profile.FullName)
            $desktop = Join-Path $profile.FullName "Desktop"
            if (Test-Path -LiteralPath $desktop -PathType Container) {
                [void]$paths.Add($desktop)
            }
        }
    }

    foreach ($profileRoot in @($profileRoots.ToArray() | Select-Object -Unique)) {
        foreach ($oneDriveFolder in @(Get-ChildItem -LiteralPath $profileRoot -Directory -Filter "OneDrive*" -ErrorAction SilentlyContinue)) {
            $oneDriveDesktop = Join-Path $oneDriveFolder.FullName "Desktop"
            if (Test-Path -LiteralPath $oneDriveDesktop -PathType Container) {
                [void]$paths.Add($oneDriveDesktop)
            }
        }
    }
    return @($paths.ToArray() | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
}

function Get-RevAgentDesktopLauncherFiles {
    param([string[]]$LauncherRoots = @())

    if ($LauncherRoots.Count -eq 0) {
        $LauncherRoots = @(Get-RevAgentDefaultDesktopLauncherRoots)
    }

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $files = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
    foreach ($root in $LauncherRoots) {
        if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) {
            continue
        }
        foreach ($item in @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue)) {
            if ($script:RevAgentLauncherCandidateExtensions -contains $item.Extension.ToLowerInvariant() -and $seen.Add($item.FullName)) {
                [void]$files.Add($item)
            }
        }
    }
    return @($files.ToArray() | Sort-Object FullName)
}

function Read-RevAgentDesktopLauncherText {
    param([System.IO.FileInfo]$File)

    $parts = [System.Collections.Generic.List[string]]::new()
    [void]$parts.Add($File.Name)
    [void]$parts.Add($File.FullName)

    if ($File.Extension.ToLowerInvariant() -eq ".lnk") {
        try {
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut($File.FullName)
            foreach ($field in @($shortcut.TargetPath, $shortcut.Arguments, $shortcut.WorkingDirectory, $shortcut.Description, $shortcut.IconLocation)) {
                if (-not [string]::IsNullOrWhiteSpace([string]$field)) {
                    [void]$parts.Add([string]$field)
                }
            }
        }
        catch {
            [void]$parts.Add($_.Exception.Message)
        }
    }
    else {
        try {
            $text = Get-Content -Raw -LiteralPath $File.FullName -ErrorAction Stop
            if (-not [string]::IsNullOrWhiteSpace($text)) {
                [void]$parts.Add($text)
            }
        }
        catch {
            [void]$parts.Add($_.Exception.Message)
        }
    }

    return [string]::Join("`n", @($parts.ToArray()))
}

function Invoke-RevAgentLegacyDesktopLauncherCleanup {
    [CmdletBinding()]
    param(
        [string[]]$LauncherRoots = @(),
        [switch]$WhatIfOnly
    )

    $removed = [System.Collections.Generic.List[object]]::new()
    $failed = [System.Collections.Generic.List[object]]::new()
    $matched = [System.Collections.Generic.List[object]]::new()

    foreach ($file in @(Get-RevAgentDesktopLauncherFiles -LauncherRoots $LauncherRoots)) {
        $text = Read-RevAgentDesktopLauncherText -File $file
        if (-not (Test-RevAgentTextContainsAny -Text $text -Patterns $script:RevAgentLegacyLauncherPatterns)) {
            continue
        }

        $record = [pscustomobject][ordered]@{
            path = $file.FullName
            name = $file.Name
            extension = $file.Extension
        }
        [void]$matched.Add($record)

        if ($WhatIfOnly) {
            continue
        }

        try {
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop
            [void]$removed.Add($record)
        }
        catch {
            [void]$failed.Add([pscustomobject][ordered]@{
                path = $file.FullName
                name = $file.Name
                extension = $file.Extension
                error = $_.Exception.Message
            })
        }
    }

    return [pscustomobject][ordered]@{
        enabled = $true
        mode = if ($WhatIfOnly) { "whatIf" } else { "commit" }
        matchedCount = $matched.Count
        removedCount = $removed.Count
        failedCount = $failed.Count
        matched = @($matched.ToArray())
        removed = @($removed.ToArray())
        failed = @($failed.ToArray())
    }
}

Export-ModuleMember -Function Invoke-RevAgentLegacyDesktopLauncherCleanup, Get-RevAgentDefaultDesktopLauncherRoots
