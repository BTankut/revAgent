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
  bindings and explicit rejection of bridge-claimed principal/seat fields;
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
implements and advertises only the RBP/1 bootstrap wire. RBP/1 is the explicit
compatibility-window exception until RBP/2 exists. A v2-only opening remains
fail-closed with `4426`/HTTP `426` and a pointer whose supported range is
exactly `1..1`; the stub never pretends that changing only the version integer
implements RBP/2. `--supported-protocols` is retained for harness identity but
accepts only `1` until a real RBP/2 adapter and vectors exist.

The exact fallback endpoints are:

- `POST /bridge/v1/http/connections`
- `GET /bridge/v1/http/connections/{connection_id}/events`
- `POST /bridge/v1/http/connections/{connection_id}/messages`

The loopback-only `POST /__rbp_test/control` surface requires
`X-RBP-Test-Control`. It can inject opening responses, drop/duplicate/delay/hold
frames, buffer/flush SSE, force disconnect/expiry, install scope holds, submit
T2-validated verification or late-terminal journal evidence, dispatch work,
start an explicit digest-bound `dispatch_payload_recovery`, and return a
redacted durable snapshot. A held or delayed HTTP uplink keeps its POST pending;
it receives `202` only after `flush_held` or the delay timer actually delivers
and durably processes the frame. Drop, shutdown, or connection cleanup before
delivery leaves acceptance unknown and closes the request without a success.
Connection cleanup cancels pending public completions synchronously, closes the
transport to release pending I/O, waits for every real delivery callback on that
connection, and only then records the durable disconnect. Concurrent close paths
share one connection promise. Whole-stub shutdown completes every connection,
listener, and core barrier before reporting any aggregated cleanup error.
Control commands use exact action-specific shapes. Dispatch payloads pass the
real RBP/1 envelope validator, evidence records pass the journal-integrity
validator, fault message names must be reachable in their selected direction,
and buffering rejects unknown fallback connections without retaining phantom
state.
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
device credential or control token. Durable session snapshots likewise retain
token digests and derived identity only, never raw credentials. The runtime
`authorizationAudit` snapshot surface is versioned and capped at 256 entries; it records
only operation/decision/reason, hashed connection/device identities, and the
names (never values) of rejected claimed-identity fields.
Signal handlers remain installed across repeated or mixed SIGINT/SIGTERM bursts
until the one shared shutdown promise settles; every programmatic close caller
receives that same completion or rejection.

Run locally:

```powershell
npm run build --workspace @revagent/protocol
npm test --workspace @revagent/gateway-stub
node packages/gateway-stub/dist/cli.js --state .tmp/rbp-gateway-stub.json
```

This package proves only the O1 test peer. It does not implement WP2 Gateway
storage/resources, OIDC, production auth, north MCP, or deployment behavior.
