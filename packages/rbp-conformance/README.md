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

`executeConformanceRun` starts only through an injected real three-process
driver. It runs both bindings for every canonical case and derives assertion
status in the runner. A driver returns raw observations and measurements; it
cannot return a case `passed` bit. Every one of the 167 frozen assertions has a
versioned component/binding/observation-kind requirement. Missing controls,
missing observations, cross-case ids, duplicate ids, a missing binding, or an
unsupported case stays failed. The package does not include a synthetic
passing driver.

Retained evidence belongs below
`artifacts/conformance/rbp-v1/1.0-rc.1/`. The manifest defines the exact run,
JUnit, aggregate, log, trace, journal, and metric path templates. Nothing below
that path is committed by this scaffold and no case is synthesized as passed.

## CLI

After `npm run build`, the package exposes:

```text
rbp-conformance validate-run <run-report.json> [--expected-commit <sha>] [--expected-tree <sha>]
rbp-conformance validate-aggregate <aggregate.json> [--expected-commit <sha>] [--expected-tree <sha>]
rbp-conformance validate-soak <soak-report.json> [--expected-commit <sha>] [--expected-tree <sha>]
rbp-conformance junit <run-report.json> <junit.xml>
rbp-conformance aggregate <run-1.json> <run-2.json> <run-3.json> [--artifact-root <path>]
rbp-conformance summary <aggregate.json> <summary.md>
```

Validation commands are pass gates: a structurally valid but unexecuted report
still exits nonzero. Fixture, simulator, and stub runners plug in through the
exported `HarnessComponentAdapter`, `ProcessCommandDescriptor`, and
`ExecutionPlan` interfaces.

## Retained evidence rules

Pass validation with `verifyArtifactFiles: true` reads every artifact beneath
the canonical retained root after resolving the real path. A lexical path,
symlink, junction, or Windows reparse point that resolves outside that root is
rejected. Required evidence is never allowed to be zero bytes.

- `wire_trace` is UTF-8 JSON Lines using `rbp-wire-trace/v1`; each row binds the
  run, case, binding, status, and in-case timestamp.
- `journal_snapshot` and optional `case_evidence` are strict
  `rbp-case-evidence/v1` JSON documents. They retain the raw, same-run,
  same-case process observations and their exact component/binding identity.
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
`artifacts/conformance/rbp-v1/1.0-rc.1/aggregate/junit.xml` and
`artifacts/conformance/rbp-v1/1.0-rc.1/aggregate/three-run-report.json`. The
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
