# DP-10 — Phase-1 Designer Client

**Status:** Selection confirmed; conformance pending
**Decision date:** 2026-07-22
**Gate:** Pilot entry
**Recorded choice:** Existing authorized ChatGPT/Codex Desktop client

## Decision

Phase 1 retains the existing authorized ChatGPT/Codex Desktop application as the daily client while replacing its legacy local stdio/NAS MCP path with revAgent's remote MCP registration. The selection is closed; pilot readiness is not.

## Responsibility boundary

- Client installation, subscription, updates, and user session are the user's responsibility.
- revAgent owns remote MCP registration instructions and end-to-end compatibility verification.
- The Gateway does not own the Phase-1 agentic loop and does not use an LLM API key.
- If conformance fails, pilot/cutover is blocked; another client requires a dated DP-10/R-F amendment.

## Required evidence

- MCP Streamable HTTP support
- OAuth compatibility, including the selected IdP's DCR behavior
- GAP-2 preview and single-use confirmation-token round trip
- Streaming and understandable error handling
- GAP-7 Excel/file ingress and exported-image access
- Turkish-friendly, non-developer UX
- User-owned subscription/session prerequisites and revAgent-owned support boundary
- Remote MCP registration, reconnect, update drift, and supportability

## Pilot binding

The pilot designer must use the selected client for at least five real working days fully off the legacy local stdio/NAS path before pilot exit.

## Open conformance gate

WP9 must attach hands-on Streamable HTTP, OAuth/DCR, confirmation, file/image, Turkish UX, reconnect, and live-Revit evidence before pilot/cutover. Operator selection is not evidence that those gates passed.
