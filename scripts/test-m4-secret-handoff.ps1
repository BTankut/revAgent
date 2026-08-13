<#
.SYNOPSIS
    CI-safe tests for the M4-04/A2 self-contained Windows binary receiver.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-NoCanary {
    param([string]$CaseId, [string[]]$Values)
    $visible = $Values -join "`n"
    foreach ($fragment in @(
            "SYNTHETIC-",
            "HANDOFF-HEAD",
            "HANDOFF-MIDDLE",
            "HANDOFF-TAIL"
        )) {
        if ($visible.Contains($fragment)) {
            throw "$CaseId leaked a synthetic distinguishing fragment."
        }
    }
}

function Test-ByteArrayEqual {
    param([byte[]]$Left, [byte[]]$Right)
    if ($Left.Length -ne $Right.Length) { return $false }
    for ($index = 0; $index -lt $Left.Length; $index++) {
        if ($Left[$index] -ne $Right[$index]) { return $false }
    }
    return $true
}

function New-ProtectedTestRoot {
    param(
        [string]$Path,
        [switch]$IncludeUsers
    )

    New-Item -ItemType Directory -Path $Path | Out-Null
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier(
        [System.Security.Principal.WellKnownSidType]::LocalSystemSid,
        $null
    )
    $administratorsSid = New-Object System.Security.Principal.SecurityIdentifier(
        [System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid,
        $null
    )
    foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit",
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    if ($IncludeUsers) {
        $usersSid = New-Object System.Security.Principal.SecurityIdentifier(
            [System.Security.Principal.WellKnownSidType]::BuiltinUsersSid,
            $null
        )
        $broadRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $usersSid,
            [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
            [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit",
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($broadRule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
    Assert-True ((Get-Acl -LiteralPath $Path).AreAccessRulesProtected) "Test root ACL must be protected."
}

function Invoke-Receiver {
    param(
        [string]$Kind,
        [string]$Root,
        [byte[]]$SecretBytes,
        [byte[]]$FrameMagicBytes = $null,
        [ValidateSet(0, 1)]
        [int]$ControlByte = 1,
        [string]$ExpectedSelfSha256 = "",
        [switch]$ProbeAbsent
    )

    $expectedHash = if ([string]::IsNullOrEmpty($ExpectedSelfSha256)) {
        $receiverSha256
    }
    else {
        $ExpectedSelfSha256
    }
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $receiverPath
    $start.Arguments = @(
        "--contract", "revagent.m4-secret-handoff/v1",
        "--kind", $Kind,
        "--root", ('"' + $Root.Replace('"', '\"') + '"'),
        "--expected-self-sha256", $expectedHash
    ) -join " "
    if ($ProbeAbsent) {
        $start.Arguments += " --probe-absent true"
    }
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.CreateNoWindow = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    [void]$process.Start()
    $inputStream = $process.StandardInput.BaseStream
    $frameMagic = if ($null -eq $FrameMagicBytes) {
        [System.Text.Encoding]::ASCII.GetBytes("REVAGENT-M4-HANDOFF-V1`n")
    }
    else {
        $FrameMagicBytes
    }
    $framedBytes = New-Object byte[] ($frameMagic.Length + 4 + $SecretBytes.Length + 1)
    [Array]::Copy($frameMagic, 0, $framedBytes, 0, $frameMagic.Length)
    $declaredLength = [uint32]$SecretBytes.Length
    $framedBytes[$frameMagic.Length] = [byte](($declaredLength -shr 24) -band 0xff)
    $framedBytes[$frameMagic.Length + 1] = [byte](($declaredLength -shr 16) -band 0xff)
    $framedBytes[$frameMagic.Length + 2] = [byte](($declaredLength -shr 8) -band 0xff)
    $framedBytes[$frameMagic.Length + 3] = [byte]($declaredLength -band 0xff)
    if ($SecretBytes.Length -gt 0) {
        [Array]::Copy($SecretBytes, 0, $framedBytes, $frameMagic.Length + 4, $SecretBytes.Length)
    }
    $framedBytes[$framedBytes.Length - 1] = [byte]$ControlByte
    if ($framedBytes.Length -gt 0) {
        try {
            $inputStream.Write($framedBytes, 0, $framedBytes.Length)
            $inputStream.Flush()
        }
        catch [System.IO.IOException] {
            # Early fail-closed receivers may close stdin before the fixture
            # finishes its one framed write. The observed result remains the
            # receiver's fixed metadata, never this transport exception.
        }
    }
    [Array]::Clear($framedBytes, 0, $framedBytes.Length)
    $inputStream.Dispose()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    Assert-True ($process.WaitForExit(15000)) "Receiver test exceeded its bounded deadline."
    return [pscustomobject][ordered]@{
        ExitCode = $process.ExitCode
        Stdout = $stdoutTask.GetAwaiter().GetResult()
        Stderr = $stderrTask.GetAwaiter().GetResult()
    }
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$projectPath = Join-Path $RepoRoot "packages\m4-secret-handoff-receiver\RevAgent.M4.SecretHandoffReceiver.csproj"
Assert-True (Test-Path -LiteralPath $projectPath -PathType Leaf) "M4 receiver project is missing."
$publishRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-m4-receiver-publish-" + [Guid]::NewGuid().ToString("N"))
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-m4-handoff-test-" + [Guid]::NewGuid().ToString("N"))
$secretText = "SYNTHETIC-HANDOFF-HEAD__HANDOFF-MIDDLE__HANDOFF-TAIL__DO-NOT-USE"
$secretBytes = [System.Text.Encoding]::UTF8.GetBytes($secretText)
try {
    & dotnet publish $projectPath `
        -c Release `
        -r win-x64 `
        --self-contained true `
        --nologo `
        -p:PublishSingleFile=true `
        -p:PublishTrimmed=false `
        -o $publishRoot
    Assert-True ($LASTEXITCODE -eq 0) "M4 receiver publish failed."
    $receiverPath = Join-Path $publishRoot "revagent-m4-secret-handoff-receiver.exe"
    Assert-True (Test-Path -LiteralPath $receiverPath -PathType Leaf) "M4 receiver executable is missing."
    $receiverSha256 = (Get-FileHash -LiteralPath $receiverPath -Algorithm SHA256).Hash.ToLowerInvariant()

    New-Item -ItemType Directory -Path $tempRoot | Out-Null

    $northRoot = Join-Path $tempRoot "north"
    New-ProtectedTestRoot -Path $northRoot
    $wrongIdentity = Invoke-Receiver `
        -Kind "north_bearer" `
        -Root $northRoot `
        -SecretBytes $secretBytes `
        -ExpectedSelfSha256 ("0" * 64)
    Assert-True ($wrongIdentity.ExitCode -eq 78) "Wrong receiver identity must fail closed."
    $wrongIdentityResult = $wrongIdentity.Stdout | ConvertFrom-Json
    Assert-True ($wrongIdentityResult.reason -eq "receiver_identity_refused") "Receiver identity refusal drifted."
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $northRoot "north-bearer.bin"))) "Identity refusal created a destination."
    Assert-NoCanary -CaseId "receiver-identity-refusal" -Values @($wrongIdentity.Stdout, $wrongIdentity.Stderr)

    $north = Invoke-Receiver -Kind "north_bearer" -Root $northRoot -SecretBytes $secretBytes
    Assert-True ($north.ExitCode -eq 78) "North receiver must fail closed with exit 78."
    Assert-True ([string]::IsNullOrEmpty($north.Stderr)) "North refusal must not use stderr."
    $northResult = $north.Stdout | ConvertFrom-Json
    Assert-True ($northResult.reason -eq "client_secure_store_unavailable") "North refusal reason drifted."
    Assert-True ($northResult.destinationAbsent -eq $true) "North refusal must prove destination absence."
    Assert-NoCanary -CaseId "north-refusal" -Values @($north.Stdout, $north.Stderr)

    $northProbe = Invoke-Receiver `
        -Kind "north_bearer" `
        -Root $northRoot `
        -SecretBytes @() `
        -ProbeAbsent
    Assert-True ($northProbe.ExitCode -eq 0) "North absence probe must pass for an absent destination."
    $northProbeResult = $northProbe.Stdout | ConvertFrom-Json
    Assert-True ($northProbeResult.action -eq "probe_m4_secret_handoff_absence") "North probe action drifted."
    Assert-True ($northProbeResult.destinationAbsent -eq $true) "North probe must positively report absence."
    Assert-NoCanary -CaseId "north-probe" -Values @($northProbe.Stdout, $northProbe.Stderr)

    $enrollmentRoot = Join-Path $tempRoot "enrollment"
    New-ProtectedTestRoot -Path $enrollmentRoot
    $enrollment = Invoke-Receiver -Kind "enrollment_artifact" -Root $enrollmentRoot -SecretBytes $secretBytes
    Assert-True ($enrollment.ExitCode -eq 0) "Enrollment receiver should accept a bounded binary payload."
    Assert-True ([string]::IsNullOrEmpty($enrollment.Stderr)) "Enrollment success must keep stderr empty."
    $enrollmentResult = $enrollment.Stdout | ConvertFrom-Json
    Assert-True ($enrollmentResult.bytes -ge 1 -and $enrollmentResult.bytes -le 4096) "Enrollment byte count was outside bounds."
    Assert-True ($enrollmentResult.destinationCreated -eq $true) "Enrollment destination was not reported created."
    Assert-True ($enrollmentResult.aclProtected -eq $true) "Enrollment file ACL was not reported protected."
    Assert-True ($enrollmentResult.linkCount -eq 1) "Enrollment destination must have one link."
    Assert-NoCanary -CaseId "enrollment-success" -Values @($enrollment.Stdout, $enrollment.Stderr)
    $destination = Join-Path $enrollmentRoot "enrollment.json"
    Assert-True (Test-Path -LiteralPath $destination -PathType Leaf) "Enrollment file does not exist."
    Assert-True ((Get-Acl -LiteralPath $destination).AreAccessRulesProtected) "Enrollment file ACL must be protected."
    $readBack = [System.IO.File]::ReadAllBytes($destination)
    if ($readBack.Length -ne $secretBytes.Length) {
        throw "Enrollment raw length mismatch."
    }
    Assert-True (Test-ByteArrayEqual -Left $secretBytes -Right $readBack) "Enrollment file bytes changed."

    $probePresent = Invoke-Receiver `
        -Kind "enrollment_artifact" `
        -Root $enrollmentRoot `
        -SecretBytes @() `
        -ProbeAbsent
    Assert-True ($probePresent.ExitCode -eq 79) "Presence probe must return cleanup_uncertain."
    $probePresentResult = $probePresent.Stdout | ConvertFrom-Json
    Assert-True ($probePresentResult.action -eq "probe_m4_secret_handoff_absence") "Presence probe action drifted."
    Assert-True ($probePresentResult.code -eq "cleanup_uncertain") "Presence probe code drifted."
    Assert-True ($probePresentResult.reason -eq "cleanup_uncertain") "Presence probe reason drifted."
    Assert-NoCanary -CaseId "probe-present" -Values @($probePresent.Stdout, $probePresent.Stderr)

    $existing = Invoke-Receiver -Kind "enrollment_artifact" -Root $enrollmentRoot -SecretBytes $secretBytes
    Assert-True ($existing.ExitCode -eq 78) "Existing destination must fail closed."
    $existingResult = $existing.Stdout | ConvertFrom-Json
    Assert-True ($existingResult.reason -eq "destination_exists") "Existing destination refusal drifted."
    Assert-NoCanary -CaseId "existing-destination" -Values @($existing.Stdout, $existing.Stderr)
    $afterExisting = [System.IO.File]::ReadAllBytes($destination)
    Assert-True (Test-ByteArrayEqual -Left $secretBytes -Right $afterExisting) "Existing destination was overwritten."

    Remove-Item -LiteralPath $destination -Force
    $aborted = Invoke-Receiver `
        -Kind "enrollment_artifact" `
        -Root $enrollmentRoot `
        -SecretBytes $secretBytes `
        -ControlByte 0
    Assert-True ($aborted.ExitCode -eq 78) "Abort control must fail closed."
    $abortedResult = $aborted.Stdout | ConvertFrom-Json
    Assert-True ($abortedResult.reason -eq "handoff_aborted") "Abort refusal drifted."
    Assert-True ($abortedResult.destinationAbsent -eq $true) "Abort must positively prove destination absence."
    Assert-True (-not (Test-Path -LiteralPath $destination)) "Abort left a destination."
    Assert-NoCanary -CaseId "aborted" -Values @($aborted.Stdout, $aborted.Stderr)

    $probeAbsent = Invoke-Receiver `
        -Kind "enrollment_artifact" `
        -Root $enrollmentRoot `
        -SecretBytes @() `
        -ProbeAbsent
    Assert-True ($probeAbsent.ExitCode -eq 0) "Absence probe must pass after unlink."
    $probeAbsentResult = $probeAbsent.Stdout | ConvertFrom-Json
    Assert-True ($probeAbsentResult.action -eq "probe_m4_secret_handoff_absence") "Absence probe action drifted."
    Assert-True ($probeAbsentResult.destinationAbsent -eq $true) "Absence probe must positively report absence."
    $empty = Invoke-Receiver -Kind "enrollment_artifact" -Root $enrollmentRoot -SecretBytes @()
    Assert-True ($empty.ExitCode -eq 78) "Empty payload must fail closed."
    $emptyResult = $empty.Stdout | ConvertFrom-Json
    Assert-True ($emptyResult.reason -eq "invalid_size") "Empty payload refusal drifted."
    Assert-True ($emptyResult.destinationAbsent -eq $true) "Empty-payload cleanup must prove absence."
    Assert-True (-not (Test-Path -LiteralPath $destination)) "Empty-payload failure left a destination."

    $oversizedBytes = New-Object byte[] 4097
    [Array]::Copy($secretBytes, 0, $oversizedBytes, 0, $secretBytes.Length)
    $oversized = Invoke-Receiver -Kind "enrollment_artifact" -Root $enrollmentRoot -SecretBytes $oversizedBytes
    Assert-True ($oversized.ExitCode -eq 78) "Oversized payload must fail closed."
    $oversizedResult = $oversized.Stdout | ConvertFrom-Json
    Assert-True ($oversizedResult.reason -eq "invalid_size") "Oversized refusal drifted."
    Assert-True ($oversizedResult.destinationAbsent -eq $true) "Oversized cleanup must prove absence."
    Assert-True (-not (Test-Path -LiteralPath $destination)) "Oversized failure left a destination."
    Assert-NoCanary -CaseId "oversized" -Values @($oversized.Stdout, $oversized.Stderr)

    $invalidFrameBytes = [System.Text.Encoding]::ASCII.GetBytes("REVAGENT-M4-HANDOFF-V0`n")
    $invalidFrame = Invoke-Receiver `
        -Kind "enrollment_artifact" `
        -Root $enrollmentRoot `
        -SecretBytes $secretBytes `
        -FrameMagicBytes $invalidFrameBytes
    Assert-True ($invalidFrame.ExitCode -eq 78) "Invalid frame must fail closed."
    $invalidFrameResult = $invalidFrame.Stdout | ConvertFrom-Json
    Assert-True ($invalidFrameResult.reason -eq "invalid_frame") "Invalid-frame refusal drifted."
    Assert-True ($invalidFrameResult.destinationAbsent -eq $true) "Invalid-frame cleanup must prove absence."
    Assert-True (-not (Test-Path -LiteralPath $destination)) "Invalid-frame failure left a destination."
    Assert-NoCanary -CaseId "invalid-frame" -Values @($invalidFrame.Stdout, $invalidFrame.Stderr)

    $unprotectedRoot = Join-Path $tempRoot "unprotected"
    New-Item -ItemType Directory -Path $unprotectedRoot | Out-Null
    $unprotectedAcl = Get-Acl -LiteralPath $unprotectedRoot
    $unprotectedAcl.SetAccessRuleProtection($false, $true)
    Set-Acl -LiteralPath $unprotectedRoot -AclObject $unprotectedAcl
    $unprotected = Invoke-Receiver -Kind "enrollment_artifact" -Root $unprotectedRoot -SecretBytes $secretBytes
    Assert-True ($unprotected.ExitCode -eq 78) "Inherited root ACL must fail closed."
    $unprotectedResult = $unprotected.Stdout | ConvertFrom-Json
    Assert-True ($unprotectedResult.reason -eq "invalid_protected_root") "Unprotected-root refusal drifted."
    Assert-NoCanary -CaseId "unprotected-root" -Values @($unprotected.Stdout, $unprotected.Stderr)

    $broadRoot = Join-Path $tempRoot "broad-protected"
    New-ProtectedTestRoot -Path $broadRoot -IncludeUsers
    $broad = Invoke-Receiver -Kind "enrollment_artifact" -Root $broadRoot -SecretBytes $secretBytes
    Assert-True ($broad.ExitCode -eq 78) "Broad protected root ACL must fail closed."
    $broadResult = $broad.Stdout | ConvertFrom-Json
    Assert-True ($broadResult.reason -eq "invalid_protected_root") "Broad-root refusal drifted."
    Assert-NoCanary -CaseId "broad-root" -Values @($broad.Stdout, $broad.Stderr)
}
finally {
    [Array]::Clear($secretBytes, 0, $secretBytes.Length)
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $publishRoot) {
        Remove-Item -LiteralPath $publishRoot -Recurse -Force
    }
}

Write-Host "M4 secret handoff receiver tests passed." -ForegroundColor Green
