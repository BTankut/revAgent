# RevAgent RBP Protocol

This package is the implementation boundary for the O1 bridge-to-Gateway contract:

- versioned JSON Schemas under `schemas/rbp/v1`
- generated TypeScript types under `src/generated`
- strict AJV validation
- pure helpers shared by the Gateway and conformance fixtures

The authoritative draft is `docs/specs/O1-bridge-gateway-protocol.md` on its WP1 PR. This W1-2 scaffold contains only the envelope seed and the RES-21 idempotency helper; message-specific payload schemas and state machines arrive after the v0.9 review.
