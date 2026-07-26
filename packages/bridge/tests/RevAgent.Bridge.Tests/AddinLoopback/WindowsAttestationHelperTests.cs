using System.Net;
using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;

namespace RevAgent.Bridge.Tests.AddinLoopback;

public sealed class WindowsAttestationHelperTests
{
    private const string Nonce =
        "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

    [Fact]
    public async Task DeadlineKillsHelperAndNextRequestUsesFreshProcess()
    {
        var blocked = new BlockingHelperProcess(processId: 101);
        var recovered = new RespondingHelperProcess(
            processId: 102,
            request => Success(request));
        var launcher = new QueueHelperProcessLauncher(
            blocked,
            recovered);
        var attestor = CreateAttestor(launcher);
        using var deadline =
            new CancellationTokenSource(TimeSpan.FromMilliseconds(100));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => attestor.AttestBeforeDispatchAsync(
                Peer(),
                deadline.Token));

        Assert.Equal(1, blocked.KillCount);
        Assert.True(blocked.Disposed);
        AddinProcessAttestation attestation =
            await attestor.AttestBeforeDispatchAsync(
                Peer(),
                default);

        Assert.Equal(4242, attestation.Identity.ProcessId);
        Assert.Equal(2, launcher.StartCount);
        Assert.Equal(0, recovered.KillCount);
        Assert.True(recovered.Disposed);
        Assert.Equal([101, 102], launcher.StartedProcessIds);
    }

    [Fact]
    public async Task ResponseNonceMismatchFailsClosed()
    {
        var helper = new RespondingHelperProcess(
            processId: 201,
            request => Success(
                request with
                {
                    Nonce =
                        "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
                }));
        var attestor = CreateAttestor(
            new QueueHelperProcessLauncher(helper));

        AddinProcessAttestationException error =
            await Assert.ThrowsAsync<AddinProcessAttestationException>(
                () => attestor.AttestBeforeDispatchAsync(
                    Peer(),
                    default));

        Assert.Equal(
            "addin_process_attestation_helper_unavailable",
            error.Code);
        Assert.Equal(1, helper.KillCount);
    }

    [Fact]
    public async Task TruncatedHelperOutputFailsClosed()
    {
        var helper = new RespondingHelperProcess(
            processId: 301,
            request => Success(request),
            truncateOutput: true);
        var attestor = CreateAttestor(
            new QueueHelperProcessLauncher(helper));

        AddinProcessAttestationException error =
            await Assert.ThrowsAsync<AddinProcessAttestationException>(
                () => attestor.AttestBeforeDispatchAsync(
                    Peer(),
                    default));

        Assert.Equal(
            "addin_process_attestation_response_unbounded",
            error.Code);
        Assert.Equal(1, helper.KillCount);
    }

    [Fact]
    public async Task StructuredHelperFailurePreservesBoundedError()
    {
        var helper = new RespondingHelperProcess(
            processId: 401,
            request =>
                AttestationHelperProtocol.SerializeResponse(
                    AttestationHelperProtocol.Failure(
                        request,
                        "revit_process_identity_changed",
                        "The process identity changed.")));
        var attestor = CreateAttestor(
            new QueueHelperProcessLauncher(helper));

        AddinProcessAttestationException error =
            await Assert.ThrowsAsync<AddinProcessAttestationException>(
                () => attestor.VerifyAfterResponseAsync(
                    Peer(),
                    ExpectedAttestation(),
                    default));

        Assert.Equal("revit_process_identity_changed", error.Code);
    }

    [Fact]
    public void ProtocolRejectsNonLoopbackPeer()
    {
        var peer = new AddinConnectedPeer(
            new IPEndPoint(IPAddress.Parse("192.0.2.10"), 8181),
            new IPEndPoint(IPAddress.Loopback, 50001));

        Assert.Throws<InvalidDataException>(
            () => AttestationHelperProtocol.CreateAttestRequest(
                Nonce,
                peer));
    }

    [Fact]
    public void ProtocolRejectsUnknownFields()
    {
        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(
            """
            {
              "protocol_version": 1,
              "nonce": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
              "operation": "attest_before_dispatch",
              "server_address": "127.0.0.1",
              "server_port": 8181,
              "client_address": "127.0.0.1",
              "client_port": 50001,
              "expected_attestation": null,
              "unexpected": true
            }
            """);

        Assert.ThrowsAny<JsonException>(
            () => AttestationHelperProtocol.ParseRequest(bytes));
    }

    private static ProcessWindowsAddinProcessAttestor CreateAttestor(
        IAttestationHelperProcessLauncher launcher) =>
        new(
            new FixedExecutableResolver(),
            launcher,
            () => Nonce);

    private static AddinConnectedPeer Peer() =>
        new(
            new IPEndPoint(IPAddress.Loopback, 8181),
            new IPEndPoint(IPAddress.Loopback, 50001));

    private static AddinProcessAttestation ExpectedAttestation() =>
        new(
            new AddinProcessIdentity(
                ProcessId: 4242,
                StartTimeFileTimeUtc: 133000000000004242),
            "2026",
            @"C:\Program Files\Autodesk\Revit 2026\Revit.exe");

    private static byte[] Success(
        AttestationHelperRequest request) =>
        AttestationHelperProtocol.SerializeResponse(
            AttestationHelperProtocol.Success(
                request,
                ExpectedAttestation()));

    private sealed class FixedExecutableResolver
        : IAttestationHelperExecutableResolver
    {
        public ResolvedAttestationHelperExecutable Resolve() =>
            new(
                @"C:\Program Files\revAgent\Bridge\versions\v1\revagent-bridge.exe",
                @"C:\Program Files\revAgent\Bridge\versions\v1");
    }

    private sealed class QueueHelperProcessLauncher
        : IAttestationHelperProcessLauncher
    {
        private readonly Queue<IAttestationHelperProcess> _processes;

        internal QueueHelperProcessLauncher(
            params IAttestationHelperProcess[] processes)
        {
            _processes =
                new Queue<IAttestationHelperProcess>(processes);
        }

        internal int StartCount { get; private set; }

        internal List<int> StartedProcessIds { get; } = new();

        public IAttestationHelperProcess Start(
            ResolvedAttestationHelperExecutable executable)
        {
            StartCount++;
            IAttestationHelperProcess process = _processes.Dequeue();
            StartedProcessIds.Add(process.Id);
            return process;
        }
    }

    private abstract class FakeHelperProcess
        : IAttestationHelperProcess
    {
        protected FakeHelperProcess(int processId)
        {
            Id = processId;
        }

        public int Id { get; }

        internal int KillCount { get; private set; }

        internal bool Disposed { get; private set; }

        public abstract Task<AttestationHelperProcessResult> ExchangeAsync(
            byte[] request,
            int maxOutputBytes);

        public void KillTree()
        {
            KillCount++;
            OnKilled();
        }

        public void Dispose()
        {
            Disposed = true;
        }

        protected virtual void OnKilled()
        {
        }
    }

    private sealed class BlockingHelperProcess : FakeHelperProcess
    {
        private readonly TaskCompletionSource<AttestationHelperProcessResult>
            _completion =
                new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal BlockingHelperProcess(int processId)
            : base(processId)
        {
        }

        public override Task<AttestationHelperProcessResult> ExchangeAsync(
            byte[] request,
            int maxOutputBytes) =>
            _completion.Task;

        protected override void OnKilled()
        {
            _completion.TrySetException(
                new IOException("The helper was terminated."));
        }
    }

    private sealed class RespondingHelperProcess : FakeHelperProcess
    {
        private readonly Func<AttestationHelperRequest, byte[]> _response;
        private readonly bool _truncateOutput;

        internal RespondingHelperProcess(
            int processId,
            Func<AttestationHelperRequest, byte[]> response,
            bool truncateOutput = false)
            : base(processId)
        {
            _response = response;
            _truncateOutput = truncateOutput;
        }

        public override Task<AttestationHelperProcessResult> ExchangeAsync(
            byte[] request,
            int maxOutputBytes)
        {
            AttestationHelperRequest parsed =
                AttestationHelperProtocol.ParseRequest(request);
            return Task.FromResult(
                new AttestationHelperProcessResult(
                    ExitCode: 0,
                    _response(parsed),
                    StandardError: Array.Empty<byte>(),
                    StandardOutputTruncated: _truncateOutput,
                    StandardErrorTruncated: false));
        }
    }
}
