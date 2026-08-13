# RevAgent Architecture Decision Checkpoint

This directory contains the operator-facing decision packets for Phase 0 / Milestone M0. The closed architecture decisions D1-D12 remain governed by `docs/TARGET_ARCHITECTURE.md`; these DP records select implementation and operating defaults without reopening that architecture.

Normative order:

1. `docs/TARGET_ARCHITECTURE.md`
2. `docs/implementation-plan/00-INDEX.md`
3. The relevant implementation-plan package
4. These decision records

The authoritative status ledger is `DP-log.md`. A recommendation in a one-pager is not an approval. Decision selection and executable-gate evidence are tracked separately: `confirmed_pending_conformance` closes the choice but not the pilot gate, while `partially_confirmed` closes only the named subfields.

## Decision packets

- `DP-01-bridge-technology.md`
- `DP-02-bridge-transport.md`
- `DP-03-tunnel.md`
- `DP-04-domain.md`
- `DP-05-identity-provider.md`
- `DP-06-llm-provider.md`
- `DP-07-seat-model.md`
- `DP-08-gateway-host.md`
- `DP-09-update-signing.md`
- `DP-10-designer-client.md`
- `DP-11-backup-target.md`
- `DP-12-pilot-and-cutover.md`
- `DP-12-PETRUCCI-readiness-2026-08-13.md` — current live-workstation locator and read-only readiness evidence
- `DP-12-NET01-readiness-2026-07-22.md` — superseded historical NET01 inventory; not a current target
- `DP-13-monorepo-layout.md`
- `DP-14-node-msi.md`
- `DP-15-historical-archive.md`

## Operator checkpoint

The 2026-07-22 written checkpoints confirmed DP-1, DP-2, DP-3, DP-4, DP-8 host selection, DP-10 client selection, and DP-13; DP-6 is not applicable to Phase 1. On 2026-08-13 Barış Tankut corrected DP-12's current live-workstation authority to `PETRUCCI` and placed `NET01` outside the program; named pilot-user/window roles remain open. Barış Tankut explicitly confirmed operator attribution for RES-23 and DP-3/DP-4/DP-10/DP-12. DP-1/DP-2/DP-13 satisfy the decision portion of the M0 build-entry gate. DP-3/DP-4/DP-8/DP-9/DP-10 conformance/DP-12 readiness evidence must still satisfy their executable pilot gates. The remaining decisions must close before fleet transition.
