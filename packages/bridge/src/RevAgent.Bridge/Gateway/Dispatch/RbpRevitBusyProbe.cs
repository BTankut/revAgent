namespace RevAgent.Bridge.Gateway.Dispatch;

/// <summary>
/// RES-10 failure-path enrichment seam: local <c>mcp_status</c> evidence
/// consulted only after a failed or timed-out invocation, to distinguish an
/// active Revit task from an unreachable add-in and enrich the structured
/// <c>revit_busy</c> fault.
/// </summary>
/// <remarks>
/// Spec Section 9 makes the boundary explicit: the bridge MUST NOT issue
/// <c>mcp_status</c> before every invocation, and it MAY consult it after a
/// failure. The dispatcher therefore never touches this seam on the invoke
/// hot path — only when a transport-shaped failure is already terminal-bound.
/// Enrichment is best-effort evidence, never authority: a probe fault leaves
/// the original failure untouched, and a Section 15 <c>journal_indeterminate</c>
/// classification is never downgraded by busy evidence.
/// </remarks>
internal interface IRbpRevitBusyProbe
{
    /// <summary>
    /// Returns a bounded description of the competing active Revit task for
    /// this session, or <see langword="null"/> when none is known.
    /// </summary>
    Task<string?> FindActiveTaskAsync(
        string rsid,
        CancellationToken cancellationToken);
}
