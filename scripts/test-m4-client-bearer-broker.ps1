param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-ExactFields {
    param([object]$Value, [string[]]$Expected, [string]$Label)
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    Assert-True (($actual -join "|") -ceq ($wanted -join "|")) "$Label field set drifted."
}

function Assert-NoSyntheticEvidence {
    param(
        [AllowEmptyString()][string]$Value,
        [string]$Label,
        [string]$Whole,
        [string[]]$Fragments
    )
    Assert-True ($Value.IndexOf($Whole, [StringComparison]::Ordinal) -lt 0) "$Label leaked the whole synthetic canary."
    foreach ($fragment in $Fragments) {
        Assert-True ($Value.IndexOf($fragment, [StringComparison]::Ordinal) -lt 0) "$Label leaked a distinguishing synthetic fragment."
    }
}

function ConvertTo-BrokerTestCommandLineArgument {
    param([AllowEmptyString()][string]$Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $backslashes++; continue }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) { [void]$builder.Append(('\' * $backslashes)); $backslashes = 0 }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Invoke-Broker {
    param(
        [string]$Executable,
        [string[]]$Arguments,
        [byte[]]$InputBytes = @()
    )

    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    if ($start.PSObject.Properties.Name -contains 'ArgumentList') {
        foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
    }
    else {
        $start.Arguments = (@($Arguments | ForEach-Object {
            ConvertTo-BrokerTestCommandLineArgument -Value $_
        }) -join ' ')
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $started = $false
    try {
        $started = $process.Start()
        Assert-True $started "Broker process did not start."
        if ($InputBytes.Length -gt 0) {
            $process.StandardInput.BaseStream.Write($InputBytes, 0, $InputBytes.Length)
            $process.StandardInput.BaseStream.Flush()
        }
        $process.StandardInput.Close()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        Assert-True $process.WaitForExit(30000) "Broker process timed out."
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = $stdoutTask.GetAwaiter().GetResult()
            Stderr = $stderrTask.GetAwaiter().GetResult()
        }
    }
    finally {
        if ($started) {
            try {
                if (-not $process.HasExited) {
                    if ($PSVersionTable.PSEdition -eq 'Core') { $process.Kill($true) }
                    else { $process.Kill() }
                }
            }
            catch {}
        }
        $process.Dispose()
    }
}

function New-ProtectedRoot {
    param([string]$Path)
    [void][IO.Directory]::CreateDirectory($Path)
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [Security.Principal.SecurityIdentifier]::new(
        [Security.Principal.WellKnownSidType]::LocalSystemSid,
        $null)
    $admins = [Security.Principal.SecurityIdentifier]::new(
        [Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid,
        $null)
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($current)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($current, $system, $admins)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit",
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow)
        [void]$acl.AddAccessRule($rule)
    }
    $directory = [System.IO.DirectoryInfo]::new($Path)
    if ('System.IO.FileSystemAclExtensions' -as [type]) {
        [System.IO.FileSystemAclExtensions]::SetAccessControl($directory, $acl)
    }
    else {
        $directory.SetAccessControl($acl)
    }
}

function New-HandoffFrame {
    param([string]$Payload, [bool]$Committed = $true, [string]$Magic = "REVAGENT-M4-HANDOFF-V1`n")
    $payloadBytes = [Text.Encoding]::ASCII.GetBytes($Payload)
    $magicBytes = [Text.Encoding]::ASCII.GetBytes($Magic)
    $stream = [IO.MemoryStream]::new()
    try {
        $stream.Write($magicBytes, 0, $magicBytes.Length)
        $length = [BitConverter]::GetBytes([uint32]$payloadBytes.Length)
        if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($length) }
        $stream.Write($length, 0, $length.Length)
        $stream.Write($payloadBytes, 0, $payloadBytes.Length)
        $stream.WriteByte($(if ($Committed) { 1 } else { 0 }))
        return ,$stream.ToArray()
    }
    finally {
        [Array]::Clear($payloadBytes, 0, $payloadBytes.Length)
        $stream.Dispose()
    }
}

$project = Join-Path $RepoRoot "packages\m4-client-bearer-broker\RevAgent.M4.ClientBearerBroker.csproj"
$testProject = Join-Path $RepoRoot "packages\m4-client-bearer-broker\tests\RevAgent.M4.ClientBearerBroker.Tests.csproj"
$packageRoot = Split-Path -Parent $project
$tempBase = Join-Path ([IO.Path]::GetTempPath()) "revagent-m4-client-bearer-broker-tests"
$tempRoot = Join-Path $tempBase ([Guid]::NewGuid().ToString("N"))
$publishRoot = Join-Path $tempRoot "publish"
$protectedRoot = Join-Path $tempRoot "store"
$canary = "SYNTHETIC-HEAD-A4-MIDDLE-BROKER-X-TAIL-NOT-SECRET-0123456789ABCD"
$canaryFragments = @(
    "SYNTHETIC-HEAD-A4",
    "MIDDLE-BROKER-X",
    "TAIL-NOT-SECRET"
)

try {
    [void][IO.Directory]::CreateDirectory($publishRoot)
    & dotnet restore $testProject --ignore-failed-sources
    if ($LASTEXITCODE -ne 0) { throw "Broker test restore failed." }
    & dotnet build $testProject -c Release --no-restore
    if ($LASTEXITCODE -ne 0) { throw "Broker test build failed." }
    & dotnet run --project $testProject -c Release --no-build
    if ($LASTEXITCODE -ne 0) { throw "Broker unit tests failed." }

    & dotnet publish $project -c Release --no-restore -o $publishRoot
    if ($LASTEXITCODE -ne 0) { throw "Broker self-contained publish failed." }
    $executable = Join-Path $publishRoot "revagent-m4-client-bearer-broker.exe"
    Assert-True (Test-Path -LiteralPath $executable -PathType Leaf) "Published broker executable is absent."
    $selfHash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    New-ProtectedRoot -Path $protectedRoot

    $common = @(
        "--contract", "revagent.m4-secret-handoff/v1",
        "--kind", "north_bearer",
        "--root", $protectedRoot,
        "--expected-self-sha256", $selfHash,
        "--destination-disposition", "current_user_dpapi_broker_v1"
    )
    $frame = New-HandoffFrame -Payload $canary
    try {
        $receive = Invoke-Broker -Executable $executable -Arguments $common -InputBytes $frame
    }
    finally {
        [Array]::Clear($frame, 0, $frame.Length)
    }
    Assert-True ($receive.ExitCode -eq 0) ("Broker receive failed with fixed metadata: exit={0}; stdout={1}; stderr={2}" -f `
        $receive.ExitCode,
        $receive.Stdout.Trim(),
        $receive.Stderr.Trim())
    Assert-True ([string]::IsNullOrEmpty($receive.Stderr)) "Broker receive wrote stderr."
    Assert-NoSyntheticEvidence `
        -Value ($receive.Stdout + $receive.Stderr) `
        -Label "Receive public output" `
        -Whole $canary `
        -Fragments $canaryFragments
    $receiveJson = $receive.Stdout | ConvertFrom-Json
    Assert-ExactFields $receiveJson @(
        "ok", "action", "contractVersion", "kind", "destinationDisposition",
        "destinationCreated", "protectionScope", "aclProtected", "linkCount"
    ) "Receive success"
    Assert-True ($receiveJson.ok -eq $true) "Receive did not report success."
    Assert-True ($receiveJson.action -ceq "receive_m4_secret_handoff") "Receive action drifted."
    Assert-True ($receiveJson.destinationDisposition -ceq "current_user_dpapi_broker_v1") "Receive disposition drifted."
    Assert-True ($receiveJson.protectionScope -ceq "current_user_dpapi") "DPAPI scope drifted."

    $store = Join-Path $protectedRoot "north-bearer.dpapi"
    $ciphertext = [IO.File]::ReadAllBytes($store)
    try {
        $ciphertextText = [Text.Encoding]::ASCII.GetString($ciphertext)
        Assert-NoSyntheticEvidence `
            -Value $ciphertextText `
            -Label "DPAPI ciphertext" `
            -Whole $canary `
            -Fragments $canaryFragments
    }
    finally {
        [Array]::Clear($ciphertext, 0, $ciphertext.Length)
    }

    $cleanup = Invoke-Broker -Executable $executable -Arguments ($common + @("--cleanup", "true"))
    Assert-True ($cleanup.ExitCode -eq 0) "Broker cleanup failed."
    $cleanupJson = $cleanup.Stdout | ConvertFrom-Json
    Assert-ExactFields $cleanupJson @("ok", "action", "contractVersion", "kind", "destinationAbsent") "Cleanup success"
    Assert-True ($cleanupJson.destinationAbsent -eq $true) "Cleanup did not positively prove absence."
    Assert-True (-not (Test-Path -LiteralPath $store)) "DPAPI store remains after cleanup."
    Assert-NoSyntheticEvidence `
        -Value ($cleanup.Stdout + $cleanup.Stderr) `
        -Label "Cleanup public output" `
        -Whole $canary `
        -Fragments $canaryFragments

    $probe = Invoke-Broker -Executable $executable -Arguments ($common + @("--probe-absent", "true"))
    Assert-True ($probe.ExitCode -eq 0) "Broker absence probe failed."
    $probeJson = $probe.Stdout | ConvertFrom-Json
    Assert-ExactFields $probeJson @("ok", "action", "contractVersion", "kind", "destinationAbsent") "Probe success"
    Assert-True ($probeJson.destinationAbsent -eq $true) "Probe did not prove absence."
    Assert-NoSyntheticEvidence `
        -Value ($probe.Stdout + $probe.Stderr) `
        -Label "Probe public output" `
        -Whole $canary `
        -Fragments $canaryFragments

    $wrongIdentityArgs = @(
        "--contract", "revagent.m4-secret-handoff/v1",
        "--kind", "north_bearer",
        "--root", $protectedRoot,
        "--expected-self-sha256", ("0" * 64),
        "--destination-disposition", "current_user_dpapi_broker_v1"
    )
    $identityRefusal = Invoke-Broker -Executable $executable -Arguments $wrongIdentityArgs
    Assert-True ($identityRefusal.ExitCode -eq 78) "Wrong broker digest did not fail closed."
    Assert-True (-not (Test-Path -LiteralPath $store)) "Identity refusal created credential residue."
    Assert-NoSyntheticEvidence `
        -Value ($identityRefusal.Stdout + $identityRefusal.Stderr) `
        -Label "Identity-refusal public output" `
        -Whole $canary `
        -Fragments $canaryFragments

    $invalidFrame = New-HandoffFrame -Payload $canary -Magic "SYNTHETIC-BAD-MAGIC`n"
    try {
        $refusal = Invoke-Broker -Executable $executable -Arguments $common -InputBytes $invalidFrame
    }
    finally {
        [Array]::Clear($invalidFrame, 0, $invalidFrame.Length)
    }
    Assert-True ($refusal.ExitCode -eq 78) "Invalid frame did not fail closed."
    Assert-NoSyntheticEvidence `
        -Value ($refusal.Stdout + $refusal.Stderr) `
        -Label "Frame-refusal public output" `
        -Whole $canary `
        -Fragments $canaryFragments
    Assert-True (-not (Test-Path -LiteralPath $store)) "Refused receive left residue."

    $productionSources = @(Get-ChildItem -LiteralPath $packageRoot -File -Filter "*.cs")
    foreach ($source in $productionSources) {
        $text = [IO.File]::ReadAllText($source.FullName)
        Assert-True ($text.IndexOf("GetEnvironmentVariable", [StringComparison]::Ordinal) -lt 0) "Environment credential input appeared."
        Assert-True ($text.IndexOf("--bearer", [StringComparison]::Ordinal) -lt 0) "Bearer argv input appeared."
    }
    $projectText = [IO.File]::ReadAllText($project)
    Assert-True ($projectText.IndexOf("PackageReference", [StringComparison]::Ordinal) -lt 0) "Broker introduced a package dependency."

    Write-Host "M4 client bearer broker checks passed."
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
        $resolvedBase = [IO.Path]::GetFullPath($tempBase).TrimEnd('\') + '\'
        if ($resolvedTemp.StartsWith($resolvedBase, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }
}
