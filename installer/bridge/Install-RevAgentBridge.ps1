<#
.SYNOPSIS
    EU-20/M6 (P3-T9) workstation installer for the revAgent Bridge: verifies
    the signed payload, lays down the P-INST-1 disjoint install/state roots,
    deploys the Revit add-in + deterministic manifest, registers the Bridge
    Windows service, hands off the one-time enrollment token, and emits a
    machine report. Idempotent re-run; -WhatIf/-DryRun performs zero
    mutations.

.DESCRIPTION
    Every machine-mutating step (directory/ACL creation, binary copy,
    service registration, enrollment-artifact write, service start) is
    routed through the single guarded choke point
    Invoke-RevAgentBridgeGuardedMutation from
    installer\bridge\lib\RevAgent.BridgeInstall.psm1. Under -WhatIf or
    -DryRun that function records a 'skipped_dry_run' plan entry and never
    invokes the underlying action -- there is exactly one place a caller
    (or a test) needs to intercept to prove zero mutation.

    This script is repo-preparation for EU-20: the true gate (destructive
    lab-machine install + live Revit read) is NOT exercised here and is not
    granted. Run only against redirected -InstallRoot/-StateRoot/etc. in a
    non-machine-mutating test/dry-run context unless you are the operator
    executing the gated lab session in docs\plan\M6_EU20_LAB_RUNBOOK.md.

.PARAMETER PackageRoot
    Directory containing the signed release payload:
      - bridge-release.json           (signed content: component manifest)
      - bridge-release.json.sig       (detached RS256 signature envelope)
      - host\revagent-bridge-host.exe
      - worker\revagent-bridge.exe (+ dependencies)
      - addin\revAgentPlugin\revAgentPlugin.dll (+ dependencies)

.PARAMETER TrustedKeysPath
    Path to the trusted-keys JSON consumed by
    installer\lib\RevAgent.DistributionIntegrity.psm1's
    Test-RevitMcpDetachedJsonSignatureFile.

.PARAMETER EnrollmentToken
    The single-use, admin-minted P-ENROLL-1 enrollment token. Required for a
    fresh machine; omitted (or ignored) on an idempotent re-run once a
    device credential already exists.

.PARAMETER EnrollmentTokenExpiresAtUtc
    The token's absolute expiry (UTC). Must leave at least 50 seconds and at
    most 24h+5s of remaining lifetime at write time (P-ENROLL-1 TTL cap).
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [Parameter(Mandatory = $true)][string]$TrustedKeysPath,
    [string]$EnrollmentToken = '',
    [Nullable[datetime]]$EnrollmentTokenExpiresAtUtc = $null,
    [string]$RevitVersion = '2022',
    [string]$GatewayHostName = '',
    [string]$InstallRoot = '',
    [string]$StateRoot = '',
    [string]$AddinProgramFilesRoot = '',
    [string]$RevitAddinsRoot = '',
    [string]$MachineReportPath = '',
    [switch]$DryRun,
    [switch]$SkipRevitDetection,
    [switch]$SkipServiceStart
)

$ErrorActionPreference = 'Stop'
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Import-Module (Join-Path $PSScriptRoot 'lib\RevAgent.BridgeInstall.psm1') -Force
Import-Module (Join-Path $RepoRoot 'installer\lib\RevAgent.DistributionIntegrity.psm1') -Force
Import-Module (Join-Path $RepoRoot 'installer\lib\RevAgent.Reporting.psm1') -Force
Import-Module (Join-Path $RepoRoot 'installer\lib\RevAgent.RevitVersions.psm1') -Force

$isDryRun = [bool]$DryRun -or ($WhatIfPreference -eq $true)
$startedAtUtc = (Get-Date).ToUniversalTime()
$steps = [System.Collections.Generic.List[object]]::new()
$reportStatus = 'success'
$reportMessage = 'Install completed.'
$errors = [System.Collections.Generic.List[string]]::new()
$installSummary = [ordered]@{
    revitVersion            = $RevitVersion
    revitDetected            = $null
    addinManifestPath        = $null
    addinManifestSha256      = $null
    serviceName              = 'revAgentBridge'
    enrollmentAttempted      = $false
    enrollmentArtifactWritten = $false
    alreadyEnrolled          = $false
    serviceAlreadyInstalled  = $false
}

function Get-BridgeLayoutArgs {
    $layoutArgs = @{}
    if ($InstallRoot) { $layoutArgs.InstallRoot = $InstallRoot }
    if ($StateRoot) { $layoutArgs.StateRoot = $StateRoot }
    if ($AddinProgramFilesRoot) { $layoutArgs.AddinProgramFilesRoot = $AddinProgramFilesRoot }
    if ($RevitAddinsRoot) { $layoutArgs.RevitAddinsRoot = $RevitAddinsRoot }
    return $layoutArgs
}

try {
    $bridgeLayoutArgs = Get-BridgeLayoutArgs
    $layout = Get-RevAgentBridgeLayout @bridgeLayoutArgs
    $addinLayout = Get-RevAgentBridgeAddinLayout -Layout $layout -RevitVersion $RevitVersion

    # Every directory create/write below is guarded (New-RevAgentGuardedDirectory /
    # Write-RevAgentGuardedAtomicBytes / Assert-RevAgentExistingPathNoLink from
    # installer\lib\RevAgent.Reporting.psm1), which refuses to walk through a
    # reparse point (junction/symlink) anywhere between GuardRoot and the
    # target and throws before any bytes are written. GuardRoot must already
    # exist, so each top-level root is guarded from its own drive root (the
    # one ancestor guaranteed to pre-exist); once a root is created and
    # verified, deeper paths under it are guarded from that root instead.
    $installRootGuard = [System.IO.Path]::GetPathRoot($layout.InstallRoot)
    $stateRootGuard = [System.IO.Path]::GetPathRoot($layout.StateRoot)
    $addinProgramFilesGuard = [System.IO.Path]::GetPathRoot($addinLayout.AddinBinRoot)
    $revitAddinsGuard = [System.IO.Path]::GetPathRoot($addinLayout.ManifestDirectory)

    # --- 1. Signature verification (fails closed; nothing below runs on failure) ---
    $contentPath = Join-Path $PackageRoot 'bridge-release.json'
    $signaturePath = Join-Path $PackageRoot 'bridge-release.json.sig'
    if (-not (Test-Path -LiteralPath $TrustedKeysPath -PathType Leaf)) {
        throw "trusted_keys_missing: $TrustedKeysPath"
    }
    $trustedKeysRaw = Get-Content -Raw -LiteralPath $TrustedKeysPath | ConvertFrom-Json
    $trustedKeys = ConvertTo-RevitMcpTrustedKeyMap -TrustedKeys $trustedKeysRaw
    $verifiedContent = $null
    $verification = Test-RevitMcpDetachedJsonSignatureFile `
        -ContentPath $contentPath `
        -SignaturePath $signaturePath `
        -TrustedKeys $trustedKeys `
        -AllowedSignedObjects @('release-manifest') `
        -VerifiedContent ([ref]$verifiedContent)
    if (-not [bool]$verification.success) {
        throw "signature_verification_failed: $($verification.reason) $($verification.message)"
    }
    [void]$steps.Add([pscustomobject][ordered]@{ target = $contentPath; action = 'verify_signature'; status = 'verified'; detail = $null })

    # --- 2. Component hash verification against the signed manifest ---
    $hostSourcePath = Join-Path $PackageRoot ([string]$verifiedContent.host.relativePath)
    $workerSourceDirectory = Join-Path $PackageRoot ([string]$verifiedContent.worker.relativeDirectory)
    $addinSourceDirectory = Join-Path $PackageRoot ([string]$verifiedContent.addin.relativeDirectory)
    foreach ($componentCheck in @(
            @{ Path = $hostSourcePath; ExpectedSha256 = [string]$verifiedContent.host.sha256; Label = 'host executable'; IsDirectory = $false }
        )) {
        if (-not (Test-Path -LiteralPath $componentCheck.Path -PathType Leaf)) {
            throw "signed_component_missing: $($componentCheck.Label) not found at $($componentCheck.Path)"
        }
        $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $componentCheck.Path).Hash
        if (-not [string]::Equals($actualSha256, $componentCheck.ExpectedSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "signed_component_hash_mismatch: $($componentCheck.Label) does not match the signed manifest. path=$($componentCheck.Path)"
        }
    }
    foreach ($directoryCheck in @(
            @{ Path = $workerSourceDirectory; ExpectedSha256 = [string]$verifiedContent.worker.sha256; Label = 'worker payload' },
            @{ Path = $addinSourceDirectory; ExpectedSha256 = [string]$verifiedContent.addin.sha256; Label = 'addin payload' }
        )) {
        if (-not (Test-Path -LiteralPath $directoryCheck.Path -PathType Container)) {
            throw "signed_component_missing: $($directoryCheck.Label) not found at $($directoryCheck.Path)"
        }
        $actualTreeSha256 = Get-RevAgentBridgeDirectoryTreeSha256 -Path $directoryCheck.Path
        if (-not [string]::Equals($actualTreeSha256, $directoryCheck.ExpectedSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "signed_component_hash_mismatch: $($directoryCheck.Label) does not match the signed manifest. path=$($directoryCheck.Path)"
        }
    }
    [void]$steps.Add([pscustomobject][ordered]@{ target = $PackageRoot; action = 'verify_component_hashes'; status = 'verified'; detail = $null })

    # --- 3. Revit-version presence (reuses installer\lib\RevAgent.RevitVersions.psm1 detection) ---
    if (-not $SkipRevitDetection) {
        try {
            $revitInstallRoot = Resolve-RevitMcpInstallRoot -Version $RevitVersion -RepoRoot $RepoRoot
            $installSummary.revitDetected = $revitInstallRoot
        }
        catch {
            throw "revit_not_detected: $($_.Exception.Message)"
        }
    }

    # --- 4. Idempotent-rerun probes (read-only) ---
    $serviceAlreadyExists = $false
    try {
        $existingService = Get-Service -Name $layout.ServiceName -ErrorAction SilentlyContinue
        $serviceAlreadyExists = ($null -ne $existingService)
    }
    catch { $serviceAlreadyExists = $false }
    $installSummary.serviceAlreadyInstalled = $serviceAlreadyExists

    $deviceCredentialAlreadyExists = Test-Path -LiteralPath $layout.DeviceCredentialPath -PathType Leaf
    $installSummary.alreadyEnrolled = $deviceCredentialAlreadyExists

    # --- 5. Install root + state root + credential directory (ACL'd) ---
    [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.InstallRoot -MutationAction 'create_install_root' -DryRun $isDryRun -Steps $steps -Apply {
            [void](New-RevAgentGuardedDirectory -Path $layout.InstallRoot -GuardRoot $installRootGuard)
            Set-RevAgentBridgeDistributionAcl -Path $layout.InstallRoot
            return $layout.InstallRoot
        }.GetNewClosure())
    [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.CurrentWorkerDirectory -MutationAction 'create_worker_directory' -DryRun $isDryRun -Steps $steps -Apply {
            [void](New-RevAgentGuardedDirectory -Path $layout.CurrentWorkerDirectory -GuardRoot $layout.InstallRoot)
            return $layout.CurrentWorkerDirectory
        })
    [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.StateRoot -MutationAction 'create_state_root' -DryRun $isDryRun -Steps $steps -Apply {
            [void](New-RevAgentGuardedDirectory -Path $layout.StateRoot -GuardRoot $stateRootGuard)
            Set-RevAgentBridgeDistributionAcl -Path $layout.StateRoot
            return $layout.StateRoot
        }.GetNewClosure())
    [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.CredentialDirectory -MutationAction 'create_credential_directory' -DryRun $isDryRun -Steps $steps -Apply {
            [void](New-RevAgentGuardedDirectory -Path $layout.CredentialDirectory -GuardRoot $layout.StateRoot)
            Set-RevAgentBridgeSystemOnlyAcl -Path $layout.CredentialDirectory
            return $layout.CredentialDirectory
        })

    # --- 6. Copy signed binaries into the disjoint install root ---
    [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.HostExecutablePath -MutationAction 'deploy_host_executable' -DryRun $isDryRun -Steps $steps -Apply {
            [void](Assert-RevAgentExistingPathNoLink -Path $layout.HostExecutablePath -GuardRoot $layout.InstallRoot)
            Copy-Item -LiteralPath $hostSourcePath -Destination $layout.HostExecutablePath -Force
            return $layout.HostExecutablePath
        })
    [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.CurrentWorkerDirectory -MutationAction 'deploy_worker_payload' -DryRun $isDryRun -Steps $steps -Apply {
            [void](Assert-RevAgentExistingPathNoLink -Path $layout.CurrentWorkerDirectory -GuardRoot $layout.InstallRoot)
            Copy-Item -LiteralPath (Join-Path $workerSourceDirectory '*') -Destination $layout.CurrentWorkerDirectory -Recurse -Force
            return $layout.CurrentWorkerDirectory
        })

    # --- 7. bridge-config.json (Gateway DNS name only, never an IP -- P-INST-1) ---
    # Uses [System.Net.IPAddress]::TryParse (not a hand-rolled regex) so both
    # IPv4 and every IPv6 literal form (bracketed "[fe80::1]", bare "::1",
    # zone-qualified "fe80::1%eth0") are refused, not just dotted-quad IPv4.
    if ($GatewayHostName) {
        $gatewayHostForIpCheck = $GatewayHostName
        if ($gatewayHostForIpCheck.StartsWith('[') -and $gatewayHostForIpCheck.EndsWith(']') -and $gatewayHostForIpCheck.Length -ge 2) {
            $gatewayHostForIpCheck = $gatewayHostForIpCheck.Substring(1, $gatewayHostForIpCheck.Length - 2)
        }
        $zoneIndex = $gatewayHostForIpCheck.IndexOf('%')
        if ($zoneIndex -ge 0) {
            $gatewayHostForIpCheck = $gatewayHostForIpCheck.Substring(0, $zoneIndex)
        }
        $parsedGatewayIp = $null
        if ([System.Net.IPAddress]::TryParse($gatewayHostForIpCheck, [ref]$parsedGatewayIp)) {
            throw "gateway_host_must_not_be_ip: $GatewayHostName"
        }
    }
    [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.ConfigurationPath -MutationAction 'write_bridge_config' -DryRun $isDryRun -Steps $steps -Apply {
            $config = [ordered]@{
                schemaVersion  = 1
                gatewayHostName = $GatewayHostName
                revitVersion    = $RevitVersion
            }
            $json = ($config | ConvertTo-Json)
            $encoding = [System.Text.UTF8Encoding]::new($false, $true)
            [void](Write-RevAgentGuardedAtomicBytes -Path $layout.ConfigurationPath -Bytes ($encoding.GetBytes($json)) -GuardRoot $layout.StateRoot)
            return $layout.ConfigurationPath
        })

    # --- 8. Add-in payload + deterministic manifest (P-INST-1 / P3-T9) ---
    [void](Invoke-RevAgentBridgeGuardedMutation -Target $addinLayout.AddinBinRoot -MutationAction 'deploy_addin_payload' -DryRun $isDryRun -Steps $steps -Apply {
            [void](New-RevAgentGuardedDirectory -Path $addinLayout.AddinBinRoot -GuardRoot $addinProgramFilesGuard)
            Copy-Item -LiteralPath (Join-Path $addinSourceDirectory '*') -Destination $addinLayout.AddinBinRoot -Recurse -Force
            Set-RevAgentBridgeDistributionAcl -Path $addinLayout.AddinBinRoot
            return $addinLayout.AddinBinRoot
        }.GetNewClosure())
    $manifestContract = New-RevAgentBridgeAddinManifestContract -AssemblyPath $addinLayout.AssemblyPath
    $installSummary.addinManifestPath = $addinLayout.ManifestPath
    $installSummary.addinManifestSha256 = $manifestContract.sha256
    [void](Invoke-RevAgentBridgeGuardedMutation -Target $addinLayout.ManifestPath -MutationAction 'write_addin_manifest' -DryRun $isDryRun -Steps $steps -Apply {
            [void](New-RevAgentGuardedDirectory -Path $addinLayout.ManifestDirectory -GuardRoot $revitAddinsGuard)
            [void](Write-RevAgentGuardedAtomicBytes -Path $addinLayout.ManifestPath -Bytes $manifestContract.bytes -GuardRoot $addinLayout.ManifestDirectory)
            Set-RevAgentBridgeDistributionAcl -Path $addinLayout.ManifestDirectory
            return $manifestContract.sha256
        }.GetNewClosure())

    # --- 9. Service registration (reuses the Bridge Host's own `install` verb -- P3-T2) ---
    if (-not $serviceAlreadyExists) {
        [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.ServiceName -MutationAction 'register_service' -DryRun $isDryRun -Steps $steps -Apply {
                $output = & $layout.HostExecutablePath 'install' 2>&1
                if ($LASTEXITCODE -ne 0) {
                    throw "bridge_host_install_failed: exit=$LASTEXITCODE output=$output"
                }
                return "$($layout.HostExecutablePath) install"
            })
    }
    else {
        [void]$steps.Add([pscustomobject][ordered]@{ target = $layout.ServiceName; action = 'register_service'; status = 'skipped_already_registered'; detail = $null })
    }

    # --- 10. One-time enrollment: write the M4 artifact for the bridge to consume on first start ---
    if ($deviceCredentialAlreadyExists) {
        [void]$steps.Add([pscustomobject][ordered]@{ target = $layout.EnrollmentArtifactPath; action = 'write_enrollment_artifact'; status = 'skipped_already_enrolled'; detail = $null })
    }
    elseif ([string]::IsNullOrWhiteSpace($EnrollmentToken)) {
        throw "enrollment_token_required: no device credential exists yet and -EnrollmentToken was not supplied."
    }
    else {
        if ($null -eq $EnrollmentTokenExpiresAtUtc) {
            throw "enrollment_token_expiry_required: -EnrollmentTokenExpiresAtUtc must accompany -EnrollmentToken."
        }
        # Fails closed here (before any write) on bad shape/expiry.
        $artifactBytes = New-RevAgentBridgeEnrollmentArtifactBytes -EnrollmentToken $EnrollmentToken -ExpiresAtUtc $EnrollmentTokenExpiresAtUtc
        $installSummary.enrollmentAttempted = $true
        [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.EnrollmentArtifactPath -MutationAction 'write_enrollment_artifact' -DryRun $isDryRun -Steps $steps -Apply {
                [void](Write-RevAgentGuardedAtomicBytes -Path $layout.EnrollmentArtifactPath -Bytes $artifactBytes -GuardRoot $layout.CredentialDirectory)
                Set-RevAgentBridgeSystemOnlyAcl -Path $layout.EnrollmentArtifactPath
                return $layout.EnrollmentArtifactPath
            }.GetNewClosure())
        $installSummary.enrollmentArtifactWritten = $true
    }

    # --- 11. Start the service so the worker consumes the artifact and connects ---
    if (-not $SkipServiceStart) {
        $needsStart = $true
        try {
            $currentService = Get-Service -Name $layout.ServiceName -ErrorAction SilentlyContinue
            $needsStart = ($null -eq $currentService) -or ($currentService.Status -ne 'Running')
        }
        catch { $needsStart = $true }
        if ($needsStart) {
            [void](Invoke-RevAgentBridgeGuardedMutation -Target $layout.ServiceName -MutationAction 'start_service' -DryRun $isDryRun -Steps $steps -Apply {
                    Start-Service -Name $layout.ServiceName
                    return 'started'
                })
        }
        else {
            [void]$steps.Add([pscustomobject][ordered]@{ target = $layout.ServiceName; action = 'start_service'; status = 'skipped_already_running'; detail = $null })
        }
    }

    $reportMessage = if ($isDryRun) { 'Dry run completed; zero mutations performed.' } else { 'Install completed.' }
}
catch {
    $reportStatus = 'failed'
    $reportMessage = $_.Exception.Message
    [void]$errors.Add($_.Exception.Message)
}

$completedAtUtc = (Get-Date).ToUniversalTime()
$report = New-RevAgentBridgeMachineReport `
    -Action 'install' `
    -DryRun $isDryRun `
    -StartedAtUtc $startedAtUtc `
    -CompletedAtUtc $completedAtUtc `
    -Status $reportStatus `
    -Message $reportMessage `
    -Steps $steps `
    -Install ([pscustomobject]$installSummary) `
    -Errors $errors.ToArray()

try {
    $reportLayoutArgs = Get-BridgeLayoutArgs
    $layoutForReport = Get-RevAgentBridgeLayout @reportLayoutArgs
    [void](Write-RevAgentBridgeMachineReport -Report $report -ReportsDirectory $layoutForReport.ReportsDirectory -DryRun $isDryRun)
}
catch {
    # Report persistence failure never masks the primary install outcome.
    [void]$errors.Add("report_persistence_failed: $($_.Exception.Message)")
}

if ($MachineReportPath) {
    $reportJson = ($report | ConvertTo-Json -Depth 10)
    $reportDirectory = Split-Path -Parent $MachineReportPath
    if ($reportDirectory -and -not (Test-Path -LiteralPath $reportDirectory)) {
        [void](New-Item -ItemType Directory -Path $reportDirectory -Force)
    }
    Set-Content -LiteralPath $MachineReportPath -Value $reportJson -Encoding UTF8
}

Write-Output ([pscustomobject]$report)

if ($reportStatus -ne 'success') {
    throw $reportMessage
}
