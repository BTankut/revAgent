# revAgent Bridge Result Contract Normalization Plan

## Summary

This plan cleans the result contract at the Revit bridge boundary. The goal is
not to enable `strict:true`. The goal is to remove C# bridge double-encoded
dynamic results, make native bridge result casing canonical, and narrow the TS
normalizer only when a self-describing contract signal proves that the active
bridge supports the new behavior.

## Key Changes

- **Preflight**
  - Work must start from the post-hardening `origin/main` baseline.
  - Do not start if `runtimeResult.ts`,
    `test-typescript-nocheck-policy.ps1`, or
    `test-mcp-build-payload-freshness.ps1` is missing.

- **C# bridge contract**
  - Dynamic execution returns JSON tokens/objects in
    `ExecutionResultInfo.Result` instead of pre-serialized JSON strings.
  - `null`, primitive returns, and unserializable Revit objects must use a safe
    fallback instead of crashing the bridge.
  - Native bridge success payloads use one central camelCase helper.
  - Both `CreateSuccessResponse` implementations and the SocketService
    guarded/failed detection paths must use the same helper behavior.

- **Result contract version**
  - Every JSON-RPC `result` payload exposes `resultContractVersion`.
  - `mcp_status` exposes the same field for discovery and diagnostics.
  - The dynamic double-encode fix and native camelCase fix ship in one Revit
    DLL payload release and one `resultContractVersion` bump.

- **TS runtime compatibility**
  - `normalizeRevitExecutionResponse`, `parseJsonLike`, and
    `normalizeSuccessCasing` remain in place for legacy and raw dynamic payloads.
  - Normalization is decided per response from the payload's
    `resultContractVersion`, not from a process-global flag.
  - Canonical camelCase/object payloads must be idempotent through the
    normalizer. New TS with an old DLL and old TS with a new DLL must both stay
    safe during rollout skew.

- **Docs and deploy**
  - Align `SKILL.md`, `AGENTS.md`, `docs/DEVELOPER_RUNBOOK.md`,
    `docs/REPOSITORY_STRUCTURE.md`, `README.md`, and `CHANGELOG.md`.
  - Because Revit-loaded payloads change, build/install/deploy work requires
    Revit to be closed.
  - `strict:true` remains out of scope.

## Test Plan

- **Non-Revit checks**
  - `scripts/test-installer-smoke.ps1`
  - `scripts/test-typescript-nocheck-policy.ps1`
  - `scripts/test-mcp-build-payload-freshness.ps1`
  - `scripts/test-all.ps1`

- **Characterization tests**
  - Fail if `ExecutionResultInfo` reintroduces
    `JsonConvert.SerializeObject(result)`.
  - Fail if bridge response, guarded, or failed result inspection bypasses the
    central camelCase helper.
  - Assert `resultContractVersion` is present in the response payload and
    visible through `mcp_status`.

- **Mocked unit tests**
  - Cover one legacy response without a contract signal and one canonical
    response with `resultContractVersion`.
  - Assert normalizer behavior is per response, not global.
  - Assert canonical camelCase/object payloads are unchanged by the normalizer.

- **Payload and live Revit**
  - `scripts/build-revit-plugin.ps1 -RevitVersion 2022`
  - Refreshed DLL payload hash/freshness check.
  - `scripts/test-commandset-live.ps1`
  - Manual checks:
    - A manual `Transaction.Start()` inside `transactionMode:auto` is guarded.
    - Dynamic object results are not double-encoded strings.
    - Native bridge commands emit camelCase `success`.
    - `resultContractVersion` is readable from the response payload.
    - New TS with old DLL stays on the legacy path.
    - Old TS with new DLL stays safe because normalization is idempotent.

## Assumptions

- This is a separate commit/release from the architecture hardening commit.
- Multi-instance support means compatibility decisions must not be
  process-global.
- Double-encode and casing C# changes ship in one DLL release.
- `normalizeSuccessCasing` is narrowed only after the capability signal is
  proven; it is not removed in the first pass.
- `strict:true` is not enabled.
