[CmdletBinding()]
param(
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot "framing"
}

& node `
    (Join-Path $PSScriptRoot "generate-frame-fixtures.mjs") `
    --output-directory ([System.IO.Path]::GetFullPath($OutputDirectory))
if ($LASTEXITCODE -ne 0) {
    throw "Executable reference frame generation failed with exit code $LASTEXITCODE."
}
