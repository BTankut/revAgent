# DP-11 — Backup Target

**Status:** Awaiting operator confirmation
**Gate:** Cutover entry
**Recommended default:** S3-compatible off-host object storage

## Decision

Select the durable target for Postgres WAL/base backups and the Phase-1 filesystem object-store copy.

## Requirements

- Off-host and outside the office's primary failure domain
- Compatible with WAL-G and ordinary recovery tooling
- Supports the RPO <= 5 minutes and RTO <= 30 minutes design
- Has an identified billing, credential, retention, and restore owner
- Allows mandatory blank-VM and recurring restore verification

## Candidate default

Cloudflare R2 is the implementation-plan recommendation because it is S3-compatible and avoids restore egress charges, but provider concentration with tunnel/DNS must be accepted explicitly.

## Confirmation prompt

Record provider, region, bucket/account owner, budget, retention, credential custody, and independent recovery path in `DP-log.md`.
