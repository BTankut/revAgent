# DP-12 — Pilot User, Pilot Machine, and Cutover Window

**Status:** Partially confirmed
**Decision date:** 2026-07-22
**Gate:** Pilot entry
**Recorded machine:** `NET01` (registered; SSH access available)

## Decision

`NET01` is the pilot workstation. Name the pilot user, backup operator, five-working-day pilot window, and fleet transition date/window before pilot entry.

## Selection requirements

- The pilot user performs representative mechanical production work and reports friction promptly.
- The pilot machine can retain the protected NAS rollback bootstrap while its scheduled updater is disabled.
- The chosen WP9 client, adapted add-in, bridge, self-update, reconnect, confirm flow, and file workflows are exercised on this exact stack.
- Cutover provides enough time for a canary pair, an early go/no-go decision, and the remaining fleet.

## Remaining fields

Record pilot user, pilot start/end, transition start/end, decision owner, fallback operator, and communications owner in `DP-log.md`; retain the live readiness evidence from NET01.
