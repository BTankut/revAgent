# revAgent no-notification update runbook

This runbook closes the operational follow-up observed during the
`2026.07.07.514-0c217fb3` deployment. It does not publish, deploy, or add a
new updater launcher.

## Decision

Do not add a new product launcher in the usage-evidence PR sequence.

For now, no-notification update triggering is an operator runbook path only. It
may be used during an approved rollout when the normal scheduled update path is
reachable but blocked behind user notification state. It must not bypass release
approval, signed-channel checks, rollout readiness checks, or named workstation
exclusions.

## When To Use

Use this path only when all are true:

- a signed stable release has already been approved for deployment
- the target workstation is in the approved rollout set
- the normal scheduled updater or GUI launcher is present but not completing
  because the notification/user-interaction path is not suitable for remote
  execution
- the operator can collect `latest.json` and rollout evidence after the run
- the temporary trigger can be cleaned up or proven one-shot

Do not use this path for:

- unapproved releases
- emergency rollback
- source-free migration without the normal migration policy gates
- workstations excluded by the rollout plan
- machines with unclear SMB/auth identity or stale NAS access
- broad blind execution across the office

## Required Controls

Every no-notification update run must record:

- requested release/channel
- target machine and Windows user context
- reason the normal notification path was unsuitable
- start/end time
- updater exit state
- path to the machine report under `reports\machines\<computer>\`
- whether the temporary task or trigger was removed
- any excluded machines that were intentionally skipped

The run must preserve the normal updater safety model:

- no Revit auto-close
- signed release verification stays active
- source-free migration policy is not skipped
- `highestAcceptedReleaseSequence` rollback protection is not bypassed
- local developer `preserve-local` policy, if present, is preserved
- no deploy/publish operation is performed by this runbook

## Future Product Candidate

A supported launcher may be considered later if repeated rollouts show the
runbook path is still needed. That launcher would need:

- explicit operator confirmation and target list
- no-notification mode as a visible option, not a hidden default
- signed release/channel preflight
- per-target evidence collection
- one-shot task registration and cleanup verification
- failure reporting that distinguishes unreachable host, auth failure, updater
  guard, Revit-close deferral, and successful no-change update

Until that product work is approved, keep no-notification update triggering as a
manual operational procedure, not an installed automatic pathway.
