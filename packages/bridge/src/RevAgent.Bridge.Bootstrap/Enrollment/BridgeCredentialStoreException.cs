namespace RevAgent.Bridge.Bootstrap.Enrollment;

internal enum BridgeCredentialStoreErrorCode
{
    UnsupportedPlatform,
    InvalidState,
    IdentityMissing,
    IdentityMismatch,
    AccessControlFailure,
    ProtectionFailure,
    ReadFailure,
    AtomicWriteFailure,
    LockUnavailable,
}

internal enum BridgeAtomicWriteOutcome
{
    NotCommitted,
    Committed,
    Indeterminate,
}

internal readonly record struct BridgeAtomicWriteResult(
    BridgeAtomicWriteOutcome Outcome)
{
    internal static BridgeAtomicWriteResult Committed =>
        new(BridgeAtomicWriteOutcome.Committed);
}

internal sealed class BridgeCredentialStoreException : Exception
{
    internal BridgeCredentialStoreException(
        BridgeCredentialStoreErrorCode errorCode,
        string message,
        Exception? innerException = null,
        BridgeAtomicWriteOutcome? atomicWriteOutcome = null)
        : base(message, innerException)
    {
        ErrorCode = errorCode;
        AtomicWriteOutcome = atomicWriteOutcome;
    }

    internal BridgeCredentialStoreErrorCode ErrorCode { get; }

    internal BridgeAtomicWriteOutcome? AtomicWriteOutcome { get; }
}
