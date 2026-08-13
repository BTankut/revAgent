# M4 secret-handoff receiver

This is the listenerless Windows destination for the versioned
`revagent.m4-secret-handoff/v1` binary seam. It is published as a .NET 8
`win-x64` self-contained single-file executable so the live workstation does
not depend on PowerShell's text pipeline or a separately installed Node/.NET
runtime.

The receiver accepts only `north_bearer` and `enrollment_artifact`, requires an
exact self SHA-256 at process start, validates a canonical current-user-owned
protected root, uses an exclusive protected file handle, and commits only after
the coordinator sends the final control byte. Every refusal emits one fixed
value-free JSON line. The north bearer remains deliberately closed as
`client_secure_store_unavailable` until a separately approved client secure
store exists.

This package does not authorize staging or execution on PETRUCCI. A later live
card must bind the exact published executable digest, destination path, ACL,
retention, and cleanup.
