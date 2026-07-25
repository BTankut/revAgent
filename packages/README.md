# RevAgent Migration Packages

This additive workspace hosts the target-architecture packages introduced during Milestone M0:

- `gateway` — TypeScript/ESM Gateway service package
- `bridge` — provisional .NET 8 bridge solution, pending final DP-1 confirmation
- `protocol` — RBP/1 JSON Schemas, generated TypeScript contracts, and validators
- `rbp-conformance` — private O1-T6 manifest, evidence schemas, fail-closed validators, and deterministic report/JUnit generators

The workspace deliberately does not move or import source from the frozen legacy surfaces during W1-2. In particular, `installer/runtime-mcp-server` retains its own package and lockfile, and `src/revit-plugin`, `installer`, `addons`, `evals`, `config`, root `AGENTS.md`, and root `SKILL.md` remain in place.

The transport spike is a separate W1-5 change. The conformance package starts
all forty cases as `not_run`. Its supervised C19 slice can execute real child
process fixtures without claiming the complete suite: the remaining 39 cases
stay `not_run` and the partial run exits nonzero.
