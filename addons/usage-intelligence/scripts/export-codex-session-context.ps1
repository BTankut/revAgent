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
    [string]$SessionIndexFile = "",
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

function Resolve-CodexSessionRoot {
    param([string]$Root)

    if (-not [string]::IsNullOrWhiteSpace($Root)) {
        return $Root
    }

    $codexHome = $env:CODEX_HOME
    if ([string]::IsNullOrWhiteSpace($codexHome)) {
        $codexHome = Join-Path $HOME ".codex"
    }

    return (Join-Path $codexHome "sessions")
}

function Resolve-CodexSessionIndexFile {
    param(
        [string]$Path,
        [string]$ResolvedSessionRoot
    )

    if (-not [string]::IsNullOrWhiteSpace($Path)) {
        return $Path
    }

    if ([string]::IsNullOrWhiteSpace($ResolvedSessionRoot)) {
        return ""
    }

    $parent = Split-Path -Parent $ResolvedSessionRoot
    if ([string]::IsNullOrWhiteSpace($parent)) {
        return ""
    }

    return (Join-Path $parent "session_index.jsonl")
}

$script:CodexSessionExportWarnings = [System.Collections.Generic.List[object]]::new()

function Add-CodexSessionExportWarning {
    param(
        [string]$Code,
        [string]$Path,
        [string]$Message
    )

    [void]$script:CodexSessionExportWarnings.Add([ordered]@{
            code = $Code
            path = $Path
            message = $Message
        })
}

function Read-CodexSessionTextLines {
    param(
        [string]$Path,
        [string]$WarningCode = "codex_session_read_failed"
    )

    try {
        $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
        try {
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
            try {
                while (-not $reader.EndOfStream) {
                    $reader.ReadLine()
                }
            }
            finally {
                $reader.Dispose()
            }
        }
        finally {
            if ($null -ne $stream) {
                $stream.Dispose()
            }
        }
    }
    catch {
        Add-CodexSessionExportWarning -Code $WarningCode -Path $Path -Message $_.Exception.Message
    }
}

function Read-CodexSessionIndex {
    param([string]$Path)

    $map = @{}
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $map
    }

    foreach ($line in Read-CodexSessionTextLines -Path $Path -WarningCode "codex_session_index_read_failed") {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        try {
            $row = $line | ConvertFrom-Json
        }
        catch {
            continue
        }

        $id = [string](Get-ReportValue -Object $row -Name "id")
        if ([string]::IsNullOrWhiteSpace($id)) {
            $id = [string](Get-ReportValue -Object $row -Name "thread_id")
        }
        if ([string]::IsNullOrWhiteSpace($id)) {
            $id = [string](Get-ReportValue -Object $row -Name "threadId")
        }

        $title = [string](Get-ReportValue -Object $row -Name "thread_name")
        if ([string]::IsNullOrWhiteSpace($title)) {
            $title = [string](Get-ReportValue -Object $row -Name "title")
        }
        if ([string]::IsNullOrWhiteSpace($title)) {
            $title = [string](Get-ReportValue -Object $row -Name "name")
        }

        if (-not [string]::IsNullOrWhiteSpace($id) -and -not [string]::IsNullOrWhiteSpace($title) -and -not $map.ContainsKey($id)) {
            $map[$id] = $title
        }
    }

    return $map
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

function Test-TimestampInUtcDate {
    param(
        [object]$Timestamp,
        [datetime]$Date
    )

    if ($null -eq $Timestamp) {
        return $false
    }

    $start = $Date.Date
    $end = $start.AddDays(1)
    return ($Timestamp -ge $start -and $Timestamp -lt $end)
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

function Get-LocalImagePaths {
    param([object]$Payload)

    $paths = [System.Collections.Generic.List[string]]::new()
    foreach ($collectionName in @("local_images", "images")) {
        $collection = Get-ReportValue -Object $Payload -Name $collectionName
        if ($null -eq $collection) {
            continue
        }

        foreach ($image in @($collection)) {
            if ($image -is [string]) {
                Add-UniqueString -List $paths -Value ([string]$image)
                continue
            }

            foreach ($pathName in @("path", "localPath", "local_path", "filePath", "file_path")) {
                $candidate = [string](Get-ReportValue -Object $image -Name $pathName)
                if (-not [string]::IsNullOrWhiteSpace($candidate)) {
                    Add-UniqueString -List $paths -Value $candidate
                }
            }
        }
    }

    return $paths.ToArray()
}

function Get-EventMessageRole {
    param([object]$Payload)

    $payloadType = [string](Get-ReportValue -Object $Payload -Name "type")
    if ($payloadType -eq "user_message") {
        return "user"
    }
    if ($payloadType -eq "agent_message") {
        return "assistant"
    }

    return ""
}

function Get-EventMessageText {
    param([object]$Payload)

    $message = Get-ReportValue -Object $Payload -Name "message"
    if ($message -is [string]) {
        return [string]$message
    }

    $fragments = Get-TextFragments -Value $message
    if (@($fragments).Count -gt 0) {
        return (($fragments | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }) -join [Environment]::NewLine)
    }

    return ""
}

function Get-EventToolName {
    param([object]$Payload)

    foreach ($candidate in @(
            (Get-ReportValue -Object $Payload -Name "name"),
            (Get-ReportValue -Object $Payload -Name "tool"),
            (Get-ReportValue -Object $Payload -Name "toolName"),
            (Get-NestedReportValue -Object $Payload -Path @("invocation", "tool")),
            (Get-NestedReportValue -Object $Payload -Path @("invocation", "name")),
            (Get-NestedReportValue -Object $Payload -Path @("invocation", "toolName"))
        )) {
        if (-not [string]::IsNullOrWhiteSpace([string]$candidate)) {
            return [string]$candidate
        }
    }

    return ""
}

function Test-CodexBootstrapUserText {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $false
    }

    $trimmed = $Text.TrimStart()
    foreach ($pattern in @(
            '(?is)^#\s*AGENTS\.md instructions(\s|$)',
            '(?is)^#\s*AGENTS\.md instructions for\s+',
            '(?is)^<environment_context>',
            '(?is)^##\s*Memory(\s|$)',
            '(?is)^========= MEMORY_SUMMARY BEGINS ========='
        )) {
        if ($trimmed -match $pattern) {
            return $true
        }
    }

    return $false
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

function Test-CodexSessionFileHasVisibleMessageOnDate {
    param(
        [System.IO.FileInfo]$File,
        [datetime]$Date
    )

    $hasEventMessageOnDate = $false
    $hasResponseMessageOnDate = $false

    foreach ($line in Read-CodexSessionTextLines -Path $File.FullName) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        try {
            $event = $line | ConvertFrom-Json
        }
        catch {
            continue
        }

        $timestamp = Get-EventTimestamp -Event $event
        $type = [string](Get-ReportValue -Object $event -Name "type")
        $payload = Get-ReportValue -Object $event -Name "payload"

        if ($type -eq "event_msg") {
            $role = Get-EventMessageRole -Payload $payload
            if (-not [string]::IsNullOrWhiteSpace($role)) {
                if (Test-TimestampInUtcDate -Timestamp $timestamp -Date $Date) {
                    $hasEventMessageOnDate = $true
                }
            }
            continue
        }

        $item = Get-ResponseItem -Event $event
        if ($null -eq $item) {
            continue
        }

        $itemType = [string](Get-ReportValue -Object $item -Name "type")
        $role = [string](Get-ReportValue -Object $item -Name "role")
        if ($itemType -eq "message" -and ($role -eq "user" -or $role -eq "assistant") -and
            (Test-TimestampInUtcDate -Timestamp $timestamp -Date $Date)) {
            $hasResponseMessageOnDate = $true
        }
    }

    return ($hasEventMessageOnDate -or $hasResponseMessageOnDate)
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

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return @()
    }

    return @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter "*.jsonl" -ErrorAction SilentlyContinue |
        Where-Object { Test-CodexSessionFileHasVisibleMessageOnDate -File $_ -Date $Date } |
        Sort-Object FullName)
}

function New-CodexSessionContext {
    param(
        [System.IO.FileInfo]$File,
        [datetime]$Date,
        [hashtable]$SessionIndex
    )

    $sessionId = ""
    $threadId = ""
    $threadTitle = ""
    $workspacePaths = [System.Collections.Generic.List[string]]::new()
    $workspaceNames = [System.Collections.Generic.List[string]]::new()
    $eventUserRequests = [System.Collections.Generic.List[object]]::new()
    $eventAssistantOutcomes = [System.Collections.Generic.List[object]]::new()
    $responseUserRequests = [System.Collections.Generic.List[object]]::new()
    $responseAssistantOutcomes = [System.Collections.Generic.List[object]]::new()
    $toolCalls = [System.Collections.Generic.List[object]]::new()
    $toolCounts = @{}
    $timestamps = [System.Collections.Generic.List[datetime]]::new()
    $eventMessageTimestamps = [System.Collections.Generic.List[datetime]]::new()
    $responseMessageTimestamps = [System.Collections.Generic.List[datetime]]::new()
    $hasEventMessageOnDate = $false
    $badLineCount = 0
    $lineCount = 0

    foreach ($line in Read-CodexSessionTextLines -Path $File.FullName) {
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
        $timestampInDate = Test-TimestampInUtcDate -Timestamp $timestamp -Date $Date

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

        if ($type -eq "event_msg") {
            $eventRole = Get-EventMessageRole -Payload $payload
            if (-not [string]::IsNullOrWhiteSpace($eventRole)) {
                if ($timestampInDate) {
                    $hasEventMessageOnDate = $true
                    $bounded = ConvertTo-BoundedText -Value (Get-EventMessageText -Payload $payload) -Limit $MaxTextChars
                    if (-not [string]::IsNullOrWhiteSpace($bounded)) {
                        if ($null -ne $timestamp) {
                            [void]$eventMessageTimestamps.Add($timestamp)
                        }
                        $entry = [ordered]@{
                            timestampUtc = if ($timestamp) { $timestamp.ToString("o") } else { $null }
                            text = $bounded
                        }
                        $imagePaths = @(Get-LocalImagePaths -Payload $payload)
                        if ($imagePaths.Count -gt 0) {
                            $entry["localImagePaths"] = @($imagePaths)
                        }
                        if ($eventRole -eq "user") {
                            Add-BoundedEntry -List $eventUserRequests -Limit $MaxUserRequests -Entry $entry
                        }
                        elseif ($eventRole -eq "assistant") {
                            Add-BoundedEntry -List $eventAssistantOutcomes -Limit $MaxAssistantOutcomes -Entry $entry
                        }
                    }
                }
            }

            $eventToolName = Get-EventToolName -Payload $payload
            $eventPayloadType = [string](Get-ReportValue -Object $payload -Name "type")
            if ($timestampInDate -and $eventPayloadType -match '(?i)(tool_call|mcp_tool_call)' -and
                -not [string]::IsNullOrWhiteSpace($eventToolName)) {
                if (-not $toolCounts.ContainsKey($eventToolName)) {
                    $toolCounts[$eventToolName] = 0
                }
                $toolCounts[$eventToolName]++
                Add-BoundedEntry -List $toolCalls -Limit $MaxToolCalls -Entry ([ordered]@{
                        timestampUtc = if ($timestamp) { $timestamp.ToString("o") } else { $null }
                        name = $eventToolName
                        type = $eventPayloadType
                    })
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

        if ($timestampInDate -and $role -eq "user") {
            foreach ($fragment in Get-TextFragments -Value $content) {
                $bounded = ConvertTo-BoundedText -Value $fragment -Limit $MaxTextChars
                if (Test-CodexBootstrapUserText -Text $bounded) {
                    continue
                }
                if (-not [string]::IsNullOrWhiteSpace($bounded)) {
                    if ($null -ne $timestamp) {
                        [void]$responseMessageTimestamps.Add($timestamp)
                    }
                    Add-BoundedEntry -List $responseUserRequests -Limit $MaxUserRequests -Entry ([ordered]@{
                            timestampUtc = if ($timestamp) { $timestamp.ToString("o") } else { $null }
                            text = $bounded
                        })
                }
            }
        }
        elseif ($timestampInDate -and $role -eq "assistant") {
            foreach ($fragment in Get-TextFragments -Value $content) {
                $bounded = ConvertTo-BoundedText -Value $fragment -Limit $MaxTextChars
                if (-not [string]::IsNullOrWhiteSpace($bounded)) {
                    if ($null -ne $timestamp) {
                        [void]$responseMessageTimestamps.Add($timestamp)
                    }
                    Add-BoundedEntry -List $responseAssistantOutcomes -Limit $MaxAssistantOutcomes -Entry ([ordered]@{
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
        if ($timestampInDate -and ($itemType -match '(?i)(function_call|tool_call|mcp_call)') -and -not [string]::IsNullOrWhiteSpace($toolName)) {
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
    if ($SessionIndex -and $SessionIndex.ContainsKey($sessionId)) {
        $threadTitle = [string]$SessionIndex[$sessionId]
    }
    if ([string]::IsNullOrWhiteSpace($threadTitle) -and -not [string]::IsNullOrWhiteSpace($threadId) -and $SessionIndex -and $SessionIndex.ContainsKey($threadId)) {
        $threadTitle = [string]$SessionIndex[$threadId]
    }

    $fullStartedAt = $null
    $fullEndedAt = $null
    if ($timestamps.Count -gt 0) {
        $orderedTimes = @($timestamps | Sort-Object)
        $fullStartedAt = $orderedTimes[0]
        $fullEndedAt = $orderedTimes[$orderedTimes.Count - 1]
    }
    else {
        $fullStartedAt = $File.LastWriteTimeUtc
        $fullEndedAt = $File.LastWriteTimeUtc
    }

    $useEventMessages = $hasEventMessageOnDate -and (($eventUserRequests.Count + $eventAssistantOutcomes.Count) -gt 0)
    $userRequestItems = if ($useEventMessages) { @($eventUserRequests.ToArray()) } else { @($responseUserRequests.ToArray()) }
    $assistantOutcomeItems = if ($useEventMessages) { @($eventAssistantOutcomes.ToArray()) } else { @($responseAssistantOutcomes.ToArray()) }
    $messageTimestampItems = if ($useEventMessages) { @($eventMessageTimestamps.ToArray()) } else { @($responseMessageTimestamps.ToArray()) }
    $messageSource = if ($useEventMessages) { "event_msg" } else { "response_item" }
    if (($userRequestItems.Count + $assistantOutcomeItems.Count) -eq 0) {
        return $null
    }

    $startedAt = $fullStartedAt
    $endedAt = $fullEndedAt
    if ($messageTimestampItems.Count -gt 0) {
        $orderedMessageTimes = @($messageTimestampItems | Sort-Object)
        $startedAt = $orderedMessageTimes[0]
        $endedAt = $orderedMessageTimes[$orderedMessageTimes.Count - 1]
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
            messageSource = $messageSource
            visibleMessageCount = ($userRequestItems.Count + $assistantOutcomeItems.Count)
            fullStartedAtUtc = $fullStartedAt.ToUniversalTime().ToString("o")
            fullEndedAtUtc = $fullEndedAt.ToUniversalTime().ToString("o")
        }
        machineName = $MachineName
        userName = $UserName
        codexSessionId = $sessionId
        threadId = $threadId
        threadTitle = $threadTitle
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
        userRequests = @($userRequestItems)
        assistantOutcomes = @($assistantOutcomeItems)
        toolCalls = @($toolCalls.ToArray())
        toolUsage = @($toolUsage)
    }
}

$date = ConvertTo-UtcDate -Value $DateUtc
$resolvedSessionRoot = Resolve-CodexSessionRoot -Root $SessionRoot
$resolvedSessionIndexFile = Resolve-CodexSessionIndexFile -Path $SessionIndexFile -ResolvedSessionRoot $resolvedSessionRoot
$sessionIndex = Read-CodexSessionIndex -Path $resolvedSessionIndexFile
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $ReportsRoot "codex-sessions"
}

$files = @(Get-CodexSessionFiles -Root $resolvedSessionRoot -Date $date)
$written = [System.Collections.Generic.List[object]]::new()
$machineSegment = ConvertTo-SafePathSegment -Value $MachineName
$dayRoot = Join-Path (Join-Path (Join-Path (Join-Path $OutputRoot $date.ToString("yyyy")) $date.ToString("MM")) $date.ToString("dd")) $machineSegment
New-Item -ItemType Directory -Path $dayRoot -Force | Out-Null

foreach ($file in $files) {
    $context = New-CodexSessionContext -File $file -Date $date -SessionIndex $sessionIndex
    if ($null -eq $context) {
        continue
    }
    $safeSessionId = ConvertTo-SafePathSegment -Value ([string]$context.codexSessionId)
    $outputPath = Join-Path $dayRoot ("{0}.context.json" -f $safeSessionId)
    $context | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $outputPath -Encoding UTF8
    [void]$written.Add([ordered]@{
            codexSessionId = $context.codexSessionId
            threadId = $context.threadId
            threadTitle = $context.threadTitle
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
    sessionRoot = $resolvedSessionRoot
    sessionIndexFile = $resolvedSessionIndexFile
    sessionFileCount = $files.Count
    contextCount = $written.Count
    warningCount = $script:CodexSessionExportWarnings.Count
    warnings = @($script:CodexSessionExportWarnings.ToArray())
    contexts = @($written.ToArray())
} | ConvertTo-Json -Depth 20
