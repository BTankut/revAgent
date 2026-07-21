# DP-01 — Bridge Technology

**Status:** Awaiting operator confirmation
**Gate:** M0 / build entry
**Recommended default:** .NET 8 self-contained single-file Windows service

## Decision

Confirm the production implementation stack for the thin desktop bridge. The provisional Week-1 scaffold may use the recommended default, but transport implementation must not merge before this decision and DP-2 are recorded.

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

## Confirmation prompt

Approve the .NET 8 default, or record the alternative plus its service-hosting, signing, journal, and self-update consequences in `DP-log.md`.
