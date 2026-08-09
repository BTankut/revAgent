using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

/// <summary>
/// Coordinates the generated Gateway stub surface across testhost processes
/// that share one repository checkout.
/// </summary>
internal static class GatewayStubBuildCoordinator
{
    private const string FingerprintVersion = "gateway-stub-build-v1";

    private static readonly TimeSpan AcquireTimeout = TimeSpan.FromMinutes(3);
    private static readonly TimeSpan RetryDelay = TimeSpan.FromMilliseconds(100);

    private static readonly string[] InputDirectories =
    {
        Path.Combine("packages", "protocol", "src"),
        Path.Combine("packages", "protocol", "schemas"),
        Path.Combine("packages", "protocol", "scripts"),
        Path.Combine("packages", "gateway-stub", "src"),
    };

    private static readonly string[] InputFiles =
    {
        "package.json",
        "package-lock.json",
        "tsconfig.base.json",
        Path.Combine("packages", "protocol", "package.json"),
        Path.Combine("packages", "protocol", "tsconfig.json"),
        Path.Combine("packages", "gateway-stub", "package.json"),
        Path.Combine("packages", "gateway-stub", "tsconfig.json"),
    };

    private static readonly string[] RequiredOutputs =
    {
        Path.Combine("packages", "gateway-stub", "dist", "cli.js"),
        Path.Combine("packages", "gateway-stub", "dist", "server.js"),
        Path.Combine("packages", "gateway-stub", "dist", "core.js"),
        Path.Combine("packages", "protocol", "dist", "src", "index.js"),
        Path.Combine(
            "packages",
            "protocol",
            "dist",
            "src",
            "parseFrame.js"),
        Path.Combine(
            "packages",
            "protocol",
            "dist",
            "src",
            "validateEnvelope.js"),
        Path.Combine(
            "packages",
            "protocol",
            "dist",
            "schemas",
            "rbp",
            "v1",
            "common.schema.json"),
        Path.Combine(
            "packages",
            "protocol",
            "dist",
            "schemas",
            "rbp",
            "v1",
            "envelope.schema.json"),
        Path.Combine(
            "packages",
            "protocol",
            "dist",
            "schemas",
            "rbp",
            "v1",
            "payloads.schema.json"),
    };

    internal static async Task EnsureBuiltAsync(
        string repositoryRoot,
        Func<Task> buildAsync)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(repositoryRoot);
        ArgumentNullException.ThrowIfNull(buildAsync);

        string normalizedRoot = NormalizeRepositoryRoot(repositoryRoot);
        string checkoutIdentity = OperatingSystem.IsWindows()
            ? normalizedRoot.ToUpperInvariant()
            : normalizedRoot;
        string checkoutKey = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(checkoutIdentity)))
            .ToLowerInvariant();
        string coordinationRoot = Path.Combine(
            Path.GetTempPath(),
            "revagent-gateway-stub-build");
        Directory.CreateDirectory(coordinationRoot);
        string lockPath = Path.Combine(
            coordinationRoot,
            checkoutKey + ".lock");
        string stampPath = Path.Combine(
            coordinationRoot,
            checkoutKey + ".stamp");

        await using FileStream lease = await AcquireAsync(lockPath)
            .ConfigureAwait(false);
        string inputFingerprint = ComputeInputFingerprint(normalizedRoot);
        if (BuildIsCurrent(normalizedRoot, stampPath, inputFingerprint))
        {
            return;
        }

        DeleteStamp(stampPath);
        await buildAsync().ConfigureAwait(false);

        string postBuildFingerprint = ComputeInputFingerprint(normalizedRoot);
        if (!string.Equals(
                inputFingerprint,
                postBuildFingerprint,
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Gateway stub build inputs changed while the coordinated " +
                "build was running.");
        }

        AssertRequiredOutputs(normalizedRoot);
        await WriteStampAsync(stampPath, inputFingerprint)
            .ConfigureAwait(false);
    }

    private static async Task<FileStream> AcquireAsync(string lockPath)
    {
        var stopwatch = Stopwatch.StartNew();
        IOException? lastFailure = null;
        while (stopwatch.Elapsed < AcquireTimeout)
        {
            try
            {
                return new FileStream(
                    lockPath,
                    FileMode.OpenOrCreate,
                    FileAccess.ReadWrite,
                    FileShare.None,
                    bufferSize: 1,
                    FileOptions.Asynchronous);
            }
            catch (IOException exception)
            {
                lastFailure = exception;
                await Task.Delay(RetryDelay).ConfigureAwait(false);
            }
        }

        throw new TimeoutException(
            "Timed out acquiring the checkout-scoped Gateway stub build lease.",
            lastFailure);
    }

    private static string NormalizeRepositoryRoot(string repositoryRoot)
    {
        return Path.TrimEndingDirectorySeparator(
            Path.GetFullPath(repositoryRoot));
    }

    private static string ComputeInputFingerprint(string repositoryRoot)
    {
        var relativePaths = new List<string>(InputFiles);
        foreach (string directory in InputDirectories)
        {
            string fullDirectory = Path.Combine(repositoryRoot, directory);
            if (!Directory.Exists(fullDirectory))
            {
                throw new InvalidOperationException(
                    "Gateway stub build input directory is missing: " +
                    fullDirectory);
            }

            relativePaths.AddRange(
                Directory.EnumerateFiles(
                        fullDirectory,
                        "*",
                        SearchOption.AllDirectories)
                    .Select(path => Path.GetRelativePath(repositoryRoot, path)));
        }

        relativePaths.Sort(StringComparer.Ordinal);
        using IncrementalHash hash = IncrementalHash.CreateHash(
            HashAlgorithmName.SHA256);
        hash.AppendData(Encoding.UTF8.GetBytes(FingerprintVersion));
        foreach (string relativePath in relativePaths)
        {
            string normalizedRelativePath = relativePath.Replace('\\', '/');
            string fullPath = Path.Combine(repositoryRoot, relativePath);
            if (!File.Exists(fullPath))
            {
                throw new InvalidOperationException(
                    "Gateway stub build input is missing: " + fullPath);
            }

            hash.AppendData(new byte[] { 0 });
            hash.AppendData(Encoding.UTF8.GetBytes(normalizedRelativePath));
            hash.AppendData(new byte[] { 0 });
            hash.AppendData(File.ReadAllBytes(fullPath));
        }

        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private static bool BuildIsCurrent(
        string repositoryRoot,
        string stampPath,
        string inputFingerprint)
    {
        if (!File.Exists(stampPath) || !RequiredOutputsExist(repositoryRoot))
        {
            return false;
        }

        try
        {
            string observed = File.ReadAllText(stampPath).Trim();
            return string.Equals(
                observed,
                inputFingerprint,
                StringComparison.Ordinal);
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool RequiredOutputsExist(string repositoryRoot) =>
        RequiredOutputs.All(
            relativePath =>
            {
                var file = new FileInfo(
                    Path.Combine(repositoryRoot, relativePath));
                return file.Exists && file.Length > 0;
            });

    private static void AssertRequiredOutputs(string repositoryRoot)
    {
        string[] missing = RequiredOutputs
            .Where(
                relativePath =>
                {
                    var file = new FileInfo(
                        Path.Combine(repositoryRoot, relativePath));
                    return !file.Exists || file.Length == 0;
                })
            .ToArray();
        if (missing.Length != 0)
        {
            throw new InvalidOperationException(
                "The coordinated Gateway stub build omitted required " +
                "outputs: " +
                string.Join(", ", missing));
        }
    }

    private static void DeleteStamp(string stampPath)
    {
        try
        {
            File.Delete(stampPath);
        }
        catch (IOException)
        {
            // Fail closed: a stale success marker must not survive a rebuild.
            throw new InvalidOperationException(
                "The stale Gateway stub build stamp could not be removed.");
        }
        catch (UnauthorizedAccessException)
        {
            throw new InvalidOperationException(
                "The stale Gateway stub build stamp could not be removed.");
        }
    }

    private static async Task WriteStampAsync(
        string stampPath,
        string inputFingerprint)
    {
        string temporaryPath = stampPath + "." +
            Environment.ProcessId.ToString(CultureInfo.InvariantCulture) +
            "." +
            Guid.NewGuid().ToString("N") +
            ".tmp";
        try
        {
            await File.WriteAllTextAsync(
                    temporaryPath,
                    inputFingerprint + Environment.NewLine,
                    Encoding.UTF8)
                .ConfigureAwait(false);
            File.Move(temporaryPath, stampPath, overwrite: true);
        }
        finally
        {
            File.Delete(temporaryPath);
        }
    }
}
