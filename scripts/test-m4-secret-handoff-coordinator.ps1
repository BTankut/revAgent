<#
.SYNOPSIS
    Deterministic, network-free tests for the M4 two-host relay core.
#>

[CmdletBinding()]
param([string]$RepoRoot = "")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-ValueFree {
    param([string]$CaseId, [string]$Visible)
    foreach ($fragment in @(
            "SYNTHETIC-RELAY-SECRET",
            "RELAY-SECRET-HEAD",
            "RELAY-SECRET-MIDDLE",
            "RELAY-SECRET-TAIL"
        )) {
        Assert-True (-not $Visible.Contains($fragment)) "$CaseId leaked a distinguishing synthetic fragment."
    }
}

function New-FixtureStartInfo {
    param(
        [string]$FixturePath,
        [string]$Mode,
        [string]$Kind
    )

    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $start.Arguments = @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", ('"' + $FixturePath.Replace('"', '\"') + '"'),
        "-Mode", $Mode,
        "-Kind", $Kind
    ) -join " "
    $start.UseShellExecute = $false
    # Source and metadata fixtures are output-only. In Windows PowerShell 5.1,
    # redirecting stdin to a -File script makes raw input part of the script
    # pipeline and can echo binary values into diagnostics.
    $start.RedirectStandardInput = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.CreateNoWindow = $true
    return $start
}

function New-ReceiverStartInfo {
    param(
        [string]$ReceiverPath,
        [string]$Kind,
        [string]$Root,
        [string]$ReceiverSha256,
        [switch]$ProbeAbsent
    )

    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $ReceiverPath
    $start.Arguments = @(
        "--contract", "revagent.m4-secret-handoff/v1",
        "--kind", $Kind,
        "--root", ('"' + $Root.Replace('"', '\"') + '"'),
        "--expected-self-sha256", $ReceiverSha256
    ) -join " "
    if ($ProbeAbsent) { $start.Arguments += " --probe-absent true" }
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = -not $ProbeAbsent
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.CreateNoWindow = $true
    return $start
}

function New-ProtectedTestRoot {
    param([string]$Path)

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
    Set-Acl -LiteralPath $Path -AclObject $acl
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
Import-Module (Join-Path $RepoRoot "scripts\M4SecretHandoffCoordinator.psm1") -Force
$wrapperPath = Join-Path $RepoRoot "scripts\invoke-m4-secret-handoff.ps1"
Assert-True (Test-Path -LiteralPath $wrapperPath -PathType Leaf) "M4 two-host wrapper is missing."
$wrapperText = Get-Content -LiteralPath $wrapperPath -Raw -Encoding UTF8
$moduleText = Get-Content -LiteralPath (Join-Path $RepoRoot "scripts\M4SecretHandoffCoordinator.psm1") -Raw -Encoding UTF8
$productionText = $wrapperText + "`n" + $moduleText
foreach ($required in @(
        "BatchMode=yes",
        '"-F", "NUL"',
        '"-p", "22"',
        "StrictHostKeyChecking=yes",
        "UserKnownHostsFile=",
        "GlobalKnownHostsFile=NUL",
        "ProxyCommand=none",
        "ProxyJump=none",
        "IdentitiesOnly=yes",
        "--pull=never",
        "--restart=no",
        "--name",
        "--network=none",
        "--read-only",
        'src=$SourceRoot/runtime/handoff',
        'dst=$containerRoot',
        "docker rm -f",
        "docker ps -a",
        "base64 -d",
        "--expected-self-sha256",
        "--probe-absent"
    )) {
    Assert-True ($productionText.Contains($required)) "M4 two-host seam lost required guard $required."
}
foreach ($forbidden in @("Invoke-Expression", "Start-Process", "Write-Host")) {
    Assert-True (-not $productionText.Contains($forbidden)) "M4 two-host seam contains forbidden surface $forbidden."
}

$fixtureText = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Mode,
    [Parameter(Mandatory = $true)]
    [ValidateSet("north_bearer", "enrollment_artifact")]
    [string]$Kind
)
$ErrorActionPreference = "Stop"
$contract = "revagent.m4-secret-handoff/v1"
$secret = [System.Text.Encoding]::UTF8.GetBytes(
    "SYNTHETIC-RELAY-SECRET__RELAY-SECRET-HEAD__RELAY-SECRET-MIDDLE__RELAY-SECRET-TAIL"
)
function Write-JsonLine([object]$Value) {
    $writer = New-Object System.IO.StreamWriter(
        [Console]::OpenStandardOutput(),
        (New-Object System.Text.UTF8Encoding($false)),
        1024,
        $true
    )
    $writer.NewLine = "`n"
    try {
        $writer.WriteLine(($Value | ConvertTo-Json -Compress))
        $writer.Flush()
    }
    finally {
        $writer.Dispose()
    }
}
function Write-Frame([string]$Magic = "REVAGENT-M4-HANDOFF-V1`n") {
    $magicBytes = [System.Text.Encoding]::ASCII.GetBytes($Magic)
    $frame = New-Object byte[] ($magicBytes.Length + 4 + $secret.Length)
    [Array]::Copy($magicBytes, 0, $frame, 0, $magicBytes.Length)
    [uint32]$length = $secret.Length
    $frame[$magicBytes.Length] = [byte](($length -shr 24) -band 0xff)
    $frame[$magicBytes.Length + 1] = [byte](($length -shr 16) -band 0xff)
    $frame[$magicBytes.Length + 2] = [byte](($length -shr 8) -band 0xff)
    $frame[$magicBytes.Length + 3] = [byte]($length -band 0xff)
    [Array]::Copy($secret, 0, $frame, $magicBytes.Length + 4, $secret.Length)
    $output = [Console]::OpenStandardOutput()
    $output.Write($frame, 0, $frame.Length)
    $output.Flush()
    [Array]::Clear($frame, 0, $frame.Length)
}

try {
    switch ($Mode) {
        "source-success" { Write-Frame; exit 0 }
        "source-success-stderr" {
            [Console]::Error.WriteLine("SYNTHETIC-RELAY-SECRET__RELAY-SECRET-MIDDLE")
            Write-Frame
            exit 0
        }
        "source-fail" { Write-Frame; exit 1 }
        "source-invalid-frame" { Write-Frame -Magic "REVAGENT-M4-HANDOFF-V0`n"; exit 0 }
        "source-timeout" { Start-Sleep -Seconds 10; exit 1 }
        "source-probe" {
            Write-JsonLine ([ordered]@{
                ok = $true
                action = "probe_preproduction_secret_handoff_source_absence"
                contractVersion = $contract
                kind = $Kind
                sourceAbsent = $true
                containerAbsent = $true
            })
            exit 0
        }
        "source-probe-fail" {
            Write-JsonLine ([ordered]@{
                ok = $false
                action = "probe_preproduction_secret_handoff_source_absence"
                contractVersion = $contract
                kind = $Kind
                code = "cleanup_uncertain"
                reason = "cleanup_uncertain"
            })
            exit 79
        }
        "destination-probe-fail" {
            Write-JsonLine ([ordered]@{
                ok = $false
                action = "probe_m4_secret_handoff_absence"
                contractVersion = $contract
                kind = $Kind
                code = "cleanup_uncertain"
                reason = "cleanup_uncertain"
            })
            exit 79
        }
        default { exit 64 }
    }
}
finally {
    [Array]::Clear($secret, 0, $secret.Length)
}
'@

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-m4-coordinator-test-" + [Guid]::NewGuid().ToString("N"))
$publishRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-m4-coordinator-receiver-" + [Guid]::NewGuid().ToString("N"))
$fixturePath = Join-Path $tempRoot "fixture.ps1"
try {
    [System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null
    [System.IO.File]::WriteAllText(
        $fixturePath,
        $fixtureText,
        (New-Object System.Text.UTF8Encoding($false))
    )

    # Prove both ProcessStartInfo.ArgumentList and the Windows PowerShell 5.1
    # fallback preserve the remote command as one byte-for-byte argv value.
    $argvFixturePath = Join-Path $tempRoot "argv-fixture.ps1"
    [System.IO.File]::WriteAllText(
        $argvFixturePath,
        '[Console]::Out.Write((@($args) | ConvertTo-Json -Compress))',
        (New-Object System.Text.UTF8Encoding($false))
    )
    $remoteCommand = 'printf %s QWxwaGE= | base64 -d | sh -c ''test "$value" = "a b"'''
    $expectedArgv = @("plain", $remoteCommand, 'C:\path with spaces\trailing\\')
    foreach ($legacy in @($false, $true)) {
        $argvStart = New-RevAgentProcessStartInfo `
            -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
            -ArgumentVector (@(
                "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
                $argvFixturePath
            ) + $expectedArgv) `
            -ForceLegacyArguments:$legacy
        $argvProcess = New-Object System.Diagnostics.Process
        $argvProcess.StartInfo = $argvStart
        Assert-True $argvProcess.Start() "argv fixture failed to start."
        $argvStdout = $argvProcess.StandardOutput.ReadToEnd()
        $argvStderr = $argvProcess.StandardError.ReadToEnd()
        Assert-True $argvProcess.WaitForExit(10000) "argv fixture timed out."
        Assert-True ($argvProcess.ExitCode -eq 0) "argv fixture failed: $argvStderr"
        $parsedArgv = $argvStdout | ConvertFrom-Json
        $actualArgv = if ($parsedArgv -is [System.Array]) {
            [object[]]$parsedArgv
        }
        else {
            @($parsedArgv)
        }
        Assert-True ($actualArgv.Count -eq $expectedArgv.Count) "argv count drifted."
        for ($argumentIndex = 0; $argumentIndex -lt $expectedArgv.Count; $argumentIndex++) {
            Assert-True ([string]::Equals(
                    [string]$actualArgv[$argumentIndex],
                    [string]$expectedArgv[$argumentIndex],
                    [System.StringComparison]::Ordinal
                )) "argv value $argumentIndex drifted."
        }
        $argvProcess.Dispose()
    }

    # A daemon/sudo failure must terminate the remote cleanup script before it
    # can print success metadata. This executes the production script shape
    # under Git's POSIX shell with a failing sudo function and no network.
    $sourceProbeScript = New-RevAgentSourceCleanupProbeScript `
        -SourceContainerName "revagent-m4-handoff-00000000000000000000000000000000" `
        -ProbeContainerName "revagent-m4-handoff-00000000000000000000000000000000-probe" `
        -SourceUidGid "1000:1000" `
        -SourceRoot "/home/bt/m4-handoff/test" `
        -ImageRef "localhost/revagent-gateway:test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" `
        -Kind "enrollment_artifact" `
        -ExpectedProbeJson '{"ok":true,"action":"probe_preproduction_secret_handoff_source_absence","contractVersion":"revagent.m4-secret-handoff/v1","kind":"enrollment_artifact","sourceAbsent":true}' `
        -CombinedProbeJson '{"ok":true,"action":"probe_preproduction_secret_handoff_source_absence","contractVersion":"revagent.m4-secret-handoff/v1","kind":"enrollment_artifact","sourceAbsent":true,"containerAbsent":true}'
    $gitSh = @(
        "$env:ProgramFiles\Git\bin\sh.exe",
        "$env:ProgramFiles\Git\usr\bin\sh.exe"
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    Assert-True (-not [string]::IsNullOrWhiteSpace($gitSh)) "Git POSIX shell is required for remote cleanup semantics test."
    $shellStart = New-RevAgentProcessStartInfo `
        -FilePath $gitSh `
        -ArgumentVector @("-s") `
        -RedirectInput $true
    $shellProcess = New-Object System.Diagnostics.Process
    $shellProcess.StartInfo = $shellStart
    Assert-True $shellProcess.Start() "remote cleanup semantics fixture failed to start."
    $shellProcess.StandardInput.WriteLine('sudo() { return 42; }')
    $shellProcess.StandardInput.Write($sourceProbeScript)
    $shellProcess.StandardInput.Dispose()
    $shellStdout = $shellProcess.StandardOutput.ReadToEnd()
    $shellStderr = $shellProcess.StandardError.ReadToEnd()
    Assert-True $shellProcess.WaitForExit(10000) "remote cleanup semantics fixture timed out."
    Assert-True ($shellProcess.ExitCode -ne 0) "daemon failure was masked as cleanup success."
    Assert-True (-not $shellStdout.Contains('"sourceAbsent":true')) "daemon failure emitted success metadata."
    Assert-ValueFree -CaseId "daemon-inventory-failure" -Visible ($shellStdout + $shellStderr)
    $shellProcess.Dispose()

    $projectPath = Join-Path $RepoRoot "packages\m4-secret-handoff-receiver\RevAgent.M4.SecretHandoffReceiver.csproj"
    & dotnet publish $projectPath `
        -c Release `
        -r win-x64 `
        --self-contained true `
        --nologo `
        -p:PublishSingleFile=true `
        -p:PublishTrimmed=false `
        -o $publishRoot
    Assert-True ($LASTEXITCODE -eq 0) "Coordinator receiver publish failed."
    $receiverPath = Join-Path $publishRoot "revagent-m4-secret-handoff-receiver.exe"
    Assert-True (Test-Path -LiteralPath $receiverPath -PathType Leaf) "Coordinator receiver executable is missing."
    $receiverSha256 = (Get-FileHash -LiteralPath $receiverPath -Algorithm SHA256).Hash.ToLowerInvariant()

    $cases = @(
        [ordered]@{ Name = "enrollment-success"; Kind = "enrollment_artifact"; Source = "source-success"; SourceProbe = "source-probe"; DestinationProbe = "receiver"; Timeout = 10000; ExitCode = 0; Reason = $null },
        [ordered]@{ Name = "north-refusal"; Kind = "north_bearer"; Source = "source-success"; SourceProbe = "source-probe"; DestinationProbe = "receiver"; Timeout = 10000; ExitCode = 78; Reason = "client_secure_store_unavailable" },
        [ordered]@{ Name = "source-failure-abort"; Kind = "enrollment_artifact"; Source = "source-fail"; SourceProbe = "source-probe"; DestinationProbe = "receiver"; Timeout = 10000; ExitCode = 78; Reason = "handoff_failed" },
        [ordered]@{ Name = "source-stderr-abort"; Kind = "enrollment_artifact"; Source = "source-success-stderr"; SourceProbe = "source-probe"; DestinationProbe = "receiver"; Timeout = 10000; ExitCode = 78; Reason = "handoff_failed" },
        [ordered]@{ Name = "destination-invalid-frame"; Kind = "enrollment_artifact"; Source = "source-invalid-frame"; SourceProbe = "source-probe"; DestinationProbe = "receiver"; Timeout = 10000; ExitCode = 78; Reason = "handoff_failed" },
        [ordered]@{ Name = "source-timeout"; Kind = "enrollment_artifact"; Source = "source-timeout"; SourceProbe = "source-probe"; DestinationProbe = "receiver"; Timeout = 5000; ExitCode = 78; Reason = "handoff_failed" },
        [ordered]@{ Name = "source-cleanup-uncertain"; Kind = "enrollment_artifact"; Source = "source-success"; SourceProbe = "source-probe-fail"; DestinationProbe = "receiver"; Timeout = 10000; ExitCode = 79; Reason = "cleanup_uncertain" },
        [ordered]@{ Name = "destination-cleanup-uncertain"; Kind = "enrollment_artifact"; Source = "source-fail"; SourceProbe = "source-probe"; DestinationProbe = "fixture-fail"; Timeout = 10000; ExitCode = 79; Reason = "cleanup_uncertain" }
    )

    foreach ($case in $cases) {
        $caseRoot = Join-Path $tempRoot $case.Name
        New-ProtectedTestRoot -Path $caseRoot
        $destinationProbe = if ($case.DestinationProbe -eq "receiver") {
            New-ReceiverStartInfo -ReceiverPath $receiverPath -ReceiverSha256 $receiverSha256 -Kind $case.Kind -Root $caseRoot -ProbeAbsent
        }
        else {
            New-FixtureStartInfo -FixturePath $fixturePath -Mode "destination-probe-fail" -Kind $case.Kind
        }
        $result = Invoke-RevAgentM4HandoffCore `
            -Kind $case.Kind `
            -SourceStartInfo (New-FixtureStartInfo -FixturePath $fixturePath -Mode $case.Source -Kind $case.Kind) `
            -DestinationStartInfo (New-ReceiverStartInfo -ReceiverPath $receiverPath -ReceiverSha256 $receiverSha256 -Kind $case.Kind -Root $caseRoot) `
            -SourceProbeStartInfo (New-FixtureStartInfo -FixturePath $fixturePath -Mode $case.SourceProbe -Kind $case.Kind) `
            -DestinationProbeStartInfo $destinationProbe `
            -TimeoutMilliseconds $case.Timeout
        $safeResult = $result | ConvertTo-Json -Compress -Depth 5
        Assert-True ($result.ExitCode -eq $case.ExitCode) "$($case.Name) exit code drifted: $safeResult"
        if ($null -eq $case.Reason) {
            Assert-True ($result.Result.ok -eq $true) "$($case.Name) should succeed."
            Assert-True ($result.Result.outcome -eq "delivered") "$($case.Name) outcome drifted."
        }
        else {
            Assert-True ($result.Result.ok -eq $false) "$($case.Name) should fail closed."
            Assert-True ($result.Result.reason -eq $case.Reason) "$($case.Name) reason drifted."
        }
        $visible = $result.Result | ConvertTo-Json -Compress
        Assert-ValueFree -CaseId $case.Name -Visible $visible

        $destinationPath = Join-Path $caseRoot $(if ($case.Kind -eq "north_bearer") { "north-bearer.bin" } else { "enrollment.json" })
        if ($case.Name -eq "enrollment-success") {
            Assert-True (Test-Path -LiteralPath $destinationPath -PathType Leaf) "Successful destination was not retained."
            Remove-Item -LiteralPath $destinationPath -Force
        }
        else {
            Assert-True (-not (Test-Path -LiteralPath $destinationPath)) "$($case.Name) left destination residue."
        }
    }
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $publishRoot) {
        Remove-Item -LiteralPath $publishRoot -Recurse -Force
    }
}

Write-Host "M4 secret handoff coordinator tests passed." -ForegroundColor Green
