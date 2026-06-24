# Retrospective Code Review — PRs #74–#97 (un-reviewed merges)

**Scope:** every PR merged to `main` from #74 (`aecc4e3`, 2026-06-22) through #97 (`4aaa512`, 2026-06-24).
**Diff range:** `04b6cb6` (parent of #74) → `4aaa512` (HEAD). 58 files, ~15,457 insertions / 115 deletions.
**Why this exists:** the Claude Code review workflow did not exist until #80 and was broken/silent until the #89 and #96 fixes — so this entire security-critical band (release signing, integrity verification, anti-rollback, license seat, signed CD, source-free migration) merged with **no review**.
**Method:** 10 subsystem reviewers → each finding adversarially verified by an independent skeptic → cross-cutting threat-model pass. 44 agents total. 33 raw findings → **30 confirmed, 1 uncertain, 2 refuted**.
**This is a read-only audit. No code was changed.**

---

## TL;DR

The signing / anti-rollback / license machinery is **well-built in isolation but does not protect anything in its shipped default configuration**. The entire trust chain collapses to a single trust boundary — *write access to the NAS share* — and every layer that is supposed to defend that boundary is either off by default, loaded unverified from that same boundary, or pinned to nothing.

**The one-line risk:** an actor who can write to the NAS release path can serve arbitrary code that every workstation installs and executes — *without forging any signature* — because (a) the updater defaults to `compatibility` (fail-open), (b) the verifier module and the trust-root key file both live on that same writable share and are loaded unverified, and (c) a single unsigned release resets client anti-rollback to 0.

Severity tally (post-verification, adjusted): **1 critical · 5 high · 7 medium · 17 low · 3 info.**

---

## Severity-ordered findings table

| # | Sev | Cat | Subsystem | PR | Location | Finding |
|---|-----|-----|-----------|----|----------|---------|
| 1 | **CRIT** | sec | updater | #82 | `installer/nas/update-from-nas.ps1:86,1686,2846` | Integrity policy defaults to `compatibility` → signature verification is **fail-open by default** |
| 2 | **HIGH** | sec | integrity-core | #82 | `installer/lib/RevitMcp.DistributionIntegrity.psm1:1208,1253-1266` | Compatibility mode returns success/`legacy-compatible` when **both signatures are stripped** (the mechanism behind #1) |
| 3 | **HIGH** | sec | updater | #83 | `installer/nas/update-from-nas.ps1:3301-3304,1775-1789` | Accepting one unsigned legacy release **resets the anti-rollback watermark to 0**, re-enabling downgrades |
| 4 | **HIGH** | sec | systemic | #81/82/83 | `publish-nas-release.ps1:990`, `update-from-nas.ps1:1733-1744` | **Trust-root key file** (`release-trusted-keys.json`) co-located on writable NAS, never pinned out-of-band |
| 5 | **HIGH** | sec | systemic | #82 | `update-from-nas.ps1:56-74,2683-2690` | **Verifier `.psm1` loaded unsigned** from the writable NAS share — swap it to always-succeed and the whole chain dies |
| 6 | **HIGH** | sec | ci-cd | #93 | `.github/workflows/signed-source-free-cd.yml:115` | Push to `main` **auto-publishes to prod NAS**, gated only by external environment protection (no CODEOWNERS/branch protection in repo) |
| 7 | MED | sec | docs | #97 | `installer/INSTALLATION.md:101-110` | Recovery publish command **omits signing** → operator publishes an unsigned release that workstations silently accept (doc-driven instance of #1) |
| 8 | MED | rel | publish | #87 | `publish-signed-source-free-release-to-nas.ps1:154-155` | Active-release pointer (channel JSON + sig) swapped **non-atomically** → races the updater scan; crash leaves a permanently half-updated pointer |
| 9 | MED | rel | publish | #87 | `publish-signed-source-free-release-to-nas.ps1:154-164` | Publisher overwrites the **live** stable pointer **before** its own post-publish readiness re-check; failed gate still mutates prod, no auto-restore |
| 10 | MED | sec | publish | #87 | `publish-signed-source-free-release-to-nas.ps1:144-164` | **No publish-time anti-rollback** — an older validly-signed release can be promoted over a newer one (hits fresh installs) |
| 11 | MED | maint | migration | #85 | `installer/install-self-contained.ps1:647-781` | Cleanup logic **duplicated** between module and installer and has **drifted** — fresh vs migrated installs leave different residue |
| 12 | MED | rel | ci-review | #96 | `.github/workflows/claude-review.yml:18-66` | Automated review is **advisory-only** — cannot block merge |
| 13 | MED | sec | ci-review | #96 | `.github/workflows/claude-review.yml:10-11` | Missing `synchronize` event → **post-open commits escape review** |
| 14 | MED | rel | ci-review | #80 | `.github/workflows/claude-review.yml:10-30` | Review **silently no-ops on fork PRs** (OAuth secret not exposed to fork `pull_request`) |
| 15 | MED | test | tests | #88 | `scripts/test-signed-source-free-cd.ps1:144` | CD "require-signing" asserted only by a **source-text grep**, not behavior |
| 16 | MED | docs | docs | #97 | `CHANGELOG.md:5-13` | CHANGELOG **omits the entire signing/integrity/anti-rollback/license workstream** (#78–#85) |
| 17 | LOW | sec | license | #84 | `installer/lib/RevitMcp.License.psm1:228-235` | Seat check is offline-only, **no machine binding / no seat-count** → unlimited seat sharing |
| 18 | LOW | sec | license | #84 | `RevitMcp.License.psm1:200-206` | `expiresAtUtc`/`notBeforeUtc` optional → a signed license with neither **never expires** |
| 19 | LOW | sec | license | #84 | `RevitMcp.License.psm1:155-235` | **No license revocation / anti-rollback** (unlike the release path) |
| 20 | LOW | rel | updater | #85 | `update-from-nas.ps1:3093-3106,3247-3261` | Migration **deletes user/source artifacts before final install completes**, no rollback on partial failure |
| 21 | LOW | sec | publish | #87 | `publish-signed-source-free-release-to-nas.ps1:138` | `tools/` (trusted keys + lib modules) replaced **live** during publish while updaters may be reading it |
| 22 | LOW | sec | ci-cd | #90 | `signed-source-free-cd.yml:71` | Signed release root handed off via **mutable persistent-runner workspace** (TOCTOU) |
| 23 | LOW | sec | ci-cd | #93 | `signed-source-free-cd.yml:62` | Auto-publish on push **never raises the anti-rollback floor** |
| 24 | LOW | sec | ci-review | #96 | `.github/workflows/claude-review.yml:41-66` | Untrusted PR title/body/diff fed to model **with comment-writing tools** (bounded prompt injection) |
| 25 | LOW | rel | integrity-core | #81 | `RevitMcp.DistributionIntegrity.psm1:669` | Canonical-JSON **throws (uncaught) on float/decimal** content → crashes updater instead of structured reject (fail-closed) |
| 26 | LOW | sec | integrity-core | #83 | `RevitMcp.DistributionIntegrity.psm1:1137` | Anti-rollback **permits replay of equal release sequence**; duplicate-key gaps |
| 27 | LOW | sec | payload | #75 | `scripts/build-mcp-release-bundle.mjs:107-118` | JS "hardening" is **plain minification, not obfuscation** — source logic + strings trivially recoverable |
| 28 | LOW | maint | payload | #76 | `scripts/RevitPayloadManifest.psm1:174-209` | .NET symbol stripping deletes `.pdb`/`.mdb` post-build but **no build-level `DebugType` guard** |
| 29 | LOW | rel | payload | #75 | `runtime-mcp-server/src/utils/runtimeIdentity.ts:21-35` | Root resolution relies on first ancestor with a marker file → **silent misresolution** if layout changes |
| 30 | LOW | test | tests | #88 | `scripts/test-all.ps1:44-59` | `test-all.ps1` **omits** the signed-CD & signed-stable-readiness tests that `test-ci.ps1` runs |
| 31 | LOW | test | tests | #95 | `runtime-mcp-server/scripts/write-tool-contract.test.mjs:25-37` | Telemetry-isolation guard matches a **bare string, no ordering** enforcement |
| 32 | INFO | maint | ci-review | #80 | `.github/workflows/claude-review.yml:9-20` | No `concurrency` control → redundant runs, wasted quota |
| ? | UNCERTAIN | rel | migration | #86 | `installer/nas/migrate-source-free-install.ps1:330-411` | Migrate wrapper has no package rollback; partial-failure handling depends on runtime not fully visible in repo |

**Refuted (checked and dismissed — do NOT spend PR effort here):**
- *Commit-mode migration untested* (#86) — **false**: `test-source-free-migration.ps1:124-223` has a dedicated commit-mode test with a stubbed updater.
- *`id-token: write` over-grant* (#80) — **false premise**: dismissed on technical grounds by the verifier (still worth a 1-line trim but not a real issue).

---

## Suggested remediation PRs (grouped by theme)

Ordered by risk. Each group is independently shippable.

### PR-1 — Close the fail-open integrity chain  🔴 *highest priority, security*
Findings **1, 2, 3, 4, 5, 7** — these interlock and must land together to mean anything.
- Make the client **fail-closed**: when trusted keys are present, require `enforce`; treat `compatibility` as an explicit, time-boxed opt-in (the plan's own steps 6–7, `REVAGENT_DISTRIBUTION_INTEGRITY_PLAN.md:186`).
- **Sticky downgrade guard:** once a signed release is accepted, refuse any later unsigned/`legacy-compatible` release; never lower the persisted watermark (store `Max(stored, new)`, and don't let an unsigned path write 0).
- **Pin the trust root:** ship the expected key fingerprint in a locally-protected installer config; reject unpinned keys. Stop trusting any `keyId` whose fingerprint merely matches the envelope.
- **Protect the verifier:** install verifier `.psm1` + keys in a local, write-protected location (or detached-sign `lib/` and verify with the pinned key before import) instead of importing unsigned from NAS.
- Fix the **INSTALLATION.md recovery command** to include signing flags (it currently teaches the unsafe path).

### PR-2 — Publish/CD pipeline safety  🟠 *security + reliability*
Findings **6, 8, 9, 10, 21, 22, 23**.
- Keep prod publish behind **explicit human approval even on push**; assert env-protection as a prerequisite; add `CODEOWNERS` + branch protection on `main`.
- **Atomic pointer swap:** stage channel JSON + sig to temp, promote with a single atomic rename; run the final readiness check against the *staged* pointer *before* the live swap; back up + auto-restore the prior pointer on failure.
- Add **publish-time anti-rollback** (compare candidate `releaseSequence` against live, require `-AllowRollback` to go backward).

### PR-3 — Make the review gate actually gate  🟠 *process — this is the gap that caused all of the above*
Findings **12, 13, 14, 32**.
- Add `synchronize` to triggers so post-open commits are reviewed.
- Decide block-vs-advisory (required check / merge gate); handle fork PRs explicitly instead of silent no-op; add `concurrency`.

### PR-4 — License hardening  🟡 *security, lower urgency (feature is "optional")*
Findings **17, 18, 19**. Machine binding + seat-count, require an expiry window, add a revocation/anti-rollback path. (Note: may need a server component — scope accordingly.)

### PR-5 — Migration robustness  🟡 *reliability*
Findings **11, 20, UNCERTAIN #86**. Defer destructive cleanup until after successful install; add rollback on partial failure; de-duplicate cleanup logic (import the module from the installer or add an equivalence test).

### PR-6 — Test & build integrity  🟢 *quality*
Findings **15, 30, 31, 25, 26, 27, 28, 29**. Replace grep-based assertions with behavioral negative tests (assert tampered/unsigned/rolled-back releases are *rejected*); make `test-all.ps1` a superset of `test-ci.ps1`; wrap canonical-JSON hashing in structured error handling; add a `DebugType` build guard; document that JS payloads are minified-not-obfuscated.

### PR-7 — Docs/changelog truth-up  🟢 *docs*
Finding **16** (+ the doc half of 7). Backfill CHANGELOG for the security workstream; reconcile every doc security claim against actual default behavior (don't claim "signed & verified" while the default is fail-open).

---

## Cross-cutting note (threat-model pass)

The weakest link is unambiguous: **the NAS share is simultaneously the payload store, the trust-root store, and the verifier-code store, and it is writable by the attacker the signing scheme is meant to defend against.** Signing only adds value once (a) the client fails closed, (b) the public key is pinned out-of-band, and (c) the verifier itself is not loaded from the untrusted share. PR-1 addresses all three; until it lands, the cryptographic machinery is effectively decorative against the primary threat.

*Open item flagged by the systemic pass (not separately verified): confirm the updater re-verifies the downloaded ZIP `sha256` against the signed manifest **before extraction** (`update-from-nas.ps1` after ~:2860).*
