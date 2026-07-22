# DP-12 — Pilot User, Pilot Machine, and Cutover Window

**Status:** Partially confirmed
**Decision date:** 2026-07-22
**Gate:** Pilot entry
**Recorded machine:** `NET01` (registered; dedicated to this work; waiting; stored SSH access available)

## Decision

Barış Tankut confirmed `NET01` as the pilot workstation and confirmed that it is fully allocated to this
work, waiting, and reachable through the stored SSH path at the requested date/time. Name the pilot user,
backup operator, five-working-day pilot window, and fleet transition date/window before pilot entry.

The implementing assistant subsequently proved public-key SSH reachability and recorded the Windows,
resource, Revit 2022, Codex AppX, installed revAgent, and protected-bootstrap inventory in
`DP-12-NET01-readiness-2026-07-22.md`. The machine/resource baseline passed. Pilot readiness remains open
because the installed daily updater launcher is stale and lacks the required `-AuditOnly` argument; no
updater or repair was executed during the evidence collection.

## Selection requirements

- The pilot user performs representative mechanical production work and reports friction promptly.
- The pilot machine can retain the protected NAS rollback bootstrap while its scheduled updater is disabled.
- The chosen WP9 client, adapted add-in, bridge, self-update, reconnect, confirm flow, and file workflows are exercised on this exact stack.
- Cutover provides enough time for a canary pair, an early go/no-go decision, and the remaining fleet.

## Remaining fields

Operator attribution and the machine allocation are closed by the 2026-07-22 checkpoint. Record pilot user,
pilot start/end, transition start/end, fallback operator, and communications owner in `DP-log.md`; retain the
live readiness evidence from NET01. The technical team must separately neutralize or repair the stale updater
task through the controlled pilot path while preserving the protected rollback bootstrap.
