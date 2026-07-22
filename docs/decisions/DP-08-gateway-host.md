# DP-08 — Gateway Host

**Status:** Confirmed
**Decision date:** 2026-07-22
**Gate:** Pilot entry

## Recorded decision

The Phase-1 Gateway host is ready as a dedicated office Ubuntu Server:

- SSH target: `bt@192.168.90.154`
- Authentication: ED25519 key only
- Password authentication: disabled
- Keyboard-interactive authentication: disabled
- Workload ownership: dedicated to revAgent

This confirmation was supplied explicitly in the M0 goal instruction and must not be reopened without an R-F amendment.

## Security boundary

The repository records only the non-secret connection identity above. Private keys, host credentials, tunnel tokens, runtime secrets, and recovery material must remain outside git.

## Remaining operational verification

The host choice is confirmed, but the M0 `ready/reachable` gate remains `in_progress` until command output is retained.

- **Owner:** Barış / office network operations
- **Next action:** capture live SSH reachability plus Ubuntu, Docker/Compose, storage, power-recovery, UPS, and resource-headroom evidence.
- **LTE next action:** before M7/pilot, verify router dual-WAN/LTE capability and record the device/SIM/provider choice; if deferred, record a dated acceptance of WAN-outage risk and its next review gate.

These checks validate the confirmed host; they do not reopen DP-8.
