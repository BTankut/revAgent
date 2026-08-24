using System.Security.Cryptography;
using System.Text;

namespace RevAgent.Bridge.Gateway.Connection;

/// <summary>
/// Value-free, best-effort observation seam for the C39 recovery carrier.
/// The production instance is deliberately a sealed no-op: it has no
/// configuration, environment, transport, or persistence surface.
/// </summary>
internal interface IRbpRecoveryCarrierObservationSink
{
    void Observe(RbpRecoveryCarrierObservation observation);
}

internal enum RbpRecoveryCarrierObservationPhase
{
    Materialized,
    Write,
    RestartResend,
    Acknowledged,
}

internal sealed record RbpRecoveryCarrierObservation(
    RbpRecoveryCarrierObservationPhase Phase,
    string HashedRecoveryId,
    long Sequence,
    string OuterDigest,
    long Ordinal)
{
    internal const string ContractVersion =
        "revagent.wp12-recovery-carrier-observation/v1";

    internal static string HashRecoveryId(string recoveryInvocationId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(recoveryInvocationId);
        byte[] prefix = Encoding.UTF8.GetBytes(
            "revagent/c39-carrier-observation/v1\0");
        byte[] identifier = Encoding.UTF8.GetBytes(recoveryInvocationId);
        byte[] input = new byte[checked(prefix.Length + identifier.Length)];
        Buffer.BlockCopy(prefix, 0, input, 0, prefix.Length);
        Buffer.BlockCopy(identifier, 0, input, prefix.Length, identifier.Length);
        return "sha256:" + Convert.ToHexString(SHA256.HashData(input))
            .ToLowerInvariant();
    }

    internal static string PhaseLabel(RbpRecoveryCarrierObservationPhase phase) =>
        phase switch
        {
            RbpRecoveryCarrierObservationPhase.Materialized => "materialized",
            RbpRecoveryCarrierObservationPhase.Write => "write",
            RbpRecoveryCarrierObservationPhase.RestartResend => "restart_resend",
            RbpRecoveryCarrierObservationPhase.Acknowledged => "ack",
            _ => throw new ArgumentOutOfRangeException(nameof(phase)),
        };
}

/// <summary>
/// Production's closed observation boundary.  All diagnostic retention is
/// opt-in from the real worker test host through an internal injected sink.
/// </summary>
internal sealed class RbpRecoveryCarrierObservationSink :
    IRbpRecoveryCarrierObservationSink
{
    internal static RbpRecoveryCarrierObservationSink None { get; } = new();

    private RbpRecoveryCarrierObservationSink()
    {
    }

    public void Observe(RbpRecoveryCarrierObservation observation)
    {
        // Deliberately no-op. Observation failure must never affect a send.
    }
}
