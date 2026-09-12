---
id: ADR-0020
type: adr
status: accepted
owner: architecture
summary: Additive ordinary-session execution authority, closure and scoped assembly contract.
---

# ADR-0020: Ordinary user-session Codex execution profile

Status: accepted

Date: 2026-09-12. Accepted after bounded architecture review under the owner
instruction to implement the reviewed plan and finish ordinary-session E2E.
This accepts the contract; implementation, adoption evidence and qualification
remain pending.

## Context

The existing Host Custody V1 contract cannot represent a cooperative same-user
process as physical containment. ADR-0010 remains authoritative for its existing
records, effects and immutable receipt closure. A private passive setup host is
not an active execution implementation. This additive decision covers
one macOS arm64 Codex ordinary-session vertical slice; it does not qualify it.

## Decision

### Profile, persistence and receipt closure

The trusted Host selects `user-session-v1`, effect class
`ordinary_user_session_effect`, capability manifest revision
`ordinary-codex-macos-arm64-0.153.4-v1`. These identities are immutable operation
inputs, surfaced in observations and artifact manifests. Submit cannot select
executable, profile, credentials, uid, cwd or owner ports. Host Custody remains an
explicit alternative; no default downgrade of an existing custody operation.

Persist ordinary records in an additive exact `schemaVersion: 3`,
`codecVersion: 3` envelope and payload with `executionProfile: user-session-v1`,
`effectClass: ordinary_user_session_effect` and the manifest revision above.
An ordinary-specific record branch/namespace is permitted. The exact ordinary
schema rejects extra/unknown profile and proof variants before dispatch.
Codec version 2 and historical raw V1 decoding retain their existing custody
semantics and frozen fixtures. No migration interprets missing profile fields as
ordinary. Readers ship before activation; older readers reject codec3 without
claim or launch. Rollback closes new admission and reconciles in-flight ordinary
records before removing the reader; it never replays them as V1.

Freeze the required receipt kinds: `dispatch_claim`, `provider_terminal`,
`output_drain`, `process_group_closed`, `workspace_snapshot`,
`artifact_published`, `credential_retired`, `provider_grant_settled`, and
`security_grant_settled`. Each binds `operationId`, `attemptId`, profile and
manifest identities plus its own typed observed facts: confirmed durable claim;
provider terminal status; final ordered output sequence and closed streams;
owned process/group identity and observed closure; stable inventory/source
integrity and snapshot digest; canonical immutable artifact path/digest;
retired materialization generation; and the respective owner's settled grant
identity/outcome. Final commit includes the canonical artifact digest.
The existing genuine
Provider Access receipt identity is reused, never cloned, reconstructed or cast
from a lookalike. The ordinary validator is separate from custody validators;
there is no no-op custody implementation, fake attestation or skip-containment
flag. Rejecting codec fixtures must match this set before activation and are not
inferred from the legacy envelope.

Terminal publication requires all mandatory closure evidence and a confirmed
durable commit. Unknown commit permits readback/reconciliation, never another
provider start. Missing process/output/workspace closure, credential retirement
or grant settlement means `reconcile_required`; these cannot be housekeeping.
Only deletion of already closed temporary resources may be later housekeeping
debt. That debt remains observable and prevents campaign cleanup PASS.

### Owners and public construction

Expose async `createAgentRuntimeHost(options)` through the curated
`@agent-teams/embedded-runtime/composition` export, backed by one Get Modular
Assembly root. Rename the private synchronous leaf as needed. The public facade
accepts closed Host configuration, not an arbitrary dependency bag, raw tokens or
a service locator. `createDefaultAgentRuntimeHost()` retains passive setup
compatibility and performs no login or provider turn. The public consumer uses
`bindAccess(scope)` then `containedTurn.submit/observe`; it never deep-imports.

Agent Execution owns operation policy and a consumer-owned ordinary dependency
record with exactly seven keys: `operationStore`, `security`, `providerAccess`,
`workspace`, `artifacts`, `process`, `provider`. Reuse existing operation/input/
scope/output identity invariants where semantics match; do not copy the entire
V1 lifecycle. Process lifecycle is a separately composed capability, distinct from the
Codex protocol provider (SR-AP-1). It owns reservation, one launch after confirmed
claim, child/process-group identity, bounded drain and shutdown. It does not own
account selection, DB truth, artifact publication or authorization. Domain and
application import neither Node nor provider protocol nor Assembly. Runtime
Configuration owns immutable launch configuration; workspace and artifact owners
supply observations through their existing narrow contracts.

The ordinary guarantee is cooperative cleanup of runtime-owned current-user
processes and their managed process group, not hostile same-uid containment.
No root, sudo, one-shot uid, FD8, native containment receipt or broad process-name
kill is allowed. Ownership must be established before signalling; stale PID after
restart is insufficient. Confirmed escape, open writers, unexplained source
mutation or uncertain identity yields reconciliation. Absence of an escape
signal alone is not proof that a hostile descendant could not escape.

### Provider Access and Runtime Security

Provider Access owns auth-only capture and generation/expiry authority. Its
production outbound adapter uses a private CODEX_HOME with only `auth.json`
symlinked to an explicitly selected read-only source; it neither copies source
credentials nor reads the parent token directly. Source config is excluded and
private effective config verified. Only the bounded protocol sequence
`initialize`, `config/read`, `account/read`, `getAuthStatus`,
`account/rateLimits/read`, and `model/list` with explicit bounded pagination is
admitted;
matching identity/token observations and closed helper process/stdio are required.
The materialization preserves source read-only authority, managed cleanup, TTL
and a consistent token limit of at most 4096. Trusted profile constants set a
maximum capture authority TTL of 60 seconds, helper deadline at most 15 seconds,
and turn deadline at most 45 seconds from claim bounded by the remaining PA TTL.
Startup and closure budgets must fit the remaining authority. No refresh creates
a second attempt; these values are not caller submit options.
Expiry/generation bound the captured
PA authority; they do not promise instant external revocation.

The main Codex process receives neither the user auth directory nor raw upstream
credentials. A Host-owned loopback broker mediates authorized transport with a
PA-owned captured credential. Runtime Security adds an ordinary route authority
bound to that operation/attempt/profile instead of requiring the host-custody
consumption identity. It authorizes route and egress intent; it does not select
accounts or own processes. Application authority must derive from genuine owners,
not assertions supplied by the runner. GET usage and reset-credit list reads are
networked reads, not model turns; reset redemption is outside this scope.

### Exact Codex and artifact contract

The candidate qualification tuple is macOS arm64, pinned Codex App Server
`0.153.4`, model `gpt-5.3-codex-spark`, `workspace-write`, `user-session-v1`,
`ordinary_user_session_effect`, `ordinary-codex-macos-arm64-0.153.4-v1` and the exact
binary/profile/source/artifact identities retained by the campaign. A retained
model catalog without Spark proves no Spark availability. Preflight requires
the explicit Spark request and a backend model-availability read; never insert
a fabricated model entry. Qualification remains
pending until the real authorized campaign passes.

One durable attempt allows one process launch, one new thread and one
`turn/start`. One turn may contain multiple model/tool exchanges. Disable HTTP
and SSE retries, websockets and reconnect in the exact effective configuration;
keep their counters distinct from turn count. No provider/model/account fallback,
resume or automatic retry. Use a separate exact ordinary broker recipe because
the native recipe hardcodes `gpt-5.4`. Explicit ordinary effect admission must
support actual `fileChange` and `commandExecution` evidence; the existing decoder
requires custody for those effects and must not be silently bypassed.

The P0 campaign task reads TASK.md and creates result.txt. Production captures
the declared result.txt and publishes its immutable bytes and SHA-256 after
stable workspace capture and source inventory verification. The P0 runner alone
compares canonical UTF-8 bytes `ordinary-session-ok\n` and their digest; this
expected text is not hardcoded into production for arbitrary text tasks. Content-addressed publication
and durable operation linkage precede success; a loose file is not the result.
Symlink/hardlink/path escape, unstable inventory, quota or storage failure refuses
publication or records uncertainty. Disposable campaign resources and evidence
are separate; uncertain recovery inputs remain retained.

### Scoped adoption and prior decisions

This is an additive extension to ADR-0008's public access, ADR-0009's operation
and Host shutdown boundaries, ADR-0010's capability manifest/resource containment,
immutable receipt closure and terminalization, ADR-0012's Provider Access owner
protocol, and ADR-0015's passive Assembly scope. Their accepted bytes and existing
V1 rules remain unchanged. Ordinary receipt closure never proves
`contained_unmediated_effect`. ADR-0016 remains proposed pending its legacy scope.

Before activation, record the ordinary composition declaration/profile/factory
paths, lifecycle owner, dependency slots and FMS scope in executable consumer
profiles. Reject unknown boundaries, new direct legacy edges, incorrect tokens or
slots, missing async await, preparation effects and fake custody receipts. Keep
one production composition authority with independent binding parity, Host
failure/cancellation ownership and a packed public consumer test. Private feature
helpers are not separate graph nodes. These gates must execute in fast/full
checks; this ADR does not declare unimplemented ordinary adoption active.

The reviewed Consumer Module Standard pin is
`714d6194afd24e0bb4375f4d38e2422c892ad021`, complete-document SHA-256
`63bbf8f6e0c92a74116bce40ac96e4fc5f1c4ed3d28325be79b5c75448a23bc3`.
The five example-link relocations are retained in
`architecture/get-modular/evidence/ordinary-session-pin-delta.diff`; review and
migration status are in the sibling `ordinary-session-pin-review.json`.
[Current adoption guidance](../architecture/get-modular-adoption.md) and
`architecture/get-modular/consumer-profile.json` preserve passive-only acceptance.

## Consequences

Stage A accepts the bounded contract, not production readiness. Implementation
must deliver exact ordinary codec/receipt fixtures, scoped FMS and Assembly
profiles, reader compatibility and rejecting enforcement before activation.
Offline synthetic 0.153.4 auth/config and transport-fault experiments establish
protocol compatibility only; they establish neither current-user authorization
nor model availability. No live evidence is fabricated or promoted by this ADR.

The prior P0 is closed FAIL with zero provider attempts. Only a new authorized
campaign may consume the separately authorized single attempt after preflight.
A durable exclusive marker, canonical public consumer, durable readback, exact
artifact bytes/digest, source integrity and complete cleanup evidence are required.
FAIL/UNKNOWN ends that campaign without retry; it does not satisfy successful E2E.
