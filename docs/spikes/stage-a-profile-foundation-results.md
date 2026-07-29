# Stage A profile foundation results

Status: decision-grade architecture evidence with scoped partials

Date: 2026-07-26

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

## Method

Each lane used:

1. an isolated hosting scratch directory;
2. a producer-built falsification harness;
3. a controller rerun from the documented command;
4. an independent adversarial review of source, tests, raw result, and report;
5. a hardening round against the critic's concrete counterexamples;
6. another controller rerun.

No real user project, credential, provider/model request, or canonical-worktree
edit was used.

Canonical baseline remained:

```text
HEAD a5bb574296eeee4aedc33905f9bb72f37457d7fa
status sha256 2fe72119a1df8cb1b86ecfa2556c4d1fd6df14bd663c8795c0ebbb7309dc33c9
```

## Final controller runs

| Lane | Run | Result | Evidence |
| --- | --- | --- | --- |
| composition hardening | `stage-a-composition-hardening-2026-07-26T17-25-23-894Z` | 9 pass, 1 partial, 0 fail | 14 tests, 17,081 assertions, deterministic digest |
| ingestion hardening | `2026-07-26T17-25-58.931Z` | 8 pass, 3 partial, 0 fail | 173 assertions, no provider-controlled network/process/filesystem side effects |
| freshness hardening | `2026-07-26T17-21-41.506Z` | 11 pass, 2 partial, 0 fail | 65 cases, 2,007 pairs, 292 same-dimension cases, 548 malformed/unknown inputs |

Scratch evidence:

```text
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/stage-a-composition
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/stage-a-ingestion
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/stage-a-freshness
```

## Composition

Confirmed:

- `absent`, `set`, and explicit provider-default `reset`;
- `upsert`, `disable`, `remove`, and explicit re-add;
- disabling a provider-default resource without a fake local definition;
- composite ordering without a global ordinal allocator;
- retry deduplication and payload conflicts;
- typed namespaced resources without an executable `JsonValue` escape;
- separate ACP and non-ACP provider packages using only the public descriptor
  contract;
- duplicate provider IDs, namespace spoofing, and incomplete classification
  fail closed;
- separate audit and effective semantic digests with a pinned canonicalization
  version;
- live policy, grants, credentials, routes, and authorization do not affect
  profile digests.

Falsified:

- stable sort can resolve equal ordinals safely;
- a parallel generic `extensions[]` bag is harmless;
- arbitrary provider keys can become canonical IDs automatically;
- provider registration proves compiler trust.

Scoped partial:

- persisted concurrent source publication is not tested;
- canonicalization has only a TypeScript implementation;
- package signatures and a real plugin loader are not tested;
- synthetic providers do not prove real provider compiler correctness.

## Passive ingestion

Confirmed:

- hosted AR accepts strict manifest bytes and content-addressed blobs, never
  client filesystem paths or trusted archive extraction;
- `SourceAccessAuthorization` and `CollectorBundleAttestation` are separate;
- attestation binds exact bundle bytes, provenance, collector, host, epoch,
  tenant, platform, and canonicalization version;
- inbound decoding produces inert deeply frozen plain data;
- Proxy/getter/class/typed-subclass, duplicate JSON keys, malformed UTF-8, and
  hostile declarations fail before domain use;
- publication validates in an expiring staging namespace and exposes no partial
  snapshot after failure;
- failure records a typed garbage-collection intent;
- logical paths and target-platform materialization paths have separate
  policies;
- brokered artifact-store transport is distinct from provider/user-controlled
  side effects.

The hardening round found an additional JavaScript edge case: Promise
resolution may read `.then` on a returned Proxy before an application-level
brand check. Therefore the blob source is a trusted outbound port and must
return owned bytes, not arbitrary objects across an async boundary.

Scoped partial:

- a finite Windows/macOS corpus cannot prove complete NTFS/APFS behavior;
- generic scanning cannot detect every disguised secret;
- a Linux harness cannot prove a secure macOS/Windows Desktop collector.

## Review and freshness

Confirmed:

- strict decoding fails closed for all tested unknown/malformed states;
- an independent versioned decision table acts as the test oracle;
- implementation does not import expected outcomes;
- every valid enum variant has explicit coverage;
- the review fingerprint ignores display labels and binds stable semantics and
  risk boundaries;
- equivalent credential refresh rebinds without review;
- semantic account, route, billing, data, capability, or workspace changes
  require review;
- invalid authority or digest hard-blocks;
- reproducible host/compiler/materializer/dependency drift reparses or
  rematerializes instead of launching ambient state;
- same-dimension conflicts use owner revision and hard-block ambiguous equal
  revisions;
- diagnostics remain causal and redact unknown raw values;
- SDK contract simulations never issue an interactive prompt.

The hardening round falsified the assumption that all pairwise mutations are
independent. Credential, route, capability-set, and target-host are atomic
consistency dimensions.

Scoped partial:

- provider/security adapters still need to prove semantic equivalence;
- clock source and tolerated skew are not decided;
- surface parity is a contract simulation, not IPC/Connect proof;
- synthetic traces are not a human usability study.

## Readiness conclusion

The pure Runtime Configuration domain kernel may start.

Do not start:

- hosted ingestion persistence before durable staging/publication conformance;
- `Latest local setup` collection before platform-native collector evidence;
- public cross-language contracts before canonicalization conformance;
- Agent Execution, credential custody, or provider-host lifecycle before Stage B
  crash, revocation, fencing, bootstrap, and credential-generation spikes.
