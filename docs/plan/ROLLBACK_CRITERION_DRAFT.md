# Fleet Rollback Criterion and Runbook Skeleton

**State:** draft; not approved for execution

**Owner:** WP8

**Required before use:** DP-10 client, DP-12 cutover window, P8-T4 rehearsal, operator signature

This artifact starts P8-T5. It does not authorize a rollback, a NAS publish, or any workstation mutation. Before M9 it must contain exact times, the complete machine roster, named decision makers, measured per-machine duration, and signatures.

## Non-negotiable rules

1. Rollback is fleet-level: restore all cut-over workstations to the frozen NAS stack or restore none. Do not leave a mixed production estate.
2. Preserve `C:\ProgramData\DPE\revAgent\bootstrap\`, `prestage\install-revagent-local-bootstrap.ps1`, and `updater\config\release-trusted-keys.json` through M10. Their removal turns rollback into a supervised manual prestage on every machine.
3. Keep the frozen NAS stable tree, currently recorded by the plan as `2026.07.20.574-11020d1a`, intact and publish nothing new during Build, Pilot, Cutover, or Insurance except through the separately approved GAP-13 emergency path.
4. Close Revit before restoring add-in/runtime files. Preserve evidence before remediation.
5. A successful same-version repair is not proof that an older signed sequence can be installed. If any machine accepted a higher signed release, the rehearsed rollback must account for the explicit per-machine signed-release rollback guard.

## Exit-84 constraint and exact per-machine recovery command

This runbook is executable by an operator only while each workstation retains a current protected trust
anchor. Rollback is not a fleet-wide push: the following command MUST be run interactively on every rostered
machine, one machine at a time, after Revit is closed:

```text
C:\ProgramData\DPE\revAgent\bootstrap\Start-revAgent-Update.cmd
```

Before running it, the operator verifies that this exact launcher and its protected bootstrap are present and
current. The operator records machine name, Windows user, start/end time, command exit code, restored release
identity, and smoke result.

If the protected bootstrap is missing or stale, the NAS Refresh path stops **before UAC with exit 84**; the
guarded direct elevated-apply path is not a bypass. On exit 84 the operator MUST stop recovery on that machine,
preserve the output, and follow the supervised high-assurance procedure in `docs/BOOTSTRAP_PRESTAGE.md`.
Running loose NAS scripts, lowering a signed sequence, or reporting the machine restored is prohibited until
that prestage and the exact launcher command above succeed. No scheduled task or single coordinator command
substitutes for the per-machine invocation.

## Fields to freeze before signature

| Field | Required value |
|---|---|
| Cutover start | `TBD — local date/time` |
| Final rollback decision time | `TBD — local date/time` |
| Target machine roster/count | `TBD` |
| Decision owner | `TBD` |
| Technical lead | `TBD` |
| User-communications lead | `TBD` |
| Maximum continuous Gateway/client outage | `TBD — measured and approved` |
| Frozen NAS release version + channel/release/package hashes | `TBD — capture immediately before cutover` |
| Rehearsed per-machine restore time | `TBD — measured on scratch hardware/VM` |

## Candidate criterion text for operator review

> At the final decision time above, the decision owner SHALL order one fleet-level rollback if any target workstation has not passed the chosen-client login, live-Revit read, confirmed write, and audit/journal verification checks; if any open P0/P1 defect threatens model integrity, authorization, idempotency, or recoverability; or if the Gateway/client path has exceeded the approved continuous-outage limit without a rehearsed same-evening recovery. The rollback applies to every cut-over workstation. No machine remains on the new production path until the root cause is fixed and the pilot gate is repeated.

During the two-week insurance window, a confirmed duplicate model mutation, authorization/tenant boundary breach, unrecoverable audit loss, or recurrence of a signed criterion condition triggers the same fleet-level rollback unless the signed operator amendment explicitly defines a safer rehearsed response.

The bracket-free final wording, exact outage limit, and deadline must be signed before cutover. Do not improvise new criteria during the cutover window.

## Pre-cutover proof checklist

- [ ] Frozen NAS release identity and exact hashes captured; channel verified restorable and no higher release scheduled.
- [ ] Publish-freeze guard verified; emergency exception owners named.
- [ ] Every target machine verified to retain the three rollback trust-anchor paths and the exact launcher `C:\ProgramData\DPE\revAgent\bootstrap\Start-revAgent-Update.cmd` is present/current.
- [ ] P3 uninstaller dry-run proves those paths are excluded.
- [ ] Pilot updater scheduled task disabled without deleting bootstrap; inverse rollback step tested.
- [ ] Scratch-machine rollback rehearsed with the exact per-machine launcher command above; exit code and restored signed identity retained.
- [ ] Exit-84 drill proves a missing/stale protected bootstrap stops before UAC and routes the operator to `docs/BOOTSTRAP_PRESTAGE.md` without an ad-hoc bypass.
- [ ] Revit-close, user-session, elevation, and Store-bound Codex attestation prerequisites rehearsed.
- [ ] Per-machine and fleet duration measured and cutover window sized accordingly.
- [ ] Current and rollback client instructions prepared and user-contact roster complete.
- [ ] Criterion signed by decision owner and technical lead.

## Execution skeleton

1. Decision owner declares rollback and records trigger, time, affected evidence ids, and fleet scope.
2. Stop new Gateway dispatch, preserve logs/audit rows, and notify all users to stop assistant actions while leaving Revit project files untouched.
3. Confirm the NAS channel remains frozen at the pre-cutover signed identity. Do not republish or lower a sequence as an ad-hoc recovery step.
4. For each rostered machine: close Revit; verify bootstrap/prestage/trusted-key paths and the exact launcher; run `C:\ProgramData\DPE\revAgent\bootstrap\Start-revAgent-Update.cmd`; if it returns exit 84, stop that machine and execute the supervised `docs/BOOTSTRAP_PRESTAGE.md` path before retrying the same launcher. Restore only the managed Codex MCP sections, AGENTS/skill material, and updater task required by the old stack.
5. Re-enable the NAS updater scheduled task on the pilot machine only as the rehearsed inverse of pilot neutralization; verify task identity and action before enabling it.
6. Run the old-stack smoke on every machine: MCP registration, Revit status, one read-only live-model query, and user-visible result. Do not use a model write as the first rollback smoke.
7. Record pass/fail, timestamps, release identity, and operator for every machine. The fleet remains unavailable until all machines pass or the incident owner declares a separate safety state.
8. Preserve the new-stack evidence and open a root-cause record. A return to the new path requires a corrected build and a repeated pilot, not an in-place mixed-estate retry.

Per-machine execution record:

| Machine | Launcher present/current | Start/end | Exit code | Restored release identity | Smoke | Operator |
|---|---|---|---:|---|---|---|
| `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |

## Honest time/cost boundary

With the trust anchor preserved, the architecture estimate is roughly 10–15 minutes per machine, about half a day for an approximately 12-machine fleet. If bootstrap/prestage trust was removed or became stale, expect a supervised two-shell high-assurance prestage of roughly 30–60 minutes per machine, approximately 1–1.5 serial operator-days before normal restore work. The rehearsal must replace these estimates with measured values.

## Sign-off

| Role | Name | Decision/signature | Date/time |
|---|---|---|---|
| Decision owner | `TBD` | `TBD` | `TBD` |
| Technical lead | `TBD` | `TBD` | `TBD` |
| Pilot user | `TBD` | `TBD` | `TBD` |

Unsigned or partially populated copies remain drafts and must not be used as cutover authority.
