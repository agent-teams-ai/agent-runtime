# macOS Keychain custody results

Status: accepted scoped evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Machine-readable summary:
`experiments/runtime-profile-behavior/fixtures/macos-keychain-custody-summary.json`

## Scope and safety

The final disposable macOS Keychain campaign passed an independent 39-of-39
read-only audit. Every keychain was a new file-backed keychain below `/tmp`.
The campaign did not list, read, or modify the login keychain, use a real
credential, open a user project, or retain secret bytes in its result.

The harness used the `security` CLI only with synthetic bytes. That interface
places supplied values in process arguments and is therefore not the
production secret path. Production access must use a focused
Security.framework `KeyProvider` adapter.

## Rejected revisions

The rejected revisions were retained as counterexamples:

- v1 observed mode `0644` on a newly created disposable keychain. The
  assumption that the file would default to `0600` was false.
- v2 enforced file mode, but combining unattended `-U` rotation with access
  control mutation through `-T` hung until the command deadline. ACL changes
  and unattended rotation cannot be treated as one already-qualified action.

## Accepted facts

The hardened v3 campaign confirmed:

- current and backup keychain files were explicitly changed to and attested as
  mode `0600`;
- a wrong unlock password was rejected, while the correct password unlocked
  and read the synthetic item;
- a locked backup copy opened with the same keychain password and retained
  generation 1 after the current keychain rotated to generation 2;
- of eight concurrent `security ... -U` updates, two succeeded and six failed;
  the final item was one of the successful values;
- the tested interface exposed no expected-generation compare-and-swap
  primitive;
- current and backup differed after rotation;
- exact cleanup removed both disposable files and left no campaign keychain
  residue.

The concurrency outcome is evidence against treating a successful Keychain
write as credential-generation serialization. It is not a general throughput
measurement.

## Security.framework follow-up

An ad-hoc signed Swift harness then used `SecItemAdd`,
`SecItemCopyMatching`, and `SecItemUpdate` against another disposable custom
file-backed keychain. It used random synthetic bytes in memory, did not access
the login keychain, and never passed item bytes through command arguments.

Three rejected revisions exposed important boundaries:

- v1 added to the intended keychain but queried with `kSecUseKeychain`, which
  returned `errSecItemNotFound`. Apple specifies `kSecUseKeychain` for add and
  `kSecMatchSearchList` for queries.
- v2 requested no authentication UI with the deprecated
  `kSecUseAuthenticationUIFail` value before reading a locked keychain.
  `SecurityAgent` still started and the call exceeded 30 seconds.
- v3 used `LAContext.interactionNotAllowed`; the locked-keychain read again
  started `SecurityAgent` and exceeded 30 seconds. The exact synthetic caller
  was terminated and the revision rejected.

The v5 flow omitted that unqualified locked read and passed three times with
byte-identical redacted results and an independent 31-of-31 audit:

- `SecItem` add, read, and update succeeded;
- a wrong explicit unlock returned `errSecAuthFailed`, while the correct
  unlock succeeded;
- the current item held generation 2 and the copied keychain retained
  generation 1;
- both files were explicitly mode `0600` and exact cleanup succeeded;
- the ad-hoc code signature passed strict verification.

This does not qualify the production path. Apple documents that custom
file-backed keychains use the legacy ACL implementation and that managing
those keychains requires deprecated `SecKeychain` APIs. The Data Protection
Keychain instead uses access groups derived from code-signing entitlements,
which must be authorized by a provisioning profile. The test harness had
neither that profile nor an access-group entitlement.

Therefore the production macOS target is a Data Protection Keychain adapter in
a signed app-like helper. A legacy custom file-backed keychain is not the
fallback production design, and headless locked access remains unproven until
tested in a disposable user or VM with the real entitlement shape.

## Architecture consequences

- Keychain is a local secret-byte store behind `KeyProvider`; it does not own
  `CredentialGeneration`, refresh authority, or generation CAS.
- Provider Access persists generation metadata and performs compare-and-swap
  before publication. A stale writer must fail closed.
- Agent Runtime explicitly enforces and attests `0600` on its file-backed
  keychain and retained copies; platform defaults are not an invariant.
- ACL or access-group changes are a separately fenced and qualified operation,
  not a side effect of headless rotation.
- A backup can retain an older usable secret after the live item rotates.
  Rotation, backup invalidation, and crypto-erasure are separate durable
  processes.
- Real secret bytes must use Security.framework APIs and never command-line
  arguments, logs, event payloads, evidence bundles, or profile artifacts.
- The production adapter targets the Data Protection Keychain from a signed
  app-like helper. It does not depend on deprecated custom-keychain management
  or legacy file-keychain ACL behavior.

## Evidence

```text
harness
f3f833f2a0e40cefa80bd9e65ae9c07934df63a675df693daab7669308a3ccb2

accepted result
a6f57ba1a95e5cd4582e62b73e55909ca1d14585896d2cbfde48f71c4112949e

independent audit script
91ce1a503a7e9325fb6ddb45154055f6e378f5cf0e650f4dcedab98c40e3370a

independent audit result
417bb5bfa5fd781061874e7b6acfb6f09431f9efca8643eeaa05dcefabf2ee0b

retained bundle
1847e5ca801bc63943571df4c97ca7ecf1a89caeb835b6a6d048c0a2b4a251e8

Security.framework source
f4dcb9c4988c0ef0e367b3a918d1c552bb4afb079a4964a7f114d99b23cfa38c

ad-hoc signed binary
bfaa1f2ba867a629233c5c84342651e68280720fc2ab32843b9c7a287e945764

three identical Security.framework results
93761842d0561f2bcf3803f70bb48697bbdc7189f200b493bc41b9f81c214b20

Security.framework audit script
6c0acf59671bfc1ce152cc13c9276f12bcdebf2d5fd2b443dd7868fcde839f61

Security.framework audit result
6a08117283eb3c6c118dfaeecd83390d538bce3bbe7c90a105ec73df4c1314f7

Security.framework retained bundle
797b91e2111daf8b50d7ea55a133dd086bf21c800627c92dcd4ac05506c16cec
```

Retained bundle:

```text
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/reports/
  macos-keychain-custody-2026-07-28.tar.gz
  macos-security-framework-secitem-2026-07-28.tar.gz
```

## Remaining gates

This closes the disposable file-backed Keychain behavior matrix only. It does
not establish production key custody. The remaining gates are:

- Data Protection Keychain `SecItem` integration from a signed app-like helper,
  including a provisioning-authorized access group and code-signing identity;
- reboot, locked-session, ACL, and user-presence behavior;
- end-to-end Provider Access generation CAS and refresh-race qualification;
- crypto-erasure and backup invalidation;
- external KMS or another off-host trust anchor where required.

Platform references:

- [Apple Platform Security: Keychain data
  protection](https://support.apple.com/guide/security/keychain-data-protection-secb0694df1a/web);
- [Keychain Access: Copy
  keychains](https://support.apple.com/guide/keychain-access/copy-keychains-kyca1121/mac);
- [Apple Security: Restricting keychain item
  accessibility](https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility);
- [Apple TN3137: On Mac keychain APIs and
  implementations](https://developer.apple.com/documentation/Technotes/tn3137-on-mac-keychains);
- [Apple Security:
  `kSecUseKeychain`](https://developer.apple.com/documentation/security/ksecusekeychain);
- [Apple Security:
  `kSecMatchSearchList`](https://developer.apple.com/documentation/security/ksecmatchsearchlist);
- [Apple Security: Data Protection
  Keychain](https://developer.apple.com/documentation/security/ksecusedataprotectionkeychain);
- [Apple: Creating distribution-signed code for
  macOS](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac).
