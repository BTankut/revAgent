# DP-12 — PETRUCCI Live Workstation Readiness Evidence

**Evidence date:** 2026-08-13

**Collector:** revAgent implementation assistant through read-only SSH from `DESKTOP-OKNV128`

**Canonical SSH selector:** `ws2@192.168.90.122`

**Result:** Current live-workstation identity and installed M3 surfaces verified; all M4 live gates remain closed

## Authority and scope

The operator corrected the DP-12/M4 live-workstation assignment on 2026-08-13:
`PETRUCCI` is the current live Revit workstation and `NET01` is outside the
program. The earlier NET01 inventory remains historical evidence only in
`DP-12-NET01-readiness-2026-07-22.md`; it is not a current target.

This collection was read-only. It did not start or stop a service, change a
configuration, inspect credential values, invoke the Revit MCP runtime, open a
model, stage a package, or contact the Gateway from PETRUCCI.

## SSH identity and direction

The coordinator used the existing private key and known-host record with
`BatchMode=yes` and `StrictHostKeyChecking=yes`:

```text
DESKTOP-OKNV128 -> ws2@192.168.90.122
remote identity : petrucci\ws2
computer name   : PETRUCCI
OS              : Microsoft Windows 11 Pro 10.0.26200 (build 26200)
LAN address     : 192.168.90.122/24
```

The repository's retained M3 bundle did not contain the selector, account, IP,
or initiating coordinator hostname. This read-only collection closes that
locator gap for the current workstation assignment.

## Installed client, Revit, and add-in surfaces

- OpenAI Codex Desktop AppX `26.803.10989.0` is installed. No Codex process was
  running during the collection, so an active signed-in client session or live
  remote-MCP registration is not claimed.
- Revit 2022 is installed at
  `C:\Program Files\Autodesk\Revit 2022\Revit.exe`, version `22.1.80.32`,
  SHA-256 `f6c9380ab9e69388c7a7287dbecf89603f89f01c49e673477c48b86342f58035`.
- A Revit process was running in the interactive session. Read-only SSH could
  not establish its open document, and no Revit MCP call was made.
- The machine-wide add-in manifest is
  `C:\ProgramData\Autodesk\Revit\Addins\2022\revAgent.addin`, SHA-256
  `9aa1ea865289adc352d5ad467fec93c11ff48b10f15f5c40bc5348d036f95b6c`.
- The manifest resolves to
  `C:\ProgramData\DPE\revAgent\revit-plugin\revAgentPlugin\revAgentPlugin.dll`,
  file/assembly version `1.0.0.0`, SHA-256
  `1e25e5a3eaaaad420a98e45abc511a11ab6ba0d9c62875650010b91c7433aefa`.
  That DLL digest matches the payload recorded by protected main in
  `installer/revit-payload-manifest.json`.

## Bridge and enrollment ceiling

- Windows service `revAgentBridge` was `Running`, start mode `Auto`, account
  `LocalSystem`, with host binary
  `C:\Program Files\revAgent\Bridge\revagent-bridge-host.exe`.
- The current Bridge configuration at
  `C:\ProgramData\revAgent\bridge\bridge-config.json` still names the M3
  loopback stub endpoint: `wss://localhost:8443/bridge/v1`. It does not name
  the real Gateway host.
- SYSTEM-owned
  `C:\ProgramData\revAgent\bridge\credentials\machine-fingerprint.json` and
  `C:\ProgramData\revAgent\bridge\credentials\device-credential.dpapi`
  artifacts exist. Their values were not read.
- The retained M3 doctor evidence reports `enrolled=true`, but that enrollment
  was against the M3 stub. It is not evidence of enrollment, token exchange,
  revocation handling, or persistence against the real Gateway.

The M4 `BRIDGE-STAGE` and `CREDENTIAL/ENROLL` gates therefore remain required
and separate. This document does not authorize either one.

## Retained M3 chain and test-model candidate

The six files under PETRUCCI's
`C:\revagent-deploy\m3-evidence` still match the retained coordinator bundle at
`C:\Users\BT\Projects\revAgent-freeze-evidence\m3-live-petrucci` by filename,
byte count, and SHA-256. The canonical M3 interpretation remains
`docs/plan/M3_BRIDGE_GATE_EVIDENCE.md`.

The M3-continuity model exists at:

```text
C:\Program Files\Autodesk\Revit 2022\Samples\rme_basic_sample_project.rvt
size    : 30,482,432 bytes
SHA-256 : 701e419b1f566c46bff51bb75f033d219719e593c47cfb2bb3548b6e8137fa51
```

It is the M4-04 live-read candidate, not a claim about the document currently
open in Revit. The operator must confirm or open this exact model only inside a
separately approved `CLIENT/LIVE` gate.

## M4-04 implications

Two endpoints are resolved: Gateway is `revagent` (`192.168.90.154`), and the
Bridge/add-in/live-Revit workstation is `PETRUCCI` (`192.168.90.122`). WP9
client placement is still an operator decision:

- A PETRUCCI client would produce three logical endpoints on two physical
  hosts. Codex Desktop is installed there, but no active signed-in client
  session or remote-MCP registration was proven.
- A DESKTOP-OKNV128 client would produce three physical hosts. That machine is
  the coordinator for this evidence collection, but this record does not
  select it or prove the exact WP9 client session/configuration.

The M4-04 card must carry that unresolved choice rather than infer it from
software presence or the phrase "three endpoints".

No `NETWORK/ACL`, `DNS/TLS-TRUST`, `BRIDGE-STAGE`, `CREDENTIAL/ENROLL`, or
`CLIENT/LIVE` approval is implied by this evidence record.

## Subsequent operator placement amendment — 2026-08-13

After this read-only discovery was recorded, the operator bound the WP9 client
to PETRUCCI. The resulting topology has three logical endpoints on two physical
machines: Gateway is `revagent`, while the WP9 client, Bridge, add-in, and Revit
are on `PETRUCCI`. `DESKTOP-OKNV128` remains the evidence coordinator and is not
an M4 client. This amendment resolves placement only; it does not convert the
installed Codex Desktop into proof of an active session, registration, or live
execution, and it does not claim that the sample model is currently open.

The DNS/TLS basis is retained in [`DP-04`](DP-04-domain.md) and the
[`DP-03/DP-04 staging evidence`](DP-03-04-cloudflare-staging.md). The production
name and stopped production connector are not used by M4. A separate same-zone
test FQDN, DNS-only private-address record, trusted-CA DNS-01 certificate, and
out-of-band narrow-zone token remain subject to their own operator card.

The seven M4-04/B records/gates remain distinct:
`CLIENT-PLACEMENT/FEASIBILITY`, `NETWORK/ACL`, `DNS/TLS-TRUST`,
`BRIDGE-STAGE`, `CREDENTIAL/ENROLL`, `CLIENT/LIVE`, and
`CLEANUP/RESIDUE-EQUALITY`. The placement decision is bound, but active-session
feasibility and all six execution gates remain open. `M4-WRITE-CONFIRM` remains
a later separate gate; M4-04/A is repo-only.
