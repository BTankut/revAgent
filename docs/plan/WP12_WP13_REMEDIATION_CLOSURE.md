# WP-12 / WP-13 remediation closure

**Record state:** engineering evidence submitted; delivery record only
**Programme state:** unchanged
**M4 state:** `in_progress / not_submitted` pending the milestone owner

This tracked record makes the completed remediation evidence durable without
rewriting the historical evidence files or promoting milestone acceptance.

## Exact product anchor

- Engineering SHA:
  `029a164b8f9395c76052de65717f686b32d83234`
- Engineering tree:
  `6d86da917cb8f8bec54efb2e44bae598cf451567`
- Protected-main base:
  `4b194ab759f76618ac1143fa75ac7b13f14763e6`
- Superseding WP-12 Markdown handoff SHA-256:
  `356ec9054105fefef3da3a3065bdeead41bc7863429dd38c997a4be8b809e0cb`
- Historical malformed WP-12 Markdown SHA-256:
  `0dad2531132f2c838b667abe265ac48d9d3700cd60a9f42930af3e6f33105220`
- WP-13 handoff SHA-256:
  `d5497caae56f61434eb3569391385976fa3ba0bd240be5608d81354b84a58022`
- WP-13 evidence-index SHA-256:
  `524d6eaf765998c2fe2a428805288fe79623a74619824452b12a3f43d7034996`

## Finding dispositions

| Finding | Engineering disposition | Evidence anchor |
| --- | --- | --- |
| RA-GW-001 | CLOSED_ENGINEERING_EVIDENCE | `15-finding-closure-map.json` / SHA-256 `fcdfa2cec70b2404a9ba73fdf729beb054b3957f2bdc1ab664aff43215672253` |
| RA-GW-002 | CLOSED_ENGINEERING_EVIDENCE | `15-finding-closure-map.json` / SHA-256 `fcdfa2cec70b2404a9ba73fdf729beb054b3957f2bdc1ab664aff43215672253` |
| RA-GW-003 | CLOSED_ENGINEERING_EVIDENCE | `15-finding-closure-map.json` / SHA-256 `fcdfa2cec70b2404a9ba73fdf729beb054b3957f2bdc1ab664aff43215672253` |
| RA-GW-004 | CLOSED_ENGINEERING_EVIDENCE | `15-finding-closure-map.json` / SHA-256 `fcdfa2cec70b2404a9ba73fdf729beb054b3957f2bdc1ab664aff43215672253` |
| RA-GW-005 | CLOSED_ENGINEERING_EVIDENCE | `15-finding-closure-map.json` / SHA-256 `fcdfa2cec70b2404a9ba73fdf729beb054b3957f2bdc1ab664aff43215672253` |
| RA-GW-006 | CLOSED_ENGINEERING_EVIDENCE | `15-finding-closure-map.json` / SHA-256 `fcdfa2cec70b2404a9ba73fdf729beb054b3957f2bdc1ab664aff43215672253` |
| RA-GW-007 | CLOSED_ENGINEERING_EVIDENCE | `15-finding-closure-map.json` / SHA-256 `fcdfa2cec70b2404a9ba73fdf729beb054b3957f2bdc1ab664aff43215672253` |
| RA-GW-008 | CLOSED_ENGINEERING_EVIDENCE | `15-finding-closure-map.json` / SHA-256 `fcdfa2cec70b2404a9ba73fdf729beb054b3957f2bdc1ab664aff43215672253` |
| RA-GW-009 | CLOSED_ENGINEERING_EVIDENCE | `15-finding-closure-map.json` / SHA-256 `fcdfa2cec70b2404a9ba73fdf729beb054b3957f2bdc1ab664aff43215672253` |
| RA-GW-010 | CLOSED_ENGINEERING_EVIDENCE | `15-finding-closure-map.json` / SHA-256 `fcdfa2cec70b2404a9ba73fdf729beb054b3957f2bdc1ab664aff43215672253` |
| RA-GW-011 | CLOSED_ENGINEERING_EVIDENCE | `15-finding-closure-map.json` / SHA-256 `fcdfa2cec70b2404a9ba73fdf729beb054b3957f2bdc1ab664aff43215672253` |
| RA-GW-012 | CLOSED_ENGINEERING_EVIDENCE | `15-finding-closure-map.json` / SHA-256 `fcdfa2cec70b2404a9ba73fdf729beb054b3957f2bdc1ab664aff43215672253` |
| RA-GW-013 | CLOSED_ENGINEERING_EVIDENCE | `15-finding-closure-map.json` / SHA-256 `fcdfa2cec70b2404a9ba73fdf729beb054b3957f2bdc1ab664aff43215672253` |

These dispositions mean that the bounded engineering evidence is closed. They
do not mean programme acceptance, M4 acceptance, deployment approval, or
release approval.

## Final reviews

- Independent integration review: **PASS**; SHA-256
  `4a2fba55e9c86c70d11821c23a1b195b7fe6e7e9418798e2279935ae4f41b208`.
- Independent security review: **PASS**; SHA-256
  `14313a702fbde133ee20d3ea1e47e66d5ccad3f26ecdb9a7853c0d3bf26a121c`.
- Bounded final review reported **0 open Critical/High** findings.

The review records are local engineering attestations. The cumulative delivery
PR supplies the durable protected-check and review boundary.

## Live Revit evidence

- Live read: **PASS**; SHA-256
  `287c31e3dfe24bc50f423c2d169d9118728a447cf60b36a8992926f8192711c0`.
- Exact instance parameter: `Mark`, BuiltInParameter id `-1001203`.
- Initial value: `1-2`.
- Preview: **PASS**, `committed=false`; SHA-256
  `a815f7be249d040caefdc924f0e7fe7eaf49289ef755123a0ff30bc8c9ab29dd`.
- Verified temporary commit: `WP13-CONFIRM-20260831-01`; SHA-256
  `94618b7e1b9e7a829e8e7d32fceec0b9ab0c4d6a3303ef661c3b19837b852e08`.
- Independent temporary-value readback: SHA-256
  `68f759e7214533fd415f7d2ef2384f04a473ac35e1bdbe79ccaefd170f349cd4`.
- Verified restore to `1-2`: SHA-256
  `871440195aadd776642fab04ee6efc68b5fe56c1a13f80052d8a66ca90063b3a`.
- Initial and final schema records are byte-identical, SHA-256
  `316c2c13dab05f5debe6d026043f43faf5a4ddb4bf0acb193f7d997e76ef1e06`.

The live result files retain task/result data but not exact request-argument
manifests, and the installed runtime was not mechanically bound to engineering
SHA `029a164b`. This limitation is preserved rather than reconstructed.

## Controlled critical scenarios

- Real production Gateway + C# Bridge + add-in fixture commit-then-throw:
  WSS **PASS** and Streamable HTTP/SSE **PASS**, 2/2, exit 0.
  - command SHA-256:
    `1fed8274ca2df6a7a43f9aeec4e2880f4a80f6ef24523f8c4e507e4ae65f867b`
  - stdout SHA-256:
    `419e12b8850cc323a8a6c19cf3be980310c42722a5ec5d6fc641924be99ebe31`
- Focused revoke/session/scope set: **11/11 PASS**, exit 0.
  - command SHA-256:
    `1c08cd1de446dac2a53a95b535cbe2d5f75fe050b19fb5e9a208173494181fe1`
  - stdout SHA-256:
    `5a2abd77e334e8934f96fb082dc1219dbebf9b5dbbea0016239293ad0e9ef920`

Both commands record exact SHA/tree and a clean worktree before and after.

## Disposable model closure

- Model:
  `C:\Program Files\Autodesk\Revit 2022\Samples\rme_basic_sample_project.rvt`
- Pre-test SHA-256:
  `701e419b1f566c46bff51bb75f033d219719e593c47cfb2bb3548b6e8137fa51`
- Post-close SHA-256:
  `701e419b1f566c46bff51bb75f033d219719e593c47cfb2bb3548b6e8137fa51`
- Byte length: `30482432` before and after.
- LastWriteTimeUtc: `2021-02-04T12:25:02Z` before and after.
- PETRUCCI Revit 2022 process count after closure: `0`.
- The Revit journal records `TaskDialogResult = No / IDNO`.

The model was closed without saving and has no persistent Mark mutation. The
session produced only the expected Revit journal and worker-journal files; no
new RVT backup, `.slog`, lock, autosave, or model-named temp/cache artifact
was found.

## WP-03 supersession

- Old PR/head: `#388` /
  `d3151a6a2f5d1379903f3d54acf364868ec712fc`.
- Old patch-id: `f2afa8a09b1d4ff54b7bc9d7672f83af25a986bb`.
- Replacement commits present in `029a164b`:
  - `b304a8ca07f5a58082159868d0fdce6d0dd7eb02` — patch-id
    `98bfebf6affefc67b7276e0d60ef62c0adafaab9`
  - `b00917e592494111cd843df1adb1e4b620042d0d` — patch-id
    `c2810669afa700229dace2584e2f7ef3064b8537`
- Old affected path set: 55 paths across WP-03 orchestration,
  runtime `send_code_to_revit`, Bridge dispatch/storage, protocol mutation
  outcome, Revit dynamic-code, and their tests.
- Replacement affected path set: 57 paths across
  Bridge add-in routing, connection, dispatch, storage, runtime, and their
  correlated verification/application-error tests.
- Path comparison: 42 old-only and
  44 replacement-only paths.
- Tree comparison against `029a164b`: 0 identical,
  37 evolved, and
  18 retired old-path blobs.
- Disposition: **tested superset, not patch-equivalent**. The earlier
  outcome-v3 topology was replaced by the reviewed current-topology safety
  implementation and exact final matrices. The old PR head is intentionally
  not grafted into the graph.

## WP-05 supersession

- Old PR/head: `#390` /
  `3039a79d25d835742396b6563d9753445cd67411`.
- Old patch-id: `9b380d401c8d80e8a43749087599713b28ed1a94`.
- Replacement commits present in `029a164b`:
  - `505ddd0189a32d8b5af30c173c2e0e206dd448f3` — patch-id
    `c7104744f4ad9eea07ec7cfe262d86986f0ea2b2`
  - `7103da122c748638227b7944b3a5a1e64d73b2c3` — patch-id
    `0f1c083bfd6a3e04cd8230d25316cd675622900b`
- Old affected path set (13):
- `.github/workflows/ci.yml`
- `.github/workflows/claude-review.yml`
- `.github/workflows/gateway-cd.yml`
- `.github/workflows/gateway-ci.yml`
- `.github/workflows/o1-addin-loopback-fixture.yml`
- `.github/workflows/o1-bridge-simulator.yml`
- `.github/workflows/signed-source-free-cd.yml`
- `.orchestration/slice_records/WP-05.md`
- `.orchestration/work_packages/WP-05.json`
- `docs/ACTION_PIN_EVIDENCE.md`
- `scripts/test-installer-smoke.ps1`
- `scripts/test-workflow-action-pins-fixtures.ps1`
- `scripts/test-workflow-action-pins.ps1`
- Replacement affected path set (14):
- `.github/workflows/ci.yml`
- `.github/workflows/claude-review.yml`
- `.github/workflows/gateway-cd.yml`
- `.github/workflows/gateway-ci.yml`
- `.github/workflows/o1-addin-loopback-fixture.yml`
- `.github/workflows/o1-bridge-simulator.yml`
- `.github/workflows/signed-source-free-cd.yml`
- `docs/ACTION_PIN_EVIDENCE.md`
- `packages/gateway-stub/src/cli.ts`
- `packages/gateway-stub/tests/cli.test.ts`
- `scripts/test-installer-smoke.ps1`
- `scripts/test-signed-source-free-cd.ps1`
- `scripts/test-workflow-action-pins-fixtures.ps1`
- `scripts/test-workflow-action-pins.ps1`
- Tree comparison against `029a164b`: 9 identical,
  2 evolved, and
  2 superseded governance blobs.
- Disposition: **tested superset, not patch-equivalent**. The immutable action
  pins remain byte-identical on the seven workflows and pin scanners, while the
  replacement adds shutdown/fixture coverage and the signed-source-free check.

## Delivery-scope dispositions

The 47 literal write-scope exceptions are classified once in
`.orchestration/artifacts/FINAL-DELIVERY/scope-disposition.json`; none remains
a genuinely unexplained product change.

The production installer difference at
`installer/nas/Install-revAgent-Updater-GUI.ps1` is retained unchanged. It
adds hidden, provenance-bound test-fixture injection only for explicit smoke
modes; normal updater behavior remains on the production path. The already
recorded exact-SHA WP-12 global `test-all`, `test-ci`, installer, fixture,
and security gates cover this change. No new installer behavior is added by
this delivery repair.

## Release boundary

This repair performed no new live Revit operation, product behavior change,
deployment, release, signing, device revoke, or NAS publication. Main remains
unchanged. M4 remains `in_progress / not_submitted`; only the milestone owner
may change that state.
