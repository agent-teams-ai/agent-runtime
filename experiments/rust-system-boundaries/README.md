# Rust system-boundary evidence harness

Status: isolated evidence spike. It is not production code, an ADR, or a
production-qualification claim.

Disposition:

- `SPIKE PROVEN`: the scoped synthetic Supervisor/Guardian assertions in the
  pass/fail matrix have passed on their declared targets.
- `PRODUCTION GATE OPEN`: the spike does not qualify a distributed binary,
  hostile macOS profile, real provider, production updater, signing chain, or
  supported platform matrix.

The canonical merged baseline is the strict machine-readable
[`main@aa76858` evidence record](evidence/main-aa76858-evidence.json). Production
gates remain in
[`docs/spikes/rust-system-boundaries-production-gates.md`](../../docs/spikes/rust-system-boundaries-production-gates.md).

Run the complete synthetic suite from the repository root:

```sh
cargo test --locked --manifest-path experiments/rust-system-boundaries/Cargo.toml --workspace --all-targets
```

Run the real TypeScript callers for Guardian crash/reconciliation and protocol
compatibility:

```sh
pnpm spike:rust-boundaries:client
```

`target/` is ignored locally inside this experiment. The harness launches only
its own `fixture-child` binary in temporary directories. It performs no network
calls, provider invocation, credential access, or user-project access.

## Boundary under test

```text
caller / future TypeScript AR client
  -- bounded NDJSON --> Rust Execution Guardian
                              |
                              +-- process tree, streams, custody evidence

caller / Desktop bootstrapper
  -- local release files --> Rust Local Supervisor
                              |
                              +-- one active local generation and rollback
```

The Supervisor and Guardian are distinct crates and binaries. Neither imports
runtime-domain models or decides any distributed policy.

**Rust is technical data-plane only. Distributed concurrency remains the
caller's CAS, revisions, inbox/outbox, leases, fences, and reconciliation.**

## Pass/fail matrix

| Evidence | Pass condition | Fail-closed result |
| --- | --- | --- |
| Concurrent Supervisor ensure | Eight separate OS processes select one exact active generation; the synthetic Host witness converges eight callers on one generation/PID | A lock, state-write, manifest, artifact, or health error rejects activation; no guessed active version |
| Supervisor lifetime custody | One process owns a state root for the complete `Supervisor` lifetime; a second in-process instance rejects and another process waits for owner release | A failed candidate cleanup retains the exact child handle under that owner, and no second instance can bypass the pending cleanup while the owner remains alive |
| Interrupted activation | Typed faults and real separate-process aborts cover after staging, after active-pointer write before phase update, and after phase update before commit; every surviving transaction restores the prior exact generation | Corrupt transaction is rejected, never inferred; an unfinalized candidate is never promoted |
| Generation-bound health | Supervisor launches the staged Host and verifies a fresh nonce, generation, artifact and executable digests, PID, OS birth identity, and continued liveness before activation | Silent, stale, replayed, wrong-generation, wrong-binary, wrong-identity, or exited candidates remain unpromoted and preserve the prior generation |
| Release integrity | External fixture trust anchor verifies Ed25519 manifest signature and canonical SHA-256 artifact; artifact file names and generation versions are validated as single safe components before staging paths exist | Signature, digest, or unsafe component rejects before staging |
| State replacement | Supervisor active/transaction state and Guardian custody evidence replace an existing same-directory file repeatedly | Windows uses `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`; Unix uses `rename`; never remove-then-rename |
| Bounded Guardian streams | Synthetic tree produces stdout/stderr while capture caps bytes and records truncation | Over-limit data is bounded, not silently unbounded |
| Tree termination | Parent plus synthetic descendant terminate through the platform containment primitive | Any required signal failure, including `EPERM`, is an error, never success |
| Guardian singleton | Two OS Guardian processes contend for one state root; one owns it, the second fails, and a successor acquires it after owner exit | A second owner receives a state-root lock failure before protocol processing |
| Fence and request replay | Caller-driven fence advancement persists the new opaque fence; the once-valid old fence is then rejected; same request is exact replay; conflicting request/operation IDs reject | No duplicate process is created and Guardian never decides fence authority |
| Crash/orphan recovery | Restarted Guardian rechecks custody nonce plus OS birth identity and may terminate only after proof matches; Linux identity includes boot ID; the TypeScript client verifies root and descendant PIDs are gone | PID alone yields `identity_unverified`; missing launch proof remains explicit `launch_uncertain` and never triggers blind respawn |
| Ambiguous spawn response | Fixture starts once, intentionally drops its first reply; the TypeScript caller crashes and restarts Guardian, then reconciles by operation identity | A second spawn is prevented by operation identity; no blind retry |
| Protocol skew | Independently frozen v1 request/response DTOs and current v2 DTOs negotiate the highest mutual version; a current client ignores unknown future advertisements and selects its highest known mutual version; TypeScript clients exercise both projections and version-mixing rejects | No mutual version rejects during handshake; the selected version is immutable and no best-effort parse or post-selection downgrade occurs |
| Unix containment | The evidence harness proves process-group escape through `setsid`, stable per-process Linux signaling through `pidfd`, fail-closed rejection without a verified delegated cgroup v2 leaf, and an isolated Ubuntu runner campaign using `clone3(CLONE_INTO_CGROUP)`, pre-exec credential reduction, `cgroup.kill`, and a final orphan scan | The workload runs as the non-root runner identity with no supplementary groups and `no_new_privs`; its active parent-cgroup escape attempt must be denied; the pass qualifies only that exact synthetic GitHub `ubuntu-24.04` target |
| Credential sentinel rejection | Linux workload identity rejects `uid_t::MAX` and `gid_t::MAX` before `setresuid`/`setresgid` | The unchanged-credential sentinel can never turn a requested privilege drop into a successful no-op |
| Signed evidence drill | Exact source ref, commit digest, archive SHA-256, and GitHub/Sigstore bundle are verified; non-main refs remain explicitly untrusted evidence | No branch attestation is treated as a trusted-main or production release claim |
| Windows containment | Windows creates the root suspended, creates a `KILL_ON_JOB_CLOSE` Job Object, assigns the root, then resumes it; five partial-failure points and Guardian crash verify bounded cleanup and tree exit | No fixture instruction or descendant runs before Job assignment; incomplete cleanup remains typed evidence and fails closed |

The exact command is designed to run on a GitHub Windows runner. A local macOS
run cannot certify Windows behavior.

## Protocol

The experiment uses closed-world NDJSON with a 64 KiB maximum frame and a
finite 64 KiB oversize-drain allowance. The schema has explicit
`protocol_version`, `request_id`, frozen v1/v2 request projections, typed
command variants, and typed errors. It is deliberately language-neutral.
The protocol crate proves per-connection negotiation and independently frozen
v1 request/response parsing against the v2 compatibility server. A current
client also accepts bounded, well-formed future version advertisements and
selects the highest mutually implemented version. The spike Guardian still
uses its legacy per-frame entrypoint; making handshake mandatory there and
selecting the final production encoding remain integration work.

## Custody evidence and recovery

Persisted files contain only technical evidence: operation ID, opaque-fence
digest, custody ID, spawn nonce, diagnostic PID/PGID, OS process birth
identity, process identity-proof path, fixture state, and containment report.
They do not contain runtime session, task, tenant, approval, lease, or
authorization models.

The synthetic root emits a terminal witness on graceful `SIGTERM`, but current
reconciliation does not treat that file alone as authoritative. OS birth
identity remains mandatory; missing or ambiguous tree evidence fails closed.

## Platform limitations

- POSIX process groups are deliberately weaker than a cgroup or Job Object; the
  harness now demonstrates a real `setsid` escape. Linux `pidfd` closes the
  identity-to-signal race only for one process. The isolated `ubuntu-24.04`
  workflow now proves Host-created cgroup v2 admission, atomic placement before
  fixture execution, removal of supplementary groups, reduction to the non-root
  runner UID/GID, `no_new_privs`, denial of an active parent-cgroup escape,
  `cgroup.kill`, and an empty post-kill member scan for its exact synthetic
  target. This does not qualify other kernels, distributions, deployment
  privileges, real provider binaries, or production crash recovery. macOS has
  no equivalent proof in this spike and remains unsupported for hostile
  custody.
- A crash before the fixture publishes its identity witness remains
  `launch_uncertain`. The Guardian refuses blind retry, but the spike does not
  prove automatic recovery of every possible pre-witness orphan window.
- Windows now uses suspended creation before Job assignment. The spike locates
  the primary thread through ToolHelp; production should retain the original
  thread handle from raw `CreateProcessW` instead of rediscovering it.
- This is an Ed25519 fixture-manifest drill only. It does not claim macOS
  notarization, Authenticode, hardware-backed keys, release provenance, or
  platform code signing.
- The Supervisor fault drill intentionally aborts a disposable child process.
  It tests local state-transition recovery, not power-loss durability; `fsync`,
  filesystem-specific atomicity, and production updater behavior remain out of
  scope for this spike.
- Failed candidate cleanup, including rejection before `RunningHost` exists,
  retains the exact child handle and blocks a new activation until
  reconciliation succeeds. A lifetime owner lock prevents another Supervisor
  instance from bypassing that in-memory custody while the owner remains alive.
  Production still needs durable startup reconciliation after the Supervisor
  itself crashes during candidate cleanup.
- Windows liveness uses a zero-time wait on a synchronized process handle, not
  `GetExitCodeProcess`; exit code `259` is therefore observed as exited rather
  than confused with the legacy `STILL_ACTIVE` value.
- Supervisor health is generation-bound, but the synthetic nonce is passed as
  a process argument and is not confidential from a hostile same-user process.
  Production needs a protected one-use IPC challenge and safe Supervisor
  reattachment after its own crash.
- The Guardian and Supervisor do not prove distributed concurrency. Their local
  fences, file locks, and custody records do not replace caller-owned CAS,
  revisions, inbox/outbox, leases, or reconciliation.
- The synthetic Host proves generation selection, candidate health,
  crash/restart, rollback, and replacement. It does not qualify a production
  updater, Host process-tree containment, or cross-user attack resistance.
- The signed workflow is provenance evidence for an exact ref and digest.
  Branch evidence is intentionally untrusted; production release retention,
  notarization, Authenticode, and key-custody policy are outside this spike.

## ProcessKit evaluation

`processkit` was evaluated but is intentionally not a dependency of this
spike. Cargo currently reports `3.1.0` as latest; `3.0.2` exists. Its documented
mechanisms and caveats are relevant: cgroup v2 / Job Object / POSIX process
groups, including the `setsid` escape limitation. It would reduce implementation
code, but for this evidence campaign it would hide the direct custody adapter,
PGID verification, exact signal behavior, and owner-loss recovery we need to
observe. It remains a future implementation-comparison candidate, not an
accepted architectural choice.

References: [ProcessKit API](https://docs.rs/processkit/latest/processkit/),
[Rust Unix CommandExt](https://doc.rust-lang.org/std/os/unix/process/trait.CommandExt.html).
