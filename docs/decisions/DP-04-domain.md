# DP-04 — Gateway Domain

**Status:** Confirmed
**Decision date:** 2026-07-22
**Gate:** Pilot entry
**Recorded choice:** `gateway.revagent.app`

## Decision

Bridges and external MCP clients use `gateway.revagent.app`. Clients must never be configured with an IP address or machine hostname.

## Requirements

- The firm controls the parent zone and renewal/account access.
- The name can point to the outbound tunnel and later move to standby or cloud infrastructure without workstation reconfiguration.
- TLS and OAuth redirect/resource-server metadata use this canonical origin.

## Consequences

- `GATEWAY_PUBLIC_URL`, OIDC audience/redirects, Caddy routing, client registration, and bridge configuration all derive from the chosen name.
- Changing it after pilot requires a controlled compatibility window.

## Remaining operational gate

The FQDN resolves through Cloudflare and the staged ingress rule maps it to the loopback-only origin;
HTTPS reaches the Cloudflare edge and currently returns the expected HTTP 530 while the connector is
intentionally stopped. Evidence is retained in `DP-03-04-cloudflare-staging.md`. Before pilot entry,
record the DNS/account recovery owner and prove public TLS plus `/healthz` through the active real
origin. Do not commit tunnel tokens or registrar secrets.
