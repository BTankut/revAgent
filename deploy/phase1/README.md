# revAgent Phase-1 Compose Skeleton

This M0 skeleton fixes the intended service and configuration boundaries without claiming a deployable Gateway image exists yet. It defines the Gateway, PostgreSQL 16, and Caddy with automatic TLS. Large result objects use the Phase-1 filesystem driver on a dedicated host bind mount; MinIO is intentionally absent.

## Validate

Copy `.env.example` to a host-only env file, replace every placeholder, create the four bind-mount directories as root, and grant the future service account only the access each container requires. The populated env file must stay outside Git.

Configuration-only validation does not start or pull containers:

```bash
docker compose \
  --env-file deploy/phase1/.env.example \
  --file deploy/phase1/docker-compose.yml \
  config --quiet
```

Before an actual deployment, replace `GATEWAY_IMAGE` with an immutable GHCR digest, connect the confirmed `gateway.revagent.app` DNS name and `revagent-gateway-prod` Cloudflare tunnel to the approved origin, and supply real Postgres and OIDC credentials from the root-owned host environment. The tunnel connector/origin is still an open operational input. Only Caddy publishes host ports; PostgreSQL remains on an internal Compose network.

The external `DATABASE_URL` must use the Compose service name `postgres` and credentials matching `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`. Compose receives sensitive values by environment name; the YAML contains neither secret values nor secret-scanner suppressions.

## Phase-1 agent-loop boundary

RES-23 keeps the Phase-1 agentic loop in the user's existing authorized ChatGPT/Codex Desktop client. The
Gateway therefore has no `LLM_API_KEY`, provider URL, model, or region input in this Compose profile. Client
installation, subscription, and user session are user responsibilities; revAgent owns remote MCP registration
and end-to-end compatibility verification. A future in-house-loop profile must add its provider settings and
secret boundary through a separately approved milestone rather than reusing this M0 skeleton silently.

## DP-5 identity gate

RES-22 recommends Keycloak-in-Compose, but DP-5 is still an operator decision. This skeleton therefore exposes only provider-neutral `OIDC_*` inputs and does not silently provision either Keycloak or Entra ID.

- If DP-5 confirms Keycloak, add its service, realm-as-code, persistent volume, and heap-tuned settings in a dedicated follow-up PR.
- If DP-5 selects Entra ID, keep this Compose topology and point the generic OIDC inputs at the verified app registration.

The Cloudflare tunnel, production secret files, host provisioning, backups, and deployment automation belong to later WP5 tasks and are not part of W1-6.
