# WP9 Phase-1 Designer Client Compatibility Matrix

**State:** M0 evaluation draft; Phase-1 client selected, conformance pending

**Decision:** DP-10 selected the existing authorized ChatGPT/Codex Desktop client on 2026-07-22

**Vendor-document snapshot:** 2026-07-22; re-check before procurement and pilot

This is the Week-1 WP9 matrix required by `docs/implementation-plan/00-INDEX.md` §4. The operator selected the existing authorized ChatGPT/Codex Desktop client; this file now defines the hands-on evidence needed to authorize that selection for pilot and cutover. A vendor claim or operator selection is not acceptance evidence: only a test against the revAgent north MCP surface, the selected DP-5 IdP, and live Revit can close a hard gate. The dated R-F amendment is carried by decision-checkpoint PR [#268](https://github.com/BTankut/revAgent/pull/268).

## Result vocabulary

| Mark | Meaning |
|---|---|
| `V` | Vendor documentation claims support; hands-on revAgent evidence still required |
| `H` | Hands-on test passed with retained evidence |
| `F` | Hands-on test failed |
| `B` | Blocked by missing revAgent/IdP/client capability |
| `?` | Not established |
| `N/A` | Not applicable to this candidate role |

DP-10 selection is recorded. Pilot/cutover may use it only when every applicable hard gate is `H`; every `N/A` requires an explicit responsibility/scope justification. No weighted score or selection decision can compensate for a failed or unknown hard gate.

## Candidate roles

| Candidate | Intended role | M0 disposition | Reason |
|---|---|---|---|
| ChatGPT/Codex Desktop | Selected Phase-1 external MCP client | `selected_pending_conformance` | Operator selected the existing authorized client; remote MCP registration, OAuth, confirmation, file, and live-Revit behavior remain untested |
| Claude Desktop | Comparison/fallback GUI candidate | `screened` | Vendor documents remote Streamable HTTP, OAuth/DCR, organization connectors, and GUI tool approvals; real confirm/file flows are untested |
| Claude web | Browser control candidate/fallback | `screened` | Shares remote connector support but cannot be assumed to preserve workstation-local file workflows |
| Claude Code | Developer/power-user reference client | `not_fleet_candidate` | Useful protocol baseline; its designer UX remains unknown without hands-on evidence and it is not the fleet role unless DP-10 is amended |
| Other GUI MCP client | Competitive alternative | `not_nominated` | WP9 must name a product and verify the same gates before comparison |

The selected row records the operator's client choice, not a conformance or procurement pass. Client installation, subscription, and user session are user responsibilities; revAgent owns remote MCP registration and end-to-end compatibility verification.

## Hard-gate matrix

| ID | Hard gate | ChatGPT/Codex Desktop | Claude Desktop | Claude web | Claude Code | Required evidence |
|---|---|---:|---:|---:|---:|---|
| G1 | User-owned Windows client access/open/login prerequisite is repeatable by a designer | `?` | `?` | `V` | `V` | Pilot Windows recording; exact build/session prerequisites and responsibility boundary |
| G2 | Turkish-friendly chat UX; no terminal/config editing in daily use | `?` | `?` | `?` | `?` | Pilot designer completes scripted Turkish prompts unaided |
| G3 | Remote MCP Streamable HTTP reaches `https://gateway.revagent.app/mcp` from the client's real origin | `?` | `V` | `V` | `V` | Public tunnel/IP policy, MCP initialize, and exact entitled `tools/list` capture |
| G4 | OAuth works with the selected DP-5 provider, including registration, refresh, revoke, and reconnect | `?` | `V` | `V` | `V` | Keycloak DCR or approved custom-client flow on the actual IdP; token lifecycle trace |
| G5 | Per-user identity and entitlement survive through Gateway audit rows | `?` | `?` | `?` | `?` | User/tenant/device/session ids and denied-tool test in audit evidence |
| G6 | GAP-2 confirm flow: preview → explicit user approval → expiring single-use `confirm_token` re-invocation | `?` | `?` | `?` | `?` | C05–C07; approval event includes who/when and links to `invocation_id` |
| G7 | No client “always allow” setting can bypass revAgent server-side confirm/gated policy | `?` | `?` | `?` | `?` | Forged/replayed/direct write attempts denied and audited |
| G8 | One read and one confirm-class write complete against live Revit with visible result | `?` | `?` | `?` | `?` | M4 conformance recording + model verification |
| G9 | Exported PNG/JPEG evidence is visible or securely downloadable, not only a server-local path | `?` | `V` | `V` | `?` | `export_revit_view_image` result opened by the user from the tested client |
| G10 | Excel/CSV ingress has an explicit secure path to Gateway reconciliation | `?` | `?` | `?` | `?` | Client upload or O1 `file_fetch` proof; local path strings alone fail |
| G11 | Result files/exports have usable retention, download, and deletion behavior | `?` | `?` | `?` | `?` | Cross-machine open, expiry, access-denial, and cleanup evidence |
| G12 | revAgent remote-MCP registration/re-registration is documented and repeatable; client install/session stays user-owned | `?` | `V` | `V` | `?` | Ordinary-user connect, removal/re-add, machine rebuild, and support-boundary rehearsal |
| G13 | Privacy terms, processing region, prompt-telemetry loss, and the user-owned subscription boundary are accepted | `?` | `?` | `?` | `N/A` | Security/privacy review, GAP-16 sign-off, and written responsibility acceptance |
| G14 | Same exact client/build/config can run the ≥5-working-day pilot and fleet cutover | `?` | `?` | `?` | `N/A` | Version/config capture; pilot attestation; update policy |
| G15 | Assistant outage is distinguishable from Revit outage and recovery requires no model repair | `?` | `?` | `?` | `?` | Network-cut drill; Revit stays usable; Turkish error/support path |

`V` on G6 or G7 is deliberately impossible: a generic client tool-approval dialog is not the revAgent domain confirmation protocol.

## Secondary evaluation matrix

These factors choose between candidates only after all hard gates pass.

| Dimension | ChatGPT/Codex Desktop | Claude Desktop | Claude web | Claude Code | Evidence still needed |
|---|---|---|---|---|---|
| Streaming/progress presentation | `?` | `?` | `?` | `?` | Long-running read + chunk/progress trace; cancellation behavior |
| Text and image MCP results | `?` | `V` | `V` | `?` | Representative schedule text and coordination image |
| Local files and desktop apps | `?` | `V` via separate desktop extensions, not the remote connector itself | `B` pending upload/download proof | `?` | Excel/Word/PDF workflow-by-workflow test; least-privilege review |
| Organization connector controls | `?` | `V` for Team/Enterprise owner-managed setup | `V` | `N/A` | Add/revoke connector; user join/leave; tool enablement policy |
| Turkish prompts and error comprehension | `?` | `?` | `?` | `?` | Pilot-user rubric across `evals/evals.json` scenarios |
| Large tool catalog usability | `?` | `?` | `?` | `?` | 40-tool entitled catalog after docs-MCP relocation; selection accuracy |
| Proxy/update behavior | `?` | `?` | Browser policy dependent | `V` proxy/auto-update configuration documented | Office proxy, forced update, rollback, and drift drill |
| User training burden | `?` | `?` | `?` | `?` | Timed open/login/read/confirm-write exercise; installation remains user-owned |

## Current vendor-document screening

The following claims are useful for candidate admission only:

- No ChatGPT/Codex Desktop remote-MCP capability claim is credited in this M0 matrix. The operator's
  selection and existing authorized session do not prove transport, OAuth, confirmation, files, or live-Revit
  compatibility; those cells remain `?` until the exact current build passes the suite below.

- Anthropic states that Claude and Claude Desktop can add custom remote MCP connectors. Team/Enterprise organization connectors are added by an Owner/Primary Owner; users then connect individually. The feature is marked beta. The remote request originates from Anthropic's cloud, even when the user is in Claude Desktop, so the Gateway must be publicly reachable through the approved tunnel and the data path requires explicit privacy review. [Custom remote connectors](https://support.anthropic.com/en/articles/11175166-about-custom-integrations-using-remote-mcp)
- Anthropic documents Streamable HTTP and OAuth remote servers, Dynamic Client Registration, token refresh, custom credentials for non-DCR servers, and text/image tool results. WP9 must still test the selected DP-5 provider rather than infer compatibility. The documented Claude.ai/Desktop result limit is approximately 150,000 characters and its tool timeout is 300 seconds, which C09 must exercise. [Remote MCP server requirements](https://claude.com/docs/connectors/building)
- Anthropic distinguishes remote connectors from local Claude Desktop extensions: local extensions may access workstation files/apps, while remote connectors reach hosted services. Combining them is possible but does not by itself solve revAgent file ingress, identity, or retention. [Desktop versus web connectors](https://support.anthropic.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)
- Claude Code documents remote HTTP MCP registration and browser OAuth through `/mcp`; DCR interoperability with the selected IdP still requires the same hands-on test. [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)
- The current US list-price evidence says Claude Team is USD 25/member/month billed annually or USD 30/member/month billed monthly, minimum five seats, excluding tax and regional differences. At 12 seats that is a provisional USD 3,600/year or USD 4,320/year before tax. This is a planning number only; procurement must obtain a Turkey-valid quote. [Team billing](https://support.anthropic.com/en/articles/9267289-how-is-my-bill-calculated)
- Anthropic's current Team-plan page says Claude Code is not included in Team. A power-user Claude Code lane therefore needs a separate licensing/API decision and must not be hidden inside the designer-seat estimate. [Team plan scope](https://support.anthropic.com/en/articles/9266767-what-is-the-claude-team-plan)

Vendor pages can change. Record page date/screenshot or exported evidence again when conformance or any fallback procurement review begins.

## Hands-on conformance suite

### Preconditions

- M2 north MCP endpoint available at the controlled DNS name with the entitled 40-tool target catalog (35 runtime + 5 docs tools).
- M5 OIDC/device/user/audit path available on the exact DP-5 provider.
- Approved tunnel permits the documented client-cloud origin without exposing a private/LAN-only endpoint; security review records what prompt and tool-result data leaves the office.
- Pilot Bridge connected to a disposable/test Revit model; model writes separately confirmed by the operator.
- Exact ChatGPT/Codex Desktop build, Windows build, remote-MCP settings, user identity, and test time recorded.
- The user supplies and maintains the authorized client installation, subscription, and session; the test does
  not introduce a Gateway LLM key.
- No test uses `allow always` as a substitute for the revAgent GAP-2 protocol.

### Cases

| Case | Test | Pass evidence |
|---|---|---|
| C01 | User-owned client opens and logs in as an ordinary Windows user | Timed screen recording; exact build/session prerequisite; no undocumented revAgent admin/CLI step |
| C02 | revAgent remote-MCP registration is added; designer authenticates | Endpoint/config, OAuth redirects, user identity, no shared secret exposed; responsibility boundary recorded |
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
| C14 | Fleet supportability | Remote registration/user removal and re-add, machine rebuild instructions, client update, and config drift are observable and repeatable; client install/session remains user-owned |
| C15 | Five-working-day pilot | Same client/build/config used daily; failures, usage, training time, and user sign-off retained |

## DP-10 decision record template

| Field | Decision |
|---|---|
| Selected fleet client + exact build | Existing authorized ChatGPT/Codex Desktop; exact pilot build `TBD` |
| Selected organization/licensing plan | Existing user-owned subscription/session; exact plan `TBD by user` |
| Seat count and Turkey-valid annual total | `N/A to revAgent procurement — user responsibility` |
| Procurement and renewal owner | `Individual user / office policy owner TBD` |
| DP-5 IdP + OAuth registration mode | `TBD` |
| Connector provisioning owner/process | `revAgent owns remote-MCP registration instructions; user owns client installation and session` |
| Confirm-flow conformance evidence | `TBD` |
| Excel/file-ingress disposition | `TBD` |
| Image/output-file disposition | `TBD` |
| Known lost/deferred workflows accepted by operator | `TBD` |
| Pilot user/machine/dates | `TBD` |
| Cutover build/config pin and update policy | `TBD` |
| DP-10 decision owner/date | `Operator / 2026-07-22` |

## Gate conclusion

M0 records the ChatGPT/Codex Desktop selection and delivers this evaluation instrument; it does not authorize pilot or cutover. DP-10 selection is closed while conformance remains open until every applicable G1–G15 gate is hands-on `H` and C01–C14 are green. M8 then requires C15 on the same client/build/config that M9 will support. If the selected client fails confirmation or file-workflow gates, the program must add the missing Gateway/client mechanism or record a dated DP-10/R-F amendment; it must not remove the legacy local Codex path first or silently choose another client.
