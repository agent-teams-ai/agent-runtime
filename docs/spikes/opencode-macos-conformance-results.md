# OpenCode macOS conformance results

Status: accepted partial platform evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Machine-readable summary:
`experiments/runtime-profile-behavior/fixtures/opencode-macos-e2e-summary.json`

Summary SHA-256:

```text
fa86a84143d3fc901d1c789c1adfd67cc768340ea2b0821ad749ac23f907a03c
```

Retained harness and result bundle on the qualification host:

```text
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/reports/
  macos-opencode-1.18.8-e2e-2026-07-28.tar.gz
```

Bundle SHA-256:

```text
cd2872dfc6f49f9245edc81871359dedc3b0af4a7f4caebad2c63ba32e592549
```

Retained deep-follow-up harness and redacted results:

```text
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/reports/
  macos-opencode-deep-e2e-2026-07-28.tar.gz
```

Deep-follow-up bundle SHA-256:

```text
d1e37e17a2c3f1ce42c3440aa70b8af4d053b4bff895361e7a40d95b234c2903
```

## Safety and scope

The matrix ran locally on macOS only after explicit user approval and only
inside a newly created disposable `/tmp` campaign. No user project was opened.
The harness supplied an isolated HOME, XDG roots, workspace, provider stub,
MCP sentinel, and APFS sparse image.

The installed global OpenCode binary, ambient user configuration, and ambient
credentials were not used. The official OpenCode `1.18.5` and `1.18.8`
Apple Silicon and x64 release assets were downloaded into the campaign and
their published SHA-256 values were verified before execution.

The tested platform was:

- macOS `15.6.1`, build `24G90`;
- Darwin `24.6.0`;
- Apple Silicon `arm64`;
- OpenCode `1.18.5` and `1.18.8`, native arm64 and x64 under Rosetta;
- ACP v1 over stdio;
- deterministic local OpenAI-compatible provider only.

No real provider inference occurred. App Sandbox tests re-signed disposable
copies after verifying the upstream assets; the original downloaded binaries
remained unchanged. The result does not claim complete macOS production
containment.

## Confirmed execution behavior

### ACP, concurrency, cancellation, and recovery

- Three isolated runs negotiated ACP v1, reported OpenCode `1.18.8`, reached
  the local provider exactly once, returned the exact marker, and ended with
  `end_turn`.
- Three same-session races issued six concurrent prompt RPCs. Both RPCs
  returned successfully in every run. Provider request counts were `2, 1, 1`;
  the second marker survived every run, while the first marker was absent in
  the two coalesced runs.
- One cancellation after the delayed provider request arrived returned
  `stopReason=cancelled` and did not issue another provider request.
- One `SIGINT` and one `SIGKILL` restart both loaded the same session in a new
  process and completed an exact new prompt.

The Linux conclusions remain valid on this sample: Agent Execution must
serialize prompts per OpenCode session, own provider acceptance, and reconcile
cancel and recovery outside ACP terminal return or OpenCode state.

### Skills and project configuration

- An OpenCode-native skill under the isolated HOME reached the provider prompt
  with no disable flag.
- It still reached the provider prompt with
  `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` and
  `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`.
- The marker was absent in all three clean-HOME control runs.
- A synthetic project MCP started twice per logical run.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` prevented every project MCP start in the
  disabled control.

External-skill compatibility flags do not suppress OpenCode-native global
skills. The isolation contract is a clean allowlisted HOME plus project-config
disable, not a growing collection of negative flags.

## Confirmed macOS containment behavior

### Process custody

For each of `SIGINT`, `SIGTERM`, and `SIGKILL`:

- OpenCode started the project MCP sentinel twice;
- killing only OpenCode stopped the sentinel;
- one sentinel-spawned child remained alive.

In a separate positive control, OpenCode ran as leader of a dedicated process
group. Killing the whole group stopped the observed sentinel and its inherited
child.

The adversarial follow-up then created one detached descendant in a new session
and process group. Group kill stopped the sentinel and inherited child but the
detached descendant survived. Cleanup using the pre-captured descendant ledger
stopped it.

A macOS adapter therefore needs dedicated process-group custody plus continuous
independent descendant observation. The counterexample closes the behavioral
question, but production implementation and qualification of that custody
remain a release gate.

### APFS paths

On the tested APFS volume:

- a workspace symlink read an external file;
- a workspace hardlink mutated the external inode;
- case-only path spellings aliased;
- NFC and NFD spellings of the same Unicode filename aliased.

Materialization must reject or safely replace symlinks and hardlinks before
launch. Collision checking must use target-volume case and Unicode behavior,
not only portable string comparison.

### Ports

One fixed-port pair left exactly one live process. Two simultaneous
`--port 0` processes both remained alive. The macOS ACP adapter should use
OS-selected ephemeral ports unless an atomic port lease is separately
qualified.

### Network enforcement

Two mechanisms were exercised:

- a `sandbox-exec` profile allowed the loopback provider and blocked an
  external TCP discriminator until the 25-second ACP supervisor timeout;
- a signed App Sandbox bundle embedded a signed OpenCode helper with
  `com.apple.security.app-sandbox` and
  `com.apple.security.inherit`.

The App Sandbox bundle required `network.server` for OpenCode's internal
listener. Without `network.client`, OpenCode negotiated ACP but could not
create a session. With `network.client`, the loopback provider completed and
the same process reached the external discriminator, producing the exact
protocol-error digest seen in the unsandboxed control.

This proves that App Sandbox can contribute filesystem and process containment
but its client entitlement is not an endpoint allowlist. Exact per-operation
egress still needs a separately qualified network adapter or a contained worker
boundary. `sandbox-exec` is marked deprecated by the tested macOS platform and
is evidence only, not the production mechanism.

## Confirmed storage behavior

Five cold first-use pairs launched ten concurrent `session list` processes
against one state root per pair:

- `5/10` succeeded;
- two failed with `database is locked`;
- three failed in schema bootstrap.

After one successful warm-up, five more concurrent pairs completed `10/10`.
OpenCode state bootstrap therefore needs one fenced owner on macOS as well as
Linux.

A separate disposable 256 MiB APFS sparse image exercised storage pressure:

- warm operation succeeded;
- after fill, about 6.49 MiB remained available and OpenCode returned a
  no-space storage failure;
- removing the filler restored about 266.56 MiB;
- the next operation succeeded.

APFS capacity failure is a typed storage outcome. Recovery still requires state
revalidation before the runtime becomes reusable.

The deep follow-up added backup, corruption, and crash cases:

- an atomic raw DB/WAL/SHM family restore passed SQLite integrity, session load,
  and a new prompt;
- a checkpointed SQLite logical backup passed the same recovery checks;
- deleting or corrupting WAL left the base DB `integrity_check` at `ok` but
  made the recent session unloadable;
- corrupting SHM recovered, and DB-header corruption recovered while the valid
  WAL was present;
- replacing the DB with invalid bytes produced a typed corrupt-database
  failure, and restoring the family recovered;
- after `SIGKILL` between provider acceptance and response, session load did
  not issue another provider request, while an explicit follow-up prompt
  succeeded;
- forced detach of a disposable APFS sparse image during an accepted prompt
  succeeded and the RPC timed out; after reattach, SQLite integrity was `ok`,
  the same session loaded without a provider request, and an explicit
  follow-up prompt succeeded.

Base-DB integrity alone is therefore insufficient. Backup owns a checkpointed
logical snapshot or an atomic DB/WAL/SHM family, and acceptance-uncertain
commands remain reconciled by durable command identity rather than replay.
Forced device removal is stronger evidence than process termination but is not
physical power-loss qualification.

## Confirmed binary compatibility

Five cold resume pairs loaded the existing session and completed a new prompt:

- arm64 `1.18.5` to arm64 `1.18.8`;
- arm64 `1.18.8` to arm64 `1.18.5`;
- Rosetta x64 `1.18.5` to Rosetta x64 `1.18.8`;
- arm64 to Rosetta x64 at `1.18.8`;
- Rosetta x64 to arm64 at `1.18.8`.

This is a bounded positive set. Rosetta is not evidence for physical Intel
hardware, other macOS releases, or binaries outside these two versions.

## Relationship to the architecture

The matrix confirms the provider-neutral ports in ADR-0001. macOS changes the
adapter, not bounded-context ownership:

- Runtime Configuration owns portable profile intent and target-platform
  compatibility requirements.
- Runtime Security owns exact filesystem and network authorization.
- Agent Execution owns session serialization, acceptance, output, recovery,
  and platform-specific process custody.
- Runtime Capacity selects a qualified macOS worker without exposing process
  IDs or paths as business identities.

The macOS implementation must sit behind focused ports for process custody,
filesystem materialization, target-volume canonicalization, storage, and
network enforcement. Signing is also an adapter concern: verify the upstream
release digest first, then attest both upstream and signed-helper identities.
Linux cgroups, namespaces, and `/proc` must not leak into domain or application
contracts.

Platform references:

- [Apple App Sandbox](https://developer.apple.com/documentation/security/app-sandbox);
- [Embedding a command-line tool in a sandboxed app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app);
- [Apple Virtualization](https://developer.apple.com/documentation/virtualization).

Credential custody is qualified separately in
`docs/spikes/macos-keychain-custody-results.md`. That scoped follow-up closes
the disposable file-backed Keychain mode, lock, backup-generation, and
concurrent-update matrix, but not production `SecItem`, Provider Access CAS,
backup invalidation, crypto-erasure, or external KMS.

## Remaining macOS gates

This is strong partial evidence, not a macOS production `GO`. The remaining
gates are:

- production endpoint-specific network enforcement and independent
  qualification;
- one real-provider and OAuth parity pass in a disposable isolated profile;
- production continuous descendant custody after the confirmed
  process-group/session escape;
- physical power loss and production backup/restore qualification beyond the
  passing process-crash, forced-device-loss, and corruption matrix;
- the supported macOS-version policy and physical Intel qualification, if
  Intel is supported.
