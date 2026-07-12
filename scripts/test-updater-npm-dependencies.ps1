<#
.SYNOPSIS
    Verify updater npm cache/runtime compatibility behavior without installing.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [string]$RuntimePackageRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
if ([string]::IsNullOrWhiteSpace($RuntimePackageRoot)) {
    $RuntimePackageRoot = Join-Path $RepoRoot "installer\runtime-mcp-server"
}
$RuntimePackageRoot = [System.IO.Path]::GetFullPath($RuntimePackageRoot)

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Equal {
    param(
        $Actual,
        $Expected,
        [string]$Message
    )

    if (-not [object]::Equals($Actual, $Expected)) {
        throw "$Message Expected='$Expected' Actual='$Actual'"
    }
}

function Import-UpdaterFunction {
    param(
        [System.Management.Automation.Language.Ast]$Ast,
        [string]$Name
    )

    $definition = @($Ast.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                    [string]::Equals($node.Name, $Name, [System.StringComparison]::OrdinalIgnoreCase)
            }, $true)) | Select-Object -First 1
    if ($null -eq $definition) {
        throw "Updater function was not found for contract test: $Name"
    }

    $scriptScopedDefinition = [regex]::Replace(
        $definition.Extent.Text,
        '^function\s+[^\s{]+',
        ("function script:{0}" -f $Name),
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    Invoke-Expression $scriptScopedDefinition
}

$updaterPath = Join-Path $RepoRoot "installer\nas\update-from-nas.ps1"
$tokens = $null
$parseErrors = $null
$updaterAst = [System.Management.Automation.Language.Parser]::ParseFile($updaterPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
    throw "Updater PowerShell parse failed: $($parseErrors[0].Message)"
}

foreach ($functionName in @(
        "Assert-PathUnderRoot",
        "Resolve-OptionalCommand",
        "Get-NodeMajorVersion",
        "Get-RevAgentSha256Hex",
        "Get-NodeRuntimeIdentity",
        "Resolve-NpmCliScript",
        "Get-NpmCliRuntimeStatus",
        "Get-NodeRuntimeStatus",
        "Get-NpmDependencyFingerprint",
        "Get-NpmDependencyMarkerPath",
        "Get-NpmPackageCacheName",
        "Get-NpmDependencyCacheNodeModulesPath",
        "Test-NpmPackageDeclaresDependency",
        "Test-NpmNativeDependenciesLoad",
        "Assert-NpmNativeDependenciesLoad",
        "Test-NpmDependenciesCurrent",
        "Remove-NpmNodeModulesPath",
        "Remove-InvalidNpmDependencyCache",
        "New-NpmDependencyJunction",
        "Restore-NpmDependenciesFromCache",
        "Remove-StaleNpmDependencyJunction",
        "Write-NpmDependencyMarker",
        "Save-NpmDependenciesToCache",
        "Invoke-NpmWithLifecycleScripts",
        "Invoke-NpmInstallIfNeeded"
    )) {
    Import-UpdaterFunction -Ast $updaterAst -Name $functionName
}

$nodeCommand = Get-Command "node.exe" -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    $nodeCommand = Get-Command "node" -ErrorAction Stop
}
$nodePath = [string]$nodeCommand.Source
$runtimeNodeModules = Join-Path $RuntimePackageRoot "node_modules"
if (-not (Test-Path -LiteralPath (Join-Path $runtimeNodeModules "better-sqlite3") -PathType Container)) {
    throw "Runtime test package must have better-sqlite3 installed before updater dependency tests: $RuntimePackageRoot"
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-updater-npm-test-" + [Guid]::NewGuid().ToString("N"))
$previousNpmIgnoreScripts = [Environment]::GetEnvironmentVariable("npm_config_ignore_scripts", "Process")
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
    Write-Host "Test updater Node ABI/platform/architecture identity" -ForegroundColor Cyan
    $identity = Get-NodeRuntimeIdentity -NodePath $nodePath
    Assert-True ($null -ne $identity) "Actual Node runtime identity must be readable."
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$identity.nodeModuleVersion)) "Node module ABI must be present."
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$identity.platform)) "Node platform must be present."
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$identity.arch)) "Node architecture must be present."
    Assert-True ([string]$identity.runtimeKey -match '^modules-[^-]+-napi-[^-]+-[^-]+-[^-]+$') "Runtime cache key must encode modules ABI, N-API, platform, and architecture."

    $npmCommand = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
    if (-not $npmCommand) {
        $npmCommand = Get-Command "npm" -ErrorAction Stop
    }
    $npmPath = [string]$npmCommand.Source
    $npmCliStatus = Get-NpmCliRuntimeStatus -NodePath $nodePath -NpmPath $npmPath
    Assert-True ([bool]$npmCliStatus.ready) "Actual selected Node/npm pair must resolve and execute npm-cli.js --version."
    Assert-True (Test-Path -LiteralPath $npmCliStatus.npmCliPath -PathType Leaf) "Ready npm status must expose an existing npm-cli.js path."
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$npmCliStatus.npmVersion)) "Ready npm status must expose the npm version returned by the selected Node."
    $actualRuntimeStatus = Get-NodeRuntimeStatus
    Assert-True ([bool]$actualRuntimeStatus.ready) "Get-NodeRuntimeStatus must report the actual validated Node/npm pair ready."
    Assert-True (Test-Path -LiteralPath $actualRuntimeStatus.npmCliPath -PathType Leaf) "Ready Node runtime status must retain the resolved npm-cli.js path."

    $invalidPairRoot = Join-Path $tempRoot "invalid-node-npm-pair"
    $invalidNodePath = Join-Path $invalidPairRoot "node\node.exe"
    $invalidNpmPath = Join-Path $invalidPairRoot "npm\npm.cmd"
    New-Item -ItemType Directory -Path (Split-Path -Parent $invalidNodePath) -Force | Out-Null
    New-Item -ItemType Directory -Path (Split-Path -Parent $invalidNpmPath) -Force | Out-Null
    Set-Content -LiteralPath $invalidNodePath -Value "fixture" -Encoding ASCII
    Set-Content -LiteralPath $invalidNpmPath -Value "fixture" -Encoding ASCII
    $invalidNpmCliStatus = Get-NpmCliRuntimeStatus -NodePath $invalidNodePath -NpmPath $invalidNpmPath
    Assert-True (-not [bool]$invalidNpmCliStatus.ready) "An npm shim without a resolvable npm-cli.js must never be ready."

    $failingNpmRoot = Join-Path $tempRoot "failing-npm"
    $failingNpmPath = Join-Path $failingNpmRoot "npm.cmd"
    $failingNpmCliPath = Join-Path $failingNpmRoot "node_modules\npm\bin\npm-cli.js"
    New-Item -ItemType Directory -Path (Split-Path -Parent $failingNpmCliPath) -Force | Out-Null
    Set-Content -LiteralPath $failingNpmPath -Value "fixture" -Encoding ASCII
    Set-Content -LiteralPath $failingNpmCliPath -Value "process.exit(23);" -Encoding ASCII
    $failingNpmCliStatus = Get-NpmCliRuntimeStatus -NodePath $nodePath -NpmPath $failingNpmPath
    Assert-True (-not [bool]$failingNpmCliStatus.ready) "An npm-cli.js that the selected Node cannot run successfully must never be ready."

    $plainPackage = Join-Path $tempRoot "plain-package"
    New-Item -ItemType Directory -Path (Join-Path $plainPackage "node_modules") -Force | Out-Null
    '{"name":"plain-package","version":"1.0.0"}' | Set-Content -LiteralPath (Join-Path $plainPackage "package.json") -Encoding UTF8
    '{"name":"plain-package","lockfileVersion":3}' | Set-Content -LiteralPath (Join-Path $plainPackage "package-lock.json") -Encoding UTF8

    $fingerprint = Get-NpmDependencyFingerprint -WorkingDirectory $plainPackage -RuntimeIdentity $identity
    Assert-Equal ([string]$fingerprint.nodeModuleVersion) ([string]$identity.nodeModuleVersion) "Fingerprint must carry the actual Node module ABI."
    Assert-Equal ([string]$fingerprint.platform) ([string]$identity.platform) "Fingerprint must carry the actual Node platform."
    Assert-Equal ([string]$fingerprint.arch) ([string]$identity.arch) "Fingerprint must carry the actual Node architecture."
    Assert-True ([string]$fingerprint.cacheKey -match '^[a-f0-9]{64}$') "Cache partition must be one deterministic SHA-256 of manifest and runtime compatibility identity."

    $cacheRoot = Join-Path $tempRoot "cache"
    $cachePath = Get-NpmDependencyCacheNodeModulesPath -CacheRoot $cacheRoot -WorkingDirectory $plainPackage -Fingerprint $fingerprint
    Assert-True ($cachePath -like "*\$($fingerprint.cacheKey)\node_modules") "Cache path must use the shortened combined manifest/runtime compatibility key."

    $alternateAbi = [pscustomobject][ordered]@{
        nodePath = "C:\alternate\node.exe"
        nodeVersion = "v99.0.0"
        nodeModuleVersion = ([int]$identity.nodeModuleVersion + 1).ToString()
        napiVersion = [string]$identity.napiVersion
        platform = [string]$identity.platform
        arch = [string]$identity.arch
        runtimeKey = "modules-$([int]$identity.nodeModuleVersion + 1)-napi-$($identity.napiVersion)-$($identity.platform)-$($identity.arch)"
    }
    $alternateFingerprint = Get-NpmDependencyFingerprint -WorkingDirectory $plainPackage -RuntimeIdentity $alternateAbi
    $alternateCachePath = Get-NpmDependencyCacheNodeModulesPath -CacheRoot $cacheRoot -WorkingDirectory $plainPackage -Fingerprint $alternateFingerprint
    Assert-True (-not [string]::Equals($cachePath, $alternateCachePath, [System.StringComparison]::OrdinalIgnoreCase)) "Different Node ABIs must never share an npm dependency cache."

    $sameCompatibilityDifferentNode = [pscustomobject][ordered]@{
        nodePath = "C:\alternate\compatible-node.exe"
        nodeVersion = "v$($identity.nodeVersion)-alternate"
        nodeModuleVersion = [string]$identity.nodeModuleVersion
        napiVersion = [string]$identity.napiVersion
        platform = [string]$identity.platform
        arch = [string]$identity.arch
        runtimeKey = [string]$identity.runtimeKey
    }
    $sameCompatibilityFingerprint = Get-NpmDependencyFingerprint -WorkingDirectory $plainPackage -RuntimeIdentity $sameCompatibilityDifferentNode
    $sameCompatibilityCachePath = Get-NpmDependencyCacheNodeModulesPath -CacheRoot $cacheRoot -WorkingDirectory $plainPackage -Fingerprint $sameCompatibilityFingerprint
    Assert-Equal $sameCompatibilityCachePath $cachePath "Compatible Node paths/patch versions must share the ABI/platform/architecture cache partition."

    $alternateArch = [pscustomobject][ordered]@{
        nodePath = [string]$identity.nodePath
        nodeVersion = [string]$identity.nodeVersion
        nodeModuleVersion = [string]$identity.nodeModuleVersion
        napiVersion = [string]$identity.napiVersion
        platform = [string]$identity.platform
        arch = "contract-test-arch"
        runtimeKey = "modules-$($identity.nodeModuleVersion)-napi-$($identity.napiVersion)-$($identity.platform)-contract-test-arch"
    }
    $alternateArchFingerprint = Get-NpmDependencyFingerprint -WorkingDirectory $plainPackage -RuntimeIdentity $alternateArch
    $alternateArchCachePath = Get-NpmDependencyCacheNodeModulesPath -CacheRoot $cacheRoot -WorkingDirectory $plainPackage -Fingerprint $alternateArchFingerprint
    Assert-True (-not [string]::Equals($cachePath, $alternateArchCachePath, [System.StringComparison]::OrdinalIgnoreCase)) "Different architectures must never share an npm dependency cache."

    Write-Host "Test legacy MAX_PATH-safe production cache layout" -ForegroundColor Cyan
    $runtimeFingerprint = Get-NpmDependencyFingerprint -WorkingDirectory $RuntimePackageRoot -RuntimeIdentity $identity
    $productionCacheRoot = "C:\ProgramData\DPE\revAgent\dependencies\npm"
    $productionCachePath = Get-NpmDependencyCacheNodeModulesPath -CacheRoot $productionCacheRoot -WorkingDirectory $RuntimePackageRoot -Fingerprint $runtimeFingerprint
    $deepestRuntimeRelativePath = @(Get-ChildItem -LiteralPath $runtimeNodeModules -Recurse -File -Force |
            ForEach-Object { $_.FullName.Substring($runtimeNodeModules.Length).TrimStart("\") } |
            Sort-Object { $_.Length } -Descending) | Select-Object -First 1
    Assert-True (-not [string]::IsNullOrWhiteSpace($deepestRuntimeRelativePath)) "Runtime dependency fixture must expose a realistic deep file path."
    $productionDeepCachePath = Join-Path $productionCachePath $deepestRuntimeRelativePath
    $productionStagingParent = Split-Path -Parent (Split-Path -Parent $productionCachePath)
    $productionStagingPath = Join-Path (Join-Path $productionStagingParent ".stg-000000000000") (Join-Path "node_modules" $deepestRuntimeRelativePath)
    $runtimePackageName = Get-NpmPackageCacheName -WorkingDirectory $RuntimePackageRoot
    $legacyVerboseCachePath = Join-Path $productionCacheRoot (Join-Path $runtimePackageName (Join-Path ([string]$runtimeFingerprint.sha256) (Join-Path ([string]$runtimeFingerprint.runtimeKey) (Join-Path "node_modules" $deepestRuntimeRelativePath))))
    Assert-True ($legacyVerboseCachePath.Length -ge 260) "Deep-path fixture must reproduce the legacy verbose cache MAX_PATH regression."
    Assert-True ($productionDeepCachePath.Length -lt 260) "Production cache plus the real deepest dependency path must stay below legacy MAX_PATH. Actual=$($productionDeepCachePath.Length)"
    Assert-True ($productionStagingPath.Length -lt 260) "Production staging cache plus the real deepest dependency path must stay below legacy MAX_PATH. Actual=$($productionStagingPath.Length)"

    Write-Host "Test updater dependency marker compatibility" -ForegroundColor Cyan
    Write-NpmDependencyMarker -WorkingDirectory $plainPackage -Fingerprint $fingerprint
    Assert-True (Test-NpmDependenciesCurrent -WorkingDirectory $plainPackage -Fingerprint $fingerprint -NodePath $nodePath -Label "Plain fixture") "Schema-v2 marker with matching runtime identity must be current."
    $markerPath = Get-NpmDependencyMarkerPath -WorkingDirectory $plainPackage
    $marker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
    $marker.schemaVersion = 1
    $marker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $markerPath -Encoding UTF8
    Assert-True (-not (Test-NpmDependenciesCurrent -WorkingDirectory $plainPackage -Fingerprint $fingerprint -NodePath $nodePath -Label "Plain fixture")) "Legacy marker schema must fail closed."
    Write-NpmDependencyMarker -WorkingDirectory $plainPackage -Fingerprint $fingerprint
    $marker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
    $marker.nodeModuleVersion = "incompatible"
    $marker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $markerPath -Encoding UTF8
    Assert-True (-not (Test-NpmDependenciesCurrent -WorkingDirectory $plainPackage -Fingerprint $fingerprint -NodePath $nodePath -Label "Plain fixture")) "Mismatched ABI marker must fail closed."

    Write-Host "Test better-sqlite3 native load and cache rejection" -ForegroundColor Cyan
    Assert-True (Test-NpmNativeDependenciesLoad -WorkingDirectory $RuntimePackageRoot -NodePath $nodePath -Label "Runtime test package") "Installed better-sqlite3 must open an in-memory database under the selected Node."
    $codexNodePath = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\node.exe"
    if (Test-Path -LiteralPath $codexNodePath -PathType Leaf) {
        $codexIdentity = Get-NodeRuntimeIdentity -NodePath $codexNodePath
        if ($null -ne $codexIdentity -and $codexIdentity.nodeModuleVersion -ne $identity.nodeModuleVersion) {
            Assert-True (-not (Test-NpmNativeDependenciesLoad -WorkingDirectory $RuntimePackageRoot -NodePath $codexNodePath -Label "Wrong ABI fixture" -Quiet)) "A real alternate Node ABI must reject the installed better-sqlite3 binding."
        }
    }

    $nativeFixture = Join-Path $tempRoot "native-fixture"
    New-Item -ItemType Directory -Path $nativeFixture -Force | Out-Null
    '{"name":"native-fixture","version":"1.0.0","dependencies":{"better-sqlite3":"12.9.0"}}' | Set-Content -LiteralPath (Join-Path $nativeFixture "package.json") -Encoding UTF8
    '{"name":"native-fixture","lockfileVersion":3}' | Set-Content -LiteralPath (Join-Path $nativeFixture "package-lock.json") -Encoding UTF8
    $nativeFingerprint = Get-NpmDependencyFingerprint -WorkingDirectory $nativeFixture -RuntimeIdentity $identity
    $nativeCachePath = Get-NpmDependencyCacheNodeModulesPath -CacheRoot $cacheRoot -WorkingDirectory $nativeFixture -Fingerprint $nativeFingerprint
    New-Item -ItemType Directory -Path (Join-Path $nativeCachePath "better-sqlite3") -Force | Out-Null
    Assert-True (-not (Test-NpmNativeDependenciesLoad -WorkingDirectory $nativeFixture -NodePath $nodePath -NodeModulesPath $nativeCachePath -Label "Invalid cache" -Quiet)) "Missing better-sqlite3 binding must fail validation."
    Assert-True (-not (Restore-NpmDependenciesFromCache -WorkingDirectory $nativeFixture -Fingerprint $nativeFingerprint -CacheRoot $cacheRoot -NodePath $nodePath -Label "Invalid cache")) "Invalid native cache must not be restored."
    Assert-True (-not (Test-Path -LiteralPath (Split-Path -Parent $nativeCachePath))) "Invalid native cache entry must be removed before rebuild."

    New-Item -ItemType Directory -Path $nativeCachePath -Force | Out-Null
    foreach ($dependencyName in @("better-sqlite3", "bindings", "file-uri-to-path")) {
        $dependencySource = Join-Path $runtimeNodeModules $dependencyName
        if (-not (Test-Path -LiteralPath $dependencySource -PathType Container)) {
            throw "Runtime dependency fixture is missing: $dependencySource"
        }
        Copy-Item -LiteralPath $dependencySource -Destination $nativeCachePath -Recurse -Force
    }
    Assert-True (Restore-NpmDependenciesFromCache -WorkingDirectory $nativeFixture -Fingerprint $nativeFingerprint -CacheRoot $cacheRoot -NodePath $nodePath -Label "Valid cache") "Validated native cache must restore successfully."
    Assert-True (Test-NpmDependenciesCurrent -WorkingDirectory $nativeFixture -Fingerprint $nativeFingerprint -NodePath $nodePath -Label "Valid cache") "Restored native cache marker and binding must be current."
    Remove-NpmNodeModulesPath -WorkingDirectory $nativeFixture

    Write-Host "Test cache restore rollback after marker failure" -ForegroundColor Cyan
    function script:Write-NpmDependencyMarker {
        param(
            [string]$WorkingDirectory,
            [object]$Fingerprint
        )
        throw "mock marker failure"
    }
    $markerFailureObserved = $false
    try {
        Restore-NpmDependenciesFromCache -WorkingDirectory $nativeFixture -Fingerprint $nativeFingerprint -CacheRoot $cacheRoot -NodePath $nodePath -Label "Marker failure fixture" | Out-Null
    }
    catch {
        $markerFailureObserved = $true
    }
    Assert-True $markerFailureObserved "Marker write failure after junction creation must propagate."
    Assert-True ($null -eq (Get-Item -LiteralPath (Join-Path $nativeFixture "node_modules") -Force -ErrorAction SilentlyContinue)) "Marker write failure must remove the restored junction/target."
    Assert-True (-not (Test-Path -LiteralPath (Get-NpmDependencyMarkerPath -WorkingDirectory $nativeFixture) -PathType Leaf)) "Marker write failure must not leave a current marker."
    Assert-True (Test-Path -LiteralPath $nativeCachePath -PathType Container) "Marker write failure must preserve the already validated cache for retry."
    Import-UpdaterFunction -Ast $updaterAst -Name "Write-NpmDependencyMarker"

    Write-Host "Test partial junction cleanup before physical-copy fallback" -ForegroundColor Cyan
    function script:New-NpmDependencyJunction {
        param(
            [string]$Path,
            [string]$Target
        )
        New-Item -ItemType Junction -Path $Path -Target $Target -Force | Out-Null
        throw "mock failure after partial junction creation"
    }
    Assert-True (Restore-NpmDependenciesFromCache -WorkingDirectory $nativeFixture -Fingerprint $nativeFingerprint -CacheRoot $cacheRoot -NodePath $nodePath -Label "Partial junction fixture") "A partial junction must be removed before physical-copy fallback."
    $fallbackNodeModulesItem = Get-Item -LiteralPath (Join-Path $nativeFixture "node_modules") -Force
    Assert-True (($fallbackNodeModulesItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) "Physical-copy fallback must not leave node_modules as a junction."
    Assert-True (Test-NpmDependenciesCurrent -WorkingDirectory $nativeFixture -Fingerprint $nativeFingerprint -NodePath $nodePath -Label "Partial junction fixture") "Physical-copy fallback must validate before writing its marker."
    Remove-NpmNodeModulesPath -WorkingDirectory $nativeFixture
    Import-UpdaterFunction -Ast $updaterAst -Name "New-NpmDependencyJunction"

    Write-Host "Test dangling node_modules junction cleanup" -ForegroundColor Cyan
    foreach ($cleanupFunction in @("Remove-NpmNodeModulesPath", "Remove-StaleNpmDependencyJunction")) {
        $danglingFixture = Join-Path $tempRoot ("dangling-" + $cleanupFunction)
        $danglingTarget = Join-Path $tempRoot ("target-" + $cleanupFunction)
        New-Item -ItemType Directory -Path $danglingFixture -Force | Out-Null
        New-Item -ItemType Directory -Path $danglingTarget -Force | Out-Null
        New-Item -ItemType Junction -Path (Join-Path $danglingFixture "node_modules") -Target $danglingTarget -Force | Out-Null
        Remove-Item -LiteralPath $danglingTarget -Recurse -Force
        & $cleanupFunction -WorkingDirectory $danglingFixture
        Assert-True ($null -eq (Get-Item -LiteralPath (Join-Path $danglingFixture "node_modules") -Force -ErrorAction SilentlyContinue)) "$cleanupFunction must remove a dangling node_modules junction."
    }

    Write-Host "Test stale physical cache replacement" -ForegroundColor Cyan
    '{"name":"native-fixture","lockfileVersion":3,"packages":{"revision":2}}' | Set-Content -LiteralPath (Join-Path $nativeFixture "package-lock.json") -Encoding UTF8
    $saveFingerprint = Get-NpmDependencyFingerprint -WorkingDirectory $nativeFixture -RuntimeIdentity $identity
    $saveCachePath = Get-NpmDependencyCacheNodeModulesPath -CacheRoot $cacheRoot -WorkingDirectory $nativeFixture -Fingerprint $saveFingerprint
    New-Item -ItemType Directory -Path (Join-Path $saveCachePath "better-sqlite3") -Force | Out-Null
    $nativeFixtureNodeModules = Join-Path $nativeFixture "node_modules"
    New-Item -ItemType Directory -Path $nativeFixtureNodeModules -Force | Out-Null
    foreach ($dependencyName in @("better-sqlite3", "bindings", "file-uri-to-path")) {
        Copy-Item -LiteralPath (Join-Path $runtimeNodeModules $dependencyName) -Destination $nativeFixtureNodeModules -Recurse -Force
    }
    Save-NpmDependenciesToCache -WorkingDirectory $nativeFixture -Fingerprint $saveFingerprint -CacheRoot $cacheRoot -NodePath $nodePath -Label "Save fixture"
    Assert-True (Test-NpmNativeDependenciesLoad -WorkingDirectory $nativeFixture -NodePath $nodePath -NodeModulesPath $saveCachePath -Label "Saved cache") "Stale physical cache must be replaced with a loadable native dependency tree."
    Assert-True (Test-Path -LiteralPath (Join-Path $saveCachePath "better-sqlite3\build\Release\better_sqlite3.node") -PathType Leaf) "Saved cache must contain the validated better-sqlite3 native binding."

    Write-Host "Test incomplete cache entry replacement" -ForegroundColor Cyan
    foreach ($incompleteKind in @("missing", "file")) {
        $revision = if ($incompleteKind -eq "missing") { 3 } else { 4 }
        ('{{"name":"native-fixture","lockfileVersion":3,"packages":{{"revision":{0}}}}}' -f $revision) | Set-Content -LiteralPath (Join-Path $nativeFixture "package-lock.json") -Encoding UTF8
        $incompleteFingerprint = Get-NpmDependencyFingerprint -WorkingDirectory $nativeFixture -RuntimeIdentity $identity
        $incompleteCachePath = Get-NpmDependencyCacheNodeModulesPath -CacheRoot $cacheRoot -WorkingDirectory $nativeFixture -Fingerprint $incompleteFingerprint
        $incompleteEntryRoot = Split-Path -Parent $incompleteCachePath
        New-Item -ItemType Directory -Path $incompleteEntryRoot -Force | Out-Null
        if ($incompleteKind -eq "file") {
            Set-Content -LiteralPath $incompleteCachePath -Value "not-a-directory" -Encoding ASCII
        }
        else {
            Set-Content -LiteralPath (Join-Path $incompleteEntryRoot "partial.txt") -Value "partial" -Encoding ASCII
        }

        Save-NpmDependenciesToCache -WorkingDirectory $nativeFixture -Fingerprint $incompleteFingerprint -CacheRoot $cacheRoot -NodePath $nodePath -Label "Incomplete $incompleteKind fixture"
        Assert-True (Test-NpmNativeDependenciesLoad -WorkingDirectory $nativeFixture -NodePath $nodePath -NodeModulesPath $incompleteCachePath -Label "Replaced incomplete cache") "An incomplete cache entry must be replaced with a loadable native dependency tree."
        $nestedStaging = @(Get-ChildItem -LiteralPath $incompleteEntryRoot -Directory -Filter ".stg-*" -Recurse -ErrorAction SilentlyContinue)
        Assert-Equal 0 $nestedStaging.Count "An incomplete cache entry must not retain a nested staging directory."
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $incompleteEntryRoot "partial.txt"))) "An incomplete cache entry must not retain orphaned content."
    }

    Write-Host "Test npm lifecycle environment isolation and exact Node invocation" -ForegroundColor Cyan
    $fakeRuntimeRoot = Join-Path $tempRoot "fake-runtime"
    $fakeNpmRoot = Join-Path $tempRoot "fake-npm"
    $fakeNodePath = Join-Path $fakeRuntimeRoot "node.exe"
    $fakeNpmPath = Join-Path $fakeNpmRoot "npm.cmd"
    $fakeNpmCliPath = Join-Path $fakeNpmRoot "node_modules\npm\bin\npm-cli.js"
    New-Item -ItemType Directory -Path (Split-Path -Parent $fakeNpmCliPath) -Force | Out-Null
    New-Item -ItemType Directory -Path $fakeRuntimeRoot -Force | Out-Null
    Set-Content -LiteralPath $fakeNodePath -Value "fixture" -Encoding ASCII
    Set-Content -LiteralPath $fakeNpmPath -Value "fixture" -Encoding ASCII
    Set-Content -LiteralPath $fakeNpmCliPath -Value "fixture" -Encoding ASCII

    $script:MockInvokeExternalThrows = $false
    $script:MockObservedIgnoreScripts = $null
    $script:MockObservedFilePath = $null
    $script:MockObservedArguments = @()
    function Invoke-External {
        param(
            [string]$FilePath,
            [string[]]$Arguments,
            [string]$WorkingDirectory
        )

        $script:MockObservedIgnoreScripts = [Environment]::GetEnvironmentVariable("npm_config_ignore_scripts", "Process")
        $script:MockObservedFilePath = $FilePath
        $script:MockObservedArguments = @($Arguments)
        if ($script:MockInvokeExternalThrows) {
            throw "mock npm failure"
        }
    }

    $env:npm_config_ignore_scripts = "true"
    Invoke-NpmWithLifecycleScripts -NodePath $fakeNodePath -NpmCliPath $fakeNpmCliPath -Arguments @("install") -WorkingDirectory $tempRoot
    Assert-Equal $script:MockObservedIgnoreScripts "false" "Updater npm commands must force lifecycle scripts process-locally."
    Assert-Equal $script:MockObservedFilePath $fakeNodePath "Updater must launch npm CLI with the selected runtime Node."
    Assert-Equal $script:MockObservedArguments[0] $fakeNpmCliPath "Updater must invoke the resolved npm-cli.js through the selected runtime Node."
    Assert-Equal ([Environment]::GetEnvironmentVariable("npm_config_ignore_scripts", "Process")) "true" "Updater must restore a pre-existing ignore-scripts value after success."

    Remove-Item Env:\npm_config_ignore_scripts -ErrorAction SilentlyContinue
    $script:MockInvokeExternalThrows = $true
    $mockFailureObserved = $false
    try {
        Invoke-NpmWithLifecycleScripts -NodePath $fakeNodePath -NpmCliPath $fakeNpmCliPath -Arguments @("rebuild", "better-sqlite3") -WorkingDirectory $tempRoot
    }
    catch {
        $mockFailureObserved = $true
    }
    Assert-True $mockFailureObserved "Mock npm failure must propagate."
    Assert-True ($null -eq [Environment]::GetEnvironmentVariable("npm_config_ignore_scripts", "Process")) "Updater must restore an absent ignore-scripts variable after failure."

    Write-Host "Test Invoke-NpmInstallIfNeeded current/ready path" -ForegroundColor Cyan
    Write-NpmDependencyMarker -WorkingDirectory $plainPackage -Fingerprint $fingerprint
    $script:MockLifecycleInvocationCount = 0
    function script:Invoke-NpmWithLifecycleScripts {
        param(
            [string]$NodePath,
            [string]$NpmCliPath,
            [string[]]$Arguments,
            [string]$WorkingDirectory
        )
        $script:MockLifecycleInvocationCount++
        throw "Current dependencies must not invoke npm."
    }
    Invoke-NpmInstallIfNeeded -NodePath $nodePath -NpmCliPath $npmCliStatus.npmCliPath -WorkingDirectory $plainPackage -Label "Current fixture" -CacheRoot $cacheRoot
    Assert-Equal $script:MockLifecycleInvocationCount 0 "Current marker/runtime identity must skip npm without re-resolving the Node/npm pair."
}
finally {
    if ($null -eq $previousNpmIgnoreScripts) {
        Remove-Item Env:\npm_config_ignore_scripts -ErrorAction SilentlyContinue
    }
    else {
        $env:npm_config_ignore_scripts = $previousNpmIgnoreScripts
    }
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

Write-Host "Updater npm dependency contract tests passed." -ForegroundColor Green
