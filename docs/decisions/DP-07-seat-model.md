# DP-07 — Seat Model

**Status:** Awaiting operator confirmation
**Gate:** Cutover entry
**Recommended default:** Named-user seats per module

## Decision

Confirm how users consume licensed module seats across designer and reviewer personas.

## Why this default

- Reviewers may have no bridge, so device or concurrent-bridge counting cannot cover the complete product.
- The audit/liability chain requires stable named actors.
- Named-user subscriptions match the purchasing model already familiar to Revit/ACC customers.

## Consequences

- Entitlements filter the capability index and are rechecked at dispatch.
- Assignment history is retained for audit.
- Reassignment cooldown and commercial packaging remain policy fields; they need not block Phase 1.

## Alternative

Concurrent seats introduce race-prone admission rules and weaker actor-to-license traceability. Select them only with an explicit reviewer-persona and audit design.

## Confirmation prompt

Approve named-user seats and record module packaging, reassignment owner, and any procurement constraint in `DP-log.md`.
