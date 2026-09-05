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
