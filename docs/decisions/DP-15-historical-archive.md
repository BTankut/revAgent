# DP-15 — Historical Usage Archive

**Status:** Awaiting operator confirmation
**Gate:** Cutover entry
**Recommended default:** Read-only NAS archive through insurance, then cold storage; no migration

## Decision

Select the final archive location, retention period, access owner, and integrity evidence for workstation-era telemetry, summaries, dashboard inputs, and Codex correlation artifacts.

## Closed boundary

O11 already decides that historical usage data is not imported into the new Gateway/Postgres store. This DP chooses archive custody only; it cannot reopen migration.

## Recommended handling

- Keep the old telemetry and reports pipeline alive through the pilot for side-by-side parity.
- Make the reports tree read-only at cutover and retain the old dashboard as an insurance-only reader.
- At NAS retirement, create a compressed archive plus SHA-256 manifest in cold storage with documented admin-only access.

## Confirmation prompt

Record the source roots, final destination, minimum retention, access owner, integrity-check procedure, and deletion authority in `DP-log.md`.
