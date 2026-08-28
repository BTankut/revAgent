# Immutable GitHub Action pin evidence

WP-05 implements RA-GW-013 / DC-11. Every external `uses:` reference in the
nine workflow files are pinned to one reviewed lowercase 40-hex commit.

`scripts/test-workflow-action-pins.ps1` scans recursive workflow YAML and any
repository `action.yml`/`action.yaml` manifest (excluding `.git` and
`node_modules`). Its bounded YAML lexer recognizes lowercase `uses` keys in
block mappings and flow mappings, with unquoted, single-quoted, or
double-quoted keys; it processes multiple flow keys on one line. A value may be
a plain or single/double-quoted scalar, but after decoding it must be exactly
either `./` plus a local relative path (without `..`) or
`owner/repo@` plus a lowercase 40-hex commit. The lexer strips a comment only
when its `#` is outside a quoted scalar and starts after whitespace.

This is an intentionally narrow fail-closed lexer, not a general YAML parser.
It rejects every recognized `uses` key that lacks one exact scalar, including
multiline values, anchors, aliases, dynamic expressions, reusable workflows,
Docker actions, tags, branches, uppercase SHAs, short SHAs, and ambiguous
tails. Backslash escapes in *any* double-quoted mapping key and YAML explicit
mapping-key syntax (`? key`, quoted explicit keys, and flow explicit keys) are
rejected globally as unsupported, even when the key is unrelated to `uses`.
An explicit-key indicator is rejected even when bare or comment-only and its
key/value continues on a later line. Outside quoted scalars/comments, YAML
anchors, aliases, and merge tokens (`&name`, `*name`, `<<:`) are also rejected.
Quoted mapping keys must open and close on the same physical line; escaped or
continued double-quoted keys and multiline single-quoted keys fail closed.
In YAML structural content, an anchor or alias indicator at a token boundary
followed by any non-whitespace, non-flow-delimiter character is rejected; this
covers punctuation and Unicode names rather than only ASCII names. Quoted
scalar contents and literal/folded block-scalar payload lines are excluded so
ordinary shell `&&` and glob text remain valid in `run: |`/`run: >` payloads.
Inline `run:` scalar command text is likewise excluded from this YAML
indirection check; the scanner continues to inspect every structural mapping
line and every `uses` value.

For literal/folded block scalars, the scanner infers the content indentation
from the first raw nonblank payload line and skips only that indentation or
deeper. A `#` line inside a block scalar is payload, not a YAML comment. A later
raw nonblank dedent is rescanned as YAML structure, even if it remains deeper
than the indicator line. Explicit indentation indicators are honored
conservatively; missing or contradictory payload indentation fails closed rather
than extending a block-scalar skip.
For sequence mappings such as `- name: |`, the comparison baseline is the
mapping-key structural column after the dash, not the physical line's leading
indent. A first nonblank line at that key column ends an empty scalar and is
rescanned as YAML structure; only a deeper line may establish block content.
Workflow YAML syntax is checked separately. The fixture matrix at
`scripts/test-workflow-action-pins-fixtures.ps1` exercises these accepted and
rejected forms.

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

On 2026-08-28, the public GitHub APIs again resolved the seven non-annotated
tag identities to the tabled commits. The moving
`anthropics/claude-code-action@v1` tag now resolves to a newer annotated target,
while the approved historical commit remains available. The workflow therefore
keeps the reviewed immutable commit rather than following the moving tag.

## Runner and review boundaries

`ci.yml` runs the scanner immediately after each pinned checkout. The two
trust-boundary jobs in `signed-source-free-cd.yml` run it after their pinned
checkout identity checks and before signing or NAS publication. This does not
dispatch a workflow or alter runner labels, secrets, signing, publication, or
release policy.

`claude-review.yml` is itself pinned. A pull request that changes that workflow
cannot self-review; it requires human review and the documented manual-merge
exception.
