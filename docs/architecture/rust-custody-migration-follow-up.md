---
id: runtime.architecture.rust-custody-migration-follow-up
type: architecture
status: active
owner: architecture
summary: Records the deferred Rust Host Custody migration discussion, research conclusions and decision points outside PR69.
---

# Rust custody migration follow-up

## Purpose

**TODO: discuss and plan the Rust Host Custody migration as separate work after
PR #69.** The owner explicitly deferred the migration on 2026-09-06 after reviewing
its estimated size. This supersedes the brief same-day instruction to start the
migration inside PR #69. No Rust migration implementation was started.

PR #69 continues against its original TypeScript/Node/Docker implementation and
original acceptance criteria. This follow-up adds no release gate, task weight,
or code-readiness denominator to that delivery. The document is an active backlog
record, not an accepted implementation ADR or a production qualification claim.

## Ownership boundary

The research recommendation is a **host-side Rust keeper plus an in-container
Rust custody-init**, with TypeScript retaining provider SDKs, operation authority,
Provider Access, Runtime Security policy, and HTTP/TLS behavior. This means moving
all technical custody ownership, not rewriting the whole runtime.

| Responsibility | Proposed owner |
| --- | --- |
| Process spawn/wait/reap, signals, raw pipes and byte accounting | Rust init/native runner |
| Docker lifecycle, exact cgroup/namespace resources and route enforcement | Rust keeper |
| Technical resource journal, crash cleanup and retained observations | Rust keeper |
| Operation state, committed claims, receipts, PostgreSQL | Existing TypeScript owners |
| Official Claude Agent SDK and Codex protocol mapping | TypeScript provider adapters |
| Account selection, credential authority, invocation/egress policy | TypeScript PA/RS |
| HTTP/TLS, provider request/response streaming | Existing TypeScript broker behavior |
| Workspace/artifact semantics and publication | Existing filesystem/artifact owners |

Replacing only Node custody-init would leave host-side ownership and crash
windows in the current implementation. The proposed boundary therefore moves
one complete resource lifecycle at a time. Docker remains the selected Linux
containment mechanism; Rust does not imply removing Docker.

## Discussion TODO

- [ ] Confirm the target boundary, smallest coherent vertical slice and delivery
  order separately from PR #69. Prefer per-attempt keeper over a host-wide daemon
  unless a concrete requirement proves that daemon necessary.
- [ ] Settle keeper/init/provider identities and minimum privileges. The proposed
  separate trusted init identity may change today's non-root, `CapDrop: ALL`
  recipe; it needs its own reviewed profile and fresh qualification.
- [ ] Specify private IPC, actual inherited descriptors, immutable launch
  authorization, lost-ack behavior and exactly-one effect owner. A serialized
  nonce or FD number alone grants no native authority.
- [ ] Distinguish bytes accepted by the custody transport from bytes accepted by
  the provider pipe. Preserve partial writes and unknown effects without replay.
- [ ] Specify autonomous deadlines, TS/keeper/init crashes and stalls, output
  backpressure, stop-tail, durable journal transitions and cleanup-only recovery.
- [ ] Decide whether the existing TS broker needs a per-attempt child process so
  keeper can close its sockets independently of a stalled controller.
- [ ] Verify official Claude SDK's synchronous spawn callback against the async
  native bridge, including early writes, cancellation and event ordering.
- [ ] Audit reusable Rust spike primitives and remove fixture/witness assumptions.
  Check available pinned toolchain/dependencies before choosing implementation.
- [ ] Preserve legacy journal cleanup and binary ownership. Cutover and rollback
  select an implementation for new attempts only, never transfer live handles by
  changing a flag.
- [ ] Define packaging and exact binary/protocol/OS/profile evidence; qualify
  Linux Codex/Claude and cooperative macOS before any production promotion.

## Estimate and research boundary

Hosted independent research inspected source commit
`287bef1da5505681dfee8bd486f07bca3c5bbcf0` on 2026-09-06. It did not run builds,
tests, provider actions or installations. Later PR69 fixes are not covered by
that inventory and must be re-read when this follow-up starts.

The recommended whole-custody transfer was estimated at **8,000-13,000 new or
substantially reworked production lines**, **10,000-18,000 test lines**, and
**10,000-16,000 removed lines**. These are separate ranges, not additive net LOC
or a delivery commitment. Estimate confidence is roughly 6/10. A first coherent
Linux synthetic slice was estimated at 3,000-5,000 production and 4,000-7,000 test
lines within those totals. Re-estimate from the then-current source before
implementation; do not use this estimate in PR69 progress calculations.

## Invariants

Keep the existing seven-port boundary and official SDKs. Rust emits technical
observations; TypeScript retains business truth. Root exit, pipe EOF, container
absence, recursive emptiness and output delivery remain distinct evidence.
Missing identity or acknowledgement remains uncertainty. Exactly one owner
mutates each live resource generation, with no dual execution or automatic
fallback. All qualification uses new disposable projects. macOS remains
cooperative; Windows production, Desktop updater and a general public RPC/SDK
are outside this proposal.

## Related documentation

- [Current V1 delivery plan](contained-agent-turn-v1-delivery-plan.md#phase-3-production-host-custody)
  remains the authority for PR #69.
- [Rust production gates](../spikes/rust-system-boundaries-production-gates.md)
  distinguish spike evidence from production readiness.
- [Rust spike and workspace](../../experiments/rust-system-boundaries/README.md)
  contain the current supervisor/guardian prototypes.
- [ADR-0009](../decisions/0009-contained-turn-private-access-and-host-shutdown-boundary.md)
  defines the existing Host shutdown and private access boundary.
- [ADR-0010](../decisions/0010-contained-agent-turn-v1-operation-authority.md)
  preserves operation authority and receipt semantics.
- [Architecture foundation](architecture-foundation.md) governs ownership and
  dependency placement; the research does not supersede it.
