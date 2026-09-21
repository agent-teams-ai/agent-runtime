---
id: runtime.architecture.capacity-admission-delivery-plan
type: architecture
status: active
owner: architecture
summary: Defines bounded admission, fair scheduling and recovery acceptance for the follow-up capacity slice.
---

# Capacity Admission Delivery Plan

## Purpose

Turn the accepted capacity contract and Stage K experimental evidence into a
bounded production follow-up. This plan is active planning guidance, not a
claim that the allocator or its production qualification exists. It does not
extend the current contained-turn V1 seven-port delivery or block PR #69.

Owner priority recorded on 2026-09-21: earn an early product advantage through
observable reliability and predictable behavior, even with fewer features.
Demonstrate guarantees with acceptance tests; documentation alone is not proof
of superiority over a reference product.

Authority remains [ADR-0001](../decisions/0001-runtime-profile-and-activation-boundaries.md).
[Stage K](../spikes/stage-k-capacity-fairness-results.md) already covers bounded
admission, a priority burst of three followed by a FIFO escape, equal-tenant
fairness, replay, lease loss and fenced reclaim in a single-host PostgreSQL
model. It did not launch real workers. The remaining work is integration,
complete bounds, policy precision and qualification under real contention.

## Ownership boundary

- Agent Execution owns admission intent, reservation binding, lease monitoring,
  execution cutoff and reconciliation through its `ExecutionCapacityPort`.
- The capacity adapter owns resource-pool truth and the allocator lease.
  Runtime Security owns authorized workspace and capability scope.
- Orchestrator owns business priority, teams, dependencies and continuation.
  AR receives an authorized technical workload class and cannot infer product
  priority from prompt text or accept arbitrary caller escalation.
- Get Modular owns composition checks. Extension Foundation owns extension
  contracts, not scheduling product work. Engineering Foundation owns shared
  architectural checks. None becomes a second capacity authority.

The shared-first choice is a narrow owner contract plus portable conformance
fixtures. Keep tenant policy, storage, worker supervision and orchestration in
their owners. Extract a shared deterministic policy kernel only when actual
scopes demonstrate identical semantics; no universal queue manager or lease.

Before production implementation, reconcile this follow-up with the latest
accepted delivery scope and pinned FMS/CMS profiles. Materialize the capacity
port only in an explicitly accepted next slice; do not silently add an eighth
V1 port or an unclassified composition boundary. Accepted ADR bytes stay intact.

## Execution shape

Prefer an asynchronous owner-local queue backed by the existing PostgreSQL
transaction boundary, with a bounded dispatcher and explicit reservation CAS.
The receipt distinguishes `queued`, `granted`, `rejected`, `expired`, `released`
and `reconcile_required`. Acknowledging admission does not mean execution began.

Commands request state changes. Events report committed facts through existing
outbox/inbox boundaries. A wake-up event is a delivery hint, not queue truth;
after lost or duplicate notifications, bounded polling recovers durable work.
Do not require event sourcing, a new broker or a microservice for this slice.
NATS belongs to the appropriate consumer transport adapter, not the AR domain.

An external broker or separate allocator is a later deployment choice justified
by measured load, independent scaling or a separate failure boundary. It must
preserve the same admission, fairness and reclaim contract. Broker depth limits
alone do not bound ingress buffers, prevent starvation or make retries safe.

## Invariants

### Admission and whole-path bounds

1. Atomically decide capacity and persist the queue entry, quota accounting,
   immutable policy revision and idempotent receipt. Concurrent controllers
   cannot each observe spare quota and over-admit. Reject before retaining an
   unbounded payload; ingress has bounded request size and concurrency too.
2. Name separate limits for pending count and bytes, active resource vectors,
   global and tenant scopes, and applicable provider/pool budgets. Record
   payload references rather than closures retaining large object graphs.
   Staging, retries, event delivery and output buffering also need explicit
   bounds; moving a backlog elsewhere is not backpressure.
3. Exact retry uses the same command identity and semantic fingerprint. Return
   its original current-meaning receipt before consuming a new queue slot.
   Changed meaning under the same identity is a conflict, not another attempt.
4. Cancellation and expiry release pending accounting exactly once. Accepted
   active work still follows containment/reclaim; deleting a queue row cannot
   prove a process stopped. Expired work is pruned before admission accounting.
5. Overload returns a typed reason and bounded retry guidance. New admission
   must not proceed from a stale in-memory quota snapshot during store failure.
   Unknown commit is reconciled by original identity before resubmission.

Grant is an affected-row-checked `queued -> granted` transition against the
current revision, cancellation guard, expiry and applicable fence in the same
transaction as pending-to-active accounting. If cancel/expiry wins, no grant,
lease or active debit is created. If grant wins, cancellation follows the
active cutoff/containment/reclaim path; it cannot delete pending accounting as
if work were still queued. Reconcile an unknown commit under the original
identity. Tests assert the reservation state, lease and resource vector as
well as counters.

Prunable queue/payload rows are distinct from command receipts and lifecycle
tombstones. Terminalize receipts on release, expiry or fencing; replay cannot
restore authority. C0 must name the full retry, restore, provider-replay and
resurrection-prevention horizon from the communication contract, using the
authoritative time view. GC is allowed only when a durable admission rule can
still reject every retired identity, including after restore. A missing row or
caller-supplied timestamp is not proof that an old identity is new. Otherwise
retain the compact terminal guard and apply storage quota/backpressure to new
admission rather than deleting that guard. Define bounds and reserved cleanup
capacity for the journal too; an ordinary transport deduplication TTL is not
the retention policy for semantic effects.

### Fair scheduling

Use Stage K's bounded-priority-burst plus FIFO escape as the initial policy
candidate. Specify the actual tenant rotation, resource-fit selection and
burst counters together before promoting that policy to production.

- Persist scheduler policy revision and the fairness state needed across
  restart. Define quota-update behavior explicitly; repeated policy edits or
  reconnects cannot reset a waiting operation's age to gain or deny service.
- Separate eligibility from priority. A queued operation may be ineligible
  because of quota, resource fit, authorization or deadline. Every skip has a
  typed reason; priority does not bypass those checks.
- Specify a finite bound in eligible grant opportunities under a fixed finite
  tenant set, persistent eligibility, finite older set and eventual release of
  required capacity. Do not promise a wall-clock bound under an unbounded
  stream, unavailable resource or indefinitely running holder.
- Mixed resource vectors need a policy against perpetual bypass of large
  requests, such as bounded bypass followed by reserving the required free
  vector for the oldest eligible request. Prove the chosen policy without
  blocking unrelated pools; impossible requests are rejected explicitly.
- Database lock availability is not fairness. Concurrent `SKIP LOCKED` consumers
  must not silently defeat the chosen ordering or duplicate a grant. Serialize
  the minimum scheduler state per pool or prove an equivalent fenced algorithm.

### Control, time and recovery

- Cancellation, renewal and reclaim run on a separate bounded control budget;
  they cannot wait behind ordinary user work. Saturating admission must leave
  a tested path to stop work and protect lease deadlines. Control traffic itself
  is authenticated, rate bounded and observable.
- Capacity expiry and fairness use the injected authoritative monotonic
  control-time view from ADR-0001. Process-local uptime or caller timestamps
  cannot be reused as durable time after restart. Qualify clock recovery and
  stale/future observations against the existing time contract.
- Ambiguous renewal never extends local authority. At expiry, reject new
  dispatch, effects and canonical output; trigger containment/reconciliation.
  `reclaim_pending` consumes capacity until an exact fence acknowledgement or
  enforcement-backed quarantine disposition makes reuse safe.
- If the store fails while stopping, preserve the local cutoff and containment
  path; do not claim a durable cancellation receipt until committed. Recovery
  records the observed outcome under its original identity. A database outage
  is not permission to continue with expired authority.
- When parent/child execution becomes supported, a waiting parent cannot retain
  all permits needed by its child. Separate durable coordination from physical
  resource occupancy. Do not release a still-running process slot to solve a
  scheduling deadlock. This is future acceptance, not added V1 functionality.
- Shutdown stops admission, drains or fences owned activity, and leaves durable
  queued work recoverable. Startup reconciles old ownership before granting
  successors. Never blindly repeat an effect whose outcome remains unknown.

## Observability and product acceptance

Expose pending count/bytes, active utilization, oldest eligible wait by class
and tenant, rejected admission reasons, fairness skips, renewal lag, quarantine
and reclaim duration. Bound metric cardinality; per-operation detail belongs in
owner-controlled diagnostics rather than unlimited metric labels.

Publish technical wait reasons and evidence freshness separately from lifecycle.
Orchestrator combines these with product dependency or approval state. Frontend
renders that projection; age alone must not diagnose a stuck task. Unknown
observation stays unknown. Do not promise an estimated start time without an
explicit model and uncertainty. Runtime acceptance, execution completion,
result delivery and parent continuation remain different owner facts.

## Delivery and evidence

| Slice | Deliverable | Required proof |
| --- | --- | --- |
| C0: reconcile and specify | Review current production owners, pinned profiles, reusable persistence primitives and first pool/resource scope; settle policy knobs and grant-opportunity bound | Reviewed delta from Stage K; no duplicate lifecycle, eighth V1 port or empty production scaffold |
| C1: durable admission | Owner-local port implementation, transaction/accounting, receipts and bounded pending storage | Concurrent limit/byte races, identity conflict/replay, expiry/cancel races, unknown commit and store restart |
| C2: dispatch and lease | Fair allocator, bounded workers, isolated control budget and production cutoff/reclaim integration | Constant urgent arrivals with background progress, mixed vectors, cross-tenant isolation, concurrent schedulers, restart of fairness state, ambiguous renewal and stale host fencing |
| C3: product and qualification | Typed observations, operator recovery and disposable hosted worker integration | Honest waiting/unknown status, stop under saturation/store outage, crash matrix and bounded soak with cleanup |

Keep each coherent slice independently reviewable and reversible. Production
estimates follow C0's inventory; Stage K model LOC are not the cost of worker
integration. No new runtime package is authorized by this document alone.

The conformance matrix must include:

- queue-full and byte-full rejection before excess payload retention, with
  exact global/tenant counters after every cancellation/expiry race;
- replay of a previously accepted command when the queue is now full;
- replay after expiry, payload pruning and restart, including both sides of
  the receipt GC boundary; retired identities never allocate again;
- continuous foreground arrival plus persistent background demand and bounded
  tenant rotation, with a strict-priority negative fixture that starves;
- large feasible resource requests amid small ones, impossible vectors,
  quota shrink without preemption, and scheduler lock contention;
- crash before/after admission commit, grant commit, process start, renewal,
  cutoff, containment acknowledgement, reclaim and result publication;
- identical recovery after lost/duplicate wake-ups; no second launch on an
  unknown launch/effect result; stale release cannot free a successor slot;
- saturation plus cancel/renew/reclaim traffic, unavailable storage and bounded
  output consumers; observed limits must cover memory as well as row counts;
- owner loss, healthy progress, waiting for an external actor and stale
  observation as distinct cases; fake time cannot turn age into failure;
- future nested parent/child admission without permit deadlock, gated on that
  capability actually entering scope.

Use deterministic policy/model tests and real PostgreSQL concurrency/fault
tests before disposable hosted worker qualification. Retain exact code, policy,
schema and environment identities with each result. Never use user projects or
live customer work. Existing Stage K evidence is reused only within its scope;
passing model tests does not certify multi-host worker behavior.

Rollback first closes new admission and drains or reconciles current owners;
queued intents retain identity. Preserve compatible durable rows and receipts,
or require an explicit migration/recovery path. A feature flag cannot bypass
fencing or make an old binary safe to consume a new state shape.

## Sources and limits

OpenClaw source review at `ed5937fbd9819634bf9a315daa5996c86a5c712f` found an
unbounded pending storage in the generic command queue and strict priority order
without aging in that primitive. This is not a claim that every external entry
point lacks limits. Its native priority mapping puts user/manual work in
foreground and cron/heartbeat/memory/overflow work in background; inter-session
input is also background. These examples motivate acceptance, not copied
product class names or evidence that our production implementation already wins.

- [OpenClaw command queue](https://github.com/openclaw/openclaw/blob/ed5937fbd9819634bf9a315daa5996c86a5c712f/src/process/command-queue.ts)
- [OpenClaw lane priority](https://github.com/openclaw/openclaw/blob/ed5937fbd9819634bf9a315daa5996c86a5c712f/src/agents/embedded-agent-runner/run/lane-runtime.ts)
- [Google SRE: handling overload](https://sre.google/sre-book/handling-overload/)
- [PostgreSQL SELECT and SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html)
- [AWS: idempotent retries](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)

The owner-local PostgreSQL design is our recommendation based on existing
boundaries, not a technology requirement imposed by these external sources.
