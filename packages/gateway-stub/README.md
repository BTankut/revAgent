# RBP Gateway Stub

`@revagent/gateway-stub` is the deterministic, test-only O1-T5 peer for the
RBP/1 conformance harness. It is deliberately separate from
`@revagent/gateway`: importing or starting this package does not register a
north MCP surface, load the production tool catalog, connect to an LLM, or
create an in-house agent loop.

The stub provides:

- WSS-primary upgrade semantics and the exact HTTP create/SSE events/HTTP
  messages fallback lifecycle;
- static, revocable test-device identities with derived tenant/user/seat
  bindings;
- durable session, sequence, acknowledgement, outbox, resume, in-flight,
  recovery-hold, chunk, and artifact-carrier state;
- authoritative per-`rsid` invocation window enforcement;
- three-way capability enforcement at each consuming boundary (provisioned
  device capability, Bridge declaration, and Gateway/session grant);
- deterministic dispatch/control APIs plus drop, duplicate, delay, hold,
  forced-EOF, proxy-buffer, opening-response, expiry, and recovery-scope fault
  controls;
- a process CLI that prints one machine-readable readiness record.

Pre-negotiation WSS sockets and fallback connections that never attach their
SSE stream expire after bounded deadlines. Version mismatch closes WSS with
4426, while `goodbye` closes the underlying transport with 1000. The fallback
listener accepts literal loopback IP addresses only; hostnames are rejected so
name resolution cannot silently widen the bind surface.

Sequence/ack retention, dispatch-window enforcement, connection/session
lifecycle transitions, mutation-hold authorization, journal-attested evidence,
and stream assembly are imported from `@revagent/protocol`. The stub persists
those T2 state objects directly; the only carrier adapter converts retained
`Uint8Array` chunks to canonical Base64 for the JSON state file. There is no
second Gateway-specific FSM implementation.

The default listener is loopback-only and plaintext for local CI. Supplying a
certificate and private key starts the same server over TLS and changes the
advertised URLs to `wss://` and `https://`.

The normative pre-negotiation `hello` and `hello_ack` omit top-level `v`; all
later messages require the selected version. Both bindings call the corrected
`@revagent/protocol` parser/validator at the raw frame boundary. This M1 stub
implements the RBP/1 bootstrap wire. A test deployment may advertise an N/N-1
window such as `[2,1]` to prove that an RBP/1 bridge still selects and receives
RBP/1. A v2-only `hello` remains fail-closed with `4426`/HTTP `426` and the
manifest pointer until a real RBP/2 adapter and vectors exist; the stub never
pretends that changing only the version integer implements RBP/2.

The exact fallback endpoints are:

- `POST /bridge/v1/http/connections`
- `GET /bridge/v1/http/connections/{connection_id}/events`
- `POST /bridge/v1/http/connections/{connection_id}/messages`

The loopback-only `POST /__rbp_test/control` surface requires
`X-RBP-Test-Control`. It can inject opening responses, drop/duplicate/delay/hold
frames, buffer/flush SSE, force disconnect/expiry, install scope holds, submit
T2-validated verification or late-terminal journal evidence, dispatch work,
start an explicit digest-bound `dispatch_payload_recovery`, and return a
redacted durable snapshot. A held HTTP uplink is transport-accepted with `202`;
its durable sequence state advances only when `flush_held` delivers the frame.
When the CLI starts with `--clock-start-ms`, `set_clock` plus
`liveness_sweep` drives the same deterministic liveness transitions without
wall-clock sleeps. Evidence submission deliberately requires both the
accepted digest-bound terminal and the complete simulator journal record; an
uncorrelated result digest cannot advance a hold. Recovery-clearance holds stay
`resolved_pending_bridge` until the Bridge durably acknowledges the authorized
dispatch. Gateway expiry preserves the original terminal classification and
retains any later Bridge terminal as evidence. Post-cancel success is retained
as evidence but is not exposed as ordinary success.

The CLI accepts explicit `--supported-protocols`,
`--connection-capabilities`, `--session-capabilities`, and `--clock-start-ms`
test-harness overrides. Unknown or duplicate options fail before readiness.
The readiness record identifies the component, configured protocol window,
control-contract version, deterministic-clock mode, control authentication
header, endpoints, PID, and supported shutdown signals. It never contains the
device credential or control token. Durable snapshots likewise retain token
digests and derived identity only, never raw credentials.

Run locally:

```powershell
npm run build --workspace @revagent/protocol
npm test --workspace @revagent/gateway-stub
node packages/gateway-stub/dist/cli.js --state .tmp/rbp-gateway-stub.json
```

This package proves only the O1 test peer. It does not implement WP2 Gateway
storage/resources, OIDC, production auth, north MCP, or deployment behavior.
