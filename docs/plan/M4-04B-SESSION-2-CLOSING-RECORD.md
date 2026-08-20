# M4-04/B session 2 — CLOSING RECORD

Date: 2026-08-20 (session ran 2026-08-18 → 2026-08-20 UTC)
Collector: `revagent.m4-session2.closing.v1`
Chain anchor: previous file `C8-TEARDOWN-EXECUTED-PENDING-OPERATOR-2026-08-19.md`
`f3e2ba7ea03124024c580b93909098748c3d2d0266ea9e6a33fbde5102b33471`

---

## 1. THE VERDICT, PRECISELY

**M4-04/B PASSES against its own scope.** That scope is seven gates, named in
`docs/plan/M4_GATE_EVIDENCE.md:405-410`, and it contains no write gate:

```text
GATE                          THIS SESSION'S RECORD                          RESULT
CLIENT-PLACEMENT/FEASIBILITY  C0 preflight + supplement, PETRUCCI bound      PASS
NETWORK/ACL                   C1 — DOCKER-USER allow/deny, both polarities   PASS
DNS/TLS-TRUST                 C2 — A + TXT, certificate issued, trust proven PASS
BRIDGE-STAGE                  C3 — staged worker + config, restore proven    PASS
CREDENTIAL/ENROLL             C5 — bearer delivered byte-faithfully,
                                   enrollment consumed, registration
                                   committed and survived a Codex restart    PASS
CLIENT/LIVE                   C6 — one read traced hop by hop,
                                   operator-confirmed on screen              PASS
CLEANUP/RESIDUE-EQUALITY      C8 — both hosts proven clean                   PASS
```

Outside those seven, also completed: **C4** broker stage, and **C9** revoked-device
refusal correlated at both ends — which belongs to RES-30, not to M4-04/B.

**M4 THE MILESTONE REMAINS OPEN.** Its acceptance (`docs/plan/MASTER_PLAN.md:463`)
names *"one read **and one confirm-class write** with originating-preview/
approval/commit audit evidence."* The read is proven; the write is not.

**C7 was never part of M4-04/B.** `M4-WRITE-CONFIRM` is a separate gate
(`MASTER_PLAN.md:179`, `M4_GATE_EVIDENCE.md:410`). Our card added it. That is a
card premise error, not a gate failure — and the planner recorded the overreach
as their own.

---

## 2. THE NINE FINDINGS

**1 — The digest trap.** A build-engine digest is not a runtime-engine digest.
*Cost:* would have pinned an image the running engine never resolves, invalidating
every downstream selector. *Caught by:* resolving the digest from the engine that
would RUN the image, not the one that built it.
**Rule adopted:** the authoritative digest is the one resolved by the engine that
will run the image.

**2 — Defect A, the ssh/sshd launch context.** Windows OpenSSH `ssh.exe` spawned
inside an *inbound* sshd session never exits when stdout is a pipe. *Cost:* an
earlier harness reported both transport legs as `TIMEOUT` — a false negative that
looked exactly like a broken network. *Caught by:* re-running with file-based
capture instead of redirected streams. Environmental, not a defect in the binary.

**3 — Defect B, CRLF in the generated POSIX cleanup-probe script.** *Cost:* the
probe could not run on the destination. *Fixed* at generation time, per the
planner's ruling, rather than by normalising at the receiver.

**4 — Defect C, the coordinator discarded the Windows destination's own metadata.**
*Cost:* the field was carried but meaningless. *Fixed* so the field is meaningful
again.

**5 — Defect D, a duplicate control byte.** *Cost:* would have corrupted the
delivered secret by one byte. *Caught at the acceptance gate* — a synthetic
full-coordinator run required to COMMIT, which the planner mandated precisely so
a defect of this class could not reach the single-generation secret. *Fixed at the
SOURCE, not the receiver*, on the planner's correction.

**6 — Defect E, the TLS timestamp guard.** `asNumber` applied
`Number.isSafeInteger` to fractional filesystem timestamps, so
`preProductionTlsMaterial` refused **every real file**. *Cost:* the pre-production
TLS path was unusable against a real filesystem. *Fixed* in slice R3 with a
regression test that uses **real filesystem stats** and a sub-millisecond
change-detection assertion, so a truncating "fix" is forbidden by the test.

**7 — The journal-state connection failure.** A journal in a particular state
leaves the Bridge unable to hold a Gateway session. *Cost:* cost this session the
whole WSS investigation arc. *Caught by:* an authorised backup/restore experiment
that localised the cause to the file itself. **The exact statement is still
unnamed** — that is R6's job, and the retained fixture is its only validation path.
Recorded as a **product defect**, not a lab artefact, on the planner's ruling.

**8 — The registration form premise error.** The registration form this milestone
had previewed could never have worked with the broker it was meant to register.
*Cost:* would have burned the broker's single-shot start. *Caught by:* reading the
broker's caller-authorization source against the registration module — **after**
an earlier "missing paths" note had already been filed and accepted as harmless.
**A premise error can survive being noticed once.**

**9 — The advertised tool surface is one callable, by hardcoded design.**
`preProductionServing.ts:211-214` wraps the catalog in
`EntitledCatalogView(catalog, entry => entry.name === M2_NORTH_FIRST_SLICE_CALLABLE)`,
and `:119-123` enforces the same at invocation. `northFirstSlice.ts:14` fixes that
constant to `core.ui.state`. The seed carries all forty tools; none of the 17 CLI
pairs scopes the surface; the broker proxies unmodified; and progressive
disclosure cannot reach past it because the search corpus **is** the entitled set
(`entitledRegistry.ts:279`). *Cost:* C7 as carded cannot run on this image.
*Caught by:* Codex's own answer contradicting my report — I had measured
`toolBindings.ts`, the code's **capability**, and presented it as the live
advertised **surface**.
**Addendum:** `revokeDevice` mutates one in-memory field and does not persist, so
a Gateway restart loses the revocation. Same M2 scaffold, same character.

---

## 3. THE RULE-8 PROGRESSION

> **Absence of evidence from an instrument that cannot produce that evidence is
> not evidence of absence — and it is not enough to establish that the instrument
> CAN show the positive. You must establish that it can show the positive AT THE
> MOMENT YOU PLAN TO READ IT.**

Fourteen instances accumulated across this milestone's reports. The register's
verifiable anchors, and the shape of the arc:

```text
 1-10  the accumulating classes, each an instrument answering a question it
       could not answer:
         · "the file did not change" — an instrument that can only ever answer
           about WRITES, used to exonerate a journal whose suspected fault was
           on the READ path
         · "zero connections" — a 2000 ms sampler against an 11 ms connection,
           a 0.06 % duty cycle reported as absence
         · `ss` on a DNAT'd published port — the host is not an endpoint, so the
           correct instrument was the container's own network namespace
         · a coordinator readiness check validating known_hosts for owner and
           ACL but never for whether the entry it needed was present
   11  worker.dispatch_trace — an optional diagnostic callback that does not fire
       on the C6 path. Had its silence been read as evidence, the conclusion
       would have been "the read never reached the Bridge", which the durable
       journal disproved outright.
   12  the twelfth, completing the standing rule as earned "twelve ways"
   13  THE C7 PROOF PLAN'S OWN "after COMMIT the hash MUST differ" — a Revit
       transaction is in-memory; nothing reaches disk until a save. A perfect
       commit would have left the hash unmoved and fired a FALSE STOP at the
       gate's most delicate moment. Caught BEFORE firing, and verified from
       source: the plugin never calls Document.Save().
   14  THE TOOL-SURFACE SUBSTITUTION — the first instance where the instrument
       was not merely blind but was MEASURING A DIFFERENT OBJECT ENTIRELY.
       toolBindings.ts answers "what can this code do", not "what does the
       Gateway advertise". Both are real measurements; only one was the question.
```

**Teardown produced two more, bringing the register to sixteen:**

```text
   15  THE CRL. Its lastUpdate was Aug 19 20:43:45Z — TEN MINUTES BEFORE the
       revocation at 20:53:41Z — with nextUpdate nine days out, and the
       certificate carries no OCSP URI because Let's Encrypt has retired OCSP.
       "Serial not in the CRL" would have been a finding built on an instrument
       that could not yet contain the answer. Discarded, and replaced with one
       that COULD answer: a second revocation attempt, which made the CA itself
       return `alreadyRevoked` naming the serial.
   16  THE SITE RESOLVER, contributed by the planner. It holds a POSITIVE cache
       entry for m4-gateway.revagent.app from this session; querying it for
       NXDOMAIN would have returned a stale SUCCESS where the truth is absence —
       the negative-caching trap in reverse. DoH against two independent
       resolvers was used deliberately, with the zone's SOA present in both
       negative answers to prove them AUTHORITATIVE rather than cache misses,
       and with two control names proving the zone and resolvers healthy.
```

### 3a. The planner-side list — by shape and first appearance

Supplied by the planner and reproduced **as a planner-side list**, explicitly
labelled as such. It is ordered by shape and first appearance rather than by a
certified count:

```text
 1  millisecond-resolution stat probe — every field read "SAME" because the
    whole probe ran inside one millisecond
 2  PowerShell startup time contaminating the naive clock midpoint
 3  negative DNS caching — querying a name before it existed poisoned the
    vantage for the negative TTL
 4  an unchanged WAL used to exonerate two code paths that are READS
 5  A1's destinationAbsent — the coordinator discarded the broker's answer
 6  BridgeDoctor's hardcoded rbpAuthenticated:false
 7  the Gateway request log with NO session (disableRequestLogging)
 8  the Gateway request log with a HELD session — cannot distinguish the two
 9  ss on a DNAT'd published port — the host is not an endpoint
10  conntrack "absent" — the tool was not installed and the proc file did not
    exist, so the instrument was unreadable rather than negative
11  dispatch_trace — an optional callback that never fires on that path
12  the plugin never calls Document.Save(), so a post-commit hash read is the
    right instrument at the wrong MOMENT
13  toolBindings.ts read as the live advertised surface — the first where the
    instrument measured a DIFFERENT OBJECT
14  the CRL, generated ten minutes before the revocation
15  the site resolver's POSITIVE cache when verifying absence
16  revokeDevice mutating one in-memory field and closing nothing — the trap
    one layer further out, which the can-fire proof exposed
```

**DISCREPANCY, RECORDED RATHER THAN RESOLVED.** The two numberings agree through
11 (`dispatch_trace`) and diverge by one position from 12 onward, because the
executor's reports numbered the `Document.Save` finding as **both twelfth and
thirteenth**:

```text
ITEM                        EXECUTOR §3      PLANNER §3a
Document.Save / commit hash      13               12
toolBindings.ts surface          14               13
the CRL                          15               14
the site resolver                16               15
revokeDevice                 (narrated as     16
                              the C9 counter-
                              example)
```

Neither count is certified, and the executor's numbering is kept in §3 on the
planner's instruction. **A record that admits an uncertain count is worth more
than one that asserts a tidy one** — the alternative was to invent an
enumeration, which is the same error as reporting a measurement you did not take.

**And the counter-example, which is the point of the whole rule.** C9's observer
was the **first instrument in this milestone proven capable BEFORE being read**.
That proof was not decoration: it uncovered that `revokeDevice` leaves the live
session running, so revoking and reading would have produced silence at both ends
and a confident report that the refusal path does not work — a trap sitting one
layer further out than the observer itself.

---

## 4. THE TWO SENTENCES

> **Widening an entitlement to make a gate pass is exactly the class of change
> that must never be made under gate pressure.**

> **The same pressure that would widen an entitlement is the pressure that would
> accept a silent observer as proof. Both are the gate asking to be told what it
> wants to hear.**

---

## 5. RES-30 — TWO OF THREE PROVEN

`M4_GATE_EVIDENCE.md:1673` names three unproven items:

```text
real Gateway token exchange              PROVEN this session (C5 + C6)
revoked-device refusal at handshake      PROVEN this session (C9, both ends,
                                         byte-identical correlation id)
device-token persistence across reboot   STILL UNPROVEN — and reboot is not
                                         authorized by M4-02, M4-HOST,
                                         M4-03/A or M4-CREDENTIAL/B
```

**RES-30 must not be read as closed.**

C9's correlation, for the record:

```text
Gateway  gateway.rbp_opening_refused   correlationId 01a01bbc-ea91-78c6-b34c-7b75f22c766c
                                       auth · httpStatus 403 · closeCode 4403 · refused
Bridge   worker.gateway_retry_paused   correlation_id 01a01bbc-ea91-78c6-b34c-7b75f22c766c
                                       http_status=none · close_code=4403 · phase=retry_paused
```

Both ends key on the **same RBP hello envelope id** — structural, not coincidental.
`http_status=none` is the field proving the refusal arrived post-hello, the only
place that observer can see it.

---

## 6. TEARDOWN LESSONS

**1 — Unregistering a scheduled task does not stop the process it started.** The
broker survived its own task's removal, keeping pid 58500 alive and holding
`:18765`. A task-only teardown leaves a listener running.

**2 — The restore source must outlive everything it restores.**
`c3-restore.ps1` reads from `C:\revagent-m4-session2\backup\`, and the session
root was itself on the deletion list. Deleting it first would have destroyed the
only copy of the incumbent worker and the original credential leaves. **Session
root last, and only after every restore assertion returns true.**

**3 — Secure deletion needs `chmod u+w` first.** Three of the five secret files
were mode `0400`; that is precisely where attempt 1's shred failed. All five
shredded successfully once write permission was restored, with positive per-file
absence proof afterwards.

**4 — Revoke before you destroy the account key.** Attempt 1 shredded the ACME
account key first and lego supports only account-key revocation, so the
certificate was left unrevoked as a tracked open item. This session revoked
**before any destruction at all**, so a failure would have left everything intact
and reversible.

**4a — The attempt-1 empty-email guard was both wrong AND unnecessary.** lego
v5.3.1 has no top-level `revoke`; it moved under `certificates`. And
`--account-id` exists *precisely because the e-mail may be absent*:

```text
lego certificates revoke --path <root>/acme --account-id noemail@example.com \
     --cert.name m4-gateway.revagent.app --reason 5 --keep
```

`--keep` was chosen deliberately: without it lego **archives** the certificate to
a new path that would then have to be hunted down and shredded.

**5 — A proof obligation is only real if it can fail you.** The first config edit
produced a 3444-byte file whose sole flaw was a trailing newline — a third
difference beyond the two exempted volatile keys. It failed **my own** proof
obligation 1 and was corrected to 3443 bytes before reporting. Relatedly, the
`File.Replace($tmp,$tc,$null)` failure was *fortunate*: it aborted before writing
and forced the question of whether the trailing blank belonged to our section.

**6 — Remove your own artefacts by name, never by wildcard**, and *name* what you
deliberately leave. `%TEMP%\.net\revagent-bridge\` stays: it is the bundle extract
of the restored incumbent service, regenerated on every start — product runtime
state, not session residue.

---

## 7. FINAL STATE

```text
GATEWAY HOST 192.168.90.154
  containers 0 · revagent networks 0 · m4-s2 DOCKER-USER rules 0 · :443 silent
  final ACL counters, captured BEFORE removal:
    ACCEPT 20461 pkts / 4157K bytes      REJECT 5 pkts / 260 bytes
    REJECT stood at 5 at C0 and 5 at close — unmoved across the entire session
  isolated root /home/bt/m4-s2 ABSENT; five key/secret files shredded with
    positive absence; no *.key/*.pem/credentials.json under /home/bt
  preserved: m4-credential-9b7ead1396ac, m4-host-1882289733ff, and both prior roots
  authorized_keys 1 line ce6ba46318f7bc95… perms 600 bt:bt

PETRUCCI 192.168.90.122
  C:\revagent-m4-session2\        ABSENT
  AppData\Local\revAgent          ABSENT      broker task ABSENT
  :18765 / :443                   0 / 0
  bridge service                  Running / Auto / LocalSystem
  bridge config                   13c171eb…   uri wss://localhost:8443/bridge/v1
  versions                        current only, worker d1c8cf10…
  credentials                     all four at their pre-session hashes
  config.toml                     38e7df85…  3443 B · 23 sections · 0 revagent
  known_hosts                     a96f37b7bc02…  3 lines
  administrators_authorized_keys  7e418f2f23ee…  2 lines, owner preserved

CERTIFICATE
  serial 05FBDE9078CD4BC679AD94BEB6FBAEC25203 · SAN m4-gateway.revagent.app
  expiry 2026-11-16T09:32:53Z · REVOKED (reason 5, cessationOfOperation)
  confirmed by the CA: alreadyRevoked, naming the serial

DNS — planner-verified independently from AXL, 2026-08-19T21:15:36Z
  m4-gateway.revagent.app                  A    Status 3 (Cloudflare + Google DoH)
  _acme-challenge.m4-gateway.revagent.app  TXT  Status 3 (Cloudflare + Google DoH)
  both negatives carry the zone SOA — AUTHORITATIVE, not cache misses
  CONTROL gateway.revagent.app / dashboard.revagent.app  Status 0, healthy

THE OFF-SESSION ORIGINAL
  C:\Program Files\Autodesk\Revit 2022\Samples\rme_basic_sample_project.rvt
  701e419b… · 30482432 B · lastWrite 2021-02-04T12:25:02Z
  The file has never been written at all — which is stronger than an
  unchanged hash.
```

---

## 8. WHAT REMAINS LIVE, AND WHY

**1 — The reproduction fixture. EXEMPT from teardown, proven present at close.**

```text
evidence\FIXTURE-rbp-journal-connection-failure\
  journal.db      0e76ec8a18e52ea191b7e66ccceada4f0ec93a19b0c6f04bb9f5a17f8620b7a2
  PROVENANCE.md   777067d9c8fbf82ed82371870996de0671542c0dfa169af9e0fd52a432052042
```

It is the only artefact that reproduces finding 7, and therefore **R6's only
validation path**. Archive, never delete.

**2 — PETRUCCI's DNS setting is a permanent change, not residue.** Recorded so
nobody later reads it as an unreverted mutation.

**3 — The journal deviation, declared as a decision.** The live journal is left
at `4f7234b7…` and the pre-session journal `0e76ec8a…` is **not** restored,
because those bytes *are* the defect. Restoring them would knowingly return the
machine to a broken state.

```text
outcome: the machine is left WORKING rather than left IDENTICAL — deliberately.
```

An undocumented deviation would be a residue-proof failure. A documented one is a
decision.

---

## 9. POST-SESSION SLICE QUEUE

```text
R1  the CRLF pair — defects B and C, generation-time normalisation
R2  control-byte ownership — must exercise the RELAYED topology, not loopback
R3  MERGED — the TLS timestamp guard, with a real-filesystem regression test
R4  documentation: the Windows ssh/sshd inbound-session launch-context defect
R5  DIAGNOSABILITY — the Bridge must be able to say WHICH journal statement
    failed. Prerequisite to R6.
R6  the journal defect itself — scoped ONLY after R5 names the statement.
    The retained fixture is its ONLY validation path.
```

**R5 strictly before R6.** R6 cannot be scoped against a defect whose failing
statement has never been named, and the instrument that would name it does not
yet exist. Scoping R6 first would repeat finding 7's own mistake — reasoning from
an instrument that cannot produce the evidence.

**Also carried forward, not slices:**

```text
GAP-14   Codex config rewrites: two UPDATE samples destroyed the managed entry,
         one RESTART preserved it. Two of one shape and one of the other is not
         a rule. Re-test deliberately at the next Codex update; if it holds, the
         entry must be re-asserted after an UPDATE, not after every restart.
M4-WRITE-CONFIRM   recommended for sequencing with M5's OAuth/entitlement work
         rather than back-fitting onto a pre-production scaffold. A recommendation
         to the plan owner, not a decision.
```

---

## 10. CLOSING

M4-04/B passed its seven gates. The milestone stays open on a write its own
pre-production profile was never built to advertise — and the honest way to that
write is a deliberate, reviewed decision about what the profile is *for*, not a
change made under gate pressure.

Nine findings. Sixteen instruments that could not answer the question asked, two
of them caught before they fired a false verdict, and one — C9's observer —
proven capable **before** it was read, which is the only reason its silence would
have meant anything at all.
