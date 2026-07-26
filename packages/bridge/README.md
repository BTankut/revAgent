# RevAgent Bridge

This package is the WP3 boundary for the thin desktop Bridge selected by DP-1.
The executable targets .NET 8. `RevAgent.Contracts` targets `netstandard2.0`
so the same additive framing and contract code can later be referenced by the
existing .NET Framework add-in under the bounded P3-T6 migration-freeze
exception.

The current P3-T1/P3-T2/P3-T3a/P3-T4a reducer slices contain the contract
primitives, the bounded Windows service skeleton, the strict one-call add-in
transport, and transport-independent RBP state:

- the existing add-in TCP length-prefix and strict JSON-RPC contract;
- the frozen RBP/1 display and document-context mapping boundary; and
- the detached RS256 distribution-signature verification contract;
- the stable Windows service Host and supervised Worker split;
- strict `bridge-config.json` with the frozen 8080-8085 add-in discovery range
  plus an allowlisted `REVAGENT_BRIDGE_ADDIN_PORT` single-port override;
- structured rolling JSON-file logging and lifecycle Event Log integration;
- public Host CLI routing for `install`, `uninstall`, `run --console`, and
  `doctor`; and
- win-x64 self-contained single-file publishing for both executables;
- numeric IP-loopback-only add-in targets with no hostname, wildcard, LAN, or
  remote escape;
- length-prefixed-only add-in calls with ordinal-exact invocation-id
  correlation and per-call deadlines that start before request serialization
  and prevent later dispatch or socket I/O once expired; and
- transport evidence that distinguishes not-started, possibly-dispatched, and
  response-observed failures without retrying an uncertain call; caller
  cancellation is honored before dispatch, while a possibly-dispatched call
  remains observed until its bounded deadline for later journal evidence;
  worker shutdown has a separate token that closes transport at any phase
  without erasing dispatch uncertainty;
- a strict UTF-8 RBP/1 outer-envelope codec that rejects BOMs, binary frames,
  duplicate keys, trailing JSON, unsafe sequence integers, invalid
  pre-/post-negotiation forms, and frozen byte-limit violations;
- RFC 8785 canonical JSON plus frozen parameter, batch, and immutable data
  envelope digests (where `ack` and `ts` are the only mutable retransmission
  fields); and
- pure per-`rsid` sequence/ack/dispatch-window reducers and
  connection/session lifecycle reducers, including frozen heartbeat and
  full-jitter retry rules.

It does not yet provide add-in discovery/session routing, the Gateway
transport, journal, enrollment, workstation installer payload, or update
behavior. Those land through separate WP3 PRs in the order fixed by
`docs/implementation-plan/03-bridge-addin-installer.md`.

Run the complete P3-T1 contract gate from the repository root:

```powershell
.\scripts\test-bridge-contracts.ps1
```

The gate validates .NET framing and mapping behavior against the frozen
TypeScript schemas/fixtures and verifies a freshly generated Windows
PowerShell 5.1 RS256 signature with the .NET implementation.

Run the P3-T2 non-admin service-skeleton gate from the repository root:

```powershell
.\scripts\test-bridge-service.ps1
```

This gate performs a locked restore, Release build/tests,
`dotnet format --verify-no-changes`, and isolated win-x64 self-contained
single-file publishes. It requires each publish directory to contain exactly
its expected executable and no DLL, `.deps.json`, `.runtimeconfig.json`, or PDB
sidecars. Both executables receive a bounded hidden `--version` smoke.

The doctor smoke invokes the published Worker's internal `__doctor` entry
point directly because an isolated Host publish deliberately has no installed
`versions\current` Worker layout. The gate clears inherited
`REVAGENT_BRIDGE_*` variables, generates a strict temporary config, and places
bare loopback TCP listeners at the configured Gateway and add-in ports. A valid
config must produce one `revagent-bridge-doctor/v1` JSON object with
`success=true`; the bare listeners must remain
`gateway.rbpAuthenticated=false` and `addin.shapeVerified=false`. This proves
bounded diagnostic behavior only. It does not prove an RBP handshake, Gateway
authentication, add-in framing, command shape, or Revit integration.

P3-T2's SCM and machine-lifecycle acceptance remains VM-only operator evidence:

- install the service under the canonical account and start it through SCM;
- prove clean SCM stop within 10 seconds;
- reboot the VM and prove the service and supervised Worker recover;
- verify lifecycle entries under the registered Windows Event Log source; and
- drive enough structured logs to prove rotation and retention on the installed
  ProgramData path.

The P3-T3a transport tests use a deterministic test-only TCP peer. They cover
fragmented frames, exact response correlation, request/response bounds,
pre-dispatch cancellation, post-dispatch outcome preservation, deadline
expiry, worker shutdown, partial-response EOF, and connection failure. The
production transport opens one short-lived loopback connection per call, sends
no legacy JSON, performs no automatic retry, and never runs an `mcp_status`
preflight.
Deterministic mid-write process-kill and partial-write journal fault injection
belongs to the later P3-T13 harness; this slice records the evidence fields but
does not claim that fault-injection proof.
Frozen-shape discovery, two-session routing, and fixture-backed traffic
evidence land in the following P3-T3 slices; live Revit command evidence
remains blocked until the P3-T6 adapted add-in is installed.

The P3-T4a codec and reducer tests consume the frozen RBP envelope,
parameter-digest, batch-digest, frame-limit, and reconnect vectors with pinned
source hashes. They prove only the local .NET codec,
canonicalization/digest behavior, UUIDv7 generation, and pure
sequence/ack/dispatch-window and connection/session lifecycle transitions. The
envelope fixture coverage intentionally proves all positive outer shapes plus
the structural, hello/hello-ack, and session-authority negative subset;
message-specific invocation/result/batch semantics remain owned by the frozen
protocol validators and later execution slices.

This evidence does not prove a WSS or Streamable HTTP/SSE binding, TLS or
device-token authentication, a live Gateway handshake, durable sequence or
session persistence, Gateway session registration/resume, T5 journal
ordering/redelivery, reconnect I/O, or production Gateway interoperability.
