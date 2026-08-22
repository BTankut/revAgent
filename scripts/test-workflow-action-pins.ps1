[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
$workflowRoot = Join-Path $resolvedRoot '.github\workflows'
if (-not (Test-Path -LiteralPath $workflowRoot -PathType Container)) {
    throw "Workflow directory is missing: $workflowRoot"
}

function Get-ActionManifestFiles {
    param([string]$Root)

    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    $files = [System.Collections.Generic.List[string]]::new()
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($entry in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if ($entry.PSIsContainer) {
                if ($entry.Name -notin @('.git', 'node_modules')) {
                    $pending.Push($entry.FullName)
                }
                continue
            }
            if ($entry.Name -in @('action.yml', 'action.yaml')) {
                $files.Add($entry.FullName)
            }
        }
    }
    return $files
}

function Remove-YamlComment {
    param([string]$Line)

    $quote = [char]0
    for ($index = 0; $index -lt $Line.Length; $index++) {
        $character = $Line[$index]
        if ($quote -ne [char]0) {
            if ($quote -eq '"' -and $character -eq '\' -and ($index + 1) -lt $Line.Length) {
                $index++
                continue
            }
            if ($character -eq $quote) {
                if ($quote -eq "'" -and ($index + 1) -lt $Line.Length -and $Line[$index + 1] -eq "'") {
                    $index++
                    continue
                }
                $quote = [char]0
            }
            continue
        }
        if ($character -in @("'", '"')) {
            $quote = $character
            continue
        }
        if ($character -eq '#' -and ($index -eq 0 -or [char]::IsWhiteSpace($Line[$index - 1]))) {
            return $Line.Substring(0, $index).TrimEnd()
        }
    }
    return $Line
}

function Read-YamlQuotedScalar {
    param([string]$Text, [int]$Start)

    $quote = $Text[$Start]
    $value = [System.Text.StringBuilder]::new()
    $hadEscape = $false
    for ($index = $Start + 1; $index -lt $Text.Length; $index++) {
        $character = $Text[$index]
        if ($quote -eq '"' -and $character -eq '\') {
            $hadEscape = $true
            if (($index + 1) -ge $Text.Length) {
                return [pscustomobject]@{ success = $false; reason = 'unterminated escape'; next = $Text.Length; value = ''; hasEscape = $true }
            }
            [void]$value.Append($Text[$index + 1])
            $index++
            continue
        }
        if ($character -eq $quote) {
            if ($quote -eq "'" -and ($index + 1) -lt $Text.Length -and $Text[$index + 1] -eq "'") {
                [void]$value.Append("'")
                $index++
                continue
            }
            return [pscustomobject]@{ success = $true; reason = ''; next = $index + 1; value = $value.ToString(); hasEscape = $hadEscape }
        }
        [void]$value.Append($character)
    }
    return [pscustomobject]@{ success = $false; reason = 'unterminated quoted scalar'; next = $Text.Length; value = ''; hasEscape = $false }
}

function Test-UnsupportedExplicitMappingKeySyntax {
    param([string]$Line)

    for ($index = 0; $index -lt $Line.Length; $index++) {
        $character = $Line[$index]
        if ($character -eq '$' -and ($index + 2) -lt $Line.Length -and $Line.Substring($index, 3) -eq '${{') {
            $expressionEnd = $Line.IndexOf('}}', $index + 3, [System.StringComparison]::Ordinal)
            if ($expressionEnd -ge 0) {
                $index = $expressionEnd + 1
                continue
            }
        }
        if ($character -in @("'", '"')) {
            $quoted = Read-YamlQuotedScalar -Text $Line -Start $index
            if (-not $quoted.success) { return $false }
            $index = $quoted.next - 1
            continue
        }
        if ($character -ne '?') { continue }
        $previousIsBoundary = $index -eq 0 -or [char]::IsWhiteSpace($Line[$index - 1]) -or $Line[$index - 1] -in @('{', ',')
        if (-not $previousIsBoundary) { continue }
        return $true
    }
    return $false
}

function Test-PotentialQuotedMappingKeyStart {
    param([string]$Line, [int]$Start)

    $previous = $Start - 1
    while ($previous -ge 0 -and [char]::IsWhiteSpace($Line[$previous])) { $previous-- }
    if ($previous -lt 0) { return $true }
    $previousCharacter = [string]$Line[$previous]
    return (($previousCharacter -eq '{') -or ($previousCharacter -eq ',') -or ($previousCharacter -eq '-') -or ($previousCharacter -eq '?'))
}

function Get-UnsupportedYamlIndirectionReason {
    param([string]$Line)

    for ($index = 0; $index -lt $Line.Length; $index++) {
        $character = $Line[$index]
        if ($character -eq '$' -and ($index + 2) -lt $Line.Length -and $Line.Substring($index, 3) -eq '${{') {
            $expressionEnd = $Line.IndexOf('}}', $index + 3, [System.StringComparison]::Ordinal)
            if ($expressionEnd -ge 0) {
                $index = $expressionEnd + 1
                continue
            }
        }
        if ($character -in @("'", '"')) {
            if ($character -eq '"' -and ($index + 1) -lt $Line.Length -and $Line[$index + 1] -eq '@') {
                continue
            }
            $isPotentialKey = Test-PotentialQuotedMappingKeyStart -Line $Line -Start $index
            $quoted = Read-YamlQuotedScalar -Text $Line -Start $index
            if (-not $quoted.success) {
                if ($isPotentialKey) { return 'quoted mapping keys must open and close on one physical line' }
                return $null
            }
            if ($isPotentialKey) {
                $tail = $quoted.next
                while ($tail -lt $Line.Length -and [char]::IsWhiteSpace($Line[$tail])) { $tail++ }
                if ($tail -lt $Line.Length -and $Line[$tail] -eq ':') {
                    if ($quoted.hasEscape) { return 'backslash escapes in double-quoted mapping keys are unsupported' }
                }
            }
            $index = $quoted.next - 1
            continue
        }
        if ($character -in @('&', '*')) {
            $previousIsBoundary = $index -eq 0 -or [char]::IsWhiteSpace($Line[$index - 1]) -or $Line[$index - 1] -in @(':', '[', '{', ',')
            $nextIsAnchorName = ($index + 1) -lt $Line.Length -and -not [char]::IsWhiteSpace($Line[$index + 1]) -and $Line[$index + 1] -notin @('[', ']', '{', '}', ',')
            if ($previousIsBoundary -and $nextIsAnchorName) {
                return 'YAML anchors and aliases are unsupported'
            }
        }
        if ($character -eq '<' -and ($index + 2) -lt $Line.Length -and $Line.Substring($index, 3) -eq '<<:') {
            return 'YAML merge keys are unsupported'
        }
    }
    return $null
}

function Read-YamlUsesValue {
    param([string]$Text, [int]$Start, [bool]$Flow)

    $index = $Start
    while ($index -lt $Text.Length -and [char]::IsWhiteSpace($Text[$index])) { $index++ }
    if ($index -ge $Text.Length) {
        return [pscustomobject]@{ success = $false; reason = 'missing or multiline scalar'; next = $index; value = '' }
    }
    if ($Text[$index] -in @('|', '>')) {
        return [pscustomobject]@{ success = $false; reason = 'multiline scalar is forbidden'; next = $index + 1; value = '' }
    }
    if ($Text[$index] -in @('&', '*')) {
        return [pscustomobject]@{ success = $false; reason = 'anchors and aliases are forbidden'; next = $index + 1; value = '' }
    }

    if ($Text[$index] -in @("'", '"')) {
        $quoted = Read-YamlQuotedScalar -Text $Text -Start $index
        if (-not $quoted.success) {
            return [pscustomobject]@{ success = $false; reason = $quoted.reason; next = $quoted.next; value = '' }
        }
        $tail = $quoted.next
        while ($tail -lt $Text.Length -and [char]::IsWhiteSpace($Text[$tail])) { $tail++ }
        if ($Flow) {
            if ($tail -lt $Text.Length -and $Text[$tail] -notin @(',', '}')) {
                return [pscustomobject]@{ success = $false; reason = 'ambiguous flow scalar'; next = $tail; value = '' }
            }
        }
        elseif ($tail -lt $Text.Length) {
            return [pscustomobject]@{ success = $false; reason = 'ambiguous block scalar'; next = $tail; value = '' }
        }
        return [pscustomobject]@{ success = $true; reason = ''; next = $tail; value = $quoted.value }
    }

    $end = $index
    while ($end -lt $Text.Length) {
        if ($Flow -and $Text[$end] -in @(',', '}')) { break }
        $end++
    }
    $value = $Text.Substring($index, $end - $index).Trim()
    if ([string]::IsNullOrWhiteSpace($value) -or $value -match '\s') {
        return [pscustomobject]@{ success = $false; reason = 'ambiguous scalar'; next = $end; value = '' }
    }
    return [pscustomobject]@{ success = $true; reason = ''; next = $end; value = $value }
}

function Test-AllowedUsesValue {
    param([string]$Value)

    if ($Value -match '^\./') {
        return $Value -match '^\./[A-Za-z0-9._/-]+$' -and $Value -notmatch '(^|/)\.\.(/|$)'
    }
    return $Value -cmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*@[0-9a-f]{40}$'
}

$filePaths = [System.Collections.Generic.List[string]]::new()
foreach ($file in @(Get-ChildItem -LiteralPath $workflowRoot -Recurse -File -Force -ErrorAction Stop | Where-Object {
            $_.Extension -in @('.yml', '.yaml')
        })) {
    $filePaths.Add($file.FullName)
}
foreach ($file in @(Get-ActionManifestFiles -Root $resolvedRoot)) {
    $filePaths.Add($file)
}

$relativeFiles = @(
    $filePaths |
        Sort-Object -Unique |
        ForEach-Object { [System.IO.Path]::GetRelativePath($resolvedRoot, $_).Replace('\', '/') } |
        Sort-Object
)

$violations = [System.Collections.Generic.List[string]]::new()
$externalCount = 0
$localCount = 0

foreach ($relativePath in $relativeFiles) {
    $absolutePath = Join-Path $resolvedRoot ($relativePath.Replace('/', '\'))
    $lineNumber = 0
    $blockScalar = $null
    foreach ($rawLine in @(Get-Content -LiteralPath $absolutePath -ErrorAction Stop)) {
        $lineNumber++
        $indent = ([regex]::Match($rawLine, '^\s*')).Length
        $line = Remove-YamlComment -Line $rawLine
        if ($null -ne $blockScalar) {
            if ([string]::IsNullOrWhiteSpace($rawLine.Trim())) {
                continue
            }
            if ($null -eq $blockScalar.contentIndent) {
                if ($indent -le $blockScalar.indicatorIndent) {
                    $violations.Add(('{0}:{1} block scalar indentation is indeterminate' -f $relativePath, $lineNumber))
                    $blockScalar = $null
                }
                elseif ($null -ne $blockScalar.explicitIndent -and $indent -lt ($blockScalar.indicatorIndent + $blockScalar.explicitIndent)) {
                    $violations.Add(('{0}:{1} block scalar violates its explicit indentation indicator' -f $relativePath, $lineNumber))
                    $blockScalar = $null
                }
                else {
                    $minimumIndent = if ($null -eq $blockScalar.explicitIndent) { $indent } else { $blockScalar.indicatorIndent + $blockScalar.explicitIndent }
                    $blockScalar.contentIndent = [Math]::Max($indent, $minimumIndent)
                    continue
                }
            }
            elseif ($indent -ge $blockScalar.contentIndent) {
                continue
            }
            else {
                $blockScalar = $null
            }
        }
        $isRunScalarLine = $line -match '^\s*run\s*:'
        if (-not $isRunScalarLine) {
            $indirectionReason = Get-UnsupportedYamlIndirectionReason -Line $line
            if ($null -ne $indirectionReason) {
                $violations.Add(('{0}:{1} {2}' -f $relativePath, $lineNumber, $indirectionReason))
                continue
            }
            if (Test-UnsupportedExplicitMappingKeySyntax -Line $line) {
                $violations.Add(('{0}:{1} explicit YAML mapping-key syntax is unsupported' -f $relativePath, $lineNumber))
                continue
            }
        }
        $flowDepth = 0
        for ($index = 0; $index -lt $line.Length; $index++) {
            $character = $line[$index]
            if ($character -eq '{') { $flowDepth++; continue }
            if ($character -eq '}') { if ($flowDepth -gt 0) { $flowDepth-- }; continue }

            $key = $null
            $keyEnd = $index
            $keyHasEscape = $false
            if ($character -in @("'", '"')) {
                $quotedKey = Read-YamlQuotedScalar -Text $line -Start $index
                if (-not $quotedKey.success) {
                    $remaining = $line.Substring($index)
                    if ($remaining -match '^(?i)["'']uses\s*:') {
                        $violations.Add(('{0}:{1} malformed quoted uses key' -f $relativePath, $lineNumber))
                    }
                    continue
                }
                $key = $quotedKey.value
                $keyEnd = $quotedKey.next
                $keyHasEscape = $quotedKey.hasEscape
            }
            elseif ($character -match '[A-Za-z_]') {
                $keyEnd = $index + 1
                while ($keyEnd -lt $line.Length -and $line[$keyEnd] -match '[A-Za-z0-9_-]') { $keyEnd++ }
                $key = $line.Substring($index, $keyEnd - $index)
            }
            else {
                continue
            }

            $colon = $keyEnd
            while ($colon -lt $line.Length -and [char]::IsWhiteSpace($line[$colon])) { $colon++ }
            if ($null -eq $key -or $colon -ge $line.Length -or $line[$colon] -ne ':') {
                $index = [Math]::Max($index, $keyEnd - 1)
                continue
            }
            if ($keyHasEscape) {
                $violations.Add(('{0}:{1} backslash escapes in double-quoted mapping keys are unsupported' -f $relativePath, $lineNumber))
                $index = $keyEnd - 1
                continue
            }

            if (-not [string]::Equals($key, 'uses', [System.StringComparison]::OrdinalIgnoreCase)) {
                $index = [Math]::Max($index, $keyEnd - 1)
                continue
            }

            $location = '{0}:{1}' -f $relativePath, $lineNumber
            if ($key -cne 'uses') {
                $violations.Add("$location uses key must be lowercase literal uses")
            }
            $valueResult = Read-YamlUsesValue -Text $line -Start ($colon + 1) -Flow ($flowDepth -gt 0)
            if (-not $valueResult.success) {
                $violations.Add("$location invalid uses value: $($valueResult.reason)")
            }
            elseif (-not (Test-AllowedUsesValue -Value $valueResult.value)) {
                $violations.Add("$location invalid uses reference: $($valueResult.value); expected ./local-path or owner/repo@lowercase-40-hex")
            }
            elseif ($valueResult.value -match '^\./') {
                $localCount++
            }
            else {
                $externalCount++
            }
            $index = [Math]::Max($index, $valueResult.next - 1)
        }
        $blockMatch = [regex]::Match($line, ':\s*[>|](?<modifiers>[+-]?[1-9]?|[1-9]?[+-]?)\s*$')
        if ($blockMatch.Success) {
            $explicitDigit = [regex]::Match($blockMatch.Groups['modifiers'].Value, '[1-9]')
            $blockScalar = [pscustomobject]@{
                indicatorIndent = $indent
                explicitIndent = if ($explicitDigit.Success) { [int]$explicitDigit.Value } else { $null }
                contentIndent = $null
            }
        }
    }
}

if ($violations.Count -gt 0) {
    $violations | ForEach-Object { Write-Error $_ }
    throw "Immutable GitHub Action pin validation failed with $($violations.Count) violation(s)."
}

Write-Host "Immutable GitHub Action pins passed: external=$externalCount local=$localCount files=$($relativeFiles.Count)."
