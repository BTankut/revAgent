## Summary

- What changed:
- Why it changed:
- Explicitly out of scope:

## Work package and milestone

- Work package (`WPn`):
- Milestone (`Mn`):
- Related DP/RES/GAP/issue:

## Validation

- [ ] I ran the relevant local tests/checks and recorded the exact commands and results below.
- [ ] I reviewed the final diff for unintended generated files, secrets, and unrelated changes.

Commands and results:

```text
<command> -> <result>
```

## Migration feature freeze (P8-T8)

- [ ] I verified that this PR does not change `installer/runtime-mcp-server/src/tools/**` or
      `src/revit-plugin/**`; **or**, if it changes either frozen path, the PR has the exact
      `migration-freeze-exception` label **and** links a dated exception/adaptation record in
      `docs/decisions/DP-log.md` below.

Dated DP-log exception/adaptation permalink:

<!-- Write `N/A — frozen paths not touched`, or paste a commit-pinned link to the dated DP-log heading. -->

The exception label is not blanket permission. Frozen-path changes must be an explicitly planned migration
protocol/transport adaptation or be covered by the linked dated record.

## Operator impact

- Operator action required (`yes` / `no`):
- Downtime, live-model write, account authorization, physical/network action, or user communication:
- R-G operator task-card and evidence destination (required when operator action is `yes`):

## Delivery impact

- Runtime/Add-in payload rebuild required:
- Installer or update behavior changed:
- Deployment, rollout, or NAS publish performed: `no` unless separately authorized and evidenced
