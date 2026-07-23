# RBP/1 conformance evidence contract

This private workspace package owns the machine-readable evidence contract for
O1-T6. Its canonical manifest enumerates exactly the forty cases in
`docs/specs/O1-bridge-gateway-protocol.md` section 21. The package validates
run and three-run aggregate evidence, and generates deterministic JUnit XML.

It is deliberately an evidence contract and executable fail-closed runner, not
a conformance result. New run
reports created by `createUnexecutedRunReport` contain all forty cases with
`status: "not_run"`. `assertPassingRunReport` rejects that state, skipped or
otherwise nonterminal cases, false assertions, incomplete component identity,
missing hashes, stale expected/observed binaries, leak counters, or any
manifest/spec mismatch.

`executeSupervisedC19Run` is the first executable T6 slice. For each supported
binding it directly spawns a fresh Gateway stub, Bridge simulator, and add-in
loopback fixture as three separate OS child processes. The parent runner owns
PID/start/readiness/exit evidence, sends the framing vectors, reads fixture
execution counts, and derives C19 outcomes from those raw events. No injected
driver can provide `actual` or `passed`; those fields exist only in the
parent-owned evaluation section of `rbp-case-evidence/v2`. The reusable adapter
registry accepts raw observations only, while the separate parent-evaluator
registry owns predicates. Complete-suite validators fail until both registries
cover all forty canonical cases and both canonical bindings.

This slice deliberately does **not** claim the complete T6 suite. C19 may pass,
but the other 39 canonical cases remain explicit `not_run`, the run status is
`failed`, and the process/report exit code is nonzero. Full O1-T6 and M1 cannot
be green until real supervised executors exist for every case.

`CASE_CONTROL_OBSERVATION_MAP` is the ordered forty-case choreography catalog.
It pins the exact T3 fixture JSONL control, T4 Bridge JSONL control, T5 Gateway
HTTP control, and parent-owned raw transport/process primitives needed by each
case. Every canonical sub-vector is bound to named, same-case raw observations
and the parent runner owns its predicate. Choreography without a supervised
executor remains `not_run`; catalog presence alone is never executable
evidence.
`ParentStepEngine` is the generic parent-owned executor foundation for the
remaining programs. It resolves binding-specific arguments, performs strict
typed substitution and JSON-pointer captures, matches expected success/error/
HTTP/close outcomes, and supports explicit async-start, async-join, and barrier
semantics with deterministic evidence order. Driver outcomes and attached raw
observations are strict-schema checked before use; opaque wire/tool payloads
may contain ordinary domain fields named `actual` or `passed`, but neither a
driver outcome nor an observation envelope may declare the parent verdict.
Binding-specific raw WSS and Streamable HTTP/SSE frame drivers plug into the
parent-harness hook; they report wire facts only and cannot declare a
conformance verdict. A catalog step's `expectedOutcome` describes the parent
control operation, not the remote protocol verdict: a negative
`send_binding_frame` step succeeds when injection and capture complete, while
the peer's WSS close or HTTP response remains a raw wire observation for the
parent evaluator. The generic close/HTTP outcomes are reserved for driver
operations whose own terminal is that close/response. The complete
step/handle/capture/substitution graph is
preflighted before the first dispatch, inputs and resolved outcomes are
snapshotted, action/component/kind provenance is enforced, and parent-attached
step-to-observation lineage is retained for requirement resolution. Each step
has a catalog-owned deadline (including the longer C27 waits); cancellation
uses a real `AbortSignal` and requires the supervisor's separately bounded
abort-and-drain callback. Unresolved tokens, malformed outcomes, duplicate
captures or observations, unjoined handles, timeout, and incomplete cleanup
fail closed. Raw frame hooks permit the canonical C16 boundary payloads while
retained wire observations remain bounded digests/length metadata rather than
multi-megabyte frame copies.
The C19 binding programs begin with isolated fresh trios using exact
execution-plan entrypoint hashes. State from one binding is held in a private
temporary instance root and removed only after every spawned child exits.

## Parent-owned raw binding hooks

`createRawBindingStepHooks` installs binding-specific `send_binding_frame`
hooks for `createHarnessStepDriverWithRawBindingHooks`. The individual
`createRawWssBindingDriver` and `createRawHttpSseBindingDriver` factories are
also exported for a single binding. Each request accepts exactly one of a JSON
`frame` or a raw UTF-8 `serializedFrame`; the latter is the intentional
malformed-JSON injection path. A non-`hello` target requires an explicit
`openingHello` in the factory options or a per-step `hello`. Pre-negotiation
negative vectors set per-step `targetIsOpeningFrame: true`, which makes the
target the first WSS message or the HTTP create body instead. A per-step
`credential` may select an identity vector without retaining the token.

The WSS hook accepts only `wss://<numeric-loopback>:<port>/bridge/v1`. It
performs normal hostname/IP-SAN validation with `rejectUnauthorized: true`,
loads an explicitly named public test CA, verifies the SHA-256 of the exact CA
file bytes, and separately pins the presented DER leaf certificate. The
Streamable HTTP/SSE hook accepts only the exact numeric-loopback
`/bridge/v1/http/connections` route. It performs `POST` create, opens
`GET <connection>/events`, and then performs `POST <connection>/messages` for
a non-opening target. HTTPS uses the same CA and leaf-pin requirements;
cleartext HTTP is loopback-only and rejects TLS options.

Both hooks inherit the parent step deadline and `AbortSignal`, enforce bounded
outbound, response, frame-count, parsed-evidence, and settle limits, and fail
closed on local TLS, I/O, timeout, or evidence-bound failures. A completed
remote rejection is still a successful parent control operation:
`remoteOutcome` contains only bounded wire facts such as WSS frames/close or
HTTP status/body digest and SSE frames. The hooks retain `stepId`, `action`,
binding, direction, target byte count/SHA-256, frame source/type, credential
source, and monotonic capture time. They never emit `actual`, `passed`, or a
conformance verdict; only the parent evaluator may do that.

## Production C25-C40 catalog

`RAW_PRODUCTION_CASES` and `rawProductionCaseVariables` own the deterministic
C25-C40 seed range. The returned seed is a fresh clone for each binding and
contains exact UUIDv7 identities, RFC 8785 digests, schema-positive and
schema-negative frames, complete batch envelopes, bounded endpoint defaults,
and the raw artifact/chunk boundary vectors. Runtime callers may replace only
the ready endpoints and opaque credentials. `RAW_PRODUCTION_FRAME_FACTS`
binds every `send_binding_frame` step to its exact source, type, UTF-8 byte
count, and SHA-256; the parent oracle rejects any retained wire observation
that does not match those bytes.

O1-C32 deliberately does not use an independent raw-binding connection. Each
chunk vector starts a fresh current-stack session, dispatches one stalled
fixture invocation, snapshots the registered Gateway state, and asks the
registered Bridge simulator to send the exact negative response on its own
selected binding. The parent oracles require matching Bridge/Gateway session
and invocation identities plus exact Base64, missing-identifier, chunk-order,
decoded-byte, reconstruction-size, and content-digest facts on both bindings.

`createRawProductionBindingStepHooks` combines that catalog with the real
pinned WSS and HTTPS/SSE drivers. It injects a valid opening `hello` before
every non-hello target and selects the other enrolled device hello only for
the C25 cross-device probe. The harmless C30 reserialization vector is sent as
`serializedFrame`, so its deliberately different property/escape spelling is
not JSON-string encoded a second time.

`RAW_PRODUCTION_ORACLES` contains exactly the 110 canonical assertions from
C25 through C40. Each predicate consumes concrete wire metadata,
`remoteOutcome`, control-domain fields, or Gateway/Bridge/fixture snapshots;
a generic successful control response and child-owned `actual`, `passed`, or
`verdict` fields cannot source PASS. C33 loopback process probes and C40
product artifact evidence remain named, fail-closed supervisor dependencies
in `RAW_PRODUCTION_EXTERNAL_DEPENDENCIES`. They must be replaced by retained
supervisor evidence before the composed forty-case registry can pass.

Retained evidence belongs below
`artifacts/conformance/rbp-v1/1.0/`. The manifest defines the exact run,
JUnit, aggregate, log, trace, journal, and metric path templates. Nothing below
that path is committed by this scaffold and no case is synthesized as passed.
The supervised writer confines every target below that root, uses 0700
directories and 0600 files, and commits each file with exclusive temporary
creation, file fsync, atomic rename, and directory fsync on Linux.

## CLI

After `npm run build`, the package exposes:

```text
rbp-conformance prepare-production <execution-plan.json> --run-id <id> --sequence <1|2|3> [--repo-root <path>] [--node-executable <path>]
rbp-conformance run-production <execution-plan.json> [--repo-root <path>] [--artifact-root <path>] [--seed <seed>]
rbp-conformance validate-run <run-report.json> [--expected-commit <sha>] [--expected-tree <sha>]
rbp-conformance validate-aggregate <aggregate.json> [--expected-commit <sha>] [--expected-tree <sha>]
rbp-conformance validate-soak <soak-report.json> [--expected-commit <sha>] [--expected-tree <sha>]
rbp-conformance junit <run-report.json> <junit.xml>
rbp-conformance aggregate <run-1.json> <run-2.json> <run-3.json> [--artifact-root <path>]
rbp-conformance summary <aggregate.json> <summary.md>
rbp-conformance run-c19 <execution-plan.json> [--repo-root <path>] [--artifact-root <path>] [--seed <seed>]
rbp-conformance run-soak <execution-plan.json> --mode <smoke|one_hour> [--repo-root <path>] [--artifact-root <path>] [--duration-ms <ms>] [--cycle-interval-ms <ms>]
```

### Canonical production prepare runbook

Do not assemble a production plan from an existing ignored `dist` tree. From
the repository root, use the single preparation path:

```powershell
npm run prepare:rbp-production -- artifacts/conformance/rbp-v1/1.0/execution-plan.json --run-id <id> --sequence <1|2|3>
```

The wrapper first refuses a dirty Git tree, forces lifecycle scripts on only in
its child environment, removes Node/module-resolution injection variables,
and opens, queries, and closes the Bridge simulator's exact installed
`better-sqlite3` module under the selected runtime Node. It then deletes only
the ignored `rbp-conformance/dist` controller output, builds protocol and the
controller from source, and starts that freshly built CLI. The CLI validates
and hashes the toolchain before cleaning any component output. Protocol,
add-in loopback fixture, Gateway stub, and Bridge simulator are then compiled
exactly once through non-recursive `build:self` targets in a fixed DAG; every
npm child is bracketed by toolchain revalidation and later steps may not
rewrite upstream outputs. The freshly built controller bytes must remain
identical throughout the component build.

The resulting canonical deterministic v2 sidecar beside each launched
component binds the clean commit/tree and:

- every tracked compile input and every emitted component/protocol byte;
- the full `rbp-conformance/dist` runner/validator and protocol closure;
- every physically resolved installed runtime-package copy for the component
  and controller, including package files, workspace-link resolution,
  installed optional peers, explicit optional-peer absence, and native
  `.node` bytes;
- the exact launched runtime Node and build Node path, real path, SHA-256,
  version, platform, architecture, modules ABI, and N-API version;
- the npm launcher plus its complete installed package tree, the complete
  TypeScript package (including `lib/_tsc.js`), and the selected Git
  executable/version; on Windows, the canonical absolute PowerShell
  executable/version used for parent-owned resource sampling is bound too.

The selected runtime Node may differ from the build Node only when its complete
recorded identity is used consistently by every canonical component command.
No timestamp or filesystem mtime participates. Windows system DLLs and
kernel-level filesystem races are outside the application provenance
boundary; every repo/npm-controlled executable byte is inside it.

`prepare-production` verifies those sidecars before writing the plan. The plan
retains each sidecar hash and its compile/runtime/dependency/controller/tool
identity. Every production execution entrypoint (`run-production`, `run-c19`,
and `run-soak`) performs the full source/build-toolchain check at its boundary.
The launch guard then re-derives the canonical command and rechecks source,
sidecar, runtime Node, entrypoint, component/protocol/controller output, and
installed runtime/native dependency closure immediately before and after
component readiness and after supervised shutdown/cycle boundaries. Component
children inherit a sanitized environment without `NODE_OPTIONS`, `NODE_PATH`,
Node compile-cache/preserve-symlink controls, or `WS_NO_*` resolution switches.
A missing sidecar, stale source, stale binary, changed dependency/native byte,
unexpected optional peer, changed controller, command or Node substitution,
changed toolchain, sidecar tamper, or dirty tree fails closed before retained
PASS evidence can be produced.

Validation commands are pass gates: a structurally valid but partially
executed report still exits nonzero. `run-c19` also exits nonzero by design
because its retained report leaves 39 cases `not_run`. Fixture, simulator, and
stub commands are supplied by the versioned `ExecutionPlan`; the supervisor,
not an adapter or child process, performs every spawn and evaluation.

`run-soak` starts and retains two independent production trios, one for WSS
and one for Streamable HTTP/SSE. Both trios stay alive for the whole run while
the parent alternates real socket backpressure, heartbeat acknowledgement,
Bridge restart/reconnect/resume, control-plane probes, and six-process resource
sampling. `one_hour` is hard-coded to 3,600,000 monotonic milliseconds and
rejects a duration override.

## Retained evidence rules

Pass validation with `verifyArtifactFiles: true` reads every artifact beneath
the canonical retained root after resolving the real path. A lexical path,
symlink, junction, or Windows reparse point that resolves outside that root is
rejected. Required evidence is never allowed to be zero bytes.

- `wire_trace` is UTF-8 JSON Lines using `rbp-wire-trace/v1`; each row binds the
  run, case, binding, status, and in-case timestamp.
- Legacy `journal_snapshot` documents remain readable as
  `rbp-case-evidence/v1`. New supervised `case_evidence` uses
  `rbp-case-evidence/v2`, separating raw same-run/same-case observations from
  the `parent_runner` evaluation section and retaining exact
  component/binding/process identity.
  Every required assertion must identify
  exactly one same-case artifact by SHA-256, and that artifact must contain the
  exact canonical assertion id, sub-vector id, statement, category, result,
  expected value, actual value, and resolvable observation-id tuple.
- `component_log` is one `rbp-component-log/v1` JSON Lines terminal record that
  matches the observed executable identity and process interval.
- `leak_metrics` is `rbp-conformance-leaks/v1` JSON and must exactly match the
  report timing, raw samples, and derived fd/memory/journal/orphan-process
  counters. RSS is evaluated from measured post-warmup growth and least-squares
  slope against the versioned 64 MiB / 2 MiB-per-second bounds; it is not held
  to an unrealistic exact-zero delta. FD growth, journal-pending growth, and
  orphan processes remain zero-tolerance.
- `junit` and `aggregate_junit` are parsed for totals, case ids, and statuses,
  then byte-compared with the deterministic generator output.

An aggregate embeds each run's manifest/spec, source commit/tree, component
identities, bindings, and exact timestamps in addition to the retained report
path and SHA-256. Pass validation reopens those three reports, verifies their
hashes and artifacts, compares every embedded field and case status, rejects
mixed stacks, and requires strictly ordered non-overlapping intervals.
The `aggregate` CLI command verifies all three retained source reports, writes
the canonical aggregate JUnit file, binds its path/hash/size into the aggregate,
and subjects the result to the same full retained-evidence validation before it
writes the aggregate JSON. It accepts no output filename: `--artifact-root`
selects the filesystem root (the current directory by default), and the command
always derives both outputs as
`artifacts/conformance/rbp-v1/1.0/aggregate/junit.xml` and
`artifacts/conformance/rbp-v1/1.0/aggregate/three-run-report.json`. The
aggregate binds the latter as `reportPath`; validation rejects a copied report
at any other location.

## Reconnect and proxy-churn soak

`runReconnectSoak` alternates real WSS and Streamable HTTP/SSE reconnect/proxy
churn cycles, retains one raw metric row per cycle, samples resources, and
computes status itself. `smoke` accepts a bounded 30-second through 10-minute
duration; `one_hour` is fixed at exactly 3,600,000 requested milliseconds. Both
bindings, reconnect, proxy churn, heartbeat acknowledgement, control traffic,
zero pending journal state, bounded resource samples, and zero orphans are
required. `validate-soak` reopens and hashes the retained JSONL metrics before
accepting a report.
