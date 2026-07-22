# DP-09 — Bridge Update Signing

**Status:** Awaiting operator confirmation
**Gate:** Pilot entry
**Recommended default:** Reuse the detached RS256 pinned-key chain

## Decision

Confirm that bridge and add-in self-update manifests use the production signing trust already established for signed source-free delivery.

## Why this default

- Existing signing custody, key id, trusted-key document, canonical JSON, detached signature, and anti-rollback practices are proven.
- The .NET bridge can verify the RSA XML public-key format and envelope semantics directly.
- A new trust ceremony during migration would add risk without changing the security model.

## Consequences

- A new allowlisted signed-object kind is added only in the later O9 implementation package.
- `releaseSequence` remains the monotonic anti-downgrade authority.
- The CD runner signing tree must survive cutover and NAS retirement.

## Confirmation prompt

Approve reuse of the existing RS256 chain and record key custodian, bridge-manifest signed-object name, and rotation owner in `DP-log.md`.
