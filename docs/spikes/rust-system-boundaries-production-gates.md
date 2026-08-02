# Rust system-boundary production qualification gates

Status: proposed fail-closed qualification plan

Companion evidence:
`experiments/rust-system-boundaries/README.md`

The existing Rust experiment is scoped spike evidence. It demonstrates that a
Rust Local Supervisor and Execution Guardian are viable technical boundaries;
it does not qualify either binary for production distribution or hostile
workload containment.

Rust remains a technical data-plane implementation detail. It may own local
process custody, bounded streams, local generation activation, and local
release verification. It must not decide runtime-domain or distributed
authority. CAS, revisions, inbox/outbox, leases, fences, idempotency, and
reconciliation remain in the owning Agent Runtime contexts.

## Qualification rule

Each gate below is closed until its exact supported-target row has an immutable
evidence bundle and all required owners record `PASS`. A pass for one operating
system, architecture, release channel, or protocol pair does not qualify any
other target. Missing, stale, partial, or unverifiable evidence is `FAIL`.

Every retained `evidence.json` must use a versioned closed schema and bind:

- gate ID and target tuple;
- source commit, dirty-tree state, Rust toolchain, dependency lock digest, and
  harness digest;
- build workflow identity, runner image, OS build, architecture, and isolation
  profile;
- unsigned payload digest, signed artifact digest when applicable, and
  attestation identity;
- exact test cases with pass, fail, or unsupported outcomes;
- cleanup and orphan-scan result;
- producer, independent verifier, acceptance owner, and UTC decision time;
- limitations and negative assertions.

The independent verifier must not be the implementation author. The Release
Manager may promote a release only when every gate required by its target
matrix is `PASS`.

## Ownership

| Role | Owned decision |
| --- | --- |
| Windows Platform Custody Owner | Windows creation, Job Object containment, process identity, and cleanup evidence |
| Unix Platform Custody Owner | Linux and macOS containment, stable identity, signaling, and cleanup evidence |
| Local Supervisor Owner | generation activation, health binding, update, and rollback evidence |
| Runtime Published Language Owner | protocol schemas, negotiation, compatibility matrix, and frozen fixtures |
| Release Engineering Owner | reproducible payload, packaging, signing pipeline, provenance, and evidence retention |
| Product Security Owner | signing custody, platform trust verification, containment threat scope, and independent negative review |
| Qualification Maintainer | evidence schema, target completeness, fixture independence, and fail-closed CI |
| Release Manager | final promotion or rejection from accepted gate results; no technical override |

## Required gates

| Gate | Target owner | Independent acceptance owner | Production pass condition |
| --- | --- | --- | --- |
| `RUST-WIN-ATOMIC-JOB` | Windows Platform Custody Owner | Product Security Owner | No provider instruction can execute before association with the intended Job Object; crash and kill-tree campaigns leave zero live descendants on every supported Windows target. |
| `RUST-UNIX-CUSTODY` | Unix Platform Custody Owner | Product Security Owner | Every advertised Unix profile has a containment primitive and stable process identity that meet its threat model; hostile escape and identity-race tests either pass or make that profile explicitly unsupported. |
| `RUST-SUP-GEN-HEALTH` | Local Supervisor Owner | Qualification Maintainer | Candidate readiness is proven over a Supervisor-owned channel bound to exact generation, artifact digest, boot nonce, and process birth identity before activation. |
| `RUST-PROTO-N-N1` | Runtime Published Language Owner | Qualification Maintainer | Independently frozen clients and servers pass both directions of the N/N-1 matrix after explicit negotiation; unsupported versions fail before commands or effects. |
| `RUST-MAC-SIGN` | Release Engineering Owner | Product Security Owner | The complete macOS executable closure passes designated signing, notarization, stapling, offline verification, tamper, revocation, install, launch, update, and rollback checks. |
| `RUST-WIN-SIGN` | Release Engineering Owner | Product Security Owner | The complete Windows executable closure passes Authenticode chain, timestamp, publisher, tamper, revocation-policy, install, launch, update, and rollback checks. |
| `RUST-SIGN-CUSTODY` | Product Security Owner | Release Manager | Platform signing keys are non-exportable or HSM/KMS-backed, least-privilege, audited, rotatable, revocable, and unavailable to untrusted pull-request workflows. |
| `RUST-REPRO-SCOPE` | Release Engineering Owner | Qualification Maintainer | Two isolated builders reproduce the declared unsigned payload scope or the release is rejected with an explicit narrower scope; nondeterministic signing material is mapped to that payload by signed provenance. |
| `RUST-N-N1-ROLLBACK` | Local Supervisor Owner | Runtime Published Language Owner | A real N-1 -> N -> N-1 campaign preserves supported state and custody semantics, rejects incompatible downgrade before mutation, and leaves no orphaned process or split active generation. |
| `RUST-EVIDENCE-RETENTION` | Release Engineering Owner | Release Manager | Complete evidence is immutable, independently retrievable, integrity-verified, and retained for at least the supported release lifetime plus twelve months. |

## Platform custody campaigns

### `RUST-WIN-ATOMIC-JOB`

The production launcher must use an OS construction that associates the child
with its Job Object before provider code can run. Preferred evidence uses
process-creation-time Job association. A suspended child followed by Job
assignment is acceptable only if the platform campaign proves that no child or
injected startup path can execute before assignment for the complete supported
binary closure.

The campaign must include immediate descendant creation, nested descendants,
Guardian crash before reply, Guardian crash after spawn, cancellation, access
denial, PID reuse pressure, and Job close. It must query Job membership and
process creation identity, then perform an independent machine-wide orphan scan.
Any observable process outside custody, unverifiable identity, failed cleanup,
or unsupported runner claim is `FAIL`.

### `RUST-UNIX-CUSTODY`

Qualification is profile-specific:

- hosted untrusted Linux requires a cgroup or equivalent kernel-enforced
  containment root plus stable process handles such as pidfds;
- trusted local Linux may use a weaker adapter only when its threat scope says
  it is not a security sandbox;
- a macOS process group is not hostile containment because a descendant may
  create a new session. An untrusted macOS profile remains unsupported until a
  stronger isolation boundary is qualified.

Tests must cover `setsid` escape, rapid exit and PID reuse, signal denial,
Guardian crash between identity verification and termination, surviving
descendants, concurrent reconciliation, and repeated cleanup. A signal issued
from a fresh PID lookup after a separate identity check cannot qualify as
race-free hostile custody. Unsupported profiles must reject admission before
spawn rather than silently downgrade containment.

## Supervisor generation health

`RUST-SUP-GEN-HEALTH` replaces the spike's caller-supplied health result with a
real candidate-process proof. The Supervisor creates the candidate and a
one-use private challenge channel. Readiness must echo the exact generation,
artifact digest, boot nonce, protocol version, PID, and process birth identity.
The Supervisor verifies continued custody and liveness before atomically
publishing the active generation. A healthy candidate has no active authority.
If replacement of a live generation cannot stop the previous Host, the
candidate must be terminated and activation fails. If a later activation step
fails after the previous Host stopped, the candidate must also be terminated;
recovery may restart the previous generation but may never leave two live
generations registered as active.

The evidence Supervisor holds an exclusive owner lock for its complete
lifetime. Cleanup failure before or after health verification retains the exact
child handle and prevents another instance from bypassing reconciliation while
that owner is alive. Production qualification additionally requires durable
startup reconciliation for a Supervisor crash inside that cleanup window.

The campaign must exercise stale and replayed readiness, an old generation
answering for a candidate, healthy-then-crash, timeout, partial startup,
concurrent ensure, every activation crash point, failed rollback health, and
power-loss-oriented filesystem recovery on each supported filesystem. No
candidate pointer may become externally active before the proof commits.

## Protocol and rollback

`RUST-PROTO-N-N1` requires separately frozen N and N-1 schemas, generated or
independently implemented request and response codecs, golden fixtures, and
four executable pairs:

```text
N client   -> N server
N-1 client -> N server
N client   -> N-1 server after negotiation to N-1
N-1 client -> N-1 server
```

Negotiation completes before an authority-bearing command. The selected
version is immutable for the connection. Unknown advertised versions may be
ignored only while selecting a known mutual version; no mutual version,
malformed frames, schema drift, response-only drift, downgrade after command
acceptance, and missing required capabilities fail closed. Compatibility must
cover success, typed failure, streaming, cancellation, dropped response,
reconciliation, and terminal shutdown.

`RUST-N-N1-ROLLBACK` uses packaged binaries and persisted synthetic custody
state, not an in-memory codec test. It upgrades N-1 to N under live synthetic
load, injects failures at each activation phase, and rolls back to N-1. If N
has written state that N-1 cannot safely read, rollback must be rejected before
switching the active pointer. Rollback never fabricates distributed authority
or bypasses caller-owned fences and reconciliation.

## Signing, provenance, and reproducibility

The signed unit is the complete executable closure: Supervisor, Guardian,
required helper binaries, native libraries, configuration schema, protocol
schema, and immutable manifest. Verifying only the top-level binary is `FAIL`.

macOS qualification uses the supported Developer ID chain, hardened runtime,
notarization, stapled ticket, `codesign` strict verification, Gatekeeper
assessment, clean-machine install/launch, tamper rejection, and update/rollback
campaigns. Windows qualification uses the approved Authenticode identity,
trusted timestamp, chain and publisher verification, Windows trust evaluation,
clean-machine install/launch, tamper rejection, and update/rollback campaigns.

Reproducibility claims apply first to the unsigned normalized payload. Platform
timestamps, notarization tickets, and signatures may make final artifacts
byte-different. Signed provenance must bind each final artifact to the exact
reproducible payload digest and source revision. A narrower reproducibility
claim must be explicit; `reproducible` without a declared byte scope is `FAIL`.

Signing jobs accept only protected release refs and reviewed workflows. Keys
must not enter source, logs, artifacts, caches, general CI variables, developer
machines, or pull-request runners. The custody drill must include unauthorized
workflow denial, key rotation, certificate expiry, revocation, compromised
release rejection, audit export, and emergency recovery with two-person
approval.

## Evidence retention and release decision

Each gate publishes its evidence bundle to immutable release storage and a
separate integrity-verification location. CI summaries and mutable artifact
links alone are insufficient. Retention includes schemas, fixtures, raw logs,
redacted diagnostics, signed manifests, attestations, checksums, cleanup scans,
runner identities, and the final owner decisions.

The Qualification Maintainer verifies closed-world target completeness. The
Product Security Owner cannot waive a failed containment or signing gate. The
Release Manager records exactly one terminal result per release target:
`QUALIFIED`, `REJECTED`, or `UNSUPPORTED`. `QUALIFIED_WITH_EXCEPTIONS` is not a
valid result.

## Current disposition

The Rust spike supports continuing production design for both components. All
gates in this document remain open. In particular, the current GitHub
attestation proves exact branch evidence only; it is not macOS notarization,
Windows Authenticode, production key custody, complete N/N-1 compatibility, or
production rollback qualification. The synthetic `ubuntu-24.04` campaign does
prove atomic cgroup v2 placement, pre-exec reduction to the non-root runner
identity, removal of supplementary groups, `no_new_privs`, denial of an active
parent-cgroup escape attempt, hostile `setsid` descendant termination, and an
empty orphan scan for that exact runner target. It does not close the
production Linux target matrix or real-provider custody gate. Candidate cleanup
custody is retained under a lifetime-exclusive Supervisor owner but remains
in-memory in this spike; durable reconciliation across a Supervisor crash
remains a production requirement.
