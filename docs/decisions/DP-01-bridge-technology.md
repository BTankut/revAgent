# DP-01 — Bridge Technology

**Status:** Confirmed
**Decision date:** 2026-07-22
**Gate:** M0 / build entry
**Recorded choice:** .NET 8 self-contained single-file Windows service

## Decision

The production implementation stack for the thin desktop bridge is .NET 8 self-contained single-file Windows service. DP-2 separately fixes its Gateway transport.

## Why this default

- RES-2 makes the .NET 8 choice the implementation-plan default.
- Windows service lifecycle, `ClientWebSocket`, `TcpClient`, DPAPI, and RS256 verification are native.
- Self-contained deployment removes the bridge's dependency on the workstation Node MSI.
- The bridge can share contracts and engineering conventions with the C# add-in without changing RevitMCPSDK.

## Consequences

- `packages/bridge` contains the .NET solution and service/worker projects.
- The durable idempotency journal uses a SQLite-class store through .NET libraries; O1 remains implementation-neutral.
- The worker can ship as a signed, self-contained artifact behind a stable host process.

## Alternative

A Node SEA/packaged executable keeps TypeScript familiarity but requires an additional Windows service wrapper and complicates native SQLite/self-update behavior. Select it only with explicit replacement designs for those concerns.

## Change control

This choice is recorded in `DP-log.md`. Replacing it requires a dated R-F amendment covering service hosting, signing, journal, and self-update consequences.
