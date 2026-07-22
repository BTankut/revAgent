# RevAgent Gateway

This is the additive M0 package boundary for the RevAgent Gateway. It mirrors the existing runtime's TypeScript ESM conventions (`ES2022`, `NodeNext`, strict mode) and pins the same MCP SDK major.

W1-2 contains only package/config/test scaffolding. The W1-5 Streamable HTTP catalog spike is intentionally delivered in a separate PR. Production orchestration, auth, persistence, dispatch, and bridge transport arrive after the O1 specification review gates permit them.

The MCP SDK 1.29 dependency graph currently includes `@hono/node-server` 1.19.x. GitHub advisory GHSA-frvp-7c67-39w9 affects that package's Windows-only `serve-static` helper; this Gateway does not serve static files and only imports the SDK Streamable HTTP transport. A forced 2.x override is intentionally avoided because it produces an invalid semver tree. W1-5 exercises the transport end to end, and the dependency should be upgraded when the SDK publishes a compatible patched range.
