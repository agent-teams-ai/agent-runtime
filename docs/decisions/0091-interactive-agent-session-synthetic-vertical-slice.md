---
id: ADR-0091
type: adr
status: accepted
owner: architecture
summary: Defines additive interactive session authority, provider SPI, durable handoff and scoped synthetic qualification without changing contained-turn.
related:
  - ADR-0003
  - ADR-0004
  - ADR-0008
  - ADR-0009
  - ADR-0010
  - ADR-0017
  - ADR-0024
  - ADR-0090
  - runtime.architecture.architecture-program-plan
  - qualification.interactive-session-c-first-slice
---

# ADR-0091: Interactive Agent Session synthetic vertical slice

Status: accepted

Date: 2026-10-21. Baseline: `efd3348f361fa6af84953325af5c0d2d8677d14a`.
Accepted by root technical review under the owner's explicit A–F autonomous
implementation direction. Review required the cancellation-authority rule below
after B exposed a real late-callback race. This accepts the scoped contract;
implementation, adoption, real-provider and deployment qualification remain pending.

## Context

The owner-directed provider extraction plan A–F selects persistent Claude
sessions through the official SDK, runtime-owned technical session semantics,
an ordinary external provider library, Orchestrator-owned product tools, and
eventual desktop integration. The owner's 2026-10-21 direction is to finish the
agreed implementation and E2E autonomously, using fixtures/mocks where real
Claude credentials are unavailable. That direction supplies the scoped product
choice; it is not real authentication or containment evidence.

The current [architecture program](../architecture/agent-runtime-architecture-program-plan.md)
§1, decision 1 and §8.1 excludes Claude rewrite, streaming, session reuse,
resume and approvals. Decision 32 freezes contained-turn. Neither
[ADR-0010](0010-contained-agent-turn-v1-operation-authority.md) nor the ordinary
Codex profile in [ADR-0090](0090-ordinary-user-session-codex-execution-profile.md)
can be widened by implementing another provider under their names.

This decision is the narrow successor to those program exclusions
for the new interactive path below. It does not supersede either entire ADR,
accept proposed ADR-0006, unfreeze contained-turn, replace Codex ordinary
records, or authorize unrelated program changes. Historical accepted bytes stay
unchanged. Existing scope, authority, cutoff and no-blind-retry invariants from
ADR-0003/0004 remain applicable.

The B implementation lives in the separate experiment
`experiments/interactive-provider-contract` on the provider extraction branch.
Its consumer-owned `./draft-contracts` and concrete `./claude` are inputs for
review, not production imports. This baseline does not contain that checkpoint;
no relative link assumes otherwise and no source copy is introduced here.
Integration must record its exact reviewed commit. The frontend candidate and
the A–F migration plan remain planning inputs, not alternate runtime authority.

## Decision

### One feature, one owner and a separate contract

Agent Execution owns a new feature at
`packages/contexts/agent-execution/src/features/interactive-agent-session`.
Its policy owns runtime session/generation IDs, operation/input intents,
admission, durable observations, pending interactions, checkpoint references,
control serialization and recovery. Orchestrator owns teams, tasks, message
delivery meaning, product approvals and retry/completion decisions. A provider
result closes a technical turn; it cannot complete product Work.

The selected public capability is `interactiveSession` on a separately admitted
scope-bound access handle, with `open`, `submit`, `observe`, `reply`,
`interrupt`, `close` and explicit `restore`. Trusted composition binds tenant,
project, workspace, authority/config/account revisions and deadlines; requests
cannot override them or select executable, credential path or arbitrary ports.
Caller abort ends an observation wait, not durable accepted work.

The runtime owns a consumer SPI, with cohesive session operations from B:
submit, observe, reply, targeted interrupt, readiness, checkpoint and close,
plus typed open/restore configuration and confirmed/required capabilities.
Failures distinguish invalid input, conflict, stale generation/operation,
unsupported capability, dependency unavailable, handoff uncertainty,
checkpoint missing/incompatible, output limit and cleanup uncertainty.
SDK DTOs, native IDs, paths, spawn types and checkpoint bytes remain private.

Expose erased SPI types from the curated
`@agent-teams/agent-execution/interactive-contracts` subpath, implemented by a
type-only `src/interactive-contracts.ts` barrel. Factories stay under the existing
`./composition` entrypoint; ordinary API contracts stay under the existing root.
The scoped export/profile changes must explicitly admit this subpath rather
than weakening the general curated-export rule. It executes no runtime import.

The first external implementation location is the planned
`agent-teams-ai/provider-implementations` repository, package
`@agent-teams/provider-implementations`, with one concrete `./claude` factory.
The package imports only the runtime contract subpath as types and is selected
by Embedded Runtime composition. Agent Execution does not depend on the
implementation package, so the package graph has no cycle. An isolated packed
consumer must prove that arrangement without a sibling checkout. If packaging
proves the private runtime package cannot supply that type dependency, extract
only this runtime-owned contract into a separately packed contracts package;
that is a concrete delivery adjustment, not a second runtime or API owner.

Move the B driver subtree once; remove the editable experimental algorithm when
the production implementation replaces it. Retain fixtures and one evolving
harness. There is no daemon, agent loop, DI framework, shared service bag,
scheduler, general storage platform, supervisor or automatic provider fallback.

### Durable intent and sequential handoff

One Agent Execution store owns an additive `interactive_session_v1` namespace;
it never decodes a missing profile as interactive or writes ordinary codec3/
contained records. Reuse the existing PostgreSQL deployment and borrowed pool,
not a second backend. Explicit migration and schema verification precede Host
activation; constructing the owner does not silently migrate data.

The store atomically admits an input with its scoped command ID, canonical
fingerprint, immutable binding, queue order and delivery intent. Exact replay
returns current original receipt/state; conflicting bytes refuse without a new
effect. The bounded queue has one active operation per session. A CAS under the
same session authority commits the dispatch claim before provider handoff.
Unknown admission/claim commit grants no dispatch authority: read back the same
identity, or retain `reconcile_required`. Never resubmit with a fresh ID to
resolve uncertainty. Different IDs do not imply business-effect equivalence.

Persist orthogonal facts: `admitted`, `dispatch_claimed`, `handoff_unknown`,
`sdk_consumed`, provider acceptance if actually observed, turn outcome and
closure. `sdk_consumed` is a handoff fact, not provider acceptance. Once claim
commits, a crash before a handoff receipt is conservative `handoff_unknown`;
readback of the claim alone cannot authorize sending again. A proven not-sent
owner fact may permit the original dispatch under policy. Otherwise recovery
blocks the same session's next handoff until reconciled. No automatic replay,
fresh session, model/account switch or checkpoint-based effect retry occurs.

Canonical runtime output has a session/generation cursor allocated in the same
owner transaction as its append. Operation/input attribution is optional when
the provider cannot prove it. Unknown session events are not assigned to the
last turn. Text snapshots/complete share message/block identity, while distinct
messages with identical text remain distinct. Observers receive bounded replay
or an explicit gap; SDK iteration itself is not a durable cursor. Unknown usage
stays unknown. Unknown control outcomes never become success.

### Independent replies, targeted control and closure

Replies bypass the prompt queue. The runtime validates permission decisions
and question answer payloads separately, binding them to the pending request,
scope, generation, operation when proven, authority and expiry. It durably
records the decision before applying it to the callback. Lost application
acknowledgement is an uncertain control fact, not permission to grant again.
After restart, old pending callbacks become stale evidence; checkpoint restore
does not recreate their grants. Late/conflicting replies refuse. An identical
decision replay may return its recorded receipt but never apply to a new request.

`canUseTool` is not authorization for every auto-approved tool. The authoritative
MCP handler/hook enforces product scope on each mutation. Runtime readiness
requires the selected tool endpoint and required tool set; absent tools produce
typed dependency failure before input, and loss suspends new handoffs. C uses
fixture tools/authority; real product mutation handlers belong to E.

Result, interrupt and next handoff share one short session control boundary.
An interrupt binds the exact active operation and generation and remains pending
until its own control call settles. Late interrupt A cannot target queued B.
Once A is cancelled, every newly arriving A permission/question callback and
reply is refused until A reaches its terminal boundary. Interrupt acknowledgement
or settlement of the control promise never restores A's callback authority.
The next B receives its own operation-bound authority; it cannot inherit A's
callback, request ID or grant. Observing a late A event does not reopen A.
The boundary does not hold a mutex across a turn, callback wait or observation;
otherwise reply could deadlock. Requested interrupt, observed provider terminal,
output drain and owned resource closure are separate facts.

Close first seals admission durably, rejects queued undispatched inputs,
invalidates interactions, drains observations and joins concurrent close calls.
The Host retains the resource owner until its bounded cleanup settles. Missing
process/stream/grant closure preserves cleanup debt and `reconcile_required`;
SDK close or a successful resource-scope callback is not physical closure proof.
Close never reopens a session. Shared backing hosts are stopped only by their
own owner; session stop cannot signal a neighbour's shared host.

Restore is explicit and requires the exact private engine/codec/config,
workspace, credential/account and checkpoint binding. It creates a new
generation, refuses missing/incompatible state, and restores no old callback
authority. It restores conversation only, not filesystem state or effect truth.
No `continue latest` or silent fresh fallback is admitted. Recovery after lost
live process ownership remains honest unknown until owner-specific evidence
resolves it; persisted PID alone is insufficient.

Immutable Host config bounds input/queue, event/output, pending interactions,
checkpoint bytes, authority and shutdown time. Overflow must retain a reserved
terminal/uncertainty record even when the normal event budget is exhausted;
it stops handoff and wakes waiters. Slow observers cannot create unbounded
buffers. Secrets/raw checkpoints and provider exception text are excluded from
public observations and diagnostics.

### Existing mechanisms and the actual missing work

| Existing source at baseline | Reuse and limit | New interactive responsibility |
| --- | --- | --- |
| `contained-agent-turn/application/ordinary-ports.ts` | Store commit uncertainty, owner ports and process/protocol separation are precedents; exact Codex manifest is closed | New consumer-owned interactive ports; no cast/widening of `OrdinaryProviderPort` |
| `contained-agent-turn/adapters/outbound/postgres/ordinary-postgres-store.ts` and `ordinary-state-codec.ts` | Borrowed pool, scope-keyed CAS, digest/conflict and readback patterns | Separate session/input/control/checkpoint/event transactions and restart suite; do not subclass or copy the whole store |
| `contained-agent-turn/adapters/outbound/ordinary-process/node-ordinary-process.ts` | Explicit launch reservation, live group ownership, drain observations and no persisted-PID recovery | Interactive launcher/SDK spawn hook compatibility and session-lifetime custody still need proof; one-turn receipts cannot be fabricated |
| Embedded Runtime `ordinary-session-runtime/composition/ordinary-agent-runtime-host.ts` | Inner-owner cleanup before journal; retained creation-failure cleanup handle | New Host capability/admission and per-session owners, with failed cleanup retained |
| Embedded Runtime trusted scope/access and disposal composition | Scope copied before use, detached handle, Host shutdown distinct from cancellation | Separately bound interactive handle and its durable stop observations |
| Provider Access and Runtime Security owners | Existing authority ownership, secret separation, revision/expiry constraints | Synthetic authority first; real Claude credential route and enforcement are unqualified |

These paths are mechanisms to inspect, not permission to modify the frozen
contained implementation. First C can use a deterministic provider and
synthetic authority/workspace, with a real interactive owner/store boundary;
it must not claim the existing Codex auth broker accepts Claude.

### Narrow FMS and CMS disposition

FMS remains `agent-teams.feature-module-standard/v1`, canonical blob
`d0bfff2033faf544fe65268c1dcdfd524d093015`, SHA-256
`851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa`.
No sub-features or v1.1 migration are needed. On implementation, the new
Agent Execution feature has domain, application/use-cases, application/ports,
adapters and composition only where real code exists, a contracts-only public
feature entry and curated composition entry. Type-only provider SPI exports
remain outer contracts; application/domain depend on their local port types.

The current CMS pin is `81063add7de50ffe2b91cc74bf7271b298624c21`.
The candidate review against verified upstream main
`ddf1e0b0053f546f12ca70190b237b4f7e78d09d`, full-document SHA-256
`c2fe582a14ff6e79620b232ca7ffc914afb0474ec21fd43f208251dd7252f4a3`, is
retained in `architecture/interactive-agent-session/cms-pin-review.json` with
the exact source and delta. It does not change the existing pin or certify C.

First implement the Agent Execution feature through its closed typed factory
and development fixture consumer. Its owner-local use cases, normalizer,
queue and codec are fixed private feature helpers, not Assembly nodes.
The fixture composition is test code. Production Embedded Runtime integration
is a separate real composition boundary and remains pending until the current
CMS/package migration and blocking adoption checks exist. Do not claim direct
fixture DI as production Host adoption or copy the obsolete Assembly API into
new Host composition.

For that boundary, the minimum independently selected capabilities are the
session owner, durable store, selected provider and Host resource/authority
bindings. The production root lists static groups/entries, uses contract
descriptors and `scoped` ownership, and keeps Core/Assembly out of policy.
Reuse existing genuine owners through narrow adapters; no new observation
store, lifecycle kernel, dynamic graph or module per use case is needed.
Updating the shared installed Get Modular pair must prove existing Host
compatibility, without opportunistic redesign of passive/ordinary profiles.

The feature delivery updates the actual FMS profile/checker, Foundation source
roots/exports, compiler and package-test census, fast/full commands and rejecting
fixtures. The production Host delivery additionally records a precise CMS
profile with root/declaration/factory paths, slots, lifecycle owner, package
archives, independent wiring oracle and packed public consumer. Unknown roots,
no-op gates, undeclared edges, inward SDK/Node/Assembly imports, deep imports,
bad slots/revisions, missing awaits and cleanup ownership failures reject.
No new baseline, wildcard exclusion or false active profile is permitted.

### Qualification and promotion

The [C qualification plan](../spikes/interactive-session-c-first-slice-qualification.md)
defines observable acceptance and the remaining gates. A synthetic C pass,
actual SDK/CLI with a localhost provider fixture pass, real Anthropic pass and
deployment qualification are distinct evidence classes. No real credential,
hostile containment, subscription onboarding or deployment is implied here.

Root technical review accepted this scoped contract on 2026-10-21 under the
owner's existing A–F direction; routine implementation choices require no
repeated owner question. The new ADR is frozen in the accepted-decision registry;
mutable program/readiness/index references record the scoped successor.
Frozen predecessor bytes are unchanged. Implementation/adoption remain pending
until their actual checks pass.
Any future substantive policy expansion beyond A–F follows its own successor;
missing real auth only blocks a real-auth claim, not synthetic implementation.

## Consequences

The persistent Claude path has an explicit authority and one technical owner
without changing contained-turn or ordinary Codex semantics. The first concrete
production-code checkpoint can implement durable admission, single claim,
normalized append, independent replies, targeted control and truthful closure
against a synthetic consumer. Production Host wiring, external driver packaging,
real credential qualification, Orchestrator integration, desktop E2E and fork
removal remain separately testable A–F work, not claims produced by this ADR.
