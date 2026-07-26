# RevAgent Bridge

This package is the WP3 boundary for the thin desktop Bridge selected by DP-1.
The executable targets .NET 8. `RevAgent.Contracts` targets `netstandard2.0`
so the same additive framing and contract code can later be referenced by the
existing .NET Framework add-in under the bounded P3-T6 migration-freeze
exception.

The current P3-T1 slice contains only contract primitives and conformance
tests:

- the existing add-in TCP length-prefix and strict JSON-RPC contract;
- the frozen RBP/1 display and document-context mapping boundary; and
- the detached RS256 distribution-signature verification contract.

It does not yet provide the Windows service host, Gateway transport, add-in
client, journal, enrollment, installer, or update behavior. Those land through
separate WP3 PRs in the order fixed by
`docs/implementation-plan/03-bridge-addin-installer.md`.

Run the complete P3-T1 contract gate from the repository root:

```powershell
.\scripts\test-bridge-contracts.ps1
```

The gate validates .NET framing and mapping behavior against the frozen
TypeScript schemas/fixtures and verifies a freshly generated Windows
PowerShell 5.1 RS256 signature with the .NET implementation.
