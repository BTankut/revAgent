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
- Connector/origin: staged on `bt@192.168.90.154` as a disabled/inactive systemd service; the frozen
  origin is `http://127.0.0.1:8081`

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

The connector credential, config, edge-connectivity proof, and safe stopped state are retained in
`DP-03-04-cloudflare-staging.md`. The implementation assistant is the SSH-execution owner. Before pilot
entry, start the real Gateway/Caddy origin, enable the connector, retain public `/healthz`, restart, and
reconnect evidence, and name the recovery contact. Credentials and tunnel tokens must not enter git.
