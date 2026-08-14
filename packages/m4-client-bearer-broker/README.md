# M4 client bearer broker

This Windows-only, self-contained broker is the explicit
`current_user_dpapi_broker_v1` consumer for
`revagent.m4-secret-handoff/v1`. It never accepts a bearer through command-line
arguments or environment variables and never writes plaintext credential
material to disk.

The receive action accepts the committed handoff frame on standard input,
protects the 64-byte synthetic/base64url-shaped bearer with CurrentUser DPAPI,
and writes only `north-bearer.dpapi` beneath an already-existing protected
root. Probe and cleanup positively prove absence. All public output and error
reasons are fixed, value-free JSON.

Serve mode opens only `http://127.0.0.1:<port>/mcp` and forwards only
GET/POST/DELETE to the fixed
`https://m4-gateway.revagent.app/mcp` upstream. It drops client credentials,
cookies, proxy/forwarding and hop-by-hop headers, then injects the sole bearer
it recovers from DPAPI only after that request's caller is authorized. The
per-request plaintext buffer is zeroed on success, refusal, upstream failure,
and cancellation; no process-lifetime plaintext bearer is retained. The native
Windows caller authority resolves the
client-side reverse TCP tuple, rejects the broker PID and ambiguity, and pins
the caller process and image while checking SID, packaged Codex identity,
exact account, package full name, protected package path, operator-pinned image
SHA-256, and cache-only Authenticode publisher certificate/thumbprint before
and after the upstream exchange.

This component does not stage credentials, change Codex registration, bind a
LAN interface, mutate DNS/trust, or perform a live Gateway/Revit operation.
The handle/identity and ACL sandwiches fail closed on observed replacement,
reparse, and hardlink changes; they do not claim isolation from a process that
already fully controls the same Windows user, Administrator, or SYSTEM.
