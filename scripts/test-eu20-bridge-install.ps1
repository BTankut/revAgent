<#
.SYNOPSIS
    EU-20/M6 (P3-T9/P3-T10) focused tests for the Bridge installer,
    uninstaller, and shared module.

.DESCRIPTION
    Local, non-admin tests. They never register a real Windows service,
    never run icacls.exe against a real path, and never touch
    C:\Program Files or the real C:\ProgramData -- every filesystem
    exercise happens under a per-run temp scratch directory, and every
    entrypoint-script invocation of Install-RevAgentBridge.ps1 /
    Uninstall-RevAgentBridge.ps1 uses -DryRun (the guarded mutation choke
    point makes that structurally zero-mutation). Get-Service /
    Get-ScheduledTask reads for the fixed 'revAgentBridge' service name and
    the managed task names are safe read-only probes that return "not
    found" on an ordinary dev/CI machine.
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
$bridgeRoot = Join-Path $RepoRoot "installer\bridge"

Import-Module (Join-Path $bridgeRoot "lib\RevAgent.BridgeInstall.psm1") -Force
Import-Module (Join-Path $RepoRoot "installer\lib\RevAgent.DistributionIntegrity.psm1") -Force
Import-Module (Join-Path $RepoRoot "installer\lib\RevAgent.Reporting.psm1") -Force
Import-Module (Join-Path $RepoRoot "installer\lib\RevAgent.RevitVersions.psm1") -Force
Import-Module (Join-Path $RepoRoot "installer\lib\RevAgent.CodexRegistration.psm1") -Force

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param([object]$Actual, [object]$Expected, [string]$Message)
    if ("$Actual" -ne "$Expected") { throw "$Message Expected '$Expected', got '$Actual'." }
}

function Assert-ThrowsLike {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    $threw = $false
    try { & $Action }
    catch {
        $threw = $true
        if ($_.Exception.Message -notmatch $Pattern) {
            throw "$Message Unexpected error: $($_.Exception.Message)"
        }
    }
    if (-not $threw) { throw "$Message Expected an exception matching '$Pattern'." }
}

function New-TestScratchDirectory {
    param([string]$Label)
    $path = Join-Path $env:TEMP ("eu20-bridge-{0}-{1}" -f $Label, [guid]::NewGuid().ToString("N"))
    [void](New-Item -ItemType Directory -Path $path -Force)
    return $path
}

function New-TestRsaProvider {
    $cspParameters = [System.Security.Cryptography.CspParameters]::new(24)
    $cspParameters.Flags = [System.Security.Cryptography.CspProviderFlags]::CreateEphemeralKey
    return [System.Security.Cryptography.RSACryptoServiceProvider]::new($cspParameters)
}

function New-BridgeReleaseFixture {
    param(
        [Parameter(Mandatory = $true)][string]$PackageRoot,
        [switch]$TamperSignature
    )

    $hostDirectory = Join-Path $PackageRoot "host"
    $workerDirectory = Join-Path $PackageRoot "worker"
    # The signed package's addin component is the PARENT of the
    # "revAgentPlugin" folder (not that folder itself): Copy-RevAgentBridgeDirectoryContents
    # copies only the top-level entries of relativeDirectory into AddinBinRoot,
    # and the deterministic manifest's AssemblyPath expects
    # AddinBinRoot\revAgentPlugin\revAgentPlugin.dll -- so the "revAgentPlugin"
    # subfolder itself must be one of those copied top-level entries.
    $addinPackageDirectory = Join-Path $PackageRoot "addin"
    $addinDirectory = Join-Path $addinPackageDirectory "revAgentPlugin"
    [void](New-Item -ItemType Directory -Path $hostDirectory -Force)
    [void](New-Item -ItemType Directory -Path $workerDirectory -Force)
    [void](New-Item -ItemType Directory -Path $addinDirectory -Force)

    $hostExePath = Join-Path $hostDirectory "revagent-bridge-host.exe"
    [System.IO.File]::WriteAllBytes($hostExePath, [byte[]](1, 2, 3, 4, 5))
    [System.IO.File]::WriteAllBytes((Join-Path $workerDirectory "revagent-bridge.exe"), [byte[]](6, 7, 8, 9))
    [System.IO.File]::WriteAllBytes((Join-Path $addinDirectory "revAgentPlugin.dll"), [byte[]](10, 11, 12))

    $content = [ordered]@{
        schemaVersion = 1
        app = "revAgent"
        version = "1.0.0-test"
        host = [ordered]@{
            relativePath = "host\revagent-bridge-host.exe"
            sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $hostExePath).Hash
        }
        worker = [ordered]@{
            relativeDirectory = "worker"
            sha256 = (Get-RevAgentBridgeDirectoryTreeSha256 -Path $workerDirectory)
        }
        addin = [ordered]@{
            relativeDirectory = "addin"
            sha256 = (Get-RevAgentBridgeDirectoryTreeSha256 -Path $addinPackageDirectory)
        }
    }

    $rsa = New-TestRsaProvider
    $publicKeyXml = $rsa.ToXmlString($false)
    $privateKeyXml = $rsa.ToXmlString($true)
    $publicKeyFingerprint = Get-RevitMcpPublicKeyFingerprint -PublicKeyXml $publicKeyXml
    $envelope = New-RevitMcpDetachedJsonSignature -Content $content -SignedObject "release-manifest" -KeyId "eu20-test-key" -PrivateKeyXml $privateKeyXml -App "revAgent"
    $rsa.Dispose()

    if ($TamperSignature) {
        $signatureBytes = [Convert]::FromBase64String([string]$envelope["signature"])
        $signatureBytes[0] = $signatureBytes[0] -bxor 0xFF
        $envelope["signature"] = [Convert]::ToBase64String($signatureBytes)
    }

    $contentPath = Join-Path $PackageRoot "bridge-release.json"
    $signaturePath = Join-Path $PackageRoot "bridge-release.json.sig"
    Set-Content -LiteralPath $contentPath -Value ($content | ConvertTo-Json -Depth 10) -Encoding UTF8
    Set-Content -LiteralPath $signaturePath -Value ($envelope | ConvertTo-Json -Depth 10) -Encoding UTF8

    $trustedKeysPath = Join-Path $PackageRoot "trusted-keys.json"
    $trustedKeys = [ordered]@{
        "eu20-test-key" = [ordered]@{
            publicKeyXml = $publicKeyXml
            publicKeyFingerprint = $publicKeyFingerprint
            algorithm = "RS256"
        }
    }
    Set-Content -LiteralPath $trustedKeysPath -Value ($trustedKeys | ConvertTo-Json -Depth 10) -Encoding UTF8

    return [pscustomobject][ordered]@{
        PackageRoot = $PackageRoot
        TrustedKeysPath = $trustedKeysPath
    }
}

function Get-BridgeTempLayoutArgs {
    param([string]$Root)
    return @{
        InstallRoot = Join-Path $Root "ProgramFiles\revAgent\Bridge"
        StateRoot = Join-Path $Root "ProgramData\revAgent\bridge"
        AddinProgramFilesRoot = Join-Path $Root "ProgramFiles\revAgent\Addin"
        RevitAddinsRoot = Join-Path $Root "ProgramData\Autodesk\Revit\Addins"
    }
}

$scratchRoots = [System.Collections.Generic.List[string]]::new()
try {

    # =====================================================================
    Write-Host "Test P-INST-1 layout matches BridgeInstallLayout.cs field-for-field"
    # =====================================================================
    $layoutRoot = New-TestScratchDirectory -Label "layout"
    $scratchRoots.Add($layoutRoot)
    $layoutArgs = Get-BridgeTempLayoutArgs -Root $layoutRoot
    $layout = Get-RevAgentBridgeLayout @layoutArgs
    Assert-Equal $layout.ServiceName "revAgentBridge" "Service name must match the frozen BridgeInstallLayout constant."
    Assert-Equal $layout.ServiceAccount "LocalSystem" "Service account must match the frozen BridgeInstallLayout constant."
    Assert-Equal $layout.HostExecutablePath (Join-Path $layout.InstallRoot "revagent-bridge-host.exe") "Host executable path derivation must match BridgeInstallLayout.cs."
    Assert-Equal $layout.CurrentWorkerDirectory (Join-Path $layout.InstallRoot "versions\current") "Current worker directory derivation must match BridgeInstallLayout.cs."
    Assert-Equal $layout.CredentialDirectory (Join-Path $layout.StateRoot "credentials") "Credential directory derivation must match BridgeInstallLayout.cs."
    Assert-Equal $layout.EnrollmentArtifactPath (Join-Path $layout.CredentialDirectory "enrollment.json") "Enrollment artifact must be named exactly 'enrollment.json' (WindowsBridgeEnrollmentArtifactSource.ExpectedFileName)."
    $addinLayout = Get-RevAgentBridgeAddinLayout -Layout $layout -RevitVersion "2022"
    Assert-Equal $addinLayout.ManifestPath (Join-Path $layout.RevitAddinsRoot "2022\revAgent.addin") "Add-in manifest path must land under the P-INST-1 ProgramData Revit Addins root."
    Assert-ThrowsLike { Get-RevAgentBridgeAddinLayout -Layout $layout -RevitVersion "abcd" } "RevitVersion must be a bounded 4-digit year" "Non-numeric Revit version must be refused."

    # =====================================================================
    Write-Host "Test deterministic revAgent.addin manifest identity and hash stability"
    # =====================================================================
    $manifestA = New-RevAgentBridgeAddinManifestContract -AssemblyPath "C:\Program Files\revAgent\Addin\2022\revAgentPlugin\revAgentPlugin.dll"
    $manifestB = New-RevAgentBridgeAddinManifestContract -AssemblyPath "C:\Program Files\revAgent\Addin\2022\revAgentPlugin\revAgentPlugin.dll"
    Assert-Equal $manifestA.sha256 $manifestB.sha256 "Manifest generation must be byte-deterministic for the same assembly path."
    Assert-Equal $manifestA.clientId "090A4C8C-61DC-426D-87DF-E4BAE0F80EC1" "Manifest ClientId must match the frozen add-in identity (installer/install-self-contained.ps1)."
    Assert-Equal $manifestA.vendorId "DPE" "Manifest VendorId must match the frozen add-in identity."
    Assert-True ($manifestA.content -match '<Name>revAgent</Name>') "Manifest must declare the exact add-in Name identity."
    $manifestDifferentPath = New-RevAgentBridgeAddinManifestContract -AssemblyPath "C:\Program Files\revAgent\Addin\2023\revAgentPlugin\revAgentPlugin.dll"
    Assert-True ($manifestA.sha256 -ne $manifestDifferentPath.sha256) "A different assembly path must change the manifest hash."

    # =====================================================================
    Write-Host "Test the single guarded mutation choke point: dry-run never invokes Apply"
    # =====================================================================
    $script:guardedCallCount = 0
    $steps = [System.Collections.Generic.List[object]]::new()
    [void](Invoke-RevAgentBridgeGuardedMutation -Target "t" -MutationAction "a" -DryRun $true -Steps $steps -Apply { $script:guardedCallCount++; return "ran" })
    Assert-Equal $script:guardedCallCount 0 "DryRun must never invoke the guarded Apply scriptblock."
    Assert-Equal $steps[0].status "skipped_dry_run" "DryRun guarded mutation must record 'skipped_dry_run'."

    [void](Invoke-RevAgentBridgeGuardedMutation -Target "t" -MutationAction "a" -DryRun $false -Steps $steps -Apply { $script:guardedCallCount++; return "ran" })
    Assert-Equal $script:guardedCallCount 1 "Non-DryRun guarded mutation must invoke Apply exactly once."
    Assert-Equal $steps[1].status "applied" "Non-DryRun guarded mutation must record 'applied' on success."

    $failureThrew = $false
    try {
        [void](Invoke-RevAgentBridgeGuardedMutation -Target "t" -MutationAction "a" -DryRun $false -Steps $steps -Apply { throw "boom" })
    }
    catch { $failureThrew = $true }
    Assert-True $failureThrew "A failing Apply must propagate (fail closed), not be swallowed."
    Assert-Equal $steps[2].status "failed" "A failing guarded mutation must record 'failed' before rethrowing."

    # =====================================================================
    Write-Host "Test P-ENROLL-1 enrollment-token shape validation fails closed"
    # =====================================================================
    Assert-ThrowsLike { Assert-RevAgentBridgeEnrollmentTokenShape -EnrollmentToken ("a" * 10) } "enrollment_token_invalid_length" "A too-short token must be refused."
    Assert-ThrowsLike { Assert-RevAgentBridgeEnrollmentTokenShape -EnrollmentToken ("a" * 5000) } "enrollment_token_invalid_length" "A too-long token must be refused."
    Assert-ThrowsLike { Assert-RevAgentBridgeEnrollmentTokenShape -EnrollmentToken (("a" * 31) + "`t") } "enrollment_token_invalid_characters" "A control character in the token must be refused."
    [void](Assert-RevAgentBridgeEnrollmentTokenShape -EnrollmentToken ("a" * 40))

    # =====================================================================
    Write-Host "Test the M4 enrollment-artifact TTL bound fails closed on bad/expired expiry"
    # =====================================================================
    $validToken = "T" + ("k" * 39)
    $nowUtc = [datetime]::UtcNow
    Assert-ThrowsLike {
        New-RevAgentBridgeEnrollmentArtifactBytes -EnrollmentToken $validToken -ExpiresAtUtc $nowUtc.AddSeconds(10) -NowUtc $nowUtc
    } "enrollment_token_expired_or_too_close" "A token expiring in 10 seconds must be refused (below the 50s floor)."
    Assert-ThrowsLike {
        New-RevAgentBridgeEnrollmentArtifactBytes -EnrollmentToken $validToken -ExpiresAtUtc $nowUtc.AddHours(-1) -NowUtc $nowUtc
    } "enrollment_token_expired_or_too_close" "An already-expired token must be refused."
    Assert-ThrowsLike {
        New-RevAgentBridgeEnrollmentArtifactBytes -EnrollmentToken $validToken -ExpiresAtUtc $nowUtc.AddHours(25) -NowUtc $nowUtc
    } "enrollment_token_ttl_exceeds_24h" "A TTL over 24h must be refused (P-ENROLL-1 cap)."
    $goodBytes = New-RevAgentBridgeEnrollmentArtifactBytes -EnrollmentToken $validToken -ExpiresAtUtc $nowUtc.AddHours(12) -NowUtc $nowUtc
    Assert-True ($goodBytes.Length -le 4096) "The enrollment artifact must stay within the bridge's 4096-byte bound."
    $goodJson = [System.Text.Encoding]::UTF8.GetString($goodBytes) | ConvertFrom-Json
    Assert-Equal $goodJson.contractVersion "revagent.m4-enrollment-artifact/v1" "Artifact contractVersion must match BridgeEnrollmentArtifactConsumer.ArtifactContractVersion exactly."
    Assert-Equal $goodJson.enrollmentToken $validToken "Artifact must carry the exact supplied token."
    Assert-True ($goodJson.expiresAtMs -gt 0) "Artifact expiresAtMs must be a positive integer."

    # =====================================================================
    Write-Host "Test ACL helpers invoke icacls only through the injectable invoker (no real icacls.exe call)"
    # =====================================================================
    $icaclsCalls = [System.Collections.Generic.List[string]]::new()
    $mockInvoker = {
        param([string[]]$Arguments)
        $icaclsCalls.Add(($Arguments -join " "))
        return "mocked"
    }.GetNewClosure()
    Set-RevAgentBridgeSystemOnlyAcl -Path "C:\does-not-matter\enrollment.json" -IcaclsInvoker $mockInvoker
    Assert-Equal $icaclsCalls.Count 3 "The narrow SYSTEM-only ACL must issue exactly setowner + inheritance:r + grant:r."
    Assert-True ($icaclsCalls[0] -match "setowner") "First narrow-ACL call must set the owner."
    Assert-True (($icaclsCalls -join "|") -match "SYSTEM:\(F\)") "Narrow ACL must grant SYSTEM FullControl."
    Assert-True (($icaclsCalls -join "|") -match "BUILTIN\\Administrators:\(F\)") "Narrow ACL must grant Administrators FullControl."
    Assert-True (($icaclsCalls -join "|") -notmatch "Users") "Narrow credential ACL must not grant interactive Users any access."

    $icaclsCalls.Clear()
    Set-RevAgentBridgeDistributionAcl -Path "C:\does-not-matter\Addin\2022" -IcaclsInvoker $mockInvoker
    Assert-True (($icaclsCalls -join "|") -match "BUILTIN\\Users:\(OI\)\(CI\)RX") "Distribution ACL must grant interactive Users read+execute so Revit can load the add-in."

    # =====================================================================
    Write-Host "Test end-to-end install -DryRun: signature failure fails closed with zero mutation steps"
    # =====================================================================
    $tamperedRoot = New-TestScratchDirectory -Label "tampered-package"
    $scratchRoots.Add($tamperedRoot)
    $tamperedFixture = New-BridgeReleaseFixture -PackageRoot $tamperedRoot -TamperSignature
    $tamperedTemp = New-TestScratchDirectory -Label "tampered-target"
    $scratchRoots.Add($tamperedTemp)
    $tamperedLayoutArgs = Get-BridgeTempLayoutArgs -Root $tamperedTemp
    $tamperedReportPath = Join-Path $tamperedTemp "report.json"
    $tamperedThrew = $false
    try {
        & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
            -PackageRoot $tamperedFixture.PackageRoot `
            -TrustedKeysPath $tamperedFixture.TrustedKeysPath `
            -EnrollmentToken ("a" * 40) `
            -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) `
            -InstallRoot $tamperedLayoutArgs.InstallRoot `
            -StateRoot $tamperedLayoutArgs.StateRoot `
            -AddinProgramFilesRoot $tamperedLayoutArgs.AddinProgramFilesRoot `
            -RevitAddinsRoot $tamperedLayoutArgs.RevitAddinsRoot `
            -MachineReportPath $tamperedReportPath `
            -SkipRevitDetection `
            -DryRun | Out-Null
    }
    catch { $tamperedThrew = $true }
    Assert-True $tamperedThrew "A tampered signature must fail the install closed."
    Assert-True (Test-Path -LiteralPath $tamperedReportPath -PathType Leaf) "A failed install must still emit a machine report."
    $tamperedReport = Get-Content -Raw -LiteralPath $tamperedReportPath | ConvertFrom-Json
    Assert-Equal $tamperedReport.status "failed" "Report status must be 'failed' for a tampered signature."
    $tamperedStepActions = @($tamperedReport.steps | ForEach-Object { $_.action })
    Assert-True ($tamperedStepActions -notcontains "create_install_root") "No mutation step may be attempted after signature verification fails."
    Assert-True (-not (Test-Path -LiteralPath $tamperedLayoutArgs.InstallRoot)) "A failed signature check must leave the install root entirely uncreated."

    # =====================================================================
    Write-Host "Test end-to-end install -DryRun: bad enrollment token fails closed independent of dry-run"
    # =====================================================================
    $goodRoot = New-TestScratchDirectory -Label "good-package"
    $scratchRoots.Add($goodRoot)
    $goodFixture = New-BridgeReleaseFixture -PackageRoot $goodRoot
    $badTokenTemp = New-TestScratchDirectory -Label "badtoken-target"
    $scratchRoots.Add($badTokenTemp)
    $badTokenLayoutArgs = Get-BridgeTempLayoutArgs -Root $badTokenTemp
    $badTokenReportPath = Join-Path $badTokenTemp "report.json"
    $badTokenThrew = $false
    try {
        & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
            -PackageRoot $goodFixture.PackageRoot `
            -TrustedKeysPath $goodFixture.TrustedKeysPath `
            -EnrollmentToken "too-short" `
            -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) `
            -InstallRoot $badTokenLayoutArgs.InstallRoot `
            -StateRoot $badTokenLayoutArgs.StateRoot `
            -AddinProgramFilesRoot $badTokenLayoutArgs.AddinProgramFilesRoot `
            -RevitAddinsRoot $badTokenLayoutArgs.RevitAddinsRoot `
            -MachineReportPath $badTokenReportPath `
            -SkipRevitDetection `
            -DryRun | Out-Null
    }
    catch { $badTokenThrew = $true }
    Assert-True $badTokenThrew "A malformed enrollment token must fail the install closed."
    $badTokenReport = Get-Content -Raw -LiteralPath $badTokenReportPath | ConvertFrom-Json
    Assert-Equal $badTokenReport.status "failed" "Report status must be 'failed' for a malformed enrollment token."
    Assert-True ($badTokenReport.message -match "enrollment_token_invalid_length") "Failure message must surface the exact fail-closed reason."

    # =====================================================================
    Write-Host "Test installer refuses to write through a pre-planted junction at InstallRoot (fails closed before any write)"
    # =====================================================================
    $junctionInstallTemp = New-TestScratchDirectory -Label "junction-install"
    $scratchRoots.Add($junctionInstallTemp)
    $junctionInstallLayoutArgs = Get-BridgeTempLayoutArgs -Root $junctionInstallTemp
    $installRootParent = Split-Path -Parent $junctionInstallLayoutArgs.InstallRoot
    [void](New-Item -ItemType Directory -Path $installRootParent -Force)
    $outsideLayoutTarget = Join-Path $junctionInstallTemp "outside-layout-root"
    [void](New-Item -ItemType Directory -Path $outsideLayoutTarget -Force)
    [void](New-Item -ItemType Junction -Path $junctionInstallLayoutArgs.InstallRoot -Target $outsideLayoutTarget)
    $junctionInstallReportPath = Join-Path $junctionInstallTemp "report.json"
    $junctionInstallThrew = $false
    try {
        & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
            -PackageRoot $goodFixture.PackageRoot `
            -TrustedKeysPath $goodFixture.TrustedKeysPath `
            -EnrollmentToken ("a" * 40) `
            -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) `
            -InstallRoot $junctionInstallLayoutArgs.InstallRoot `
            -StateRoot $junctionInstallLayoutArgs.StateRoot `
            -AddinProgramFilesRoot $junctionInstallLayoutArgs.AddinProgramFilesRoot `
            -RevitAddinsRoot $junctionInstallLayoutArgs.RevitAddinsRoot `
            -MachineReportPath $junctionInstallReportPath `
            -SkipRevitDetection `
            -SkipServiceStart | Out-Null
    }
    catch { $junctionInstallThrew = $true }
    Assert-True $junctionInstallThrew "A pre-planted junction at InstallRoot must make a real (non-dry-run) install fail closed."
    $junctionInstallReport = Get-Content -Raw -LiteralPath $junctionInstallReportPath | ConvertFrom-Json
    Assert-Equal $junctionInstallReport.status "failed" "Report status must be 'failed' when InstallRoot is a pre-planted junction."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $outsideLayoutTarget "revagent-bridge-host.exe"))) "Nothing may be written through the junction into the out-of-layout target."
    $junctionInstallStepActions = @($junctionInstallReport.steps | ForEach-Object { $_.action })
    Assert-True ($junctionInstallStepActions -notcontains "deploy_host_executable") "No later step may run once the link guard throws on create_install_root."

    # =====================================================================
    Write-Host "Test GatewayHostName guard rejects IPv6 literals (bracketed and bare), not just IPv4"
    # =====================================================================
    foreach ($ipv6Case in @("::1", "[fe80::1]", "2001:db8::8a2e:370:7334", "fe80::1%eth0")) {
        $ipv6Temp = New-TestScratchDirectory -Label "ipv6"
        $scratchRoots.Add($ipv6Temp)
        $ipv6LayoutArgs = Get-BridgeTempLayoutArgs -Root $ipv6Temp
        $ipv6ReportPath = Join-Path $ipv6Temp "report.json"
        $ipv6Threw = $false
        try {
            & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
                -PackageRoot $goodFixture.PackageRoot `
                -TrustedKeysPath $goodFixture.TrustedKeysPath `
                -EnrollmentToken ("a" * 40) `
                -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) `
                -InstallRoot $ipv6LayoutArgs.InstallRoot `
                -StateRoot $ipv6LayoutArgs.StateRoot `
                -AddinProgramFilesRoot $ipv6LayoutArgs.AddinProgramFilesRoot `
                -RevitAddinsRoot $ipv6LayoutArgs.RevitAddinsRoot `
                -GatewayHostName $ipv6Case `
                -MachineReportPath $ipv6ReportPath `
                -SkipRevitDetection `
                -DryRun | Out-Null
        }
        catch { $ipv6Threw = $true }
        Assert-True $ipv6Threw "GatewayHostName '$ipv6Case' (an IPv6 literal) must be refused."
        $ipv6Report = Get-Content -Raw -LiteralPath $ipv6ReportPath | ConvertFrom-Json
        Assert-True ($ipv6Report.message -match "gateway_host_must_not_be_ip") "Failure reason for '$ipv6Case' must be gateway_host_must_not_be_ip."
    }
    $dnsTemp = New-TestScratchDirectory -Label "dns-ok"
    $scratchRoots.Add($dnsTemp)
    $dnsLayoutArgs = Get-BridgeTempLayoutArgs -Root $dnsTemp
    $dnsReportPath = Join-Path $dnsTemp "report.json"
    & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
        -PackageRoot $goodFixture.PackageRoot `
        -TrustedKeysPath $goodFixture.TrustedKeysPath `
        -EnrollmentToken ("a" * 40) `
        -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) `
        -InstallRoot $dnsLayoutArgs.InstallRoot `
        -StateRoot $dnsLayoutArgs.StateRoot `
        -AddinProgramFilesRoot $dnsLayoutArgs.AddinProgramFilesRoot `
        -RevitAddinsRoot $dnsLayoutArgs.RevitAddinsRoot `
        -GatewayHostName "gateway.dpe.internal" `
        -MachineReportPath $dnsReportPath `
        -SkipRevitDetection `
        -DryRun | Out-Null
    $dnsReport = Get-Content -Raw -LiteralPath $dnsReportPath | ConvertFrom-Json
    Assert-Equal $dnsReport.status "success" "A genuine DNS hostname must still be accepted."

    # =====================================================================
    Write-Host "Test end-to-end install -DryRun happy path performs zero mutations and validates against the machine-report schema"
    # =====================================================================
    $happyTemp = New-TestScratchDirectory -Label "happy-target"
    $scratchRoots.Add($happyTemp)
    $happyLayoutArgs = Get-BridgeTempLayoutArgs -Root $happyTemp
    $happyReportPath = Join-Path $happyTemp "report.json"
    & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
        -PackageRoot $goodFixture.PackageRoot `
        -TrustedKeysPath $goodFixture.TrustedKeysPath `
        -EnrollmentToken ("a" * 40) `
        -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) `
        -InstallRoot $happyLayoutArgs.InstallRoot `
        -StateRoot $happyLayoutArgs.StateRoot `
        -AddinProgramFilesRoot $happyLayoutArgs.AddinProgramFilesRoot `
        -RevitAddinsRoot $happyLayoutArgs.RevitAddinsRoot `
        -MachineReportPath $happyReportPath `
        -SkipRevitDetection `
        -DryRun | Out-Null
    $happyReport = Get-Content -Raw -LiteralPath $happyReportPath | ConvertFrom-Json
    Assert-Equal $happyReport.status "success" "A valid signature + valid token + DryRun must succeed."
    Assert-Equal $happyReport.dryRun $true "Report must record dryRun=true."
    $nonSkippedSteps = @($happyReport.steps | Where-Object { $_.status -notin @("skipped_dry_run", "verified") })
    Assert-Equal $nonSkippedSteps.Count 0 "Every mutating step under -DryRun must be 'skipped_dry_run' (or a read-only 'verified' step)."
    Assert-True (-not (Test-Path -LiteralPath $happyLayoutArgs.InstallRoot)) "DryRun must not create the install root."
    Assert-True (-not (Test-Path -LiteralPath $happyLayoutArgs.StateRoot)) "DryRun must not create the state root."

    $schemaPath = Join-Path $RepoRoot "config\bridge-machine-report.schema.json"
    Assert-True (Test-Path -LiteralPath $schemaPath -PathType Leaf) "The machine-report schema must exist under config/."
    $schema = Get-Content -Raw -LiteralPath $schemaPath | ConvertFrom-Json
    foreach ($requiredField in $schema.required) {
        Assert-True ($null -ne ($happyReport.PSObject.Properties[$requiredField])) "Machine report is missing schema-required field '$requiredField'."
    }
    Assert-Equal $happyReport.schemaVersion 1 "Report schemaVersion must be 1."
    Assert-Equal $happyReport.app "revAgent" "Report app identity must be 'revAgent'."
    Assert-Equal $happyReport.component "bridge" "Report component must be 'bridge'."

    # =====================================================================
    Write-Host "Test end-to-end install (non-dry-run): payload files actually land, durable machine report is written"
    # =====================================================================
    # This is the regression test for the '*' literal-path copy bug and the
    # ReportsDirectory-guards-itself bug: it is the only test in this suite
    # that lets the real mutation Apply blocks run. Only the OS-level
    # surfaces this installer would otherwise really touch outside its own
    # temp roots -- icacls.exe (ACL lockdown) and the Get-Service
    # registration probe -- are mocked; every directory/file operation
    # (creation, link guards, payload copy, config/manifest/enrollment
    # writes, the durable report) executes for real against the temp roots.
    $realRunTemp = New-TestScratchDirectory -Label "real-run"
    $scratchRoots.Add($realRunTemp)
    $realRunLayoutArgs = Get-BridgeTempLayoutArgs -Root $realRunTemp
    $realRunReportPath = Join-Path $realRunTemp "external-report.json"

    # $global: (not $script:) is required here: Install-RevAgentBridge.ps1 is
    # invoked below as a nested script file via '&', which gives it its own
    # script-scope frame, so a '$script:' write inside a function that
    # happens to run while that nested script is on the call stack lands in
    # the NESTED script's scope, not this test file's -- $global: is the one
    # unambiguous, single top-level counter regardless of which script frame
    # is executing when the mock is invoked.
    $global:eu20MockIcaclsCallCount = 0
    function icacls.exe {
        $global:eu20MockIcaclsCallCount++
        $global:LASTEXITCODE = 0
        return "mocked"
    }
    function Get-Service {
        param([string]$Name, $ErrorAction)
        return [pscustomobject]@{ Name = $Name; Status = "Stopped" }
    }
    try {
        & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
            -PackageRoot $goodFixture.PackageRoot `
            -TrustedKeysPath $goodFixture.TrustedKeysPath `
            -EnrollmentToken ("a" * 40) `
            -EnrollmentTokenExpiresAtUtc ([datetime]::UtcNow.AddHours(1)) `
            -InstallRoot $realRunLayoutArgs.InstallRoot `
            -StateRoot $realRunLayoutArgs.StateRoot `
            -AddinProgramFilesRoot $realRunLayoutArgs.AddinProgramFilesRoot `
            -RevitAddinsRoot $realRunLayoutArgs.RevitAddinsRoot `
            -MachineReportPath $realRunReportPath `
            -SkipRevitDetection `
            -SkipServiceStart | Out-Null
    }
    finally {
        Remove-Item -LiteralPath Function:\icacls.exe -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath Function:\Get-Service -ErrorAction SilentlyContinue
    }

    Assert-True ($global:eu20MockIcaclsCallCount -gt 0) "The real install path must reach ACL lockdown (proves it ran past directory creation, through the mocked icacls.exe)."
    Remove-Variable -Name eu20MockIcaclsCallCount -Scope Global -ErrorAction SilentlyContinue
    $realRunReport = Get-Content -Raw -LiteralPath $realRunReportPath | ConvertFrom-Json
    Assert-Equal $realRunReport.status "success" "A real (non-dry-run) install against valid fixtures must succeed end-to-end."
    Assert-Equal $realRunReport.dryRun $false "This run must be recorded as non-dry-run."

    $realRunLayout = Get-RevAgentBridgeLayout @realRunLayoutArgs
    Assert-True (Test-Path -LiteralPath (Join-Path $realRunLayout.CurrentWorkerDirectory "revagent-bridge.exe") -PathType Leaf) "The worker payload file must actually land in CurrentWorkerDirectory -- a literal '*' Copy-Item path would have thrown/no-op'd here."
    $realRunAddinLayout = Get-RevAgentBridgeAddinLayout -Layout $realRunLayout -RevitVersion "2022"
    Assert-True (Test-Path -LiteralPath (Join-Path $realRunAddinLayout.AddinBinRoot "revAgentPlugin\revAgentPlugin.dll") -PathType Leaf) "The add-in payload file, including its subdirectory, must actually land in AddinBinRoot."
    Assert-True (Test-Path -LiteralPath $realRunLayout.HostExecutablePath -PathType Leaf) "The host executable must be deployed."
    Assert-True (Test-Path -LiteralPath $realRunAddinLayout.ManifestPath -PathType Leaf) "The deterministic add-in manifest must be written."
    Assert-True (Test-Path -LiteralPath $realRunLayout.EnrollmentArtifactPath -PathType Leaf) "The enrollment artifact must be written on a real run."

    Assert-True (Test-Path -LiteralPath $realRunLayout.ReportsDirectory -PathType Container) "The durable <StateRoot>\reports directory must exist after a real install, not just the explicit -MachineReportPath copy."
    $durableReportFiles = @(Get-ChildItem -LiteralPath $realRunLayout.ReportsDirectory -Filter "install-*.json" -File)
    Assert-True ($durableReportFiles.Count -ge 1) "At least one durable install-<timestamp>.json report must have been written under <StateRoot>\reports."
    $durableLatestPath = Join-Path $realRunLayout.ReportsDirectory "install-latest.json"
    Assert-True (Test-Path -LiteralPath $durableLatestPath -PathType Leaf) "install-latest.json must exist under <StateRoot>\reports."
    $durableReport = Get-Content -Raw -LiteralPath $durableLatestPath | ConvertFrom-Json
    foreach ($requiredField in $schema.required) {
        Assert-True ($null -ne $durableReport.PSObject.Properties[$requiredField]) "Durable machine report is missing schema-required field '$requiredField'."
    }
    Assert-Equal $durableReport.status "success" "The durable machine report must also record success."

    # =====================================================================
    Write-Host "Test Write-RevAgentBridgeMachineReport against a not-yet-existing reports directory"
    # =====================================================================
    $freshReportsRoot = New-TestScratchDirectory -Label "fresh-reports"
    $scratchRoots.Add($freshReportsRoot)
    $freshStateRoot = Join-Path $freshReportsRoot "StateRoot"
    [void](New-Item -ItemType Directory -Path $freshStateRoot -Force)
    $freshReportsDirectory = Join-Path $freshStateRoot "reports"
    Assert-True (-not (Test-Path -LiteralPath $freshReportsDirectory)) "Fixture precondition: the reports directory must not exist yet."
    $freshReport = New-RevAgentBridgeMachineReport -Action "install" -DryRun $false -StartedAtUtc ([datetime]::UtcNow) -CompletedAtUtc ([datetime]::UtcNow) -Status "success" -Message "unit test"
    $freshWrittenPath = Write-RevAgentBridgeMachineReport -Report $freshReport -ReportsDirectory $freshReportsDirectory -DryRun $false
    Assert-True (Test-Path -LiteralPath $freshReportsDirectory -PathType Container) "Write-RevAgentBridgeMachineReport must create a not-yet-existing reports directory (guarded from its parent, not from itself)."
    Assert-True (Test-Path -LiteralPath $freshWrittenPath -PathType Leaf) "Write-RevAgentBridgeMachineReport must return the path it wrote."
    Assert-True (Test-Path -LiteralPath (Join-Path $freshReportsDirectory "install-latest.json") -PathType Leaf) "install-latest.json must be written alongside the timestamped report."

    # =====================================================================
    Write-Host "Test idempotent re-run: an existing device credential skips enrollment-artifact write"
    # =====================================================================
    $idempotentTemp = New-TestScratchDirectory -Label "idempotent-target"
    $scratchRoots.Add($idempotentTemp)
    $idempotentLayoutArgs = Get-BridgeTempLayoutArgs -Root $idempotentTemp
    $idempotentLayout = Get-RevAgentBridgeLayout @idempotentLayoutArgs
    [void](New-Item -ItemType Directory -Path $idempotentLayout.CredentialDirectory -Force)
    [System.IO.File]::WriteAllBytes($idempotentLayout.DeviceCredentialPath, [byte[]](1, 2, 3))
    $idempotentReportPath = Join-Path $idempotentTemp "report.json"
    & (Join-Path $bridgeRoot "Install-RevAgentBridge.ps1") `
        -PackageRoot $goodFixture.PackageRoot `
        -TrustedKeysPath $goodFixture.TrustedKeysPath `
        -InstallRoot $idempotentLayoutArgs.InstallRoot `
        -StateRoot $idempotentLayoutArgs.StateRoot `
        -AddinProgramFilesRoot $idempotentLayoutArgs.AddinProgramFilesRoot `
        -RevitAddinsRoot $idempotentLayoutArgs.RevitAddinsRoot `
        -MachineReportPath $idempotentReportPath `
        -SkipRevitDetection `
        -DryRun | Out-Null
    $idempotentReport = Get-Content -Raw -LiteralPath $idempotentReportPath | ConvertFrom-Json
    Assert-Equal $idempotentReport.status "success" "Re-run against an already-enrolled machine must succeed without -EnrollmentToken."
    Assert-Equal $idempotentReport.install.alreadyEnrolled $true "Re-run must detect the existing device credential."
    Assert-Equal $idempotentReport.install.enrollmentAttempted $false "Re-run must not attempt enrollment when already enrolled."
    $enrollmentStep = @($idempotentReport.steps | Where-Object { $_.action -eq "write_enrollment_artifact" })[0]
    Assert-Equal $enrollmentStep.status "skipped_already_enrolled" "Re-run's enrollment-artifact step must be skipped for the already-enrolled reason, not the dry-run reason."

    # =====================================================================
    Write-Host "Test tree-wipe dry-run performs zero deletions and never invokes the removal action (single choke point)"
    # =====================================================================
    $wipeDryRunRoot = New-TestScratchDirectory -Label "wipe-dryrun"
    $scratchRoots.Add($wipeDryRunRoot)
    $wipeDryRunFile = Join-Path $wipeDryRunRoot "loose-file.txt"
    Set-Content -LiteralPath $wipeDryRunFile -Value "content" -Encoding UTF8
    $wipeDryRunPlan = Get-RevAgentBridgeTreeWipePlan -Root $wipeDryRunRoot -Anchors @()
    $script:eu20RemoveActionCallCount = 0
    $mockRemoveAction = { param([string]$ItemPath, [string]$ItemKind) $script:eu20RemoveActionCallCount++; return "removed" }
    $wipeDryRunSteps = [System.Collections.Generic.List[object]]::new()
    $wipeDryRunResults = Invoke-RevAgentBridgeTreeWipePlan -Plan $wipeDryRunPlan -DryRun $true -Steps $wipeDryRunSteps -RemoveItemAction $mockRemoveAction
    Assert-Equal $script:eu20RemoveActionCallCount 0 "Tree-wipe dry-run must never invoke the removal action -- DryRun gating lives only in the guarded choke point."
    Assert-True (Test-Path -LiteralPath $wipeDryRunFile -PathType Leaf) "Tree-wipe dry-run must perform zero deletions."
    $wipeDryRunFileResult = @($wipeDryRunResults | Where-Object { $_.path -eq $wipeDryRunFile })[0]
    Assert-Equal $wipeDryRunFileResult.disposition "would_remove" "Dry-run disposition for a plan 'remove' item must be 'would_remove'."
    Assert-True ($wipeDryRunSteps.Count -gt 0) "Each planned removal must still be recorded as a guarded-mutation step even under dry-run."
    Assert-True (@($wipeDryRunSteps | Where-Object { $_.status -ne "skipped_dry_run" }).Count -eq 0) "Every tree-wipe step under dry-run must be 'skipped_dry_run'."

    # =====================================================================
    Write-Host "Test a directory junction inside the legacy tree is not followed"
    # =====================================================================
    $junctionWalkRoot = New-TestScratchDirectory -Label "junction-walk"
    $scratchRoots.Add($junctionWalkRoot)
    $junctionLegacyRoot = Join-Path $junctionWalkRoot "legacy"
    [void](New-Item -ItemType Directory -Path $junctionLegacyRoot -Force)
    Set-Content -LiteralPath (Join-Path $junctionLegacyRoot "ordinary-file.txt") -Value "x" -Encoding UTF8
    $junctionOutsideTarget = Join-Path $junctionWalkRoot "outside-target"
    [void](New-Item -ItemType Directory -Path $junctionOutsideTarget -Force)
    Set-Content -LiteralPath (Join-Path $junctionOutsideTarget "secret-marker.txt") -Value "do-not-touch" -Encoding UTF8
    $junctionLinkPath = Join-Path $junctionLegacyRoot "evil-link"
    [void](New-Item -ItemType Junction -Path $junctionLinkPath -Target $junctionOutsideTarget)

    $junctionPlan = Get-RevAgentBridgeTreeWipePlan -Root $junctionLegacyRoot -Anchors @()
    $junctionLinkEntry = @($junctionPlan | Where-Object { $_.path -eq $junctionLinkPath })[0]
    Assert-Equal $junctionLinkEntry.disposition "kept_reparse_point" "A directory junction inside the legacy tree must be kept, never planned for removal by recursion."
    $leakedMarkerEntries = @($junctionPlan | Where-Object { $_.path -like "*secret-marker.txt" })
    Assert-Equal $leakedMarkerEntries.Count 0 "Contents behind a planted junction must never be enumerated into the wipe plan (the walk must not follow it)."

    $junctionResults = Invoke-RevAgentBridgeTreeWipePlan -Plan $junctionPlan -DryRun $false
    $failedJunctionResults = @($junctionResults | Where-Object { $_.disposition -eq "failed" })
    Assert-Equal $failedJunctionResults.Count 0 "Wiping around a kept junction must not fail."
    Assert-True (Test-Path -LiteralPath (Join-Path $junctionOutsideTarget "secret-marker.txt") -PathType Leaf) "The out-of-tree target behind the junction must survive completely untouched."
    Assert-True (Test-Path -LiteralPath $junctionLinkPath) "The junction placeholder itself must survive (never deleted, never followed)."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $junctionLegacyRoot "ordinary-file.txt"))) "An ordinary non-anchor file alongside the junction must still be removed."

    # =====================================================================
    Write-Host "Test uninstaller tree wipe structurally cannot remove a P-SEQ-2 rollback anchor"
    # =====================================================================
    $wipeRoot = New-TestScratchDirectory -Label "wipe"
    $scratchRoots.Add($wipeRoot)
    $legacyRoot = Join-Path $wipeRoot "DPE\revAgent"
    $bootstrapDir = Join-Path $legacyRoot "bootstrap"
    $prestageDir = Join-Path $legacyRoot "prestage"
    $updaterConfigDir = Join-Path $legacyRoot "updater\config"
    [void](New-Item -ItemType Directory -Path $bootstrapDir -Force)
    [void](New-Item -ItemType Directory -Path $prestageDir -Force)
    [void](New-Item -ItemType Directory -Path $updaterConfigDir -Force)
    Set-Content -LiteralPath (Join-Path $bootstrapDir "seed.ps1") -Value "# bootstrap seed" -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $prestageDir "install-revagent-local-bootstrap.ps1") -Value "# anchor script" -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $prestageDir "other-prestage-file.ps1") -Value "# not an anchor" -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $updaterConfigDir "release-trusted-keys.json") -Value '{"keys":[]}' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $updaterConfigDir "other-updater-config.json") -Value '{}' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $legacyRoot "legacy-loose-file.txt") -Value "legacy" -Encoding UTF8

    $anchors = Get-RevAgentBridgeRollbackAnchors -ProgramDataRoot $wipeRoot
    Assert-Equal $anchors.Count 3 "There must be exactly three P-SEQ-2 rollback anchors."
    $anchorHashesBefore = Get-RevAgentBridgeAnchorHashes -Anchors $anchors

    $plan = Get-RevAgentBridgeTreeWipePlan -Root $legacyRoot -Anchors $anchors
    $anchorScriptPath = Join-Path $prestageDir "install-revagent-local-bootstrap.ps1"
    $anchorPlanEntry = @($plan | Where-Object { $_.path -eq $anchorScriptPath })[0]
    Assert-Equal $anchorPlanEntry.disposition "kept_anchor" "The anchor script must never be planned for removal."
    $bootstrapDirPlanEntry = @($plan | Where-Object { $_.path -eq $bootstrapDir })[0]
    Assert-Equal $bootstrapDirPlanEntry.disposition "kept_anchor" "The bootstrap\ anchor directory must never be planned for removal."

    $results = Invoke-RevAgentBridgeTreeWipePlan -Plan $plan -DryRun $false
    $failedResults = @($results | Where-Object { $_.disposition -eq "failed" })
    Assert-Equal $failedResults.Count 0 "The legacy-tree wipe must not fail on any item in this fixture."

    Assert-True (Test-Path -LiteralPath (Join-Path $bootstrapDir "seed.ps1") -PathType Leaf) "bootstrap\ contents must survive the wipe untouched."
    Assert-True (Test-Path -LiteralPath $anchorScriptPath -PathType Leaf) "The exact anchor script must survive the wipe."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $prestageDir "other-prestage-file.ps1"))) "A non-anchor file alongside an anchor must still be removed."
    Assert-True (Test-Path -LiteralPath (Join-Path $updaterConfigDir "release-trusted-keys.json") -PathType Leaf) "The anchor trusted-keys file must survive the wipe."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $updaterConfigDir "other-updater-config.json"))) "A non-anchor file in the updater config directory must still be removed."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $legacyRoot "legacy-loose-file.txt"))) "Loose non-anchor legacy files must be removed."

    $anchorHashesAfter = Get-RevAgentBridgeAnchorHashes -Anchors $anchors
    foreach ($anchor in $anchors) {
        Assert-Equal $anchorHashesAfter.$anchor $anchorHashesBefore.$anchor "Anchor content hash must be byte-identical before and after the wipe: $anchor"
    }

    # =====================================================================
    Write-Host "Test uninstaller -DryRun end-to-end: zero mutation, anchors reported preserved"
    # =====================================================================
    $uninstallDryRunRoot = New-TestScratchDirectory -Label "uninstall-dryrun"
    $scratchRoots.Add($uninstallDryRunRoot)
    $udrLegacyRoot = Join-Path $uninstallDryRunRoot "DPE\revAgent"
    [void](New-Item -ItemType Directory -Path (Join-Path $udrLegacyRoot "bootstrap") -Force)
    Set-Content -LiteralPath (Join-Path $udrLegacyRoot "bootstrap\seed.ps1") -Value "# seed" -Encoding UTF8
    [void](New-Item -ItemType Directory -Path (Join-Path $udrLegacyRoot "prestage") -Force)
    Set-Content -LiteralPath (Join-Path $udrLegacyRoot "prestage\install-revagent-local-bootstrap.ps1") -Value "# anchor" -Encoding UTF8
    [void](New-Item -ItemType Directory -Path (Join-Path $udrLegacyRoot "updater\config") -Force)
    Set-Content -LiteralPath (Join-Path $udrLegacyRoot "updater\config\release-trusted-keys.json") -Value '{}' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $udrLegacyRoot "legacy-loose-file.txt") -Value "legacy" -Encoding UTF8

    $uninstallReportPath = Join-Path $uninstallDryRunRoot "wipe-report.json"
    & (Join-Path $bridgeRoot "Uninstall-RevAgentBridge.ps1") `
        -ProgramDataRoot $uninstallDryRunRoot `
        -LocalAppDataRoot (Join-Path $uninstallDryRunRoot "LocalAppData") `
        -MachineReportPath $uninstallReportPath `
        -SkipScheduledTaskRemoval `
        -SkipServiceRemoval `
        -DryRun | Out-Null
    $uninstallReport = Get-Content -Raw -LiteralPath $uninstallReportPath | ConvertFrom-Json
    Assert-Equal $uninstallReport.status "success" "Uninstaller dry-run against this fixture must succeed."
    Assert-Equal $uninstallReport.dryRun $true "Uninstaller report must record dryRun=true."
    Assert-True (Test-Path -LiteralPath (Join-Path $udrLegacyRoot "legacy-loose-file.txt") -PathType Leaf) "Uninstaller -DryRun must not remove anything -- the loose legacy file must still exist."
    foreach ($anchorRecord in $uninstallReport.uninstall.anchors) {
        Assert-Equal $anchorRecord.preserved $true "Every anchor record in the dry-run report must show preserved=true: $($anchorRecord.path)"
    }

    # =====================================================================
    Write-Host "Test bounded Codex config edit preserves everything outside the two managed sections byte-for-byte"
    # =====================================================================
    $codexRoot = New-TestScratchDirectory -Label "codex-config"
    $scratchRoots.Add($codexRoot)
    $codexConfigPath = Join-Path $codexRoot "config.toml"
    $codexConfigContent = @(
        "[some_other_section]",
        'value = "keep-me"',
        "",
        "[mcp_servers.revAgent]",
        'command = "node"',
        'args = ["C:\\old\\runtime\\index.js"]',
        "",
        "[mcp_servers.revAgent-api-docs]",
        'command = "node"',
        'args = ["C:\\old\\docs\\index.js"]',
        "",
        "[another_untouched_section]",
        "nested_value = 42",
        ""
    ) -join "`r`n"
    Set-Content -LiteralPath $codexConfigPath -Value $codexConfigContent -Encoding UTF8

    $codexResult = Remove-RevAgentBridgeManagedCodexSections -ConfigPath $codexConfigPath -DryRun $false
    Assert-Equal (@($codexResult.sectionsRemoved) -join ",") "revAgent,revAgent-api-docs" "Both managed legacy sections must be reported removed."
    Assert-True $codexResult.unchangedElsewhere "The edit must be proven structurally bounded to the two managed sections."
    $codexAfter = Get-Content -Raw -LiteralPath $codexConfigPath
    Assert-True ($codexAfter -match '\[some_other_section\]') "Unrelated sections must survive the bounded Codex edit."
    Assert-True ($codexAfter -match 'value = "keep-me"') "Unrelated scalar values must survive the bounded Codex edit byte-for-byte."
    Assert-True ($codexAfter -match '\[another_untouched_section\]') "A section declared after the managed sections must survive untouched."
    Assert-True ($codexAfter -notmatch '\[mcp_servers\.revAgent\]') "The managed revAgent section must be gone."
    Assert-True ($codexAfter -notmatch '\[mcp_servers\.revAgent-api-docs\]') "The managed revAgent-api-docs section must be gone."

    # Idempotent re-run (section already absent) must be a safe no-op.
    $codexResultAgain = Remove-RevAgentBridgeManagedCodexSections -ConfigPath $codexConfigPath -DryRun $false
    Assert-Equal $codexResultAgain.sectionsRemoved.Count 0 "A second run must find nothing left to remove."
    $codexAfterAgain = Get-Content -Raw -LiteralPath $codexConfigPath
    Assert-Equal $codexAfterAgain $codexAfter "A no-op re-run must leave the config byte-identical."

    Write-Host ""
    Write-Host "All EU-20 Bridge installer/uninstaller focused tests passed." -ForegroundColor Green
}
finally {
    foreach ($root in $scratchRoots) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}
