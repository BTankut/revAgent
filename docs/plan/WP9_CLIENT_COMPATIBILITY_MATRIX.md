# WP9 Phase-1 Designer Client Compatibility Matrix

**State:** M0 evaluation draft; no client selected

**Decision:** DP-10 remains open

**Vendor-document snapshot:** 2026-07-22; re-check before procurement and pilot

This is the Week-1 WP9 matrix required by `docs/implementation-plan/00-INDEX.md` §4. It screens candidate clients and defines the hands-on conformance suite. A vendor claim is not acceptance evidence: only a test against the revAgent north MCP surface, the selected DP-5 IdP, and live Revit can close a hard gate.

## Result vocabulary

| Mark | Meaning |
|---|---|
| `V` | Vendor documentation claims support; hands-on revAgent evidence still required |
| `H` | Hands-on test passed with retained evidence |
| `F` | Hands-on test failed |
| `B` | Blocked by missing revAgent/IdP/client capability |
| `?` | Not established |
| `N/A` | Not applicable to this candidate role |

DP-10 may select a fleet client only when every hard gate is `H`. No weighted score can compensate for a failed hard gate.

## Candidate roles

| Candidate | Intended role | M0 disposition | Reason |
|---|---|---|---|
| Claude Desktop | Primary GUI candidate for approximately 11 Turkish-speaking designers | `screened` | Vendor documents remote Streamable HTTP, OAuth/DCR, organization connectors, and GUI tool approvals; real confirm/file flows are untested |
| Claude web | Browser control candidate/fallback | `screened` | Shares remote connector support but cannot be assumed to preserve workstation-local file workflows |
| Claude Code | Developer/power-user reference client | `not_fleet_candidate` | Useful protocol baseline; CLI workflow does not satisfy the non-developer designer-UX gate without operator exception |
| Other GUI MCP client | Competitive alternative | `not_nominated` | WP9 must name a product and verify the same gates before comparison |
| ChatGPT/Codex desktop reattachment | None in Phase 1 | `out_of_scope` | P-CODEX-1 retires the existing local integration at cutover; reattachment is a later optional package, not a silent fallback |

No row above is a recommendation or procurement approval.

## Hard-gate matrix

| ID | Hard gate | Claude Desktop | Claude web | Claude Code | Other GUI | Required evidence |
|---|---|---:|---:|---:|---:|---|
| G1 | Windows access/install/open/login is repeatable by a designer | `?` | `V` | `V` | `?` | Clean Windows machine recording; install/admin prerequisites |
| G2 | Turkish-friendly chat UX; no terminal/config editing in daily use | `?` | `?` | `F` | `?` | Pilot designer completes scripted Turkish prompts unaided |
| G3 | Remote MCP Streamable HTTP reaches `https://gateway.<domain>/mcp` from the vendor's cloud origin | `V` | `V` | `V` | `?` | Public tunnel/IP policy, MCP initialize, and exact entitled `tools/list` capture |
| G4 | OAuth works with the selected DP-5 provider, including registration, refresh, revoke, and reconnect | `V` | `V` | `V` | `?` | Keycloak DCR or approved custom-client flow on the actual IdP; token lifecycle trace |
| G5 | Per-user identity and entitlement survive through Gateway audit rows | `?` | `?` | `?` | `?` | User/tenant/device/session ids and denied-tool test in audit evidence |
| G6 | GAP-2 confirm flow: preview → explicit user approval → expiring single-use `confirm_token` re-invocation | `?` | `?` | `?` | `?` | C05–C07; approval event includes who/when and links to `invocation_id` |
| G7 | No client “always allow” setting can bypass revAgent server-side confirm/gated policy | `?` | `?` | `?` | `?` | Forged/replayed/direct write attempts denied and audited |
| G8 | One read and one confirm-class write complete against live Revit with visible result | `?` | `?` | `?` | `?` | M4 conformance recording + model verification |
| G9 | Exported PNG/JPEG evidence is visible or securely downloadable, not only a server-local path | `V` | `V` | `?` | `?` | `export_revit_view_image` result opened by the user from the chosen client |
| G10 | Excel/CSV ingress has an explicit secure path to Gateway reconciliation | `?` | `?` | `?` | `?` | Client upload or O1 `file_fetch` proof; local path strings alone fail |
| G11 | Result files/exports have usable retention, download, and deletion behavior | `?` | `?` | `?` | `?` | Cross-machine open, expiry, access-denial, and cleanup evidence |
| G12 | Connector install/config can be centrally managed and repeated on every fleet machine | `V` | `V` | `?` | `?` | Owner provisioning + ordinary-user connect; machine rebuild rehearsal |
| G13 | Commercial/privacy terms, processing region, prompt-telemetry loss, tax, per-seat cost, and procurement owner are accepted | `?` | `?` | `B` | `?` | Security/privacy review, GAP-16 sign-off, dated quote, and approved annual total |
| G14 | Same exact client/build/config can run the ≥5-working-day pilot and fleet cutover | `?` | `?` | `N/A` | `?` | Version/config capture; pilot attestation; update policy |
| G15 | Assistant outage is distinguishable from Revit outage and recovery requires no model repair | `?` | `?` | `?` | `?` | Network-cut drill; Revit stays usable; Turkish error/support path |

`V` on G6 or G7 is deliberately impossible: a generic client tool-approval dialog is not the revAgent domain confirmation protocol.

## Secondary evaluation matrix

These factors choose between candidates only after all hard gates pass.

| Dimension | Claude Desktop | Claude web | Claude Code | Evidence still needed |
|---|---|---|---|---|
| Streaming/progress presentation | `?` | `?` | `?` | Long-running read + chunk/progress trace; cancellation behavior |
| Text and image MCP results | `V` | `V` | `?` | Representative schedule text and coordination image |
| Local files and desktop apps | `V` via separate desktop extensions, not the remote connector itself | `B` pending upload/download proof | `?` | Excel/Word/PDF workflow-by-workflow test; least-privilege review |
| Organization connector controls | `V` for Team/Enterprise owner-managed setup | `V` | `N/A` | Add/revoke connector; user join/leave; tool enablement policy |
| Turkish prompts and error comprehension | `?` | `?` | `?` | Pilot-user rubric across `evals/evals.json` scenarios |
| Large tool catalog usability | `?` | `?` | `?` | 40-tool entitled catalog after docs-MCP relocation; selection accuracy |
| Proxy/update behavior | `?` | Browser policy dependent | `V` proxy/auto-update configuration documented | Office proxy, forced update, rollback, and drift drill |
| User training burden | `?` | `?` | High by design | Timed install/login/read/confirm-write exercise |

## Current vendor-document screening

The following claims are useful for candidate admission only:

- Anthropic states that Claude and Claude Desktop can add custom remote MCP connectors. Team/Enterprise organization connectors are added by an Owner/Primary Owner; users then connect individually. The feature is marked beta. The remote request originates from Anthropic's cloud, even when the user is in Claude Desktop, so the Gateway must be publicly reachable through the approved tunnel and the data path requires explicit privacy review. [Custom remote connectors](https://support.anthropic.com/en/articles/11175166-about-custom-integrations-using-remote-mcp)
- Anthropic documents Streamable HTTP and OAuth remote servers, Dynamic Client Registration, token refresh, custom credentials for non-DCR servers, and text/image tool results. WP9 must still test the selected DP-5 provider rather than infer compatibility. The documented Claude.ai/Desktop result limit is approximately 150,000 characters and its tool timeout is 300 seconds, which C09 must exercise. [Remote MCP server requirements](https://claude.com/docs/connectors/building)
- Anthropic distinguishes remote connectors from local Claude Desktop extensions: local extensions may access workstation files/apps, while remote connectors reach hosted services. Combining them is possible but does not by itself solve revAgent file ingress, identity, or retention. [Desktop versus web connectors](https://support.anthropic.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)
- Claude Code documents remote HTTP MCP registration and browser OAuth through `/mcp`; DCR interoperability with the selected IdP still requires the same hands-on test. [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)
- The current US list-price evidence says Claude Team is USD 25/member/month billed annually or USD 30/member/month billed monthly, minimum five seats, excluding tax and regional differences. At 12 seats that is a provisional USD 3,600/year or USD 4,320/year before tax. This is a planning number only; procurement must obtain a Turkey-valid quote. [Team billing](https://support.anthropic.com/en/articles/9267289-how-is-my-bill-calculated)
- Anthropic's current Team-plan page says Claude Code is not included in Team. A power-user Claude Code lane therefore needs a separate licensing/API decision and must not be hidden inside the designer-seat estimate. [Team plan scope](https://support.anthropic.com/en/articles/9266767-what-is-the-claude-team-plan)

Vendor pages can change. Record page date/screenshot or exported evidence again when DP-10 is decided.

## Hands-on conformance suite

### Preconditions

- M2 north MCP endpoint available at the controlled DNS name with the entitled 40-tool target catalog (35 runtime + 5 docs tools).
- M5 OIDC/device/user/audit path available on the exact DP-5 provider.
- Approved tunnel permits the documented client-cloud origin without exposing a private/LAN-only endpoint; security review records what prompt and tool-result data leaves the office.
- Pilot Bridge connected to a disposable/test Revit model; model writes separately confirmed by the operator.
- Candidate version, Windows build, organization plan, connector settings, user identity, and test time recorded.
- No test uses `allow always` as a substitute for the revAgent GAP-2 protocol.

### Cases

| Case | Test | Pass evidence |
|---|---|---|
| C01 | Clean install/open/login as ordinary Windows user | Timed screen recording; no undocumented admin/CLI step |
| C02 | Owner adds organization connector; designer authenticates | Connector URL/config, OAuth redirects, user identity, no shared secret exposed |
| C03 | Token expiry/refresh, explicit revoke, and reconnect | Refresh succeeds; revoke blocks next call; audit/session transitions correct |
| C04 | Entitled catalog and denial | Exact expected tool names; unentitled tool absent and forged call denied |
| C05 | Turkish read workflow | Pilot user locates model evidence and understands guarded/partial warnings |
| C06 | Confirm preview and approval | Preview performs no write; client presents understandable proposed change and expiry |
| C07 | Confirm-token safety | One approved re-invocation commits once; replay, expiry, wrong user/session/params all fail; approval event linked to invocation |
| C08 | Live result verification | Revit shows the intended single change; journal/audit/result agree |
| C09 | Long result, progress, cancel, reconnect | No duplicate invocation/mutation; usable progress; bounded result handling |
| C10 | Revit image evidence | PNG/JPEG renders visibly and downloads only for authorized user before expiry |
| C11 | Excel reconciliation ingress | Selected file reaches Gateway through approved upload/`file_fetch`; review remains write-free; filename/path leakage bounded |
| C12 | Output file workflow | Export/reconciliation artifact opens on the designer machine; access expires and is tenant/session scoped |
| C13 | Network and Gateway outage | Turkish assistant-down message; Revit remains usable; reconnect resumes without model repair |
| C14 | Fleet manageability | Connector/user removal, machine rebuild, client update, and config drift are observable and repeatable |
| C15 | Five-working-day pilot | Same client/build/config used daily; failures, usage, training time, and user sign-off retained |

## DP-10 decision record template

| Field | Decision |
|---|---|
| Selected fleet client + exact build | `TBD` |
| Selected organization/licensing plan | `TBD` |
| Seat count and Turkey-valid annual total | `TBD` |
| Procurement and renewal owner | `TBD` |
| DP-5 IdP + OAuth registration mode | `TBD` |
| Connector provisioning owner/process | `TBD` |
| Confirm-flow conformance evidence | `TBD` |
| Excel/file-ingress disposition | `TBD` |
| Image/output-file disposition | `TBD` |
| Known lost/deferred workflows accepted by operator | `TBD` |
| Pilot user/machine/dates | `TBD` |
| Cutover build/config pin and update policy | `TBD` |
| DP-10 decision owner/date | `TBD` |

## Gate conclusion

M0 delivers this evaluation instrument, not a client choice. DP-10 remains open until a candidate passes G1–G15 hands-on, pricing/procurement is approved, and C01–C14 are green. M8 then requires C15 on the same client stack that M9 will deploy. If no candidate passes the confirm or file-workflow gates, the program must add the missing Gateway/client mechanism or explicitly reduce scope with operator sign-off; it must not remove the old Codex path first.
