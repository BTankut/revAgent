# DP-02 — Gateway-to-Bridge Transport

**Status:** Awaiting operator confirmation
**Gate:** M0 / build entry
**Recommended default:** WSS primary with Streamable HTTP fallback

## Decision

Select the Phase-1 transport instantiation for the internal RBP protocol. This is not the Gateway's north MCP transport; the Gateway-to-bridge hop remains internal RPC under D4.

## Why this default

- A persistent outbound WSS connection supports server-to-bridge dispatch, heartbeats, resume, and low-latency results over port 443.
- Streamable HTTP is reserved as a transport-compatible fallback for proxy-hostile customer networks.
- Both transports use the same RBP envelope, sequence, acknowledgement, and journal semantics.

## Consequences

- Phase 1 implements and soaks WSS first.
- O1 advertises fallback capability without coupling protocol meaning to WebSocket frames.
- Corporate proxy and TLS-interception behavior becomes a pilot test and a product-site diagnostic.

## Alternative

Streamable HTTP as the primary transport reduces WebSocket dependency but adds long-poll/stream lifecycle complexity before the office path proves it is needed.

## Confirmation prompt

Approve WSS primary plus Streamable HTTP fallback, or record a different primary and its heartbeat, server-push, resume, and proxy-test implications.
