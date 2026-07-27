namespace RevAgent.Bridge.Gateway.Storage;

internal enum RbpJournalErrorCode
{
    WriterLeaseUnavailable,
    IntegrityCheckFailed,
    UnsupportedSchema,
    MigrationMismatch,
    InvalidDurabilityProfile,
    SessionNotFound,
    SessionConflict,
    ProtocolConflict,
    SecretProtectionFailed,
    InvalidHeartbeatFence,
    CleanupIncomplete,
    PostCommitFailure,
    StoreClosed,
}

internal sealed class RbpJournalException : Exception
{
    internal RbpJournalException(
        RbpJournalErrorCode errorCode,
        string message,
        Exception? innerException = null,
        bool durableStateObserved = false)
        : base(message, innerException)
    {
        ErrorCode = errorCode;
        DurableStateObserved = durableStateObserved;
    }

    internal RbpJournalErrorCode ErrorCode { get; }

    internal bool DurableStateObserved { get; }
}
