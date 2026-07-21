# RevAgent DP Decision Log

**Milestone:** M0
**Prepared:** 2026-07-22
**Normative coordinator:** `docs/implementation-plan/00-INDEX.md`
**Status rule:** `proposed` and `awaiting_confirmation` do not satisfy a milestone gate.

## Current decisions

| DP | Decision | Gate | Status | Recorded choice | Decision date | Evidence / next action |
|---|---|---|---|---|---|---|
| DP-1 | Bridge technology | M0 / build entry | awaiting_confirmation | Recommended: .NET 8 self-contained single-file Windows service | — | Operator confirmation required; provisional scaffold may use the recommended default per Week-1 instructions. |
| DP-2 | Gateway-to-bridge transport | M0 / build entry | awaiting_confirmation | Recommended: WSS primary, Streamable HTTP fallback | — | Operator confirmation required before build entry. |
| DP-3 | Outbound tunnel | Pilot entry | awaiting_confirmation | Recommended: Cloudflare Tunnel | — | W1-7 operator task: confirm account and tunnel direction. |
| DP-4 | Gateway domain | Pilot entry | awaiting_confirmation | Recommended: `gateway.<company-domain>` | — | W1-7 operator task: record the controlled domain and DNS owner. |
| DP-5 | Phase-1 identity provider | Cutover entry | awaiting_confirmation | Recommended: Keycloak in Compose, through generic `OIDC_*` configuration | — | RES-22 governs. Entra ID remains conditional on an office M365 tenant and successful WP9 OAuth testing without DCR. |
| DP-6 | LLM provider, models, and region | Pilot entry | awaiting_confirmation | Recommended: current cloud provider through the OpenAI-compatible adapter | — | Record provider, main model, optional router model, region, and spend owner. |
| DP-7 | Seat model | Cutover entry | awaiting_confirmation | Recommended: named-user seats per module | — | Confirm reassignment and procurement policy. |
| DP-8 | Gateway host | Pilot entry | confirmed | Dedicated office Ubuntu Server at `bt@192.168.90.154`; ED25519-key-only SSH; password and keyboard-interactive authentication disabled; dedicated to revAgent | 2026-07-22 | Confirmed in the M0 goal instruction. Host provisioning verification remains a W1-7 operator task, not a reopened architecture decision. |
| DP-9 | Bridge update signing | Pilot entry | awaiting_confirmation | Recommended: reuse the detached RS256 pinned-key chain | — | Confirm existing production key custody and bridge-manifest signing use. |
| DP-10 | Phase-1 designer client | Pilot entry | awaiting_evaluation | No client selected; WP9 matrix is required | — | Decide only after Streamable HTTP, OAuth/DCR, GAP-2 confirm, GAP-7 files, Turkish UX, cost, and manageability are tested. |
| DP-11 | Backup target | Cutover entry | awaiting_confirmation | Recommended: S3-compatible off-host bucket | — | Record provider, region, owner, and budget. |
| DP-12 | Pilot user/machine and cutover window | Pilot entry | awaiting_confirmation | Recommended: designer power-user and weekend/evening cutover | — | Record exact user, device, fallback operator, and dates. |
| DP-13 | Monorepo layout | M0 / build entry | awaiting_confirmation | Recommended: `packages/gateway`, `packages/bridge`, `packages/protocol`; legacy directories untouched | — | Operator confirmation required; provisional scaffold is explicitly allowed in Week 1. |
| DP-14 | Node MSI disposition | Cutover entry | awaiting_confirmation | Recommended: keep through insurance, remove only at Retire if no other owner needs it | — | Confirm shared-machine dependencies before removal. |
| DP-15 | Historical usage archive | Cutover entry | awaiting_confirmation | Recommended: read-only NAS archive through insurance, then cold storage; no Postgres migration | — | Record final archive location, retention, and access owner. |

## Confirmation-session record

The operator confirmation session has not yet been held. This log deliberately records only DP-8 as confirmed because that confirmation was supplied explicitly. DP-1, DP-2, and DP-13 therefore remain open M0 exit gates even though their defaults are safe for provisional scaffolding.

When the session occurs, append a dated entry rather than rewriting history:

```text
### YYYY-MM-DD — M0 operator checkpoint
- Attendees:
- Confirmed decisions:
- Deferred decisions and owners:
- Amendments required under R-F:
- Evidence links:
```

## Amendments

No RES-* or plan amendment has been raised during Week-1 preparation. Any implementation-discovered conflict must be added here as a dated amendment and reflected in `docs/implementation-plan/00-INDEX.md` before code diverges.
