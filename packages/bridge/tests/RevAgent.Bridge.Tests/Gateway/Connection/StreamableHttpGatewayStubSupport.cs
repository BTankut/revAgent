using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

/// <summary>
/// Starts the unchanged Node gateway stub with the
/// <c>transport_streamable_http</c> connection capability provisioned and
/// exposes its <c>/bridge/v1/http/connections</c> surface. The frozen
/// <see cref="GatewayStubProcess"/> helper deliberately starts a WSS-only
/// stub, so the HTTP-binding tests own this dedicated launcher instead of
/// modifying it.
/// </summary>
internal sealed class StreamableHttpGatewayStubProcess : IAsyncDisposable
{
    private readonly Process _process;
    private readonly string _workDirectory;
    private readonly X509Certificate2 _certificate;
    private bool _disposed;

    private StreamableHttpGatewayStubProcess(
        Process process,
        string workDirectory,
        X509Certificate2 certificate,
        Uri webSocketUri,
        Uri httpConnectionUri)
    {
        _process = process;
        _workDirectory = workDirectory;
        _certificate = certificate;
        WebSocketUri = webSocketUri;
        HttpConnectionUri = httpConnectionUri;
    }

    internal Uri WebSocketUri { get; }

    internal Uri HttpConnectionUri { get; }

    internal static async Task<StreamableHttpGatewayStubProcess>
        StartAsync()
    {
        string repositoryRoot = FindRepositoryRoot();
        await EnsureStubBuiltAsync(repositoryRoot).ConfigureAwait(false);
        string workDirectory = Path.Combine(
            Path.GetTempPath(),
            "revagent-bridge-gateway-stub-" +
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDirectory);
        string certificatePath =
            Path.Combine(workDirectory, "loopback-cert.pem");
        string keyPath = Path.Combine(workDirectory, "loopback-key.pem");
        string statePath = Path.Combine(workDirectory, "state.json");
        X509Certificate2 certificate =
            CreateLoopbackCertificate(certificatePath, keyPath);

        var startInfo = new ProcessStartInfo
        {
            FileName = OperatingSystem.IsWindows() ? "node.exe" : "node",
            WorkingDirectory = repositoryRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add(
            Path.Combine(
                repositoryRoot,
                "packages",
                "gateway-stub",
                "dist",
                "cli.js"));
        AddArgument(startInfo, "--state", statePath);
        AddArgument(startInfo, "--host", "127.0.0.1");
        AddArgument(startInfo, "--port", "0");
        AddArgument(startInfo, "--tls-cert", certificatePath);
        AddArgument(startInfo, "--tls-key", keyPath);
        AddArgument(startInfo, "--supported-protocols", "1");
        AddArgument(
            startInfo,
            "--connection-capabilities",
            "transport_streamable_http");
        AddArgument(startInfo, "--session-capabilities", string.Empty);

        var process = new Process { StartInfo = startInfo };
        try
        {
            if (!process.Start())
            {
                throw new InvalidOperationException(
                    "The Gateway stub process did not start.");
            }

            using var timeout = new CancellationTokenSource(
                TimeSpan.FromSeconds(20));
            string? line = await process.StandardOutput
                .ReadLineAsync(timeout.Token)
                .ConfigureAwait(false);
            if (line is null)
            {
                string error = await process.StandardError
                    .ReadToEndAsync(timeout.Token)
                    .ConfigureAwait(false);
                throw new InvalidOperationException(
                    "The Gateway stub returned no readiness record: " +
                    error);
            }

            using JsonDocument readiness = JsonDocument.Parse(line);
            JsonElement root = readiness.RootElement;
            if (!string.Equals(
                    root.GetProperty("event").GetString(),
                    "ready",
                    StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    "The Gateway stub returned an invalid readiness record.");
            }

            var rawWebSocketUri = new Uri(
                root.GetProperty("ws_url").GetString() ??
                throw new InvalidOperationException(
                    "Gateway readiness omitted ws_url."));
            var webSocketUri = new UriBuilder(rawWebSocketUri)
            {
                Host = "localhost",
            }.Uri;
            var rawHttpConnectionUri = new Uri(
                root.GetProperty("http_connection_url").GetString() ??
                throw new InvalidOperationException(
                    "Gateway readiness omitted http_connection_url."));
            var httpConnectionUri = new UriBuilder(rawHttpConnectionUri)
            {
                Host = "localhost",
            }.Uri;
            return new StreamableHttpGatewayStubProcess(
                process,
                workDirectory,
                certificate,
                webSocketUri,
                httpConnectionUri);
        }
        catch
        {
            StopProcess(process);
            process.Dispose();
            certificate.Dispose();
            DeleteWorkDirectory(workDirectory);
            throw;
        }
    }

    internal bool TrustsExactCertificate(
        X509Certificate? certificate)
    {
        if (certificate is null)
        {
            return false;
        }

        byte[] expected = _certificate.GetCertHash(HashAlgorithmName.SHA256);
        byte[] actual = certificate.GetCertHash(HashAlgorithmName.SHA256);
        return CryptographicOperations.FixedTimeEquals(expected, actual);
    }

    public ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return ValueTask.CompletedTask;
        }

        _disposed = true;
        StopProcess(_process);
        _process.Dispose();
        _certificate.Dispose();
        DeleteWorkDirectory(_workDirectory);
        return ValueTask.CompletedTask;
    }

    /// <summary>
    /// Builds the stub through the frozen
    /// <see cref="GatewayStubProcess"/> single-flight build authority. The
    /// stub's npm build is not concurrency-safe, so a second private build
    /// gate in this class would let two test classes rebuild
    /// <c>dist</c> simultaneously; sharing the one gate (via reflection,
    /// because the member is deliberately private on the frozen helper)
    /// serializes every stub build in the test process.
    /// </summary>
    private static Task EnsureStubBuiltAsync(string repositoryRoot)
    {
        MethodInfo ensure =
            typeof(GatewayStubProcess).GetMethod(
                "EnsureStubBuiltAsync",
                BindingFlags.NonPublic | BindingFlags.Static) ??
            throw new InvalidOperationException(
                "GatewayStubProcess.EnsureStubBuiltAsync was not found.");
        return (Task)(ensure.Invoke(null, new object[] { repositoryRoot }) ??
            throw new InvalidOperationException(
                "The shared Gateway stub build returned no task."));
    }

    private static X509Certificate2 CreateLoopbackCertificate(
        string certificatePath,
        string keyPath)
    {
        using RSA key = RSA.Create(2048);
        var request = new CertificateRequest(
            "CN=127.0.0.1",
            key,
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1);
        var names = new SubjectAlternativeNameBuilder();
        names.AddDnsName("localhost");
        names.AddIpAddress(IPAddress.Loopback);
        request.CertificateExtensions.Add(names.Build());
        request.CertificateExtensions.Add(
            new X509BasicConstraintsExtension(
                certificateAuthority: false,
                hasPathLengthConstraint: false,
                pathLengthConstraint: 0,
                critical: true));
        request.CertificateExtensions.Add(
            new X509KeyUsageExtension(
                X509KeyUsageFlags.DigitalSignature,
                critical: true));
        request.CertificateExtensions.Add(
            new X509EnhancedKeyUsageExtension(
                new OidCollection
                {
                    new("1.3.6.1.5.5.7.3.1"),
                },
                critical: false));
        using X509Certificate2 generated = request.CreateSelfSigned(
            DateTimeOffset.UtcNow.AddMinutes(-5),
            DateTimeOffset.UtcNow.AddDays(1));
        File.WriteAllText(
            certificatePath,
            generated.ExportCertificatePem());
        File.WriteAllText(keyPath, key.ExportPkcs8PrivateKeyPem());
        return new X509Certificate2(generated.Export(
            X509ContentType.Cert));
    }

    private static void AddArgument(
        ProcessStartInfo startInfo,
        string name,
        string value)
    {
        startInfo.ArgumentList.Add(name);
        startInfo.ArgumentList.Add(value);
    }

    private static string FindRepositoryRoot()
    {
        foreach (string start in new[]
                 {
                     Directory.GetCurrentDirectory(),
                     AppContext.BaseDirectory,
                 })
        {
            var directory = new DirectoryInfo(start);
            while (directory is not null)
            {
                if (File.Exists(
                        Path.Combine(
                            directory.FullName,
                            "packages",
                            "gateway-stub",
                            "package.json")) &&
                    File.Exists(
                        Path.Combine(
                            directory.FullName,
                            "packages",
                            "bridge",
                            "RevAgent.Bridge.sln")))
                {
                    return directory.FullName;
                }

                directory = directory.Parent;
            }
        }

        throw new InvalidOperationException(
            "The repository root could not be located for the Gateway stub.");
    }

    private static void StopProcess(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5_000);
            }
        }
        catch (InvalidOperationException)
        {
        }
    }

    private static void DeleteWorkDirectory(string workDirectory)
    {
        string fullPath = Path.GetFullPath(workDirectory);
        string tempPath = Path.GetFullPath(Path.GetTempPath());
        if (!tempPath.EndsWith(
                Path.DirectorySeparatorChar.ToString(),
                StringComparison.Ordinal))
        {
            tempPath += Path.DirectorySeparatorChar;
        }

        if (!fullPath.StartsWith(
                tempPath,
                StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(fullPath).StartsWith(
                "revagent-bridge-gateway-stub-",
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Refusing to remove an unbounded Gateway stub directory.");
        }

        if (Directory.Exists(fullPath))
        {
            Directory.Delete(fullPath, recursive: true);
        }
    }
}
