# revAgent Distribution Integrity Plan

This document records the Phase 5 source-protection plan for verifying release
origin and package integrity. The goal is to make unauthorized or modified
revAgent release packages expensive to ship through the office update channel.

This is not a user-data privacy boundary. It protects the revAgent application,
release channel, and product know-how already hardened by the earlier
source-free package phases.

## Current State

The NAS release channel currently has these integrity checks:

- `channels\stable.json` points workstations at the target version, release
  manifest, package path, and package SHA256.
- `releases\<version>\manifest.json` records the release package, package hash,
  component hashes, update policy, and git identity.
- `update-from-nas.ps1` copies the ZIP to a local cache and verifies the ZIP
  SHA256 before replacing the managed package folder.
- The release ZIP is an allowlisted user pack and no longer carries source
  trees, debug symbols, source maps, or developer-only manifests.

The remaining gap is origin authenticity. If an attacker can alter both the
channel or release manifest and the package on the NAS, a hash check alone only
proves that the downloaded package matches the altered manifest.

## Threat Model

The integrity layer should protect against:

- a modified ZIP being placed on the NAS release channel;
- a channel manifest being edited to point to an unauthorized package;
- a release manifest being edited after publication;
- accidental publication from an untrusted or incomplete release path;
- later license or seat checks being bypassed by embedding signing or licensing
  secrets in the workstation payload.

The integrity layer does not try to prevent:

- a local administrator from modifying already-installed files;
- someone with repository access from reading source history;
- reverse engineering of the binaries already installed on a workstation;
- Revit model, workbook, telemetry, or user Codex memory disclosure.

## Trust Model

Private signing material must stay outside all shipped artifacts:

- no private release-signing key in Git;
- no private release-signing key in the NAS `tools/` folder;
- no private release-signing key inside a user release ZIP;
- no private licensing or seat-secret material in the updater or runtime
  payload.

The workstation updater may carry only public verification material:

- trusted public release keys;
- key IDs and public-key fingerprints;
- rotation metadata for current and retired-but-still-valid keys;
- enforcement policy for unsigned legacy releases during migration.

Release signing and license/seat enforcement are separate systems. A release
signature proves package origin. A license or seat token proves entitlement and
must use either a signed token verified by a public key or a service-side check.

## Signed Artifacts

Use detached signatures so existing JSON payloads remain readable and the
signature is never part of the signed bytes.

Recommended release layout:

```text
channels\
  stable.json
  stable.sig.json
releases\
  <version>\
    manifest.json
    manifest.sig.json
    revit-mcp-skill-<version>.zip
```

`manifest.sig.json` carries a detached signature envelope for `manifest.json`.
`stable.sig.json` carries a detached signature envelope for `stable.json`.

The target JSON is canonicalized and hashed as `contentSha256`. The signature
then covers a canonicalized signature payload built from the envelope fields
except `signature`, including `contentSha256`, `signedObject`, `algorithm`,
`keyId`, `publicKeyFingerprint`, `canonicalization`, and `createdAtUtc`. This
binds the release metadata to the signed content hash and prevents unsigned
metadata edits.

Signature envelope fields:

- `schemaVersion`
- `app`
- `signedObject`: `channel` or `release-manifest`
- `algorithm`
- `keyId`
- `publicKeyFingerprint`
- `canonicalization`
- `contentSha256`
- `createdAtUtc`
- `signature`

The signature must cover the package path and package SHA recorded by the
manifest. The ZIP bytes are still verified with SHA256 after copy, using the
signed manifest value.

## Canonicalization Requirement

Do not sign raw `ConvertTo-Json` output directly as the long-term contract.
PowerShell version, object ordering, and formatting changes can produce
different JSON text for the same logical manifest.

Before signature enforcement ships, add a tested canonical JSON writer, ideally
aligned with RFC 8785 JSON Canonicalization Scheme (JCS), with these
properties:

- UTF-8 without BOM;
- object keys sorted ordinally;
- arrays preserved in source order;
- integers, booleans, nulls, and strings encoded consistently;
- no insignificant whitespace, with the canonical form minified as required by
  RFC 8785 alignment.

The publish and updater paths must share the same canonicalization helper.

## Updater Verification Flow

The updater must verify origin before it replaces any local managed package
folder:

1. Load `channels\stable.json`.
2. Load and verify `channels\stable.sig.json` using the configured public key.
3. Resolve `manifestPath` from the verified channel.
4. Load `manifest.json`.
5. Load and verify `manifest.sig.json`.
6. Confirm the manifest version, channel, package path, and package SHA match
   the signed channel data.
7. Reject signed-channel replay by comparing a signed monotonic release
   sequence, signed minimum accepted version, or equivalent anti-rollback
   claim against the locally stored highest accepted release state.
8. Copy the ZIP to the local cache.
9. Verify the cached ZIP SHA256 against the signed manifest.
10. Continue with the existing component-aware update flow.
11. Record integrity verification status in local and NAS update reports.

After enforcement is enabled, signature, hash, or anti-rollback failure must
stop the update before package replacement. Guarded failures should be explicit
in logs and reports as distribution-integrity failures, not generic install
errors.

## Migration Policy

Phase 5 must not break existing unsigned stable releases before a signed
baseline is published.

Migration sequence:

1. Add canonicalization and verifier fixtures without changing production
   updater behavior.
2. Add optional signing to the publish path and write detached signature files
   when a signing key is provided.
3. Add updater verification in compatibility mode: signed releases are
   verified, unsigned releases are reported as legacy-compatible.
4. Add a signed release sequence or minimum-version claim and persist the
   highest accepted release state locally.
5. Publish one signed stable release through the normal human-approved NAS
   process.
6. Flip the updater policy to require signed channel and release manifests.
7. Keep an emergency rollback path that requires an explicit local operator
   flag, bypasses normal scheduled update execution, and writes an audit
   report. Replaying an older signed `stable.json` and `stable.sig.json` pair
   from the NAS channel must not be enough to roll a workstation back.

## Key Management

Required operational rules:

- Use an asymmetric signing algorithm supported by the Windows updater runtime.
- Assign every key a stable `keyId` and public-key fingerprint.
- Store private keys outside the repo and outside NAS `tools/`.
- Pass the private key path to the publish script only at publish time.
- Do not log private keys, passphrases, raw secret material, or private key
  paths if those paths reveal secret storage layout.
- Support multiple trusted public keys during rotation.
- Treat unknown key IDs, mismatched fingerprints, and revoked key IDs as
  verification failures after enforcement is enabled.

The concrete algorithm and private-key storage path must be chosen in the
implementation PR. The decision should optimize for reliable Windows
PowerShell verification without adding a heavy external dependency to every
workstation.

## License And Seat Boundary

License or seat checks are not a substitute for release signing.

Acceptable future patterns:

- signed entitlement token stored locally, bound to a documented machine
  identity claim, and verified with a public key only;
- service-side seat check with an offline grace policy;
- machine or user identity claim that is not trusted unless signed or confirmed
  by the service.

Rejected patterns:

- shared license secret embedded in the client;
- private license-signing key in the updater, runtime MCP server, DLL, or NAS
  tools folder;
- hard-failing office production workstations before an operator-approved grace
  and support policy exists.

## Workstreams

Each workstream should remain a separate PR:

1. Distribution integrity plan and gates.
2. Canonical JSON plus signature verification fixtures.
3. Publish-path detached signing support.
4. Updater verification in compatibility mode with reporting.
5. Signed-stable baseline and enforcement flip.
6. Optional license or seat design and implementation.

## Acceptance Gates

Implementation PRs must add tests for:

- valid channel signature;
- valid release-manifest signature;
- package hash mismatch after a valid manifest;
- tampered channel JSON;
- tampered release manifest JSON;
- unknown key ID;
- wrong public-key fingerprint;
- older signed channel replay blocked without explicit rollback authorization;
- unsigned legacy release in compatibility mode;
- unsigned release blocked after enforcement is enabled.

Release gates must also verify that private keys, test private keys, and license
secrets do not appear in the user pack, NAS `tools/`, or committed config.

## Phase 5 Outcome

This phase defines the release-origin trust model and the implementation gates.
It does not publish a NAS release, enable signature enforcement, add private
keys, or add license enforcement. Those changes require the separate
workstreams above and a signed stable baseline before fail-closed updater
behavior is enabled.
