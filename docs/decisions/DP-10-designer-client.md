# DP-10 — Phase-1 Designer Client

**Status:** Awaiting evaluation; no default is approved
**Gate:** Pilot entry
**Recommended process:** Complete the WP9 evaluation matrix before selecting a client

## Decision

Select the daily client that designers open after the Codex-local runtime is retired. The client must be validated as part of the production stack, not treated as an interchangeable UI.

## Required evidence

- MCP Streamable HTTP support
- OAuth compatibility, including the selected IdP's DCR behavior
- GAP-2 preview and single-use confirmation-token round trip
- Streaming and understandable error handling
- GAP-7 Excel/file ingress and exported-image access
- Turkish-friendly, non-developer UX
- Per-seat cost and licensing owner
- Fleet install, login, MCP registration, update, and supportability

## Pilot binding

The pilot designer must use the selected client for at least five real working days fully off the old Codex path before pilot exit.

## Confirmation prompt

Do not choose from reputation alone. Attach the completed WP9 matrix and conformance result, then record the selected client, license owner, supported workflows, and accepted gaps in `DP-log.md`.
