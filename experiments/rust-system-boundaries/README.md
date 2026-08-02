# Rust system-boundary evidence harness

Status: isolated evidence spike. It is not production code, an ADR, or a
production-qualification claim.

Run the complete synthetic suite from the repository root:

```sh
cargo test --locked --manifest-path experiments/rust-system-boundaries/Cargo.toml --workspace --all-targets
```

Run the real TypeScript caller to Rust Guardian crash/reconciliation test:

```sh
node --test experiments/rust-system-boundaries/client/guardian-conformance.test.ts
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
| Interrupted activation | Typed faults and real separate-process aborts cover after staging, after active-pointer write before phase update, and after phase update before commit; every surviving transaction restores the prior exact generation | Corrupt transaction is rejected, never inferred; an unfinalized candidate is never promoted |
| Health gate rollback | A caller-supplied failed health result preserves the previous active pointer | Candidate remains unpromoted; real candidate-process health is not claimed |
| Release integrity | External fixture trust anchor verifies Ed25519 manifest signature and canonical SHA-256 artifact; artifact file names and generation versions are validated as single safe components before staging paths exist | Signature, digest, or unsafe component rejects before staging |
| State replacement | Supervisor active/transaction state and Guardian custody evidence replace an existing same-directory file repeatedly | Windows uses `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`; Unix uses `rename`; never remove-then-rename |
| Bounded Guardian streams | Synthetic tree produces stdout/stderr while capture caps bytes and records truncation | Over-limit data is bounded, not silently unbounded |
| Tree termination | Parent plus synthetic descendant terminate through the platform containment primitive | Any required signal failure, including `EPERM`, is an error, never success |
| Guardian singleton | Two OS Guardian processes contend for one state root; one owns it, the second fails, and a successor acquires it after owner exit | A second owner receives a state-root lock failure before protocol processing |
| Fence and request replay | Caller-driven fence advancement persists the new opaque fence; the once-valid old fence is then rejected; same request is exact replay; conflicting request/operation IDs reject | No duplicate process is created and Guardian never decides fence authority |
| Crash/orphan recovery | Restarted Guardian rechecks custody nonce plus OS birth identity and may terminate only after proof matches; Linux identity includes boot ID; the TypeScript client verifies root and descendant PIDs are gone | PID alone yields `identity_unverified`; missing launch proof remains explicit `launch_uncertain` and never triggers blind respawn |
| Ambiguous spawn response | Fixture starts once, intentionally drops its first reply; the TypeScript caller crashes and restarts Guardian, then reconciles by operation identity | A second spawn is prevented by operation identity; no blind retry |
| Protocol skew | Frozen, distinct v1/v2 request fixtures and an actual v1 TypeScript request run against the v2 Guardian; `N+1`, `N-2`, malformed, unknown-field, and oversize frames reject | Draining is finite; excessive oversized input makes the connection terminal; no best-effort parse or downgrade |
| macOS/Linux containment | Rust 1.97 `CommandExt::process_group(0)` plus verified dedicated PGID controls the synthetic tree | A `setsid`-escaping child remains explicitly unsupported |
| Signed evidence drill | Exact source ref, commit digest, archive SHA-256, and GitHub/Sigstore bundle are verified; non-main refs remain explicitly untrusted evidence | No branch attestation is treated as a trusted-main or production release claim |
| Windows containment | `cfg(windows)` creates a Job Object with `KILL_ON_JOB_CLOSE`, assigns the fixture before descendant release, records process creation time, and verifies actual process exit | Arbitrary post-spawn attachment is not claimed as production-safe containment |

The exact command is designed to run on a GitHub Windows runner. A local macOS
run cannot certify Windows behavior.

## Protocol

The experiment uses closed-world NDJSON with a 64 KiB maximum frame and a
finite 64 KiB oversize-drain allowance. The schema has explicit
`protocol_version`, `request_id`, frozen v1/v2 request projections, typed
command variants, and typed errors. It is deliberately language-neutral.
Per-connection negotiation, an independently generated v1 response client,
and the final production encoding remain open.

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

- POSIX process groups are deliberately weaker than a cgroup or Job Object:
  a descendant that calls `setsid` can escape. The Guardian reports that limit;
  it makes no security-containment claim for POSIX process groups.
- Recovered Unix termination still has a narrow identity-check-to-PGID-signal
  race because POSIX exposes no stable process-group handle. Production custody
  needs a reaper/launcher design or a stronger platform primitive before this
  can protect hostile multi-tenant workloads.
- A crash before the fixture publishes its identity witness remains
  `launch_uncertain`. The Guardian refuses blind retry, but the spike does not
  prove automatic recovery of every possible pre-witness orphan window.
- The Windows fixture waits for Guardian release before it creates descendants,
  so the test proves Job Object tree termination without claiming arbitrary
  post-spawn attachment is race-free. A production Windows Guardian would need
  an atomic suspended/CreateProcess or Job-list path.
- This is an Ed25519 fixture-manifest drill only. It does not claim macOS
  notarization, Authenticode, hardware-backed keys, release provenance, or
  platform code signing.
- The Supervisor fault drill intentionally aborts a disposable child process.
  It tests local state-transition recovery, not power-loss durability; `fsync`,
  filesystem-specific atomicity, and production updater behavior remain out of
  scope for this spike.
- Supervisor `HealthCheck` is a caller-supplied result, not a generation-bound
  process probe. The Host witness starts after activation, so production
  candidate health and readiness still require a separate design.
- The Guardian and Supervisor do not prove distributed concurrency. Their local
  fences, file locks, and custody records do not replace caller-owned CAS,
  revisions, inbox/outbox, leases, or reconciliation.
- The synthetic Host witness uses in-process coordination around a disposable
  child. It proves generation selection and restart/update behavior, not a
  production Host process manager or two independent Host bootstrappers.
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
