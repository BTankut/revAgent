<#
.SYNOPSIS
    Run optional live Revit commandset integration checks.

.DESCRIPTION
    This script connects directly to the Revit MCP socket and validates the
    dynamic command payload in a real Revit session. It is intentionally not
    part of scripts/test-all.ps1 because it requires Revit 2022 with revAgent
    loaded and an active document.

    The checks are read/probe oriented: transactionMode auto/none, guarded
    manual-transaction blocking, manual transaction rollback in none mode, and
    dynamic Newtonsoft.Json compilation.
#>

[CmdletBinding()]
param(
    [string]$HostName = "",
    [int]$Port = 0,
    [int]$TimeoutMs = 120000
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($HostName)) {
    if ([string]::IsNullOrWhiteSpace($env:REVIT_MCP_HOST)) {
        $HostName = "localhost"
    }
    else {
        $HostName = $env:REVIT_MCP_HOST
    }
}

if ($Port -le 0) {
    if ([int]::TryParse($env:REVIT_MCP_PORT, [ref]$Port) -and $Port -gt 0) {
        # Use parsed environment port.
    }
    else {
        $Port = 8080
    }
}

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Equal {
    param(
        [object]$Actual,
        [object]$Expected,
        [string]$Message
    )

    if ($Actual -ne $Expected) {
        throw "$Message Expected '$Expected', got '$Actual'."
    }
}

function Read-ExactBytes {
    param(
        [System.IO.Stream]$Stream,
        [int]$Count
    )

    $buffer = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
        $read = $Stream.Read($buffer, $offset, $Count - $offset)
        if ($read -le 0) {
            throw "Socket closed while reading response."
        }
        $offset += $read
    }
    return $buffer
}

function ConvertFrom-RevitJsonLike {
    param(
        [object]$Value,
        [int]$Depth = 0
    )

    if ($Depth -ge 4 -or -not ($Value -is [string])) {
        return $Value
    }

    $text = $Value.Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $Value
    }

    if ($text -eq "true") {
        return $true
    }
    if ($text -eq "false") {
        return $false
    }
    if ($text -eq "null") {
        return $null
    }

    $looksJsonLike =
        $text.StartsWith("{") -or
        $text.StartsWith("[") -or
        $text.StartsWith('"')

    if (-not $looksJsonLike) {
        return $Value
    }

    try {
        $parsed = $text | ConvertFrom-Json
        if ($parsed -is [string]) {
            return ConvertFrom-RevitJsonLike -Value $parsed -Depth ($Depth + 1)
        }
        return $parsed
    }
    catch {
        return $Value
    }
}

function Invoke-RevitMcpRequest {
    param(
        [string]$Method,
        [object]$Params = @{}
    )

    $client = New-Object System.Net.Sockets.TcpClient
    $client.ReceiveTimeout = $TimeoutMs
    $client.SendTimeout = $TimeoutMs

    try {
        $client.Connect($HostName, $Port)
        $stream = $client.GetStream()

        $requestId = [Guid]::NewGuid().ToString("N")
        $request = [ordered]@{
            jsonrpc = "2.0"
            method = $Method
            params = $Params
            id = $requestId
        }
        $json = $request | ConvertTo-Json -Depth 30 -Compress
        $payload = [System.Text.Encoding]::UTF8.GetBytes($json)
        $header = [System.BitConverter]::GetBytes([uint32]$payload.Length)
        if ([System.BitConverter]::IsLittleEndian) {
            [array]::Reverse($header)
        }

        $stream.Write($header, 0, $header.Length)
        $stream.Write($payload, 0, $payload.Length)
        $stream.Flush()

        $responseHeader = Read-ExactBytes -Stream $stream -Count 4
        if ([System.BitConverter]::IsLittleEndian) {
            [array]::Reverse($responseHeader)
        }
        $responseLength = [System.BitConverter]::ToUInt32($responseHeader, 0)
        Assert-True ($responseLength -gt 0 -and $responseLength -le (32 * 1024 * 1024)) "Invalid response frame length: $responseLength"

        $responseBytes = Read-ExactBytes -Stream $stream -Count ([int]$responseLength)
        $responseJson = [System.Text.Encoding]::UTF8.GetString($responseBytes)
        $response = $responseJson | ConvertFrom-Json

        if ($response.error) {
            throw "Revit MCP request '$Method' failed: $($response.error.message)"
        }

        return $response.result
    }
    finally {
        $client.Close()
    }
}

function Get-RevitMcpStatus {
    return Invoke-RevitMcpRequest -Method "mcp_status" -Params @{}
}

function Assert-RevitMcpReady {
    param([string]$NextCommand)

    $status = Get-RevitMcpStatus
    if ($status.activeTask) {
        $taskName = $status.activeTask.taskName
        if ([string]::IsNullOrWhiteSpace($taskName)) {
            $taskName = $status.activeTask.method
        }
        $elapsedMs = $status.activeTask.elapsedMs
        throw "Revit MCP is busy with '$taskName' ($elapsedMs ms). Wait before running '$NextCommand'."
    }
    return $status
}

function Invoke-RevitCode {
    param(
        [string]$Code,
        [ValidateSet("auto", "none")]
        [string]$TransactionMode,
        [string]$TaskName
    )

    Assert-RevitMcpReady -NextCommand "send_code_to_revit" | Out-Null
    $params = [ordered]@{
        code = $Code
        parameters = @()
        transactionMode = $TransactionMode
        taskName = $TaskName
    }
    return Invoke-RevitMcpRequest -Method "send_code_to_revit" -Params $params
}

function Assert-SuccessfulCodeResult {
    param(
        [object]$Result,
        [string]$CaseName
    )

    Assert-True ($null -ne $Result) "$CaseName returned no result."
    Assert-Equal ([bool]$Result.success) $true "$CaseName should succeed."
    Assert-Equal ([bool]$Result.guarded) $false "$CaseName should not be guarded."
}

Write-Host "Live commandset integration target: $HostName`:$Port"

$initialStatus = Assert-RevitMcpReady -NextCommand "live commandset tests"
Assert-True ($initialStatus.service.isRunning -eq $true) "Revit MCP service did not report running."

$prefix = "revAgent commandset live " + (Get-Date -Format "HHmmss")

Write-Host "Test transactionMode none and Newtonsoft.Json compile"
$noneProbe = Invoke-RevitCode `
    -TransactionMode "none" `
    -TaskName "$prefix none probe" `
    -Code @'
return Newtonsoft.Json.JsonConvert.SerializeObject(new {
    caseName = "none_read_probe",
    isModifiable = document.IsModifiable,
    title = document.Title
});
'@
Assert-SuccessfulCodeResult -Result $noneProbe -CaseName "transactionMode none probe"
$nonePayload = ConvertFrom-RevitJsonLike -Value $noneProbe.result
Assert-Equal ([bool]$nonePayload.isModifiable) $false "transactionMode none should run outside the wrapper transaction."

Write-Host "Test transactionMode auto wrapper transaction"
$autoProbe = Invoke-RevitCode `
    -TransactionMode "auto" `
    -TaskName "$prefix auto probe" `
    -Code @'
return Newtonsoft.Json.JsonConvert.SerializeObject(new {
    caseName = "auto_read_probe",
    isModifiable = document.IsModifiable,
    title = document.Title
});
'@
Assert-SuccessfulCodeResult -Result $autoProbe -CaseName "transactionMode auto probe"
$autoPayload = ConvertFrom-RevitJsonLike -Value $autoProbe.result
Assert-Equal ([bool]$autoPayload.isModifiable) $true "transactionMode auto should run inside the wrapper transaction."

Write-Host "Test guarded manual transaction under auto"
$guardTaskName = "$prefix guarded manual tx"
$guardedProbe = Invoke-RevitCode `
    -TransactionMode "auto" `
    -TaskName $guardTaskName `
    -Code @'
using (var tx = new Transaction(document, "revAgent live test should be guarded"))
{
    tx.Start();
    tx.RollBack();
}
return "unexpected";
'@
Assert-Equal ([bool]$guardedProbe.success) $false "Manual transaction under auto should not report success."
Assert-Equal ([bool]$guardedProbe.guarded) $true "Manual transaction under auto should be guarded."
Assert-Equal ([string]$guardedProbe.guardReason) "manual_transaction_requires_transactionMode_none" "Manual transaction guard reason changed."

$statusAfterGuard = Get-RevitMcpStatus
$guardedRecent = @($statusAfterGuard.recentTasks) | Where-Object { $_.taskName -eq $guardTaskName } | Select-Object -First 1
Assert-True ($null -ne $guardedRecent) "Guarded task was not found in recent task history."
Assert-Equal ([string]$guardedRecent.state) "guarded" "Guarded task history state changed."

Write-Host "Test manual transaction rollback under none"
$manualNoneProbe = Invoke-RevitCode `
    -TransactionMode "none" `
    -TaskName "$prefix none manual tx rollback" `
    -Code @'
string started;
string rolledBack;
using (var tx = new Transaction(document, "revAgent live rollback probe"))
{
    started = tx.Start().ToString();
    rolledBack = tx.RollBack().ToString();
}
return Newtonsoft.Json.JsonConvert.SerializeObject(new {
    caseName = "none_manual_transaction_rollback",
    started = started,
    rolledBack = rolledBack,
    isModifiableAfterRollback = document.IsModifiable
});
'@
Assert-SuccessfulCodeResult -Result $manualNoneProbe -CaseName "transactionMode none manual transaction rollback"
$manualNonePayload = ConvertFrom-RevitJsonLike -Value $manualNoneProbe.result
Assert-Equal ([string]$manualNonePayload.started) "Started" "Manual transaction under none did not start."
Assert-Equal ([string]$manualNonePayload.rolledBack) "RolledBack" "Manual transaction under none did not roll back."
Assert-Equal ([bool]$manualNonePayload.isModifiableAfterRollback) $false "Document should not remain modifiable after rollback."

$finalStatus = Get-RevitMcpStatus
Assert-True ($null -eq $finalStatus.activeTask) "Revit MCP active task should be clear after live commandset tests."

Write-Host "Live commandset integration tests passed." -ForegroundColor Green
