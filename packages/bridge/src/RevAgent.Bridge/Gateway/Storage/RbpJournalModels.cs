using System.Text.Json;
using RevAgent.Bridge.Gateway.Protocol;

namespace RevAgent.Bridge.Gateway.Storage;

internal sealed record RbpSessionRegistration(
    string Rsid,
    string LocalSessionKey,
    JsonElement RegistrationPayload,
    string ResumeToken,
    DateTimeOffset ResumeExpiresAt,
    IReadOnlyList<string> GrantedCapabilities)
{
    public override string ToString() =>
        $"RbpSessionRegistration {{ Rsid = {Rsid}, " +
        $"LocalSessionKey = {LocalSessionKey}, " +
        $"ResumeToken = [redacted], " +
        $"ResumeExpiresAt = {ResumeExpiresAt:O}, " +
        $"GrantedCapabilities = {GrantedCapabilities.Count} }}";
}

internal sealed record RbpStoredSession(
    string Rsid,
    string LocalSessionKey,
    JsonElement RegistrationPayload,
    string RegistrationDigest,
    RbpSecretString ResumeToken,
    DateTimeOffset ResumeExpiresAt,
    IReadOnlyList<string> GrantedCapabilities,
    long CreatedAtMilliseconds,
    long UpdatedAtMilliseconds);

internal enum RbpUnregisterPhase
{
    Pending,
    Confirmed,
}

internal sealed record RbpUnregisterTombstone(
    string Rsid,
    RbpSessionUnregisterReason Reason,
    RbpUnregisterPhase Phase,
    long CreatedAtMilliseconds,
    long UpdatedAtMilliseconds);

internal sealed record RbpResumeCandidate(
    RbpStoredSession Session,
    long LastJournaledReceivedSequence,
    IReadOnlyList<RbpDataEnvelopeSnapshot> Outbox);

internal sealed record RbpPendingInboundHandoff(
    string Rsid,
    RbpDataEnvelopeSnapshot Envelope,
    long AcceptedAtMilliseconds);

internal sealed record RbpReceiveFrontier(
    long LastAcceptedSequence,
    long LastJournaledSequence);

internal sealed record RbpExpiredSession(
    string Rsid,
    string LocalSessionKey,
    DateTimeOffset ResumeExpiresAt);

internal sealed record RbpJournalRecoveryPlan(
    IReadOnlyList<RbpUnregisterTombstone> ConfirmedCleanup,
    IReadOnlyList<RbpUnregisterTombstone> PendingUnregister,
    IReadOnlyList<RbpPendingInboundHandoff> PendingInboundHandoffs,
    IReadOnlyList<RbpResumeCandidate> ResumeCandidates,
    IReadOnlyList<RbpExpiredSession> ExpiredSessions);

internal sealed record RbpResumeAcknowledgementResult(
    RbpAcknowledgementResult Acknowledgement,
    RbpStoredSession Session,
    IReadOnlyList<RbpDataEnvelopeSnapshot> Retransmit);

internal sealed record RbpSessionAcknowledgement(
    string Rsid,
    long Sequence);

internal sealed record RbpHeartbeatFence(
    long ConnectionGeneration,
    IReadOnlyList<string> ExpectedActiveRsids,
    IReadOnlyList<RbpSessionAcknowledgement> Acknowledgements,
    IReadOnlyList<string> ConfirmUnregisterRsids);

internal sealed record RbpHeartbeatFenceResult(
    IReadOnlyList<string> AcknowledgedRsids,
    IReadOnlyList<string> ConfirmedUnregisterRsids);

internal sealed record RbpJournalDurabilityProfile(
    string JournalMode,
    int Synchronous,
    bool ForeignKeys,
    bool TrustedSchema,
    bool SecureDelete,
    int BusyTimeoutMilliseconds,
    int WalAutoCheckpointPages);

internal sealed record RbpJournalMigration(
    int Version,
    string Owner,
    string Name,
    string Sql);

internal enum RbpJournalFaultPoint
{
    BeforeCommit,
    AfterCommitBeforeReturn,
    RecoveryValidatedRaw,
    RecoveryPlanInserted,
    RecoverySequenceReserved,
    RecoverySendStarted,
    RecoveryEqualAcknowledgement,
    RecoveryTombstoneRawDeleted,
    RecoveryMinimalTombstonePersisted,
    RecoveryDetailedAuditPruned,
}

internal interface IRbpJournalFaultInjector
{
    void Hit(RbpJournalFaultPoint point);
}

internal sealed record RbpJournalOpenOptions(
    int BusyTimeoutMilliseconds = 5_000,
    Func<long>? NowMilliseconds = null,
    IRbpJournalFaultInjector? FaultInjector = null,
    IReadOnlyList<RbpJournalMigration>? AdditionalMigrations = null);
