# DP-06 — LLM Provider, Models, and Region

**Status:** Not applicable to Phase 1
**Decision date:** 2026-07-22
**Gate:** None in Phase 1
**Recorded choice:** The authorized ChatGPT/Codex Desktop client owns the Phase-1 agentic loop; the Gateway has no LLM API key

## Decision

Phase 1 uses the external-client path permitted by D9. The Gateway serves the remote MCP surface and does not run the in-house agentic loop, select a provider/model, or store an LLM API key.

## Phase-1 boundary

- Client installation, subscription, provider access, and user session are user responsibilities.
- revAgent owns remote MCP registration and end-to-end compatibility verification.
- Compose and Gateway configuration MUST NOT require `LLM_API_KEY` or provider/model settings in Phase 1.
- The long-term D8/D9 provider abstraction and in-house-loop target remain deferred implementation work, not deleted architecture.

## Consequences

- DP-6 is removed from the Phase-1 pilot-entry gate by RES-23.
- A later in-house-loop milestone must reopen provider/model/region/quota choices before it introduces any Gateway LLM credential.
- A failed client conformance run blocks pilot/cutover; it does not authorize a silent Gateway-loop fallback.

## Change control

RES-23 and `DP-log.md` record this bounded Phase-1 amendment. Introducing a Gateway LLM key during Phase 1 requires a new dated R-F amendment and explicit operator approval.
