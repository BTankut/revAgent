# DP-04 — Gateway Domain

**Status:** Awaiting operator confirmation
**Gate:** Pilot entry
**Recommended default:** `gateway.<company-domain>`

## Decision

Record the exact controlled DNS name used by bridges and external MCP clients. Clients must never be configured with an IP address or machine hostname.

## Requirements

- The firm controls the parent zone and renewal/account access.
- The name can point to the outbound tunnel and later move to standby or cloud infrastructure without workstation reconfiguration.
- TLS and OAuth redirect/resource-server metadata use this canonical origin.

## Consequences

- `GATEWAY_PUBLIC_URL`, OIDC audience/redirects, Caddy routing, client registration, and bridge configuration all derive from the chosen name.
- Changing it after pilot requires a controlled compatibility window.

## Confirmation prompt

Record the exact FQDN, DNS provider/account owner, and recovery contact in `DP-log.md`; do not commit tunnel tokens or registrar secrets.
