# Add-in loopback fixture

Implementation-independent O1-T3 fixture for the normative add-in loopback v1
contract. It runs on Node.js in Linux CI and does not load Revit or the revAgent
add-in.

The fixture provides:

- a numeric-loopback-only TCP listener;
- exact four-byte big-endian, UTF-8 JSON-RPC framing;
- validation against `@revagent/protocol` add-in-loopback/v1 schemas;
- deterministic `mcp_status`, cached `get_document_context`, ordinary method,
  and atomic `execute_batch` behavior;
- a test `TransactionGroup` model and deterministic execution observations;
- explicit delay, stall, disconnect, crash, late-outcome, and rollback-failure
  fault controls, queued FIFO per duplicate request id;
- strict duplicate-key-rejecting JSON at both the TCP and CLI boundaries;
- deterministic response-prefix disconnects for partial-header and
  partial-payload fault windows;
- a validated `applyDocumentContextEvent` control that increments the cached
  context revision inside one running fixture session.

Run the standalone CLI after building:

```console
npm run build --workspace @revagent/addin-loopback-fixture
node packages/addin-loopback-fixture/dist/cli.js --host 127.0.0.1 --port 0
```

The CLI prints one JSON readiness record and then accepts strict JSON Lines
control v1 on stdin. Every input line is at most 64 KiB, contains a correlation
`id`, and produces exactly one FIFO JSON response on stdout. Stdout contains no
other text. Supported actions are `plan_fault`, `release_stall`,
`apply_document_context`, `snapshot_evidence`, and `shutdown`. Fault plans can
select busy, delay, stall, guarded/failed outcomes, standard JSON-RPC errors,
before/after-dispatch disconnect or crash, response-prefix disconnect, and
rollback failure. Evidence is paged below the line limit and retains ordered
observations, request/method execution counts, pending stalls, open-socket
count, and only a digest/count for model state; it never emits raw model state.
Use the returned `snapshotId` and `nextCursor` until `complete:true`.

There is deliberately no unsafe-bind override or network control endpoint. The
fixture proves transport and contract behavior without claiming a real Revit
`ExternalEvent`, native `TransactionGroup`, O1-T4 through O1-T6, or the M1
freeze gate.

The dedicated `O1 add-in loopback fixture` Linux workflow runs only for the
fixture, protocol/spec, and root workspace inputs on which this package depends.
Local Windows signal tests are retained, but Linux evidence exists only after
that workflow has completed successfully on the pull request head.
