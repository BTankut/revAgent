# DP-03 — Outbound Tunnel

**Status:** Awaiting operator confirmation
**Gate:** Pilot entry
**Recommended default:** Cloudflare Tunnel

## Decision

Select the outbound tunnel provider for the public Gateway endpoint. No customer or office router inbound port-forward is permitted.

## Why this default

- The office already has operational familiarity with `cloudflared` through the dashboard add-on.
- A named tunnel provides stable HTTPS without a static public IP.
- DNS, tunnel replicas, and the planned standby path share one operational surface.

## Consequences

- `cloudflared` credentials remain host-local secrets and never enter git.
- Caddy remains the internal reverse-proxy boundary.
- Provider concentration is retained as a Phase-1 risk with a documented DNS/provider escape path.

## Alternative

A different outbound-tunnel provider is acceptable only if it preserves the owned DNS name, no inbound ports, automated reconnect, and standby/failover operation.

## Confirmation prompt

Confirm Cloudflare account ownership and tunnel direction; record the operational owner and recovery contact in `DP-log.md`.
