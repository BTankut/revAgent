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
production prepare and the sole PASS-capable final command begin in the
expected commit's tracked launcher blob under the exact SystemRoot Windows
PowerShell. That launcher removes Node and `ws` resolution overrides before the exact reviewed
Node executable can load any production JavaScript. The production launcher
requires an unelevated Windows token and Node 22.15 or newer. It accepts only
the exact native `Program Files\nodejs\node.exe` and
`Program Files\Git\bin\git.exe` known-folder candidates, rejects every
symlink/junction/reparse segment, verifies the full protected ACL chain and a
valid Authenticode publisher (`OpenJS Foundation` for Node and
`Johannes Schindelin` for Git), and holds read locks on both executable files
through the child lifetime. Git is never selected from `PATH`. A behavioral
probe must prove that the selected Node's synchronous `module.registerHooks`
observes both dynamic `import()` and `createRequire()` before any pipe is
created.

Before any pipe is created, a fixed `-EncodedCommand` bootstrap receives only
canonical Base64 fields through `-EncodedArguments`. It authenticates and
locks the exact Program Files Git binary, resolves the constant launcher path
from the operator-locked commit, reads that object with `git cat-file` as raw
bytes, recomputes the Git blob object id and SHA-256, strict-decodes UTF-8, and
executes that blob as a scriptblock in the same SystemRoot PowerShell process.
The worktree `invoke-production.ps1` is never executed. The launcher then
proves that its derived root is the actual clean Git worktree, binds the exact
HEAD commit and tree, rejects
index flags/local filters/replace refs/grafts/info attributes and untracked
compile inputs, and raw-hashes the tracked protocol and conformance source
trees against HEAD without Git content filters. The source-anchor helper,
attestation client, selected entrypoint, launcher, bootstrap pin, and related
guard files have fixed structural paths and HEAD-current byte identities. The
PowerShell launcher raw-verifies the builtins-only source-anchor helper before
asking the authenticated Node to execute it. It opens the complete initial
JavaScript import closure and bootstrap pin with `FileShare.Read`, keeps those
handles through child exit, and sends the verified bytes through a separate
current-user/PID-bound pipe. A static `node -e` loader installs synchronous
hooks over that in-memory map before importing the CLI bootstrap or prepare
wrapper. A scripts-only copied tree, parent junction, dirty helper, dirty
launcher, or ignored `dist` tree cannot receive a launch receipt.

Before any production controller import, the child uses a separate exact
SystemRoot Windows
PowerShell probe and `GetNamedPipeServerProcessId` to prove that its
current-user-only authentication pipe is owned by its OS parent. The probe
returns the parent's OS executable and `Win32_Process.CommandLine`; the child
requires the exact fixed
`-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedArguments
<canonical payload> -EncodedCommand <fixed bootstrap>` argument vector and
re-renders both encoded fields byte for byte. The launcher independently
uses `GetNamedPipeClientProcessId` on both the authentication connection and
the second one-shot receipt connection, and requires the receipt client to be
the Node PID it started. The receipt binds that OS handoff to the exact argv,
launcher commit/tree/path/mode/blob object id/blob SHA-256, compressed bootstrap
template and outer-command digests, initial-loader digest, Node/entrypoint
identities, and the complete Git/source-anchor record. The tracked CLI
bootstrap recomputes that anchor and validates the receipt before importing
the freshly built controller.
Do not enter the canonical path through `npm run`, an npm lifecycle, a shell
bin shim, the `rbp-conformance` bin, a direct Node-to-CLI invocation, or a
worktree launch renderer. No Node, Git, or worktree executable/source is run to
derive the production host command. The exact expected commit and tree are
operator-approved literals; they are not calculated by a pre-bootstrap Git
command.

Each launch begins from an independently protected authority vector produced
and reviewed in a separate clean step. Its retained record contains exactly
eight host arguments, the whole `EncodedArguments` SHA-256, the
`EncodedCommand` SHA-256, bootstrap-template SHA-256, payload SHA-256, expected
commit/tree, the bound repository root as the exact child working directory,
generation timestamp, and authority label. The approved vector is retained
outside both the mutable checkout and the evidence artifact root.
Canonical execution passes those eight saved arguments directly to the exact
SystemRoot Windows PowerShell. The ceremony below starts only after the
protected authority has supplied the five approved prepare/final vector
objects; the ceremony itself must come from that protected operator record,
not from the candidate checkout:

```powershell
$PowerShell = [IO.Path]::Combine(
  [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows),
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

function Get-RbpVectorHash([byte[]]$Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString(
      $algorithm.ComputeHash($Bytes)
    )).Replace('-', '').ToLowerInvariant()
  }
  finally {
    $algorithm.Dispose()
  }
}

function ConvertFrom-RbpVectorBase64([string]$Value, [string]$Label) {
  $bytes = [Convert]::FromBase64String($Value)
  if (-not [StringComparer]::Ordinal.Equals(
    [Convert]::ToBase64String($bytes),
    $Value
  )) {
    throw "$Label is not canonical Base64"
  }
  return ,$bytes
}

function ConvertTo-RbpWindowsArgument([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }
  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $slashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $slashes++
      continue
    }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * (2 * $slashes + 1)))
      [void]$builder.Append('"')
      $slashes = 0
      continue
    }
    if ($slashes -gt 0) {
      [void]$builder.Append(('\' * $slashes))
      $slashes = 0
    }
    [void]$builder.Append($character)
  }
  if ($slashes -gt 0) {
    [void]$builder.Append(('\' * (2 * $slashes)))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Invoke-ApprovedRbpVector($Vector) {
  [string[]]$hostArguments = @($Vector.hostArguments)
  if (
    [string]$Vector.schemaVersion -ne
      'rbp-production-launch-authority-vector/v2' -or
    $Vector.authoritative -ne $true -or
    -not [StringComparer]::OrdinalIgnoreCase.Equals(
      [IO.Path]::GetFullPath([string]$Vector.powershellExecutable),
      $PowerShell
    ) -or
    $hostArguments.Count -ne 8 -or
    $hostArguments[0] -ne '-NoProfile' -or
    $hostArguments[1] -ne '-NonInteractive' -or
    $hostArguments[2] -ne '-ExecutionPolicy' -or
    $hostArguments[3] -ne 'Bypass' -or
    $hostArguments[4] -ne '-EncodedArguments' -or
    $hostArguments[6] -ne '-EncodedCommand'
  ) {
    throw 'approved production vector has a non-canonical host argument shape'
  }
  $commandBytes = ConvertFrom-RbpVectorBase64 `
    $hostArguments[7] 'EncodedCommand'
  if (
    (Get-RbpVectorHash $commandBytes) -ne
    [string]$Vector.encodedCommandSha256
  ) {
    throw 'approved EncodedCommand hash mismatch'
  }
  $encodedArgumentBytes = ConvertFrom-RbpVectorBase64 `
    $hostArguments[5] 'EncodedArguments'
  if (
    (Get-RbpVectorHash $encodedArgumentBytes) -ne
    [string]$Vector.encodedArgumentsSha256
  ) {
    throw 'approved EncodedArguments hash mismatch'
  }
  $utf16 = [Text.UnicodeEncoding]::new(
    $false,
    $false,
    $true
  )
  $xml = $utf16.GetString($encodedArgumentBytes)
  if (-not [StringComparer]::Ordinal.Equals(
    [Convert]::ToBase64String($utf16.GetBytes($xml)),
    [Convert]::ToBase64String($encodedArgumentBytes)
  )) {
    throw 'approved EncodedArguments are not strict UTF-16LE'
  }
  $xmlPrefix = [string]::Join(
    "`r`n",
    @(
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">',
      '  <Obj RefId="0">',
      '    <TN RefId="0">',
      '      <T>System.Object[]</T>',
      '      <T>System.Array</T>',
      '      <T>System.Object</T>',
      '    </TN>',
      '    <LST>',
      '      <S>'
    )
  )
  $xmlSuffix = [string]::Join(
    "`r`n",
    @(
      '</S>',
      '    </LST>',
      '  </Obj>',
      '</Objs>'
    )
  )
  if (
    -not $xml.StartsWith($xmlPrefix, [StringComparison]::Ordinal) -or
    -not $xml.EndsWith($xmlSuffix, [StringComparison]::Ordinal) -or
    $xml.Length -le $xmlPrefix.Length + $xmlSuffix.Length
  ) {
    throw 'approved EncodedArguments document is not canonical'
  }
  $payloadBase64 = $xml.Substring(
    $xmlPrefix.Length,
    $xml.Length - $xmlPrefix.Length - $xmlSuffix.Length
  )
  if (-not [StringComparer]::Ordinal.Equals(
    $xml,
    $xmlPrefix + $payloadBase64 + $xmlSuffix
  )) {
    throw 'approved EncodedArguments document is not canonical'
  }
  $payloadBytes = ConvertFrom-RbpVectorBase64 `
    $payloadBase64 'bootstrap payload'
  if ((Get-RbpVectorHash $payloadBytes) -ne [string]$Vector.payloadSha256) {
    throw 'approved bootstrap payload hash mismatch'
  }
  $utf8 = [Text.UTF8Encoding]::new($false, $true)
  $payloadText = $utf8.GetString($payloadBytes)
  if (-not [Convert]::ToBase64String(
    $utf8.GetBytes($payloadText)
  ).Equals([Convert]::ToBase64String($payloadBytes))) {
    throw 'approved bootstrap payload is not strict UTF-8'
  }
  $encodedFields = $payloadText.Split(
    [char]9,
    [StringSplitOptions]::None
  )
  $fields = [Collections.Generic.List[string]]::new()
  foreach ($encodedField in $encodedFields) {
    $fieldBytes = ConvertFrom-RbpVectorBase64 $encodedField 'payload field'
    $field = $utf8.GetString($fieldBytes)
    if (-not [Convert]::ToBase64String(
      $utf8.GetBytes($field)
    ).Equals([Convert]::ToBase64String($fieldBytes))) {
      throw 'approved payload field is not strict UTF-8'
    }
    [void]$fields.Add($field)
  }
  $argumentCount = 0
  if (
    $fields.Count -lt 7 -or
    $fields[0] -ne 'rbp-production-encoded-bootstrap/v2' -or
    $fields[3] -ne
      'packages/rbp-conformance/scripts/invoke-production.ps1' -or
    -not [int]::TryParse(
      $fields[6],
      [Globalization.NumberStyles]::None,
      [Globalization.CultureInfo]::InvariantCulture,
      [ref]$argumentCount
    ) -or
    $argumentCount -lt 0 -or
    $fields.Count -ne 7 + $argumentCount -or
    -not [StringComparer]::Ordinal.Equals(
      $fields[1],
      [string]$Vector.repoRoot
    ) -or
    -not [StringComparer]::Ordinal.Equals(
      $fields[2],
      [string]$Vector.role
    ) -or
    -not [StringComparer]::Ordinal.Equals(
      $fields[4],
      [string]$Vector.expectedCommit
    ) -or
    -not [StringComparer]::Ordinal.Equals(
      $fields[5],
      [string]$Vector.expectedTree
    ) -or
    [string]::IsNullOrWhiteSpace([string]$Vector.workingDirectory) -or
    -not [IO.Path]::IsPathRooted([string]$Vector.workingDirectory) -or
    -not [StringComparer]::Ordinal.Equals(
      [string]$Vector.workingDirectory,
      [string]$Vector.repoRoot
    )
  ) {
    throw 'approved authority fields do not match the executed payload'
  }
  [string[]]$approvedCommandArguments = @($Vector.commandArguments)
  if ($approvedCommandArguments.Count -ne $argumentCount) {
    throw 'approved command-argument count does not match the executed payload'
  }
  for ($index = 0; $index -lt $argumentCount; $index++) {
    if (-not [StringComparer]::Ordinal.Equals(
      $fields[7 + $index],
      $approvedCommandArguments[$index]
    )) {
      throw 'approved command arguments do not match the executed payload'
    }
  }
  $timestamp = [DateTimeOffset]::MinValue
  $timestampValid = [DateTimeOffset]::TryParseExact(
    [string]$Vector.generationTimestamp,
    'yyyy-MM-ddTHH:mm:ss.fffZ',
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal,
    [ref]$timestamp
  )
  if (
    [string]$Vector.expectedCommit -notmatch '^[0-9a-f]{40,64}$' -or
    [string]$Vector.expectedTree -notmatch '^[0-9a-f]{40,64}$' -or
    [string]$Vector.encodedArgumentsSha256 -notmatch '^[0-9a-f]{64}$' -or
    [string]$Vector.bootstrapTemplateSha256 -notmatch '^[0-9a-f]{64}$' -or
    -not $timestampValid -or
    [string]::IsNullOrWhiteSpace([string]$Vector.authorityLabel) -or
    [string]$Vector.authorityLabel -ne
      ([string]$Vector.authorityLabel).Trim() -or
    ([string]$Vector.authorityLabel).Length -gt 160
  ) {
    throw 'approved production vector audit fields are incomplete'
  }
  $commandLineParts = [Collections.Generic.List[string]]::new()
  [void]$commandLineParts.Add((ConvertTo-RbpWindowsArgument $PowerShell))
  foreach ($hostArgument in $hostArguments) {
    [void]$commandLineParts.Add(
      (ConvertTo-RbpWindowsArgument $hostArgument)
    )
  }
  if ([string]::Join(' ', $commandLineParts).Length -gt 32766) {
    throw 'approved production vector exceeds the Windows command-line limit'
  }
  & $PowerShell @hostArguments
  if ($LASTEXITCODE -ne 0) {
    throw 'approved production vector failed'
  }
}

# These are exact records supplied by the independently protected authority.
# They are not read or generated from the checkout or evidence artifact root.
Invoke-ApprovedRbpVector $ApprovedPrepareR1Vector
Invoke-ApprovedRbpVector $ApprovedPrepareR2Vector
Invoke-ApprovedRbpVector $ApprovedPrepareR3Vector
Invoke-ApprovedRbpVector $ApprovedPrepareSoakVector
```

`production-launch-bootstrap.mjs
__render-production-launch-review-candidate` is an optional review-only
producer. Its output is explicitly `authoritative: false`; it may be used in
the separate clean review step, but production entry must not execute it or
trust its output until the exact vector and reported identities have been
independently reviewed, approved, and retained by the protected authority. That
authority preserves every reported field and exact host argument, changes the
record schema to `rbp-production-launch-authority-vector/v2`, and records
`authoritative: true`; this promotion is an external approval act, not a
worktree capability. The old `__render-production-launch` mode fails closed. A
renderer candidate rejects a Windows command line longer than 32,766
characters. The launcher ignores the authority executor's ambient directory,
starts the Node child with the approved `repoRoot` as its exact working
directory, and the child attestation rejects any mismatch before loading the
production controller.

`expectedCommit`/`expectedTree` prove the approved clean candidate's internal
consistency; they do not establish publisher approval. Publisher/candidate
approval remains a separate protected release-policy input.

The four paths are intentionally distinct and outside the source worktree.
Never prepare r1, r2, r3, or the soak into a shared
`execution-plan.json`; a later prepare must not overwrite the exact plan that
gates an earlier retained report. The soak uses its own run id and plan even
though its plan sequence is `1`. Replace `<sha12>` only after locking the clean
candidate. Create a fresh evidence-set directory instead of reusing a failed
set. At final-run entry, an existing artifact root may contain only the four
selected physical plan files and the directories needed to reach them. Any
other file, directory, old plan, prior run/soak/aggregate output, symlink,
junction, or reparse entry rejects the set. When all four plans are outside the
artifact root, that root must be absent or empty.

The wrapper refuses npm lifecycle invocation, caller-supplied
`--git-executable`, hostile in-process resolution overrides, a dirty Git tree,
and any npm entrypoint other than the exact npm CLI below the authenticated
Program Files Node installation. It passes the fixed authenticated Program
Files Git path to the freshly built inner CLI; neither wrapper nor CLI resolves
Git from `PATH`.

Before protocol generation or controller compilation, both launcher roles
delete the ignored protocol and conformance `dist` roots and rebuild them from
the clean anchored source. The tracked
`scripts/production-bootstrap-identity.json` pins the complete physical
TypeScript package, the selected `json-schema-to-typescript` transitive
closure, the complete npm package tree used by preparation, and the Ajv,
Ajv-formats, ws, and transitive runtime-package closure used by the controller.
Those identities are rehashed around every generator, clean, and TypeScript
child and again around controller import. A changed compiler
shim/implementation, formatter, schema parser, npm byte, runtime dependency,
physical resolution, or optional dependency state fails closed. This check
does not depend on a plan, sidecar, or not-yet-imported controller.

After the clean rebuild, the bootstrap captures every protocol/controller and
pinned runtime-package file into an in-memory byte map. A synchronous,
process-local loader guard permits only Node builtins or an exact captured file,
rejects alternate schemes/query/hash aliases and uncaptured paths, and returns
the captured bytes for the initial CLI and every later JavaScript/JSON module.
Additional synchronous or asynchronous loader-hook registration is disabled
after the guard is installed. On-disk closure bytes and pinned package
identities are checked again after import. There is no outer native smoke under
an incidental Node. The inner CLI resolves the selected runtime Node
(`--node-executable`, or the current controller Node when omitted) and opens,
queries, and closes the Bridge simulator's exact installed `better-sqlite3`
module under that runtime before and after the component DAG.

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
For the M1 authority vectors they are deliberately the same exact Program Files
Node. A different current controller Node fails closed against the plan.
No timestamp or filesystem mtime participates. At each guarded boundary every
static repo/npm-controlled executable byte is inside the application provenance
anchor. Windows system DLLs, kernel-level filesystem races, and an already
running same-user process that can actively mutate and restore build inputs or
installed dependency bytes during a generator/compiler subprocess are outside
that anchor; the operator must quiesce other writers for canonical evidence.

After all four plans are prepared, the entire three-run, aggregate/JUnit, and
fixed one-hour-soak chain runs in one attested Node process. This is the only
command allowed to print the literal final `PASS`. The independently protected
final authority vector binds the same approved commit/tree and exact four plan
paths used by the prepare vectors:

```powershell
# Exact record supplied outside the checkout and evidence artifact root.
Invoke-ApprovedRbpVector $ApprovedFinalEvidenceVector
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
APIs, actively race writable build/dependency files during the guarded
generator/compiler window, or act with kernel-equivalent authority is outside
the boundary. Those capabilities can falsify an application-level check and
require operator quiescence plus a separate signed native or OS policy anchor.
Pre-existing dirty/tampered bytes, same-user pipe-name guessing alone, ordinary
direct invocation, and an untrusted parent process are inside the tested
fail-closed boundary.

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

Each authoritative suite or soak opens one process-owned runtime-integrity
epoch. The epoch fully re-derives the canonical commands and rechecks source,
sidecars, runtime Node, entrypoints, component/protocol/controller output, and
the installed runtime/native dependency closure before any component starts
and again after every supervised component has stopped. Component launch,
readiness, failed-start cleanup, supervised shutdown, and per-cycle soak
boundaries remain fail-closed to the exact epoch plan bytes and physical
repository root; a different plan/root or a nested/concurrent epoch is
rejected. Amortizing the static byte walk across the run keeps the real
forty-case suite inside its ten-minute gate and keeps the 5-second soak cadence
measurable without weakening the persistent-mutation check. As stated in the
threat boundary above, an active same-user writer able to mutate and restore
anchored bytes entirely between the epoch's opening and closing checks remains
outside the application provenance anchor and requires operator quiescence.
Component children inherit a sanitized environment without `NODE_OPTIONS`,
`NODE_PATH`, Node compile-cache/preserve-symlink controls, or `WS_NO_*`
resolution switches.
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
The non-authoritative `aggregate` audit command verifies all three retained
source reports and deterministically reconstructs aggregate JSON/JUnit only in
memory. It prints `VALID (NON-AUTHORITATIVE)` followed by a hash/count summary;
it does not print the reconstructed JSON/JUnit bytes and does not write any
output file. `--output` and `--junit-output` are rejected. This write-free
boundary avoids treating drive-letter, UNC, substituted-drive, hard-link, or
reparse aliases as separate evidence locations. Only `run-final-evidence` may
create the retained
`artifacts/conformance/rbp-v1/1.0/aggregate/junit.xml` and
`artifacts/conformance/rbp-v1/1.0/aggregate/three-run-report.json` pair.

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
