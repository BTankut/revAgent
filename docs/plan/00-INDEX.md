# Plan index — start here

**What this is.** revAgent is a Revit automation product being migrated from a
NAS-deployed workstation package to a Gateway/Bridge architecture: an external
MCP client talks to a **Gateway**, which talks over a frozen protocol (**RBP/1**)
to a **Bridge** running on the user's workstation, which drives a **Revit add-in**
against the live model. The `README.md` at the repository root documents the
*legacy* workstation package; the migration is tracked here.

**State as of `main` = `422b6862`** (2026-08-20).

| Milestone | Subject | State |
| --- | --- | --- |
| M0 | Phase-0 exit | passed 2026-07-22 |
| M1 | O1/RBP v1.0 freeze | **closed** — tag `rbp/v1.0.0` created and identity-validated 2026-07-31 |
| M2 | Gateway core / conformance vectors | accepted |
| M3 | Bridge + add-in live chain | accepted — proven live on a real Revit 2022 workstation |
| M4 | Pre-production-auth vertical slice | **`in_progress`** |

**Why M4 is still open, precisely.** M4 acceptance names *one read **and one
confirm-class write*** with originating-preview/approval/commit audit evidence.
The read is proven end to end through the real chain. The write is not — see
"already found" below. The `M4-04/B` gate itself is **`passed`** against its own
seven-gate scope, which contains no write gate. Those two facts are different and
this repository keeps them apart deliberately.

---

## Reading order for a reviewer

1. **`docs/TARGET_ARCHITECTURE.md`** — what is being built and why.
2. **[Repository Git topology and programme status](REPOSITORY_GIT_TOPOLOGY.md)**
   — the mechanical 155-head inventory, the separate programme-status view,
   and the preserved local recovery surface.
3. **`docs/plan/MASTER_PLAN.md`** — the living ledger: milestones, decision
   points, status vocabulary. Read the "Status vocabulary" section first; the
   words are load-bearing.
4. **`docs/implementation-plan/00-INDEX.md`** — the work-package breakdown and
   the frozen protocol specification (`01-protocol-O1.md`).
5. **`docs/plan/M4_GATE_EVIDENCE.md`** — the deepest document here, and the main
   subject of a review of "everything up to M4".
6. **`docs/plan/M4-04B-SESSION-2-CLOSING-RECORD.md`** — the closing record of the
   last live session, imported byte-for-byte. Its SHA-256 is attested in
   `M4_GATE_EVIDENCE.md`; it must never be edited in place.
7. Earlier milestones: `M1_O1_FREEZE_EVIDENCE.md`, `M2_GATE_EVIDENCE.md`,
   `M3_BRIDGE_GATE_EVIDENCE.md`.
8. **`AGENTS.md`** — the working discipline, including the slice ritual every
   change here follows.

---

## Known issues — please read before reporting findings

We are not asking you to agree with us. We are asking you to spend your budget on
ground we have **not** covered. Everything below is already recorded; challenge it
if you think we are wrong, but it is not new.

### Already found, root-caused, and queued

Nine findings from the last live session are recorded in full — with what each
cost and how it was caught — in `M4-04B-SESSION-2-CLOSING-RECORD.md` §2, and
summarised in `M4_GATE_EVIDENCE.md`.

| # | Finding | Where it goes |
| --- | --- | --- |
| 1 | Build-engine digest ≠ runtime-engine digest; only the runtime-resolved digest is authoritative | recorded |
| 2 | Windows OpenSSH: `ssh.exe` inside an inbound sshd session never exits when stdout is a pipe | slice `S4` |
| 3 | CRLF in a generated POSIX probe script | slice `S1` |
| 4 | Coordinator discarded the destination's own metadata | slice `S1` |
| 5 | Duplicate control byte would have corrupted a delivered secret by one byte | slice `S2` |
| 6 | TLS material timestamp guard refused every real file | **fixed**, `PR #383` |
| 7 | A journal in a particular state leaves the Bridge unable to hold a session | slice `S6`, blocked on `S5` |
| 8 | A registration form that could never have worked with the broker it registered | recorded |
| 9 | The pre-production Gateway entitles exactly **one** callable, by hardcoded design | recorded |

The follow-up queue is `S1`..`S6` in `M4_GATE_EVIDENCE.md` → "Post-session slice
queue". **`S5` (diagnosability) is strictly before `S6`** — finding 7's failing
statement has never been named, and the instrument that would name it does not
exist yet.

> **Label warning.** `R1`..`R6` and `S1`..`S6` are two different namespaces in
> `M4_GATE_EVIDENCE.md`. `R`n are **product requirements** raised by the live
> sessions; `S`n are the **post-session slice queue**. Records written before the
> rename that cite a queue item as `R`n mean `S`n.

### Known, deliberately deferred, with the reason

- **Park List** (`M4_GATE_EVIDENCE.md` → "Park List") — including an `npm audit`
  disposition deferred to the M5 security lane, a Bridge staged-worker startup
  anomaly that stays inside its timeout, and a session-1 certificate that is
  unrevoked and now unrevokable because its ACME account key was destroyed.
- **`GAP-14`** — Codex configuration rewrites. Two package-update samples
  destroyed a managed entry; one plain restart preserved it. Two of one shape and
  one of the other is **not a rule**; it is scheduled for deliberate re-test.
- **The single-callable entitlement (finding 9)** is an **M2 scaffold**, not a
  defect. M4 correctly built transport, identity, secret handling and the client
  path *around* it.
- **`M4-WRITE-CONFIRM`** — the missing confirm-class write. It is recommended,
  not decided, that it be sequenced with the M5 OAuth/entitlement lane rather than
  back-fitted onto a pre-production scaffold. Widening an entitlement to make a
  gate pass is a change this project declined to make under gate pressure.
- **`RES-30`** is **two-thirds** proven: real Gateway token exchange and
  revoked-device refusal at handshake are both proven live. Device-token
  persistence across reboot is **not**, and reboot is not authorized by any
  current card. Do not read `RES-30` as closed.

### Deliberate permanent deviations

- **The live workstation's DNS setting** is a permanent change, not unreverted
  residue.
- **The Bridge journal is left working, not left byte-identical.** The
  pre-session journal *is* finding 7's defect; restoring it would knowingly return
  the machine to a broken state. The original is archived as a reproduction
  fixture.

### Genuinely unknown — this is where your budget is worth most

We have not covered these, and we would rather you spent time here than
re-deriving the list above:

- **The confirm-class write path has never been executed end to end.** Preview →
  approval → commit, the originating-preview binding, confirm-token replay
  refusal, and the audit chain are implemented and unit-tested but have never run
  against a live Revit document.
- **Concurrency and crash-recovery on the invoke path.** A recorded residual
  window exists: the conflict index knows holds, not in-flight uncertainty, so a
  mutation left `executing` by a crash installs no hold until redelivery.
- **The M5 OAuth/entitlement design does not exist yet.** Everything about real
  multi-tenant entitlement is unbuilt.
- **Replay semantics.** Review gates have historically caught real RBP replay
  defects that local suites missed; this is the project's known weak spot.
- **Installer/uninstaller and migration** (M6) is specified but not built.
- **The frozen protocol itself** (`docs/implementation-plan/01-protocol-O1.md`) —
  it is frozen, but "frozen" is not "reviewed by someone outside the team".

---

## What is held outside this repository

Live-session evidence is hash-chained and retained on the coordinator
workstation, not committed here: 24 session-1 records, the per-session gate cards,
the 94-record session-2 chain, and a reproduction fixture that is a captured
defective database. `M4_GATE_EVIDENCE.md` → "What is held off-repo, and why"
lists them with the reason for each. **The evidence exists and can be produced by
name and SHA-256** — its absence here is a boundary, not a gap in the work.

---

## Maintenance

This index asserts a state. When a milestone state, a Park item, a queued slice or
a known-issue entry changes, update it **in the same slice** that changes the
underlying document — otherwise it becomes exactly the kind of stale record it
exists to prevent.
