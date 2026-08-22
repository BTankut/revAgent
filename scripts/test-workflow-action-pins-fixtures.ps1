[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
$scanner = Join-Path $root 'scripts\test-workflow-action-pins.ps1'
if (-not (Test-Path -LiteralPath $scanner -PathType Leaf)) {
    throw "Scanner is missing: $scanner"
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Invoke-ScannerFixture {
    param([string]$Name, [string]$Content, [bool]$ExpectedSuccess)

    $fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-action-pin-$Name-" + [Guid]::NewGuid().ToString('N'))
    try {
        $workflowDirectory = Join-Path $fixtureRoot '.github\workflows'
        New-Item -ItemType Directory -Path $workflowDirectory -ErrorAction Stop | Out-Null
        [System.IO.File]::WriteAllText(
            (Join-Path $workflowDirectory 'fixture.yml'),
            $Content,
            [System.Text.UTF8Encoding]::new($false))

        $succeeded = $true
        try {
            & $scanner -RepoRoot $fixtureRoot *>$null
        }
        catch {
            $succeeded = $false
        }
        Assert-True ($succeeded -eq $ExpectedSuccess) "Fixture $Name expected success=$ExpectedSuccess, actual=$succeeded."
    }
    finally {
        if (Test-Path -LiteralPath $fixtureRoot) {
            Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction Stop
        }
    }
}

$sha = 'd23441a48e516b6c34aea4fa41551a30e30af803'
$fixtures = @(
    [pscustomobject]@{ name = 'quoted-pinned'; success = $true; content = "jobs:`n  sample:`n    'uses': 'actions/checkout@$sha'`n" },
    [pscustomobject]@{ name = 'quoted-tag'; success = $false; content = "jobs:`n  sample:`n    `"uses`": actions/checkout@v6`n" },
    [pscustomobject]@{ name = 'flow-pinned'; success = $true; content = "job: { `"uses`": `"actions/checkout@$sha`", local: { 'uses': ./local-action } }`n" },
    [pscustomobject]@{ name = 'flow-tag'; success = $false; content = 'job: { uses: actions/checkout@v6 }' },
    [pscustomobject]@{ name = 'flow-dynamic'; success = $false; content = 'job: { uses: ${{ github.repository }}/action@main }' },
    [pscustomobject]@{ name = 'flow-docker'; success = $false; content = 'job: { uses: docker://alpine:3.20 }' },
    [pscustomobject]@{ name = 'flow-reusable'; success = $false; content = "job: { uses: owner/repo/.github/workflows/release.yml@$sha }" },
    [pscustomobject]@{ name = 'multiple-uses'; success = $true; content = "first: { uses: actions/checkout@$sha }`nsecond: { 'uses': ./local-action }`n" },
    [pscustomobject]@{ name = 'ambiguous'; success = $false; content = "uses: actions/checkout@$sha extra`n" },
    [pscustomobject]@{ name = 'multiline'; success = $false; content = "uses: >`n  actions/checkout@$sha`n" },
    [pscustomobject]@{ name = 'malformed-quoted-key'; success = $false; content = "'uses: actions/checkout@$sha`n" },
    [pscustomobject]@{ name = 'escaped-key-middle'; success = $false; content = "`"u\u0073es`": actions/checkout@$sha`n" },
    [pscustomobject]@{ name = 'escaped-key-prefix'; success = $false; content = "`"\u0075ses`": actions/checkout@$sha`n" },
    [pscustomobject]@{ name = 'escaped-key-hex'; success = $false; content = "`"\x75ses`": actions/checkout@$sha`n" },
    [pscustomobject]@{ name = 'escaped-key-unicode'; success = $false; content = "`"\U00000075ses`": actions/checkout@$sha`n" },
    [pscustomobject]@{ name = 'escaped-unrelated-key'; success = $false; content = "`"unrelated\u006bey`": value`n" },
    [pscustomobject]@{ name = 'explicit-block-uses-tag'; success = $false; content = "? uses`n: actions/checkout@v6`n" },
    [pscustomobject]@{ name = 'explicit-block-quoted-pinned'; success = $false; content = "? `"uses`"`n: actions/checkout@$sha`n" },
    [pscustomobject]@{ name = 'explicit-flow-dynamic'; success = $false; content = 'job: { ? uses : ${{ github.repository }}/action@main }' },
    [pscustomobject]@{ name = 'explicit-bare-then-plain-uses'; success = $false; content = "?`nuses: actions/checkout@$sha`n" },
    [pscustomobject]@{ name = 'explicit-comment-then-quoted-uses'; success = $false; content = "? # continued explicit key`n`"uses`": actions/checkout@$sha`n" },
    [pscustomobject]@{ name = 'anchor-scalar-and-alias-uses'; success = $false; content = "pin: &saved actions/checkout@$sha`nuses: *saved`n" },
    [pscustomobject]@{ name = 'anchor-mapping-and-merge'; success = $false; content = "defaults: &saved`n  uses: actions/checkout@$sha`njob:`n  <<: *saved`n" },
    [pscustomobject]@{ name = 'alias-key-flow'; success = $false; content = 'job: { *saved: value }' },
    [pscustomobject]@{ name = 'double-quoted-key-backslash-continuation'; success = $false; content = "`"u\`n0073es`": actions/checkout@$sha`n" },
    [pscustomobject]@{ name = 'single-quoted-key-multiline'; success = $false; content = "'u`nses': actions/checkout@$sha`n" },
    [pscustomobject]@{ name = 'comment'; success = $true; content = "uses: actions/checkout@$sha # reviewed comment`n" },
    [pscustomobject]@{ name = 'safe-quoted-value-and-comment'; success = $true; content = "uses: `"actions/checkout@$sha`" # reviewed comment`n" },
    [pscustomobject]@{ name = 'quoted-comment-content'; success = $false; content = "uses: `"actions/checkout@$sha # not a comment`"`n" },
    [pscustomobject]@{ name = 'uppercase'; success = $false; content = "uses: actions/checkout@$($sha.ToUpperInvariant())`n" },
    [pscustomobject]@{ name = 'anchor'; success = $false; content = "uses: &immutable actions/checkout@$sha`n" },
    [pscustomobject]@{ name = 'alias'; success = $false; content = 'uses: *immutable' }
)

foreach ($fixture in $fixtures) {
    Invoke-ScannerFixture -Name $fixture.name -Content $fixture.content -ExpectedSuccess $fixture.success
}

Write-Host "Workflow action pin scanner fixture tests passed: cases=$($fixtures.Count)."
