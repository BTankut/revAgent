# DP-12 — NET01 Live Readiness Evidence

**Evidence date:** 2026-07-22
**Collector:** revAgent implementation assistant through read-only SSH
**Canonical SSH selector used:** `Net01@100.119.168.39`
**Result:** Reachable; machine/resource baseline passed; updater-neutrality proof failed closed

## Identity and resources

The short `NET01` alias defaulted to the coordinator account `bt` and did not authenticate. The stored
machine-specific selector above authenticated with public key and returned the expected identities:

```text
remote identity : net01\net01
computer name   : NET01
interactive user: NET01\Net01
OS              : Microsoft Windows 11 Pro 10.0.26200, 64 bit
CPU             : 13th Gen Intel Core i9-13900, 32 logical processors
memory          : 127.7 GiB
system disk     : 1,844.9 GiB total, 1,399.2 GiB free
OpenSSH service : Running / Automatic
```

No Revit process was running at the capture time. That proves a safe idle inventory window only; it is not
a live-Revit or DP-10 conformance result.

## Installed pilot surfaces

- Revit 2022 is installed.
- The `OpenAI.Codex` Windows application is installed at version `26.715.8383.0`.
- The SSH session did not resolve a `codex` command on `PATH`; this does not negate the AppX installation and
  must not be treated as a remote-MCP registration result.
- The interactive user's `.codex/config.toml` exists.
- The installed revAgent stable package is `2026.07.17.561-3450aeb1`, commit
  `3450aeb1280ebee06d07ad60aeb985037a6873e9`.
- `C:\ProgramData\DPE\revAgent`, the protected
  `bootstrap\Start-revAgent-Update.cmd`, and the installed runtime entry point all exist.
- `revAgent Codex Session Context Export` is `Ready`; its latest recorded result was `0`.

These rows prove machine allocation and installed prerequisites. They do not prove client sign-in, OAuth,
Gateway reachability, confirm flow, file workflow, or live Revit behavior; those remain WP9 hands-on gates.

## Failed updater-neutrality check

The installed `revAgent Auto Update` task is `Ready`, runs daily at 12:00, and recorded result `1` on
2026-07-22. More importantly, its installed hidden launcher invokes `update-from-nas.ps1` with
`-NotifyUser -OperationMethod scheduled-update` but **without** `-AuditOnly`.

Current protected source generates this launcher with the exact arguments
`-AuditOnly -NotifyUser -OperationMethod scheduled-update-audit`. That correction entered the repository
after NET01's frozen stable package, so the installed surface cannot be used as evidence that the scheduled
task exits without payload changes. No updater or installer was executed during this audit, and no direct
workstation repair or release-freeze bypass was attempted.

This finding keeps two gates open:

1. GAP-13.2's technical assertion that scheduled update tasks are audit-only/non-mutating.
2. DP-12 pilot readiness, which requires the task to be disabled or repaired through a controlled,
   evidenced pilot-neutralization step while the protected bootstrap remains intact.

The remediation is technical-team work. It is not delegated to the pilot user and does not require the user
to run an updater manually.

## Remaining DP-12 decisions

The machine evidence does not name the human pilot user, backup operator, five-working-day pilot dates,
fleet transition window, or communications owner. Those remain operator-owned decisions and must be
recorded before pilot entry.
