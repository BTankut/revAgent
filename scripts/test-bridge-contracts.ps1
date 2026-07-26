<#
.SYNOPSIS
    Verify the WP3 Bridge contract boundary against the frozen M1 contracts.

.DESCRIPTION
    Builds the frozen protocol and add-in loopback fixture, validates the
    cross-runtime contract vectors, generates a fresh detached-signature oracle
    with Windows PowerShell 5.1, and runs the locked .NET contract build/tests.
    The generated signing key is ephemeral and all fresh oracle files stay in
    a script-owned temporary directory.
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

$solutionPath = Join-Path $RepoRoot "packages\bridge\RevAgent.Bridge.sln"
$validatorPath = Join-Path $RepoRoot "packages\bridge\tests\schema-compat\validate-contract-vectors.mjs"
$frameGeneratorPath = Join-Path $RepoRoot "packages\bridge\test-fixtures\generate-frame-fixtures.mjs"
$committedFrameDirectory = Join-Path $RepoRoot "packages\bridge\test-fixtures\framing"
$oracleGeneratorPath = Join-Path $RepoRoot "packages\bridge\test-fixtures\signing\generate-oracle-fixtures.ps1"
$windowsPowerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

foreach ($requiredPath in @(
    $solutionPath,
    $validatorPath,
    $frameGeneratorPath,
    $oracleGeneratorPath,
    $windowsPowerShellPath
)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required Bridge contract test dependency is missing: $requiredPath"
    }
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Description,

        [Parameter(Mandatory = $true)]
        [scriptblock]$Command
    )

    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$workDirectory = Join-Path $tempRoot ("revagent-bridge-contracts-" + [guid]::NewGuid().ToString("N"))
$workDirectory = [System.IO.Path]::GetFullPath($workDirectory)
$expectedPrefix = $tempRoot.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $workDirectory.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to create a Bridge contract work directory outside the system temp root."
}
[System.IO.Directory]::CreateDirectory($workDirectory) | Out-Null
$oracleDirectory = Join-Path $workDirectory "signature-oracle"
$previousOracleDirectory = $env:REVAGENT_SIGNATURE_ORACLE_FIXTURE_DIR

try {
    Push-Location $RepoRoot
    try {
        Invoke-CheckedCommand "Migration workspace dependency install" {
            npm ci --ignore-scripts
        }
        Invoke-CheckedCommand "Frozen protocol build" {
            npm run build:self --workspace @revagent/protocol
        }
        Invoke-CheckedCommand "Frozen add-in loopback fixture build" {
            npm run build:self --workspace @revagent/addin-loopback-fixture
        }
        $eslintPath = Join-Path $RepoRoot "node_modules\eslint\bin\eslint.js"
        if (-not (Test-Path -LiteralPath $eslintPath -PathType Leaf)) {
            throw "Workspace ESLint entry point is missing after npm ci: $eslintPath"
        }
        Invoke-CheckedCommand "Bridge JavaScript fixture lint" {
            node $eslintPath $frameGeneratorPath $validatorPath
        }
        Invoke-CheckedCommand "Generated protocol source cleanliness check" {
            git diff --exit-code -- packages/protocol/src/generated
        }
        Invoke-CheckedCommand "Cross-runtime Bridge contract-vector validation" {
            node $validatorPath
        }

        $freshFrameDirectory = Join-Path $workDirectory "framing-reference"
        Invoke-CheckedCommand "Executable Node/add-in reference frame capture" {
            node $frameGeneratorPath --output-directory $freshFrameDirectory
        }
        foreach ($fixtureName in @(
            "node-client-utf8-request.bin",
            "addin-success-response.bin",
            "coalesced-two-frames.bin"
        )) {
            $expectedFixturePath = Join-Path $committedFrameDirectory $fixtureName
            $actualFixturePath = Join-Path $freshFrameDirectory $fixtureName
            if (-not (Test-Path -LiteralPath $expectedFixturePath -PathType Leaf) -or
                -not (Test-Path -LiteralPath $actualFixturePath -PathType Leaf)) {
                throw "Bridge frame fixture is missing: $fixtureName"
            }
            $expectedHash = (Get-FileHash -LiteralPath $expectedFixturePath -Algorithm SHA256).Hash
            $actualHash = (Get-FileHash -LiteralPath $actualFixturePath -Algorithm SHA256).Hash
            if (-not [string]::Equals(
                    $expectedHash,
                    $actualHash,
                    [StringComparison]::Ordinal)) {
                throw "Bridge frame fixture differs from executable reference output: $fixtureName"
            }
        }

        Invoke-CheckedCommand "Windows PowerShell 5.1 signature-oracle generation" {
            & $windowsPowerShellPath `
                -NoLogo `
                -NoProfile `
                -NonInteractive `
                -ExecutionPolicy Bypass `
                -File $oracleGeneratorPath `
                -RepoRoot $RepoRoot `
                -OutputDirectory $oracleDirectory
        }

        $env:REVAGENT_SIGNATURE_ORACLE_FIXTURE_DIR = $oracleDirectory
        Invoke-CheckedCommand "Locked Bridge restore" {
            dotnet restore $solutionPath --locked-mode
        }
        Invoke-CheckedCommand "Bridge Release build" {
            dotnet build $solutionPath -c Release --no-restore
        }
        Invoke-CheckedCommand "Bridge contract tests" {
            dotnet test $solutionPath -c Release --no-build --no-restore
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    $env:REVAGENT_SIGNATURE_ORACLE_FIXTURE_DIR = $previousOracleDirectory
    $resolvedWorkDirectory = [System.IO.Path]::GetFullPath($workDirectory)
    if (-not $resolvedWorkDirectory.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a Bridge contract work directory outside the system temp root."
    }
    if (Test-Path -LiteralPath $resolvedWorkDirectory) {
        Remove-Item -LiteralPath $resolvedWorkDirectory -Recurse -Force
    }
}

Write-Host "Bridge contract gates passed." -ForegroundColor Green
