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
