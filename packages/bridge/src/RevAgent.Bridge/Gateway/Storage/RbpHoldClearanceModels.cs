namespace RevAgent.Bridge.Gateway.Storage;

/// <summary>
/// A durable verification attempt journaled against a Section 6.2.1 hold.
/// A conclusive attempt proves non-execution or the intended postcondition
/// and drives <c>active -&gt; evidence_recorded</c>; an inconclusive attempt
/// is retained while the hold stays blocking, because evidence is never
/// clearance.
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
