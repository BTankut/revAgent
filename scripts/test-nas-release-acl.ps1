<#
.SYNOPSIS
    Test optional NAS ACL telemetry/administration with disposable fixtures.
#>

[CmdletBinding()]
param([string]$RepoRoot = "")

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$aclScript = Join-Path $RepoRoot "scripts\set-nas-release-acl.ps1"

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param([object]$Actual, [object]$Expected, [string]$Message)
    if (-not [object]::Equals($Actual, $Expected)) { throw "$Message Expected '$Expected', got '$Actual'." }
}

function Assert-ThrowsLike {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    $caught = $null
    try { & $Action } catch { $caught = $_ }
    if ($null -eq $caught) { throw "$Message Expected an exception." }
    if (-not ([string]$caught.Exception.Message -match $Pattern)) { throw "$Message Unexpected exception: $($caught.Exception.Message)" }
}

function Write-TestFile {
    param([string]$Path, [string]$Text)
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("revagent-release-acl-test-" + [Guid]::NewGuid().ToString("N"))
$releaseRoot = Join-Path $tempRoot "revAgent-deploy-fixture"
$publisher = [Security.Principal.WindowsIdentity]::GetCurrent().Name

try {
    Assert-ThrowsLike -Action {
        & $aclScript -ReleaseRoot (Join-Path $tempRoot "revAgent-deploy") -Mode Preview | Out-Null
    } -Pattern "exactly match the canonical production root" -Message "A same-leaf local or mistyped release root must not pass the production-root guard."
    Assert-ThrowsLike -Action {
        & $aclScript -ReleaseRoot (Join-Path $RepoRoot "not-a-temp-release-fixture") -Mode Preview -AllowTestRoot | Out-Null
    } -Pattern "limited to disposable local fixtures" -Message "AllowTestRoot must not bypass the canonical-root guard outside TEMP."
    foreach ($directory in @("tools", "channels", "releases\v1", "reports\machines\TEST")) {
        New-Item -ItemType Directory -Path (Join-Path $releaseRoot $directory) -Force | Out-Null
    }
    $toolFile = Join-Path $releaseRoot "tools\update.ps1"
    $channelFile = Join-Path $releaseRoot "channels\stable.json"
    $releaseFile = Join-Path $releaseRoot "releases\v1\package.zip"
    $reportFile = Join-Path $releaseRoot "reports\machines\TEST\latest.json"
    Write-TestFile $toolFile "tool-v1"
    Write-TestFile $channelFile "{}"
    Write-TestFile $releaseFile "package"
    Write-TestFile $reportFile "report-v1"
    $rootOwnerSid = [string](Get-Acl -LiteralPath $releaseRoot).GetOwner([Security.Principal.SecurityIdentifier]).Value

    Write-Host "Test preview and first seal"
    $initial = & $aclScript -ReleaseRoot $releaseRoot -Mode Preview -AllowTestRoot
    Assert-True (-not [bool]$initial.sealed) "Fresh publisher-owned fixture should begin unsealed."
    Assert-Equal ([string]$initial.transportTrust) "signed_local_snapshot" "ACL preview must identify the actual signed local snapshot transport boundary."
    Assert-True (-not [bool]$initial.requiredForTransportTrust -and [string]$initial.diagnosticRole -eq "optional_acl_telemetry") "ACL preview must remain optional transport telemetry."
    Assert-Equal ([string]$initial.publisherSid) $rootOwnerSid "Preview must default publisher identity to the release-root owner."
    Assert-Equal ([string]$initial.publisherPrincipalSource) "release_root_owner" "Preview must report owner-derived publisher selection."
    $sealed = & $aclScript -ReleaseRoot $releaseRoot -Mode Seal -AllowTestRoot
    Assert-True ([bool]$sealed.sealed -and [bool]$sealed.safe -and [bool]$sealed.allProtectedDaclsProtected) "Release fixture did not seal with protected DACLs."
    Assert-True ([bool]$sealed.publisherSessionProbe.publisherOnlyModify -and [bool]$sealed.publisherSessionProbe.cleaned) "Seal did not prove and clean the publisher-only session probe."
    Assert-Equal @($sealed.protectedWriteRules).Count 0 "Sealed release retained a write allow ACE."
    Assert-True ([bool]$sealed.reportsPreserved -and [bool]$sealed.reportsAclProtected -and [bool]$sealed.reportsWritableEvidence) "Reports ACL evidence must remain protected and writable."
    Assert-Equal ([IO.File]::ReadAllText($toolFile)) "tool-v1" "Sealed release should retain read access."
    $reportsAclAfterFirstSeal = (Get-Acl -LiteralPath (Join-Path $releaseRoot "reports")).Sddl

    Assert-ThrowsLike -Action {
        [IO.File]::WriteAllText($toolFile, "unauthorized", [Text.UTF8Encoding]::new($false))
    } -Pattern "denied|access|unauthorized|izin|reddedildi|WriteAllText" -Message "Sealed tools file must not be writable by the publisher."
    [IO.File]::WriteAllText($reportFile, "report-v2", [Text.UTF8Encoding]::new($false))
    Assert-Equal ([IO.File]::ReadAllText($reportFile)) "report-v2" "Reports subtree lost its evidence write access."

    Write-Host "Test bounded publisher unseal and reseal"
    Assert-ThrowsLike -Action {
        & $aclScript -ReleaseRoot $releaseRoot -Mode Unseal -AllowTestRoot | Out-Null
    } -Pattern "ConfirmPublisherWrite" -Message "Unseal must require explicit publish confirmation."
    Assert-ThrowsLike -Action {
        & $aclScript -ReleaseRoot $releaseRoot -Mode Unseal -AllowTestRoot -PublisherPrincipal "S-1-5-18" -ConfirmPublisherWrite | Out-Null
    } -Pattern "filesystem/SMB session did not map" -Message "Unseal must reject a publisher that the active filesystem session cannot exercise."
    Assert-Equal @(Get-ChildItem -LiteralPath (Join-Path $releaseRoot "reports") -Force -Filter ".publisher-session-probe-*").Count 0 "Failed publisher mapping probe left a reports artifact."
    $unsealed = & $aclScript -ReleaseRoot $releaseRoot -Mode Unseal -AllowTestRoot -ConfirmPublisherWrite
    Assert-True ([bool]$unsealed.unsealedForPublisherOnly -and [bool]$unsealed.allProtectedDaclsProtected) "Unseal did not constrain write ACEs to the publisher on protected DACLs."
    Assert-Equal ([string]$unsealed.publisherSid) $rootOwnerSid "Unseal must default to the release-root owner SID."
    Assert-True ([bool]$unsealed.publisherSessionProbe.publisherOnlyModify -and [bool]$unsealed.publisherSessionProbe.createDelete.created -and [bool]$unsealed.publisherSessionProbe.createDelete.deleted -and [bool]$unsealed.publisherSessionProbe.cleaned) "Unseal publisher session mapping evidence is incomplete."
    Assert-True ([bool]$unsealed.unsealWriteCanary.created -and [bool]$unsealed.unsealWriteCanary.deleted -and [bool]$unsealed.unsealWriteCanary.cleaned) "Unseal did not prove effective release-root write/delete access."
    Assert-Equal @($unsealed.protectedWriteRules | Where-Object { $_.sid -ne $unsealed.publisherSid }).Count 0 "Unseal retained a foreign writer."
    Assert-Equal @(Get-ChildItem -LiteralPath $releaseRoot -Force -Filter ".revagent-acl-canary-*").Count 0 "Unseal write/delete canary was not cleaned."
    [IO.File]::WriteAllText($toolFile, "tool-v2", [Text.UTF8Encoding]::new($false))
    $resealed = & $aclScript -ReleaseRoot $releaseRoot -Mode Seal -AllowTestRoot -PublisherPrincipal $publisher
    Assert-True ([bool]$resealed.sealed) "Release fixture did not reseal after publish."
    Assert-Equal (Get-Acl -LiteralPath (Join-Path $releaseRoot "reports")).Sddl $reportsAclAfterFirstSeal "Seal/unseal modified the protected reports ACL."

    Write-Host "Test reparse fixture fails before ACL recursion"
    [void](& $aclScript -ReleaseRoot $releaseRoot -Mode Unseal -AllowTestRoot -PublisherPrincipal $publisher -ConfirmPublisherWrite)
    $outsideDirectory = Join-Path $tempRoot "outside-directory"
    New-Item -ItemType Directory -Path $outsideDirectory -Force | Out-Null
    $outsideFile = Join-Path $outsideDirectory "outside.txt"
    Write-TestFile $outsideFile "outside"
    $outsideAcl = (Get-Acl -LiteralPath $outsideFile).Sddl
    $junction = Join-Path $releaseRoot "tools\unsafe-junction"
    New-Item -ItemType Junction -Path $junction -Target $outsideDirectory | Out-Null
    Assert-ThrowsLike -Action {
        & $aclScript -ReleaseRoot $releaseRoot -Mode Seal -AllowTestRoot -PublisherPrincipal $publisher | Out-Null
    } -Pattern "unsafe filesystem links.*reparse_or_link" -Message "Seal must reject a reparse fixture."
    Assert-Equal (Get-Acl -LiteralPath $outsideFile).Sddl $outsideAcl "Reparse rejection touched the external target ACL."
    [IO.Directory]::Delete($junction, $false)

    Write-Host "Test hardlink fixture fails before ACL recursion"
    $outsideHardlinkSource = Join-Path $tempRoot "outside-hardlink-source.txt"
    Write-TestFile $outsideHardlinkSource "outside-hardlink"
    $outsideHardlinkAcl = (Get-Acl -LiteralPath $outsideHardlinkSource).Sddl
    $hardlink = Join-Path $releaseRoot "tools\unsafe-hardlink.txt"
    New-Item -ItemType HardLink -Path $hardlink -Target $outsideHardlinkSource | Out-Null
    Assert-ThrowsLike -Action {
        & $aclScript -ReleaseRoot $releaseRoot -Mode Seal -AllowTestRoot -PublisherPrincipal $publisher | Out-Null
    } -Pattern "unsafe filesystem links.*hardlink" -Message "Seal must reject a hardlink fixture."
    Assert-Equal (Get-Acl -LiteralPath $outsideHardlinkSource).Sddl $outsideHardlinkAcl "Hardlink rejection touched the external target ACL."
    Remove-Item -LiteralPath $hardlink -Force
    $finalSeal = & $aclScript -ReleaseRoot $releaseRoot -Mode Seal -AllowTestRoot -PublisherPrincipal $publisher
    Assert-True ([bool]$finalSeal.sealed) "Fixture did not return to sealed state after link tests."

    Write-Host "Test signed publish wrapper keeps ACL inspection optional and non-mutating"
    $publishText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\publish-signed-source-free-release-to-nas.ps1")
    Assert-True ($publishText -match '\[switch\]\$IncludeAclTelemetry' -and $publishText -match 'not_requested_optional' -and $publishText -match 'set-nas-release-acl\.ps1' -and $publishText -match 'Mode\s+Preview' -and $publishText -match 'acl_diagnostic_unavailable') "Publish wrapper must retain opt-in ACL telemetry."
    Assert-True ($publishText -notmatch 'Mode\s+Unseal' -and $publishText -notmatch 'Mode\s+Seal' -and $publishText -notmatch 'ConfirmPublisherWrite') "Publish wrapper must not mutate Samba/SMB DACLs."
    Assert-True ($publishText -match 'transportTrust = "signed_local_snapshot"' -and $publishText -match 'releaseRootOwnerSid' -and $publishText -match 'createdDirectoryOwnerSid' -and $publishText -match 'createDeleteCanary') "Publish wrapper must report signed transport owner/session and create-delete canary evidence."
}
finally {
    if (Test-Path -LiteralPath $releaseRoot -PathType Container) {
        try { & $aclScript -ReleaseRoot $releaseRoot -Mode Unseal -AllowTestRoot -ConfirmPublisherWrite | Out-Null } catch {}
    }
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host "Optional NAS release ACL telemetry/administration tests passed." -ForegroundColor Green
