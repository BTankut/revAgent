<#
.SYNOPSIS
    Export bounded Codex session context for revAgent usage correlation.

.DESCRIPTION
    Reads local Codex session JSONL files on a production workstation and writes
    bounded context JSON under the NAS reports tree. This script intentionally
    does not export a full raw transcript.
#>

[CmdletBinding()]
param(
    [string]$SessionRoot = "",
    [string[]]$SessionFile = @(),
    [string]$ReportsRoot = "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports",
    [string]$DateUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd"),
    [string]$OutputRoot = "",
    [string]$MachineName = $env:COMPUTERNAME,
    [string]$UserName = $env:USERNAME,
    [int]$MaxTextChars = 600,
    [int]$MaxUserRequests = 12,
    [int]$MaxAssistantOutcomes = 8,
    [int]$MaxToolCalls = 80
)

$ErrorActionPreference = "Stop"

function Get-ReportValue {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object -or [string]::IsNullOrWhiteSpace($Name)) {
        return $null
    }

    if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($Name)) {
        return $Object[$Name]
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($property) {
        return $property.Value
    }

    return $null
}

function Get-NestedReportValue {
    param(
        [object]$Object,
        [string[]]$Path
    )

    $current = $Object
    foreach ($part in $Path) {
        $current = Get-ReportValue -Object $current -Name $part
        if ($null -eq $current) {
            return $null
        }
    }

    return $current
}

function ConvertTo-UtcDate {
    param([string]$Value)

    try {
        return ([datetime]::ParseExact(
            $Value,
            "yyyy-MM-dd",
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AssumeUniversal
        )).ToUniversalTime()
    }
    catch {
        throw "DateUtc must use yyyy-MM-dd, got '$Value'."
    }
}

function ConvertTo-BoundedText {
    param(
        [object]$Value,
        [int]$Limit
    )

    if ($null -eq $Value) {
        return ""
    }

    $text = ([string]$Value).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        return ""
    }

    $text = ($text -replace '\s+', ' ').Trim()
    if ($Limit -gt 0 -and $text.Length -gt $Limit) {
        return $text.Substring(0, $Limit) + "..."
    }

    return $text
}

function ConvertTo-SafePathSegment {
    param([string]$Value)

    $text = if ([string]::IsNullOrWhiteSpace($Value)) { "unknown" } else { $Value }
    $text = $text -replace '[<>:"/\\|?*\x00-\x1F]', '_'
    $text = $text.Trim(". ")
    if ([string]::IsNullOrWhiteSpace($text)) {
        return "unknown"
    }
    if ($text.Length -gt 120) {
        return $text.Substring(0, 120)
    }
    return $text
}

function Get-EventTimestamp {
    param([object]$Event)

    $candidates = @(
        (Get-ReportValue -Object $Event -Name "timestampUtc"),
        (Get-ReportValue -Object $Event -Name "timestamp"),
        (Get-ReportValue -Object $Event -Name "createdAt"),
        (Get-ReportValue -Object $Event -Name "created_at"),
        (Get-NestedReportValue -Object $Event -Path @("payload", "timestampUtc")),
        (Get-NestedReportValue -Object $Event -Path @("payload", "timestamp"))
    )

    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace([string]$candidate)) {
            continue
        }
        try {
            return ([datetime]::Parse(
                [string]$candidate,
                [System.Globalization.CultureInfo]::InvariantCulture,
                [System.Globalization.DateTimeStyles]::AssumeUniversal
            )).ToUniversalTime()
        }
        catch {
        }
    }

    return $null
}

function Add-UniqueString {
    param(
        [System.Collections.Generic.List[string]]$List,
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return
    }
    if (-not $List.Contains($Value)) {
        [void]$List.Add($Value)
    }
}

function Add-BoundedEntry {
    param(
        [System.Collections.Generic.List[object]]$List,
        [object]$Entry,
        [int]$Limit
    )

    if ($Limit -lt 1) {
        return
    }
    if ($List.Count -lt $Limit) {
        [void]$List.Add($Entry)
    }
}

function Get-TextFragments {
    param([object]$Value)

    $items = [System.Collections.Generic.List[string]]::new()
    if ($null -eq $Value) {
        return $items.ToArray()
    }

    if ($Value -is [string]) {
        Add-UniqueString -List $items -Value ([string]$Value)
        return $items.ToArray()
    }

    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        foreach ($entry in $Value) {
            foreach ($fragment in Get-TextFragments -Value $entry) {
                Add-UniqueString -List $items -Value $fragment
            }
        }
        return $items.ToArray()
    }

    foreach ($name in @("text", "content", "input_text", "output_text", "message")) {
        $candidate = Get-ReportValue -Object $Value -Name $name
        if ($candidate -is [string]) {
            Add-UniqueString -List $items -Value ([string]$candidate)
        }
    }

    return $items.ToArray()
}

function Get-ResponseItem {
    param([object]$Event)

    $payload = Get-ReportValue -Object $Event -Name "payload"
    $item = Get-ReportValue -Object $Event -Name "item"
    if ($null -eq $item) {
        $item = Get-ReportValue -Object $payload -Name "item"
    }
    if ($null -eq $item) {
        $item = Get-ReportValue -Object $payload -Name "response_item"
    }
    if ($null -eq $item -and ([string](Get-ReportValue -Object $Event -Name "type")) -eq "response_item") {
        $item = $payload
    }

    return $item
}

function Get-CodexSessionFiles {
    param(
        [string]$Root,
        [datetime]$Date
    )

    if (-not [string]::IsNullOrWhiteSpace($SessionFile)) {
        return @($SessionFile | ForEach-Object {
            if (-not (Test-Path -LiteralPath $_ -PathType Leaf)) {
                throw "Codex session file was not found: $_"
            }
            Get-Item -LiteralPath $_
        })
    }

    if ([string]::IsNullOrWhiteSpace($Root)) {
        $codexHome = $env:CODEX_HOME
        if ([string]::IsNullOrWhiteSpace($codexHome)) {
            $codexHome = Join-Path $HOME ".codex"
        }
        $Root = Join-Path $codexHome "sessions"
    }

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return @()
    }

    $dateRoot = Join-Path (Join-Path (Join-Path $Root $Date.ToString("yyyy")) $Date.ToString("MM")) $Date.ToString("dd")
    if (Test-Path -LiteralPath $dateRoot -PathType Container) {
        return @(Get-ChildItem -LiteralPath $dateRoot -File -Filter "*.jsonl" -ErrorAction SilentlyContinue)
    }

    $start = $Date.Date
    $end = $start.AddDays(1)
    return @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter "*.jsonl" -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTimeUtc -ge $start -and $_.LastWriteTimeUtc -lt $end })
}

function New-CodexSessionContext {
    param(
        [System.IO.FileInfo]$File,
        [datetime]$Date
    )

    $sessionId = ""
    $threadId = ""
    $workspacePaths = [System.Collections.Generic.List[string]]::new()
    $workspaceNames = [System.Collections.Generic.List[string]]::new()
    $userRequests = [System.Collections.Generic.List[object]]::new()
    $assistantOutcomes = [System.Collections.Generic.List[object]]::new()
    $toolCalls = [System.Collections.Generic.List[object]]::new()
    $toolCounts = @{}
    $timestamps = [System.Collections.Generic.List[datetime]]::new()
    $badLineCount = 0
    $lineCount = 0

    foreach ($line in [System.IO.File]::ReadLines($File.FullName, [System.Text.Encoding]::UTF8)) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        $lineCount++
        try {
            $event = $line | ConvertFrom-Json
        }
        catch {
            $badLineCount++
            continue
        }

        $timestamp = Get-EventTimestamp -Event $event
        if ($null -ne $timestamp) {
            [void]$timestamps.Add($timestamp)
        }

        $type = [string](Get-ReportValue -Object $event -Name "type")
        $payload = Get-ReportValue -Object $event -Name "payload"

        if ($type -eq "session_meta" -or $null -ne (Get-ReportValue -Object $payload -Name "id")) {
            $payloadId = [string](Get-ReportValue -Object $payload -Name "id")
            if ([string]::IsNullOrWhiteSpace($sessionId) -and -not [string]::IsNullOrWhiteSpace($payloadId)) {
                $sessionId = $payloadId
            }
            $payloadThread = [string](Get-ReportValue -Object $payload -Name "thread_id")
            if ([string]::IsNullOrWhiteSpace($payloadThread)) {
                $payloadThread = [string](Get-ReportValue -Object $payload -Name "threadId")
            }
            if ([string]::IsNullOrWhiteSpace($threadId) -and -not [string]::IsNullOrWhiteSpace($payloadThread)) {
                $threadId = $payloadThread
            }
        }

        foreach ($workspaceCandidate in @(
                (Get-ReportValue -Object $event -Name "cwd"),
                (Get-ReportValue -Object $payload -Name "cwd"),
                (Get-ReportValue -Object $event -Name "workdir"),
                (Get-ReportValue -Object $payload -Name "workdir"),
                (Get-NestedReportValue -Object $event -Path @("environment_context", "cwd")),
                (Get-NestedReportValue -Object $payload -Path @("environment_context", "cwd"))
            )) {
            if (-not [string]::IsNullOrWhiteSpace([string]$workspaceCandidate)) {
                $workspaceText = [string]$workspaceCandidate
                Add-UniqueString -List $workspacePaths -Value $workspaceText
                try {
                    Add-UniqueString -List $workspaceNames -Value ([System.IO.Path]::GetFileName($workspaceText.TrimEnd("\", "/")))
                }
                catch {
                }
            }
        }

        $item = Get-ResponseItem -Event $event
        if ($null -eq $item) {
            continue
        }

        $itemType = [string](Get-ReportValue -Object $item -Name "type")
        $role = [string](Get-ReportValue -Object $item -Name "role")
        $content = Get-ReportValue -Object $item -Name "content"
        if ($null -eq $content) {
            $content = Get-ReportValue -Object $item -Name "message"
        }

        if ($role -eq "user") {
            foreach ($fragment in Get-TextFragments -Value $content) {
                $bounded = ConvertTo-BoundedText -Value $fragment -Limit $MaxTextChars
                if (-not [string]::IsNullOrWhiteSpace($bounded)) {
                    Add-BoundedEntry -List $userRequests -Limit $MaxUserRequests -Entry ([ordered]@{
                            timestampUtc = if ($timestamp) { $timestamp.ToString("o") } else { $null }
                            text = $bounded
                        })
                }
            }
        }
        elseif ($role -eq "assistant") {
            foreach ($fragment in Get-TextFragments -Value $content) {
                $bounded = ConvertTo-BoundedText -Value $fragment -Limit $MaxTextChars
                if (-not [string]::IsNullOrWhiteSpace($bounded)) {
                    Add-BoundedEntry -List $assistantOutcomes -Limit $MaxAssistantOutcomes -Entry ([ordered]@{
                            timestampUtc = if ($timestamp) { $timestamp.ToString("o") } else { $null }
                            text = $bounded
                        })
                }
            }
        }

        $toolName = [string](Get-ReportValue -Object $item -Name "name")
        if ([string]::IsNullOrWhiteSpace($toolName)) {
            $toolName = [string](Get-ReportValue -Object $item -Name "toolName")
        }
        if (($itemType -match '(?i)(function_call|tool_call|mcp_call)') -and -not [string]::IsNullOrWhiteSpace($toolName)) {
            if (-not $toolCounts.ContainsKey($toolName)) {
                $toolCounts[$toolName] = 0
            }
            $toolCounts[$toolName]++
            Add-BoundedEntry -List $toolCalls -Limit $MaxToolCalls -Entry ([ordered]@{
                    timestampUtc = if ($timestamp) { $timestamp.ToString("o") } else { $null }
                    name = $toolName
                    type = $itemType
                })
        }
    }

    if ([string]::IsNullOrWhiteSpace($sessionId)) {
        $sessionId = [System.IO.Path]::GetFileNameWithoutExtension($File.Name)
    }

    $startedAt = $null
    $endedAt = $null
    if ($timestamps.Count -gt 0) {
        $orderedTimes = @($timestamps | Sort-Object)
        $startedAt = $orderedTimes[0]
        $endedAt = $orderedTimes[$orderedTimes.Count - 1]
    }
    else {
        $startedAt = $File.LastWriteTimeUtc
        $endedAt = $File.LastWriteTimeUtc
    }

    $toolUsage = @($toolCounts.GetEnumerator() |
        Sort-Object @{ Expression = { $_.Value }; Descending = $true }, Name |
        ForEach-Object {
            [ordered]@{
                name = [string]$_.Key
                count = [int]$_.Value
            }
        })

    [ordered]@{
        schemaVersion = "revagent.codex.session.context.v1"
        generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        dateUtc = $Date.ToString("yyyy-MM-dd")
        source = [ordered]@{
            path = $File.FullName
            lineCount = $lineCount
            badLineCount = $badLineCount
            rawTranscriptIncluded = $false
        }
        machineName = $MachineName
        userName = $UserName
        codexSessionId = $sessionId
        threadId = $threadId
        startedAtUtc = $startedAt.ToUniversalTime().ToString("o")
        endedAtUtc = $endedAt.ToUniversalTime().ToString("o")
        workspace = [ordered]@{
            paths = @($workspacePaths.ToArray())
            names = @($workspaceNames.ToArray())
        }
        limits = [ordered]@{
            maxTextChars = $MaxTextChars
            maxUserRequests = $MaxUserRequests
            maxAssistantOutcomes = $MaxAssistantOutcomes
            maxToolCalls = $MaxToolCalls
        }
        userRequests = @($userRequests.ToArray())
        assistantOutcomes = @($assistantOutcomes.ToArray())
        toolCalls = @($toolCalls.ToArray())
        toolUsage = @($toolUsage)
    }
}

$date = ConvertTo-UtcDate -Value $DateUtc
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $ReportsRoot "codex-sessions"
}

$files = @(Get-CodexSessionFiles -Root $SessionRoot -Date $date)
$written = [System.Collections.Generic.List[object]]::new()
$machineSegment = ConvertTo-SafePathSegment -Value $MachineName
$dayRoot = Join-Path (Join-Path (Join-Path (Join-Path $OutputRoot $date.ToString("yyyy")) $date.ToString("MM")) $date.ToString("dd")) $machineSegment
New-Item -ItemType Directory -Path $dayRoot -Force | Out-Null

foreach ($file in $files) {
    $context = New-CodexSessionContext -File $file -Date $date
    $safeSessionId = ConvertTo-SafePathSegment -Value ([string]$context.codexSessionId)
    $outputPath = Join-Path $dayRoot ("{0}.context.json" -f $safeSessionId)
    $context | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $outputPath -Encoding UTF8
    [void]$written.Add([ordered]@{
            codexSessionId = $context.codexSessionId
            threadId = $context.threadId
            path = $outputPath
            userRequestCount = @($context.userRequests).Count
            assistantOutcomeCount = @($context.assistantOutcomes).Count
            toolCallCount = @($context.toolCalls).Count
        })
}

[ordered]@{
    schemaVersion = "revagent.codex.session.export.v1"
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    dateUtc = $date.ToString("yyyy-MM-dd")
    machineName = $MachineName
    userName = $UserName
    reportsRoot = $ReportsRoot
    outputRoot = $OutputRoot
    sessionFileCount = $files.Count
    contextCount = $written.Count
    contexts = @($written.ToArray())
} | ConvertTo-Json -Depth 20
