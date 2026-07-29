# Stage C provider profile and OpenCode operation results

Status: accepted scoped experimental evidence

Date: 2026-07-28

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

Accepted frozen source pin:

```text
27a7b2aa61d997f45a31697450cd55238f75558f112e9a0b4e7b7c8b1c8a6078
```

The pin contained 62 root-owned read-only source files. The bound pre-run
source audit passed 148 of 148 assertions, including exact campaign roles,
one-attempt claims, final prerequisites, rejection archives, provider
isolation, atomic provider-accept projection, and a six-case campaign-policy
tamper matrix.

The campaign sequence was exactly:

```text
calibration / index 1
stage-c-v6-1-2026-07-27T23-50-42.004Z-f7ba1be6

final-1 / index 2
stage-c-v6-2-2026-07-27T23-59-19.036Z-207ccbb4

final-2 / index 3
stage-c-v6-3-2026-07-28T00-01-21.280Z-45a3bb6c
```

Each index had one signed retained claim. The source did not change between
calibration, the independent calibration audit, either final campaign, the
comparison, or the final independent audit.

### Calibration

The positive critic accepted:

- 2,313 integrity assertions with zero failures;
- 455 semantic assertions with zero failures;
- normalized projection
  `ea223488baf264faea4c2cc64cb8237e6c77234a6ca9bff83ce44d100e644848`.

The pack-signature negative was rejected with exactly the two expected
signature/anchor failures. All 18 semantic mutation fixtures were rejected for
their expected reasons, the mutation report signature was valid, and the
postflight passed its exact 24-check set.

The independent read-only calibration `GO` record has SHA-256:

```text
2588be96df2e920806e0b167addaf991ac12438d80311fbf75ce57edb7a03f19
```

### Final campaigns and comparison

Final-1 passed 2,313 integrity and 455 semantic assertions. Final-2 passed
2,318 integrity and 455 semantic assertions. Neither critic reported a
failure.

The independently recomputed semantic projections were canonical-equal:

```text
ea223488baf264faea4c2cc64cb8237e6c77234a6ca9bff83ce44d100e644848
```

The inputs were nevertheless fresh and distinct:

```text
raw evidence tree, final-1
5902ba2772f82f5e811d88ef7209125ccfb2bd6ca5b16cddc7030f821182b714

raw evidence tree, final-2
be12d0e6a92a10e93a5f1c75295515c47028354ad5c6b610f07b159ab39a0b81

manifest canonical SHA-256, final-1
40243e073fb8109c2667313225d45acaee007651d5f075fa141038ea749caae5

manifest canonical SHA-256, final-2
28425a90c474642cf16c4ad91235544cc49cee0b103242ddc9bc586df20fc1e7
```

The strict comparison accepted every boolean gate, including exact role and
path boundaries, distinct signed claims and seeds, valid pack signatures,
policy/vendor binding, exact raw-evidence digests, different manifests and raw
evidence, and equal semantic projections. Its raw file SHA-256 is:

```text
9250e0d3ed9b16fb2ff963b2b7dc1c16aff3bc64da053a672a59853a2818cdde
```

The final independent read-only audit rechecked all 359 and 360 manifest
entries, signatures, prerequisite chains, critics, semantic flows, comparison,
and live residue. Its `GO` record has SHA-256:

```text
95d2ec129b4c1fc6e3882d984c8c21f6ad84963c12c7de342bd5eb4656bf0e5f
```

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
- provider namespaces exposed only their authorized state, workspace,
  synthetic configuration, temporary paths, and runtime dependencies;
- provider access to AR state, raw evidence, barriers, control data, signing
  material, and sibling operation state failed closed;
- signed network authorization allowed only the exact provider and ACP
  loopback endpoints; DNS, alternate ports, and unexpected loopback endpoints
  were rejected;
- the provider execution path did not use a generic shell.

## Rejected source revisions

Rejected revisions were retained instead of rerun:

- `d42b0e3764e317e505211c5e9500686087e4f9a3ea3e11efefcef2f9ffb8786f`
  was rejected because the final campaigns diverged on provider-accept
  projection and the legacy campaign-index contract;
- `a5ab8e8141b97c00bcbfc937814753d937d89ee3100caeb6add250631e1b7826`
  was rejected because duplicated policy wording made the positive critic fail
  `CAMPAIGN_POLICY_EXACT`.

The latter defect was fixed by one JSON-only deep-frozen campaign policy used
directly by the policy producer, critic, source audit, and frozen-pin verifier.
No calibration was repeated on either rejected pin.

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

The frozen Stage C source, campaigns, and accepted projections remain
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
