# M5 Gate Evidence

## Header and anchor

**Protected-main anchor:** SHA `28214c4ef714436c2810680b840bda76f81feda9`,
tree `b02595a60a2854ec4c5b79263ce6e7073fd162d2`.

**M5 unit PRs delivered to protected main** (`gh pr view <N> --json mergeCommit,statusCheckRollup`):

| PR | Title | Merge commit (on `main`) | Post-merge CI (`gh run list --branch main --commit <sha>`) |
|---|---|---|---|
| [#403](https://github.com/BTankut/revAgent/pull/403) | [EU-10][M5] Authenticated tenant read | `f6764059a2aa4b181c1aed34a0443dca9150581f` | run 33589502708 `CI` SUCCESS; run 33589502713 `Gateway CI` SUCCESS; run 33589502710 `O1 add-in loopback fixture` SUCCESS; run 33589502705 `Gateway CD (M0 stub)` SKIPPED |
| [#404](https://github.com/BTankut/revAgent/pull/404) | [EU-11][M5] Enrolled and entitled Bridge dispatch | `8d530d0cf65b2865cf92fbbe5b98151250f1f142` | run 33600841035 `CI` SUCCESS; run 33600841045 `Gateway CI` SUCCESS; run 33600841076 `Gateway CD (M0 stub)` SKIPPED |
| [#405](https://github.com/BTankut/revAgent/pull/405) | [EU-12][M5] Event, result, retention, release data, and parity | `28214c4ef714436c2810680b840bda76f81feda9` | run 33674945050 `CI` SUCCESS; run 33674945013 `Gateway CI` SUCCESS; run 33674945120 `Gateway CD (M0 stub)` SKIPPED |

PR #405's merge commit is the current protected-main anchor, so PR #403/#404/#405
are the entire M5-labelled history on `main` between the pre-M5 base and the
anchor. All three merge commits appear in `git log --first-parent origin/main`
in that order immediately below the anchor.

## M5 evidence matrix

*(drafting)*

## Card acceptance checklist

*(drafting)*

## Red-result and gap disposition

*(drafting)*

## Milestone-owner decision card

*(drafting)*

## Authorization ceiling

*(drafting)*
