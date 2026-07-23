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
rbp-conformance prepare-production <execution-plan.json> --run-id <id> --sequence <1|2|3> --git-executable <absolute-path> [--repo-root <path>] [--node-executable <path>]
rbp-conformance run-final-evidence --plan-1 <plan.json> --plan-2 <plan.json> --plan-3 <plan.json> --soak-plan <plan.json> --repo-root <path> --artifact-root <path> [--expected-commit <sha>] [--expected-tree <sha>]
rbp-conformance run-production <execution-plan.json> [--repo-root <path>] [--artifact-root <path>] [--seed <seed>]
rbp-conformance validate-run <run-report.json> --plan <execution-plan.json> --repo-root <path> [--artifact-root <path>] [--expected-commit <sha>] [--expected-tree <sha>]
rbp-conformance validate-aggregate <aggregate.json> --plan-1 <plan.json> --plan-2 <plan.json> --plan-3 <plan.json> --repo-root <path> [--artifact-root <path>] [--expected-commit <sha>] [--expected-tree <sha>]
rbp-conformance validate-soak <soak-report.json> --plan <soak-plan.json> --aggregate <aggregate.json> --plan-1 <run-1-plan.json> --plan-2 <run-2-plan.json> --plan-3 <run-3-plan.json> --repo-root <path> [--artifact-root <path>] [--expected-commit <sha>] [--expected-tree <sha>]
rbp-conformance junit <run-report.json> <junit.xml>
rbp-conformance aggregate <run-1.json> <run-2.json> <run-3.json> --plan-1 <plan.json> --plan-2 <plan.json> --plan-3 <plan.json> --repo-root <path> [--artifact-root <path>]
rbp-conformance summary <aggregate.json> <summary.md>
rbp-conformance run-c19 <execution-plan.json> [--repo-root <path>] [--artifact-root <path>] [--seed <seed>]
rbp-conformance run-soak <execution-plan.json> --mode <smoke|one_hour> [--repo-root <path>] [--artifact-root <path>] [--duration-ms <ms>] [--cycle-interval-ms <ms>]
```

### Canonical production prepare runbook

Do not assemble a production plan from an existing ignored `dist` tree. Every
production prepare and the sole PASS-capable final command begin in the tracked
external launcher under the exact SystemRoot Windows PowerShell. That
launcher removes Node and `ws` resolution overrides before the exact reviewed
Node executable can load any production JavaScript. Before any production
controller import, the child uses a separate exact SystemRoot Windows
PowerShell probe and `GetNamedPipeServerProcessId` to prove that its
current-user-only authentication pipe is owned by its OS parent. The probe
returns the parent's OS executable and `Win32_Process.CommandLine`; the child
requires the exact `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File
<canonical invoke-production.ps1>` argument vector. The launcher independently
uses `GetNamedPipeClientProcessId` on both the authentication connection and
the second one-shot receipt connection, and requires the receipt client to be
the Node PID it started. The receipt binds that OS handoff to the exact argv,
launcher/Node/entrypoint paths, and their SHA-256 identities. The tracked CLI
bootstrap validates the receipt before importing the freshly built controller.
Do not enter the canonical path
through `npm run`, an npm lifecycle, a shell bin shim, the `rbp-conformance`
bin, or a direct Node-to-CLI invocation:

```powershell
$RepoRoot = (Resolve-Path -LiteralPath '.').Path
$BoundNode = 'C:\Program Files\nodejs\node.exe'
$NpmCli = 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js'
$PowerShell = Join-Path `
  ([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)) `
  'System32\WindowsPowerShell\v1.0\powershell.exe'
$EvidenceRoot = 'C:\Users\BT\Projects\revAgent-freeze-evidence\rbp-v1.0-<sha12>-s01'
$PlanRoot = Join-Path $EvidenceRoot 'artifacts\conformance\rbp-v1\1.0\plans\rbp-v1.0-<sha12>-s01'
$Launcher = Join-Path $RepoRoot 'packages\rbp-conformance\scripts\invoke-production.ps1'
$Wrapper = Join-Path $RepoRoot 'packages\rbp-conformance\scripts\prepare-production.mjs'
$CliBootstrap = Join-Path $RepoRoot 'packages\rbp-conformance\scripts\production-cli-bootstrap.mjs'

$PlanR1 = Join-Path $PlanRoot 'run-1.execution-plan.json'
$PlanR2 = Join-Path $PlanRoot 'run-2.execution-plan.json'
$PlanR3 = Join-Path $PlanRoot 'run-3.execution-plan.json'
$PlanSoak = Join-Path $PlanRoot 'soak-one-hour.execution-plan.json'

& $PowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File $Launcher -NodeExecutable $BoundNode -Entrypoint $Wrapper `
  --npm-executable $NpmCli $PlanR1 `
  --run-id 'rbp-v1.0-<sha12>-s01-r1' --sequence 1 `
  --repo-root $RepoRoot --node-executable $BoundNode
if ($LASTEXITCODE -ne 0) { throw 'r1 prepare failed' }
& $PowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File $Launcher -NodeExecutable $BoundNode -Entrypoint $Wrapper `
  --npm-executable $NpmCli $PlanR2 `
  --run-id 'rbp-v1.0-<sha12>-s01-r2' --sequence 2 `
  --repo-root $RepoRoot --node-executable $BoundNode
if ($LASTEXITCODE -ne 0) { throw 'r2 prepare failed' }
& $PowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File $Launcher -NodeExecutable $BoundNode -Entrypoint $Wrapper `
  --npm-executable $NpmCli $PlanR3 `
  --run-id 'rbp-v1.0-<sha12>-s01-r3' --sequence 3 `
  --repo-root $RepoRoot --node-executable $BoundNode
if ($LASTEXITCODE -ne 0) { throw 'r3 prepare failed' }
& $PowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File $Launcher -NodeExecutable $BoundNode -Entrypoint $Wrapper `
  --npm-executable $NpmCli $PlanSoak `
  --run-id 'rbp-v1.0-<sha12>-s01-soak-1h' --sequence 1 `
  --repo-root $RepoRoot --node-executable $BoundNode
if ($LASTEXITCODE -ne 0) { throw 'soak prepare failed' }
```

The four paths are intentionally distinct and outside the source worktree.
Never prepare r1, r2, r3, or the soak into a shared
`execution-plan.json`; a later prepare must not overwrite the exact plan that
gates an earlier retained report. The soak uses its own run id and plan even
though its plan sequence is `1`. Replace `<sha12>` only after locking the clean
candidate. Create a fresh evidence-set directory instead of reusing a failed
set.

The wrapper refuses npm lifecycle invocation, caller-supplied
`--git-executable`, hostile in-process resolution overrides, and a dirty Git
tree. It resolves Git once through the absolute SystemRoot `where.exe`,
validates the selected file/version, and passes that exact absolute path to
the freshly built inner CLI; the CLI never resolves Git from `PATH`.

Before protocol generation or controller compilation, the wrapper captures
the complete physical TypeScript package and the actual installed
`json-schema-to-typescript` transitive package closure selected from the
protocol package. It rehashes that bootstrap identity immediately before and
after each generator, clean, and TypeScript child, and once more before
starting the inner CLI. A changed compiler shim/implementation, formatter,
schema parser, transitive dependency, physical resolution, or optional
dependency state fails closed. This bootstrap check does not depend on a
not-yet-built controller.

The wrapper deletes only the ignored `rbp-conformance/dist` controller output
and directly runs the bound Node for protocol generation/cleaning and
TypeScript compilation. It builds protocol and the conformance controller
from source, then starts that freshly built CLI with the same bound
build/controller Node. There is no outer native smoke under an incidental
Node. The inner CLI resolves the selected runtime Node (`--node-executable`,
or the current controller Node when omitted) and opens, queries, and closes
the Bridge simulator's exact installed `better-sqlite3` module under that
runtime before and after the component DAG.

The CLI validates and hashes the toolchain before cleaning component output.
Protocol, add-in loopback fixture, Gateway stub, and Bridge simulator are then
compiled exactly once by direct bound-Node generator/clean/TypeScript calls in
a fixed non-recursive DAG. Every child is bracketed by full toolchain
revalidation. After each step, every already-completed upstream output is
rehashed; a later step may not rewrite it. The freshly built controller and
protocol harness must remain byte-identical throughout the component build.

The resulting canonical deterministic v3 sidecar beside each launched
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

The installed dependency graph is resolved by the bound runtime Node through
real CommonJS, ESM, and package-manifest probes. Each selected module must
match the captured physical package root. Workspace targets, distinct nested
copies, native files, installed optional peers, and explicit optional-peer
absence are therefore separate identity facts; a convenient root package is
not substituted for the copy Node actually loads.

The selected runtime Node may differ from the build/controller Node only when
its complete recorded identity is used consistently by every canonical
component command, native smoke, production run, and validator invocation.
For the M1 runbook above they are deliberately the same `$BoundNode`. A
different current controller Node fails closed against the plan.
No timestamp or filesystem mtime participates. Windows system DLLs and
kernel-level filesystem races are outside the application provenance
boundary; every repo/npm-controlled executable byte is inside it.

After all four plans are prepared, the entire three-run, aggregate/JUnit, and
fixed one-hour-soak chain runs in one attested Node process. This is the only
command allowed to print the literal final `PASS`; `<sha>` and `<tree>` are the
locked candidate identities:

```powershell
$ExpectedCommit = '<sha>'
$ExpectedTree = '<tree>'

& $PowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File $Launcher -NodeExecutable $BoundNode -Entrypoint $CliBootstrap `
  run-final-evidence `
  --plan-1 $PlanR1 --plan-2 $PlanR2 --plan-3 $PlanR3 `
  --soak-plan $PlanSoak `
  --repo-root $RepoRoot --artifact-root $EvidenceRoot `
  --expected-commit $ExpectedCommit --expected-tree $ExpectedTree
if ($LASTEXITCODE -ne 0) { throw 'final evidence run failed' }
```

The command accepts no retained report, aggregate, soak result, duration,
clock, adapter, executor, or oracle input. Before the first case starts it
requires four physical, byte-canonical, distinct plan files; sequence
`1/2/3` for the three runs; sequence `1` for the unique soak plan; four unique
run ids; and one exact candidate/toolchain/controller identity. The exact
run-id directories, aggregate directory, and one-hour soak run-id directory
must not already exist. Any failed or partial attempt therefore requires a new
evidence-set directory and new run ids.

The same process executes the three runs sequentially from the gated plans.
Its decision source is each directly returned in-memory report, not caller
JSON. It byte-compares each canonical retained report with `stableJson` of that
returned object, performs full artifact validation, builds the aggregate and
JUnit from those same three objects, writes and reopens their canonical bytes,
then runs the non-overridable one-hour soak. After the hour it reopens every
report, rechecks all four original plan bytes and current candidate/toolchain/
CLI bindings, and fully validates the aggregate and soak before printing
`RBP FINAL EVIDENCE: PASS`.

The launcher accepts only the canonical tracked prepare wrapper or CLI
bootstrap. Its source, the attestation client/bootstrap, and PowerShell
identity are themselves protected harness/toolchain bytes. The prepare wrapper
keeps the attested process alive while importing the freshly compiled
controller. The sidecar writer and production-plan builder are internal,
absent from the package-root export surface, and independently require that
same process-private prepare-wrapper receipt before they inspect ignored build
output, write sidecars, or assemble a production-valid plan. Direct module
imports therefore fail closed even when a caller fabricates an npm marker. The
in-process controller environment guard remains defense in depth, but it
cannot replace this pre-production-JavaScript boundary: a direct Node
invocation with `NODE_OPTIONS`, `NODE_PATH`, compile-cache,
preserve-symlink, or `WS_NO_*` overrides is not canonical evidence.

This boundary prevents a direct Node process or preload from becoming
PASS-capable merely by naming or hosting a forged pipe: the OS-reported server
PID must be the Node parent, that parent must be the exact SystemRoot Windows
PowerShell, its OS command line must be the canonical launcher invocation, and
the launcher checks the actual receipt-pipe client PID rather than a PID in a
request. Security-critical launcher setup uses .NET APIs and a fixed binary
line protocol, not profile-shadowable `Get-Process`, `Get-Item`,
`Get-FileHash`, `ForEach-Object`, or JSON cmdlet pipelines. The launcher also
rejects a nested/profile/proxy host before it starts Node.
An inherited anonymous Windows handle is not used because the supported Node
JavaScript surface cannot authenticate that handle's peer process without a
new native add-on; the two private pipe connections keep peer-PID checks on
documented Windows APIs at both ends without adding an untracked binary.

This is an application provenance anchor, not Windows code integrity. An
attacker able to inject native code into, debug, or replace state inside the
already-running canonical PowerShell/Node processes, hook the OS process/pipe
APIs, or act with kernel-equivalent authority is outside the boundary. Those
capabilities can falsify any JavaScript/.NET in-process check and require a
separate signed native or OS policy anchor. Same-user pipe-name guessing alone,
ordinary direct invocation, and an untrusted parent process are inside the
tested fail-closed boundary.

`prepare-production` verifies those sidecars before writing the plan. The plan
retains each sidecar hash and its compile/runtime/dependency/controller/tool
identity. Every production execution entrypoint (`run-production`, `run-c19`,
`run-soak`, and `run-final-evidence`) and each plan-bound audit/aggregation
path performs the full source/build-toolchain check at its boundary and
requires the current controller Node to equal the plan-bound runtime Node.
Standalone `validate-run`, `validate-aggregate`, `validate-soak`, and
`aggregate` consume caller-supplied retained JSON and are explicitly
NON-AUTHORITATIVE audit/reconstruction tools. They may exit zero and print
`VALID`, but they never print the literal `PASS` or produce a freeze verdict.
Likewise, standalone `run-production` and `run-soak` produce diagnostic or
partial retained evidence, not final freeze acceptance.

The launch guard re-derives the canonical command and rechecks source,
sidecar, runtime Node, entrypoint, component/protocol/controller output, and
installed runtime/native dependency closure immediately before each component
spawn and after readiness. It repeats after every supervised shutdown; failed
starts also run the boundary guard after cleanup. The soak retains two
independent three-process stacks, applies the same guard at child boundaries,
after every churn cycle, and during shutdown cleanup. Component children
inherit a sanitized environment without `NODE_OPTIONS`, `NODE_PATH`, Node
compile-cache/preserve-symlink controls, or `WS_NO_*` resolution switches.
A missing sidecar, stale source, stale binary, changed dependency/native byte,
unexpected optional peer, changed controller, command or Node substitution,
changed toolchain, sidecar tamper, or dirty tree fails closed before retained
final evidence can be accepted.

These v3 checks define the candidate-evidence boundary; they are not themselves
a freeze verdict. No M1 PASS, protected merge, or `rbp/v1.0.0` tag is claimed
until the authoritative same-process workflow, tree-identity proof, and
operator closing review complete. The independent audit commands may be rerun
for inspection, but their results never authorize that transition.

Audit validation remains fail-closed: a structurally valid but partially
executed report still exits nonzero. `run-c19` also exits nonzero by design
because its retained report leaves 39 cases `not_run`. Fixture, simulator, and
stub commands are supplied by the versioned `ExecutionPlan`; the supervisor,
not an adapter or child process, performs every spawn and evaluation.

`run-soak` starts and retains two independent production trios, one for WSS
and one for Streamable HTTP/SSE. Both trios stay alive for the whole run while
the parent alternates real socket backpressure, heartbeat acknowledgement,
Bridge restart/reconnect/resume, control-plane probes, and six-process resource
sampling. `one_hour` is hard-coded to 3,600,000 monotonic milliseconds and
rejects a duration override. Its scheduler is anchored to the monotonic start:
it requires exactly 720 alternating cycles and 720 same-index resource samples
at 5,000 ms slots. A cycle may start at most 2,500 ms late and its sample must
complete within 7,500 ms of that slot; observed sample gaps must stay within
2,500-7,500 ms. Sampling begins within the first 7,500 ms, extends from the
final scheduled window through the bounded run end, and the final
sample-to-finish gap may not exceed one 5,000 ms slot. The runner must reach the
one-hour deadline no more than 7,500 ms late. An event-loop suspension or late
cycle outside those bounds fails the run instead
of permitting catch-up cycles or a timestamp-only PASS.

## Retained evidence rules

Full evidence validation with `verifyArtifactFiles: true` reads every artifact beneath
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
The non-authoritative `aggregate` audit command verifies all three retained source reports, writes
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
required. The authoritative `run-final-evidence` workflow reopens and hashes
the retained JSONL metrics, requires every metric row to exactly mirror its
same-index report cycle and resource sample, and independently enforces the
one-hour 720-cycle coverage, alternating binding sequence, head/tail windows,
and bounded interval/jitter policy. It also reopens the retained aggregate,
re-gates all four exact plans, and rejects any aggregate/soak candidate
mismatch before emitting its final literal. `validate-soak` exposes the same
retained-data checks only as a NON-AUTHORITATIVE audit of caller-supplied JSON.
