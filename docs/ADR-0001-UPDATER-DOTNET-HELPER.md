# ADR 0001: Updater .NET Helper

## Status

Deferred.

## Context

The updater currently uses PowerShell for package orchestration, scheduled task
registration, ACL repair, proxy setup, Codex MCP registration, and reporting.
The modernization goal asked whether a small .NET helper would be worthwhile for
hidden process launch, exit-code propagation, permission repair, and scheduled
task action generation.

## Decision

Do not add a .NET helper on this branch.

The highest-value helper cases are now covered with lower deployment risk:

- Hidden background launch is handled by a single-line VBS launcher that runs
  PowerShell hidden and propagates the child exit code.
- Scheduled task action generation and repair are centralized in
  `installer/lib/RevAgent.ScheduledTask.psm1`.
- Permission repair uses a targeted plan in
  `installer/lib/RevAgent.Permissions.psm1` and avoids broad recursive scans.
- Package/update decisions remain inspectable PowerShell logic with local smoke
  tests that do not require admin rights or Revit.

Adding a compiled helper would introduce a second build artifact, signing or
trust questions, versioned deployment rules, and another failure mode in the
workstation updater. That cost is not justified for the current risk profile.

## Revisit When

Reconsider a .NET helper if the updater needs one of these:

- long-lived elevated service behavior
- robust Windows Task Scheduler COM APIs beyond PowerShell cmdlets
- ACL changes that need richer diagnostics than `icacls`
- signed, centrally managed helper binaries with a clear release process
- substantial startup performance problems caused by PowerShell process launch
