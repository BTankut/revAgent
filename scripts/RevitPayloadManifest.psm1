$script:RevitPayloadManifestRelativePath = "installer\revit-payload-manifest.json"
$script:RevitPayloadManifestSchemaVersion = 1

function ConvertTo-RevitPayloadGitPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return ($Path -replace "\\", "/").TrimStart("/")
}

function Join-RevitPayloadRepoPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    $separator = [string][System.IO.Path]::DirectorySeparatorChar
    $nativePath = $RelativePath.Replace("/", $separator).Replace("\", $separator)
    return Join-Path $RepoRoot $nativePath
}

function Invoke-RevitPayloadGit {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & git -C $RepoRoot @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        $message = ($output | Out-String).Trim()
        throw "git $($Arguments -join ' ') failed. $message"
    }

    return @($output | ForEach-Object { [string]$_ })
}

function Get-RevitPayloadManifestRelativePath {
    return $script:RevitPayloadManifestRelativePath
}

function Get-RevitPayloadSourceGroups {
    param(
        [string]$RevitVersion = "2022"
    )

    return @(
        [pscustomobject]@{
            Name = "revit-mcp-plugin"
            SourceRoot = "src/revit-plugin/revit-mcp-plugin"
            InputExtensions = @(".cs", ".csproj", ".xaml", ".resx")
            PayloadPaths = @(
                "installer/revit-plugin/revit_mcp_plugin/RevitMCPPlugin.dll"
            )
        },
        [pscustomobject]@{
            Name = "RevitMCPCommandSet"
            SourceRoot = "src/revit-plugin/RevitMCPCommandSet"
            InputExtensions = @(".cs", ".csproj", ".xaml", ".json", ".resx")
            PayloadPaths = @(
                "installer/command-payload/RevitMCPCommandSet.dll",
                "installer/revit-plugin/revit_mcp_plugin/Commands/RevitMCPCommandSet/$RevitVersion/RevitMCPCommandSet.dll"
            )
        }
    )
}

function Test-RevitPayloadSourcePathRelevant {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RelativePath,

        [Parameter(Mandatory = $true)]
        [string[]]$InputExtensions
    )

    $gitPath = ConvertTo-RevitPayloadGitPath -Path $RelativePath
    if ($gitPath -match '(^|/)(bin|obj)/') {
        return $false
    }

    $extension = [System.IO.Path]::GetExtension($gitPath).ToLowerInvariant()
    $extensions = @($InputExtensions | ForEach-Object { [string]$_ } | ForEach-Object { $_.ToLowerInvariant() })
    return $extensions -contains $extension
}

function Get-RevitPayloadSourceInputs {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [Parameter(Mandatory = $true)]
        [object]$Group
    )

    $sourceRootGit = ConvertTo-RevitPayloadGitPath -Path ([string]$Group.SourceRoot)
    $sourceRootPath = Join-RevitPayloadRepoPath -RepoRoot $RepoRoot -RelativePath $sourceRootGit
    if (-not (Test-Path -LiteralPath $sourceRootPath -PathType Container)) {
        throw "Revit payload source root was not found: $sourceRootGit"
    }

    $trackedFiles = @(Invoke-RevitPayloadGit -RepoRoot $RepoRoot -Arguments @("ls-files", "--", $sourceRootGit))
    $inputFiles = @($trackedFiles |
        Where-Object {
            Test-RevitPayloadSourcePathRelevant `
                -RelativePath $_ `
                -InputExtensions @($Group.InputExtensions)
        } |
        ForEach-Object { ConvertTo-RevitPayloadGitPath -Path $_ } |
        Sort-Object)

    if ($inputFiles.Count -eq 0) {
        throw "No Revit payload source inputs were found under: $sourceRootGit"
    }

    return $inputFiles
}

function Get-UntrackedRevitPayloadSourceInputs {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [Parameter(Mandatory = $true)]
        [object]$Group
    )

    $sourceRootGit = ConvertTo-RevitPayloadGitPath -Path ([string]$Group.SourceRoot)
    $statusLines = @(Invoke-RevitPayloadGit -RepoRoot $RepoRoot -Arguments @("status", "--porcelain", "--", $sourceRootGit))
    $untracked = @()
    foreach ($line in $statusLines) {
        if (-not $line.StartsWith("?? ")) {
            continue
        }

        $relativePath = ConvertTo-RevitPayloadGitPath -Path $line.Substring(3)
        if (Test-RevitPayloadSourcePathRelevant -RelativePath $relativePath -InputExtensions @($Group.InputExtensions)) {
            $untracked += $relativePath
        }
    }

    return @($untracked | Sort-Object)
}

function Assert-NoUntrackedRevitPayloadSourceInputs {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [string]$RevitVersion = "2022"
    )

    $allUntracked = @()
    foreach ($group in Get-RevitPayloadSourceGroups -RevitVersion $RevitVersion) {
        $allUntracked += @(Get-UntrackedRevitPayloadSourceInputs -RepoRoot $RepoRoot -Group $group)
    }

    if ($allUntracked.Count -gt 0) {
        throw "Untracked Revit payload source inputs are not covered by the manifest: $($allUntracked -join ', '). Add them to Git or remove them, then run scripts\build-revit-plugin.ps1."
    }
}

function Get-RevitPayloadGitBlobSha {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    $gitPath = ConvertTo-RevitPayloadGitPath -Path $RelativePath
    $fullPath = Join-RevitPayloadRepoPath -RepoRoot $RepoRoot -RelativePath $gitPath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Tracked Revit payload source input is missing from the working tree: $gitPath. Run scripts\build-revit-plugin.ps1 after resolving the source file set."
    }

    $hash = @(Invoke-RevitPayloadGit -RepoRoot $RepoRoot -Arguments @("hash-object", "--path=$gitPath", "--", $fullPath))
    if ($hash.Count -ne 1 -or [string]::IsNullOrWhiteSpace($hash[0])) {
        throw "Could not calculate Git blob SHA for Revit payload source input: $gitPath"
    }

    return $hash[0].Trim().ToLowerInvariant()
}

function Get-RevitPayloadFileFingerprint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    $gitPath = ConvertTo-RevitPayloadGitPath -Path $RelativePath
    $fullPath = Join-RevitPayloadRepoPath -RepoRoot $RepoRoot -RelativePath $gitPath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Revit payload file is missing: $gitPath. Run scripts\build-revit-plugin.ps1."
    }

    $item = Get-Item -LiteralPath $fullPath
    if ($item.Length -le 0) {
        throw "Revit payload file is empty: $gitPath. Run scripts\build-revit-plugin.ps1."
    }

    return [pscustomobject]@{
        path = $gitPath
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $fullPath).Hash.ToLowerInvariant()
        sizeBytes = [int64]$item.Length
    }
}

function New-RevitPayloadManifest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [string]$RevitVersion = "2022",

        [Parameter(Mandatory = $true)]
        [string]$Configuration
    )

    Assert-NoUntrackedRevitPayloadSourceInputs -RepoRoot $RepoRoot -RevitVersion $RevitVersion

    $sourceGroupRecords = @()
    foreach ($group in Get-RevitPayloadSourceGroups -RevitVersion $RevitVersion) {
        $inputPaths = @(Get-RevitPayloadSourceInputs -RepoRoot $RepoRoot -Group $group)
        $inputRecords = @($inputPaths | ForEach-Object {
                [ordered]@{
                    path = $_
                    gitBlobSha = Get-RevitPayloadGitBlobSha -RepoRoot $RepoRoot -RelativePath $_
                }
            })
        $payloadRecords = @($group.PayloadPaths | ForEach-Object {
                Get-RevitPayloadFileFingerprint -RepoRoot $RepoRoot -RelativePath $_
            })

        $sourceGroupRecords += [ordered]@{
            name = [string]$group.Name
            sourceRoot = ConvertTo-RevitPayloadGitPath -Path ([string]$group.SourceRoot)
            inputExtensions = @($group.InputExtensions)
            inputGlobs = @($group.InputExtensions | ForEach-Object { "*$_" })
            inputs = @($inputRecords)
            payloads = @($payloadRecords)
        }
    }

    return [ordered]@{
        schemaVersion = $script:RevitPayloadManifestSchemaVersion
        kind = "revit-payload-freshness"
        generatedBy = "scripts/build-revit-plugin.ps1"
        buildIdentity = [ordered]@{
            revitVersion = $RevitVersion
            configuration = $Configuration
        }
        sourceGroups = @($sourceGroupRecords)
    }
}

function Write-RevitPayloadManifest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [string]$RevitVersion = "2022",

        [Parameter(Mandatory = $true)]
        [string]$Configuration
    )

    $manifest = New-RevitPayloadManifest `
        -RepoRoot $RepoRoot `
        -RevitVersion $RevitVersion `
        -Configuration $Configuration
    $manifestPath = Join-RevitPayloadRepoPath -RepoRoot $RepoRoot -RelativePath $script:RevitPayloadManifestRelativePath
    $manifestDir = Split-Path -Parent $manifestPath
    if (-not (Test-Path -LiteralPath $manifestDir -PathType Container)) {
        New-Item -ItemType Directory -Path $manifestDir -Force | Out-Null
    }

    $manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    return $manifestPath
}

function Assert-RevitPayloadSetEqual {
    param(
        [string[]]$Actual,
        [string[]]$Expected,
        [string]$Description,
        [string]$RefreshMessage
    )

    $actualSorted = @($Actual | ForEach-Object { [string]$_ } | Sort-Object)
    $expectedSorted = @($Expected | ForEach-Object { [string]$_ } | Sort-Object)
    if (($actualSorted -join "|") -eq ($expectedSorted -join "|")) {
        return
    }

    $missing = @($expectedSorted | Where-Object { $actualSorted -notcontains $_ })
    $extra = @($actualSorted | Where-Object { $expectedSorted -notcontains $_ })
    $parts = @("$Description mismatch.")
    if ($missing.Count -gt 0) {
        $parts += "Missing: $($missing -join ', ')."
    }
    if ($extra.Count -gt 0) {
        $parts += "Extra: $($extra -join ', ')."
    }
    $parts += $RefreshMessage
    throw ($parts -join " ")
}

function Get-RevitPayloadManifestInputMap {
    param(
        [Parameter(Mandatory = $true)]
        [object]$ManifestGroup
    )

    $map = @{}
    foreach ($input in @($ManifestGroup.inputs)) {
        $path = ConvertTo-RevitPayloadGitPath -Path ([string]$input.path)
        if ([string]::IsNullOrWhiteSpace($path)) {
            throw "Revit payload manifest contains an input with an empty path."
        }
        $map[$path] = [string]$input.gitBlobSha
    }
    return $map
}

function Get-RevitPayloadManifestPayloadMap {
    param(
        [Parameter(Mandatory = $true)]
        [object]$ManifestGroup
    )

    $map = @{}
    foreach ($payload in @($ManifestGroup.payloads)) {
        $path = ConvertTo-RevitPayloadGitPath -Path ([string]$payload.path)
        if ([string]::IsNullOrWhiteSpace($path)) {
            throw "Revit payload manifest contains a payload with an empty path."
        }
        $map[$path] = $payload
    }
    return $map
}

function Assert-RevitPayloadManifestFresh {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $refreshMessage = "Run scripts\build-revit-plugin.ps1 and commit installer\revit-payload-manifest.json with the refreshed payload DLLs."
    $manifestPath = Join-RevitPayloadRepoPath -RepoRoot $RepoRoot -RelativePath $script:RevitPayloadManifestRelativePath
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Revit payload freshness manifest is missing: $script:RevitPayloadManifestRelativePath. $refreshMessage"
    }

    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ([int]$manifest.schemaVersion -ne $script:RevitPayloadManifestSchemaVersion) {
        throw "Unsupported Revit payload manifest schemaVersion '$($manifest.schemaVersion)'. $refreshMessage"
    }
    if ([string]$manifest.kind -ne "revit-payload-freshness") {
        throw "Unexpected Revit payload manifest kind '$($manifest.kind)'. $refreshMessage"
    }
    if ($null -eq $manifest.buildIdentity -or [string]::IsNullOrWhiteSpace([string]$manifest.buildIdentity.revitVersion) -or [string]::IsNullOrWhiteSpace([string]$manifest.buildIdentity.configuration)) {
        throw "Revit payload manifest is missing build identity. $refreshMessage"
    }

    $revitVersion = [string]$manifest.buildIdentity.revitVersion
    $expectedGroups = @(Get-RevitPayloadSourceGroups -RevitVersion $revitVersion)
    $manifestGroups = @($manifest.sourceGroups)
    $expectedGroupNames = @($expectedGroups | ForEach-Object { [string]$_.Name })
    $manifestGroupNames = @($manifestGroups | ForEach-Object { [string]$_.name })
    Assert-RevitPayloadSetEqual `
        -Actual $manifestGroupNames `
        -Expected $expectedGroupNames `
        -Description "Revit payload manifest group list" `
        -RefreshMessage $refreshMessage

    Assert-NoUntrackedRevitPayloadSourceInputs -RepoRoot $RepoRoot -RevitVersion $revitVersion

    foreach ($expectedGroup in $expectedGroups) {
        $matchingGroups = @($manifestGroups | Where-Object { [string]$_.name -eq [string]$expectedGroup.Name })
        if ($matchingGroups.Count -ne 1) {
            throw "Revit payload manifest must contain exactly one group named '$($expectedGroup.Name)'. $refreshMessage"
        }

        $manifestGroup = $matchingGroups[0]
        $expectedSourceRoot = ConvertTo-RevitPayloadGitPath -Path ([string]$expectedGroup.SourceRoot)
        $actualSourceRoot = ConvertTo-RevitPayloadGitPath -Path ([string]$manifestGroup.sourceRoot)
        if ($actualSourceRoot -ne $expectedSourceRoot) {
            throw "Revit payload manifest sourceRoot for '$($expectedGroup.Name)' is '$actualSourceRoot', expected '$expectedSourceRoot'. $refreshMessage"
        }

        $actualExtensions = @($manifestGroup.inputExtensions | ForEach-Object { ([string]$_).ToLowerInvariant() })
        $expectedExtensions = @($expectedGroup.InputExtensions | ForEach-Object { ([string]$_).ToLowerInvariant() })
        Assert-RevitPayloadSetEqual `
            -Actual $actualExtensions `
            -Expected $expectedExtensions `
            -Description "Revit payload manifest input extension list for '$($expectedGroup.Name)'" `
            -RefreshMessage $refreshMessage

        $actualPayloadPaths = @($manifestGroup.payloads | ForEach-Object { ConvertTo-RevitPayloadGitPath -Path ([string]$_.path) })
        $expectedPayloadPaths = @($expectedGroup.PayloadPaths | ForEach-Object { ConvertTo-RevitPayloadGitPath -Path $_ })
        Assert-RevitPayloadSetEqual `
            -Actual $actualPayloadPaths `
            -Expected $expectedPayloadPaths `
            -Description "Revit payload manifest payload list for '$($expectedGroup.Name)'" `
            -RefreshMessage $refreshMessage

        $currentInputs = @(Get-RevitPayloadSourceInputs -RepoRoot $RepoRoot -Group $expectedGroup)
        $manifestInputMap = Get-RevitPayloadManifestInputMap -ManifestGroup $manifestGroup
        $manifestInputPaths = @($manifestInputMap.Keys | Sort-Object)
        Assert-RevitPayloadSetEqual `
            -Actual $currentInputs `
            -Expected $manifestInputPaths `
            -Description "Revit payload source input list for '$($expectedGroup.Name)'" `
            -RefreshMessage $refreshMessage

        foreach ($inputPath in $currentInputs) {
            $expectedHash = [string]$manifestInputMap[$inputPath]
            $actualHash = Get-RevitPayloadGitBlobSha -RepoRoot $RepoRoot -RelativePath $inputPath
            if (-not [string]::Equals($actualHash, $expectedHash, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Revit payload source changed after manifest generation: $inputPath. $refreshMessage"
            }
        }

        $manifestPayloadMap = Get-RevitPayloadManifestPayloadMap -ManifestGroup $manifestGroup
        foreach ($payloadPath in $expectedPayloadPaths) {
            if (-not $manifestPayloadMap.ContainsKey($payloadPath)) {
                throw "Revit payload manifest is missing payload fingerprint: $payloadPath. $refreshMessage"
            }

            $actualFingerprint = Get-RevitPayloadFileFingerprint -RepoRoot $RepoRoot -RelativePath $payloadPath
            $expectedFingerprint = $manifestPayloadMap[$payloadPath]
            if ([int64]$expectedFingerprint.sizeBytes -ne [int64]$actualFingerprint.sizeBytes) {
                throw "Revit payload file size does not match manifest: $payloadPath. $refreshMessage"
            }
            if (-not [string]::Equals([string]$expectedFingerprint.sha256, [string]$actualFingerprint.sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Revit payload file hash does not match manifest: $payloadPath. $refreshMessage"
            }
        }
    }
}

Export-ModuleMember `
    -Function `
    Get-RevitPayloadManifestRelativePath, `
    Get-RevitPayloadSourceGroups, `
    Assert-NoUntrackedRevitPayloadSourceInputs, `
    New-RevitPayloadManifest, `
    Write-RevitPayloadManifest, `
    Assert-RevitPayloadManifestFresh
