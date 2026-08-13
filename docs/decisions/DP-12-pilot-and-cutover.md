# DP-12 — Pilot User, Pilot Machine, and Cutover Window

**Status:** Partially confirmed
**Decision date:** 2026-07-22
**Authority correction:** 2026-08-13
**Gate:** Pilot entry
**Current live workstation:** `PETRUCCI` (`ws2@192.168.90.122`; read-only public-key SSH verified from `DESKTOP-OKNV128`)
**Superseded assignment:** `NET01` is outside the current program; its 2026-07-22 readiness record is historical only

## Decision

Barış Tankut corrected the live-workstation authority on 2026-08-13:
`PETRUCCI`, not `NET01`, is the DP-12/M4 live Revit workstation. The current
read-only locator and installed-surface evidence is retained in
`DP-12-PETRUCCI-readiness-2026-08-13.md`; the accepted M3 live chain is retained
in `docs/plan/M3_BRIDGE_GATE_EVIDENCE.md`. Name the human pilot user, backup
operator, five-working-day pilot window, and fleet transition date/window
before pilot entry.

The 2026-07-22 NET01 public-key SSH/resource/updater inventory remains in
`DP-12-NET01-readiness-2026-07-22.md` without rewriting history, but it no
longer supplies current DP-12 readiness. PETRUCCI's current Bridge still points
to the M3 loopback stub, and its retained enrollment is stub-only. Real Gateway
networking, trust, Bridge staging, credential/enrollment, and client/live-Revit
execution remain separate M4-04 gates.

## Selection requirements

- The pilot user performs representative mechanical production work and reports friction promptly.
- The pilot machine's installed/recovery surface is inventoried before any separately approved staging or update.
- The chosen WP9 client, adapted add-in, bridge, self-update, reconnect, confirm flow, and file workflows are exercised on this exact stack.
- Cutover provides enough time for a canary pair, an early go/no-go decision, and the remaining fleet.

## Remaining fields

The live-workstation allocation is corrected by the 2026-08-13 operator record.
Record the human pilot user, pilot start/end, transition start/end, fallback
operator, and communications owner in `DP-log.md`. Before live execution,
close the separately operator-gated PETRUCCI network/trust, Bridge staging,
real-Gateway credential/enrollment, and WP9 client/live-Revit steps. Do not
contact NET01 as a substitute.
