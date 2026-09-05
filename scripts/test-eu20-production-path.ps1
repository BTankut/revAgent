#requires -Version 7.0
<#
.SYNOPSIS
  Isolated actual-image/Postgres/C# proof. Never installs a service or touches
  canonical Bridge state. Docker ports are never published.
.DESCRIPTION
  -Mode genuine requires an existing elevated Windows test process. It
  proves genuine random identity -> real M5 mint/exchange -> protected DPAPI
  credential -> WSS read -> restart from that credential -> HTTP/SSE read.
  It does not elevate itself, install a service, or count skipped proof as PASS.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent),
    [Parameter(Mandatory)][string]$EvidenceRoot,
    [Parameter(Mandatory)][string]$NodePath,
    [ValidateSet('transport','genuine')][string]$Mode = 'genuine',
    [switch]$AllowDirtyCandidate
)
$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$EvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
if ($Mode -eq 'genuine' -and (-not $IsWindows -or -not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))) {
    throw 'genuine_first_install_unproven: run from an existing elevated disposable Windows test process; no elevation or service installation is performed by this script'
}
if ((& $NodePath --version) -ne 'v24.14.1') { throw 'Node 24.14.1 is required for this exact proof' }
if (Test-Path -LiteralPath $EvidenceRoot) { throw 'Use a new evidence directory; existing evidence is never overwritten' }
$names = @('revagent-eu20-b1-pg','revagent-eu20-b1-issuer','revagent-eu20-b1-gateway')
$existing = @(docker ps -a --format '{{.Names}}')
if ($LASTEXITCODE -ne 0) { throw 'Docker is unavailable' }
foreach ($name in $names) { if ($existing -contains $name) { throw "Isolated test resource already exists: $name" } }
if (@(docker network ls --format '{{.Name}}') -contains 'revagent-eu20-b1-private') { throw 'Isolated test network already exists' }
$status = @(git -C $RepoRoot status --porcelain)
if ($status.Count -gt 0 -and -not $AllowDirtyCandidate) { throw 'Commit the exact candidate before collecting final proof' }
New-Item -ItemType Directory -Path $EvidenceRoot | Out-Null
$candidate = [ordered]@{
    head = (git -C $RepoRoot rev-parse HEAD)
    tree = (git -C $RepoRoot rev-parse 'HEAD^{tree}')
    dirty = ($status.Count -gt 0)
    mode = $Mode
    nodeVersion = (& $NodePath --version)
    protectedFirstInstall = 'pending'
}
$candidate | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'candidate.json')
function Invoke-ProofCommand([string]$Name, [scriptblock]$Action) {
    & $Action 2>&1 | Tee-Object -FilePath (Join-Path $EvidenceRoot "$Name.log")
    if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE); proof remains incomplete" }
}
$created = [Collections.Generic.List[string]]::new()
$networkCreated = $false
Push-Location $RepoRoot
try {
    $rsa = [Security.Cryptography.RSA]::Create(2048)
    try {
        $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=revagent-eu20-private-proof', $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
        @('localhost','revagent-eu20-b1-gateway','revagent-eu20-b1-issuer') | ForEach-Object { $san.AddDnsName($_) }
        $san.AddIpAddress([Net.IPAddress]::Loopback)
        $request.CertificateExtensions.Add($san.Build())
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
        $cert = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddDays(2))
        try {
            [IO.File]::WriteAllText((Join-Path $EvidenceRoot 'test-cert.pem'),$cert.ExportCertificatePem())
            [IO.File]::WriteAllText((Join-Path $EvidenceRoot 'test-key.pem'),$rsa.ExportPkcs8PrivateKeyPem())
        } finally { $cert.Dispose() }
    } finally { $rsa.Dispose() }
    $adminPassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $runtimePassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $pepper = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $gatewayEnv = @(
        "DATABASE_URL=postgres://revagent_runtime:${runtimePassword}@revagent-eu20-b1-pg:5432/eu20",
        "M5_TOKEN_PEPPER=$pepper", 'NODE_ENV=production', 'NODE_EXTRA_CA_CERTS=/proof/test-cert.pem',
        'GATEWAY_BIND_HOST=0.0.0.0', 'PORT=8080', 'GATEWAY_PUBLIC_URL=https://revagent-eu20-b1-gateway:8080',
        'OBJECT_STORE_ROOT=/tmp/revagent-eu20-b1', 'OIDC_ISSUER_URL=https://revagent-eu20-b1-issuer:8443',
        'OIDC_CLIENT_ID=eu20-test-client', 'OIDC_JWKS_URI=https://revagent-eu20-b1-issuer:8443/jwks',
        'GATEWAY_TLS_CERT_FILE=/proof/test-cert.pem', 'GATEWAY_TLS_KEY_FILE=/proof/test-key.pem'
    )
    [IO.File]::WriteAllLines((Join-Path $EvidenceRoot 'gateway.env'),$gatewayEnv)
    [IO.File]::WriteAllLines((Join-Path $EvidenceRoot 'test.env'),$gatewayEnv + @("DATABASE_MIGRATION_URL=postgres://postgres:${adminPassword}@revagent-eu20-b1-pg:5432/eu20", "REVAGENT_APP_DATABASE_PASSWORD=$runtimePassword"))
    [IO.File]::WriteAllLines((Join-Path $EvidenceRoot 'postgres.env'),@("POSTGRES_PASSWORD=$adminPassword", 'POSTGRES_DB=eu20'))
    Invoke-ProofCommand 'gateway-image-build' { docker build -t revagent-eu20-b1-gateway:local -f packages/gateway/Dockerfile . }
    Invoke-ProofCommand 'addin-fixture-build' { & $NodePath node_modules/typescript/lib/tsc.js -p packages/addin-loopback-fixture/tsconfig.json }
    Invoke-ProofCommand 'csharp-fixture-build' { dotnet build packages/bridge/tests/RevAgent.Bridge.RealWorkerHost/RevAgent.Bridge.RealWorkerHost.csproj --nologo --verbosity minimal }
    $candidate.imageId = (docker image inspect revagent-eu20-b1-gateway:local --format '{{.Id}}')
    $cmd = (docker image inspect revagent-eu20-b1-gateway:local --format '{{json .Config.Cmd}}') | ConvertFrom-Json
    if (($cmd -join ' ') -ne 'node packages/gateway/dist/main.js') { throw 'Actual image CMD differs from production main' }
    docker network create --internal --label revagent.test=eu20-b1 revagent-eu20-b1-private | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Private network creation failed' }
    $networkCreated = $true
    docker run -d --name $names[0] --network revagent-eu20-b1-private --label revagent.test=eu20-b1 --env-file (Join-Path $EvidenceRoot 'postgres.env') postgres:16 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Private Postgres start failed' }
    $created.Add($names[0])
    $ready = $false
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        docker exec $names[0] pg_isready -U postgres 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $ready=$true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Private Postgres readiness timed out' }
    Invoke-ProofCommand 'image-migrations' { docker run --rm --network revagent-eu20-b1-private --env-file (Join-Path $EvidenceRoot 'test.env') revagent-eu20-b1-gateway:local node packages/gateway/dist/migrate.js }
    Invoke-ProofCommand 'image-migrations-rerun' { docker run --rm --network revagent-eu20-b1-private --env-file (Join-Path $EvidenceRoot 'test.env') revagent-eu20-b1-gateway:local node packages/gateway/dist/migrate.js }
    $scriptsMount = (Join-Path $RepoRoot 'packages/gateway/scripts') + ':/app/packages/gateway/scripts:ro'
    docker run -d --name $names[1] --network revagent-eu20-b1-private --label revagent.test=eu20-b1 -v "${EvidenceRoot}:/proof:ro" -v $scriptsMount revagent-eu20-b1-gateway:local node packages/gateway/scripts/eu20-test-issuer.mjs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Private issuer start failed' }
    $created.Add($names[1])
    docker run -d --name $names[2] --network revagent-eu20-b1-private --label revagent.test=eu20-b1 --env-file (Join-Path $EvidenceRoot 'gateway.env') -v "${EvidenceRoot}:/proof:ro" revagent-eu20-b1-gateway:local | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Actual image startup failed' }
    $created.Add($names[2])
    $ready=$false
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        docker exec $names[2] node --input-type=module -e "const r=await fetch('https://localhost:8080/healthz');if(r.status!==200)process.exit(1)" 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $ready=$true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Actual production image readiness timed out' }
    if ($Mode -eq 'transport') {
        Invoke-ProofCommand 'image-oidc-m5' { docker run --rm --network revagent-eu20-b1-private --env-file (Join-Path $EvidenceRoot 'test.env') -v "${EvidenceRoot}:/proof" -v $scriptsMount revagent-eu20-b1-gateway:local node packages/gateway/scripts/eu20-image-auth-proof.mjs }
    }
    Invoke-ProofCommand 'csharp-wss' { & $NodePath packages/gateway/scripts/eu20-csharp-transport-proof.mjs $RepoRoot $EvidenceRoot wss $Mode }
    $secondMode = if ($Mode -eq 'genuine') { 'genuine-restart' } else { 'transport' }
    Invoke-ProofCommand 'csharp-http-sse' { & $NodePath packages/gateway/scripts/eu20-csharp-transport-proof.mjs $RepoRoot $EvidenceRoot streamable_http_sse $secondMode }
    $candidate.protectedFirstInstall = if ($Mode -eq 'genuine') { 'passed' } else { 'not_exercised' }
    $candidate.actualImageAndCSharpRead = 'passed'
} finally {
    $cleanupNames = $created.ToArray()
    [array]::Reverse($cleanupNames)
    foreach ($name in $cleanupNames) {
        docker logs $name 2>&1 | Set-Content -LiteralPath (Join-Path $EvidenceRoot "$name.log")
        docker stop --time 20 $name | Out-Null
        docker rm -v $name | Out-Null
    }
    if ($networkCreated) { docker network rm revagent-eu20-b1-private | Out-Null }
    $candidate | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'candidate.json')
    Pop-Location
}
