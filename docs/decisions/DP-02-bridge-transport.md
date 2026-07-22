# DP-02 — Gateway-to-Bridge Transport

**Status:** Confirmed
**Decision date:** 2026-07-22
**Gate:** M0 / build entry
**Recorded choice:** WSS primary with Streamable HTTP/SSE fallback

## Decision

Phase 1 uses WSS as the primary transport and Streamable HTTP/SSE as the fallback for the internal RBP protocol. This is not the Gateway's north MCP transport; the Gateway-to-bridge hop remains internal RPC under D4.

## Why this default

- A persistent outbound WSS connection supports server-to-bridge dispatch, heartbeats, resume, and low-latency results over port 443.
- Streamable HTTP/SSE is a required, capability-gated fallback for proxy-hostile customer networks.
- Both transports use the same RBP envelope, sequence, acknowledgement, and journal semantics.

## Consequences

- Phase 1 implements and soaks WSS first, then proves the fallback before pilot use.
- O1 freezes the fallback binding and advertises its capability without coupling protocol meaning to WebSocket frames.
- Corporate proxy and TLS-interception behavior becomes a pilot test and a product-site diagnostic.

## Alternative

Streamable HTTP as the primary transport reduces WebSocket dependency but adds long-poll/stream lifecycle complexity before the office path proves it is needed.

## Change control

RES-25 and `DP-log.md` record the R-F amendment to WP1 P-O1-1. A different primary or removal of the fallback requires a dated amendment covering heartbeat, server-push, resume, and proxy-test implications.
