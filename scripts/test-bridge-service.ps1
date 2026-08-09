<#
.SYNOPSIS
    Run the non-admin P3-T2 Bridge service-skeleton gate.

.DESCRIPTION
    Performs a locked restore, Release build/tests, formatting verification,
    win-x64 self-contained single-file publishes, bounded hidden version
    smokes, and a bounded worker-side doctor smoke with a generated strict
    configuration.

    This gate does not install or control a Windows service. SCM lifecycle,
    reboot survival, Event Log registration, and production log-rotation
    evidence remain VM-only P3-T2 acceptance work.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [ValidateRange(1, 120)]
    [int]$SmokeTimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

$solutionPath = Join-Path $RepoRoot "packages\bridge\RevAgent.Bridge.sln"
$hostProjectPath = Join-Path $RepoRoot "packages\bridge\src\RevAgent.Bridge.Host\RevAgent.Bridge.Host.csproj"
$workerProjectPath = Join-Path $RepoRoot "packages\bridge\src\RevAgent.Bridge\RevAgent.Bridge.csproj"
$hostExecutableName = "revagent-bridge-host.exe"
$workerExecutableName = "revagent-bridge.exe"

foreach ($requiredPath in @(
    $solutionPath,
    $hostProjectPath,
    $workerProjectPath
)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required Bridge service gate dependency is missing: $requiredPath"
    }
}

if ($null -eq (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw "The dotnet CLI is required for the Bridge service gate."
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Description,

        [Parameter(Mandatory = $true)]
        [scriptblock]$Command
    )

    Write-Host "==> $Description"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

function Join-NativeArguments {
    param(
        [string[]]$Arguments
    )

    $parts = [System.Collections.Generic.List[string]]::new()
    foreach ($argument in $Arguments) {
        $value = [string]$argument
        if ($value.Length -eq 0) {
            [void]$parts.Add('""')
        }
        elseif ($value -match '[\s"]') {
            [void]$parts.Add('"' + ($value -replace '"', '\"') + '"')
        }
        else {
            [void]$parts.Add($value)
        }
    }

    return ($parts.ToArray() -join " ")
}

function Invoke-BoundedHiddenProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [string[]]$Arguments = @(),

        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,

        [Parameter(Mandatory = $true)]
        [int]$TimeoutSeconds,

        [string]$ClearEnvironmentPrefix = "",

        [hashtable]$EnvironmentOverrides = @{}
    )

    $process = $null
    try {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $FilePath
        $startInfo.Arguments = Join-NativeArguments -Arguments $Arguments
        $startInfo.WorkingDirectory = $WorkingDirectory
        $startInfo.UseShellExecute = $false
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.CreateNoWindow = $true

        if (-not [string]::IsNullOrWhiteSpace($ClearEnvironmentPrefix)) {
            foreach ($key in @($startInfo.EnvironmentVariables.Keys)) {
                if ([string]$key -like "$ClearEnvironmentPrefix*") {
                    [void]$startInfo.EnvironmentVariables.Remove([string]$key)
                }
            }
        }
        foreach ($key in $EnvironmentOverrides.Keys) {
            $startInfo.EnvironmentVariables[[string]$key] =
                [string]$EnvironmentOverrides[$key]
        }

        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        [void]$process.Start()
        $standardOutputTask = $process.StandardOutput.ReadToEndAsync()
        $standardErrorTask = $process.StandardError.ReadToEndAsync()
        $completed = $process.WaitForExit(
            [Math]::Max(1, $TimeoutSeconds) * 1000)

        if (-not $completed) {
            try {
                $process.Kill($true)
            }
            catch {
                try {
                    $process.Kill()
                }
                catch {
                }
            }

            [void]$process.WaitForExit(5000)
            return [pscustomobject]@{
                ExitCode = 124
                TimedOut = $true
                StandardOutput = ""
                StandardError = "Timed out after $TimeoutSeconds second(s)."
            }
        }

        $process.WaitForExit()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            TimedOut = $false
            StandardOutput = [string]$standardOutputTask.Result
            StandardError = [string]$standardErrorTask.Result
        }
    }
    finally {
        if ($null -ne $process) {
            $process.Dispose()
        }
    }
}

function Assert-SingleFilePublish {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PublishDirectory,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedExecutableName
    )

    $files = @(
        Get-ChildItem -LiteralPath $PublishDirectory -File -Recurse -Force
    )
    $forbiddenSidecars = @(
        $files | Where-Object {
            $_.Name -match '\.(dll|deps\.json|runtimeconfig\.json|pdb)$'
        }
    )
    if ($forbiddenSidecars.Count -ne 0) {
        throw (
            "Single-file publish contains forbidden sidecars: " +
            (($forbiddenSidecars | ForEach-Object { $_.Name }) -join ", ")
        )
    }

    if ($files.Count -ne 1 -or
        -not [string]::Equals(
            $files[0].Name,
            $ExpectedExecutableName,
            [StringComparison]::OrdinalIgnoreCase)) {
        $actualNames = @($files | ForEach-Object { $_.Name }) -join ", "
        throw (
            "Single-file publish expected only '$ExpectedExecutableName'; " +
            "actual files: [$actualNames]."
        )
    }

    $directories = @(
        Get-ChildItem -LiteralPath $PublishDirectory -Directory -Recurse -Force
    )
    if ($directories.Count -ne 0) {
        throw "Single-file publish contains unexpected subdirectories."
    }

    return $files[0].FullName
}

function Assert-VersionSmoke {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ExecutablePath,

        [Parameter(Mandatory = $true)]
        [int]$TimeoutSeconds
    )

    $result = Invoke-BoundedHiddenProcess `
        -FilePath $ExecutablePath `
        -Arguments @("--version") `
        -WorkingDirectory (Split-Path -Parent $ExecutablePath) `
        -TimeoutSeconds $TimeoutSeconds `
        -ClearEnvironmentPrefix "REVAGENT_BRIDGE_"

    if ($result.TimedOut) {
        throw "'$ExecutablePath --version' exceeded the bounded smoke timeout."
    }
    if ($result.ExitCode -ne 0) {
        throw (
            "'$ExecutablePath --version' failed with exit code " +
            "$($result.ExitCode): $($result.StandardError)"
        )
    }
    if ([string]::IsNullOrWhiteSpace(
            $result.StandardOutput + $result.StandardError)) {
        throw "'$ExecutablePath --version' returned no version text."
    }
}

function Get-RequiredJsonProperty {
    param(
        [Parameter(Mandatory = $true)]
        [object]$InputObject,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$ObjectPath
    )

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        throw "Doctor output is missing '$ObjectPath.$Name'."
    }

    return $property.Value
}

$systemTempRoot = [System.IO.Path]::GetFullPath(
    [System.IO.Path]::GetTempPath())
$tempPrefix = $systemTempRoot
if (-not ($tempPrefix.EndsWith(
            [System.IO.Path]::DirectorySeparatorChar.ToString()) -or
        $tempPrefix.EndsWith(
            [System.IO.Path]::AltDirectorySeparatorChar.ToString()))) {
    $tempPrefix += [System.IO.Path]::DirectorySeparatorChar
}

$workLeaf = "revagent-bridge-service-" + [Guid]::NewGuid().ToString("N")
$workDirectory = [System.IO.Path]::GetFullPath(
    (Join-Path $systemTempRoot $workLeaf))
if (-not $workDirectory.StartsWith(
        $tempPrefix,
        [StringComparison]::OrdinalIgnoreCase) -or
    -not [string]::Equals(
        [System.IO.Path]::GetFileName($workDirectory),
        $workLeaf,
        [StringComparison]::Ordinal) -or
    $workLeaf -notmatch '^revagent-bridge-service-[0-9a-f]{32}$') {
    throw "Refusing to create a Bridge service work directory outside the bounded temp root."
}

[System.IO.Directory]::CreateDirectory($workDirectory) | Out-Null
$hostPublishDirectory = Join-Path $workDirectory (
    "host-" + [Guid]::NewGuid().ToString("N"))
$workerPublishDirectory = Join-Path $workDirectory (
    "worker-" + [Guid]::NewGuid().ToString("N"))
[System.IO.Directory]::CreateDirectory($hostPublishDirectory) | Out-Null
[System.IO.Directory]::CreateDirectory($workerPublishDirectory) | Out-Null

$gatewayListener = $null
$addinListener = $null

try {
    Push-Location $RepoRoot
    try {
        Invoke-CheckedCommand "Locked Bridge restore" {
            dotnet restore $solutionPath --locked-mode
        }
        Invoke-CheckedCommand "Locked Bridge Host win-x64 restore" {
            dotnet restore $hostProjectPath `
                --locked-mode `
                --no-dependencies `
                --force `
                -r win-x64 `
                -p:RuntimeFrameworkVersion=8.0.29
        }
        Invoke-CheckedCommand "Locked Bridge Worker win-x64 restore" {
            dotnet restore $workerProjectPath `
                --locked-mode `
                --no-dependencies `
                --force `
                -r win-x64 `
                -p:RuntimeFrameworkVersion=8.0.29
        }
        Invoke-CheckedCommand "Bridge Release build" {
            dotnet build $solutionPath -c Release --no-restore
        }
        Invoke-CheckedCommand "Bridge Release tests" {
            dotnet test $solutionPath -c Release --no-build --no-restore
        }
        Invoke-CheckedCommand "Bridge formatting verification" {
            dotnet format $solutionPath `
                --verify-no-changes `
                --no-restore `
                --verbosity minimal
        }
        Invoke-CheckedCommand "Bridge Host win-x64 single-file publish" {
            dotnet publish $hostProjectPath `
                -c Release `
                -r win-x64 `
                --self-contained true `
                --no-restore `
                -o $hostPublishDirectory `
                -p:PublishSingleFile=true `
                -p:IncludeNativeLibrariesForSelfExtract=true `
                -p:IncludeAllContentForSelfExtract=false `
                -p:PublishTrimmed=false `
                -p:PublishReadyToRun=false `
                -p:DebugType=embedded `
                -p:DebugSymbols=false
        }
        Invoke-CheckedCommand "Bridge Worker win-x64 single-file publish" {
            dotnet publish $workerProjectPath `
                -c Release `
                -r win-x64 `
                --self-contained true `
                --no-restore `
                -o $workerPublishDirectory `
                -p:PublishSingleFile=true `
                -p:IncludeNativeLibrariesForSelfExtract=true `
                -p:IncludeAllContentForSelfExtract=false `
                -p:PublishTrimmed=false `
                -p:PublishReadyToRun=false `
                -p:DebugType=embedded `
                -p:DebugSymbols=false
        }
    }
    finally {
        Pop-Location
    }

    $hostExecutablePath = Assert-SingleFilePublish `
        -PublishDirectory $hostPublishDirectory `
        -ExpectedExecutableName $hostExecutableName
    $workerExecutablePath = Assert-SingleFilePublish `
        -PublishDirectory $workerPublishDirectory `
        -ExpectedExecutableName $workerExecutableName

    Assert-VersionSmoke `
        -ExecutablePath $hostExecutablePath `
        -TimeoutSeconds $SmokeTimeoutSeconds
    Assert-VersionSmoke `
        -ExecutablePath $workerExecutablePath `
        -TimeoutSeconds $SmokeTimeoutSeconds

    $gatewayListener = [System.Net.Sockets.TcpListener]::new(
        [System.Net.IPAddress]::Loopback,
        0)
    $gatewayListener.Start()
    $gatewayPort = (
        [System.Net.IPEndPoint]$gatewayListener.LocalEndpoint
    ).Port

    $addinListener = [System.Net.Sockets.TcpListener]::new(
        [System.Net.IPAddress]::Loopback,
        0)
    $addinListener.Start()
    $addinPort = (
        [System.Net.IPEndPoint]$addinListener.LocalEndpoint
    ).Port

    $configurationPath = Join-Path $workDirectory "bridge-config.json"
    $configuration = [ordered]@{
        schemaVersion = 1
        gateway = [ordered]@{
            uri = "wss://localhost:$gatewayPort/bridge/v1"
        }
        addin = [ordered]@{
            scanStartPort = 8080
            scanEndPort = 8085
        }
        logging = [ordered]@{
            maxFileBytes = 65536
            retainedFileCount = 3
        }
    }
    $configurationJson = $configuration | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText(
        $configurationPath,
        $configurationJson,
        [System.Text.UTF8Encoding]::new($false))

    $doctorResult = Invoke-BoundedHiddenProcess `
        -FilePath $workerExecutablePath `
        -Arguments @("__doctor", "--config", $configurationPath) `
        -WorkingDirectory $workerPublishDirectory `
        -TimeoutSeconds $SmokeTimeoutSeconds `
        -ClearEnvironmentPrefix "REVAGENT_BRIDGE_" `
        -EnvironmentOverrides @{
            REVAGENT_BRIDGE_ADDIN_PORT = [string]$addinPort
        }

    if ($doctorResult.TimedOut) {
        throw "Bridge worker doctor exceeded the bounded smoke timeout."
    }
    if ($doctorResult.ExitCode -ne 0) {
        throw (
            "Bridge worker doctor failed with exit code " +
            "$($doctorResult.ExitCode): $($doctorResult.StandardError)"
        )
    }
    if (-not [string]::IsNullOrWhiteSpace($doctorResult.StandardError)) {
        throw (
            "Bridge worker doctor wrote unexpected stderr: " +
            $doctorResult.StandardError.Trim()
        )
    }

    $doctorOutput = $doctorResult.StandardOutput.Trim()
    if ([string]::IsNullOrWhiteSpace($doctorOutput)) {
        throw "Bridge worker doctor returned no JSON output."
    }
    try {
        $doctor = $doctorOutput | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw "Bridge worker doctor did not return exactly one valid JSON object: $($_.Exception.Message)"
    }
    if ($doctor -is [System.Array]) {
        throw "Bridge worker doctor returned an array instead of one JSON object."
    }

    $doctorSchemaVersion = Get-RequiredJsonProperty `
        -InputObject $doctor `
        -Name "schemaVersion" `
        -ObjectPath '$'
    $doctorSuccess = Get-RequiredJsonProperty `
        -InputObject $doctor `
        -Name "success" `
        -ObjectPath '$'
    $gatewayHealth = Get-RequiredJsonProperty `
        -InputObject $doctor `
        -Name "gateway" `
        -ObjectPath '$'
    $addinHealth = Get-RequiredJsonProperty `
        -InputObject $doctor `
        -Name "addin" `
        -ObjectPath '$'
    $rbpAuthenticated = Get-RequiredJsonProperty `
        -InputObject $gatewayHealth `
        -Name "rbpAuthenticated" `
        -ObjectPath '$.gateway'
    $addinShapeVerified = Get-RequiredJsonProperty `
        -InputObject $addinHealth `
        -Name "shapeVerified" `
        -ObjectPath '$.addin'
    $addinScanStartPort = Get-RequiredJsonProperty `
        -InputObject $addinHealth `
        -Name "scanStartPort" `
        -ObjectPath '$.addin'
    $addinScanEndPort = Get-RequiredJsonProperty `
        -InputObject $addinHealth `
        -Name "scanEndPort" `
        -ObjectPath '$.addin'
    $addinReachablePorts = @(
        Get-RequiredJsonProperty `
            -InputObject $addinHealth `
            -Name "reachablePorts" `
            -ObjectPath '$.addin'
    )
    $addinProbes = @(
        Get-RequiredJsonProperty `
            -InputObject $addinHealth `
            -Name "probes" `
            -ObjectPath '$.addin'
    )

    if (-not [string]::Equals(
            [string]$doctorSchemaVersion,
            "revagent-bridge-doctor/v1",
            [StringComparison]::Ordinal)) {
        throw "Bridge worker doctor returned an unexpected schemaVersion."
    }
    if ($doctorSuccess -isnot [bool] -or -not $doctorSuccess) {
        throw "Bridge worker doctor must report success=true for a valid configuration."
    }
    if ($rbpAuthenticated -isnot [bool] -or $rbpAuthenticated) {
        throw "A bare TCP listener must not be reported as an authenticated RBP endpoint."
    }
    if ($addinShapeVerified -isnot [bool] -or $addinShapeVerified) {
        throw "A bare TCP listener must not be reported as a shape-verified add-in endpoint."
    }
    if ([int]$addinScanStartPort -ne $addinPort -or
        [int]$addinScanEndPort -ne $addinPort) {
        throw "Bridge worker doctor did not honor the explicit add-in port override."
    }
    if ($addinReachablePorts.Count -ne 1 -or
        [int]$addinReachablePorts[0] -ne $addinPort) {
        throw "Bridge worker doctor did not report only the explicit reachable add-in port."
    }
    if ($addinProbes.Count -ne 1) {
        throw "Bridge worker doctor did not perform exactly one explicit add-in port probe."
    }
    $addinProbePort = Get-RequiredJsonProperty `
        -InputObject $addinProbes[0] `
        -Name "port" `
        -ObjectPath '$.addin.probes[0]'
    $addinProbeReachable = Get-RequiredJsonProperty `
        -InputObject $addinProbes[0] `
        -Name "tcpReachable" `
        -ObjectPath '$.addin.probes[0]'
    if ([int]$addinProbePort -ne $addinPort -or
        $addinProbeReachable -isnot [bool] -or
        -not $addinProbeReachable) {
        throw "Bridge worker doctor did not reach the explicit add-in listener."
    }
}
finally {
    if ($null -ne $addinListener) {
        $addinListener.Stop()
    }
    if ($null -ne $gatewayListener) {
        $gatewayListener.Stop()
    }

    $resolvedWorkDirectory = [System.IO.Path]::GetFullPath($workDirectory)
    if (-not $resolvedWorkDirectory.StartsWith(
            $tempPrefix,
            [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals(
            [System.IO.Path]::GetFileName($resolvedWorkDirectory),
            $workLeaf,
            [StringComparison]::Ordinal)) {
        throw "Refusing to remove a Bridge service work directory outside the bounded temp root."
    }
    if (Test-Path -LiteralPath $resolvedWorkDirectory) {
        $workItem = Get-Item -LiteralPath $resolvedWorkDirectory -Force
        if (($workItem.Attributes -band
                [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to recursively remove a reparse-point Bridge service work directory."
        }
        Remove-Item -LiteralPath $resolvedWorkDirectory -Recurse -Force
    }
}

Write-Host "Bridge P3-T2 non-admin service gate passed." -ForegroundColor Green
