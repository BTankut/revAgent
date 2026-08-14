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

function Assert-ExactProperties {
    param(
        [object]$Value,
        [string[]]$Names,
        [string]$Message
    )

    $actual = if ($Value -is [System.Collections.IDictionary]) {
        @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object)
    }
    else {
        @($Value.PSObject.Properties.Name | Sort-Object)
    }
    $expected = @($Names | Sort-Object)
    Assert-True ($actual.Count -eq $expected.Count) $Message
    for ($index = 0; $index -lt $expected.Count; $index++) {
        Assert-True ([string]::Equals(
                [string]$actual[$index],
                [string]$expected[$index],
                [System.StringComparison]::Ordinal
            )) $Message
    }
}

function New-FixtureStartInfo {
    param(
        [string]$FixturePath,
        [string]$Mode,
        [string]$Kind,
        [string]$ObservationPath = ""
    )

    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $argumentVector = @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", ('"' + $FixturePath.Replace('"', '\"') + '"'),
        "-Mode", $Mode,
        "-Kind", $Kind
    )
    if (-not [string]::IsNullOrWhiteSpace($ObservationPath)) {
        $argumentVector += @(
            "-ObservationPath",
            ('"' + $ObservationPath.Replace('"', '\"') + '"')
        )
    }
    $start.Arguments = $argumentVector -join " "
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

function New-BrokerFixtureStartInfo {
    param(
        [string]$FixturePath,
        [string]$Mode,
        [string]$Root,
        [bool]$RedirectInput = $false
    )

    return New-RevAgentProcessStartInfo `
        -FilePath $FixturePath `
        -ArgumentVector @("--mode", $Mode, "--root", $Root) `
        -RedirectInput $RedirectInput
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
$coordinatorModule = Import-Module `
    (Join-Path $RepoRoot "scripts\M4SecretHandoffCoordinator.psm1") `
    -Force `
    -PassThru

# The explicit broker path uses absolute stage deadlines. Exercise the pure
# budget calculation directly so cleanup/probe reserve is proven without
# depending on how quickly the operating system happens to reap a killed
# fixture process on this machine.
$brokerDeadlines = & $coordinatorModule {
    Get-RevAgentBrokerStageDeadlines -TimeoutMilliseconds 10000
}
Assert-True ($brokerDeadlines.Operation -eq 4000) `
    "Broker operation deadline drifted."
Assert-True ($brokerDeadlines.SourceStop -eq 5000) `
    "Broker source-stop deadline drifted."
Assert-True ($brokerDeadlines.SourceProof -eq 6500) `
    "Broker source-proof deadline drifted."
Assert-True ($brokerDeadlines.DestinationStop -eq 7000) `
    "Broker destination-stop deadline drifted."
Assert-True ($brokerDeadlines.DestinationCleanup -eq 8000) `
    "Broker cleanup deadline drifted."
Assert-True ($brokerDeadlines.DestinationCleanupStop -eq 8500) `
    "Broker cleanup stop deadline drifted."
Assert-True ($brokerDeadlines.DestinationProbe -eq 10000) `
    "Broker destination-probe deadline drifted."
Assert-True (($brokerDeadlines.DestinationProbe -
            $brokerDeadlines.DestinationCleanupStop) -eq 1500) `
    "Broker final absence probe no longer has a reserved budget."

$stopBudgetCases = @(
    [ordered]@{ Elapsed = 1000; Deadline = 6500; Expected = 2000 },
    [ordered]@{ Elapsed = 6499; Deadline = 6500; Expected = 1 },
    [ordered]@{ Elapsed = 6500; Deadline = 6500; Expected = 0 },
    [ordered]@{ Elapsed = 8350; Deadline = 8500; Expected = 150 }
)
foreach ($case in $stopBudgetCases) {
    $actualStopBudget = & $coordinatorModule {
        param($ElapsedMilliseconds, $StopDeadlineMilliseconds)
        Get-RevAgentBoundedStopWaitMilliseconds `
            -ElapsedMilliseconds $ElapsedMilliseconds `
            -StopDeadlineMilliseconds $StopDeadlineMilliseconds
    } $case.Elapsed $case.Deadline
    Assert-True ($actualStopBudget -eq $case.Expected) `
        "Broker stop budget drifted at elapsed=$($case.Elapsed)."
}

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
        "--probe-absent",
        "--destination-disposition",
        "current_user_dpapi_broker_v1",
        "--cleanup true",
        "Get-RevAgentBrokerStageDeadlines",
        "SourceStop",
        "SourceProof",
        "DestinationStop",
        "DestinationCleanupStop",
        '-WaitMilliseconds $waitMilliseconds',
        '[int]$WaitMilliseconds = 2000'
    )) {
    Assert-True ($productionText.Contains($required)) "M4 two-host seam lost required guard $required."
}
Assert-True ($wrapperText -match '\[string\]\$DestinationDisposition = "north_refusal_v1"') `
    "Legacy north refusal is no longer the wrapper default."
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
    [string]$Kind,
    [string]$ObservationPath = ""
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
function Start-InheritedPipeHolder {
    $holderStart = New-Object System.Diagnostics.ProcessStartInfo
    $holderStart.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $holderStart.Arguments = '-NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 15"'
    $holderStart.UseShellExecute = $false
    $holderStart.CreateNoWindow = $true
    $holder = New-Object System.Diagnostics.Process
    $holder.StartInfo = $holderStart
    if (-not $holder.Start()) { throw "pipe_holder_start_failed" }
    $holder.Dispose()
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
        "source-stuck-child" {
            Start-InheritedPipeHolder
            Start-Sleep -Seconds 15
            exit 1
        }
        "source-probe" {
            if (-not [string]::IsNullOrWhiteSpace($ObservationPath)) {
                [System.IO.File]::AppendAllText(
                    $ObservationPath,
                    "source-probe`n",
                    (New-Object System.Text.UTF8Encoding($false))
                )
            }
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
        "source-probe-timeout" { Start-Sleep -Seconds 10; exit 79 }
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

$brokerFixtureText = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

public static class RevAgentM4BrokerCoordinatorFixture
{
    private const string Contract = "revagent.m4-secret-handoff/v1";
    private const string Disposition = "current_user_dpapi_broker_v1";
    private const string StoreName = "broker-store.bin";
    private const string EventName = "events.txt";

    public static int Main(string[] args)
    {
        try
        {
            string mode = ReadArgument(args, "--mode");
            string root = ReadArgument(args, "--root");
            Directory.CreateDirectory(root);
            if (mode.StartsWith("receive-", StringComparison.Ordinal))
            {
                return Receive(mode, root);
            }
            if (mode.StartsWith("cleanup-", StringComparison.Ordinal))
            {
                return Cleanup(mode, root);
            }
            if (String.Equals(mode, "probe", StringComparison.Ordinal))
            {
                return Probe(root);
            }
            return 64;
        }
        catch
        {
            return 70;
        }
    }

    private static int Receive(string mode, string root)
    {
        AppendEvent(root, "receive");
        if (String.Equals(mode, "receive-stuck-child", StringComparison.Ordinal))
        {
            File.WriteAllBytes(Path.Combine(root, StoreName), new byte[] { 0x41, 0x34 });
            StartInheritedPipeHolder();
            Thread.Sleep(15000);
            return 70;
        }
        if (String.Equals(mode, "receive-timeout", StringComparison.Ordinal))
        {
            File.WriteAllBytes(Path.Combine(root, StoreName), new byte[] { 0x41, 0x34 });
            Thread.Sleep(10000);
            return 70;
        }

        Stream input = Console.OpenStandardInput();
        byte[] magic = ReadMagic(input);
        byte[] lengthBytes = ReadExact(input, 4);
        int length = (lengthBytes[0] << 24) | (lengthBytes[1] << 16) |
            (lengthBytes[2] << 8) | lengthBytes[3];
        if (length < 1 || length > 4096)
        {
            return 78;
        }
        byte[] payload = ReadExact(input, length);
        try
        {
            int commit = input.ReadByte();
            if (commit != 1)
            {
                AppendEvent(root, "abort");
                WriteJson("{\"ok\":false,\"action\":\"receive_m4_secret_handoff\",\"contractVersion\":\"" +
                    Contract + "\",\"kind\":\"north_bearer\",\"code\":\"m4_secret_handoff_refused\",\"reason\":\"handoff_failed\",\"destinationAbsent\":true}");
                return 78;
            }
            AppendEvent(root, "commit");
            File.WriteAllBytes(Path.Combine(root, StoreName), new byte[] { 0x41, 0x34 });
            string exact = "{\"ok\":true,\"action\":\"receive_m4_secret_handoff\",\"contractVersion\":\"" +
                Contract + "\",\"kind\":\"north_bearer\",\"destinationDisposition\":\"" +
                Disposition + "\",\"destinationCreated\":true,\"protectionScope\":\"current_user_dpapi\",\"aclProtected\":true,\"linkCount\":1";
            if (String.Equals(mode, "receive-invalid-metadata", StringComparison.Ordinal))
            {
                WriteJson(exact + ",\"unexpected\":true}");
            }
            else
            {
                WriteJson(exact + "}");
            }
            return 0;
        }
        finally
        {
            Array.Clear(payload, 0, payload.Length);
            Array.Clear(lengthBytes, 0, lengthBytes.Length);
            Array.Clear(magic, 0, magic.Length);
        }
    }

    private static byte[] ReadMagic(Stream input)
    {
        byte[] expected = Encoding.ASCII.GetBytes("REVAGENT-M4-HANDOFF-V1\n");
        byte[] first = ReadExact(input, 3);
        byte[] received;
        if (first[0] == 0xef && first[1] == 0xbb && first[2] == 0xbf)
        {
            received = ReadExact(input, expected.Length);
        }
        else
        {
            received = new byte[expected.Length];
            Array.Copy(first, 0, received, 0, first.Length);
            byte[] remaining = ReadExact(input, expected.Length - first.Length);
            Array.Copy(remaining, 0, received, first.Length, remaining.Length);
            Array.Clear(remaining, 0, remaining.Length);
        }
        bool matches = true;
        for (int index = 0; index < expected.Length; index++)
        {
            matches = matches && received[index] == expected[index];
        }
        Array.Clear(first, 0, first.Length);
        Array.Clear(expected, 0, expected.Length);
        if (!matches)
        {
            Array.Clear(received, 0, received.Length);
            throw new InvalidDataException();
        }
        return received;
    }

    private static int Cleanup(string mode, string root)
    {
        AppendEvent(root, "cleanup");
        if (String.Equals(mode, "cleanup-timeout", StringComparison.Ordinal))
        {
            Thread.Sleep(10000);
            return 79;
        }
        string store = Path.Combine(root, StoreName);
        if (!String.Equals(mode, "cleanup-no-remove", StringComparison.Ordinal) && File.Exists(store))
        {
            File.Delete(store);
        }
        string exact = "{\"ok\":true,\"action\":\"cleanup_m4_client_bearer_store\",\"contractVersion\":\"" +
            Contract + "\",\"kind\":\"north_bearer\",\"destinationAbsent\":true";
        if (String.Equals(mode, "cleanup-invalid-metadata", StringComparison.Ordinal))
        {
            WriteJson(exact + ",\"unexpected\":true}");
        }
        else
        {
            WriteJson(exact + "}");
        }
        return 0;
    }

    private static int Probe(string root)
    {
        AppendEvent(root, "probe");
        bool absent = !File.Exists(Path.Combine(root, StoreName));
        WriteJson("{\"ok\":" + (absent ? "true" : "false") +
            ",\"action\":\"probe_m4_secret_handoff_absence\",\"contractVersion\":\"" +
            Contract + "\",\"kind\":\"north_bearer\",\"destinationAbsent\":" +
            (absent ? "true" : "false") + "}");
        return absent ? 0 : 79;
    }

    private static byte[] ReadExact(Stream input, int count)
    {
        byte[] value = new byte[count];
        int offset = 0;
        while (offset < count)
        {
            int read = input.Read(value, offset, count - offset);
            if (read == 0)
            {
                throw new EndOfStreamException();
            }
            offset += read;
        }
        return value;
    }

    private static void StartInheritedPipeHolder()
    {
        string powershell = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "powershell.exe");
        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = powershell;
        start.Arguments = "-NoLogo -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 15\"";
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        Process holder = Process.Start(start);
        if (holder == null)
        {
            throw new InvalidOperationException();
        }
        holder.Dispose();
    }

    private static string ReadArgument(string[] args, string name)
    {
        for (int index = 0; index + 1 < args.Length; index += 2)
        {
            if (String.Equals(args[index], name, StringComparison.Ordinal))
            {
                return args[index + 1];
            }
        }
        throw new ArgumentException();
    }

    private static void AppendEvent(string root, string value)
    {
        File.AppendAllText(Path.Combine(root, EventName), value + "\n", new UTF8Encoding(false));
    }

    private static void WriteJson(string value)
    {
        byte[] bytes = new UTF8Encoding(false).GetBytes(value + "\n");
        Stream output = Console.OpenStandardOutput();
        output.Write(bytes, 0, bytes.Length);
        output.Flush();
        Array.Clear(bytes, 0, bytes.Length);
    }
}
'@

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-m4-coordinator-test-" + [Guid]::NewGuid().ToString("N"))
$publishRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("revagent-m4-coordinator-receiver-" + [Guid]::NewGuid().ToString("N"))
$fixturePath = Join-Path $tempRoot "fixture.ps1"
$brokerFixturePath = Join-Path $tempRoot "broker-fixture.exe"
try {
    [System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null
    [System.IO.File]::WriteAllText(
        $fixturePath,
        $fixtureText,
        (New-Object System.Text.UTF8Encoding($false))
    )
    Add-Type `
        -TypeDefinition $brokerFixtureText `
        -Language CSharp `
        -OutputAssembly $brokerFixturePath `
        -OutputType ConsoleApplication
    Assert-True (Test-Path -LiteralPath $brokerFixturePath -PathType Leaf) `
        "Broker coordinator fixture did not compile."

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

        if ($case.Name -eq "north-refusal") {
            Assert-ExactProperties -Value $result.Result -Names @(
                "ok", "action", "contractVersion", "kind", "code", "reason",
                "sourceAbsent", "destinationAbsent"
            ) -Message "Legacy north refusal schema drifted."
            Assert-True ($result.Result.code -eq "m4_secret_handoff_refused") `
                "Legacy north refusal code drifted."
            Assert-True ($result.Result.sourceAbsent -eq $true -and
                $result.Result.destinationAbsent -eq $true) `
                "Legacy north refusal absence proof drifted."
        }
        elseif ($case.Name -eq "enrollment-success") {
            Assert-ExactProperties -Value $result.Result -Names @(
                "ok", "action", "contractVersion", "kind", "outcome",
                "sourceAbsent", "destinationRetained"
            ) -Message "Legacy enrollment success schema drifted."
        }
    }

    $brokerCases = @(
        [ordered]@{ Name = "broker-success"; Source = "source-success"; SourceProbe = "source-probe"; Destination = "receive-success"; Cleanup = "cleanup-success"; Timeout = 10000; ExitCode = 0; Reason = $null; Events = @("receive", "commit"); StorePresent = $true },
        [ordered]@{ Name = "broker-abort"; Source = "source-fail"; SourceProbe = "source-probe"; Destination = "receive-success"; Cleanup = "cleanup-success"; Timeout = 10000; ExitCode = 78; Reason = "handoff_failed"; Events = @("receive", "abort", "cleanup", "probe"); StorePresent = $false },
        [ordered]@{ Name = "broker-value-free-source-stderr"; Source = "source-success-stderr"; SourceProbe = "source-probe"; Destination = "receive-success"; Cleanup = "cleanup-success"; Timeout = 10000; ExitCode = 78; Reason = "handoff_failed"; Events = @("receive", "abort", "cleanup", "probe"); StorePresent = $false },
        [ordered]@{ Name = "broker-timeout-source-proof"; Source = "source-timeout"; SourceProbe = "source-probe"; Destination = "receive-success"; Cleanup = "cleanup-success"; Timeout = 10000; RequireSourceProbe = $true; ExitCode = 78; Reason = "handoff_failed"; Events = @("receive", "cleanup", "probe"); StorePresent = $false },
        [ordered]@{ Name = "broker-source-stuck-pipe"; Source = "source-stuck-child"; SourceProbe = "source-probe"; Destination = "receive-success"; Cleanup = "cleanup-success"; Timeout = 8000; MaxElapsed = 9500; ExitCode = 79; Reason = "cleanup_uncertain"; Events = @("receive", "cleanup", "probe"); StorePresent = $false },
        [ordered]@{ Name = "broker-destination-stuck-pipe"; Source = "source-success"; SourceProbe = "source-probe"; Destination = "receive-stuck-child"; Cleanup = "cleanup-success"; Timeout = 8000; MaxElapsed = 9500; ExitCode = 79; Reason = "cleanup_uncertain"; Events = @("receive", "cleanup", "probe"); StorePresent = $false },
        [ordered]@{ Name = "broker-invalid-metadata"; Source = "source-success"; SourceProbe = "source-probe"; Destination = "receive-invalid-metadata"; Cleanup = "cleanup-success"; Timeout = 10000; ExitCode = 78; Reason = "handoff_failed"; Events = @("receive", "commit", "cleanup", "probe"); StorePresent = $false },
        [ordered]@{ Name = "broker-source-cleanup-uncertain"; Source = "source-success"; SourceProbe = "source-probe-fail"; Destination = "receive-success"; Cleanup = "cleanup-success"; Timeout = 10000; ExitCode = 79; Reason = "cleanup_uncertain"; Events = @("receive", "abort", "cleanup", "probe"); StorePresent = $false },
        [ordered]@{ Name = "broker-source-probe-timeout-reserve"; Source = "source-success"; SourceProbe = "source-probe-timeout"; Destination = "receive-success"; Cleanup = "cleanup-success"; Timeout = 10000; ExitCode = 79; Reason = "cleanup_uncertain"; Events = @("receive", "abort", "cleanup", "probe"); StorePresent = $false },
        [ordered]@{ Name = "broker-cleanup-metadata-invalid"; Source = "source-success"; SourceProbe = "source-probe"; Destination = "receive-invalid-metadata"; Cleanup = "cleanup-invalid-metadata"; Timeout = 10000; ExitCode = 79; Reason = "cleanup_uncertain"; Events = @("receive", "commit", "cleanup", "probe"); StorePresent = $false },
        [ordered]@{ Name = "broker-cleanup-timeout-reserve"; Source = "source-success"; SourceProbe = "source-probe"; Destination = "receive-invalid-metadata"; Cleanup = "cleanup-timeout"; Timeout = 10000; ExitCode = 79; Reason = "cleanup_uncertain"; Events = @("receive", "commit", "cleanup", "probe"); StorePresent = $true },
        [ordered]@{ Name = "broker-positive-absence-required"; Source = "source-success"; SourceProbe = "source-probe"; Destination = "receive-invalid-metadata"; Cleanup = "cleanup-no-remove"; Timeout = 10000; ExitCode = 79; Reason = "cleanup_uncertain"; Events = @("receive", "commit", "cleanup", "probe"); StorePresent = $true }
    )

    foreach ($case in $brokerCases) {
        $caseRoot = Join-Path $tempRoot $case.Name
        New-ProtectedTestRoot -Path $caseRoot
        $sourceProbeObservationPath = if ($case.Contains('RequireSourceProbe')) {
            Join-Path $caseRoot 'source-probe-observation.txt'
        }
        else {
            ''
        }
        $caseStopwatch = [Diagnostics.Stopwatch]::StartNew()
        $result = Invoke-RevAgentM4HandoffCore `
            -Kind "north_bearer" `
            -SourceStartInfo (New-FixtureStartInfo -FixturePath $fixturePath -Mode $case.Source -Kind "north_bearer") `
            -DestinationStartInfo (New-BrokerFixtureStartInfo -FixturePath $brokerFixturePath -Mode $case.Destination -Root $caseRoot -RedirectInput $true) `
            -SourceProbeStartInfo (New-FixtureStartInfo -FixturePath $fixturePath -Mode $case.SourceProbe -Kind "north_bearer" -ObservationPath $sourceProbeObservationPath) `
            -DestinationProbeStartInfo (New-BrokerFixtureStartInfo -FixturePath $brokerFixturePath -Mode "probe" -Root $caseRoot) `
            -TimeoutMilliseconds $case.Timeout `
            -DestinationDisposition "current_user_dpapi_broker_v1" `
            -DestinationCleanupStartInfo (New-BrokerFixtureStartInfo -FixturePath $brokerFixturePath -Mode $case.Cleanup -Root $caseRoot)
        $caseStopwatch.Stop()
        $safeResult = $result | ConvertTo-Json -Compress -Depth 5
        $eventPath = Join-Path $caseRoot "events.txt"
        $eventPreview = if (Test-Path -LiteralPath $eventPath -PathType Leaf) {
            @(Get-Content -LiteralPath $eventPath -Encoding UTF8) -join ","
        }
        else {
            "missing"
        }
        Assert-True ($result.ExitCode -eq $case.ExitCode) `
            "$($case.Name) exit code drifted (events=$eventPreview): $safeResult"
        if ($case.Contains('MaxElapsed')) {
            Assert-True ($caseStopwatch.ElapsedMilliseconds -lt $case.MaxElapsed) `
                "$($case.Name) exceeded its bounded cleanup/probe budget: $($caseStopwatch.ElapsedMilliseconds)ms."
        }
        if ($case.Contains('RequireSourceProbe')) {
            Assert-True (Test-Path -LiteralPath $sourceProbeObservationPath -PathType Leaf) `
                "$($case.Name) never executed the post-timeout source cleanup probe."
            Assert-True ((Get-Content -LiteralPath $sourceProbeObservationPath -Raw -Encoding UTF8) -eq "source-probe`n") `
                "$($case.Name) source cleanup probe evidence drifted."
        }
        if ($null -eq $case.Reason) {
            Assert-ExactProperties -Value $result.Result -Names @(
                "ok", "action", "contractVersion", "kind",
                "destinationDisposition", "protectionScope", "outcome",
                "sourceAbsent", "destinationRetained"
            ) -Message "$($case.Name) success schema drifted."
            Assert-True ($result.Result.ok -eq $true -and
                $result.Result.destinationDisposition -eq "current_user_dpapi_broker_v1" -and
                $result.Result.protectionScope -eq "current_user_dpapi" -and
                $result.Result.outcome -eq "delivered" -and
                $result.Result.sourceAbsent -eq $true -and
                $result.Result.destinationRetained -eq $true) `
                "$($case.Name) success result drifted."
        }
        else {
            Assert-True ($result.Result.ok -eq $false -and
                $result.Result.reason -eq $case.Reason) `
                "$($case.Name) fail-closed result drifted: $safeResult"
        }

        Assert-True (Test-Path -LiteralPath $eventPath -PathType Leaf) `
            "$($case.Name) emitted no lifecycle events."
        $events = @(Get-Content -LiteralPath $eventPath -Encoding UTF8)
        Assert-True (($events -join "|") -eq ($case.Events -join "|")) `
            "$($case.Name) lifecycle order drifted: $($events -join ',')"
        $storePath = Join-Path $caseRoot "broker-store.bin"
        Assert-True ((Test-Path -LiteralPath $storePath -PathType Leaf) -eq $case.StorePresent) `
            "$($case.Name) retained-destination state drifted."
        $visibleFiles = @(
            Get-ChildItem -LiteralPath $caseRoot -File | ForEach-Object {
                [System.Text.Encoding]::UTF8.GetString(
                    [System.IO.File]::ReadAllBytes($_.FullName)
                )
            }
        ) -join "`n"
        Assert-ValueFree -CaseId $case.Name -Visible ($safeResult + $visibleFiles)
        if (Test-Path -LiteralPath $storePath -PathType Leaf) {
            Remove-Item -LiteralPath $storePath -Force
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
