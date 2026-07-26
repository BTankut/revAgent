using System.Globalization;
using System.Net;
using System.Net.Sockets;

namespace RevAgent.Bridge.AddinLoopback;

internal readonly record struct AddinProcessIdentity(
    int ProcessId,
    long StartTimeFileTimeUtc)
{
    internal string CreateLocalSessionKey(AddinEndpoint target)
    {
        ArgumentNullException.ThrowIfNull(target);
        return "port:" +
            target.Port.ToString(CultureInfo.InvariantCulture) +
            ":pid:" +
            ProcessId.ToString(CultureInfo.InvariantCulture) +
            ":started:" +
            StartTimeFileTimeUtc.ToString(CultureInfo.InvariantCulture);
    }
}

internal sealed record AddinProcessAttestation(
    AddinProcessIdentity Identity,
    string RevitVersion,
    string ImagePath);

internal sealed record AddinConnectedPeer(
    IPEndPoint ClientEndPoint,
    IPEndPoint ServerEndPoint)
{
    internal static AddinConnectedPeer FromConnectedClient(TcpClient client)
    {
        ArgumentNullException.ThrowIfNull(client);
        if (client.Client.LocalEndPoint is not IPEndPoint clientEndPoint ||
            client.Client.RemoteEndPoint is not IPEndPoint serverEndPoint ||
            clientEndPoint.AddressFamily != AddressFamily.InterNetwork ||
            serverEndPoint.AddressFamily != AddressFamily.InterNetwork)
        {
            throw new AddinProcessAttestationException(
                "addin_connected_peer_unavailable",
                "The connected add-in TCP endpoints are unavailable.");
        }

        return new AddinConnectedPeer(clientEndPoint, serverEndPoint);
    }
}

internal interface IAddinProcessAttestor
{
    Task<AddinProcessAttestation> AttestBeforeDispatchAsync(
        AddinConnectedPeer peer,
        CancellationToken cancellationToken);

    Task VerifyAfterResponseAsync(
        AddinConnectedPeer peer,
        AddinProcessAttestation attestation,
        CancellationToken cancellationToken);
}

internal sealed class AddinProcessAttestationException : Exception
{
    internal AddinProcessAttestationException(
        string code,
        string message,
        Exception? innerException = null)
        : base(message, innerException)
    {
        Code = code;
    }

    internal string Code { get; }
}

internal sealed class ExpectedAddinProcessAttestor : IAddinProcessAttestor
{
    private readonly IAddinProcessAttestor _inner;

    internal ExpectedAddinProcessAttestor(
        IAddinProcessAttestor inner,
        AddinProcessAttestation expected)
    {
        _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        Expected = expected ?? throw new ArgumentNullException(nameof(expected));
        if (Expected.Identity.ProcessId <= 0 ||
            Expected.Identity.StartTimeFileTimeUtc <= 0 ||
            string.IsNullOrWhiteSpace(Expected.RevitVersion) ||
            string.IsNullOrWhiteSpace(Expected.ImagePath))
        {
            throw new ArgumentException(
                "The expected add-in process attestation is incomplete.",
                nameof(expected));
        }
    }

    internal AddinProcessAttestation Expected { get; }

    public async Task<AddinProcessAttestation> AttestBeforeDispatchAsync(
        AddinConnectedPeer peer,
        CancellationToken cancellationToken)
    {
        AddinProcessAttestation actual =
            await _inner.AttestBeforeDispatchAsync(
                peer,
                cancellationToken).ConfigureAwait(false);
        EnsureExpected(actual);
        return actual;
    }

    public Task VerifyAfterResponseAsync(
        AddinConnectedPeer peer,
        AddinProcessAttestation attestation,
        CancellationToken cancellationToken)
    {
        EnsureExpected(attestation);
        return _inner.VerifyAfterResponseAsync(
            peer,
            attestation,
            cancellationToken);
    }

    private void EnsureExpected(AddinProcessAttestation actual)
    {
        if (actual == null ||
            actual.Identity != Expected.Identity ||
            !string.Equals(
                actual.RevitVersion,
                Expected.RevitVersion,
                StringComparison.Ordinal) ||
            !PathEquals(actual.ImagePath, Expected.ImagePath))
        {
            throw new AddinProcessAttestationException(
                "addin_process_identity_mismatch",
                "The connected add-in endpoint is no longer owned by the expected Revit process.");
        }
    }

    private static bool PathEquals(string left, string right)
    {
        try
        {
            return string.Equals(
                Path.GetFullPath(left),
                Path.GetFullPath(right),
                StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception exception) when (
            exception is ArgumentException ||
            exception is NotSupportedException ||
            exception is PathTooLongException)
        {
            return false;
        }
    }
}

internal sealed record WindowsProcessSnapshot(
    int ProcessId,
    long StartTimeFileTimeUtc,
    string ImagePath);

internal interface IWindowsTcpConnectionOwnerResolver
{
    int ResolveOwnerProcessId(AddinConnectedPeer peer);
}

internal interface IWindowsProcessSnapshotProvider
{
    WindowsProcessSnapshot Capture(int processId);
}

internal interface IWindowsRevitImageTrustVerifier
{
    void Verify(string imagePath, string trustedProgramFilesRoot);
}

/// <summary>
/// Binds a self-reported mcp_status identity to Windows-owned listener,
/// process-start, executable-path, ACL, and Authenticode evidence.
/// </summary>
internal sealed class WindowsAddinProcessAttestor : IAddinProcessAttestor
{
    private static readonly SemaphoreSlim AttestationWorkerGate =
        new(initialCount: 1, maxCount: 1);
    private readonly IWindowsTcpConnectionOwnerResolver _connectionOwnerResolver;
    private readonly IWindowsProcessSnapshotProvider _processSnapshotProvider;
    private readonly IWindowsRevitImageTrustVerifier _imageTrustVerifier;
    private readonly Func<string> _programFilesPath;
    private readonly Func<bool> _isWindows;

    internal WindowsAddinProcessAttestor()
        : this(
            new WindowsTcpConnectionOwnerResolver(),
            new WindowsProcessSnapshotProvider(),
            new WindowsRevitImageTrustVerifier(),
            () => Environment.GetFolderPath(
                Environment.SpecialFolder.ProgramFiles),
            OperatingSystem.IsWindows)
    {
    }

    internal WindowsAddinProcessAttestor(
        IWindowsTcpConnectionOwnerResolver connectionOwnerResolver,
        IWindowsProcessSnapshotProvider processSnapshotProvider,
        IWindowsRevitImageTrustVerifier imageTrustVerifier,
        Func<string> programFilesPath,
        Func<bool> isWindows)
    {
        _connectionOwnerResolver = connectionOwnerResolver ??
            throw new ArgumentNullException(nameof(connectionOwnerResolver));
        _processSnapshotProvider = processSnapshotProvider ??
            throw new ArgumentNullException(nameof(processSnapshotProvider));
        _imageTrustVerifier = imageTrustVerifier ??
            throw new ArgumentNullException(nameof(imageTrustVerifier));
        _programFilesPath = programFilesPath ??
            throw new ArgumentNullException(nameof(programFilesPath));
        _isWindows = isWindows ??
            throw new ArgumentNullException(nameof(isWindows));
    }

    public async Task<AddinProcessAttestation> AttestBeforeDispatchAsync(
        AddinConnectedPeer peer,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(peer);
        try
        {
            return await RunSerializedAsync(
                () => AttestBeforeDispatch(peer, cancellationToken),
                cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (
            exception is not OperationCanceledException &&
            exception is not AddinProcessAttestationException)
        {
            throw Failure(
                "addin_process_attestation_unavailable",
                "Connected-peer process attestation failed.",
                exception);
        }
    }

    public async Task VerifyAfterResponseAsync(
        AddinConnectedPeer peer,
        AddinProcessAttestation attestation,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(peer);
        ArgumentNullException.ThrowIfNull(attestation);
        try
        {
            await RunSerializedAsync(
                () =>
                {
                    VerifyAfterResponse(attestation, cancellationToken);
                    return true;
                },
                cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (
            exception is not OperationCanceledException &&
            exception is not AddinProcessAttestationException)
        {
            throw Failure(
                "addin_process_attestation_unavailable",
                "Post-response process identity verification failed.",
                exception);
        }
    }

    private AddinProcessAttestation AttestBeforeDispatch(
        AddinConnectedPeer peer,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!_isWindows())
        {
            throw Failure(
                "addin_process_attestation_unavailable",
                "Add-in process attestation is available only on Windows.");
        }

        if (peer.ServerEndPoint.AddressFamily != AddressFamily.InterNetwork ||
            peer.ClientEndPoint.AddressFamily != AddressFamily.InterNetwork)
        {
            throw Failure(
                "addin_listener_address_family_unsupported",
                "Windows add-in listener attestation requires an IPv4 target.");
        }

        int ownerProcessId = ResolveConnectionOwner(peer);
        cancellationToken.ThrowIfCancellationRequested();
        WindowsProcessSnapshot before = Capture(ownerProcessId);
        cancellationToken.ThrowIfCancellationRequested();
        string programFilesRoot = ResolveProgramFilesRoot();
        string revitVersion = ResolveExpectedRevitVersion(
            programFilesRoot,
            before.ImagePath);
        string expectedImagePath = BuildExpectedImagePath(
            programFilesRoot,
            revitVersion);
        if (!PathEquals(before.ImagePath, expectedImagePath))
        {
            throw Failure(
                "revit_process_image_path_untrusted",
                "The listener-owning process is not the expected Program Files Revit executable.");
        }

        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            _imageTrustVerifier.Verify(
                expectedImagePath,
                programFilesRoot);
            cancellationToken.ThrowIfCancellationRequested();
        }
        catch (AddinProcessAttestationException)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            throw Failure(
                "revit_process_image_trust_unavailable",
                "The Revit executable trust evidence could not be verified.",
                exception);
        }

        if (ResolveConnectionOwner(peer) != ownerProcessId)
        {
            throw Failure(
                "addin_listener_identity_changed",
                "The TCP listener owner changed during attestation.");
        }

        cancellationToken.ThrowIfCancellationRequested();
        WindowsProcessSnapshot after = Capture(ownerProcessId);
        cancellationToken.ThrowIfCancellationRequested();
        if (before.StartTimeFileTimeUtc != after.StartTimeFileTimeUtc ||
            !PathEquals(before.ImagePath, after.ImagePath))
        {
            throw Failure(
                "revit_process_identity_changed",
                "The listener-owning process identity changed during attestation.");
        }

        return new AddinProcessAttestation(
            new AddinProcessIdentity(
                ownerProcessId,
                after.StartTimeFileTimeUtc),
            revitVersion,
            after.ImagePath);
    }

    private void VerifyAfterResponse(
        AddinProcessAttestation attestation,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        WindowsProcessSnapshot after = Capture(
            attestation.Identity.ProcessId);
        cancellationToken.ThrowIfCancellationRequested();
        if (after.StartTimeFileTimeUtc !=
                attestation.Identity.StartTimeFileTimeUtc ||
            !PathEquals(after.ImagePath, attestation.ImagePath))
        {
            throw Failure(
                "revit_process_identity_changed",
                "The connected Revit process identity changed before its response was accepted.");
        }
    }

    private int ResolveConnectionOwner(AddinConnectedPeer peer)
    {
        try
        {
            return _connectionOwnerResolver.ResolveOwnerProcessId(peer);
        }
        catch (AddinProcessAttestationException)
        {
            throw;
        }
        catch (Exception exception)
        {
            throw Failure(
                "addin_connection_owner_unavailable",
                "The Windows connected TCP peer owner could not be resolved.",
                exception);
        }
    }

    private WindowsProcessSnapshot Capture(int processId)
    {
        WindowsProcessSnapshot snapshot;
        try
        {
            snapshot = _processSnapshotProvider.Capture(processId);
        }
        catch (AddinProcessAttestationException)
        {
            throw;
        }
        catch (Exception exception)
        {
            throw Failure(
                "revit_process_identity_unavailable",
                "The listener-owning process identity could not be read.",
                exception);
        }

        if (snapshot.ProcessId != processId ||
            snapshot.StartTimeFileTimeUtc <= 0 ||
            string.IsNullOrWhiteSpace(snapshot.ImagePath))
        {
            throw Failure(
                "revit_process_identity_invalid",
                "The listener-owning process returned incomplete identity evidence.");
        }

        return snapshot;
    }

    private string ResolveProgramFilesRoot()
    {
        try
        {
            string root = _programFilesPath();
            if (string.IsNullOrWhiteSpace(root) ||
                !Path.IsPathFullyQualified(root))
            {
                throw Failure(
                    "program_files_root_unavailable",
                    "The trusted Program Files root is unavailable.");
            }

            return Path.TrimEndingDirectorySeparator(
                Path.GetFullPath(root));
        }
        catch (AddinProcessAttestationException)
        {
            throw;
        }
        catch (Exception exception)
        {
            throw Failure(
                "program_files_root_unavailable",
                "The trusted Program Files root could not be resolved.",
                exception);
        }
    }

    private static string BuildExpectedImagePath(
        string programFilesRoot,
        string revitVersion)
    {
        try
        {
            return Path.GetFullPath(
                Path.Combine(
                    programFilesRoot,
                    "Autodesk",
                    "Revit " + revitVersion,
                    "Revit.exe"));
        }
        catch (Exception exception)
        {
            throw Failure(
                "revit_process_image_path_untrusted",
                "The expected Revit executable path could not be resolved.",
                exception);
        }
    }

    private static string ResolveExpectedRevitVersion(
        string programFilesRoot,
        string imagePath)
    {
        string canonicalImagePath;
        try
        {
            canonicalImagePath = Path.GetFullPath(imagePath);
        }
        catch (Exception exception)
        {
            throw Failure(
                "revit_process_image_path_untrusted",
                "The connected process image path could not be canonicalized.",
                exception);
        }

        string? revitDirectory =
            new FileInfo(canonicalImagePath).Directory?.Name;
        if (revitDirectory == null ||
            !revitDirectory.StartsWith(
                "Revit ",
                StringComparison.Ordinal) ||
            revitDirectory.Length != "Revit ".Length + 4)
        {
            throw Failure(
                "revit_process_image_path_untrusted",
                "The connected process is not installed in a versioned Revit directory.");
        }

        string revitVersion = revitDirectory.Substring("Revit ".Length);
        if (revitVersion.Any(character => character < '0' || character > '9') ||
            !PathEquals(
                canonicalImagePath,
                BuildExpectedImagePath(programFilesRoot, revitVersion)))
        {
            throw Failure(
                "revit_process_image_path_untrusted",
                "The connected process is not the expected Program Files Revit executable.");
        }

        return revitVersion;
    }

    private static async Task<T> RunSerializedAsync<T>(
        Func<T> work,
        CancellationToken cancellationToken)
    {
        await AttestationWorkerGate.WaitAsync(cancellationToken)
            .ConfigureAwait(false);
        Task<T>? worker = null;
        bool releaseSynchronously = false;
        try
        {
            worker = Task.Run(work, CancellationToken.None);
            T result = await worker.WaitAsync(cancellationToken)
                .ConfigureAwait(false);
            releaseSynchronously = true;
            return result;
        }
        finally
        {
            if (worker == null)
            {
                AttestationWorkerGate.Release();
            }
            else if (releaseSynchronously || worker.IsCompleted)
            {
                _ = ObserveFailure(worker);
                AttestationWorkerGate.Release();
            }
            else
            {
                _ = ReleaseWorkerWhenCompletedAsync(worker);
            }
        }
    }

    private static async Task ReleaseWorkerWhenCompletedAsync(Task worker)
    {
        try
        {
            await worker.ConfigureAwait(false);
        }
        catch
        {
            // The caller already failed closed at its deadline. The worker is
            // observed only so a late native failure cannot become unobserved.
        }
        finally
        {
            AttestationWorkerGate.Release();
        }
    }

    private static bool ObserveFailure(Task worker)
    {
        _ = worker.Exception;
        return true;
    }

    private static bool PathEquals(string left, string right)
    {
        try
        {
            return string.Equals(
                Path.GetFullPath(left),
                Path.GetFullPath(right),
                StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception exception) when (
            exception is ArgumentException ||
            exception is NotSupportedException ||
            exception is PathTooLongException)
        {
            return false;
        }
    }

    private static AddinProcessAttestationException Failure(
        string code,
        string message,
        Exception? innerException = null) =>
        new(code, message, innerException);
}
