# EU-20 installer credential ACL correction

Scope record: Hedef: prevent native installer credential ACL lockout | Plan satırı: M6/P3-T9, P-INST-1, R9 | Kabul: an elevated fresh directory/file receives the exact SYSTEM/Administrators ACL without losing administrative access during application | Kapsam: credential ACL producer and focused/native regression evidence | Forecast: 1-2 active engineering hours, excluding CI/review waiting

Base: protected main `a973f7e171708933748bd1d6937ed960fab6d0b5`.

The actual PETRUCCI installation failed at `create_credential_directory`
before binary deployment, configuration, identity preparation, enrollment or
service creation. The producer changed owner to SYSTEM, removed inherited
access and only then attempted to grant SYSTEM/Administrators access. Native
readback showed SYSTEM ownership and a protected empty DACL. The final grant
therefore failed with access denied. The existing mocked test froze this
defective ordering and did not exercise a native inherited-only directory.

The correction must establish the intended access before removing inherited
access and transferring ownership, preserve the strict SYSTEM/Administrators
boundary, use locale-safe identities, and verify the resulting ownership and
ACL. Directory/file behavior and unexpected explicit ACEs must be covered.
No identity seed, token, protocol, enrollment semantics or Revit model changes
are in scope. Do not bypass validation or patch the live ACL to claim success.

Validation includes a native elevated fresh-directory/file regression with
inherited-only baseline access, strict final ACL/readback, failure propagation,
and zero-mutation dry-run coverage. Existing relevant gates remain required;
the real installer acceptance must be rerun from a clean restored baseline
after protected delivery. Record each gate against its actual source.

The failed attempt and all recovery evidence remain under local
`artifacts/EU-20/astra-b1/b2-install-a973`. R-D was restored, the temporary
endpoint was rolled back and the owned Gateway resources were cleaned. No
token or model operation occurred. Unit and milestone acceptance remain open.

Park List: none. Active actual/variance and final evidence will be recorded
without relabeling earlier evidence or inventing unmeasured active time.

## Focused candidate

The credential producer now grants numeric SYSTEM/Administrators SIDs before
removing inheritance and transfers ownership last. It rejects any deny ACE
or foreign explicit ACE before mutation and verifies exact protected owner,
two non-propagating FullControl allows, and absence of other entries afterward.
Distribution permissions are unchanged. Windows PowerShell native stderr is
captured without losing the checked exit code.

The non-admin installer suite passed under Windows PowerShell 5.1. Its existing
copy/report fixture now explicitly mocks credential metadata as well as its
already-mocked native invoker; it is not native ACL evidence. A separate test
proves a no-op invoker fails actual postcondition verification. An initial
test assertion matched `Users` in the temporary path; that assertion now checks
the denied grant SID precisely. Both terminal logs remain under local
`artifacts/EU-20/astra-b1/credential-acl-focused*.log`.

`scripts/test-eu20-credential-acl-native.ps1 -EvidenceRoot <fresh-private-path>`
is the pending elevated Windows PowerShell 5.1 proof. It tests a fresh
inherited-only directory, a real public file created inside that resulting
non-propagating credential parent, exact permissions, idempotency, foreign/deny
refusal and real native failure propagation. It emits a source-hashed outcome
and retains failed fixtures for diagnosis. No elevated pass or real installer
acceptance is claimed before that runner actually succeeds. Broader delivery
gates and protected review remain pending; active-hour totals are not measured.

### Native creation finding and bounded correction

The first actual elevated proof at `07c78879` passed six directory and
idempotency checks, then correctly refused the ordinary file's default DACL:
Windows added an explicit logon SID with read/execute access. That failed
fixture and its metadata remain preserved. This is not authority to admit
logon SIDs or weaken final verification.

The slice therefore also covers the installer enrollment-artifact call site
and a dedicated create-only credential writer. It must supply the protected
SYSTEM/Administrators DACL atomically when creating its private temporary
file, finalize and verify ownership before publication, and preserve any
existing destination. Generic configuration/report writers are unchanged.
The native proof must use this actual producer, retain arbitrary foreign-ACE
refusal, and distinguish the first failed proof from its successor.

The successor's focused installer suite passes in both Windows PowerShell 5.1
and PowerShell 7, including unsafe-parent zero-write refusal. Native proof
now supports both runtimes' ACL-at-creation APIs and verifies the producer's
empty private file checkpoint before bytes are written, final ownership,
create-only collision preservation, failure cleanup and an actual competing
publication. Both elevated runs are still pending at this source checkpoint.

Both elevated `f7d35766` runs subsequently passed 31 checks covering the real
producer and file/directory ACL behavior. Their final native-error fixture
failed because a script-local `Get-Acl` shadow was invisible to the imported
module under the operator wrapper's nested invocation. This was reproduced
with a disposable local directory: top-level execution produced the expected
native exit 2, while nested execution did not remove the fixture first.

The test-only successor installs a captured, exact-path global reader and
restores the original global function in `finally`, forwarding other reads.
It records the actual closed native error and absence readback. The exact
error-fixture block and full focused installer suite now pass through nested
wrappers in PS5 and PS7; the existing metadata mock uses the same scope fix.
Product source is unchanged from `f7d35766`. The two elevated full-run outcomes
remain failed historical evidence until the corrected runner is executed.
