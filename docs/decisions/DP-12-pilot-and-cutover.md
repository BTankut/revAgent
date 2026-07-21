# DP-12 — Pilot User, Pilot Machine, and Cutover Window

**Status:** Awaiting operator confirmation
**Gate:** Pilot entry
**Recommended default:** Designer power-user; weekend/evening cutover

## Decision

Name the pilot user and workstation, the backup operator, the five-working-day pilot window, and the fleet cutover date/window.

## Selection requirements

- The pilot user performs representative mechanical production work and reports friction promptly.
- The pilot machine can retain the protected NAS rollback bootstrap while its scheduled updater is disabled.
- The chosen WP9 client, adapted add-in, bridge, self-update, reconnect, confirm flow, and file workflows are exercised on this exact stack.
- Cutover provides enough time for a canary pair, an early go/no-go decision, and the remaining fleet.

## Confirmation prompt

Record user, device, pilot start/end, cutover start/end, decision owner, fallback operator, and communication owner in `DP-log.md`.
