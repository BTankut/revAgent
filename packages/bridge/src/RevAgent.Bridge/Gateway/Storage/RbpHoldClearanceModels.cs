namespace RevAgent.Bridge.Gateway.Storage;

/// <summary>
/// Compatibility lookup for a production-written verification candidate.
/// Conclusive is retained for source compatibility only and grants no
/// authority. The correlated read terminal, never this caller-supplied flag,
/// determines candidate eligibility; a candidate is not an effect verdict.
/// </summary>
internal sealed record RbpHoldVerificationEvidence(
    string VerificationHoldId,
    string VerificationInvocationId,
    string EvidenceDigest,
    bool Conclusive);

/// <summary>
/// The outcome of a Section 6.2.1 clearance-gated admission. Exactly one
/// property is set: an admitted envelope carries its ordinary Section 12.2
/// result, while a blocked envelope wrote no invocation row and must be
/// answered with the original hold's <c>journal_indeterminate</c> error
/// without add-in contact.
/// </summary>
internal sealed record RbpClearanceGatedAdmission(
    RbpInvocationAdmissionResult? Admission,
    RbpVerificationHold? BlockingHold);
