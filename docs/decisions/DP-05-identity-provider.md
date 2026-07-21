# DP-05 — Phase-1 Identity Provider

**Status:** Awaiting operator confirmation
**Gate:** Cutover entry; implementation choice needed before auth delivery
**Recommended default:** Keycloak in the Phase-1 Compose stack

## Decision

Select the Phase-1 OIDC provider while keeping the Gateway implementation provider-neutral through `OIDC_*` configuration.

## Why this default

RES-22 reverses the earlier Entra default because Phase-1 third-party MCP clients need OAuth dynamic client registration, the office has no confirmed central IdP, and the on-prem/air-gapped product variant needs a local identity option. Keycloak satisfies those constraints inside Compose.

## Consequences

- The Phase-1 Compose skeleton includes a heap-tuned Keycloak service and persistent data only after this decision is confirmed.
- Realm configuration is versioned without secrets.
- `tenant_admin` realizes the architecture's Phase-1 admin role.

## Conditional alternative

Entra ID remains viable only if the office M365 tenant is confirmed and the WP9 client evaluation proves the selected client can complete OAuth against Entra without DCR. That evidence must be attached before changing the default.

## Confirmation prompt

Approve Keycloak, or record the Entra tenant owner and successful WP9 OAuth evidence in `DP-log.md`.
