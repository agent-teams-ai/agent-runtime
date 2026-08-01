# Stage C provider profile and OpenCode operation results

Status: accepted scoped experimental evidence

Date: 2026-08-01

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

No production runtime code was written in this stage. The evidence supports a
bounded architecture decision; it is not a production-readiness or broad
provider-conformance claim.

## Safety boundary

All campaigns ran on the designated Linux hosting worker. They used synthetic
workspaces, credentials, provider configuration, prompts, and a local provider
stub. No user project, ambient user configuration, real credential, provider
inference request, or MCP server was used.

The actual vendored OpenCode `1.18.5` process exercised ACP v1 against the
synthetic provider. Same-host root remained the source, signing, namespace,
and evidence trust anchor.

## Provider and profile source roundtrip

Accepted campaigns:

```text
stage-c-provider-source-roundtrip-v8-20260727133458526-1-a26cd684f5
stage-c-provider-source-roundtrip-v8-20260727133528693-2-a972eb4fca
```

Evidence identities:

```text
source inventory
03e3c57966a0fa6c6a44eb8ff3d224b6b21a1a0b5fdbd3f629aaa275f65594c8

dependency inventory
4fa565e6dec224b7e16b9e7e9e3aaf3becc6b8c8aebd0ab69b1d77468208dd99

independent critic
12a313296e77b97968d656e10128206f34154315fe2c7c0234f763c1920b995e
```

The verdict was `accepted-with-honest-scoped-partials`. It provides the
provider/profile-source evidence for this stage; real provider configuration
and credential conformance remain outside the result.

## OpenCode operation seam

Current accepted frozen source pin:

```text
83e0b3e71208d99ec13c9d73644623a3b68ead374dd355f30591b556e9b3bd49
```

The pin contained 64 root-owned read-only source files. The bound pre-run
source audit passed 153 of 153 assertions, including exact campaign roles,
one-attempt claims, final prerequisites, rejection and post-final invalidation
archives, provider isolation, atomic provider-accept projection, and the
campaign-policy tamper matrix. The bound namespace preflight used the exact
source pin and helper-build attestation, observed a fresh cross-UID
`/proc/<pid>/exe` `EACCES`, and passed all 13 positive/negative provider
identity cases.

The campaign sequence was exactly:

```text
calibration / index 1
stage-c-v6-1-2026-08-01T20-01-47.321Z-71fb0766

final-1 / index 2
stage-c-v6-2-2026-08-01T20-12-31.316Z-3fda949d

final-2 / index 3
stage-c-v6-3-2026-08-01T20-16-47.411Z-4f6aa7ab
```

Each index had one signed retained claim. The source did not change between
calibration, the independent calibration audit, either final campaign, the
comparison, or the final independent audit.

### Calibration

The positive critic accepted:

- 2,327 integrity assertions with zero failures;
- 455 semantic assertions with zero failures;
- normalized projection
  `6768a401d0da207d17a80b505195505a36f7a5ff93e800c86a0ceff6c811a0fe`.

The pack-signature negative was rejected with exactly the two expected
signature/anchor failures. All 18 semantic mutation fixtures were rejected for
their expected reasons, the mutation report signature was valid, and the
postflight passed its exact 24-check set.

The independent read-only calibration `GO` record has SHA-256:

```text
c7782574f051714447d945369dc2eecc2dc34037299bb81bc10ca13e2df7a660
```

### Final campaigns and comparison

Final-1 passed 2,327 integrity and 455 semantic assertions. Final-2 passed
2,337 integrity and 455 semantic assertions. Neither critic reported a
failure.

The independently recomputed semantic projections were canonical-equal:

```text
6768a401d0da207d17a80b505195505a36f7a5ff93e800c86a0ceff6c811a0fe
```

The inputs were nevertheless fresh and distinct:

```text
raw evidence tree, final-1
a1d4d66c8cdbafad9c96aa8119ae292ea1d13cf617d39e734a9c032b8a7f5f52

raw evidence tree, final-2
0404cee5e2890f519087b5efdcef3494bf6b5b5bc92503478e98bf924a02b204

manifest canonical SHA-256, final-1
2222b5f54b7129afe39f67de1c1380022f4429dfef9522db14b758c388427c93

manifest canonical SHA-256, final-2
3ce85abbc5aba41a7f4bcc4ae24d6341ed7e9a72a3688fd9a9e909b0ff898492
```

The strict comparison accepted every boolean gate, including exact role and
path boundaries, distinct signed claims and seeds, valid pack signatures,
policy/vendor binding, exact raw-evidence digests, different manifests and raw
evidence, and equal semantic projections. Its raw file SHA-256 is:

```text
11a12e0e1896ca3e8b0cdfaa7f71679399b9bb6c64b6365896963c6d05a02840
```

The final independent read-only audit rechecked all 359 and 361 manifest
entries, signatures, prerequisite chains, critics, semantic flows, comparison,
and live residue. Its `GO` record has SHA-256:

```text
03bf067e3c21a7d73f3615a08b33ca4256bb3720e3f9f18328c461f88231d251
```

This is accepted scoped experimental evidence for hosted Linux, the exact
OpenCode `1.18.5` binary closure, ACP v1, the synthetic provider seam, and the
tested operation semantics. It does not qualify production deployment,
another platform/provider/version, real credentials or inference, MCP,
external egress, physical power loss, distributed concurrency, production key
custody, or the complete cancellation-interleaving matrix.

## Confirmed operation behavior

The two final projections agreed on all five flows:

- `op-crash` reached `SUCCEEDED_RECONCILED` after provider acceptance was
  durably projected and independently observed; dispatch count remained one;
- `op-revoke` reached `REVOKED`, interrupted the provider request, and
  excluded post-cutoff output;
- `op-cancel-duplicate` reached `CANCELLED_STREAM` without a duplicate
  provider cancel;
- `op-cancel-terminal-barrier` reached `CANCELLED_STREAM` while preserving the
  terminal barrier and pre-cutoff output;
- `op-terminal-first` reached `SUCCEEDED` without a late cancellation effect.

Across the flows:

- every operation had dispatch count one;
- provider acceptance was projected exactly once by the transactional owner;
- late output was excluded from the canonical feed and retained only as
  redacted digest and length evidence;
- cursor sequences, ten signed receipts, and ten signed barriers were checked;
- acceptance uncertainty reconciled instead of blindly redispatching;
- writer drain completed before sealing;
- root cleanup found zero processes, mounts, cgroups, sockets, deleted open
  descriptors, provider-state residue, SQLite sidecars, receipt private keys,
  or sensitive sentinels.

## Confirmed isolation boundary

- operation, stub, and provider identities were separate;
- each provider used a distinct UID and GID;
- a root-owned observer verified process identity and issued a signed
  attestation bound to run, operation, authorization, source pin, UID/GID, PID,
  boot identity, process start, executable path, and executable digest;
- the guardian retained no root capability and consumed only the signed
  attestation;
- the attestation preflight separately rejected forged, stale, wrong-run,
  wrong-operation, wrong-authorization-digest, wrong-UID, wrong-GID, wrong-PID,
  wrong-start-ticks, wrong-boot, wrong-executable-digest, and
  wrong-executable-path inputs;
- the namespace preflight was bound to the current source pin and helper build,
  and the guardian's cross-UID process-identity probe failed with `EACCES`;
- provider namespaces exposed only their authorized state, workspace,
  synthetic configuration, temporary paths, and runtime dependencies;
- provider access to AR state, raw evidence, barriers, control data, signing
  material, and sibling operation state failed closed;
- signed network authorization allowed only the exact provider and ACP
  loopback endpoints; DNS, alternate ports, and unexpected loopback endpoints
  were rejected;
- the provider execution path did not use a generic shell.

## Superseded accepted final set

The earlier pin
`27a7b2aa61d997f45a31697450cd55238f75558f112e9a0b4e7b7c8b1c8a6078`
originally produced comparison `accept` with SHA-256
`9250e0d3ed9b16fb2ff963b2b7dc1c16aff3bc64da053a672a59853a2818cdde`
and independent `GO` with SHA-256
`95d2ec129b4c1fc6e3882d984c8c21f6ad84963c12c7de342bd5eb4656bf0e5f`.
Those historical artifacts remain unmodified.

A later independent audit found
`ATTESTATION_NEGATIVE_MATRIX_INCOMPLETE` and
`NAMESPACE_PREFLIGHT_SOURCE_PIN_STALE`. The signed post-final disposition
therefore sets the effective qualification to `REJECT` with reason
`MANDATORY_PROVIDER_IDENTITY_QUALIFICATION_SCOPE_INCOMPLETE`. The independent
invalidation SHA-256 is
`d077ab49ba38b9598f3811d8bf2f87bf90e25c8c202ec3baff5c7807a909b4bb`;
the signed archive index SHA-256 is
`8c978766a7589bf8a8471e8f3698f8b9c8797e21172ba82029c98254bf7336fc`;
the signature file SHA-256 is
`cd2fc0bebbfc08b253fb8e894442f9c31379b42cda5363e2b39327d04f77f4ff`.

## Rejected source revisions

Rejected revisions were retained instead of rerun:

- `d42b0e3764e317e505211c5e9500686087e4f9a3ea3e11efefcef2f9ffb8786f`
  was rejected because the final campaigns diverged on provider-accept
  projection and the legacy campaign-index contract;
- `a5ab8e8141b97c00bcbfc937814753d937d89ee3100caeb6add250631e1b7826`
  was rejected because duplicated policy wording made the positive critic fail
  `CAMPAIGN_POLICY_EXACT`;
- `db07fc80b0ee404a4de1256b9abe0eef94ce9629753455cfd504fa96db4dce95`
  was rejected before calibration because a rebuild removed the required
  setuid helper modes and the namespace preflight failed closed;
- `9058db81fed097ccc964eda46dcaa4f7528784dbc521e3ca63acc553b730326d`
  was rejected before calibration because the rejection fixture depended
  circularly on the live base policy;
- `4a95dfd35467f59bcd52705b2d40194bdb2aa549077ba4cba3b85cf7bac8d695`
  was rejected before calibration because the post-final validator was
  incompatible with the retained historical run-root modes.

The duplicated-policy defect was fixed by one JSON-only deep-frozen campaign
policy used directly by the policy producer, critic, source audit, and
frozen-pin verifier. No campaign was launched for the last three pre-execution
rejects. No rejected pin was silently rerun.

## Architecture consequence

The evidence supports these scoped boundaries:

- external provider acceptance needs a durable projection before recovery can
  decide whether redispatch is safe;
- cancellation, revocation, output cutoff, and late-evidence handling are
  one operation-state concern;
- root process observation and guardian authorization remain separate
  capabilities;
- provider filesystem and network access are explicit signed projections, not
  ambient host access;
- a final campaign is admissible only after immutable calibration evidence and
  an independent `GO`.

The scratch harness is evidence, not production code, and must not be copied as
an implementation.

## Post-stage OpenCode conformance follow-up

The later hosting-only OpenCode E2E matrix is recorded in
`docs/spikes/opencode-hosting-e2e-results.md`. Its machine-readable redacted
summary is
`experiments/runtime-profile-behavior/fixtures/opencode-hosting-e2e-summary.json`.

That follow-up used OpenCode `1.18.5` and `1.18.8`, deterministic provider
faults, and a disposable real ChatGPT OAuth grant in synthetic workspaces. It
confirmed the Stage C ownership model while adding native counterexamples for
same-session concurrency, early cancellation, output drain, session ownership,
MCP and skill discovery, filesystem indirection, descendant cleanup, OAuth
generation races, dependency egress, retry storms, SQLite pressure, and
upgrade/rollback.

The current accepted Stage C source, campaigns, and projections remain
unchanged. The follow-up narrows some OpenCode-specific partials; it does not
upgrade Stage C into a production-readiness claim.

## Post-stage Linux containment and egress follow-up

The hosted Linux matrix is recorded in
`docs/spikes/linux-nonroot-containment-egress-results.md`. Its machine-readable
redacted summary is
`experiments/runtime-profile-behavior/fixtures/linux-nonroot-containment-egress-summary.json`.

Three campaigns plus an independent 50-of-50 audit confirmed that a non-root,
zero-capability runtime with read-only root, no-new-privileges, seccomp,
AppArmor, explicit resource limits, and cgroup-v2 custody left no observed
survivor after timed stop or forced kill, even when a child created a new
process group and session.

The same campaigns proved that an internal Docker bridge is not an endpoint
allowlist: a deliberately attached unauthorized peer was reachable every
time. The provider-facing network must contain only a per-operation egress
gateway, which enforces the signed destination and budget.

This closes the scoped container/cgroup custody question on the tested worker.
External TLS/DNS gateway policy, Docker-daemon custody, custom profiles, image
trust, init/zombie behavior, platform versions, and end-to-end OpenCode in
that boundary remain gates.

## Post-stage PostgreSQL concurrency follow-up

The later single-host PostgreSQL matrix is recorded in
`docs/spikes/postgresql-concurrency-results.md`. Its machine-readable redacted
summary is
`experiments/runtime-profile-behavior/fixtures/postgresql-concurrency-summary.json`.

The final PostgreSQL `18.4` single-host campaign passed an independent
32-of-32 audit over command idempotency, cross-session conflicts, locked
sequence allocation, timeout-after-commit replay, dispatch fencing, acceptance
reconciliation, transactional outbox, idempotent inbox, process crash, and
same-server logical restore. A two-physical-host macOS/Linux client follow-up
passed 48 of 48 checks over the same-command race, cross-session conflict,
gap-free sequence allocation, and complete SSH-link loss.

The link-loss evidence proves that disconnect does not imply transaction
rollback: PostgreSQL may continue a buffered batch and commit after the client
has failed. Durable command reconciliation is mandatory. General delay,
packet loss, asymmetric partitions, multi-worker orchestration, HA/failover,
split-brain fencing, off-host PITR, physical power loss, and production
pool/migration behavior remain gates.

## Post-stage Connect replay follow-up

The local Node Connect matrix is recorded in
`docs/spikes/connect-replay-results.md`. Its machine-readable redacted summary
is `experiments/runtime-profile-behavior/fixtures/connect-replay-summary.json`.

Connect `2.1.2` over HTTP/1.1 and HTTP/2 passed an independent 55-of-55 audit
covering timeout after durable acceptance, explicit cursor resume after
socket/session loss, at-least-once redelivery after an uncheckpointed event,
typed expired/forged/wrong-stream/ahead cursors, HTTP/2 GOAWAY, and bounded
transport cleanup.

The slow-consumer case also falsified an unsafe assumption: while the client
paused, the server generator produced the full 8 MiB sample on both protocols.
AR must enforce its own per-subscriber byte/event budgets instead of treating
Connect backpressure as that budget.

This closes only the local Node contract. TLS/proxy/load-balancer/service-mesh,
browser/mobile SDK, multi-host drain, production persistence/retention,
cursor-key rotation, and resource-soak behavior remain gates.

## Post-stage macOS Keychain custody follow-up

The disposable file-backed Keychain matrix is recorded in
`docs/spikes/macos-keychain-custody-results.md`. Its machine-readable redacted
summary is
`experiments/runtime-profile-behavior/fixtures/macos-keychain-custody-summary.json`.

The accepted campaign passed an independent 39-of-39 audit. It falsified the
assumed secure create mode by observing `0644`, proved that a backup can retain
an older usable credential generation after live rotation, and showed that
concurrent Keychain updates are not a generation-CAS mechanism.

The scoped result makes Keychain a local secret-byte adapter behind
`KeyProvider`, while Provider Access owns credential generation, refresh
fencing, and durable CAS. An ad-hoc signed `SecItem` follow-up qualified only
the deprecated custom file-keychain path and falsified reliable no-UI locked
access there. Data Protection Keychain integration from the signed helper,
access-group and locked-session behavior, backup invalidation, crypto-erasure,
and external KMS or off-host trust custody remain gates.

## Remaining production gates

The following remain unresolved and block broader release claims:

- real Codex and Claude credentials and provider conformance, plus any
  additional supported OpenCode accounts and routes;
- Linux end-to-end OpenCode in the accepted non-root container/cgroup
  boundary, external TLS/DNS egress gateway policy, Docker-daemon custody,
  custom seccomp/AppArmor and image trust, init/zombie behavior, and the
  supported platform matrix; scoped descendant custody and same-network
  egress evidence is complete;
- macOS production endpoint-specific network enforcement and continuous
  descendant custody after the confirmed process-group/session escape,
  isolated real-provider parity, broader macOS versions, and physical Intel if
  supported; full Windows process, filesystem, and network containment;
- physical power loss, migration, and production backup/restore behavior; the
  follow-up covers scoped OpenCode `ENOSPC`, process crash, forced disposable
  APFS detach/reattach, atomic family and logical restore, and corruption
  recovery;
- PostgreSQL multi-host partitions, replication/leader failover, split-brain
  fencing, off-host PITR, and measured RPO/RTO; scoped single-host concurrency,
  fencing, process crash, same-server restore, and two-physical-host
  client/link-loss behavior are complete;
- external Connect TLS/proxy/load-balancer/service-mesh, browser/mobile SDK,
  multi-host drain, production persistence/retention, cursor-key rotation, and
  resource-soak conformance; the scoped local Node matrix is complete;
- production `KeyProvider` and external KMS or off-host trust anchor; the
  disposable macOS file-backed Keychain storage matrix is complete, but signed
  `SecItem`, Provider Access CAS, backup invalidation, and crypto-erasure are
  not;
- binary policy beyond the tested OpenCode `1.18.5` and `1.18.8` resume pair.
