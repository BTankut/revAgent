# DP-03 — Outbound Tunnel

**Status:** Confirmed
**Decision date:** 2026-07-22
**Gate:** Pilot entry
**Recorded choice:** Cloudflare Tunnel

## Decision

The outbound tunnel provider is Cloudflare Tunnel. No customer or office router inbound port-forward is permitted.

The registered tunnel object is:

- Name: `revagent-gateway-prod`
- UUID: `bb68cbcb-eedf-474e-aaee-145d160ed004`
- Connector/origin: not yet defined

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

## Remaining operational gate

Define the connector/origin, name the operational owner and recovery contact, and retain tunnel-to-origin reachability evidence before pilot entry. Credentials and tunnel tokens must not enter git.
