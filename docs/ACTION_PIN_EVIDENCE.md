# Immutable GitHub Action pin evidence

WP-05 implements RA-GW-013 / DC-11. Every external `uses:` reference in the
seven workflow files is pinned to one reviewed lowercase 40-hex commit. The
scanner at `scripts/test-workflow-action-pins.ps1` fails closed unless a use is
either a local `./` path or an `owner/repo@` reference ending in one exact,
lowercase 40-hex commit. It rejects tags, branches, uppercase or short object
names, quoted/dynamic values, and multiline or ambiguous YAML values.

| Action tag | Reviewed commit |
| --- | --- |
| `actions/checkout@v6` | `d23441a48e516b6c34aea4fa41551a30e30af803` |
| `actions/setup-node@v6` | `249970729cb0ef3589644e2896645e5dc5ba9c38` |
| `actions/upload-artifact@v7` | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| `actions/download-artifact@v8` | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` |
| `gitleaks/gitleaks-action@v2.3.9` | `ff98106e4c7b2bc287b24eaf42907196329070c7` |
| `anthropics/claude-code-action@v1` | `24dcd50c0568f0fc9e9211213a4fd2d9eb15c4e0` |
| `actions/checkout@v4` | `11d5960a326750d5838078e36cf38b85af677262` |
| `actions/setup-node@v4` | `49933ea5288caeca8642d1e84afbd3f7d6820020` |

## Retrieval provenance

The reviewed map was resolved on 2026-08-22 through the GitHub REST git-ref
and tag APIs. Each publisher repository/tag was resolved through any release,
lightweight tag, or annotated-tag object to its final commit identity before it
was admitted to this map.

## Runner and review boundaries

`ci.yml` runs the scanner immediately after each pinned checkout. The two
trust-boundary jobs in `signed-source-free-cd.yml` run it after their pinned
checkout identity checks and before signing or NAS publication. This does not
dispatch a workflow or alter runner labels, secrets, signing, publication, or
release policy.

`claude-review.yml` is itself pinned. A pull request that changes that workflow
cannot self-review; it requires human review and the documented manual-merge
exception.
