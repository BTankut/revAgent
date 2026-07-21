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

W1-7 still verifies host provisioning facts such as Ubuntu version, Docker/Compose readiness, storage, power recovery, UPS coverage, and resource headroom. Those checks validate the confirmed host; they do not change DP-8. LTE failover remains a Phase-1 resilience item in the risk register unless the operator records a separate commitment.
