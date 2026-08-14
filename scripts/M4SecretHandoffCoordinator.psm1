Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:ContractVersion = "revagent.m4-secret-handoff/v1"
$script:CoordinatorAction = "invoke_m4_secret_handoff"
$script:CurrentUserDpapiBrokerDisposition = "current_user_dpapi_broker_v1"
$script:MaximumMetadataBytes = 8192
$script:MaximumFrameBytes = 8192

if (-not ("RevAgent.M4.BoundedStreams" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace RevAgent.M4 {
    public static class BoundedStreams {
        public static async Task<byte[]> ReadAsync(
            Stream source,
            int maximumBytes,
            CancellationToken cancellationToken) {
            using (var output = new MemoryStream()) {
                var buffer = new byte[1024];
                try {
                    while (true) {
                        var read = await source.ReadAsync(
                            buffer,
                            0,
                            buffer.Length,
                            cancellationToken).ConfigureAwait(false);
                        if (read == 0) break;
                        if (output.Length + read > maximumBytes) {
                            throw new InvalidDataException("bounded_stream_exceeded");
                        }
                        output.Write(buffer, 0, read);
                    }
                    return output.ToArray();
                }
                finally {
                    Array.Clear(buffer, 0, buffer.Length);
                }
            }
        }

        public static async Task<long> CopyAsync(
            Stream source,
            Stream destination,
            int maximumBytes,
            CancellationToken cancellationToken) {
            var buffer = new byte[1024];
            long total = 0;
            try {
                while (true) {
                    var read = await source.ReadAsync(
                        buffer,
                        0,
                        buffer.Length,
                        cancellationToken).ConfigureAwait(false);
                    if (read == 0) break;
                    total += read;
                    if (total > maximumBytes) {
                        throw new InvalidDataException("bounded_stream_exceeded");
                    }
                    await destination.WriteAsync(
                        buffer,
                        0,
                        read,
                        cancellationToken).ConfigureAwait(false);
                    await destination.FlushAsync(cancellationToken).ConfigureAwait(false);
                }
                return total;
            }
            finally {
                Array.Clear(buffer, 0, buffer.Length);
            }
        }
    }
}
'@
}

if (-not ("RevAgent.M4.ProcessHandles" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace RevAgent.M4 {
    public static class ProcessHandles {
        private const uint WaitObject0 = 0x00000000;
        private const uint WaitTimeout = 0x00000102;
        private const uint WaitFailed = 0xffffffff;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        public static bool WaitForExit(Process process, int milliseconds) {
            if (process == null) return true;
            if (milliseconds < 0) throw new ArgumentOutOfRangeException("milliseconds");
            uint result = WaitForSingleObject(process.Handle, (uint)milliseconds);
            if (result == WaitObject0) return true;
            if (result == WaitTimeout) return false;
            if (result == WaitFailed) throw new Win32Exception(Marshal.GetLastWin32Error());
            throw new InvalidOperationException("unexpected_process_wait_result");
        }
    }
}
'@
}

function Wait-RevAgentOwnedProcessExit {
    param(
        [System.Diagnostics.Process]$Process,
        [ValidateRange(0, 120000)][int]$WaitMilliseconds
    )

    if ($null -eq $Process) { return $true }
    try {
        return [RevAgent.M4.ProcessHandles]::WaitForExit(
            $Process,
            $WaitMilliseconds
        )
    }
    catch {
        return $false
    }
}

function Stop-RevAgentOwnedProcess {
    param(
        [System.Diagnostics.Process]$Process,

        [ValidateRange(0, 2000)]
        [int]$WaitMilliseconds = 2000,

        [switch]$UseNativeHandleWait
    )

    if ($null -eq $Process) { return $true }
    try {
        if ($UseNativeHandleWait) {
            if (-not (Wait-RevAgentOwnedProcessExit -Process $Process -WaitMilliseconds 0)) {
                $Process.Kill()
                if (-not (Wait-RevAgentOwnedProcessExit `
                        -Process $Process `
                        -WaitMilliseconds $WaitMilliseconds)) { return $false }
            }
            return Wait-RevAgentOwnedProcessExit -Process $Process -WaitMilliseconds 0
        }

        if (-not $Process.HasExited) {
            $Process.Kill()
            if (-not $Process.WaitForExit($WaitMilliseconds)) { return $false }
        }
        return $Process.HasExited
    }
    catch {
        return $false
    }
}

function ConvertTo-RevAgentWindowsCommandLineArgument {
    param([AllowEmptyString()][string]$Value)

    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }

    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $backslashCount = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashCount++
            continue
        }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * (($backslashCount * 2) + 1)))
            [void]$builder.Append('"')
            $backslashCount = 0
            continue
        }
        if ($backslashCount -gt 0) {
            [void]$builder.Append(('\' * $backslashCount))
            $backslashCount = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashCount -gt 0) {
        [void]$builder.Append(('\' * ($backslashCount * 2)))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function New-RevAgentProcessStartInfo {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [string[]]$ArgumentVector,

        [bool]$RedirectInput = $false,

        [switch]$ForceLegacyArguments
    )

    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $FilePath
    if (-not $ForceLegacyArguments -and
        $start.PSObject.Properties.Name -contains 'ArgumentList') {
        foreach ($argument in $ArgumentVector) {
            [void]$start.ArgumentList.Add($argument)
        }
    }
    else {
        # Windows PowerShell 5.1 / .NET Framework fallback. This is the
        # CommandLineToArgvW inverse, including quote-adjacent and trailing
        # backslash doubling, so every logical argument survives exactly.
        $start.Arguments = @(
            $ArgumentVector | ForEach-Object {
                ConvertTo-RevAgentWindowsCommandLineArgument -Value $_
            }
        ) -join ' '
    }
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $RedirectInput
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.CreateNoWindow = $true
    return $start
}

function New-RevAgentSourceCleanupProbeScript {
    param(
        [Parameter(Mandatory = $true)][string]$SourceContainerName,
        [Parameter(Mandatory = $true)][string]$ProbeContainerName,
        [Parameter(Mandatory = $true)][string]$SourceUidGid,
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$ImageRef,
        [Parameter(Mandatory = $true)][ValidateSet("north_bearer", "enrollment_artifact")][string]$Kind,
        [Parameter(Mandatory = $true)][string]$ExpectedProbeJson,
        [Parameter(Mandatory = $true)][string]$CombinedProbeJson
    )

    $template = @'
set -eu
before=$(sudo -n docker ps -a --filter 'name=^/__SOURCE_CONTAINER__$' --format '{{.Names}}')
case "$before" in
  '') ;;
  '__SOURCE_CONTAINER__') sudo -n docker rm -f __SOURCE_CONTAINER__ >/dev/null ;;
  *) exit 1 ;;
esac
after=$(sudo -n docker ps -a --filter 'name=^/__SOURCE_CONTAINER__$' --format '{{.Names}}')
test -z "$after"
probe=$(sudo -n docker run --rm --restart=no --name __PROBE_CONTAINER__ --pull=never --log-driver=none --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges --user __SOURCE_UID_GID__ --mount type=bind,src=__SOURCE_ROOT__/runtime/handoff,dst=/run/revagent-m4-handoff,readonly --env NODE_ENV=preproduction __IMAGE_REF__ node /app/packages/gateway/dist/preProductionSecretHandoffSourceMain.js --contract revagent.m4-secret-handoff/v1 --kind __KIND__ --root /run/revagent-m4-handoff --probe-absent true)
test "$probe" = '__EXPECTED_PROBE_JSON__'
source_inventory=$(sudo -n docker ps -a --filter 'name=^/__SOURCE_CONTAINER__$' --format '{{.Names}}')
test -z "$source_inventory"
probe_inventory=$(sudo -n docker ps -a --filter 'name=^/__PROBE_CONTAINER__$' --format '{{.Names}}')
test -z "$probe_inventory"
printf '%s\n' '__COMBINED_PROBE_JSON__'
'@
    return $template.
        Replace("__SOURCE_CONTAINER__", $SourceContainerName).
        Replace("__PROBE_CONTAINER__", $ProbeContainerName).
        Replace("__SOURCE_UID_GID__", $SourceUidGid).
        Replace("__SOURCE_ROOT__", $SourceRoot).
        Replace("__IMAGE_REF__", $ImageRef).
        Replace("__KIND__", $Kind).
        Replace("__EXPECTED_PROBE_JSON__", $ExpectedProbeJson).
        Replace("__COMBINED_PROBE_JSON__", $CombinedProbeJson)
}

function Get-RevAgentRemainingMilliseconds {
    param(
        [System.Diagnostics.Stopwatch]$Stopwatch,
        [int]$DeadlineMilliseconds
    )

    return [Math]::Max(0, $DeadlineMilliseconds - [int]$Stopwatch.ElapsedMilliseconds)
}

function Get-RevAgentBrokerStageDeadlines {
    param([int]$TimeoutMilliseconds)

    return [pscustomobject][ordered]@{
        Operation = [int]($TimeoutMilliseconds * 0.40)
        SourceStop = [int]($TimeoutMilliseconds * 0.50)
        SourceProof = [int]($TimeoutMilliseconds * 0.65)
        DestinationStop = [int]($TimeoutMilliseconds * 0.70)
        DestinationCleanup = [int]($TimeoutMilliseconds * 0.80)
        DestinationCleanupStop = [int]($TimeoutMilliseconds * 0.85)
        DestinationProbe = $TimeoutMilliseconds
    }
}

function Get-RevAgentBoundedStopWaitMilliseconds {
    param(
        [int]$ElapsedMilliseconds,
        [int]$StopDeadlineMilliseconds
    )

    return [Math]::Min(
        2000,
        [Math]::Max(0, $StopDeadlineMilliseconds - $ElapsedMilliseconds)
    )
}

function Stop-RevAgentOwnedProcessWithinDeadline {
    param(
        [System.Diagnostics.Process]$Process,
        [System.Diagnostics.Stopwatch]$Stopwatch,
        [AllowNull()][Nullable[int]]$StopDeadlineMilliseconds,
        [switch]$UseNativeHandleWait
    )

    if ($null -eq $StopDeadlineMilliseconds) {
        return Stop-RevAgentOwnedProcess `
            -Process $Process `
            -UseNativeHandleWait:$UseNativeHandleWait
    }
    $waitMilliseconds = Get-RevAgentBoundedStopWaitMilliseconds `
        -ElapsedMilliseconds ([int]$Stopwatch.ElapsedMilliseconds) `
        -StopDeadlineMilliseconds ([int]$StopDeadlineMilliseconds)
    return Stop-RevAgentOwnedProcess `
        -Process $Process `
        -WaitMilliseconds $waitMilliseconds `
        -UseNativeHandleWait:$UseNativeHandleWait
}

function Close-RevAgentOwnedProcessResources {
    param(
        [System.Diagnostics.Process]$Process,
        [AllowNull()][System.Threading.Tasks.Task[]]$StreamTasks
    )

    if ($null -eq $Process) { return }
    $hasIncompleteStream = @($StreamTasks | Where-Object {
            $null -ne $_ -and -not $_.IsCompleted
        }).Count -gt 0
    if (-not $hasIncompleteStream) {
        $Process.Dispose()
        return
    }

    # Process.Dispose() closes redirected streams and can synchronously wait
    # behind a descendant that inherited their pipe handles. Release only the
    # native process handle here; the pending read tasks own their stream
    # handles until EOF/fault and must never borrow cleanup/probe time.
    try { $Process.SafeHandle.Dispose() } catch {}
}

function Get-RevAgentTaskResult {
    param([System.Threading.Tasks.Task]$Task)

    # Preserve byte[] as one object. PowerShell otherwise enumerates a
    # non-empty array and turns an empty array into $null at the function
    # boundary, which makes a valid empty stderr indistinguishable from a
    # failed bounded read.
    return ,$Task.GetAwaiter().GetResult()
}

function Get-RevAgentTaskResultBeforeDeadline {
    param(
        [System.Threading.Tasks.Task]$Task,
        [System.Diagnostics.Stopwatch]$Stopwatch,
        [int]$DeadlineMilliseconds
    )

    if (-not $Task.IsCompleted) {
        $remaining = Get-RevAgentRemainingMilliseconds `
            -Stopwatch $Stopwatch `
            -DeadlineMilliseconds $DeadlineMilliseconds
        if ($remaining -le 0) {
            return [pscustomobject][ordered]@{
                Completed = $false
                Succeeded = $false
                Value = $null
            }
        }
        try {
            [void]$Task.Wait($remaining)
        }
        catch {
            # A faulted task is complete and is handled without exposing its
            # exception or any captured bytes below.
        }
    }

    if (-not $Task.IsCompleted) {
        return [pscustomobject][ordered]@{
            Completed = $false
            Succeeded = $false
            Value = $null
        }
    }
    try {
        return [pscustomobject][ordered]@{
            Completed = $true
            Succeeded = $true
            Value = (Get-RevAgentTaskResult -Task $Task)
        }
    }
    catch {
        return [pscustomobject][ordered]@{
            Completed = $true
            Succeeded = $false
            Value = $null
        }
    }
}

function ConvertFrom-RevAgentMetadataBytes {
    param([byte[]]$Bytes)

    try {
        $encoding = New-Object System.Text.UTF8Encoding($false, $true)
        $text = $encoding.GetString($Bytes)
        if (-not $text.EndsWith("`n", [System.StringComparison]::Ordinal) -or
            $text.Substring(0, $text.Length - 1).Contains("`n") -or
            $text.Contains("`r")) {
            return $null
        }
        return $text.Substring(0, $text.Length - 1) | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Test-RevAgentExactProperties {
    param(
        [object]$Value,
        [string[]]$Names
    )

    if ($null -eq $Value) { return $false }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Names | Sort-Object)
    if ($actual.Count -ne $expected.Count) { return $false }
    for ($index = 0; $index -lt $actual.Count; $index++) {
        if (-not [string]::Equals(
                [string]$actual[$index],
                [string]$expected[$index],
                [System.StringComparison]::Ordinal
            )) {
            return $false
        }
    }
    return $true
}

function Test-RevAgentSourceProbeResult {
    param(
        [object]$Value,
        [string]$Kind
    )

    return (Test-RevAgentExactProperties -Value $Value -Names @(
            "ok", "action", "contractVersion", "kind", "sourceAbsent",
            "containerAbsent"
        )) -and
        $Value.ok -eq $true -and
        $Value.action -eq "probe_preproduction_secret_handoff_source_absence" -and
        $Value.contractVersion -eq $script:ContractVersion -and
        $Value.kind -eq $Kind -and
        $Value.sourceAbsent -eq $true -and
        $Value.containerAbsent -eq $true
}

function Test-RevAgentDestinationProbeResult {
    param(
        [object]$Value,
        [string]$Kind
    )

    return (Test-RevAgentExactProperties -Value $Value -Names @(
            "ok", "action", "contractVersion", "kind", "destinationAbsent"
        )) -and
        $Value.ok -eq $true -and
        $Value.action -eq "probe_m4_secret_handoff_absence" -and
        $Value.contractVersion -eq $script:ContractVersion -and
        $Value.kind -eq $Kind -and
        $Value.destinationAbsent -eq $true
}

function Test-RevAgentEnrollmentDestinationResult {
    param([object]$Value)

    return (Test-RevAgentExactProperties -Value $Value -Names @(
            "ok", "action", "contractVersion", "kind", "bytes",
            "destinationCreated", "aclProtected", "linkCount"
        )) -and
        $Value.ok -eq $true -and
        $Value.action -eq "receive_m4_secret_handoff" -and
        $Value.contractVersion -eq $script:ContractVersion -and
        $Value.kind -eq "enrollment_artifact" -and
        $Value.bytes -is [ValueType] -and
        [decimal]$Value.bytes -eq [Math]::Truncate([decimal]$Value.bytes) -and
        $Value.bytes -ge 1 -and $Value.bytes -le 4096 -and
        $Value.destinationCreated -eq $true -and
        $Value.aclProtected -eq $true -and
        $Value.linkCount -eq 1
}

function Test-RevAgentNorthDestinationResult {
    param([object]$Value)

    return (Test-RevAgentExactProperties -Value $Value -Names @(
            "ok", "action", "contractVersion", "kind", "code", "reason",
            "destinationAbsent"
        )) -and
        $Value.ok -eq $false -and
        $Value.action -eq "receive_m4_secret_handoff" -and
        $Value.contractVersion -eq $script:ContractVersion -and
        $Value.kind -eq "north_bearer" -and
        $Value.code -eq "m4_secret_handoff_refused" -and
        $Value.reason -eq "client_secure_store_unavailable" -and
        $Value.destinationAbsent -eq $true
}

function Test-RevAgentCurrentUserDpapiNorthDestinationResult {
    param([object]$Value)

    return (Test-RevAgentExactProperties -Value $Value -Names @(
            "ok", "action", "contractVersion", "kind",
            "destinationDisposition", "destinationCreated",
            "protectionScope", "aclProtected", "linkCount"
        )) -and
        $Value.ok -eq $true -and
        $Value.action -eq "receive_m4_secret_handoff" -and
        $Value.contractVersion -eq $script:ContractVersion -and
        $Value.kind -eq "north_bearer" -and
        $Value.destinationDisposition -eq $script:CurrentUserDpapiBrokerDisposition -and
        $Value.destinationCreated -eq $true -and
        $Value.protectionScope -eq "current_user_dpapi" -and
        $Value.aclProtected -eq $true -and
        $Value.linkCount -is [ValueType] -and
        [decimal]$Value.linkCount -eq 1
}

function Test-RevAgentCurrentUserDpapiCleanupResult {
    param([object]$Value)

    return (Test-RevAgentExactProperties -Value $Value -Names @(
            "ok", "action", "contractVersion", "kind", "destinationAbsent"
        )) -and
        $Value.ok -eq $true -and
        $Value.action -eq "cleanup_m4_client_bearer_store" -and
        $Value.contractVersion -eq $script:ContractVersion -and
        $Value.kind -eq "north_bearer" -and
        $Value.destinationAbsent -eq $true
}

function Start-RevAgentBoundedProcess {
    param([System.Diagnostics.ProcessStartInfo]$StartInfo)

    if (-not $StartInfo.UseShellExecute -and
        $StartInfo.RedirectStandardOutput -and
        $StartInfo.RedirectStandardError) {
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $StartInfo
        if (-not $process.Start()) {
            throw "process_start_failed"
        }
        return $process
    }
    throw "unsafe_process_start_info"
}

function Invoke-RevAgentMetadataProcess {
    param(
        [System.Diagnostics.ProcessStartInfo]$StartInfo,
        [System.Diagnostics.Stopwatch]$Stopwatch,
        [int]$DeadlineMilliseconds,
        [AllowNull()][Nullable[int]]$StopDeadlineMilliseconds = $null,
        [switch]$UseNativeHandleWait
    )

    $process = $null
    $stdoutTask = $null
    $stderrTask = $null
    try {
        $process = Start-RevAgentBoundedProcess -StartInfo $StartInfo
        if ($StartInfo.RedirectStandardInput) {
            $process.StandardInput.Dispose()
        }
        $stdoutTask = [RevAgent.M4.BoundedStreams]::ReadAsync(
            $process.StandardOutput.BaseStream,
            $script:MaximumMetadataBytes,
            [System.Threading.CancellationToken]::None
        )
        $stderrTask = [RevAgent.M4.BoundedStreams]::ReadAsync(
            $process.StandardError.BaseStream,
            $script:MaximumMetadataBytes,
            [System.Threading.CancellationToken]::None
        )
        $remaining = Get-RevAgentRemainingMilliseconds -Stopwatch $Stopwatch -DeadlineMilliseconds $DeadlineMilliseconds
        $processExited = $remaining -gt 0 -and $(if ($UseNativeHandleWait) {
                Wait-RevAgentOwnedProcessExit `
                    -Process $process `
                    -WaitMilliseconds $remaining
            }
            else {
                $process.WaitForExit($remaining)
            })
        if (-not $processExited) {
            [void](Stop-RevAgentOwnedProcessWithinDeadline `
                -Process $process `
                -Stopwatch $Stopwatch `
                -StopDeadlineMilliseconds $StopDeadlineMilliseconds `
                -UseNativeHandleWait:$UseNativeHandleWait)
            return $null
        }
        if ($UseNativeHandleWait) {
            $stdoutRead = Get-RevAgentTaskResultBeforeDeadline `
                -Task $stdoutTask `
                -Stopwatch $Stopwatch `
                -DeadlineMilliseconds $DeadlineMilliseconds
            $stderrRead = Get-RevAgentTaskResultBeforeDeadline `
                -Task $stderrTask `
                -Stopwatch $Stopwatch `
                -DeadlineMilliseconds $DeadlineMilliseconds
            if (-not $stdoutRead.Succeeded -or -not $stderrRead.Succeeded) {
                return $null
            }
            $stdout = $stdoutRead.Value
            $stderr = $stderrRead.Value
        }
        else {
            $stdout = Get-RevAgentTaskResult -Task $stdoutTask
            $stderr = Get-RevAgentTaskResult -Task $stderrTask
        }
        return [pscustomobject][ordered]@{
            ExitCode = $process.ExitCode
            Stdout = $stdout
            Stderr = $stderr
        }
    }
    catch {
        [void](Stop-RevAgentOwnedProcessWithinDeadline `
            -Process $process `
            -Stopwatch $Stopwatch `
            -StopDeadlineMilliseconds $StopDeadlineMilliseconds `
            -UseNativeHandleWait:$UseNativeHandleWait)
        return $null
    }
    finally {
        if ($UseNativeHandleWait) {
            Close-RevAgentOwnedProcessResources `
                -Process $process `
                -StreamTasks @($stdoutTask, $stderrTask)
        }
        elseif ($null -ne $process) {
            $process.Dispose()
        }
    }
}

function New-RevAgentCleanupUncertainResult {
    param([string]$Kind)

    return [pscustomobject][ordered]@{
        ExitCode = 79
        Result = [ordered]@{
            ok = $false
            action = $script:CoordinatorAction
            contractVersion = $script:ContractVersion
            kind = $Kind
            code = "cleanup_uncertain"
            reason = "cleanup_uncertain"
        }
    }
}

function New-RevAgentHandoffFailureResult {
    param([string]$Kind)

    return [pscustomobject][ordered]@{
        ExitCode = 78
        Result = [ordered]@{
            ok = $false
            action = $script:CoordinatorAction
            contractVersion = $script:ContractVersion
            kind = $Kind
            code = "m4_secret_handoff_refused"
            reason = "handoff_failed"
            sourceAbsent = $true
            destinationAbsent = $true
        }
    }
}

function Invoke-RevAgentM4HandoffCore {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("north_bearer", "enrollment_artifact")]
        [string]$Kind,

        [Parameter(Mandatory = $true)]
        [System.Diagnostics.ProcessStartInfo]$SourceStartInfo,

        [Parameter(Mandatory = $true)]
        [System.Diagnostics.ProcessStartInfo]$DestinationStartInfo,

        [Parameter(Mandatory = $true)]
        [System.Diagnostics.ProcessStartInfo]$SourceProbeStartInfo,

        [Parameter(Mandatory = $true)]
        [System.Diagnostics.ProcessStartInfo]$DestinationProbeStartInfo,

        [ValidateRange(750, 120000)]
        [int]$TimeoutMilliseconds = 30000,

        [ValidateSet("north_refusal_v1", "current_user_dpapi_broker_v1")]
        [string]$DestinationDisposition = "north_refusal_v1",

        [AllowNull()]
        [System.Diagnostics.ProcessStartInfo]$DestinationCleanupStartInfo = $null
    )

    $usesCurrentUserDpapiBroker =
        $DestinationDisposition -eq $script:CurrentUserDpapiBrokerDisposition
    if ($usesCurrentUserDpapiBroker -and $Kind -ne "north_bearer") {
        throw "invalid_destination_disposition"
    }
    if ($usesCurrentUserDpapiBroker -and $null -eq $DestinationCleanupStartInfo) {
        throw "missing_destination_cleanup_start_info"
    }

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $brokerStageDeadlines = if ($usesCurrentUserDpapiBroker) {
        Get-RevAgentBrokerStageDeadlines -TimeoutMilliseconds $TimeoutMilliseconds
    }
    else {
        $null
    }
    $operationDeadline = if ($usesCurrentUserDpapiBroker) {
        $brokerStageDeadlines.Operation
    }
    else {
        [Math]::Max(
            500,
            $TimeoutMilliseconds - [Math]::Max(250, [int]($TimeoutMilliseconds * 0.30))
        )
    }
    $sourceProofDeadline = if ($usesCurrentUserDpapiBroker) {
        $brokerStageDeadlines.SourceProof
    }
    else {
        $TimeoutMilliseconds
    }
    $sourceStopDeadline = if ($usesCurrentUserDpapiBroker) {
        [Nullable[int]]$brokerStageDeadlines.SourceStop
    }
    else {
        $null
    }
    $sourceProofStopDeadline = if ($usesCurrentUserDpapiBroker) {
        [Nullable[int]]$brokerStageDeadlines.DestinationStop
    }
    else {
        $null
    }
    $destinationStopDeadline = if ($usesCurrentUserDpapiBroker) {
        [Nullable[int]]$brokerStageDeadlines.DestinationStop
    }
    else {
        $null
    }
    $destinationCleanupDeadline = if ($usesCurrentUserDpapiBroker) {
        $brokerStageDeadlines.DestinationCleanup
    }
    else {
        $TimeoutMilliseconds
    }
    $destinationCleanupStopDeadline = if ($usesCurrentUserDpapiBroker) {
        [Nullable[int]]$brokerStageDeadlines.DestinationCleanupStop
    }
    else {
        $null
    }
    $destinationProbeDeadline = if ($usesCurrentUserDpapiBroker) {
        $brokerStageDeadlines.DestinationProbe
    }
    else {
        $TimeoutMilliseconds
    }
    $destinationProbeStopDeadline = if ($usesCurrentUserDpapiBroker) {
        [Nullable[int]]$brokerStageDeadlines.DestinationProbe
    }
    else {
        # Preserve the A2 legacy probe's fixed two-second stop wait.
        $null
    }
    $source = $null
    $destination = $null
    $sourceExit = $null
    $destinationExit = $null
    $sourceExitConfirmed = $false
    $destinationExitConfirmed = $false
    $copySucceeded = $false
    $operationTimedOut = $false
    $sourceStderr = $null
    $destinationStdout = $null
    $destinationStderr = $null
    $sourceAbsent = $false
    $terminalUncertain = $false
    $sourceMetadataClean = $false
    $sourceStderrTask = $null
    $copyTask = $null
    $drainTask = $null
    $destinationStdoutTask = $null
    $destinationStderrTask = $null

    try {
        $destination = Start-RevAgentBoundedProcess -StartInfo $DestinationStartInfo
        if (-not $DestinationStartInfo.RedirectStandardInput) {
            throw "destination_input_not_redirected"
        }
        $destinationStdoutTask = [RevAgent.M4.BoundedStreams]::ReadAsync(
            $destination.StandardOutput.BaseStream,
            $script:MaximumMetadataBytes,
            [System.Threading.CancellationToken]::None
        )
        $destinationStderrTask = [RevAgent.M4.BoundedStreams]::ReadAsync(
            $destination.StandardError.BaseStream,
            $script:MaximumMetadataBytes,
            [System.Threading.CancellationToken]::None
        )

        $source = Start-RevAgentBoundedProcess -StartInfo $SourceStartInfo
        if ($SourceStartInfo.RedirectStandardInput) {
            # The source side is output-only. Closing its unused input is part
            # of the process contract and prevents PowerShell/SSH children
            # from keeping the invocation alive while awaiting stdin EOF.
            $source.StandardInput.Dispose()
        }
        $sourceStderrTask = [RevAgent.M4.BoundedStreams]::ReadAsync(
            $source.StandardError.BaseStream,
            $script:MaximumMetadataBytes,
            [System.Threading.CancellationToken]::None
        )
        $copyTask = [RevAgent.M4.BoundedStreams]::CopyAsync(
            $source.StandardOutput.BaseStream,
            $destination.StandardInput.BaseStream,
            $script:MaximumFrameBytes,
            [System.Threading.CancellationToken]::None
        )

        $remaining = $operationDeadline - [int]$stopwatch.ElapsedMilliseconds
        $copyCompleted = $false
        if ($remaining -gt 0) {
            try {
                $copyCompleted = $copyTask.Wait($remaining)
            }
            catch [System.AggregateException] {
                $copyCompleted = $copyTask.IsCompleted
            }
        }
        if (-not $copyCompleted) {
            $operationTimedOut = $true
        }
        else {
            try {
                [void](Get-RevAgentTaskResult -Task $copyTask)
                $copySucceeded = $true
            }
            catch {
                # A north receiver intentionally closes before consuming the
                # source. Drain the remaining bounded source bytes without
                # decoding them so the source can finish and clean itself.
                try {
                    $drainTask = [RevAgent.M4.BoundedStreams]::ReadAsync(
                        $source.StandardOutput.BaseStream,
                        $script:MaximumFrameBytes,
                        [System.Threading.CancellationToken]::None
                    )
                    $remaining = $operationDeadline - [int]$stopwatch.ElapsedMilliseconds
                    if ($remaining -gt 0) { [void]$drainTask.Wait($remaining) }
                }
                catch {}
            }
        }

        if (-not $operationTimedOut) {
            $remaining = $operationDeadline - [int]$stopwatch.ElapsedMilliseconds
            $sourceExited = $remaining -gt 0 -and $(if ($usesCurrentUserDpapiBroker) {
                    Wait-RevAgentOwnedProcessExit `
                        -Process $source `
                        -WaitMilliseconds $remaining
                }
                else {
                    $source.WaitForExit($remaining)
                })
            if (-not $sourceExited) {
                $operationTimedOut = $true
            }
            else {
                $sourceExit = $source.ExitCode
                $sourceExitConfirmed = $true
            }
        }

        if ($operationTimedOut) {
            $sourceExitConfirmed = Stop-RevAgentOwnedProcessWithinDeadline `
                    -Process $source `
                    -Stopwatch $stopwatch `
                    -StopDeadlineMilliseconds $sourceStopDeadline `
                    -UseNativeHandleWait:$usesCurrentUserDpapiBroker
            if (-not $sourceExitConfirmed) {
                $terminalUncertain = $true
            }
        }

        # Source exit alone is not success. Harvest its bounded stderr before
        # the cleanup probe and before the receiver commit decision; any byte
        # (or unreadable stream) forces abort so a later metadata failure can
        # never leave a committed destination.
        if ($sourceExitConfirmed -and $usesCurrentUserDpapiBroker) {
            $sourceStderrRead = Get-RevAgentTaskResultBeforeDeadline `
                -Task $sourceStderrTask `
                -Stopwatch $stopwatch `
                -DeadlineMilliseconds $brokerStageDeadlines.SourceStop
            if ($sourceStderrRead.Succeeded) {
                $sourceStderr = $sourceStderrRead.Value
                $sourceMetadataClean = $sourceStderr.Length -eq 0
            }
            else {
                $sourceMetadataClean = $false
                if (-not $sourceStderrRead.Completed) {
                    $terminalUncertain = $true
                }
            }
        }
        elseif ($sourceExitConfirmed) {
            try {
                $sourceStderr = Get-RevAgentTaskResult -Task $sourceStderrTask
                $sourceMetadataClean = $sourceStderr.Length -eq 0
            }
            catch {
                $sourceMetadataClean = $false
            }
        }
        else {
            $sourceMetadataClean = $false
            $terminalUncertain = $true
        }

        # The source endpoint and its attempt-scoped remote process/container
        # must both be positively absent before the receiver is committed.
        # Until this cleanup/probe succeeds, the destination owns only an
        # abortable private file and cannot make the handoff durable.
        $sourceProbe = Invoke-RevAgentMetadataProcess `
            -StartInfo $SourceProbeStartInfo `
            -Stopwatch $stopwatch `
            -DeadlineMilliseconds $sourceProofDeadline `
            -StopDeadlineMilliseconds $sourceProofStopDeadline `
            -UseNativeHandleWait:$usesCurrentUserDpapiBroker
        $sourceAbsent = $null -ne $sourceProbe -and
            $sourceProbe.ExitCode -eq 0 -and
            $sourceProbe.Stderr.Length -eq 0 -and
            (Test-RevAgentSourceProbeResult `
                -Value (ConvertFrom-RevAgentMetadataBytes -Bytes $sourceProbe.Stdout) `
                -Kind $Kind)
        $commit = -not $operationTimedOut -and $copySucceeded -and
            $sourceExit -eq 0 -and $sourceMetadataClean -and $sourceAbsent
        $copyTerminal = $null -ne $copyTask -and $copyTask.IsCompleted
        if (-not $usesCurrentUserDpapiBroker -or $copyTerminal) {
            try {
                $destination.StandardInput.BaseStream.WriteByte($(if ($commit) { 1 } else { 0 }))
                $destination.StandardInput.BaseStream.Flush()
            }
            catch {}
            try { $destination.StandardInput.Dispose() } catch {}
        }
        else {
            # A timed-out CopyAsync may still own a pending write to the
            # receiver pipe. A second synchronous commit/abort write or a
            # StreamWriter disposal can then block until an inherited reader
            # closes, bypassing every later cleanup/probe deadline. Leave the
            # pipe task-owned, kill the destination by its native handle below,
            # and retain terminal uncertainty even if store cleanup succeeds.
            $operationTimedOut = $true
            $terminalUncertain = $true
        }

        # The explicit broker path gives the receiver only the shared
        # source/destination hard-stop window to process commit or abort. Its
        # later cleanup and independent absence-probe budgets remain reserved.
        # Legacy receiver timing stays byte-for-byte compatible with A2.
        $destinationDeadline = if ($usesCurrentUserDpapiBroker) {
            $brokerStageDeadlines.DestinationStop
        }
        else {
            $TimeoutMilliseconds
        }
        $remaining = $destinationDeadline - [int]$stopwatch.ElapsedMilliseconds
        $destinationExited = $remaining -gt 0 -and $(if ($usesCurrentUserDpapiBroker) {
                Wait-RevAgentOwnedProcessExit `
                    -Process $destination `
                    -WaitMilliseconds $remaining
            }
            else {
                $destination.WaitForExit($remaining)
            })
        if ($destinationExited) {
            $destinationExit = $destination.ExitCode
            $destinationExitConfirmed = $true
        }
        else {
            $operationTimedOut = $true
            $destinationExitConfirmed = Stop-RevAgentOwnedProcessWithinDeadline `
                    -Process $destination `
                    -Stopwatch $stopwatch `
                    -StopDeadlineMilliseconds $destinationStopDeadline `
                    -UseNativeHandleWait:$usesCurrentUserDpapiBroker
            if (-not $destinationExitConfirmed) {
                $terminalUncertain = $true
            }
        }
        if ($destinationExitConfirmed -and $usesCurrentUserDpapiBroker) {
            $destinationStdoutRead = Get-RevAgentTaskResultBeforeDeadline `
                -Task $destinationStdoutTask `
                -Stopwatch $stopwatch `
                -DeadlineMilliseconds $destinationDeadline
            $destinationStderrRead = Get-RevAgentTaskResultBeforeDeadline `
                -Task $destinationStderrTask `
                -Stopwatch $stopwatch `
                -DeadlineMilliseconds $destinationDeadline
            if ($destinationStdoutRead.Succeeded -and
                $destinationStderrRead.Succeeded) {
                $destinationStdout = $destinationStdoutRead.Value
                $destinationStderr = $destinationStderrRead.Value
            }
            elseif (-not $destinationStdoutRead.Completed -or
                -not $destinationStderrRead.Completed) {
                $terminalUncertain = $true
            }
        }
        elseif ($destinationExitConfirmed) {
            try { $destinationStdout = Get-RevAgentTaskResult -Task $destinationStdoutTask } catch {}
            try { $destinationStderr = Get-RevAgentTaskResult -Task $destinationStderrTask } catch {}
        }
        else {
            $terminalUncertain = $true
        }
    }
    catch {
        $operationTimedOut = $true
        try {
            if ($null -ne $destination -and
                (-not $usesCurrentUserDpapiBroker -or
                    $null -eq $copyTask -or $copyTask.IsCompleted)) {
                $destination.StandardInput.Dispose()
            }
        }
        catch {}
        if (-not (Stop-RevAgentOwnedProcessWithinDeadline -Process $source -Stopwatch $stopwatch -StopDeadlineMilliseconds $sourceStopDeadline -UseNativeHandleWait:$usesCurrentUserDpapiBroker)) { $terminalUncertain = $true }
        if (-not (Stop-RevAgentOwnedProcessWithinDeadline -Process $destination -Stopwatch $stopwatch -StopDeadlineMilliseconds $destinationStopDeadline -UseNativeHandleWait:$usesCurrentUserDpapiBroker)) { $terminalUncertain = $true }
    }
    finally {
        if (-not (Stop-RevAgentOwnedProcessWithinDeadline -Process $source -Stopwatch $stopwatch -StopDeadlineMilliseconds $sourceStopDeadline -UseNativeHandleWait:$usesCurrentUserDpapiBroker)) { $terminalUncertain = $true }
        if (-not (Stop-RevAgentOwnedProcessWithinDeadline -Process $destination -Stopwatch $stopwatch -StopDeadlineMilliseconds $destinationStopDeadline -UseNativeHandleWait:$usesCurrentUserDpapiBroker)) { $terminalUncertain = $true }
        if ($usesCurrentUserDpapiBroker) {
            Close-RevAgentOwnedProcessResources `
                -Process $source `
                -StreamTasks @($sourceStderrTask, $copyTask, $drainTask)
            Close-RevAgentOwnedProcessResources `
                -Process $destination `
                -StreamTasks @($destinationStdoutTask, $destinationStderrTask, $copyTask)
        }
        else {
            if ($null -ne $source) { $source.Dispose() }
            if ($null -ne $destination) { $destination.Dispose() }
        }
    }

    $destinationMetadataClean = $null -ne $destinationStderr -and $destinationStderr.Length -eq 0
    $destinationMetadata = if ($null -eq $destinationStdout) {
        $null
    }
    else {
        ConvertFrom-RevAgentMetadataBytes -Bytes $destinationStdout
    }
    $operationSucceeded = if ($Kind -eq "enrollment_artifact") {
        -not $operationTimedOut -and
        $copySucceeded -and $sourceExit -eq 0 -and $sourceAbsent -and
        $destinationExit -eq 0 -and
        $sourceMetadataClean -and $destinationMetadataClean -and
        (Test-RevAgentEnrollmentDestinationResult -Value $destinationMetadata)
    }
    elseif ($usesCurrentUserDpapiBroker) {
        -not $operationTimedOut -and
        $copySucceeded -and $sourceExit -eq 0 -and $sourceAbsent -and
        $destinationExit -eq 0 -and
        $sourceMetadataClean -and $destinationMetadataClean -and
        (Test-RevAgentCurrentUserDpapiNorthDestinationResult `
            -Value $destinationMetadata)
    }
    else {
        -not $operationTimedOut -and
        $sourceExit -eq 0 -and $sourceAbsent -and $destinationExit -eq 78 -and
        $sourceMetadataClean -and $destinationMetadataClean -and
        (Test-RevAgentNorthDestinationResult -Value $destinationMetadata)
    }

    $destinationMayBeRetained = -not $terminalUncertain -and
        $operationSucceeded -and
        ($Kind -eq "enrollment_artifact" -or $usesCurrentUserDpapiBroker)
    $destinationCleanupProved = $true
    if ($usesCurrentUserDpapiBroker -and -not $destinationMayBeRetained) {
        # The broker store is a distinct destination from the legacy receiver.
        # Every failed or uncertain attempt first invokes its identity-checked
        # cleanup action, then independently proves absence below. Neither
        # metadata result is allowed to substitute for the other.
        $destinationCleanup = Invoke-RevAgentMetadataProcess `
            -StartInfo $DestinationCleanupStartInfo `
            -Stopwatch $stopwatch `
            -DeadlineMilliseconds $destinationCleanupDeadline `
            -StopDeadlineMilliseconds $destinationCleanupStopDeadline `
            -UseNativeHandleWait:$usesCurrentUserDpapiBroker
        $destinationCleanupProved = $null -ne $destinationCleanup -and
            $destinationCleanup.ExitCode -eq 0 -and
            $destinationCleanup.Stderr.Length -eq 0 -and
            (Test-RevAgentCurrentUserDpapiCleanupResult `
                -Value (ConvertFrom-RevAgentMetadataBytes `
                    -Bytes $destinationCleanup.Stdout))
    }

    $destinationAbsent = $false
    if ($destinationMayBeRetained) {
        # Successful enrollment and explicit broker handoffs intentionally
        # retain the protected destination for their separately authorized
        # one-shot or broker consumer.
        $destinationAbsent = $false
    }
    else {
        $destinationProbe = Invoke-RevAgentMetadataProcess `
            -StartInfo $DestinationProbeStartInfo `
            -Stopwatch $stopwatch `
            -DeadlineMilliseconds $destinationProbeDeadline `
            -StopDeadlineMilliseconds $destinationProbeStopDeadline `
            -UseNativeHandleWait:$usesCurrentUserDpapiBroker
        $destinationAbsent = $null -ne $destinationProbe -and
            $destinationProbe.ExitCode -eq 0 -and
            $destinationProbe.Stderr.Length -eq 0 -and
            (Test-RevAgentDestinationProbeResult `
                -Value (ConvertFrom-RevAgentMetadataBytes -Bytes $destinationProbe.Stdout) `
                -Kind $Kind)
    }

    if ($terminalUncertain -or -not $sourceAbsent -or
        -not $destinationCleanupProved -or
        (-not $destinationMayBeRetained -and -not $destinationAbsent)) {
        return New-RevAgentCleanupUncertainResult -Kind $Kind
    }
    if (-not $operationSucceeded) {
        return New-RevAgentHandoffFailureResult -Kind $Kind
    }
    if ($Kind -eq "north_bearer" -and -not $usesCurrentUserDpapiBroker) {
        return [pscustomobject][ordered]@{
            ExitCode = 78
            Result = [ordered]@{
                ok = $false
                action = $script:CoordinatorAction
                contractVersion = $script:ContractVersion
                kind = $Kind
                code = "m4_secret_handoff_refused"
                reason = "client_secure_store_unavailable"
                sourceAbsent = $true
                destinationAbsent = $true
            }
        }
    }
    if ($usesCurrentUserDpapiBroker) {
        return [pscustomobject][ordered]@{
            ExitCode = 0
            Result = [ordered]@{
                ok = $true
                action = $script:CoordinatorAction
                contractVersion = $script:ContractVersion
                kind = $Kind
                destinationDisposition = $script:CurrentUserDpapiBrokerDisposition
                protectionScope = "current_user_dpapi"
                outcome = "delivered"
                sourceAbsent = $true
                destinationRetained = $true
            }
        }
    }
    return [pscustomobject][ordered]@{
        ExitCode = 0
        Result = [ordered]@{
            ok = $true
            action = $script:CoordinatorAction
            contractVersion = $script:ContractVersion
            kind = $Kind
            outcome = "delivered"
            sourceAbsent = $true
            destinationRetained = $true
        }
    }
}

Export-ModuleMember -Function Invoke-RevAgentM4HandoffCore, New-RevAgentProcessStartInfo, New-RevAgentSourceCleanupProbeScript
