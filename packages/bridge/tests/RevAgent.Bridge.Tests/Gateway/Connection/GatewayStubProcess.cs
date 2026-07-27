using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

internal sealed class GatewayStubProcess : IAsyncDisposable
{
    private static readonly SemaphoreSlim BuildGate = new(1, 1);
    private static string? _builtRepositoryRoot;

    private readonly Process _process;
    private readonly string _workDirectory;
    private readonly X509Certificate2 _certificate;
    private bool _disposed;

    private GatewayStubProcess(
        Process process,
        string workDirectory,
        X509Certificate2 certificate,
        Uri webSocketUri,
        Uri controlUri)
    {
        _process = process;
        _workDirectory = workDirectory;
        _certificate = certificate;
        WebSocketUri = webSocketUri;
        ControlUri = controlUri;
    }

    internal Uri WebSocketUri { get; }

    internal Uri ControlUri { get; }

    internal string CertificateThumbprint => _certificate.Thumbprint;

    internal static async Task<GatewayStubProcess> StartAsync()
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
        AddArgument(startInfo, "--connection-capabilities", string.Empty);
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
            var controlUri = new Uri(
                root.GetProperty("control_url").GetString() ??
                throw new InvalidOperationException(
                    "Gateway readiness omitted control_url."));
            return new GatewayStubProcess(
                process,
                workDirectory,
                certificate,
                webSocketUri,
                controlUri);
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

    internal async Task EnqueueOpeningFaultAsync(
        int status,
        string? retryAfter = null)
    {
        using var handler = new HttpClientHandler
        {
            UseProxy = false,
            ServerCertificateCustomValidationCallback =
                (_, certificate, _, _) =>
                    TrustsExactCertificate(certificate),
        };
        using var client = new HttpClient(handler);
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            ControlUri);
        request.Headers.Add("X-RBP-Test-Control", "rbp-test-control");
        object openingRule = retryAfter is null
            ? new
            {
                binding = "wss",
                status,
                remaining = 1,
            }
            : new
            {
                binding = "wss",
                status,
                retryAfter,
                remaining = 1,
            };
        request.Content = JsonContent.Create(
            new
            {
                action = "enqueue_opening_fault",
                rule = openingRule,
            });
        using HttpResponseMessage response =
            await client.SendAsync(request).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
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

    private static async Task EnsureStubBuiltAsync(string repositoryRoot)
    {
        await BuildGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (string.Equals(
                    _builtRepositoryRoot,
                    repositoryRoot,
                    StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            string npm = ResolveNpmCommand();
            var startInfo = new ProcessStartInfo
            {
                FileName = npm,
                WorkingDirectory = repositoryRoot,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            startInfo.ArgumentList.Add("run");
            startInfo.ArgumentList.Add("build");
            startInfo.ArgumentList.Add("--workspace");
            startInfo.ArgumentList.Add("@revagent/gateway-stub");
            using var process = new Process { StartInfo = startInfo };
            if (!process.Start())
            {
                throw new InvalidOperationException(
                    "The Gateway stub build did not start.");
            }

            Task<string> output = process.StandardOutput.ReadToEndAsync();
            Task<string> error = process.StandardError.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(
                TimeSpan.FromSeconds(120));
            try
            {
                await process.WaitForExitAsync(timeout.Token)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
                when (timeout.IsCancellationRequested)
            {
                StopProcess(process);
                throw new TimeoutException(
                    "The unchanged Gateway stub build exceeded 120 seconds.");
            }

            string standardOutput = await output.ConfigureAwait(false);
            string standardError = await error.ConfigureAwait(false);
            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException(
                    "The unchanged Gateway stub failed to build: " +
                    standardOutput +
                    standardError);
            }

            _builtRepositoryRoot = repositoryRoot;
        }
        finally
        {
            BuildGate.Release();
        }
    }

    private static string ResolveNpmCommand()
    {
        string command = OperatingSystem.IsWindows() ? "npm.cmd" : "npm";
        string? path = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrWhiteSpace(path))
        {
            return command;
        }

        foreach (string entry in path.Split(Path.PathSeparator))
        {
            string directory = entry.Trim().Trim('"');
            if (directory.Length == 0)
            {
                continue;
            }

            string candidate = Path.Combine(directory, command);
            if (File.Exists(candidate))
            {
                return Path.GetFullPath(candidate);
            }
        }

        return command;
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
