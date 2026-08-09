# Architecture qualification and readiness

Status: current qualification register, not a production-readiness claim

The canonical domain, dependency, and package-identity decisions are in
ADR-0001, ADR-0002, ADR-0003, ADR-0004, and ADR-0005. Proposed ADR-0006 must be
accepted before the first Agent Execution operation/effect-ledger slice.
Evidence promotion is in `architecture/evidence-traceability.md`. Exact scoped
target matches and evidence hashes are in
`architecture/qualification-registry.json`. This document owns the mutable list
of qualified scope and remaining gates.

Registry matching is over an indivisible observed eight-field tuple. In
particular, storage and transport topology tokens name the complete observed
topology rather than reusable hops. Evidence for two binaries, protocols, or
adapters creates explicit tuples only; it never authorizes their Cartesian
product.

## Status vocabulary

- `foundation accepted`: ownership and contracts may be implemented.
- `scoped qualified`: the named revision/platform/scenario passed its retained
  evidence campaign.
- `implementation qualified`: production code and adapters pass contract,
  migration, recovery, and boundary tests.
- `deployment qualified`: the exact release topology passes operational,
  security, upgrade, rollback, and disaster-recovery gates.

No current domain slice is `implementation qualified`. No current target is
`deployment qualified`.

## Cross-cutting authority invariants

Foundation accepted:

- caller, provider, event, and adapter timestamps are observations, never the
  authority for expiry, lease, TTL, retention, or garbage collection;
- time-sensitive consumers receive one read-only `MonotonicTimeView`; only a
  private startup/anchor capability may restore or advance its durable
  high-water state;
- authority-bearing heads, tombstones, leases, roots, assignments,
  reservations, fences, and journals remain private and are exposed only as
  detached immutable snapshots;
- mutations require an owner capability plus expected revision, generation,
  fence, or semantic fingerprint;
- terminal replay returns current authority meaning and cannot recreate state
  after release, expiry, collection, or fencing.

Scoped qualified:

- PostgreSQL-backed capacity time survived process restart in Stage K;
- loopback gateway startup/restart, read-only time, expiry, TTL, rotation and
  revocation paths passed in Stage M;
- deterministic binary lifecycle, assignment-root, tombstone, GC, replay and
  mixed-composition negatives passed in Stage N.

Remaining before implementation qualification:

- production durable anchor storage, signing/KMS custody, startup ordering,
  restore authorization and rollback recovery;
- database-backed concurrent implementations proving private-state and
  terminal-replay semantics at adapter boundaries;
- multi-controller and multi-host rollback, partition and stale-anchor tests.
- adversarial cross-tenant and cross-workspace substitution, confused-deputy,
  enumeration and leakage tests across repositories/queries, profile and
  account bindings, artifact staging/CAS/GC, caches and idempotency journals,
  launch tickets/manifests, provider-state namespaces, host reuse,
  transcripts/output/events/logs, and every enabled adapter.

## Profiles, settings, and environment

Foundation accepted:

- immutable `ProfileRevision` and provider-specific `CompiledProfilePlan`;
- Runtime Configuration-owned source precedence, immutable resolved bindings,
  tombstones, provenance, and semantic digests;
- separate profile, policy, credential, route, capacity, and execution owners;
- signed, host-bound, replay-protected `EffectiveActivationManifest`;
- default-deny typed `EnvironmentProjection` with immutable non-secret value
  custody and opaque secret bindings;
- explicit instruction composition algebra and immutable snapshots;
- target-platform canonicalization before collision detection;
- no ambient reread by a pinned session.

Scoped qualified:

- synthetic deterministic source precedence over 5,000 randomized input
  permutations per final campaign;
- the nine-case remove/disable/upsert truth table and instruction
  append/replace/reset/disable algebra over 3,000 randomized permutations;
- synthetic immutable environment-value custody, unknown-key rejection,
  Windows/Unicode collision negatives, and no newest-head fallback;
- fail-closed completeness checks for the versioned provider-extension
  classifier contract.

Remaining before implementation qualification:

- real Claude, Codex, and OpenCode semantic classifiers for every supported
  profile resource and binary revision;
- provider-by-provider mapping tests for global, workspace, explicit, and
  provider-default settings, including the normative
  reset/disable/remove/re-enable truth table;
- instruction append/replace/reset/disable ordering, conflict, deduplication,
  and byte/token-budget fixtures;
- golden contract fixtures proving exact environment keys, precedence,
  immutable value bytes/references, digest verification, provenance,
  secret-binding references, and unknown-key rejection;
- mutable-profile-head races proving review and activation use only resolved
  immutable revision IDs and semantic digests;
- concurrent launch-ticket consume/start, identical and conflicting replay,
  worker-custody loss, preallocated-host reconciliation, worker crash, and
  unknown-commit tests proving a single materialization executor;
- secure platform-native Desktop collectors and target-filesystem
  canonicalization for each supported OS/filesystem, including case, Unicode,
  Windows environment-key aliases, ADS, device-name, and trailing-dot
  collisions;
- cross-language canonicalization before public non-TypeScript contracts;
- stale-review and manifest-delta UX tests.

## Provider access and key custody

Scoped qualified:

- disposable OpenCode OAuth behavior;
- synthetic credential generation/CAS and cleanup behavior;
- disposable macOS file-backed Keychain characteristics.

Remaining:

- dedicated non-user Codex, Claude, and OpenCode accounts and routes;
- production credential import, refresh fencing, and `CredentialBinding`-owned
  generation CAS, including concurrent refresh/revoke races;
- signed Data Protection Keychain helper and provisioning-authorized access
  groups;
- production `KeyProvider`, rotation, crypto-erasure, backup invalidation,
  external KMS/off-host trust anchor, reboot and locked-session behavior.

## Execution, tools, and child agents

Foundation accepted:

- Agent Execution-owned invocation scope, adapter-normalized provider request,
  and Security-owned authorization context are separate;
- typed resource claims are policy input; semantic digests are identity, not
  a substitute for path, destination, process, child, or credential scope;
- authorization, stateful admission, and dispatch claim are separate steps;
- admission is idempotent by AR-owned invocation-attempt identity and dispatch
  revalidates authority, expiry, constraints, capacity, cancellation, and
  fence;
- mediated provider paths require a qualified authoritative interceptor or
  AR-owned enforcing broker/sandbox; contained-unmediated turns use an
  explicit coarse receipt and never claim individual effect evidence;
- semantic `EffectId` survives retries, controller failover, reconciliation,
  and successor generations;
- only success requires a proven drain barrier; uncertain drain or transport
  enters `reconcile_required`;
- child operations explicitly join the parent or complete a fenced
  offered/accepted/effective custody handoff;
- cross-revision transcript resume is exact-compatible or explicitly migrated,
  never best effort.

Scoped qualified:

- AR-owned operation/command identity, effect-ledger counterexamples, output
  drain, direct stdio cancellation, and same-host two-process background
  overlap;
- provider-neutral rule that provider status and IDs are observations;
- scoped child authorization mapping and duplicate-launch counterexamples;
- single-host PostgreSQL CAS races and client kill-after-commit for launch
  ticket, admission/dispatch, semantic effect, child handoff, and exact
  capability-specific receipt barriers.

Remaining:

- production implementation of authorization, admission and dispatch-claim
  ports, command/effect ledger, effect receipts, child-operation state,
  custody transfer, cancellation fan-out, and transcript envelopes;
- one authoritative-interceptor conformance suite for every enabled
  provider/binary effect path; Codex shell, patch, and MCP plus OpenCode ACP
  and native tool paths are separate qualification rows;
- contained-unmediated scope, containment-receipt, required-receipt-set, and
  terminal-barrier tests;
- spoofed/corrupted provider owner IDs proving adapters cannot replace trusted
  invocation scope;
- duplicate/multi-hook admission tests proving one budget/capacity claim,
  exact replay idempotency, and fingerprint-conflict rejection;
- queued authorization expiry/revocation races and dispatch-CAS tests;
- semantic effect identity conflicts across controller and successor
  generations, provider acceptance uncertainty, and no-blind-retry tests;
- joined-child terminal barrier, transfer offer/accept/effective races,
  accepted-claim expiry/revocation, composite-token mismatch, unknown handoff
  commit, single-owner fencing, and detached-child failure tests;
- transcript exact/migrate/read-only/incompatible fixtures, including partial
  subkey trees and mixed codec revisions;
- remote tool-host crash, reconnect, partition, replay, malformed/flooded
  frames, committed-effect reconciliation, and detached descendants;
- bounded concurrency, queue fairness, tenant limits, backpressure, duplicate
  launch control, and long-duration stream/queue soak;
- hook-host crash/replay and parked-approval timeout policy.

## Capacity and control-plane scaling

Foundation accepted:

- `ExecutionCapacityPort` remains an Agent Execution application port in v1;
- reservation identity, fence, expiry, heartbeat, queue, fairness, overload,
  reclaim, and reconciliation are explicit contract concerns;
- Agent Execution owns renewal monitoring; lease loss cuts off dispatch,
  effects, and canonical output before containment/reconciliation;
- an exclusive slot is not re-granted before stale-host fencing is proved or
  the slot is quarantined.

Scoped qualified:

- single-host PostgreSQL renewal CAS, unknown renewal response, lease-loss
  authority cutoff, stale-output rejection, reclaim-pending barrier, and
  explicit successor generation.
- Stage K single-host PostgreSQL capacity campaigns: 32 concurrent claims for
  eight slots, exact claim/quota/output/reclaim replay, non-preemptive quota
  shrink, overload bounds, reclaim acknowledgement before successor fencing,
  authoritative time, restart persistence, cleanup, and a 300-grant equal-
  tenant soak;
- finite fairness only under the documented fixed-tenant, persistent-
  eligibility and finite-older-set assumptions; unbounded strict priority is
  not an accepted default.

Remaining:

- production allocator/adapter and lease-monitor implementation with real
  workers, containment acknowledgement, quarantine, crash-safe reclaim and
  observability;
- multi-controller and multi-host admission/renewal, allocator failover,
  asymmetric partition, dynamic quota/workload policy and long-duration
  backpressure/fairness soak.

## Persistence, contracts, and service extraction

Scoped qualified:

- PostgreSQL command idempotency, fencing, outbox/inbox, process crash,
  same-server logical restore, and two-physical-host client link loss;
- dedicated loopback ext4 ENOSPC with state/outbox rollback, emergency-reserve
  recovery, PostgreSQL `SIGKILL`, checksum-corruption detection, and
  same-host restore verified by semantic projection and `pg_amcheck`;
- local Connect timeout, cursor replay, slow-consumer, cleanup, and GOAWAY.
- experimental PostgreSQL consumer-first v1/v2 event compatibility,
  deterministic upcast, poison quarantine with later progress, inbox replay,
  event retirement, active-binary contract gate, backfill, and single migration
  claim.
- Stage L synthetic same-host three-node PostgreSQL 18.4 streaming-replication
  campaigns: `remote_apply` visibility, exact replay after unknown commit,
  quorum-loss reconciliation, old-primary process/client-route fencing before
  promotion, durable authority advance, stale-output rejection, `pg_rewind`,
  least-privilege replication identities and streaming on the new timeline;
- the retained split-brain negative proved that database epoch and uniqueness
  constraints do not fence two disconnected writable primaries. Replication is
  not authority; promotion requires an external fence of the old writer and
  client route.

Remaining:

- package-boundary and forbidden-import CI in production code;
- independent schema/migration ownership and contract tests;
- production rolling old/new binaries, upcasters, poison-message operations,
  event retirement, expand/backfill/contract migrations, and rollback tests;
- production HA manager and external fencing/STONITH, physical independent
  hosts/failure domains, delay, packet loss, asymmetric partition, repeated
  failover/rejoin, connection-pool behavior, PITR, backup/restore and measured
  RPO/RTO;
- external TLS/proxy/load-balancer/service-mesh and deployment-drain
  conformance;
- production storage watermark/reserve custody and admission integration;
- browser/mobile/generated SDK parity and production cursor retention/key
  rotation.

No context is `service-ready` until these implementation and remote-adapter
contracts pass. Current boundaries are service-extraction constraints, not
proof of effortless extraction.

## Platform containment and binary policy

Scoped feasibility evidence, not production qualification:

- Rust Local Supervisor and Execution Guardian passed the synthetic
  Linux/macOS/Windows boundary matrix on `main@aa76858`; the immutable source
  and run references are recorded in
  `experiments/rust-system-boundaries/evidence/main-aa76858-evidence.json`;
- the same revision has a trusted-main GitHub/Sigstore provenance attestation
  for its non-production evidence archive;
- `SPIKE PROVEN` does not imply `PRODUCTION QUALIFIED`;
  `PRODUCTION GATE OPEN` applies to every gate in
  `docs/spikes/rust-system-boundaries-production-gates.md`.

Scoped qualified:

- synthetic Linux non-root container/cgroup custody and application gateway;
- synthetic loopback HTTP/1 pre-dispatch request bounds, pre/post-header
  response bounds, timeout classification, cancellation propagation,
  backpressure, and concurrent receipt isolation;
- scoped Apple Silicon process, APFS, storage, backup/corruption, native and
  Rosetta pairs;
- scoped immutable OpenCode binary/helper/config closure.
- Stage M signed immutable egress policy and dispatch authorization on
  synthetic loopback HTTP/1.1 and HTTP/2: independent address classification,
  route/address/TLS/peer/redirect/time binding, final pre-byte reauthorization,
  queued rotation/revocation/expiry denial, closed/quarantined pooled
  transports, and complete raw-preimage digest verification;
- Stage N deterministic complete `BinaryRevision` closure identity,
  exact/migratable/read-only/incompatible transcript outcomes, activation-head
  CAS, session pinning, assignment lease/root lifecycle, drain, rollback,
  retention, tombstone/GC, private state and terminal replay without
  resurrection.

Remaining:

- Linux production signed-gateway loading, public-PKI DNS/rebinding, kernel and
  container/VM egress bypass resistance, external proxy/load-balancer,
  HTTP/2/HTTP/3 as enabled, real provider/SDK streaming, daemon custody,
  image-signature policy, init/zombie behavior and supported version matrix;
- macOS endpoint-specific network enforcement, continuous descendant custody,
  real isolated-provider parity, physical power loss, supported version
  policy, and physical Intel if supported;
- Windows Job Object plus filesystem/network/storage containment;
- production artifact store, signature/KMS custody, provenance/corruption
  handling, real provider binaries and worker fleet, plus revision-by-revision
  binary/helper/adapter-contract/normalizer/interceptor/projector/codec rollout,
  rollback, drain, compatibility, retention, GC and deprecation policy;
- off-host backup/restore and physical corruption/power-loss campaigns.

## Hosted tenancy and tenant retirement

Foundation accepted:

- single-user, multi-user, dedicated single-tenant hosted, and shared
  multi-tenant hosted are different deployment scopes;
- the domain remains tenant-scoped even when the first hosted deployment is
  dedicated single-tenant;
- internal `TenantId` values are opaque, globally unique, and never reused;
- AR is a participant, not the product owner, of tenant/account lifecycle,
  legal hold, export, and compliance policy;
- each bounded context owns disposition of its data; cross-context deletion
  SQL or a universal deletion repository is forbidden;
- full tenant retirement is deferred, but storage ownership and
  resurrection-prevention cannot be designed away.

Remaining before a dedicated hosted tenant can claim retirement:

- complete versioned inventory of stores, backups, logs, external sinks,
  provider state, worker residue, and keys;
- verified destruction of its complete deployment, storage namespace, worker
  residue, provider state where supported, and key namespace;
- backup/restore policy and evidence that retired authority cannot be reopened;
- honest `unsupported` or `unknown` results for external provider deletion.

Remaining before shared multi-tenant retirement qualification:

- versioned data inventory for every table, object namespace, cache, journal,
  DLQ, provider-state path, transcript, output, log, backup, and key;
- idempotent owner-local disposition commands and receipts;
- concurrent write/freeze, stale-region, offline-worker, CAS/GC, provider
  timeout, and restore-resurrection campaigns;
- legal-hold, export, backup retention, object-version, and cryptographic
  erasure policy when the product promises those capabilities;
- cross-tenant proof that deleting one tenant cannot delete, reveal, or provide
  an existence oracle for another tenant's data.

No tenant-retirement path is currently implementation or deployment qualified.

## Reconciliation and operator controls

Foundation accepted:

- reconciliation is owner-local domain correctness; no central reconciliation
  bounded context owns or assigns another aggregate's truth;
- Agent Execution owns operation, semantic-effect, authority, host,
  containment, output, and terminal-barrier reconciliation;
- a shared Operator Case projection is rebuildable and read-only;
- projections contain only redacted summaries, opaque owner references, and
  digests, never raw evidence, user content, secrets, private fences, or
  internal generation identities;
- `reconcile_required` is durable and nonterminal;
- `outcome_indeterminate` is a distinct truthful terminal result allowed only
  after cutoff, output fencing, containment assurance, exact closure receipts,
  and permanent no-retry tombstones;
- provider adapters publish typed observations and capability manifests, while
  the owner evaluates evidence through a pinned policy revision;
- only a qualified authoritative-negative observation can prove
  `known_not_accepted` and authorize a successor attempt;
- there are no generic force-outcome/retry commands or direct operator SQL;
- operator commands are typed, revision-bound, evidence-bound, idempotent, and
  recorded with owner state, a local audit receipt, and outbox atomically;
- break-glass is a separate emergency channel limited to authority-reducing
  fence, revoke, stop, quarantine, and admission-disable actions;
- operation cutoff, session cutoff, runtime-scope suspension, and scope
  disposition have separate consistency boundaries;
- admission fencing, canonical-output fencing, provider containment, and
  effect reconciliation are orthogonal authoritative dimensions;
- technically `not_required` containment requires exact qualified operation
  capabilities plus receipt evidence; product policy may strengthen but never
  weaken the technical requirement;
- AR blocks exact operation, effect, and opaque external-effect identities but
  does not infer business-effect equivalence between different identities;
- scope disposition executes an immutable normalized technical plan with one
  effective action per category, deterministic ordering, exact receipts, and
  cryptographic erasure only for a proven exclusive key scope.

Remaining before implementation qualification:

- state, effect-ledger, terminal-requirement, evidence, command, capability,
  audit, and projection contracts plus migrations;
- property tests for all terminal and forbidden transitions;
- concurrent claims, lost response after commit, exact replay, stale
  revision/generation/fence, reordered inbox/outbox, conflicting evidence, and
  tombstone restore tests;
- tenant, target, audience, proposal, and evidence-digest substitution;
- capability replay/expiry/key-revocation/clock-rollback, approver
  separation-of-duty, audit-unavailable, and partitioned-writer negatives;
- deterministic Operator Case rebuild and proof that projection lag cannot
  authorize mutation;
- target-specific cutoff commands, typed predecessor-barrier evidence, durable
  receipt query/feed contracts, pre-materialization dispatch-prevention guards,
  and normalized disposition-plan contracts;
- ADR-0003 conformance cases for target races, delayed output, policy-only
  containment, external-effect identity, scope fan-out, disposition ordering,
  key-scope proof, and restore resurrection;
- ADR-0004 conformance cases for pre-materialization prevention, negative-guard
  retention and restore, dispatch ordering, and automated external-effect
  identity enforcement.

Remaining before dedicated hosted single-tenant operation:

- real reconciliation probes and capability manifests for every enabled
  provider/binary pair;
- operator API, normal JIT capability issuance, local and off-host immutable
  audit, and production descendant containment;
- lost-response, provider-retention, late-output, KMS, identity, and audit-sink
  outage drills;
- minimal safe-direction break-glass.

Remaining before shared multi-tenant operation:

- tenant scope and support-role redaction in every evidence, journal,
  projection, query, cache, artifact, output, log, and operator capability;
- RBAC plus resource/policy attributes, dual control for high-risk recovery,
  per-tenant queues/limits, and cross-tenant substitution/leakage campaigns.

Remaining before multi-host operation:

- independent external fencing of stale database, controller, worker, and
  client routes;
- physical-host asymmetric partition and stale-primary campaigns;
- globally consistent capability consumption, off-host audit recovery, and
  restore/PITR/failover drills;
- a qualified hardware-backed offline containment issuer only if the operating
  model requires emergency action while normal identity/KMS control is down.

No provider-specific reconciliation or break-glass path is currently
implementation or deployment qualified.

## Release rule

A release claim names the exact provider adapter, binary closure, platform,
credential route, storage topology, transport topology, and qualified failure
domains. Passing another row or a synthetic adapter never fills an unnamed
dimension. A shared multi-tenant release additionally requires the
cross-tenant isolation gate for every enabled storage, cache, artifact,
provider-state, execution, transcript, output, event, logging, projection,
operator, and adapter path.
