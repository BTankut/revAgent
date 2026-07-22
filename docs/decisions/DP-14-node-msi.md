# DP-14 — Workstation Node MSI Disposition

**Status:** Awaiting operator confirmation
**Gate:** Cutover entry
**Recommended default:** Keep through insurance; remove only at Retire if unowned

## Decision

Determine when the pinned workstation Node MSI may be removed after the self-contained .NET bridge replaces the local runtime.

## Why this default

- Keeping Node during Build, pilot, and insurance preserves the frozen NAS rollback path and avoids collateral impact on unrelated workstation tools.
- Node removal has little value during the risky migration window.
- Retire is the first point at which the old stdio runtime and local Codex integration are intentionally unavailable.

## Preconditions for removal

- DP-1 remains .NET self-contained.
- No other managed or operator-owned software requires `C:\Program Files\nodejs`.
- Insurance has exited and the Retire checklist explicitly owns the action.

## Confirmation prompt

Approve deferred removal or record a shared dependency that makes Node a permanent keep item.
