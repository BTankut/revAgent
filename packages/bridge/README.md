# RevAgent Bridge

This package is the WP3 boundary for the thin desktop Bridge selected by DP-1.
The executable targets .NET 8. `RevAgent.Contracts` targets `netstandard2.0`
so the same additive framing and contract code can later be referenced by the
existing .NET Framework add-in under the bounded P3-T6 migration-freeze
exception.

The current P3-T1/P3-T2 slices contain the contract primitives and the bounded
Windows service skeleton:

- the existing add-in TCP length-prefix and strict JSON-RPC contract;
- the frozen RBP/1 display and document-context mapping boundary; and
- the detached RS256 distribution-signature verification contract;
- the stable Windows service Host and supervised Worker split;
- strict `bridge-config.json` with the frozen 8080-8085 add-in discovery range
  plus an allowlisted `REVAGENT_BRIDGE_ADDIN_PORT` single-port override;
- structured rolling JSON-file logging and lifecycle Event Log integration;
- public Host CLI routing for `install`, `uninstall`, `run --console`, and
  `doctor`; and
- win-x64 self-contained single-file publishing for both executables.

It does not yet provide the Gateway transport, add-in client, journal,
enrollment, workstation installer payload, or update behavior. Those land
through separate WP3 PRs in the order fixed by
`docs/implementation-plan/03-bridge-addin-installer.md`.

Run the complete P3-T1 contract gate from the repository root:

```powershell
.\scripts\test-bridge-contracts.ps1
```

The gate validates .NET framing and mapping behavior against the frozen
TypeScript schemas/fixtures and verifies a freshly generated Windows
PowerShell 5.1 RS256 signature with the .NET implementation.

Run the P3-T2 non-admin service-skeleton gate from the repository root:

```powershell
.\scripts\test-bridge-service.ps1
```

This gate performs a locked restore, Release build/tests,
`dotnet format --verify-no-changes`, and isolated win-x64 self-contained
single-file publishes. It requires each publish directory to contain exactly
its expected executable and no DLL, `.deps.json`, `.runtimeconfig.json`, or PDB
sidecars. Both executables receive a bounded hidden `--version` smoke.

The doctor smoke invokes the published Worker's internal `__doctor` entry
point directly because an isolated Host publish deliberately has no installed
`versions\current` Worker layout. The gate clears inherited
`REVAGENT_BRIDGE_*` variables, generates a strict temporary config, and places
bare loopback TCP listeners at the configured Gateway and add-in ports. A valid
config must produce one `revagent-bridge-doctor/v1` JSON object with
`success=true`; the bare listeners must remain
`gateway.rbpAuthenticated=false` and `addin.shapeVerified=false`. This proves
bounded diagnostic behavior only. It does not prove an RBP handshake, Gateway
authentication, add-in framing, command shape, or Revit integration.

P3-T2's SCM and machine-lifecycle acceptance remains VM-only operator evidence:

- install the service under the canonical account and start it through SCM;
- prove clean SCM stop within 10 seconds;
- reboot the VM and prove the service and supervised Worker recover;
- verify lifecycle entries under the registered Windows Event Log source; and
- drive enough structured logs to prove rotation and retention on the installed
  ProgramData path.
