# revAgent RBP Protocol

This package is the implementation boundary for the O1 bridge-to-Gateway contract:

- versioned JSON Schemas under `schemas/rbp/v1`
- generated TypeScript types under `src/generated`
- strict AJV validation
- raw UTF-8 parsing with duplicate-key rejection and normative byte caps
- RFC 8785 JCS `params_digest` and reconnect-backoff helpers
- bounded, language-neutral conformance vectors under `conformance/fixtures`

`schemas/rbp/v1/envelope.schema.json` is the public entry point. It references
`common.schema.json` and `payloads.schema.json`, covers every RBP/1 message type,
omits and rejects `v` on the pre-negotiation `hello`/`hello_ack` pair, requires
the selected `v` on every post-negotiation object, additionally requires `rsid`
and `seq` on session data, and rejects `rsid`, `seq`, and `ack` on
connection-control messages. A connection-level `error` is the explicit
exception carrier defined by the spec: it is unsequenced, permits only
`protocol` or `auth`, and cannot carry an `invocation_id`.

Run the package gates with:

```powershell
npm run lint --workspace @revagent/protocol
npm run typecheck --workspace @revagent/protocol
npm run test --workspace @revagent/protocol
npm run check:generated --workspace @revagent/protocol
```

The `test` command also builds and runs the bounded conformance harness. Its
JSON output reports the positive/negative envelope, raw-frame/byte-limit,
RFC 8785 digest, and reconnect-backoff vector counts. `validateRbpEnvelope`
checks an already-parsed object and therefore does not claim wire byte-limit
enforcement. Wire consumers must call `parseRbpFrame(Uint8Array)`, which also
rejects malformed UTF-8, BOMs, duplicate keys, and oversize values/frames.

The authoritative protocol document remains
`docs/specs/O1-bridge-gateway-protocol.md`. This package implements the M1
schema and pure-contract portion; it does not by itself prove the full v1.0
freeze. Transport interoperability, journal crash recovery, Gateway/Bridge
simulators, and real add-in evidence remain separate conformance gates.

The add-in-facing contract is versioned independently under
`schemas/addin-loopback/v1`. It fixes the loopback JSON-RPC response,
`mcp_status`, cached `get_document_context`, and atomic `execute_batch` shapes.
Golden positive/negative vectors live under `fixtures/addin-loopback/v1` and
are exercised by Vitest. These artifacts are schema/semantic prerequisites
only; they do not claim a running listener, Revit transaction, or M1
executable conformance result.
