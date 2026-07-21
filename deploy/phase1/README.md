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

Before an actual deployment, replace `GATEWAY_IMAGE` with an immutable GHCR digest, point the DNS name at the approved ingress, and supply real Postgres, LLM, and OIDC credentials from the root-owned host environment. Only Caddy publishes host ports; PostgreSQL remains on an internal Compose network.

The external `DATABASE_URL` must use the Compose service name `postgres` and credentials matching `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`. Compose receives sensitive values by environment name; the YAML contains neither secret values nor secret-scanner suppressions.

## DP-5 identity gate

RES-22 recommends Keycloak-in-Compose, but DP-5 is still an operator decision. This skeleton therefore exposes only provider-neutral `OIDC_*` inputs and does not silently provision either Keycloak or Entra ID.

- If DP-5 confirms Keycloak, add its service, realm-as-code, persistent volume, and heap-tuned settings in a dedicated follow-up PR.
- If DP-5 selects Entra ID, keep this Compose topology and point the generic OIDC inputs at the verified app registration.

The Cloudflare tunnel, production secret files, host provisioning, backups, and deployment automation belong to later WP5 tasks and are not part of W1-6.
