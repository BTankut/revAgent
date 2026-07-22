# RevAgent DP Decision Log

**Milestone:** M0
**Prepared:** 2026-07-22
**Normative coordinator:** `docs/implementation-plan/00-INDEX.md`
**Status rule:** `proposed`, `awaiting_confirmation`, `partially_confirmed`, and
`confirmed_pending_conformance` do not by themselves satisfy the associated executable milestone gate.

## Current decisions

| DP | Decision | Gate | Status | Recorded choice | Decision date | Evidence / next action |
|---|---|---|---|---|---|---|
| DP-1 | Bridge technology | M0 / build entry | confirmed | .NET 8 self-contained single-file Windows service | 2026-07-22 | Operator-confirmed; scaffold and Bridge implementation use this stack. |
| DP-2 | Gateway-to-bridge transport | M0 / build entry | confirmed | WSS primary; Streamable HTTP/SSE fallback | 2026-07-22 | Operator-confirmed. RES-25 records the R-F amendment to WP1 P-O1-1; the fallback binding and conformance evidence remain v1.0/pilot work. |
| DP-3 | Outbound tunnel | Pilot entry | confirmed | Cloudflare Tunnel object `revagent-gateway-prod`; UUID `bb68cbcb-eedf-474e-aaee-145d160ed004` | 2026-07-22 | Barış Tankut confirmed operator attribution. Connector credential/config and a bounded QUIC+HTTP/2 edge proof are staged on the Gateway host; the service remains deliberately disabled/inactive until the real origin exists. |
| DP-4 | Gateway domain | Pilot entry | confirmed | `gateway.revagent.app` | 2026-07-22 | Barış Tankut confirmed operator attribution. DNS/edge TLS and the staged `http://127.0.0.1:8081` ingress are evidenced; active-origin `/healthz` and restart proof remain pilot gates. |
| DP-5 | Phase-1 identity provider | Cutover entry | awaiting_confirmation | Recommended: Keycloak in Compose, through generic `OIDC_*` configuration | — | RES-22 governs. Entra ID remains conditional on an office M365 tenant and successful WP9 OAuth testing without DCR. |
| DP-6 | LLM provider, models, and region | Phase 1 | not_applicable_phase1 | The authorized ChatGPT/Codex Desktop client retains the Phase-1 agentic loop; the Gateway uses no LLM API key | 2026-07-22 | RES-23 removes DP-6 from the Phase-1 pilot gate. The long-term in-house-loop/provider choice remains a later D9 implementation decision. |
| DP-7 | Seat model | Cutover entry | awaiting_confirmation | Recommended: named-user seats per module | — | Confirm reassignment and procurement policy. |
| DP-8 | Gateway host | Pilot entry | confirmed | Dedicated office Ubuntu Server at `bt@192.168.90.154`; ED25519-key-only SSH; password and keyboard-interactive authentication disabled; dedicated to revAgent | 2026-07-22 | M0 live SSH/OS/resource evidence was retained in `DP-08-gateway-host.md` on 2026-07-22. Router dual-WAN/LTE is unavailable; Barış Tankut accepted the WAN-outage risk. Docker/Compose, power/UPS, and production tunnel readiness remain later operational gates. |
| DP-9 | Bridge update signing | Pilot entry | awaiting_confirmation | Recommended: reuse the detached RS256 pinned-key chain | — | Confirm existing production key custody and bridge-manifest signing use. |
| DP-10 | Phase-1 designer client | Pilot entry | confirmed_pending_conformance | Existing authorized ChatGPT/Codex Desktop client | 2026-07-22 | Barış Tankut confirmed operator attribution on 2026-07-22. Client installation, subscription, and user session are user responsibilities; revAgent owns remote MCP registration and end-to-end compatibility verification. WP9 conformance must pass before pilot/cutover. |
| DP-11 | Backup target | Cutover entry | awaiting_confirmation | Recommended: S3-compatible off-host bucket | — | Record provider, region, owner, and budget. |
| DP-12 | Pilot user/machine and cutover window | Pilot entry | partially_confirmed | Pilot machine: `NET01` (registered, dedicated to this work, waiting, and reachable by stored SSH access at the requested date/time) | 2026-07-22 | Barış Tankut confirmed operator attribution and the machine allocation. Live SSH/resource/installed-surface evidence is retained in `DP-12-NET01-readiness-2026-07-22.md`; the stale non-`AuditOnly` updater task and the named user/window/roles remain open. |
| DP-13 | Monorepo layout | M0 / build entry | confirmed | `packages/gateway`, `packages/bridge`, `packages/protocol`; legacy directories untouched | 2026-07-22 | Operator-confirmed; the W1 scaffold must preserve the frozen legacy paths and independent runtime lockfile. |
| DP-14 | Node MSI disposition | Cutover entry | awaiting_confirmation | Recommended: keep through insurance, remove only at Retire if no other owner needs it | — | Confirm shared-machine dependencies before removal. |
| DP-15 | Historical usage archive | Cutover entry | awaiting_confirmation | Recommended: read-only NAS archive through insurance, then cold storage; no Postgres migration | — | Record final archive location, retention, and access owner. |

## Confirmation-session record

### 2026-07-22 — M0 operator checkpoint

- Operator: Barış Tankut.
- Evidence source: operator-provided written checkpoints in the Week-1 review and merge-execution tasks.
- Confirmed decisions: DP-1, DP-2, DP-3, DP-4, DP-8 host selection, DP-10 client selection, and DP-13.
- Phase-1 non-applicability: DP-6; the client owns the loop and the Gateway has no LLM API key.
- Partially confirmed: DP-12 assigns the registered `NET01` machine exclusively to this work and makes it
  available over stored SSH access at the requested date/time; pilot user, concrete dates/window, fallback
  operator, and communications owner remain open.
- Network resilience disposition: the router has no dual-WAN/LTE support; Barış Tankut accepts WAN-outage
  risk as of 2026-07-22.
- Live host evidence: BatchMode SSH reached `bt@192.168.90.154`; Ubuntu 26.04 LTS, 8 CPUs, 30 GiB RAM,
  204 GiB free root storage, and 870 GiB free data storage were retained in `DP-08-gateway-host.md`.
- Staged operational evidence: `DP-03-04-cloudflare-staging.md` records `cloudflared` 2026.7.2,
  credential-hash parity, loopback ingress validation, QUIC/HTTP2 edge proof, Docker Engine 29.6.2,
  Compose v5.3.1, hash-matched PR #273 artifacts, configuration validation, and the deliberate stopped
  state. Active-origin `/healthz`, power-recovery/UPS, and later production-readiness proof remain open.
- Executable gates remain independent of decision acceptance: WP9 must prove the selected client's remote-MCP path; NET01 and the Gateway host must produce retained readiness evidence.

### 2026-07-22 — Operator attribution closure

Barış Tankut explicitly confirmed that RES-23 direction and the DP-3, DP-4, DP-10, and DP-12 decisions
are operator-owned. This dated confirmation closes the earlier `attribution asserted, not repo-provable`
evidence gap. It confirms authorship of the decisions; it does not substitute for the separately required
tunnel, reachability, client-conformance, or pilot-execution evidence.

### 2026-07-22 — DP-3/DP-4 connector staging evidence

Under R-G, the implementation assistant used the confirmed SSH path rather than assigning server work
to the operator. Cloudflared 2026.7.2, the existing tunnel credential, root-owned locally managed config,
and a disabled systemd unit were staged on `revagent`. Ingress validation bound
`gateway.revagent.app` to `http://127.0.0.1:8081`; bounded QUIC and HTTP/2 edge checks passed. The unit
was returned to `disabled`/`inactive` because no real Gateway/Caddy origin exists yet. Exact non-secret
evidence is retained in `DP-03-04-cloudflare-staging.md`; no new Cloudflare authorization was required.

The implementing assistant then installed Docker Engine 29.6.2 and Compose v5.3.1, staged the hash-matched
PR #273 origin artifacts root-owned under `/opt/revagent/deploy/phase1`, and passed configuration-only
Compose validation. No container or TCP 8081 listener was started. The stale Ookla Ubuntu 26.04 apt source
that blocked package-index refresh was moved to the reversible `.list.disabled` form and retained.

### 2026-07-22 — DP-12 NET01 live readiness evidence

Under R-G, the implementation assistant used the stored machine-specific SSH selector and proved that
`NET01` is reachable, idle, dedicated-capacity Windows 11 hardware with Revit 2022, the OpenAI Codex AppX,
the frozen revAgent stable package, and the protected rollback launcher present. Exact non-secret evidence is
retained in `DP-12-NET01-readiness-2026-07-22.md`.

The same read-only audit found that the installed `revAgent Auto Update` hidden launcher lacks `-AuditOnly`
and recorded task result `1`. The current source-side audit-only correction post-dates the installed frozen
package. No task, updater, installer, model, or direct repair was executed. GAP-13.2 scheduled-task proof and
DP-12 pilot readiness therefore remain open until a controlled technical-team neutralization/repair is
evidenced; this work is not assigned to the pilot user.

## Amendments

### 2026-07-22 — R-F: Phase-1 external client path (RES-23)

The operator selected the existing authorized ChatGPT/Codex Desktop client and made DP-6 inapplicable to
Phase 1. This supersedes WP3 P-CODEX-1, the INDEX's prior Claude-default candidate wording, and lower-plan
instructions that require the pilot to be fully off Codex or require a Gateway LLM key. Phase 1 removes the
legacy local stdio/NAS registrations, not the user-owned application, subscription, or session. revAgent
owns remote MCP registration and end-to-end conformance. The long-term D9 in-house-loop target is unchanged.
The normative amendment is RES-23 in `docs/implementation-plan/00-INDEX.md`.

### 2026-07-22 — R-F: bounded W1-4 `ci.yml` exception (RES-24)

WP5 P-CD-3 says Gateway CI/CD lands only in new workflow files, while the authoritative Week-1 task W1-4
requires one additive `gateway-gates` job in `.github/workflows/ci.yml`. RES-24 permits only that M0 addition
in PR #271. Existing jobs and the signed release workflow remain unchanged; subsequent Gateway CI/CD returns
to dedicated workflow files.

### 2026-07-22 — R-F: DP-2 fallback is a Phase-1 requirement (RES-25)

DP-2 confirms WSS primary with Streamable HTTP/SSE fallback. This supersedes WP1 P-O1-1's statement that
WSS is the sole Phase-1 transport and the fallback is not built. Both bindings share RBP semantics; the
fallback remains capability-gated and cannot enter the pilot until its binding and conformance evidence are
frozen. The normative amendment is RES-25 in `docs/implementation-plan/00-INDEX.md`.

### 2026-07-22 — R-G: mandatory operator task cards

Source: operator instruction from Barış Tankut, 2026-07-22. Every implementation report that leaves an
operator action MUST end with a separate `## OPERATÖR GÖREV KARTLARI` section. Every card carries exact
steps, gate rationale, deadline/blocking gate, evidence destination, and a one-message reply format.
Server-side work that is safely executable through the available `bt@192.168.90.154` SSH path belongs to
the implementing assistant, with retained command output. Only account authorization, physical/network
work, decisions, and user communications remain operator-owned. The permanent normative wording is R-G in
`docs/implementation-plan/00-INDEX.md` §8.
