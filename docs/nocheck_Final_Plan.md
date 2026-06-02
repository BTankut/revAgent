# TypeScript @ts-nocheck Allowlist Elimination Final Plan

## Summary

Remove the current six-file `@ts-nocheck` debt without enabling `strict:true`.
This work must not change Revit DLL payloads, ProgramData installation, NAS
release state, live Revit behavior, public MCP schemas, socket protocol,
bridge contract, or telemetry file format.

The work is split into five waves and five commits. Each wave removes
`@ts-nocheck` from the target file(s), tightens types, shrinks
`scripts/test-typescript-nocheck-policy.ps1`, and runs the required gates.

Initial allowlist:

- `installer/revit-api-docs-mcp/src/utils/docIndex.ts`
- `installer/runtime-mcp-server/src/utils/SocketClient.ts`
- `installer/runtime-mcp-server/src/utils/revitToolHelpers.ts`
- `installer/runtime-mcp-server/src/database/service.ts`
- `installer/runtime-mcp-server/src/utils/ConnectionManager.ts`
- `installer/runtime-mcp-server/src/utils/telemetry.ts`

## Key Changes

- Wave 1: `docIndex.ts` and `SocketClient.ts`
  - Covers both MCP packages.
  - Add small option/interface types for default `{}` parameters.
  - Use `Promise<void>` for no-value Promise resolution if needed.
  - Remove both files from the allowlist.
  - Pure-type wave: `build/` diff must stay empty.

- Wave 2: `revitToolHelpers.ts`
  - Add option-bag types for connection, status, execution, and normalizer
    helpers.
  - Preserve bridge normalizer behavior: canonical `resultContractVersion`
    payloads remain idempotent, legacy payloads keep parse/casing fallback.
  - Remove the file from the allowlist.
  - Pure-type wave: `build/` diff must stay empty.

- Wave 3: `database/service.ts`
  - Add narrow local SQLite row/result types.
  - Type object-spread sources as objects.
  - Preserve runtime database behavior.
  - Remove the file from the allowlist.
  - Pure-type wave: `build/` diff must stay empty.

- Wave 4: `ConnectionManager.ts`
  - Add option-bag types.
  - Inspect each `TS2554` call-signature issue individually.
  - Complete the call if the runtime argument is truly required; otherwise make
    the callee parameter optional.
  - Preserve multi-instance `target/host/port`, connection lock, and preflight
    behavior.
  - This is the only wave where `build/` diff may be legitimate.

- Wave 5: `telemetry.ts`
  - Add event, option, and record-payload types.
  - Preserve event names, telemetry file format, and write behavior.
  - Split only type/helper code if it improves readability without changing
    behavior.
  - Remove the final allowlist entry.
  - Pure-type wave: `build/` diff must stay empty.

- C# fallback helper decision
  - Do not merge `BridgeResultContract.ToCamelCaseToken` with
    `ExecuteCodeEventHandler.CreateSafeResultToken`.
  - Native bridge camelCase contract serialization and dynamic snippet
    verbatim result preservation intentionally differ.
  - Add only intent comments if needed; no behavior change.

## Test Plan

Every wave:

- Run `npm run build` for the relevant package(s).
- Run `npm run test` for the relevant package(s).
- Wave 1 runs both `runtime-mcp-server` and `revit-api-docs-mcp`; later waves
  run `runtime-mcp-server`.
- Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-typescript-nocheck-policy.ps1`.
- Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-mcp-build-payload-freshness.ps1`.
- Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-all.ps1`.
- Run `git diff --check`.

Pure-type invariant:

- Waves 1, 2, 3, and 5 must leave `git diff -- **/build/**` empty.
- If `build/` changes in those waves, stop and treat it as an accidental
  runtime behavior change.
- Wave 4 is the only exception because `TS2554` fixes may legitimately change
  emitted JavaScript.

Final acceptance:

- `rg -n "@ts-nocheck" installer\runtime-mcp-server\src installer\revit-api-docs-mcp\src`
  returns no matches.
- `scripts/test-typescript-nocheck-policy.ps1` has an empty allowlist or an
  explicit zero-allowed structure.
- `test-all` and payload freshness pass.
- Revit DLL/payload files are unchanged.

## Assumptions

- `strict:true` remains out of scope.
- Public MCP tool schemas, socket protocol, bridge contract, telemetry format,
  and runtime behavior do not change.
- Each wave is committed separately and remains reversible.
- Revit close, live Revit testing, ProgramData install, and NAS publish are out
  of scope.
