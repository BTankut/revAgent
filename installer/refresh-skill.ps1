<#
.SYNOPSIS
    Refresh the revAgent skill in every host where it is installed.

.DESCRIPTION
    Detects existing revAgent skill installations under known host
    locations (Codex Desktop, Claude Code), determines whether each one is a
    git clone, a symlink, or a plain copy, and updates it in place using
    the matching strategy:

      git clone  -> git fetch + ff-only pull
      symlink    -> reports the target; no copy needed
      copy       -> wipe, resync from -RepoRoot

    Run this after pulling the latest skill commit on disk so every host
    that has an old install gets refreshed without manual file juggling.

.PARAMETER RepoRoot
    Path to the local revAgent repository (the directory that
    contains SKILL.md). Defaults to the parent of this script's folder.

.PARAMETER ExtraPaths
    Additional skill install paths to check, e.g. project-level
    .claude/skills/revAgent directories.

.PARAMETER NoConfirm
    Skip per-target confirmation prompts. Use only in unattended runs.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\installer\refresh-skill.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\installer\refresh-skill.ps1 `
        -RepoRoot C:\src\revAgent `
        -ExtraPaths C:\Projects\my-revit\.claude\skills\revAgent `
        -NoConfirm
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string[]]$ExtraPaths = @(),
    [switch]$NoConfirm
)

$ErrorActionPreference = "Stop"

function Write-Section($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)      { Write-Host "[OK]   $msg"   -ForegroundColor Green }
function Write-Warn($msg)    { Write-Host "[WARN] $msg"   -ForegroundColor Yellow }
function Write-Err($msg)     { Write-Host "[FAIL] $msg"   -ForegroundColor Red }
function Write-Info($msg)    { Write-Host "       $msg"   -ForegroundColor Gray }

function Confirm-Action($msg) {
    if ($NoConfirm) { return $true }
    $r = Read-Host "$msg [y/N]"
    return $r -match '^[Yy]'
}

function Get-InstallKind($path) {
    if (-not (Test-Path -LiteralPath $path)) { return "missing" }
    $item = Get-Item -LiteralPath $path -Force
    if ($item.LinkType -in @("SymbolicLink", "Junction")) { return "symlink" }
    if (Test-Path -LiteralPath (Join-Path $path ".git"))  { return "git" }
    return "copy"
}

function Sync-Copy($source, $destination) {
    Get-ChildItem -LiteralPath $source -Force |
        Where-Object { $_.Name -ne ".git" } |
        ForEach-Object {
            Copy-Item -Recurse -Force -LiteralPath $_.FullName `
                -Destination (Join-Path $destination $_.Name)
        }
}

function Update-Target {
    param(
        [string]$HostName,
        [string]$Path,
        [string]$Source
    )

    Write-Section "$HostName -> $Path"
    $kind = Get-InstallKind $Path

    switch ($kind) {
        "missing" {
            Write-Warn "No installation found. Skipping."
            return [pscustomobject]@{
                Host = $HostName; Path = $Path; Kind = "-"; Action = "skipped"
            }
        }

        "symlink" {
            $target = (Get-Item -LiteralPath $Path -Force).Target
            Write-Ok  "Symlink detected."
            Write-Info "Target: $target"
            Write-Info "Nothing to copy. Make sure the target is up to date (e.g. git pull)."
            return [pscustomobject]@{
                Host = $HostName; Path = $Path; Kind = "symlink"; Action = "no-op"
            }
        }

        "git" {
            Write-Ok "Git working tree detected."
            if (-not (Confirm-Action "Run 'git fetch && git pull --ff-only' in $Path?")) {
                return [pscustomobject]@{
                    Host = $HostName; Path = $Path; Kind = "git"; Action = "skipped"
                }
            }
            Push-Location $Path
            try {
                git fetch origin
                if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
                git pull --ff-only
                if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only failed (non-fast-forward?)" }
                Write-Ok "Pulled latest."
                return [pscustomobject]@{
                    Host = $HostName; Path = $Path; Kind = "git"; Action = "pulled"
                }
            }
            catch {
                Write-Err $_
                return [pscustomobject]@{
                    Host = $HostName; Path = $Path; Kind = "git"; Action = "error"
                }
            }
            finally { Pop-Location }
        }

        "copy" {
            Write-Ok "Plain copy detected."
            if (-not (Confirm-Action "Wipe and resync $Path from $Source?")) {
                return [pscustomobject]@{
                    Host = $HostName; Path = $Path; Kind = "copy"; Action = "skipped"
                }
            }
            Remove-Item -Recurse -Force -LiteralPath $Path
            New-Item -ItemType Directory -Path $Path -Force | Out-Null
            Sync-Copy -Source $Source -Destination $Path
            Write-Ok "Resynced from $Source."
            return [pscustomobject]@{
                Host = $HostName; Path = $Path; Kind = "copy"; Action = "resynced"
            }
        }
    }
}

# 1. Validate source repo
Write-Section "Validating source repo at $RepoRoot"
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "SKILL.md"))) {
    Write-Err "SKILL.md not found at $RepoRoot."
    Write-Info "Pass -RepoRoot pointing to the cloned revAgent repository directory."
    exit 1
}
Write-Ok "Source repo looks valid."

# 2. Candidate install locations (user-level, Windows)
$candidates = @(
    @{ Host = "Codex Desktop";   Path = Join-Path $env:USERPROFILE ".codex\skills\revAgent" },
    @{ Host = "Claude Code"; Path = Join-Path $env:USERPROFILE ".claude\skills\revAgent" }
)
foreach ($extra in $ExtraPaths) {
    $candidates += @{ Host = "Custom"; Path = $extra }
}

# 3. Process each candidate
$results = @()
foreach ($c in $candidates) {
    $results += Update-Target -HostName $c.Host -Path $c.Path -Source $RepoRoot
}

# 4. Summary
Write-Section "Summary"
$results | Format-Table -AutoSize

Write-Host "`nNext steps:" -ForegroundColor Cyan
Write-Host "  - Codex Desktop: /skills reload"
Write-Host "  - Claude Code : start a new session"
Write-Host "  - Cursor      : restart Cursor"
