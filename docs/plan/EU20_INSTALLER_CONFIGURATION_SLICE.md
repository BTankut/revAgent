# EU-20 installer configuration contract correction

Hedef | Plan satırı | Kabul | Kapsam | Forecast
Make the genuine installer produce the existing Bridge configuration contract | M6/P3-T9, P-INST-1, P-ENROLL-1 within existing EU-20 | Actual installer-produced configuration is accepted by the real compiled Bridge loader, with idempotent configuration preservation and unchanged strict rejection rules | Installer configuration producer, focused contract tests and source-bound evidence | 1-2 active engineering hours excluding CI/review waiting

Base: `4154a97bb799d7d7cc1bd5ad47d366318b4a27de`, tree `67e37b806437a132c8ceea7c4c2ad3d51de86f0a` (PR410). This is a bounded followup within the existing EU-20 unit, not a new programme, milestone or acceptance decision.

## Concrete mismatch

At this base, `installer/bridge/Install-RevAgentBridge.ps1` step7 emits `schemaVersion`, `gatewayHostName` and `revitVersion`. The production `BridgeConfigurationLoader.Load` permits and requires `schemaVersion`, `gateway`, `addin` and `logging`, including `gateway.uri` and the existing add-in/logging fields. The normal worker calls that loader before runtime composition. The installer output therefore cannot satisfy the current strict consumer.

PR410's real C# fixture, local gates, independent review and merged-main gates remain valid source-bound evidence; they were explicitly separate from the pending signed-installer/SCM/live-machine predicate. This followup must close the actual producer/consumer contract before touching PETRUCCI's R-D.

## Scope and invariants

- Repair the producer to emit the existing canonical schema using existing validated defaults and DNS/URI rules. Preserve the strict consumer, schema version and wire/auth contracts.
- Preserve existing valid configuration and custom settings on an idempotent rerun; do not replace a configured endpoint with an empty/default value or reset unrelated logging settings.
- Preserve the single guarded mutation path, dry-run zero-mutation behavior, real elevation/ACL enforcement, genuine identity preparation and the one-invocation protected enrollment-artifact handoff.
- Add a normal compiled contract regression that consumes actual producer output with the real Bridge loader. Cover fresh output, supported endpoint forms, rejected input and idempotent preservation as relevant to the change. Do not rely solely on mirrored schema assertions or mocked host output.
- No hand-editing live configuration to hide the mismatch, permissive parser fallback, new architecture, broad refactor, signing/review workflow changes, Revit model action or production publication.

## Delivery

Scope-record commit and draft PR precede implementation. One isolated writer, source-bound relevant tests and delivery gates, independent final protected review, exact-head guarded merge and post-merge verification. Reassess the existing automatic signing effect against the operator's current authorization; never bypass branch protection or alter triggers.

Network proof continues separately using only coordinator and PETRUCCI with accurately labeled controlled-negative evidence. Existing package/key/TLS/R-D/archive/rollback assets stay preserved. EU-20 and milestone acceptance remain open until the real signed install, live read, uninstall and restoration predicates pass.

Forecast/actual/variance and Park List will be recorded from observed evidence; no active-time total is invented from waiting time. Initial Park List: none.

## Implementation and targeted evidence

The installer now plans configuration before its first guarded machine mutation.
A fresh committed install requires `GatewayHostName` as a DNS authority, with
an optional port (for example `eu20-gateway.lab:8443`). The producer constructs
`wss://<authority>/bridge/v1` and emits the existing strict schema. Defaults use
the frozen add-in range8080-8085 and the production stable Host's10MiB/seven-file
logging policy. No hostname is invented when input is omitted.

Dry-run may retain `unresolved_endpoint` as an explicit planning disposition;
it creates no configuration and does not claim a usable endpoint. Existing
regular configuration is preserved byte-for-byte, with `preserved_existing`
reported explicitly. A config appearing after planning also wins; create-only
atomic promotion cannot replace it. Existing malformed configuration is not
silently repaired or accepted: the unchanged strict compiled reader still
rejects it. IP literals, scheme/path/userinfo/query/fragment input and invalid
ports are refused by fresh-input validation.

The new compiled xUnit contract tests execute the actual installer's
`write_bridge_config` command/Apply block from its source AST through the real
guarded mutation primitive in isolated scratch roots. They then call
`BridgeConfigurationLoader.Load` directly from the normal compiled test
assembly. No product DLL is reflectively loaded by PowerShell, and no full
installation, service, live model or signing-key operation is performed.
The original producer reproduced the reader's `Unknown property
'gatewayHostName' at $.` error. The corrected producer matrix and existing
strict-reader suite passed78 cases, with no skips, across Windows PowerShell5.1
and PowerShell7. Coverage includes both DNS endpoint forms, custom-byte
preservation, malformed/BOM rejection, unresolved dry-run, planning-before-write
ordering, and create-only collision protection. Formatting and diff checks
passed. Raw TRX evidence is under
`.orchestration/autopilot-v2/artifacts/EU-20/installer-configuration/`.

These are targeted repository results. Required delivery gates, independent
protected review, merge/signing-effect authorization and signed/live-machine
acceptance remain separate. Production C# reader/worker sources are unchanged.
Forecast remains1-2 active engineering hours; no complete active-time ledger was
collected, so actual/variance are not invented from wall-clock time. Park List:
none.

The existing installer/uninstaller script contract suite also passed under
Windows PowerShell 5.1 and PowerShell 7. Four non-dry-run fixtures now provide
the required DNS endpoint so they continue testing their original junction,
elevation and identity guards. The configuration planner preserves the existing
`gateway_host_must_not_be_ip` refusal code for IP literals. The compiled
producer/reader matrix passed again (78 passed, zero skipped) after this
compatibility correction; see `ip-refusal-contract-green.trx` and
`installer-contract-ps5-01.log` / `installer-contract-ps7-03.log` in the same
artifact root. Earlier failing fixture logs remain retained. Subsequent full
gate manifests bind their own exact source head and outcome; this record does
not anticipate those results.
