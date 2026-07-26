using System.ComponentModel;
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
    public Task TerminationTimeoutPoisonsProcessAndPreventsSecondStart() =>
        AssertTerminationFailurePoisonsProcessAsync(
            new TimeoutException(
                "Injected helper termination timeout."));

    [Fact]
    public Task TerminationWin32FailurePoisonsProcessAndPreventsSecondStart() =>
        AssertTerminationFailurePoisonsProcessAsync(
            new Win32Exception(
                error: 5,
                "Injected helper termination failure."));

    [Fact]
    public async Task UnobservedLiveHelperPoisonsProcessAndPreventsSecondStart()
    {
        var health = new AttestationHelperProcessHealth();
        var live = new UnobservedLiveHelperProcess(processId: 504);
        var unusedRecovery = new RespondingHelperProcess(
            processId: 505,
            request => Success(request));
        var launcher = new QueueHelperProcessLauncher(
            live,
            unusedRecovery);
        var attestor = new ProcessWindowsAddinProcessAttestor(
            new FixedExecutableResolver(),
            launcher,
            () => Nonce,
            health,
            TimeSpan.FromMilliseconds(25));
        using var deadline =
            new CancellationTokenSource(TimeSpan.FromMilliseconds(100));

        AddinProcessAttestationException failure =
            await Assert.ThrowsAsync<AddinProcessAttestationException>(
                () => attestor.AttestBeforeDispatchAsync(
                    Peer(),
                    deadline.Token));

        Assert.Equal(
            "addin_process_attestation_helper_restart_required",
            failure.Code);
        Assert.True(health.IsPoisoned);
        Assert.Equal(1, launcher.StartCount);
        Assert.Equal(1, live.KillCount);

        await Assert.ThrowsAsync<AddinProcessAttestationException>(
            () => attestor.AttestBeforeDispatchAsync(
                Peer(),
                default));
        Assert.Equal(1, launcher.StartCount);
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
    public void ProtocolRoundTripPreservesAsymmetricEndpointRoles()
    {
        AddinConnectedPeer expected = Peer();
        AttestationHelperRequest request =
            AttestationHelperProtocol.CreateAttestRequest(
                Nonce,
                expected);

        AddinConnectedPeer actual =
            AttestationHelperProtocol.ToPeer(
                AttestationHelperProtocol.ParseRequest(
                    AttestationHelperProtocol.SerializeRequest(request)));

        Assert.Equal(expected, actual);
        Assert.Equal(50001, actual.ClientEndPoint.Port);
        Assert.Equal(8181, actual.ServerEndPoint.Port);
    }

    [Fact]
    public async Task HelperServerPassesCorrectEndpointRolesToAttestor()
    {
        AddinConnectedPeer expected = Peer();
        AttestationHelperRequest request =
            AttestationHelperProtocol.CreateAttestRequest(
                Nonce,
                expected);
        await using var input = new MemoryStream(
            AttestationHelperProtocol.SerializeRequest(request));
        await using var output = new MemoryStream();
        var attestor = new CapturingAddinProcessAttestor();

        int exitCode = await WindowsAttestationHelperServer.RunAsync(
            input,
            output,
            () => attestor);

        Assert.Equal(0, exitCode);
        Assert.Equal(expected, attestor.BeforeDispatchPeer);
        AttestationHelperResponse response =
            AttestationHelperProtocol.ParseResponse(output.ToArray());
        AttestationHelperProtocol.VerifyNonce(Nonce, response.Nonce);
        Assert.Equal(
            ExpectedAttestation(),
            AttestationHelperProtocol.RequireAttestation(response));
    }

    [Fact]
    public async Task ExecutablePinRemainsHeldThroughHelperLaunch()
    {
        var pathPin = new RecordingDisposable();
        var helper = new RespondingHelperProcess(
            processId: 410,
            request => Success(request));
        var innerLauncher =
            new QueueHelperProcessLauncher(helper);
        var launcher = new PinObservingLauncher(
            innerLauncher,
            pathPin);
        var attestor = new ProcessWindowsAddinProcessAttestor(
            new FixedExecutableResolver(pathPin),
            launcher,
            () => Nonce);

        _ = await attestor.AttestBeforeDispatchAsync(
            Peer(),
            default);

        Assert.True(launcher.PinWasHeldAtStart);
        Assert.True(pathPin.Disposed);
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

    private static async Task
        AssertTerminationFailurePoisonsProcessAsync(
            Exception terminationFailure)
    {
        var health = new AttestationHelperProcessHealth();
        var blocked = new TerminationFailureHelperProcess(
            processId: 501,
            terminationFailure);
        var unusedRecovery = new RespondingHelperProcess(
            processId: 502,
            request => Success(request));
        var launcher = new QueueHelperProcessLauncher(
            blocked,
            unusedRecovery);
        var attestor = new ProcessWindowsAddinProcessAttestor(
            new FixedExecutableResolver(),
            launcher,
            () => Nonce,
            health);
        using var deadline =
            new CancellationTokenSource(TimeSpan.FromMilliseconds(100));

        AddinProcessAttestationException failure =
            await Assert.ThrowsAsync<AddinProcessAttestationException>(
                () => attestor.AttestBeforeDispatchAsync(
                    Peer(),
                    deadline.Token));

        Assert.Equal(
            "addin_process_attestation_helper_restart_required",
            failure.Code);
        Assert.InRange(failure.Message.Length, 1, 512);
        AggregateException aggregate =
            Assert.IsType<AggregateException>(
                failure.InnerException);
        Assert.Contains(
            aggregate.InnerExceptions,
            exception => exception is OperationCanceledException);
        Assert.Contains(
            aggregate.InnerExceptions,
            exception =>
                exception.GetType() == terminationFailure.GetType());
        Assert.True(health.IsPoisoned);
        Assert.Equal(1, launcher.StartCount);
        Assert.Equal(1, blocked.KillCount);

        AddinProcessAttestationException poisoned =
            await Assert.ThrowsAsync<AddinProcessAttestationException>(
                () => attestor.AttestBeforeDispatchAsync(
                    Peer(),
                    default));
        Assert.Equal(
            "addin_process_attestation_helper_restart_required",
            poisoned.Code);
        Assert.Equal(1, launcher.StartCount);

        var sameProcessLauncher = new QueueHelperProcessLauncher(
            new RespondingHelperProcess(
                processId: 503,
                request => Success(request)));
        var sameProcessAttestor =
            new ProcessWindowsAddinProcessAttestor(
                new FixedExecutableResolver(),
                sameProcessLauncher,
                () => Nonce,
                health);
        AddinProcessAttestationException sameProcessPoisoned =
            await Assert.ThrowsAsync<AddinProcessAttestationException>(
                () => sameProcessAttestor.AttestBeforeDispatchAsync(
                    Peer(),
                    default));
        Assert.Equal(
            "addin_process_attestation_helper_restart_required",
            sameProcessPoisoned.Code);
        Assert.Equal(0, sameProcessLauncher.StartCount);

        var freshLauncher = new QueueHelperProcessLauncher(
            new RespondingHelperProcess(
                processId: 504,
                request => Success(request)));
        var freshWorkerAttestor =
            new ProcessWindowsAddinProcessAttestor(
                new FixedExecutableResolver(),
                freshLauncher,
                () => Nonce,
                new AttestationHelperProcessHealth());
        AddinProcessAttestation recovered =
            await freshWorkerAttestor.AttestBeforeDispatchAsync(
                Peer(),
                default);
        Assert.Equal(4242, recovered.Identity.ProcessId);
        Assert.Equal(1, freshLauncher.StartCount);
    }

    private static AddinConnectedPeer Peer() =>
        new(
            new IPEndPoint(IPAddress.Loopback, 50001),
            new IPEndPoint(IPAddress.Loopback, 8181));

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
        private readonly IDisposable _pathPin;

        internal FixedExecutableResolver(
            IDisposable? pathPin = null)
        {
            _pathPin = pathPin ?? new NoOpDisposable();
        }

        public ResolvedAttestationHelperExecutable Resolve() =>
            new(
                @"C:\Program Files\revAgent\Bridge\versions\v1\revagent-bridge.exe",
                @"C:\Program Files\revAgent\Bridge\versions\v1",
                new WindowsFileIdentity(VolumeSerialNumber: 7, FileIndex: 11),
                @"C:\Program Files\revAgent\Bridge\versions\v1\revagent-bridge.exe",
                _pathPin);
    }

    private sealed class CapturingAddinProcessAttestor
        : IAddinProcessAttestor
    {
        internal AddinConnectedPeer? BeforeDispatchPeer { get; private set; }

        public Task<AddinProcessAttestation> AttestBeforeDispatchAsync(
            AddinConnectedPeer peer,
            CancellationToken cancellationToken)
        {
            BeforeDispatchPeer = peer;
            return Task.FromResult(ExpectedAttestation());
        }

        public Task VerifyAfterResponseAsync(
            AddinConnectedPeer peer,
            AddinProcessAttestation attestation,
            CancellationToken cancellationToken) =>
            Task.CompletedTask;
    }

    private sealed class NoOpDisposable : IDisposable
    {
        public void Dispose()
        {
        }
    }

    private sealed class RecordingDisposable : IDisposable
    {
        internal bool Disposed { get; private set; }

        public void Dispose()
        {
            Disposed = true;
        }
    }

    private sealed class PinObservingLauncher
        : IAttestationHelperProcessLauncher
    {
        private readonly IAttestationHelperProcessLauncher _inner;
        private readonly RecordingDisposable _pathPin;

        internal PinObservingLauncher(
            IAttestationHelperProcessLauncher inner,
            RecordingDisposable pathPin)
        {
            _inner = inner;
            _pathPin = pathPin;
        }

        internal bool PinWasHeldAtStart { get; private set; }

        public IAttestationHelperProcess Start(
            ResolvedAttestationHelperExecutable executable)
        {
            PinWasHeldAtStart = !_pathPin.Disposed;
            return _inner.Start(executable);
        }
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

        public virtual Task TerminateAsync()
        {
            RecordTermination();
            OnKilled();
            return Task.CompletedTask;
        }

        public void Dispose()
        {
            Disposed = true;
        }

        protected virtual void OnKilled()
        {
        }

        protected void RecordTermination()
        {
            KillCount++;
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

    private sealed class TerminationFailureHelperProcess
        : FakeHelperProcess
    {
        private readonly Exception _terminationFailure;
        private readonly TaskCompletionSource<AttestationHelperProcessResult>
            _exchange =
                new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal TerminationFailureHelperProcess(
            int processId,
            Exception terminationFailure)
            : base(processId)
        {
            _terminationFailure = terminationFailure;
        }

        public override Task<AttestationHelperProcessResult> ExchangeAsync(
            byte[] request,
            int maxOutputBytes) =>
            _exchange.Task;

        public override Task TerminateAsync()
        {
            RecordTermination();
            return Task.FromException(_terminationFailure);
        }
    }

    private sealed class UnobservedLiveHelperProcess
        : FakeHelperProcess
    {
        private readonly TaskCompletionSource<AttestationHelperProcessResult>
            _exchange =
                new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal UnobservedLiveHelperProcess(int processId)
            : base(processId)
        {
        }

        public override Task<AttestationHelperProcessResult> ExchangeAsync(
            byte[] request,
            int maxOutputBytes) =>
            _exchange.Task;
    }
}
