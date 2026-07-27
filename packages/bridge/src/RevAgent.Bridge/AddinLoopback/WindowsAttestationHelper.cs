using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using RevAgent.Bridge.Bootstrap;

namespace RevAgent.Bridge.AddinLoopback;

internal sealed record AttestationHelperProcessResult(
    int ExitCode,
    byte[] StandardOutput,
    byte[] StandardError,
    bool StandardOutputTruncated,
    bool StandardErrorTruncated);

internal interface IAttestationHelperExecutableResolver
{
    ResolvedAttestationHelperExecutable Resolve();
}

internal interface IAttestationHelperProcessLauncher
{
    IAttestationHelperProcess Start(
        ResolvedAttestationHelperExecutable executable);
}

internal interface IAttestationHelperProcess : IDisposable
{
    int Id { get; }

    Task<AttestationHelperProcessResult> ExchangeAsync(
        byte[] request,
        int maxOutputBytes);

    Task TerminateAsync();
}

internal sealed class AttestationHelperProcessHealth
{
    private int _poisoned;

    internal bool IsPoisoned =>
        Volatile.Read(ref _poisoned) != 0;

    internal void Poison()
    {
        Interlocked.Exchange(ref _poisoned, 1);
    }
}

internal sealed class ProcessWindowsAddinProcessAttestor
    : IAddinProcessAttestor
{
    private const int MaxIpcBytes = 8192;
    private static readonly SemaphoreSlim HelperGate =
        new(initialCount: 1, maxCount: 1);
    private static readonly AttestationHelperProcessHealth ProcessHealth =
        new();
    private readonly IAttestationHelperExecutableResolver _executableResolver;
    private readonly IAttestationHelperProcessLauncher _processLauncher;
    private readonly Func<string> _nonceFactory;
    private readonly AttestationHelperProcessHealth _health;
    private readonly TimeSpan _cleanupObservationTimeout;

    internal ProcessWindowsAddinProcessAttestor()
        : this(
            new AttestationHelperExecutableResolver(),
            new SystemAttestationHelperProcessLauncher(),
            CreateNonce,
            ProcessHealth,
            TimeSpan.FromSeconds(2))
    {
    }

    internal ProcessWindowsAddinProcessAttestor(
        IAttestationHelperExecutableResolver executableResolver,
        IAttestationHelperProcessLauncher processLauncher,
        Func<string> nonceFactory)
        : this(
            executableResolver,
            processLauncher,
            nonceFactory,
            new AttestationHelperProcessHealth(),
            TimeSpan.FromSeconds(2))
    {
    }

    internal ProcessWindowsAddinProcessAttestor(
        IAttestationHelperExecutableResolver executableResolver,
        IAttestationHelperProcessLauncher processLauncher,
        Func<string> nonceFactory,
        AttestationHelperProcessHealth health)
        : this(
            executableResolver,
            processLauncher,
            nonceFactory,
            health,
            TimeSpan.FromSeconds(2))
    {
    }

    internal ProcessWindowsAddinProcessAttestor(
        IAttestationHelperExecutableResolver executableResolver,
        IAttestationHelperProcessLauncher processLauncher,
        Func<string> nonceFactory,
        AttestationHelperProcessHealth health,
        TimeSpan cleanupObservationTimeout)
    {
        _executableResolver = executableResolver ??
            throw new ArgumentNullException(nameof(executableResolver));
        _processLauncher = processLauncher ??
            throw new ArgumentNullException(nameof(processLauncher));
        _nonceFactory = nonceFactory ??
            throw new ArgumentNullException(nameof(nonceFactory));
        _health = health ??
            throw new ArgumentNullException(nameof(health));
        if (cleanupObservationTimeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(
                nameof(cleanupObservationTimeout));
        }

        _cleanupObservationTimeout = cleanupObservationTimeout;
    }

    public Task<AddinProcessAttestation> AttestBeforeDispatchAsync(
        AddinConnectedPeer peer,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(peer);
        return RunAsync(
            AttestationHelperProtocol.CreateAttestRequest(
                _nonceFactory(),
                peer),
            response => AttestationHelperProtocol.RequireAttestation(response),
            cancellationToken);
    }

    public async Task VerifyAfterResponseAsync(
        AddinConnectedPeer peer,
        AddinProcessAttestation attestation,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(peer);
        ArgumentNullException.ThrowIfNull(attestation);
        _ = await RunAsync(
            AttestationHelperProtocol.CreateVerifyRequest(
                _nonceFactory(),
                peer,
                attestation),
            response =>
            {
                AttestationHelperProtocol.RequireVerification(response);
                return true;
            },
            cancellationToken).ConfigureAwait(false);
    }

    private async Task<T> RunAsync<T>(
        AttestationHelperRequest request,
        Func<AttestationHelperResponse, T> resultFactory,
        CancellationToken cancellationToken)
    {
        EnsureHealthy();
        byte[] requestBytes =
            AttestationHelperProtocol.SerializeRequest(request);
        if (requestBytes.Length > MaxIpcBytes)
        {
            throw Failure(
                "addin_process_attestation_request_unbounded",
                "The internal attestation request exceeds its IPC bound.");
        }

        await HelperGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        IAttestationHelperProcess? process = null;
        ResolvedAttestationHelperExecutable? executable = null;
        Task<AttestationHelperProcessResult>? exchange = null;
        try
        {
            EnsureHealthy();
            executable = _executableResolver.Resolve();
            process = _processLauncher.Start(executable);
            exchange = process.ExchangeAsync(
                requestBytes,
                MaxIpcBytes);
            AttestationHelperProcessResult result =
                await exchange.WaitAsync(cancellationToken)
                    .ConfigureAwait(false);

            if (result.StandardOutputTruncated ||
                result.StandardErrorTruncated)
            {
                throw Failure(
                    "addin_process_attestation_response_unbounded",
                    "The internal attestation helper exceeded its IPC bound.");
            }

            if (result.ExitCode != 0)
            {
                throw Failure(
                    "addin_process_attestation_helper_failed",
                    "The internal attestation helper exited without valid evidence.");
            }

            AttestationHelperResponse response =
                AttestationHelperProtocol.ParseResponse(
                    result.StandardOutput);
            AttestationHelperProtocol.VerifyNonce(
                request.Nonce,
                response.Nonce);
            return resultFactory(response);
        }
        catch (OperationCanceledException exception)
            when (cancellationToken.IsCancellationRequested)
        {
            if (process != null)
            {
                await TerminateAndObserveOrPoisonAsync(
                        process,
                        exchange,
                        exception)
                    .ConfigureAwait(false);
            }

            throw;
        }
        catch (AddinProcessAttestationException exception)
        {
            if (process != null &&
                !_health.IsPoisoned)
            {
                await TerminateAndObserveOrPoisonAsync(
                        process,
                        exchange,
                        exception)
                    .ConfigureAwait(false);
            }

            throw;
        }
        catch (AttestationHelperLaunchCleanupException exception)
        {
            _health.Poison();
            throw Failure(
                "addin_process_attestation_helper_restart_required",
                "The attestation helper launch cleanup could not be verified; the Bridge Worker must restart.",
                exception.InnerException ?? exception);
        }
        catch (Exception exception)
        {
            if (process != null)
            {
                await TerminateAndObserveOrPoisonAsync(
                        process,
                        exchange,
                        exception)
                    .ConfigureAwait(false);
            }

            throw Failure(
                "addin_process_attestation_helper_unavailable",
                "The isolated attestation helper could not produce evidence.",
                exception);
        }
        finally
        {
            process?.Dispose();
            executable?.Dispose();
            HelperGate.Release();
        }
    }

    private async Task TerminateAndObserveOrPoisonAsync(
        IAttestationHelperProcess process,
        Task? exchange,
        Exception originalFailure)
    {
        try
        {
            await TerminateAndObserveAsync(process, exchange)
                .ConfigureAwait(false);
        }
        catch (Exception cleanupFailure)
        {
            _health.Poison();
            throw Failure(
                "addin_process_attestation_helper_restart_required",
                "The attestation helper exit could not be verified; the Bridge Worker must restart.",
                new AggregateException(
                    originalFailure,
                    cleanupFailure));
        }
    }

    private async Task TerminateAndObserveAsync(
        IAttestationHelperProcess process,
        Task? exchange)
    {
        await process.TerminateAsync().ConfigureAwait(false);
        if (exchange == null)
        {
            return;
        }

        try
        {
            await exchange
                .WaitAsync(_cleanupObservationTimeout)
                .ConfigureAwait(false);
        }
        catch (TimeoutException exception)
        {
            throw new IOException(
                "The terminated attestation helper pipe did not close.",
                exception);
        }
        catch
        {
            // A verified-terminated helper normally faults its pipe exchange.
            // Observing that terminal failure is sufficient for cleanup.
        }
    }

    private void EnsureHealthy()
    {
        if (_health.IsPoisoned)
        {
            throw Failure(
                "addin_process_attestation_helper_restart_required",
                "The attestation helper is poisoned; the Bridge Worker must restart.");
        }
    }

    private static string CreateNonce()
    {
        byte[] bytes = RandomNumberGenerator.GetBytes(32);
        return Convert.ToBase64String(bytes);
    }

    private static AddinProcessAttestationException Failure(
        string code,
        string message,
        Exception? innerException = null) =>
        new(code, message, innerException);
}

internal sealed class AttestationHelperExecutableResolver
    : IAttestationHelperExecutableResolver
{
    private readonly Func<string?> _processPath;
    private readonly Func<string> _workingDirectory;
    private readonly Func<BridgeInstallLayout> _installLayout;
    private readonly Func<string> _programFilesRoot;
    private readonly IAttestationHelperPathAuthority _pathAuthority;

    internal AttestationHelperExecutableResolver()
        : this(
            () => Environment.ProcessPath,
            () => AppContext.BaseDirectory,
            () => BridgeInstallLayout.Canonical,
            () => Environment.GetFolderPath(
                Environment.SpecialFolder.ProgramFiles),
            new WindowsAttestationHelperPathAuthority())
    {
    }

    internal AttestationHelperExecutableResolver(
        Func<string?> processPath,
        Func<string> workingDirectory,
        Func<BridgeInstallLayout> installLayout,
        Func<string> programFilesRoot,
        IAttestationHelperPathAuthority pathAuthority)
    {
        _processPath = processPath ??
            throw new ArgumentNullException(nameof(processPath));
        _workingDirectory = workingDirectory ??
            throw new ArgumentNullException(nameof(workingDirectory));
        _installLayout = installLayout ??
            throw new ArgumentNullException(nameof(installLayout));
        _programFilesRoot = programFilesRoot ??
            throw new ArgumentNullException(nameof(programFilesRoot));
        _pathAuthority = pathAuthority ??
            throw new ArgumentNullException(nameof(pathAuthority));
    }

    public ResolvedAttestationHelperExecutable Resolve()
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException(
                "The attestation helper is Windows-only.");
        }

        string? rawProcessPath = _processPath();
        string workingDirectory = _workingDirectory();
        string programFilesRoot = _programFilesRoot();
        if (string.IsNullOrWhiteSpace(rawProcessPath) ||
            string.IsNullOrWhiteSpace(workingDirectory) ||
            string.IsNullOrWhiteSpace(programFilesRoot))
        {
            throw new InvalidOperationException(
                "The current Bridge worker executable path is unavailable.");
        }

        BridgeInstallLayout layout = _installLayout() ??
            throw new InvalidOperationException(
                "The canonical Bridge install layout is unavailable.");
        return _pathAuthority.OpenTrustedExecutable(
            rawProcessPath,
            workingDirectory,
            layout.VersionsRoot,
            programFilesRoot);
    }
}

internal sealed class SystemAttestationHelperProcessLauncher
    : IAttestationHelperProcessLauncher
{
    private static readonly string[] AllowedEnvironmentVariables =
    [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "DOTNET_BUNDLE_EXTRACT_BASE_DIR",
    ];
    private readonly IAttestationHelperChildImageVerifier _imageVerifier;
    private readonly IAttestationHelperJobFactory _jobFactory;
    private readonly IAttestationHelperNativeProcessFactory
        _nativeProcessFactory;

    internal SystemAttestationHelperProcessLauncher()
        : this(
            new WindowsAttestationHelperChildImageVerifier(),
            new WindowsAttestationHelperJobFactory(),
            new WindowsAttestationHelperNativeProcessFactory())
    {
    }

    internal SystemAttestationHelperProcessLauncher(
        IAttestationHelperChildImageVerifier imageVerifier,
        IAttestationHelperJobFactory jobFactory)
        : this(
            imageVerifier,
            jobFactory,
            new WindowsAttestationHelperNativeProcessFactory())
    {
    }

    internal SystemAttestationHelperProcessLauncher(
        IAttestationHelperChildImageVerifier imageVerifier,
        IAttestationHelperJobFactory jobFactory,
        IAttestationHelperNativeProcessFactory nativeProcessFactory)
    {
        _imageVerifier = imageVerifier ??
            throw new ArgumentNullException(nameof(imageVerifier));
        _jobFactory = jobFactory ??
            throw new ArgumentNullException(nameof(jobFactory));
        _nativeProcessFactory = nativeProcessFactory ??
            throw new ArgumentNullException(nameof(nativeProcessFactory));
    }

    public IAttestationHelperProcess Start(
        ResolvedAttestationHelperExecutable executable)
    {
        ArgumentNullException.ThrowIfNull(executable);
        ProcessStartInfo startInfo = CreateStartInfo(executable);
        IAttestationHelperJob? job = null;
        IAttestationHelperNativeProcess? process = null;
        try
        {
            job = _jobFactory.Create();
            process = _nativeProcessFactory.StartSuspended(
                startInfo,
                job);
            _imageVerifier.Verify(process.Process, executable);
            process.Resume();
            var result =
                new SystemAttestationHelperProcess(process, job);
            process = null;
            job = null;
            return result;
        }
        catch (Exception launchFailure)
        {
            if (process != null &&
                job != null)
            {
                IReadOnlyList<Exception> cleanupFailures =
                    CleanupStartedProcess(process, job);
                if (cleanupFailures.Count != 0)
                {
                    throw new AttestationHelperLaunchCleanupException(
                        launchFailure,
                        cleanupFailures);
                }
            }

            throw;
        }
        finally
        {
            job?.Dispose();
            process?.Dispose();
        }
    }

    internal static ProcessStartInfo CreateStartInfo(
        ResolvedAttestationHelperExecutable executable)
    {
        ArgumentNullException.ThrowIfNull(executable);
        var startInfo = new ProcessStartInfo
        {
            FileName = executable.ExecutablePath,
            WorkingDirectory = executable.WorkingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add(
            AttestationHelperProtocol.InternalCommand);
        startInfo.Environment.Clear();
        foreach (string variableName in AllowedEnvironmentVariables)
        {
            string? value =
                Environment.GetEnvironmentVariable(variableName);
            if (!string.IsNullOrWhiteSpace(value))
            {
                startInfo.Environment[variableName] = value;
            }
        }

        return startInfo;
    }

    private static IReadOnlyList<Exception> CleanupStartedProcess(
        IAttestationHelperNativeProcess process,
        IAttestationHelperJob job)
    {
        var failures = new List<Exception>();
        try
        {
            job.Terminate();
        }
        catch (Exception exception)
        {
            failures.Add(exception);
        }

        try
        {
            if (!process.WaitForExit(TimeSpan.FromSeconds(2)))
            {
                failures.Add(
                    new TimeoutException(
                        "The suspended attestation helper did not terminate."));
            }
        }
        catch (Exception exception)
        {
            failures.Add(exception);
        }

        try
        {
            job.VerifyEmpty(TimeSpan.FromSeconds(2));
        }
        catch (Exception exception)
        {
            failures.Add(exception);
        }

        return failures;
    }
}

internal sealed class SystemAttestationHelperProcess
    : IAttestationHelperProcess
{
    private readonly IAttestationHelperNativeProcess _process;
    private readonly IAttestationHelperJob _job;
    private int _disposed;

    internal SystemAttestationHelperProcess(
        IAttestationHelperNativeProcess process,
        IAttestationHelperJob job)
    {
        _process = process ??
            throw new ArgumentNullException(nameof(process));
        _job = job ??
            throw new ArgumentNullException(nameof(job));
    }

    public int Id => _process.Process.Id;

    public async Task<AttestationHelperProcessResult> ExchangeAsync(
        byte[] request,
        int maxOutputBytes)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Length == 0 || request.Length > maxOutputBytes)
        {
            throw new ArgumentOutOfRangeException(nameof(request));
        }

        Task<BoundedBytes> stdout = ReadBoundedAsync(
            _process.StandardOutput,
            maxOutputBytes);
        Task<BoundedBytes> stderr = ReadBoundedAsync(
            _process.StandardError,
            maxOutputBytes);
        await _process.StandardInput
            .WriteAsync(request)
            .ConfigureAwait(false);
        await _process.StandardInput
            .FlushAsync()
            .ConfigureAwait(false);
        _process.StandardInput.Close();

        await _process.WaitForExitAsync()
            .ConfigureAwait(false);
        _job.VerifyEmpty(TimeSpan.FromSeconds(2));
        BoundedBytes standardOutput = await stdout.ConfigureAwait(false);
        BoundedBytes standardError = await stderr.ConfigureAwait(false);
        return new AttestationHelperProcessResult(
            _process.ExitCode,
            standardOutput.Bytes,
            standardError.Bytes,
            standardOutput.Truncated,
            standardError.Truncated);
    }

    public async Task TerminateAsync()
    {
        if (!_process.HasExited ||
            !_job.IsEmpty)
        {
            _job.Terminate();
        }

        await _process.WaitForExitAsync()
            .WaitAsync(TimeSpan.FromSeconds(2))
            .ConfigureAwait(false);
        if (!_process.HasExited)
        {
            throw new TimeoutException(
                "The attestation helper process exit was not observed.");
        }

        _job.VerifyEmpty(TimeSpan.FromSeconds(2));
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            _job.Dispose();
            _process.Dispose();
        }
    }

    private static async Task<BoundedBytes> ReadBoundedAsync(
        Stream stream,
        int maxBytes)
    {
        var retained = new MemoryStream(Math.Min(maxBytes, 4096));
        var buffer = new byte[1024];
        bool truncated = false;
        while (true)
        {
            int read = await stream.ReadAsync(buffer).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            int available = maxBytes - checked((int)retained.Length);
            int toRetain = Math.Min(available, read);
            if (toRetain > 0)
            {
                retained.Write(buffer, 0, toRetain);
            }

            if (toRetain != read)
            {
                truncated = true;
            }
        }

        return new BoundedBytes(retained.ToArray(), truncated);
    }

    private sealed record BoundedBytes(byte[] Bytes, bool Truncated);
}

internal sealed record AttestationHelperRequest(
    int ProtocolVersion,
    string Nonce,
    string Operation,
    string ServerAddress,
    int ServerPort,
    string ClientAddress,
    int ClientPort,
    AttestationHelperPayload? ExpectedAttestation);

internal sealed record AttestationHelperResponse(
    int ProtocolVersion,
    string Nonce,
    bool Success,
    AttestationHelperPayload? Attestation,
    string? ErrorCode,
    string? ErrorMessage);

internal sealed record AttestationHelperPayload(
    int ProcessId,
    long StartTimeFileTimeUtc,
    string RevitVersion,
    string ImagePath);

internal static class AttestationHelperProtocol
{
    internal const string InternalCommand = "__attestation_helper";
    internal const int ProtocolVersion = 1;
    internal const int MaxIpcBytes = 8192;
    private const string AttestOperation = "attest_before_dispatch";
    private const string VerifyOperation = "verify_after_response";
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 8,
    };

    internal static bool IsHelperCommand(IReadOnlyList<string> args) =>
        args.Count == 1 &&
        string.Equals(
            args[0],
            InternalCommand,
            StringComparison.Ordinal);

    internal static AttestationHelperRequest CreateAttestRequest(
        string nonce,
        AddinConnectedPeer peer) =>
        CreateRequest(
            nonce,
            AttestOperation,
            peer,
            expectedAttestation: null);

    internal static AttestationHelperRequest CreateVerifyRequest(
        string nonce,
        AddinConnectedPeer peer,
        AddinProcessAttestation attestation) =>
        CreateRequest(
            nonce,
            VerifyOperation,
            peer,
            ToPayload(attestation));

    internal static byte[] SerializeRequest(
        AttestationHelperRequest request)
    {
        ValidateRequest(request);
        return JsonSerializer.SerializeToUtf8Bytes(
            request,
            JsonOptions);
    }

    internal static AttestationHelperRequest ParseRequest(byte[] bytes)
    {
        ValidateIpcBytes(bytes);
        AttestationHelperRequest request =
            JsonSerializer.Deserialize<AttestationHelperRequest>(
                bytes,
                JsonOptions) ??
            throw new InvalidDataException(
                "The attestation helper request is empty.");
        ValidateRequest(request);
        return request;
    }

    internal static byte[] SerializeResponse(
        AttestationHelperResponse response)
    {
        ValidateResponse(response);
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(
            response,
            JsonOptions);
        ValidateIpcBytes(bytes);
        return bytes;
    }

    internal static AttestationHelperResponse ParseResponse(
        byte[] bytes)
    {
        ValidateIpcBytes(bytes);
        AttestationHelperResponse response =
            JsonSerializer.Deserialize<AttestationHelperResponse>(
                bytes,
                JsonOptions) ??
            throw new InvalidDataException(
                "The attestation helper response is empty.");
        ValidateResponse(response);
        return response;
    }

    internal static AddinProcessAttestation RequireAttestation(
        AttestationHelperResponse response)
    {
        RequireSuccess(response);
        return FromPayload(
            response.Attestation ??
            throw new InvalidDataException(
                "The attestation helper omitted process evidence."));
    }

    internal static void RequireVerification(
        AttestationHelperResponse response)
    {
        RequireSuccess(response);
        if (response.Attestation != null)
        {
            throw new InvalidDataException(
                "A verification response must not return new attestation evidence.");
        }
    }

    internal static void VerifyNonce(
        string expectedNonce,
        string actualNonce)
    {
        byte[] expected = DecodeNonce(expectedNonce);
        byte[] actual = DecodeNonce(actualNonce);
        if (!CryptographicOperations.FixedTimeEquals(expected, actual))
        {
            throw new InvalidDataException(
                "The attestation helper response nonce does not match its request.");
        }
    }

    internal static AttestationHelperResponse Success(
        AttestationHelperRequest request,
        AddinProcessAttestation? attestation) =>
        new(
            ProtocolVersion,
            request.Nonce,
            Success: true,
            attestation == null ? null : ToPayload(attestation),
            ErrorCode: null,
            ErrorMessage: null);

    internal static AttestationHelperResponse Failure(
        AttestationHelperRequest request,
        string errorCode,
        string errorMessage) =>
        new(
            ProtocolVersion,
            request.Nonce,
            Success: false,
            Attestation: null,
            Bound(errorCode, 128),
            Bound(errorMessage, 512));

    private static AttestationHelperRequest CreateRequest(
        string nonce,
        string operation,
        AddinConnectedPeer peer,
        AttestationHelperPayload? expectedAttestation)
    {
        var request = new AttestationHelperRequest(
            ProtocolVersion,
            nonce,
            operation,
            peer.ServerEndPoint.Address.ToString(),
            peer.ServerEndPoint.Port,
            peer.ClientEndPoint.Address.ToString(),
            peer.ClientEndPoint.Port,
            expectedAttestation);
        ValidateRequest(request);
        return request;
    }

    private static void ValidateRequest(
        AttestationHelperRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.ProtocolVersion != ProtocolVersion)
        {
            throw new InvalidDataException(
                "The attestation helper request protocol is unsupported.");
        }

        _ = DecodeNonce(request.Nonce);
        _ = ParseLoopback(request.ServerAddress, request.ServerPort);
        _ = ParseLoopback(request.ClientAddress, request.ClientPort);
        if (string.Equals(
                request.Operation,
                AttestOperation,
                StringComparison.Ordinal))
        {
            if (request.ExpectedAttestation != null)
            {
                throw new InvalidDataException(
                    "An initial attestation request must not include prior evidence.");
            }
        }
        else if (string.Equals(
                     request.Operation,
                     VerifyOperation,
                     StringComparison.Ordinal))
        {
            ValidatePayload(
                request.ExpectedAttestation ??
                throw new InvalidDataException(
                    "A post-response verification requires prior evidence."));
        }
        else
        {
            throw new InvalidDataException(
                "The attestation helper operation is unsupported.");
        }
    }

    private static void ValidateResponse(
        AttestationHelperResponse response)
    {
        ArgumentNullException.ThrowIfNull(response);
        if (response.ProtocolVersion != ProtocolVersion)
        {
            throw new InvalidDataException(
                "The attestation helper response protocol is unsupported.");
        }

        _ = DecodeNonce(response.Nonce);
        if (response.Success)
        {
            if (response.ErrorCode != null ||
                response.ErrorMessage != null)
            {
                throw new InvalidDataException(
                    "A successful attestation helper response contains an error.");
            }

            if (response.Attestation != null)
            {
                ValidatePayload(response.Attestation);
            }
        }
        else
        {
            if (response.Attestation != null ||
                string.IsNullOrWhiteSpace(response.ErrorCode) ||
                response.ErrorCode.Length > 128 ||
                string.IsNullOrWhiteSpace(response.ErrorMessage) ||
                response.ErrorMessage.Length > 512)
            {
                throw new InvalidDataException(
                    "A failed attestation helper response is malformed.");
            }
        }
    }

    private static void RequireSuccess(
        AttestationHelperResponse response)
    {
        if (!response.Success)
        {
            throw new AddinProcessAttestationException(
                response.ErrorCode!,
                response.ErrorMessage!);
        }
    }

    private static AttestationHelperPayload ToPayload(
        AddinProcessAttestation attestation) =>
        new(
            attestation.Identity.ProcessId,
            attestation.Identity.StartTimeFileTimeUtc,
            attestation.RevitVersion,
            attestation.ImagePath);

    private static AddinProcessAttestation FromPayload(
        AttestationHelperPayload payload)
    {
        ValidatePayload(payload);
        return new AddinProcessAttestation(
            new AddinProcessIdentity(
                payload.ProcessId,
                payload.StartTimeFileTimeUtc),
            payload.RevitVersion,
            payload.ImagePath);
    }

    private static void ValidatePayload(
        AttestationHelperPayload payload)
    {
        if (payload.ProcessId <= 0 ||
            payload.StartTimeFileTimeUtc <= 0 ||
            payload.RevitVersion.Length != 4 ||
            payload.RevitVersion.Any(
                character => character is < '0' or > '9') ||
            string.IsNullOrWhiteSpace(payload.ImagePath) ||
            payload.ImagePath.Length > 1024 ||
            !Path.IsPathFullyQualified(payload.ImagePath))
        {
            throw new InvalidDataException(
                "The attestation helper process evidence is malformed.");
        }
    }

    private static IPEndPoint ParseLoopback(
        string addressText,
        int port)
    {
        if (port is <= 0 or > 65535 ||
            !IPAddress.TryParse(addressText, out IPAddress? address) ||
            !address.Equals(IPAddress.Loopback))
        {
            throw new InvalidDataException(
                "The attestation helper accepts only exact IPv4 loopback endpoints.");
        }

        return new IPEndPoint(address, port);
    }

    internal static AddinConnectedPeer ToPeer(
        AttestationHelperRequest request)
    {
        ValidateRequest(request);
        return new AddinConnectedPeer(
            ParseLoopback(request.ClientAddress, request.ClientPort),
            ParseLoopback(request.ServerAddress, request.ServerPort));
    }

    internal static AddinProcessAttestation ExpectedAttestation(
        AttestationHelperRequest request) =>
        FromPayload(
            request.ExpectedAttestation ??
            throw new InvalidDataException(
                "The helper request has no expected attestation."));

    internal static bool IsAttestOperation(
        AttestationHelperRequest request) =>
        string.Equals(
            request.Operation,
            AttestOperation,
            StringComparison.Ordinal);

    private static byte[] DecodeNonce(string nonce)
    {
        if (string.IsNullOrWhiteSpace(nonce) || nonce.Length != 44)
        {
            throw new InvalidDataException(
                "The attestation helper nonce is malformed.");
        }

        try
        {
            byte[] bytes = Convert.FromBase64String(nonce);
            if (bytes.Length != 32)
            {
                throw new InvalidDataException(
                    "The attestation helper nonce has the wrong size.");
            }

            return bytes;
        }
        catch (FormatException exception)
        {
            throw new InvalidDataException(
                "The attestation helper nonce is malformed.",
                exception);
        }
    }

    private static void ValidateIpcBytes(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        if (bytes.Length is <= 0 or > MaxIpcBytes)
        {
            throw new InvalidDataException(
                "The attestation helper IPC payload is empty or unbounded.");
        }
    }

    private static string Bound(string value, int maximumLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "attestation_helper_failure";
        }

        return value.Length <= maximumLength
            ? value
            : value[..maximumLength];
    }
}

internal static class WindowsAttestationHelperServer
{
    internal static Task<int> RunAsync() =>
        RunAsync(
            Console.OpenStandardInput(),
            Console.OpenStandardOutput(),
            WindowsAddinProcessAttestor.CreateNativeInProcess);

    internal static async Task<int> RunAsync(
        Stream input,
        Stream output,
        Func<IAddinProcessAttestor> attestorFactory)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(output);
        ArgumentNullException.ThrowIfNull(attestorFactory);

        AttestationHelperRequest request;
        try
        {
            byte[] requestBytes = await ReadBoundedToEndAsync(
                input,
                AttestationHelperProtocol.MaxIpcBytes)
                .ConfigureAwait(false);
            request = AttestationHelperProtocol.ParseRequest(requestBytes);
        }
        catch
        {
            return 64;
        }

        AttestationHelperResponse response;
        try
        {
            AddinConnectedPeer peer =
                AttestationHelperProtocol.ToPeer(request);
            IAddinProcessAttestor attestor = attestorFactory();
            if (AttestationHelperProtocol.IsAttestOperation(request))
            {
                AddinProcessAttestation attestation =
                    await attestor.AttestBeforeDispatchAsync(
                        peer,
                        CancellationToken.None).ConfigureAwait(false);
                response = AttestationHelperProtocol.Success(
                    request,
                    attestation);
            }
            else
            {
                await attestor.VerifyAfterResponseAsync(
                    peer,
                    AttestationHelperProtocol.ExpectedAttestation(request),
                    CancellationToken.None).ConfigureAwait(false);
                response = AttestationHelperProtocol.Success(
                    request,
                    attestation: null);
            }
        }
        catch (AddinProcessAttestationException exception)
        {
            response = AttestationHelperProtocol.Failure(
                request,
                exception.Code,
                exception.Message);
        }
        catch
        {
            response = AttestationHelperProtocol.Failure(
                request,
                "addin_process_attestation_helper_unavailable",
                "The isolated attestation helper could not produce evidence.");
        }

        byte[] responseBytes =
            AttestationHelperProtocol.SerializeResponse(response);
        await output.WriteAsync(responseBytes).ConfigureAwait(false);
        await output.FlushAsync().ConfigureAwait(false);
        return 0;
    }

    private static async Task<byte[]> ReadBoundedToEndAsync(
        Stream input,
        int maxBytes)
    {
        using var retained = new MemoryStream(Math.Min(maxBytes, 4096));
        var buffer = new byte[1024];
        while (true)
        {
            int read = await input.ReadAsync(buffer).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            if (retained.Length + read > maxBytes)
            {
                throw new InvalidDataException(
                    "The attestation helper request exceeds its IPC bound.");
            }

            retained.Write(buffer, 0, read);
        }

        return retained.ToArray();
    }
}
