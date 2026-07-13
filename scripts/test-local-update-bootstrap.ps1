[CmdletBinding()]
param([string]$RepoRoot = "")

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

function Invoke-ExpectBootstrapFailure {
    param([string]$Pattern, [string]$Message)
    $caught = $null
    try {
        & (Join-Path $bootstrapRoot "Start-revAgent-Update.ps1") `
            -BootstrapRoot $bootstrapRoot `
            -ChannelManifestPath (Join-Path $fakeRelease "channels\stable.json") `
            -VerificationOnly `
            -AllowTestRoot | Out-Null
    }
    catch { $caught = $_ }
    Assert-True ($null -ne $caught -and [string]$caught.Exception.Message -match $Pattern) $Message
}

function Restore-TestAcl {
    param([string]$Path, [string]$Sddl, [switch]$Directory)
    $acl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetSecurityDescriptorSddlForm($Sddl, [Security.AccessControl.AccessControlSections]::Access)
    if ($Directory -and ("System.IO.FileSystemAclExtensions" -as [type])) {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo](Get-Item -LiteralPath $Path -Force), $acl)
    }
    elseif (-not $Directory -and ("System.IO.FileSystemAclExtensions" -as [type])) {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo](Get-Item -LiteralPath $Path -Force), $acl)
    }
    elseif ($Directory) { ([IO.DirectoryInfo](Get-Item -LiteralPath $Path -Force)).SetAccessControl($acl) }
    else { ([IO.FileInfo](Get-Item -LiteralPath $Path -Force)).SetAccessControl($acl) }
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ("revagent-local-bootstrap-test-" + [Guid]::NewGuid().ToString("N"))
$bootstrapRoot = Join-Path $temp "bootstrap"
$fakeRelease = Join-Path $temp "revAgent-deploy"
$expectedPath = Join-Path $temp "expected.json"
$junctionParent = Join-Path $temp "preplanted-parent"
$junctionTarget = Join-Path $temp "preplanted-target"
$evidenceJunction = Join-Path $temp "evidence-parent"
$evidenceTarget = Join-Path $temp "evidence-target"
$trustedKeys = "C:\ProgramData\DPE\revAgent\updater\config\release-trusted-keys.json"
if (-not (Test-Path -LiteralPath $trustedKeys -PathType Leaf)) { throw "Local public trusted-key fixture was not found: $trustedKeys" }
$sources = [ordered]@{
    bootstrap = Join-Path $RepoRoot "installer\nas\Start-revAgent-Update.ps1"
    launcher = Join-Path $RepoRoot "installer\nas\Start-revAgent-Update.cmd"
    updaterGui = Join-Path $RepoRoot "installer\nas\Install-revAgent-Updater-GUI.ps1"
    distributionIntegrity = Join-Path $RepoRoot "installer\lib\RevAgent.DistributionIntegrity.psm1"
    sourceFreeMigration = Join-Path $RepoRoot "installer\lib\RevAgent.SourceFreeMigration.psm1"
    releaseSnapshot = Join-Path $RepoRoot "installer\lib\RevAgent.ReleaseSnapshot.psm1"
    privilegedSnapshotUpdate = Join-Path $RepoRoot "installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1"
    trustedKeys = $trustedKeys
}
try {
    $runtimeSmoke = & (Join-Path $RepoRoot "installer\nas\Start-revAgent-Update.ps1") -RuntimePathSmokeTest
    Assert-True ([bool]$runtimeSmoke.success -and [IO.Path]::IsPathRooted([string]$runtimeSmoke.powershellPath) -and (Test-Path -LiteralPath $runtimeSmoke.powershellPath -PathType Leaf)) "Bootstrap runtime path smoke test failed."
    New-Item -ItemType Directory -Path (Join-Path $fakeRelease "channels") -Force | Out-Null
    $hashes = [ordered]@{}
    foreach ($entry in $sources.GetEnumerator()) { $hashes[$entry.Key] = (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.Value).Hash }
    $expected = [ordered]@{
        schemaVersion = 1
        app = "revAgent"
        evidenceType = "bootstrap-prestage"
        release = [ordered]@{
            root = $fakeRelease; channel = 'stable'; version = '2099.01.01.test'
            releaseSequence = 10; minimumAcceptedReleaseSequence = 1; highestAcceptedReleaseSequence = 10
            channelManifestSha256 = ('A' * 64); releaseManifestSha256 = ('B' * 64); packageSha256 = ('C' * 64)
            signatureVerified = $true
        }
        localBootstrapInstallerScript = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1")).Hash
        localBootstrapInstallerModule = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $RepoRoot "installer\lib\RevAgent.LocalBootstrap.psm1")).Hash
        sources = $hashes
    }
    [IO.File]::WriteAllText($expectedPath, ($expected | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    $state = & (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1") -RepoRoot $RepoRoot -ReleaseRoot $fakeRelease -TrustedKeysPath $trustedKeys -ExpectedHashesPath $expectedPath -BootstrapRoot $bootstrapRoot -ConfirmIndependentlyAuthenticatedSource -AllowTestRoot
    Assert-True ([bool]$state.sourceAuthentication.independentlyAuthenticated) "Prestage state lacks independent-authentication evidence."
    Assert-True (Test-Path -LiteralPath (Join-Path $bootstrapRoot "bootstrap-state.json")) "Protected bootstrap state was not installed."
    Assert-True ((Test-Path -LiteralPath (Join-Path $bootstrapRoot "Start-revAgent-Update.cmd") -PathType Leaf) -and $null -ne $state.files.launcher) "Protected local clickable launcher and its hash evidence were not installed."
    Assert-True ((Test-Path -LiteralPath (Join-Path $bootstrapRoot "Invoke-revAgent-PrivilegedSnapshotUpdate.ps1") -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $bootstrapRoot "lib\RevAgent.ReleaseSnapshot.psm1") -PathType Leaf)) "Protected snapshot broker/module were not installed."
    $caught = $null
    try { & (Join-Path $bootstrapRoot "Start-revAgent-Update.ps1") -BootstrapRoot $bootstrapRoot -ChannelManifestPath (Join-Path $fakeRelease "channels\stable.json") -VerificationOnly -AllowTestRoot | Out-Null } catch { $caught = $_ }
    Assert-True ($null -ne $caught -and [string]$caught.Exception.Message -match "Bootstrap path is missing") ("Bootstrap execution did not reach fail-closed signed-channel validation. actual={0}" -f $(if ($null -eq $caught) { '<none>' } else { [string]$caught.Exception.Message }))

    Write-Host "Test foreign bootstrap writer fails closed"
    $bootstrapScriptPath = Join-Path $bootstrapRoot "Start-revAgent-Update.ps1"
    $bootstrapScriptAcl = Get-Acl -LiteralPath $bootstrapScriptPath
    $bootstrapScriptSddl = $bootstrapScriptAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    try {
        [void]$bootstrapScriptAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new("S-1-5-32-546"),
                [Security.AccessControl.FileSystemRights]::WriteData,
                [Security.AccessControl.AccessControlType]::Allow))
        Restore-TestAcl -Path $bootstrapScriptPath -Sddl ($bootstrapScriptAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access))
        Invoke-ExpectBootstrapFailure -Pattern "write-capable access to an untrusted principal" -Message "A foreign standard-user/group writer on the local executable trust anchor was accepted."
    }
    finally { Restore-TestAcl -Path $bootstrapScriptPath -Sddl $bootstrapScriptSddl }

    Write-Host "Test unprotected bootstrap DACL fails closed"
    $bootstrapRootAcl = Get-Acl -LiteralPath $bootstrapRoot
    $bootstrapRootSddl = $bootstrapRootAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    try {
        $bootstrapRootAcl.SetAccessRuleProtection($false, $true)
        Restore-TestAcl -Path $bootstrapRoot -Sddl ($bootstrapRootAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)) -Directory
        Invoke-ExpectBootstrapFailure -Pattern "DACL must be protected from inheritance" -Message "An unprotected local bootstrap DACL was accepted."
    }
    finally { Restore-TestAcl -Path $bootstrapRoot -Sddl $bootstrapRootSddl -Directory }

    Write-Host "Test current and stale signed-component freshness bindings"
    $fakeTools = Join-Path $fakeRelease "tools"
    $fakeManifestRoot = Join-Path $fakeRelease "releases\current"
    New-Item -ItemType Directory -Path $fakeTools, $fakeManifestRoot -Force | Out-Null
    $surfaceFiles = [ordered]@{
        localBootstrap = @("installer\nas\Start-revAgent-Update.ps1", "Start-revAgent-Update.ps1")
        updaterGui = @("installer\nas\Install-revAgent-Updater-GUI.ps1", "Install-revAgent-Updater-GUI.ps1")
        updater = @("installer\nas\update-from-nas.ps1", "update-from-nas.ps1")
        updaterTaskInstaller = @("installer\nas\install-updater-task.ps1", "install-updater-task.ps1")
        installerLibDistributionIntegrity = @("installer\lib\RevAgent.DistributionIntegrity.psm1", "lib\RevAgent.DistributionIntegrity.psm1")
        installerLibSourceFreeMigration = @("installer\lib\RevAgent.SourceFreeMigration.psm1", "lib\RevAgent.SourceFreeMigration.psm1")
        installerLibReleaseSnapshot = @("installer\lib\RevAgent.ReleaseSnapshot.psm1", "lib\RevAgent.ReleaseSnapshot.psm1")
        privilegedSnapshotUpdate = @("installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1", "Invoke-revAgent-PrivilegedSnapshotUpdate.ps1")
        installerLibLocalBootstrap = @("installer\lib\RevAgent.LocalBootstrap.psm1", "lib\RevAgent.LocalBootstrap.psm1")
        installerLibHiddenLauncher = @("installer\lib\RevAgent.HiddenLauncher.psm1", "lib\RevAgent.HiddenLauncher.psm1")
        installerLibScheduledTask = @("installer\lib\RevAgent.ScheduledTask.psm1", "lib\RevAgent.ScheduledTask.psm1")
        installerLibVersions = @("installer\lib\RevAgent.RevitVersions.psm1", "lib\RevAgent.RevitVersions.psm1")
        installerLibPackage = @("installer\lib\RevAgent.Package.psm1", "lib\RevAgent.Package.psm1")
        installerLibUpdatePolicy = @("installer\lib\RevAgent.UpdatePolicy.psm1", "lib\RevAgent.UpdatePolicy.psm1")
        installerLibProxy = @("installer\lib\RevAgent.Proxy.psm1", "lib\RevAgent.Proxy.psm1")
        installerLibLogRetention = @("installer\lib\RevAgent.LogRetention.psm1", "lib\RevAgent.LogRetention.psm1")
        installerLibPermissions = @("installer\lib\RevAgent.Permissions.psm1", "lib\RevAgent.Permissions.psm1")
        installerLibSecureTemp = @("installer\lib\RevAgent.SecureTemp.psm1", "lib\RevAgent.SecureTemp.psm1")
        installerLibCodexRegistration = @("installer\lib\RevAgent.CodexRegistration.psm1", "lib\RevAgent.CodexRegistration.psm1")
        installerLibConfigSync = @("installer\lib\RevAgent.ConfigSync.psm1", "lib\RevAgent.ConfigSync.psm1")
        installerLibReporting = @("installer\lib\RevAgent.Reporting.psm1", "lib\RevAgent.Reporting.psm1")
        installerLibDesktopLauncherCleanup = @("installer\lib\RevAgent.DesktopLauncherCleanup.psm1", "lib\RevAgent.DesktopLauncherCleanup.psm1")
        installerLibLicense = @("installer\lib\RevAgent.License.psm1", "lib\RevAgent.License.psm1")
    }
    $components = [ordered]@{}
    foreach ($surface in $surfaceFiles.GetEnumerator()) {
        $sourcePath = Join-Path $RepoRoot ([string]$surface.Value[0])
        $destinationPath = Join-Path $fakeTools ([string]$surface.Value[1])
        New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
        $components[$surface.Key] = [ordered]@{ path = [string]$surface.Value[0]; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $destinationPath).Hash }
    }
    $components["localBootstrapLauncher"] = [ordered]@{ path = "installer\nas\Start-revAgent-Update.cmd"; sha256 = [string]$state.files.launcher.sha256 }
    $manifestPath = Join-Path $fakeManifestRoot "manifest.json"
    $channelPath = Join-Path $fakeRelease "channels\stable.json"
    [IO.File]::WriteAllText($manifestPath, ([ordered]@{ schemaVersion = 1; app = "revAgent"; components = $components } | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($channelPath, ([ordered]@{ schemaVersion = 1; app = "revAgent"; channel = "stable"; version = "current"; manifestPath = "..\releases\current\manifest.json" } | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))

    $currentCaught = $null
    try { & (Join-Path $bootstrapRoot "Start-revAgent-Update.ps1") -BootstrapRoot $bootstrapRoot -ChannelManifestPath $channelPath -VerificationOnly -AllowTestRoot | Out-Null } catch { $currentCaught = $_ }
    Assert-True ($null -ne $currentCaught -and [string]$currentCaught.Exception.Message -match "packagePath" -and [string]$currentCaught.Exception.Message -notmatch "bootstrap_refresh_required") "Current local bootstrap components did not pass freshness binding before signed package transport validation."

    $components.localBootstrapLauncher.sha256 = ("0" * 64)
    [IO.File]::WriteAllText($manifestPath, ([ordered]@{ schemaVersion = 1; app = "revAgent"; components = $components } | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $staleCaught = $null
    try { & (Join-Path $bootstrapRoot "Start-revAgent-Update.ps1") -BootstrapRoot $bootstrapRoot -ChannelManifestPath $channelPath -VerificationOnly -AllowTestRoot | Out-Null } catch { $staleCaught = $_ }
    Assert-True ($null -ne $staleCaught -and [string]$staleCaught.Exception.Message -match "bootstrap_refresh_required.*launcher") "A stale protected local launcher did not fail closed with bootstrap_refresh_required."

    New-Item -ItemType Directory -Path $junctionTarget -Force | Out-Null
    $junctionMarker = Join-Path $junctionTarget "must-remain-unchanged.txt"
    [IO.File]::WriteAllText($junctionMarker, "unchanged", [Text.UTF8Encoding]::new($false))
    $markerHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $junctionMarker).Hash
    $targetChildrenBefore = @((Get-ChildItem -LiteralPath $junctionTarget -Force | Select-Object -ExpandProperty Name) | Sort-Object)
    New-Item -ItemType Junction -Path $junctionParent -Target $junctionTarget | Out-Null
    $junctionCaught = $null
    try {
        & (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1") -RepoRoot $RepoRoot -ReleaseRoot $fakeRelease -TrustedKeysPath $trustedKeys -ExpectedHashesPath $expectedPath -BootstrapRoot (Join-Path $junctionParent "bootstrap") -ConfirmIndependentlyAuthenticatedSource -AllowTestRoot | Out-Null
    }
    catch { $junctionCaught = $_ }
    Assert-True ($null -ne $junctionCaught -and [string]$junctionCaught.Exception.Message -match "filesystem link") "Preplanted bootstrap parent junction was not rejected before destination writes."
    Assert-True ((Test-Path -LiteralPath $junctionMarker -PathType Leaf) -and (Get-FileHash -Algorithm SHA256 -LiteralPath $junctionMarker).Hash -eq $markerHashBefore) "Preplanted junction target marker changed during rejected bootstrap install."
    $targetChildrenAfter = @((Get-ChildItem -LiteralPath $junctionTarget -Force | Select-Object -ExpandProperty Name) | Sort-Object)
    Assert-True ([string]::Join("|", $targetChildrenAfter) -eq [string]::Join("|", $targetChildrenBefore)) "Rejected bootstrap install wrote files through the preplanted parent junction."
    [IO.Directory]::Delete($junctionParent)

    New-Item -ItemType Directory -Path $evidenceTarget -Force | Out-Null
    $linkedExpectedPath = Join-Path $evidenceTarget "expected.json"
    Copy-Item -LiteralPath $expectedPath -Destination $linkedExpectedPath
    $evidenceHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $linkedExpectedPath).Hash
    New-Item -ItemType Junction -Path $evidenceJunction -Target $evidenceTarget | Out-Null
    $evidenceBootstrapRoot = Join-Path $temp "evidence-junction-bootstrap"
    $evidenceCaught = $null
    try {
        & (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1") -RepoRoot $RepoRoot -ReleaseRoot $fakeRelease -TrustedKeysPath $trustedKeys -ExpectedHashesPath (Join-Path $evidenceJunction "expected.json") -BootstrapRoot $evidenceBootstrapRoot -ConfirmIndependentlyAuthenticatedSource -AllowTestRoot | Out-Null
    }
    catch { $evidenceCaught = $_ }
    Assert-True ($null -ne $evidenceCaught -and [string]$evidenceCaught.Exception.Message -match "filesystem link/reparse component") "Authenticated hash evidence reached through a parent junction was not rejected."
    Assert-True (-not (Test-Path -LiteralPath $evidenceBootstrapRoot)) "Evidence parent-junction rejection occurred after bootstrap destination writes."
    Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $linkedExpectedPath).Hash -eq $evidenceHashBefore) "Rejected evidence parent junction changed its target file."
    [IO.Directory]::Delete($evidenceJunction)

    $swapRepo = Join-Path $temp "swap-repo"
    foreach ($relativeDirectory in @("installer\lib", "installer\nas")) {
        New-Item -ItemType Directory -Path (Join-Path $swapRepo $relativeDirectory) -Force | Out-Null
    }
    foreach ($relativePath in @(
            "installer\lib\RevAgent.LocalBootstrap.psm1",
            "installer\lib\RevAgent.DistributionIntegrity.psm1",
            "installer\lib\RevAgent.SourceFreeMigration.psm1",
            "installer\lib\RevAgent.ReleaseSnapshot.psm1",
            "installer\nas\Start-revAgent-Update.ps1",
            "installer\nas\Start-revAgent-Update.cmd",
            "installer\nas\Install-revAgent-Updater-GUI.ps1",
            "installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1"
        )) {
        Copy-Item -LiteralPath (Join-Path $RepoRoot $relativePath) -Destination (Join-Path $swapRepo $relativePath)
    }
    $swapSources = [ordered]@{
        bootstrap = Join-Path $swapRepo "installer\nas\Start-revAgent-Update.ps1"
        launcher = Join-Path $swapRepo "installer\nas\Start-revAgent-Update.cmd"
        updaterGui = Join-Path $swapRepo "installer\nas\Install-revAgent-Updater-GUI.ps1"
        distributionIntegrity = Join-Path $swapRepo "installer\lib\RevAgent.DistributionIntegrity.psm1"
        sourceFreeMigration = Join-Path $swapRepo "installer\lib\RevAgent.SourceFreeMigration.psm1"
        releaseSnapshot = Join-Path $swapRepo "installer\lib\RevAgent.ReleaseSnapshot.psm1"
        privilegedSnapshotUpdate = Join-Path $swapRepo "installer\nas\Invoke-revAgent-PrivilegedSnapshotUpdate.ps1"
        trustedKeys = $trustedKeys
    }
    $swapHashes = [ordered]@{}
    foreach ($entry in $swapSources.GetEnumerator()) { $swapHashes[$entry.Key] = (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.Value).Hash }
    $swapModulePath = Join-Path $swapRepo "installer\lib\RevAgent.LocalBootstrap.psm1"
    $swapExpectedPath = Join-Path $temp "swap-expected.json"
    [IO.File]::WriteAllText($swapExpectedPath, ([ordered]@{
                schemaVersion = 1
                app = "revAgent"
                evidenceType = "bootstrap-prestage"
                release = [ordered]@{
                    root = $fakeRelease; channel = 'stable'; version = '2099.01.01.test'
                    releaseSequence = 10; minimumAcceptedReleaseSequence = 1; highestAcceptedReleaseSequence = 10
                    channelManifestSha256 = ('A' * 64); releaseManifestSha256 = ('B' * 64); packageSha256 = ('C' * 64)
                    signatureVerified = $true
                }
                localBootstrapInstallerScript = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1")).Hash
                localBootstrapInstallerModule = (Get-FileHash -Algorithm SHA256 -LiteralPath $swapModulePath).Hash
                sources = $swapHashes
            } | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    $swapBootstrapRoot = Join-Path $temp "swap-bootstrap"
    $swapCaught = $null
    $swapHook = { param($Path) [IO.File]::AppendAllText($Path, "`r`n# deterministic hash-to-import swap") }
    try {
        & (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1") -RepoRoot $swapRepo -ReleaseRoot $fakeRelease -TrustedKeysPath $trustedKeys -ExpectedHashesPath $swapExpectedPath -BootstrapRoot $swapBootstrapRoot -ConfirmIndependentlyAuthenticatedSource -AllowTestRoot -ModuleStageTestHook $swapHook | Out-Null
    }
    catch { $swapCaught = $_ }
    Assert-True ($null -ne $swapCaught -and [string]$swapCaught.Exception.Message -match "changed identity or content after verification") "Hash-to-import module source swap was not rejected after protected staging."
    Assert-True (-not (Test-Path -LiteralPath $swapBootstrapRoot)) "Hash-to-import rejection occurred after bootstrap installation."

    Write-Host "Test legacy developer product-root ACL migration"
    $aclFixtureRoot = Join-Path $temp "legacy-product-root-fixture"
    $aclFixtureShared = Join-Path $aclFixtureRoot "DPE"
    $aclFixtureProduct = Join-Path $aclFixtureShared "revAgent"
    $aclFixtureLinkTarget = Join-Path $aclFixtureRoot "junction-target"
    $aclFixtureLink = Join-Path $aclFixtureShared "linkedAgent"
    $aclFixtureSwap = Join-Path $aclFixtureShared "revAgent-swapped"
    New-Item -ItemType Directory -Path $aclFixtureProduct, $aclFixtureLinkTarget -Force | Out-Null
    New-Item -ItemType Junction -Path $aclFixtureLink -Target $aclFixtureLinkTarget | Out-Null
    $localBootstrapModule = Import-Module (Join-Path $RepoRoot "installer\lib\RevAgent.LocalBootstrap.psm1") -Force -PassThru
    try {
        $aclFixtureResult = & $localBootstrapModule {
            param($SharedPath, $ProductPath, $LinkName, $UntrustedOwnerSid, $SwapPath)

            $script:AclFixtureSharedPath = [IO.Path]::GetFullPath($SharedPath).TrimEnd('\')
            $script:AclFixtureProductPath = [IO.Path]::GetFullPath($ProductPath).TrimEnd('\')
            $script:AclFixtureProductOwner = 'S-1-5-32-544'
            $script:AclFixtureHardened = $false
            $script:AclFixtureHardenCallCount = 0
            $script:AclFixtureRenameBlocked = $false

            function New-AclFixtureRule {
                param([string]$Sid, [Security.AccessControl.FileSystemRights]$Rights)
                return [pscustomobject]@{
                    AccessControlType = [Security.AccessControl.AccessControlType]::Allow
                    IdentityReference = [Security.Principal.SecurityIdentifier]::new($Sid)
                    FileSystemRights = $Rights
                }
            }

            function New-AclFixtureDescriptor {
                param([string]$OwnerSid, [bool]$Protected, [object[]]$Rules)
                $descriptor = [pscustomobject]@{
                    AreAccessRulesProtected = $Protected
                    FixtureOwnerSid = $OwnerSid
                    FixtureRules = @($Rules)
                }
                $descriptor | Add-Member -MemberType ScriptMethod -Name GetOwner -Value {
                    param($TargetType)
                    return [Security.Principal.SecurityIdentifier]::new([string]$this.FixtureOwnerSid)
                }
                $descriptor | Add-Member -MemberType ScriptMethod -Name GetAccessRules -Value {
                    param($IncludeExplicit, $IncludeInherited, $TargetType)
                    return @($this.FixtureRules)
                }
                return $descriptor
            }

            function Get-Acl {
                [CmdletBinding()]
                param([Parameter(Mandatory = $true)][string]$LiteralPath)
                $canonical = [IO.Path]::GetFullPath($LiteralPath).TrimEnd('\')
                if ([string]::Equals($canonical, $script:AclFixtureSharedPath, [StringComparison]::OrdinalIgnoreCase)) {
                    # The shared DPE ancestor may allow create/write data, but it
                    # may not delegate delete, DACL, or ownership capability.
                    return New-AclFixtureDescriptor -OwnerSid 'S-1-5-32-544' -Protected $false -Rules @(
                        (New-AclFixtureRule -Sid 'S-1-5-32-545' -Rights ([Security.AccessControl.FileSystemRights]::Write))
                    )
                }
                if ([string]::Equals($canonical, $script:AclFixtureProductPath, [StringComparison]::OrdinalIgnoreCase)) {
                    if ($script:AclFixtureHardened) {
                        return New-AclFixtureDescriptor -OwnerSid 'S-1-5-32-544' -Protected $true -Rules @(
                            (New-AclFixtureRule -Sid 'S-1-5-32-545' -Rights ([Security.AccessControl.FileSystemRights]::ReadAndExecute))
                        )
                    }
                    return New-AclFixtureDescriptor -OwnerSid $script:AclFixtureProductOwner -Protected $false -Rules @(
                        (New-AclFixtureRule -Sid $UntrustedOwnerSid -Rights ([Security.AccessControl.FileSystemRights]::Modify))
                    )
                }
                Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath
            }

            function Set-RevAgentBootstrapDacl {
                param([Parameter(Mandatory = $true)][string]$Path, [switch]$SetAdministratorsOwner)
                $canonical = [IO.Path]::GetFullPath($Path).TrimEnd('\')
                if (-not [string]::Equals($canonical, $script:AclFixtureProductPath, [StringComparison]::OrdinalIgnoreCase) -or -not $SetAdministratorsOwner) {
                    throw "Fixture observed an unexpected ACL hardening target. path=$canonical"
                }
                $script:AclFixtureHardenCallCount++
                try {
                    Move-Item -LiteralPath $script:AclFixtureProductPath -Destination $SwapPath -ErrorAction Stop
                    Move-Item -LiteralPath $SwapPath -Destination $script:AclFixtureProductPath -ErrorAction Stop
                }
                catch { $script:AclFixtureRenameBlocked = $true }
                $script:AclFixtureHardened = $true
            }

            $identityGuard = Open-RevAgentBootstrapDirectoryGuard -Path $ProductPath
            try { $identityBefore = [string]$identityGuard.Identity }
            finally { $identityGuard.Handle.Dispose() }
            $successPath = Initialize-RevAgentProtectedProductRoot -SharedParent $SharedPath -Name 'revAgent'
            $identityGuard = Open-RevAgentBootstrapDirectoryGuard -Path $ProductPath
            try { $identityAfter = [string]$identityGuard.Identity }
            finally { $identityGuard.Handle.Dispose() }
            $successHardened = $script:AclFixtureHardened
            $successHardenCalls = $script:AclFixtureHardenCallCount

            $script:AclFixtureHardened = $false
            $script:AclFixtureProductOwner = $UntrustedOwnerSid
            $maliciousOwnerError = $null
            try { Initialize-RevAgentProtectedProductRoot -SharedParent $SharedPath -Name 'revAgent' | Out-Null }
            catch { $maliciousOwnerError = [string]$_.Exception.Message }
            $callsAfterMaliciousOwner = $script:AclFixtureHardenCallCount

            $linkError = $null
            try { Initialize-RevAgentProtectedProductRoot -SharedParent $SharedPath -Name $LinkName | Out-Null }
            catch { $linkError = [string]$_.Exception.Message }

            return [pscustomobject]@{
                successPath = $successPath
                successHardened = $successHardened
                successHardenCalls = $successHardenCalls
                renameBlocked = $script:AclFixtureRenameBlocked
                identityBefore = $identityBefore
                identityAfter = $identityAfter
                maliciousOwnerError = $maliciousOwnerError
                callsAfterMaliciousOwner = $callsAfterMaliciousOwner
                linkError = $linkError
            }
        } $aclFixtureShared $aclFixtureProduct 'linkedAgent' ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) $aclFixtureSwap
    }
    finally {
        Remove-Module $localBootstrapModule.Name -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $aclFixtureLink) { [IO.Directory]::Delete($aclFixtureLink) }
    }
    Assert-True ([bool]$aclFixtureResult.successHardened -and [int]$aclFixtureResult.successHardenCalls -eq 1 -and [string]::Equals([IO.Path]::GetFullPath([string]$aclFixtureResult.successPath), [IO.Path]::GetFullPath($aclFixtureProduct), [StringComparison]::OrdinalIgnoreCase)) "A trusted legacy developer product root with a user Modify/Delete ACE was not hardened in place."
    Assert-True ([bool]$aclFixtureResult.renameBlocked -and [string]::Equals([string]$aclFixtureResult.identityBefore, [string]$aclFixtureResult.identityAfter, [StringComparison]::Ordinal)) "Legacy product-root ACL migration did not hold a no-FILE_SHARE_DELETE handle with stable path identity."
    Assert-True ([string]$aclFixtureResult.maliciousOwnerError -match "untrusted owner" -and [int]$aclFixtureResult.callsAfterMaliciousOwner -eq 1) "A product root with an untrusted owner reached ACL mutation."
    Assert-True ([string]$aclFixtureResult.linkError -match "filesystem link") "A product-root junction was not rejected before ACL mutation."

    $prestageDocText = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "docs\BOOTSTRAP_PRESTAGE.md")
    $productHardenIndex = $prestageDocText.IndexOf('Set-ProtectedProductRootAcl $productPath', [StringComparison]::Ordinal)
    $prestageCreateIndex = $prestageDocText.IndexOf("New-ProtectedChild `$product 'prestage'", [StringComparison]::Ordinal)
    Assert-True ($prestageDocText -match 'exact existing product root \(or prestage child\) may carry the' -and $prestageDocText -match 'Never apply this migration to the shared DPE ancestor') "Manual prestage does not document the exact product-root/prestage legacy ACL migration boundary."
    Assert-True ($productHardenIndex -ge 0 -and $prestageCreateIndex -gt $productHardenIndex) "Manual prestage does not harden the existing product root before creating the protected prestage child."
    Assert-True ($prestageDocText -match 'FILE_SHARE_DELETE' -and $prestageDocText -match 'Assert-DirectoryGuardPath \$guard \$Path' -and $prestageDocText -match 'if \(Test-Path -LiteralPath \$path\) \{ Set-ProtectedProductRootAcl \$path') "Manual prestage does not hold and reverify exact product-root/prestage directory identity during legacy ACL hardening."

    $launcher = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\revAgent Updater STABLE.cmd")
    Assert-True ($launcher -match '%ProgramData%\\DPE\\revAgent\\bootstrap\\Start-revAgent-Update\.ps1' -and $launcher -notmatch 'Install-revAgent-Updater-GUI\.ps1') "Stable launcher is not local-bootstrap-only."
    $bootstrapSource = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "installer\nas\Start-revAgent-Update.ps1")
    Assert-True ($bootstrapSource -match '\[IO\.FileMode\]::Open' -and $bootstrapSource -match '\[IO\.FileMode\]::Append') "Protected bootstrap must probe both overwrite and append-only effective write access."
    $prestageInstallerSource = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "scripts\install-revagent-local-bootstrap.ps1")
    Assert-True ($prestageInstallerSource -match 'Administrator prestage installer must already be staged at the protected canonical path' -and $prestageInstallerSource -match 'localBootstrapInstallerScript' -and $prestageInstallerSource -match 'Protected prestage installer does not match independently authenticated SHA-256 evidence') "Production prestage must reject elevation of the repo-side wrapper and bind the protected staged wrapper to independent evidence."
}
finally {
    if (Test-Path -LiteralPath $junctionParent) {
        try { [IO.Directory]::Delete($junctionParent) } catch { }
    }
    if (Test-Path -LiteralPath $evidenceJunction) {
        try { [IO.Directory]::Delete($evidenceJunction) } catch { }
    }
    if (Test-Path -LiteralPath $bootstrapRoot) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $icacls = Join-Path ([Environment]::SystemDirectory) "icacls.exe"
        & $icacls $bootstrapRoot /grant:r ("*{0}:(OI)(CI)F" -f $identity) /T /C | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not restore recursive test cleanup access on $bootstrapRoot" }
        & $icacls $bootstrapRoot /grant:r ("*{0}:F" -f $identity) /T /C | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not restore protected-leaf test cleanup access on $bootstrapRoot" }
    }
    if (Test-Path -LiteralPath $temp) {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $temp) { throw "Local bootstrap test cleanup left artifacts behind: $temp" }
    }
}
Write-Host "Local protected update bootstrap tests passed." -ForegroundColor Green
