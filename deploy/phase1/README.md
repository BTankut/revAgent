# revAgent Phase-1 Compose Skeleton

This skeleton defines the Gateway, PostgreSQL 16, the tracked Keycloak identity choice, and a loopback-only Caddy origin. Cloudflare terminates public TLS; Caddy accepts plain HTTP only through the host connector at `127.0.0.1:8081`. Large result objects use the Phase-1 filesystem driver on a dedicated host bind mount; MinIO is intentionally absent.

## Validate

Copy `.env.example` to a host-only env file, replace every placeholder, create the four bind-mount directories as root, and grant the future service account only the access each container requires. The populated env file must stay outside Git.

Configuration-only validation does not start or pull containers:

```bash
docker compose \
  --env-file deploy/phase1/.env.example \
  --file deploy/phase1/docker-compose.yml \
  config --quiet
```

Before an actual deployment, replace `GATEWAY_IMAGE` with an immutable GHCR digest and supply real Postgres and OIDC credentials from the root-owned host environment. The confirmed `revagent-gateway-prod` tunnel (`bb68cbcb-eedf-474e-aaee-145d160ed004`) routes `gateway.revagent.app` to `http://127.0.0.1:8081`. Only Caddy publishes that loopback host port; PostgreSQL remains on an internal Compose network. Do not change `CADDY_ORIGIN_BIND` to a LAN/WAN address: doing so bypasses the Cloudflare ingress and access-policy boundary.

The external `DATABASE_URL` must use the Compose service name `postgres` and credentials matching `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`. Compose receives sensitive values by environment name; the YAML contains neither secret values nor secret-scanner suppressions.

## Phase-1 agent-loop boundary

RES-23 keeps the Phase-1 agentic loop in the user's existing authorized ChatGPT/Codex Desktop client. The
Gateway therefore has no `LLM_API_KEY`, provider URL, model, or region input in this Compose profile. Client
installation, subscription, and user session are user responsibilities; revAgent owns remote MCP registration
and end-to-end compatibility verification. A future in-house-loop profile must add its provider settings and
secret boundary through a separately approved milestone rather than reusing this M0 skeleton silently.

## DP-5 identity selection

EU-10 tracks the RES-22 recommended Keycloak-in-Compose choice. The realm export contains no user, password, client secret, or production credential. The Gateway remains provider-neutral: it consumes only issuer, audience/client id, and JWKS URI through `OIDC_*` configuration and validates bearer JWTs as an OAuth resource server.

The checked-in `start-dev` command is a bounded Compose/integration choice for M5 evidence; it is not production deployment approval. Production hardening, secrets, DNS, host provisioning, backups, and dispatch remain later gated work. An eventual Entra selection changes the deployment adapter and `OIDC_*` values, not the Gateway identity contract.

The Cloudflare tunnel, production secret files, host provisioning, backups, and deployment automation belong to later WP5 tasks and are not part of W1-6.
