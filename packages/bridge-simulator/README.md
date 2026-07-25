# Bridge simulator

O1-T4 implementation-independent, headless Bridge reference core. It consumes
the pure `@revagent/protocol` state machines and the actual O1-T3 add-in
loopback fixture contract. It is conformance code, not the production .NET 8
Bridge service and not an in-house agent/LLM loop.

The simulator provides:

- bounded numeric-loopback discovery (explicit target or ports 8080–8085),
  one persistent framed TCP connection per accepted Revit fixture session, and
  an explicit audit proof that no temp registry path was read;
- a `better-sqlite3` reference journal in WAL/FULL mode with durable ordering,
  exact invocation/batch bindings, persistent sequence outboxes, and a
  distinct durable mutation-hold relation;
- restart/pending-expiry classification, terminal and late-evidence replay,
  correlated verification and evidence-bound one-envelope clearance;
- WSS-primary and exact HTTP/SSE create/events/messages client bindings that
  feed one transport-neutral RBP engine, including session register/resume/
  unregister, heartbeat liveness, bounded document-context polling, and the
  8 MiB outbound data backpressure boundary;
- chunk/artifact reconstruction, durable acknowledgement-driven cleanup,
  heartbeat/backoff helpers, cancellation, and deterministic crash injection;
- versioned backpressure samples taken from the active transport's real
  `bufferedAmount`, bounded per-invocation chunk/progress counters, and
  fail-closed retained-carrier evidence that exposes descriptors/digests but
  never the spool root, retained directories, or local file paths.

Run the focused tests and three-run determinism gate:

```console
npm test --workspace @revagent/bridge-simulator
npm run test:determinism --workspace @revagent/bridge-simulator
```

The `crash-recovery` CLI command emits a deterministic JSON evidence record.
It never installs, deploys, enrolls, or connects to a production Gateway.

## Long-lived control daemon

`node dist/cli.js daemon` starts the headless T6-facing process. Pass an
absolute, non-root `--state-root PATH` (or set `REVAGENT_BRIDGE_STATE_ROOT`)
to retain the SQLite journal and artifact spool across process restarts. An
explicit state root is never deleted by the daemon. Without one, the daemon
uses a private temporary root and removes it only after the runtime and journal
close; cleanup failure is a non-zero daemon shutdown.

Standard output contains only strict, correlation-preserving JSONL. The first record is
the readiness contract; every subsequent request has this base shape:

```json
{"controlVersion":1,"id":"runner-correlation","action":"snapshot_evidence"}
```

Success is `{controlVersion,id,ok:true,result}`. Failure is
`{controlVersion,id,ok:false,error:{code,message}}`. Input and output records
are each bounded to 64 KiB. Duplicate JSON keys, unknown action fields,
non-finite/unsafe numeric values, and trailing JSON are rejected. The daemon
does not accept `run_case` and does not produce a self-declared `passed` value;
the T6 parent runner owns all assertions. Independent controls may execute
concurrently. Lifecycle mutations, crash planning, clock changes, evidence
snapshots, restart, and shutdown are barriers. Responses remain in accepted
input order and pass through one atomic JSONL writer.

Action fields, in addition to the base fields, are exact:

| Action | Required fields | Optional fields |
| --- | --- | --- |
| `discover_fixture` | — | `host`, `port`, `firstPort`, `lastPort`, `probeTimeoutMs` |
| `attach_fixture_session` | `probeIndex`, `rsid`, `resumeToken`, `resumeExpiresAt`, `userHint`, `hostname`, `fingerprint`, `bridgeVersion` | `grantedSessionCapabilities` |
| `open_transport` | `kind`, `deviceToken`, `hello` | `wssUrl`, `fallbackUrl`, `fallbackProvisioned` as required by the selected kind; `endpointPolicy`; `tlsTrust` |
| `start_run_loop` | — | — |
| `session_register` | `probeIndex`, `userHint`, `hostname`, `fingerprint`, `bridgeVersion` | — |
| `session_resume` | `rsid` | — |
| `session_unregister` | `rsid`, `reason` | — |
| `tick` | `nowMs` | — |
| `poll_document_context` | `rsid` | `force` |
| `flush_outbound` | — | `rsid` |
| `invoke_local` | `envelope` | `crashAt` |
| `record_verification_attempt` | `rsid`, `holdId`, `verificationInvocationId`, `evidenceDigest`, `conclusion`, `atMs` | — |
| `record_late_evidence` | `rsid`, `holdId`, `originInvocationId`, `evidenceDigest`, `conclusion`, `atMs` | — |
| `resolve_hold` | `rsid`, `holdId`, `basis`, `verificationInvocationId`, `evidenceDigest`, `decision`, `resolutionId`, `auditId`, `authorizedDispatchIdentity`, `atMs` | — |
| `clearance_for_hold` | `rsid`, `holdId` | — |
| `inject_crash` | `point` | — |
| `restart_simulator` | — | — |
| `configure_reconnect_conformance` | `mode`, `jitterUnits` | — |
| `advance_reconnect_conformance_clock` | `advanceByMs`, `heartbeatStepMs` | — |
| `send_chunk_conformance` | `vector`, `rsid`, `invocationId` | — |
| `snapshot_soak_status` | — | — |
| `snapshot_evidence` | — | continuation-only `snapshotId` and `cursor` |
| `shutdown` | — | — |

`hello` has exact fields `id`, `ts`, `bridgeVersion`, `deviceId`, `hostname`,
and `os`, with optional `fingerprint`. `kind` is `wss`,
`streamable_http_sse`, or `primary_then_fallback`. When present,
`endpointPolicy` is `loopback_test_readiness` for the cleartext numeric-
loopback T5 readiness surface or `loopback_test_tls` for the real WSS
conformance surface; omission retains the fail-closed production URL policy.
The TLS policy is accepted only with `kind=wss`, a numeric-loopback URL with
an explicit port, and exact `tlsTrust` fields `caCertificatePath`,
`caCertificateSha256`, and `serverCertificateSha256`. The Bridge reads the
absolute public-certificate path, verifies the exact file-byte digest, keeps
normal TLS authorization enabled, performs the IP SAN check, and pins the
Gateway leaf DER digest. The trust object is rejected by production,
cleartext-readiness, HTTP/SSE, fallback, and custom-WebSocket-factory paths.
Evidence records the resolved certificate path and both digests, never private
key material. Evidence pages are immutable
and expose redacted journal/hold/durability/sequence/session facts plus Bridge
peer and transport state. `peer.backpressure`, `peer.deliveryProgress`, and
`artifactSpool` are versioned/bounded evidence surfaces; artifact evidence is
rehydrated through the ordinary containment, non-reparse, size, and digest
guards before being returned. Snapshot pages carry at most one retained carrier;
descriptor content-type text is capped at 128 characters with its full digest
and truncation flag retained. Shutdown closes transports, loopback clients, the
run loop, and SQLite, then reports the corresponding zero-leak counters.

`snapshot_soak_status` is the bounded, read-only liveness surface used by the
long-running soak observer. Its result uses
`schemaVersion: "bridge-simulator-soak-status/v1"`, reports
`journalPendingCount` for the non-terminal `received`, `executing`, and
`indeterminate` journal states, and returns the compact `peer` snapshot (or
`null`). It performs a direct journal count and does not create or retain an
evidence-snapshot lease.

The reconnect conformance controls are an explicit test-only clock/RNG seam.
`configure_reconnect_conformance` is accepted exactly once and only before
`open_transport`; its mode must be `deterministic_virtual_clock` and every
bounded jitter sample must be in `[0,1)`. Only that configured path replaces
the peer's normal `Math.random` and real timer with deterministic sampling and
a virtual sleep. `advance_reconnect_conformance_clock` remains gated on a real
successful reconnect and live run loop, advances through at most 30-second
heartbeat steps, waits for real Gateway heartbeat acknowledgements, and refuses
to move beyond the 120-second steady boundary. Snapshot evidence reports the
actual zero-based reconnect callback/sleep trace and peer reset transitions;
it never reports a verdict or a self-declared pass.

`send_chunk_conformance` is a narrow T6-only negative-vector seam. It requires
the exact stalled invocation of a locally registered Bridge session whose peer
is registered and dispatch-enabled on the current Gateway binding. The
simulator generates one bounded O1-C32 fixture, sends any schema-valid prefix
through the ordinary binding, and sends only the expected-fault frame through
the conformance seam. Its result retains the pre-fault connection/session
identity, sequence basis, frame byte counts/digests, decoded-size and terminal
descriptor facts, and the authenticated Gateway protocol rejection. It cannot
be used by production invocation delivery and does not emit a verdict.
