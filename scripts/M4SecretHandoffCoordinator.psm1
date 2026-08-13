Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:ContractVersion = "revagent.m4-secret-handoff/v1"
$script:CoordinatorAction = "invoke_m4_secret_handoff"
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

function Stop-RevAgentOwnedProcess {
    param([System.Diagnostics.Process]$Process)

    if ($null -eq $Process) { return $true }
    try {
        if (-not $Process.HasExited) {
            $Process.Kill()
            if (-not $Process.WaitForExit(2000)) { return $false }
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

function Get-RevAgentTaskResult {
    param([System.Threading.Tasks.Task]$Task)

    # Preserve byte[] as one object. PowerShell otherwise enumerates a
    # non-empty array and turns an empty array into $null at the function
    # boundary, which makes a valid empty stderr indistinguishable from a
    # failed bounded read.
    return ,$Task.GetAwaiter().GetResult()
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
        [int]$DeadlineMilliseconds
    )

    $process = $null
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
        if ($remaining -le 0 -or -not $process.WaitForExit($remaining)) {
            Stop-RevAgentOwnedProcess -Process $process
            return $null
        }
        $stdout = Get-RevAgentTaskResult -Task $stdoutTask
        $stderr = Get-RevAgentTaskResult -Task $stderrTask
        return [pscustomobject][ordered]@{
            ExitCode = $process.ExitCode
            Stdout = $stdout
            Stderr = $stderr
        }
    }
    catch {
        Stop-RevAgentOwnedProcess -Process $process
        return $null
    }
    finally {
        if ($null -ne $process) { $process.Dispose() }
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
        [int]$TimeoutMilliseconds = 30000
    )

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $operationDeadline = [Math]::Max(
        500,
        $TimeoutMilliseconds - [Math]::Max(250, [int]($TimeoutMilliseconds * 0.30))
    )
    $source = $null
    $destination = $null
    $sourceExit = $null
    $destinationExit = $null
    $copySucceeded = $false
    $operationTimedOut = $false
    $sourceStderr = $null
    $destinationStdout = $null
    $destinationStderr = $null
    $sourceAbsent = $false
    $terminalUncertain = $false
    $sourceMetadataClean = $false

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
            if ($remaining -le 0 -or -not $source.WaitForExit($remaining)) {
                $operationTimedOut = $true
            }
            else {
                $sourceExit = $source.ExitCode
            }
        }

        if ($operationTimedOut) {
            if (-not (Stop-RevAgentOwnedProcess -Process $source)) {
                $terminalUncertain = $true
            }
        }

        # Source exit alone is not success. Harvest its bounded stderr before
        # the cleanup probe and before the receiver commit decision; any byte
        # (or unreadable stream) forces abort so a later metadata failure can
        # never leave a committed destination.
        try {
            $sourceStderr = Get-RevAgentTaskResult -Task $sourceStderrTask
            $sourceMetadataClean = $sourceStderr.Length -eq 0
        }
        catch {
            $sourceMetadataClean = $false
        }

        # The source endpoint and its attempt-scoped remote process/container
        # must both be positively absent before the receiver is committed.
        # Until this cleanup/probe succeeds, the destination owns only an
        # abortable private file and cannot make the handoff durable.
        $sourceProbe = Invoke-RevAgentMetadataProcess `
            -StartInfo $SourceProbeStartInfo `
            -Stopwatch $stopwatch `
            -DeadlineMilliseconds $TimeoutMilliseconds
        $sourceAbsent = $null -ne $sourceProbe -and
            $sourceProbe.ExitCode -eq 0 -and
            $sourceProbe.Stderr.Length -eq 0 -and
            (Test-RevAgentSourceProbeResult `
                -Value (ConvertFrom-RevAgentMetadataBytes -Bytes $sourceProbe.Stdout) `
                -Kind $Kind)

        $commit = -not $operationTimedOut -and $copySucceeded -and
            $sourceExit -eq 0 -and $sourceMetadataClean -and $sourceAbsent
        try {
            if (-not $destination.HasExited) {
                $destination.StandardInput.BaseStream.WriteByte($(if ($commit) { 1 } else { 0 }))
                $destination.StandardInput.BaseStream.Flush()
            }
        }
        catch {}
        try { $destination.StandardInput.Dispose() } catch {}

        $remaining = $TimeoutMilliseconds - [int]$stopwatch.ElapsedMilliseconds
        if ($remaining -gt 0 -and $destination.WaitForExit($remaining)) {
            $destinationExit = $destination.ExitCode
        }
        else {
            $operationTimedOut = $true
            if (-not (Stop-RevAgentOwnedProcess -Process $destination)) {
                $terminalUncertain = $true
            }
        }

        try { $destinationStdout = Get-RevAgentTaskResult -Task $destinationStdoutTask } catch {}
        try { $destinationStderr = Get-RevAgentTaskResult -Task $destinationStderrTask } catch {}
    }
    catch {
        $operationTimedOut = $true
        try { if ($null -ne $destination) { $destination.StandardInput.Dispose() } } catch {}
        if (-not (Stop-RevAgentOwnedProcess -Process $source)) { $terminalUncertain = $true }
        if (-not (Stop-RevAgentOwnedProcess -Process $destination)) { $terminalUncertain = $true }
    }
    finally {
        if (-not (Stop-RevAgentOwnedProcess -Process $source)) { $terminalUncertain = $true }
        if (-not (Stop-RevAgentOwnedProcess -Process $destination)) { $terminalUncertain = $true }
        if ($null -ne $source) { $source.Dispose() }
        if ($null -ne $destination) { $destination.Dispose() }
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

    else {
        -not $operationTimedOut -and
        $sourceExit -eq 0 -and $sourceAbsent -and $destinationExit -eq 78 -and
        $sourceMetadataClean -and $destinationMetadataClean -and
        (Test-RevAgentNorthDestinationResult -Value $destinationMetadata)
    }

    $destinationAbsent = $false
    if ($Kind -eq "enrollment_artifact" -and $operationSucceeded) {
        # A successful enrollment handoff intentionally retains the protected
        # destination for the separately authorized one-shot consumer.
        $destinationAbsent = $false
    }
    else {
        $destinationProbe = Invoke-RevAgentMetadataProcess `
            -StartInfo $DestinationProbeStartInfo `
            -Stopwatch $stopwatch `
            -DeadlineMilliseconds $TimeoutMilliseconds
        $destinationAbsent = $null -ne $destinationProbe -and
            $destinationProbe.ExitCode -eq 0 -and
            $destinationProbe.Stderr.Length -eq 0 -and
            (Test-RevAgentDestinationProbeResult `
                -Value (ConvertFrom-RevAgentMetadataBytes -Bytes $destinationProbe.Stdout) `
                -Kind $Kind)
    }

    if ($terminalUncertain -or -not $sourceAbsent -or
        (-not ($Kind -eq "enrollment_artifact" -and $operationSucceeded) -and
            -not $destinationAbsent)) {
        return New-RevAgentCleanupUncertainResult -Kind $Kind
    }
    if (-not $operationSucceeded) {
        return New-RevAgentHandoffFailureResult -Kind $Kind
    }
    if ($Kind -eq "north_bearer") {
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
