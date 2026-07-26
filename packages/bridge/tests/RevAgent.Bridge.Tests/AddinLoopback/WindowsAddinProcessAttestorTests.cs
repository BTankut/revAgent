using System.Net;
using System.Net.Sockets;
using RevAgent.Bridge.AddinLoopback;

namespace RevAgent.Bridge.Tests.AddinLoopback;

public sealed class WindowsAddinProcessAttestorTests
{
    private const int ProcessId = 4242;
    private const long StartTimeFileTimeUtc = 133000000000004242;

    [Fact]
    public async Task AttestBeforeDispatch_BindsExactConnectionAndStartIdentity()
    {
        AddinConnectedPeer peer = ConnectedPeer();
        string trustedRoot = TrustedRoot();
        string imagePath = ExpectedImagePath(trustedRoot);
        var connectionOwner = new StubConnectionOwnerResolver(ProcessId);
        var processSnapshots = new QueueProcessSnapshotProvider(
            Snapshot(imagePath),
            Snapshot(imagePath),
            Snapshot(imagePath));
        var imageTrust = new RecordingImageTrustVerifier();
        var attestor = CreateAttestor(
            connectionOwner,
            processSnapshots,
            imageTrust,
            trustedRoot);

        AddinProcessAttestation result =
            await attestor.AttestBeforeDispatchAsync(peer, default);
        await attestor.VerifyAfterResponseAsync(peer, result, default);

        Assert.Equal(
            new AddinProcessIdentity(ProcessId, StartTimeFileTimeUtc),
            result.Identity);
        Assert.Equal("2026", result.RevitVersion);
        Assert.Equal(imagePath, result.ImagePath);
        Assert.Equal(peer, connectionOwner.Peer);
        Assert.Equal(2, connectionOwner.ResolveCount);
        Assert.Equal(3, processSnapshots.CaptureCount);
        Assert.Equal(imagePath, imageTrust.ImagePath);
        Assert.Equal(
            Path.TrimEndingDirectorySeparator(
                Path.GetFullPath(trustedRoot)),
            imageTrust.TrustedRoot);
    }

    [Fact]
    public async Task AttestBeforeDispatch_RejectsUnexpectedRevitExecutablePath()
    {
        string untrustedImagePath = Path.Combine(
            Path.GetTempPath(),
            "spoof",
            "Revit.exe");
        var processSnapshots = new QueueProcessSnapshotProvider(
            Snapshot(untrustedImagePath));
        var imageTrust = new RecordingImageTrustVerifier();
        var attestor = CreateAttestor(
            new StubConnectionOwnerResolver(ProcessId),
            processSnapshots,
            imageTrust,
            TrustedRoot());

        AddinProcessAttestationException error =
            await Assert.ThrowsAsync<AddinProcessAttestationException>(
                () => attestor.AttestBeforeDispatchAsync(
                    ConnectedPeer(),
                    default));

        Assert.Equal("revit_process_image_path_untrusted", error.Code);
        Assert.Single(processSnapshots.ProcessIds);
        Assert.Null(imageTrust.ImagePath);
    }

    [Fact]
    public async Task AttestBeforeDispatch_RejectsPidReuseDuringImageVerification()
    {
        string trustedRoot = TrustedRoot();
        string imagePath = ExpectedImagePath(trustedRoot);
        var processSnapshots = new QueueProcessSnapshotProvider(
            Snapshot(imagePath),
            new WindowsProcessSnapshot(
                ProcessId,
                StartTimeFileTimeUtc + 1,
                imagePath));
        var attestor = CreateAttestor(
            new StubConnectionOwnerResolver(ProcessId),
            processSnapshots,
            new RecordingImageTrustVerifier(),
            trustedRoot);

        AddinProcessAttestationException error =
            await Assert.ThrowsAsync<AddinProcessAttestationException>(
                () => attestor.AttestBeforeDispatchAsync(
                    ConnectedPeer(),
                    default));

        Assert.Equal("revit_process_identity_changed", error.Code);
        Assert.Equal(2, processSnapshots.CaptureCount);
    }

    [Fact]
    public async Task VerifyAfterResponse_RejectsPidReuseAfterDispatch()
    {
        string trustedRoot = TrustedRoot();
        string imagePath = ExpectedImagePath(trustedRoot);
        var processSnapshots = new QueueProcessSnapshotProvider(
            Snapshot(imagePath),
            Snapshot(imagePath),
            new WindowsProcessSnapshot(
                ProcessId,
                StartTimeFileTimeUtc + 1,
                imagePath));
        var attestor = CreateAttestor(
            new StubConnectionOwnerResolver(ProcessId),
            processSnapshots,
            new RecordingImageTrustVerifier(),
            trustedRoot);
        AddinConnectedPeer peer = ConnectedPeer();
        AddinProcessAttestation before =
            await attestor.AttestBeforeDispatchAsync(peer, default);

        AddinProcessAttestationException error =
            await Assert.ThrowsAsync<AddinProcessAttestationException>(
                () => attestor.VerifyAfterResponseAsync(
                    peer,
                    before,
                    default));

        Assert.Equal("revit_process_identity_changed", error.Code);
    }

    [Fact]
    public async Task AttestationDeadlineFailsClosedAndKeepsOneNativeWorker()
    {
        string trustedRoot = TrustedRoot();
        string imagePath = ExpectedImagePath(trustedRoot);
        using var release = new ManualResetEventSlim();
        var imageTrust = new BlockingImageTrustVerifier(release);
        var processSnapshots = new QueueProcessSnapshotProvider(
            Snapshot(imagePath),
            Snapshot(imagePath));
        var connectionOwner =
            new StubConnectionOwnerResolver(ProcessId);
        var attestor = CreateAttestor(
            connectionOwner,
            processSnapshots,
            imageTrust,
            trustedRoot);
        using var firstDeadline =
            new CancellationTokenSource(TimeSpan.FromMilliseconds(150));

        Task<AddinProcessAttestation> first =
            attestor.AttestBeforeDispatchAsync(
                ConnectedPeer(),
                firstDeadline.Token);
        Assert.True(
            imageTrust.Started.Wait(TimeSpan.FromSeconds(2)),
            "The serialized native worker did not start.");
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);

        using var secondDeadline =
            new CancellationTokenSource(TimeSpan.FromMilliseconds(150));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => attestor.AttestBeforeDispatchAsync(
                ConnectedPeer(),
                secondDeadline.Token));
        Assert.Equal(1, imageTrust.InvocationCount);

        release.Set();
        await Task.Delay(TimeSpan.FromMilliseconds(100));
        Assert.Equal(1, connectionOwner.ResolveCount);
        Assert.Equal(1, processSnapshots.CaptureCount);
    }

    [Fact]
    public async Task ExpectedAttestorAcceptsThePinnedProcessIdentity()
    {
        string imagePath = ExpectedImagePath(TrustedRoot());
        var expected = new AddinProcessAttestation(
            new AddinProcessIdentity(
                ProcessId,
                StartTimeFileTimeUtc),
            "2026",
            imagePath);
        var inner = new StubProcessAttestor(expected);
        var attestor = new ExpectedAddinProcessAttestor(
            inner,
            expected);

        AddinProcessAttestation actual =
            await attestor.AttestBeforeDispatchAsync(
                ConnectedPeer(),
                default);
        await attestor.VerifyAfterResponseAsync(
            ConnectedPeer(),
            actual,
            default);

        Assert.Same(expected, actual);
        Assert.Equal(1, inner.AttestCount);
        Assert.Equal(1, inner.VerifyCount);
    }

    [Theory]
    [InlineData(ProcessId + 1, StartTimeFileTimeUtc)]
    [InlineData(ProcessId, StartTimeFileTimeUtc + 1)]
    public async Task ExpectedAttestorRejectsProcessTakeoverBeforeDispatch(
        int actualProcessId,
        long actualStartTimeFileTimeUtc)
    {
        string imagePath = ExpectedImagePath(TrustedRoot());
        var expected = new AddinProcessAttestation(
            new AddinProcessIdentity(
                ProcessId,
                StartTimeFileTimeUtc),
            "2026",
            imagePath);
        var actual = expected with
        {
            Identity = new AddinProcessIdentity(
                actualProcessId,
                actualStartTimeFileTimeUtc),
        };
        var inner = new StubProcessAttestor(actual);
        var attestor = new ExpectedAddinProcessAttestor(
            inner,
            expected);

        AddinProcessAttestationException error =
            await Assert.ThrowsAsync<AddinProcessAttestationException>(
                () => attestor.AttestBeforeDispatchAsync(
                    ConnectedPeer(),
                    default));

        Assert.Equal("addin_process_identity_mismatch", error.Code);
        Assert.Equal(1, inner.AttestCount);
        Assert.Equal(0, inner.VerifyCount);
    }

    [Fact]
    public async Task AttestBeforeDispatch_RejectsWhenWindowsEvidenceIsUnavailable()
    {
        var connectionOwner = new StubConnectionOwnerResolver(ProcessId);
        var processSnapshots = new QueueProcessSnapshotProvider();
        var imageTrust = new RecordingImageTrustVerifier();
        var attestor = new WindowsAddinProcessAttestor(
            connectionOwner,
            processSnapshots,
            imageTrust,
            TrustedRoot,
            () => false);

        AddinProcessAttestationException error =
            await Assert.ThrowsAsync<AddinProcessAttestationException>(
                () => attestor.AttestBeforeDispatchAsync(
                    ConnectedPeer(),
                    default));

        Assert.Equal("addin_process_attestation_unavailable", error.Code);
        Assert.Null(connectionOwner.Peer);
        Assert.Equal(0, processSnapshots.CaptureCount);
        Assert.Null(imageTrust.ImagePath);
    }

    [Fact]
    public async Task ConnectionOwnerResolver_UsesExactWindowsTcpTuple()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            var serverPort =
                ((IPEndPoint)listener.LocalEndpoint).Port;
            using var client = new TcpClient(AddressFamily.InterNetwork);
            Task<TcpClient> accept = listener.AcceptTcpClientAsync();
            await client.ConnectAsync(IPAddress.Loopback, serverPort);
            using TcpClient server = await accept;
            AddinConnectedPeer peer =
                AddinConnectedPeer.FromConnectedClient(client);

            int ownerProcessId =
                new WindowsTcpConnectionOwnerResolver()
                    .ResolveOwnerProcessId(peer);

            Assert.Equal(Environment.ProcessId, ownerProcessId);
        }
        finally
        {
            listener.Stop();
        }
    }

    [Fact]
    public async Task ConnectionOwnerResolver_RejectsSameListenerWithWrongClientTuple()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            var serverPort =
                ((IPEndPoint)listener.LocalEndpoint).Port;
            using var client = new TcpClient(AddressFamily.InterNetwork);
            Task<TcpClient> accept = listener.AcceptTcpClientAsync();
            await client.ConnectAsync(IPAddress.Loopback, serverPort);
            using TcpClient server = await accept;
            AddinConnectedPeer actual =
                AddinConnectedPeer.FromConnectedClient(client);
            var wrongTuple = actual with
            {
                ClientEndPoint = new IPEndPoint(
                    actual.ClientEndPoint.Address,
                    actual.ClientEndPoint.Port == 65535
                        ? actual.ClientEndPoint.Port - 1
                        : actual.ClientEndPoint.Port + 1),
            };

            AddinProcessAttestationException error =
                Assert.Throws<AddinProcessAttestationException>(
                    () => new WindowsTcpConnectionOwnerResolver()
                        .ResolveOwnerProcessId(wrongTuple));

            Assert.Equal("addin_listener_owner_not_found", error.Code);
        }
        finally
        {
            listener.Stop();
        }
    }

    [Fact]
    public void ProcessSnapshotProvider_UsesLiveWindowsProcessIdentity()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        WindowsProcessSnapshot snapshot =
            new WindowsProcessSnapshotProvider().Capture(
                Environment.ProcessId);

        Assert.Equal(Environment.ProcessId, snapshot.ProcessId);
        Assert.True(snapshot.StartTimeFileTimeUtc > 0);
        Assert.True(File.Exists(snapshot.ImagePath));
    }

    private static WindowsAddinProcessAttestor CreateAttestor(
        IWindowsTcpConnectionOwnerResolver connectionOwner,
        IWindowsProcessSnapshotProvider processSnapshots,
        IWindowsRevitImageTrustVerifier imageTrust,
        string trustedRoot) =>
        new(
            connectionOwner,
            processSnapshots,
            imageTrust,
            () => trustedRoot,
            () => true);

    private static AddinConnectedPeer ConnectedPeer() =>
        new(
            new IPEndPoint(IPAddress.Loopback, 50001),
            new IPEndPoint(IPAddress.Loopback, 8181));

    private static WindowsProcessSnapshot Snapshot(string imagePath) =>
        new(ProcessId, StartTimeFileTimeUtc, imagePath);

    private static string TrustedRoot() =>
        Path.GetFullPath(
            Path.Combine(
                Path.GetTempPath(),
                "revagent-tests",
                "program-files"));

    private static string ExpectedImagePath(string trustedRoot) =>
        Path.GetFullPath(
            Path.Combine(
                trustedRoot,
                "Autodesk",
                "Revit 2026",
                "Revit.exe"));

    private sealed class StubConnectionOwnerResolver
        : IWindowsTcpConnectionOwnerResolver
    {
        private readonly int _processId;

        internal StubConnectionOwnerResolver(int processId)
        {
            _processId = processId;
        }

        internal AddinConnectedPeer? Peer { get; private set; }

        internal int ResolveCount { get; private set; }

        public int ResolveOwnerProcessId(AddinConnectedPeer peer)
        {
            ResolveCount++;
            Peer = peer;
            return _processId;
        }
    }

    private sealed class QueueProcessSnapshotProvider
        : IWindowsProcessSnapshotProvider
    {
        private readonly Queue<WindowsProcessSnapshot> _snapshots;

        internal QueueProcessSnapshotProvider(
            params WindowsProcessSnapshot[] snapshots)
        {
            _snapshots = new Queue<WindowsProcessSnapshot>(snapshots);
        }

        internal List<int> ProcessIds { get; } = new();

        internal int CaptureCount => ProcessIds.Count;

        public WindowsProcessSnapshot Capture(int processId)
        {
            ProcessIds.Add(processId);
            return _snapshots.Dequeue();
        }
    }

    private sealed class RecordingImageTrustVerifier
        : IWindowsRevitImageTrustVerifier
    {
        internal string? ImagePath { get; private set; }

        internal string? TrustedRoot { get; private set; }

        public void Verify(
            string imagePath,
            string trustedProgramFilesRoot)
        {
            ImagePath = imagePath;
            TrustedRoot = trustedProgramFilesRoot;
        }
    }

    private sealed class BlockingImageTrustVerifier
        : IWindowsRevitImageTrustVerifier
    {
        private readonly ManualResetEventSlim _release;
        private int _invocationCount;

        internal BlockingImageTrustVerifier(ManualResetEventSlim release)
        {
            _release = release;
        }

        internal ManualResetEventSlim Started { get; } = new();

        internal int InvocationCount =>
            Volatile.Read(ref _invocationCount);

        public void Verify(
            string imagePath,
            string trustedProgramFilesRoot)
        {
            Interlocked.Increment(ref _invocationCount);
            Started.Set();
            _release.Wait();
        }
    }

    private sealed class StubProcessAttestor : IAddinProcessAttestor
    {
        private readonly AddinProcessAttestation _attestation;

        internal StubProcessAttestor(
            AddinProcessAttestation attestation)
        {
            _attestation = attestation;
        }

        internal int AttestCount { get; private set; }

        internal int VerifyCount { get; private set; }

        public Task<AddinProcessAttestation> AttestBeforeDispatchAsync(
            AddinConnectedPeer peer,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AttestCount++;
            return Task.FromResult(_attestation);
        }

        public Task VerifyAfterResponseAsync(
            AddinConnectedPeer peer,
            AddinProcessAttestation attestation,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            VerifyCount++;
            return Task.CompletedTask;
        }
    }
}
