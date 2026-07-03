# revAgent Codex Session Correlation Pilot Plan

## Goal

Add a bounded, opt-in usage-intelligence layer that connects what a production
user asked Codex to do with what revAgent actually did in Revit.

The pilot data source is NET01, not the developer workstation. NET01 is the
right first machine because it can produce the real production loop in one
place:

- Revit is open on NET01.
- The user talks to Codex on NET01.
- Codex calls revAgent tools on NET01.
- revAgent telemetry is already written from NET01 to the NAS reports tree.
- A local Codex session exporter can write bounded session context from NET01
  to the same NAS reports tree.

## Data Contract

Existing revAgent telemetry stays in:

```text
reports\events\YYYY\MM\DD\<machine>\<revAgentSessionId>.ndjson
```

New bounded Codex session context is written to:

```text
reports\codex-sessions\YYYY\MM\DD\<machine>\<codexSessionId>.context.json
```

Daily deterministic evidence outputs are written to:

```text
reports\summaries\daily\YYYY-MM-DD.session-correlations.json
reports\summaries\daily\YYYY-MM-DD.session-correlation-evidence.md
reports\llm-review-packs\<range>\review-pack.json
reports\llm-review-packs\<range>\review-pack-prompt.md
```

## Privacy Boundary

The exporter must not move full raw chat transcripts to the NAS. It exports
only bounded context:

- session/thread identity
- machine and user
- UTC time window
- workspace hints
- bounded user request snippets
- bounded assistant outcome snippets
- tool-call names and counts

Raw tool output bodies, full assistant reasoning, full transcripts, model data,
images, and unbounded file contents are outside the exported context contract.

## Pilot Flow

1. Install or copy the usage-intelligence add-on tools onto NET01.
2. Install the `revAgent Codex Session Context Export` scheduled task on NET01.
3. Trigger the scheduled task once and confirm its local latest report is
   written under the add-on state folder.
4. Confirm the context JSON lands under `reports\codex-sessions`.
5. Run the correlation script for the same UTC date.
6. Run the LLM review pack preparer for the target date range.
7. Open a new Codex/LLM chat and use the pack to prepare the actual semantic
   management report.
8. Review whether the LLM can answer:
   - What did the user ask for?
   - Which tools did Codex use?
   - What did revAgent do in Revit?
   - Did the workflow complete, guard, fail, or stop partially?
   - Did the user repeat or repair the request?
   - Does the evidence point to a product improvement?
   - Which users need targeted training?
   - Which findings are strong enough for action, and which need follow-up?

## Rollout Rule

Do not install workstation-wide exporters until the NET01 pilot produces useful
bounded evidence and the privacy boundary is accepted. The developer
workstation remains a development and review machine, not a production data
source.

## First Implementation Package

This package adds:

- a NET01-ready Codex session context exporter
- a workstation-side scheduled exporter task for NET01 automation testing
- a deterministic revAgent telemetry correlator
- an LLM review pack preparer that treats deterministic outputs as evidence,
  not as the final report
- daily publish integration for correlation and review-pack outputs
- tests with fixture Codex sessions and telemetry events
- documentation for the pilot runbook and data contract
