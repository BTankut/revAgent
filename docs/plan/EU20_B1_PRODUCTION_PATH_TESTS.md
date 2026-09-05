# EU-20 B1 production-path verification

The production image runs `node packages/gateway/dist/main.js` with PostgreSQL,
the real M5 credential authority, shared WSS/HTTP ingress, filesystem private
objects and OIDC-authenticated `core.ui.state` dispatch. Missing database,
pepper, OIDC or object-root configuration refuses startup. Fixture identities
and conformance stores are not production adapters.

Run migrations from the same image using a separate `DATABASE_MIGRATION_URL`
and `REVAGENT_APP_DATABASE_PASSWORD`. Runtime receives only `DATABASE_URL` with
the restricted `revagent_runtime` role. `M5_TOKEN_PEPPER` stays out of logs.
Optional `GATEWAY_TLS_CERT_FILE`/`GATEWAY_TLS_KEY_FILE` must be supplied together;
otherwise TLS terminates at the existing trusted deployment proxy. The
production image includes migrations and does not migrate with runtime rights.

## One installer invocation

On a fresh machine, use `Install-RevAgentBridge.ps1 -WaitForEnrollmentArtifact`
(default handoff timeout 300 seconds, maximum 900) or `-PromptForEnrollment`.
Do the normal dry run first. Both modes prepare identity inside the same signed
installer invocation before asking for a fingerprint-bound token. The signed
host's `prepare-enrollment` command invokes the genuine C# random identity store
and returns only the public fingerprint. Elevated Administrators are supported
through the existing scoped restore privilege and LocalMachine DPAPI; the
installer does not need a LocalSystem process.

The noninteractive mode emits `enrollment_handoff_ready` plus the fingerprint,
then waits for the admin to atomically deliver the existing bounded M4
`enrollment.json` contract at the canonical credential directory. The file and
directory must be SYSTEM-owned with only SYSTEM/Administrators FullControl.
No enrollment token enters argv, environment or logs in this mode. Existing
artifacts and mixed secret sources are refused. The normal worker consumes and
proves deletion before exchanging, using the same prepared identity; first
enrollment cannot overwrite an existing device credential. Network exchange
runs after worker control-service composition, so SCM readiness does not wait
for the enrollment network request.

First-install artifact reads pin the fixed machine-owned policy through
`WindowsBridgeEnrollmentArtifactSource.CreateFirstInstall`. The A2 re-enrollment
constructor retains its current-user-owned policy. Both use actual Windows ACL
checks, pinned no-follow handles, single-link/default-stream checks and positive
deletion. This is policy selection, not an ACL mock or a permission bypass.

Manual bootstrap followed by `doctor --re-enroll` is not fresh-install evidence.
The actual signed installer/service/Revit acceptance remains the separately
authorized laboratory run; repository fixture proof never promotes EU-20.

## Reproducible repository proof

Prerequisites: Windows PowerShell 7, .NET 8 SDK, existing Linux Docker engine,
Node **24.14.1**, installed repository npm dependencies and built protocol
workspace. Use a new empty evidence directory and a committed clean candidate.
The script refuses existing `revagent-eu20-b1-*` containers/network rather than
changing another run. No Docker ports are published. C# connects through an
opaque TLS relay bound only to numeric loopback. The certificate is generated
for the fixture and pinned by its C# transport; production TLS behavior is unchanged.

From an **already elevated** disposable test process:

```powershell
pwsh -NoProfile -File .\scripts\test-eu20-production-path.ps1 `
  -RepoRoot <exact-candidate-checkout> `
  -EvidenceRoot <new-private-evidence-directory> `
  -NodePath <verified-node-24.14.1-node.exe> `
  -Mode genuine
```

This does not elevate itself, install/control a Windows service, select a Revit
process, or use canonical Bridge state. The complete profile creates a genuine
C# identity in a disposable root, mints through cryptographically verified
OIDC/M5, hands the artifact through a pipe/file without logging it, consumes it
using real machine ACL/DPAPI code, executes a WSS read, then restarts from the
persisted credential and executes an HTTP/SSE read. The add-in endpoint is an
explicit loopback fixture; the Gateway entry point and Bridge protocol pipeline
are real. `candidate.json` records head/tree, image id, dirty-state and proof scope.

Before generating secrets, the runner creates and reads back a private Windows
DACL owned by the current user and allowing only that user, SYSTEM and
Administrators FullControl. Existing/reparse/hardlink paths are refused; ancestor
ACLs are not changed. Generated files inherit that private policy.

Every long-lived test container/network carries a unique run label and its
creation id is retained. Cleanup verifies id/name/run ownership, checks native
exit codes and verifies resource absence, including a final run-label inventory.
`actualImageAndCSharpRead` retains the real check result; `cleanup` and
`overallOutcome` are separate. Incomplete cleanup fails the process and overall
outcome even when a read passed. `scripts/test-eu20-proof-safety.ps1`, also called
by `test-ci.ps1`, tests real private ACLs and eight simulated cleanup failure/state
cases; simulations are not represented as native Docker or privileged evidence.

`-Mode transport` runs the image/OIDC/M5 negatives and real C# WSS/HTTP reads with
explicit synthetic enrolled test credentials. It always records
`protectedFirstInstall: not_exercised`. This mode is runnable without elevation
and cannot replace the complete profile. The default elevated xUnit case proves
real ACL/DPAPI and consumption semantics but uses a test HTTP handler; it also
cannot replace complete-image proof. Missing privilege is an explicit skip or
failure, never PASS.

The fixture directory contains ephemeral test credentials/private TLS material.
Keep it private and outside release packages; attach only value-free logs and
public candidate metadata to review evidence.
