---
id: qualification.shared-research-integration
type: qualification-plan
status: proposed
owner: architecture/qualification
summary: Proposed evidence and qualification mapping for shared research into ordinary runtime and capacity delivery.
related:
  - runtime.architecture.architecture-program-plan
  - runtime.architecture.capacity-admission-delivery-plan
---

# Shared Research Integration Plan

## Target tuple

Proposed qualification mapping dated 2026-11-03. Ordinary runtime v3
[S1-S5](../architecture/agent-runtime-architecture-program-plan.md) and the
[capacity C0-C3 delivery](../architecture/capacity-admission-delivery-plan.md)
remain separate. Assume each approved design is implemented correctly when
comparing its intended guarantees. Completion of ordinary execution does not
qualify thousands of simultaneously active agents.

The shared [Paperclip source dossier](https://github.com/agent-teams-ai/engineering-research/blob/12c40892e805944719d6fbec14d2c26874803b2c/docs/competitors/paperclip.md)
is published in [Engineering Research draft PR #1](https://github.com/agent-teams-ai/engineering-research/pull/1) at commit
`12c40892e805944719d6fbec14d2c26874803b2c`. Its [evaluation method](https://github.com/agent-teams-ai/engineering-research/blob/12c40892e805944719d6fbec14d2c26874803b2c/docs/methodology/evaluation-methodology.md)
and [decision cards](https://github.com/agent-teams-ai/engineering-research/blob/12c40892e805944719d6fbec14d2c26874803b2c/docs/lessons/preimplementation-decisions.md)
retain shared evidence and proposed alternatives. The [shared research index](https://github.com/agent-teams-ai/engineering-research/blob/docs/shared-research-2026-11-04/docs/README.md)
is the maintained discovery route. This document owns only proposed Runtime
applicability and routes to existing acceptance owners. Central publication is
still a draft; it does not accept product policy or qualify a deployment.

The source review inspected Paperclip at
[`61e8d5c7eb097664958e00c30ccd88bb51359043`](https://github.com/paperclipai/paperclip/tree/61e8d5c7eb097664958e00c30ccd88bb51359043).
No Paperclip tests, live providers or active-worker benchmark were executed in
this documentation change. The review retains Paperclip's durable identities,
uncertain-outcome handling, control reserve, cleanup fences and bounded viewer
delivery as counterevidence against blanket scalability criticism.

## Required evidence

Use these rows to refine existing task acceptance. They introduce no parallel
release gate, new port, scheduler, storage authority or production package.
If the current owner already covers a row, record that coverage once.

| Priority and question | Existing owner or delivery | Proposed acceptance refinement |
| --- | --- | --- |
| Before implementation: what is an active agent? | C0 workload and resource inventory | Record simultaneous executions, active sessions, pending count and bytes, tenants, pools, hosts, provider connections, output rate/size, retention and cleanup debt. Compare one large tenant with the same population spread across tenants. |
| Before implementation: which mutation is shared? | C0/C1 capacity transactions and current S2 persistence | Inventory every shared counter and lock writer. Measure admission, usage receipt and settlement work separately; do not serialize unrelated per-receipt writes behind a tenant aggregate by accident. Usage pricing and product budget decisions stay with their consumer. |
| Before implementation: what does the feed acknowledge? | Existing S2 operations/store and feed contract | Preserve its declared sequence/gap semantics. Benchmark append and replay against increasing retained history; measure database work as well as response bytes. Use incremental cursor work only where the selected contract needs it, with gap and conflicting-replay tests. Do not add a gap-tolerant protocol merely because another system has one. |
| During delivery: does eligible work progress? | C1/C2 bounded admission and persisted fairness | Reuse pending count/byte limits, finite claim batches and the existing grant-opportunity bound. Add blocked-prefix, mixed-vector and constant higher-preference arrivals to the actual allocator tests. Product dependency eligibility remains an authorized consumer input. |
| During delivery: can several pools preserve one global allowance? | C0 scope definition, C1 atomic admission and C2 allocation | Name the single authority for each global, tenant and provider allowance. Independent pools must not each spend the whole shared allowance. If subdivision is selected, prove grant conservation, expiry, unknown outcomes and safe reclaim. Do not add a global scheduler without this concrete need. |
| During delivery: can safety work proceed under pressure? | C2 control reserve and native-team integration | Bound count, bytes, database connections and other material resources used by cancellation and renewal. Saturate ordinary traffic, pause storage during stop, lose the receipt and keep a descendant alive. Preserve cutoff and honest pending/unknown state. |
| Before qualification: is reclaimed capacity safe? | C2/C3 and existing physical-custody owner | Keep capacity charged until physical fencing/containment or an enforcement-backed quarantine permits reuse. A lease expiry, task result, cancellation acknowledgement and physical cleanup are distinct observations. |
| Before qualification: does the complete profile work? | C3 existing worker/soak qualification | Run the smallest useful fully local, self-hosted and managed profiles with their actual worker/process topology. Exercise overlapping controllers beyond rollout windows, notification loss, reconnect, recovery and bounded cleanup. Publish only the measured envelope. |

The [Stage K evidence](stage-k-capacity-fairness-results.md) is a bounded model
and PostgreSQL experiment. It is useful evidence for admission/fairness/reclaim;
it is not an active-worker fleet qualification. Inspect its exact scope before
adding a redundant model test. Runtime supplies technical receipt and execution
truth; Orchestrator and Platform own authorized views, business continuation
and commercial policy.

## Negative gates

The following are rejecting scenarios within existing acceptance, not a new
set of repository tooling gates:

- An ambiguous grant, commit or provider outcome must not authorize duplicate
  dispatch or erase the original identity guard.
- A blocked queue prefix must not indefinitely hide eligible work. State the
  finite progress assumptions; permanently occupied capacity cannot support an
  unconditional wall-clock guarantee.
- A full telemetry or output queue must not consume the declared safety reserve.
  An exhausted reserve must produce an honest failure/recovery state.
- Cancel versus grant and lease loss versus reclaim must retain the existing
  owner-local atomicity and physical-custody obligations.
- A source-cursor optimization must preserve exact replay, conflict rejection,
  terminal ordering and durable acknowledgement. A maximum sequence alone is
  insufficient for a contract that admits gaps.
- Provider-pool limits and per-worker caps must not silently replace global or
  tenant accounting. Cross-pool movement must not duplicate admission.

Keep the native-team coordination boundary in the
[architecture program](../architecture/agent-runtime-architecture-program-plan.md).
Do not add another supervisor, native journal, custody receipt or TypeScript
process manager to satisfy these scenarios. Get Modular composition and current
owner contracts remain the relevant reuse mechanisms.

## Research custody and delivery scope

The five local reports retain their complete historical bodies and heading
anchors, with notices linking to their published central studies. The
[central import provenance manifest](https://github.com/agent-teams-ai/engineering-research/blob/12c40892e805944719d6fbec14d2c26874803b2c/data/import-provenance.json)
records each original source hash and unchanged raw snapshot:
[industry](agent-runtime-industry-architecture-research.md),
[frameworks](agent-runtime-framework-research.md),
[libraries](agent-runtime-library-research.md),
[durability](agent-runtime-durability-research.md) and
[lessons](agent-runtime-antipattern-register.md).
The [modular synthesis](../architecture/agent-runtime-modular-research.md),
[experiments](agent-runtime-modular-architecture-spikes.md) and
[review record](agent-runtime-modular-research-review.md) retain Runtime ownership.
Historical source pins, review identities and qualified evidence are not rewritten
as a new campaign. These reciprocal routes preserve the original local metadata,
IDs and every original heading anchor. Future shortening requires a verified
inbound-reference inventory and retained redirects or anchors; no source body is
removed by this change.

This delivery adds documentation only: zero production implementation lines.
Future estimates belong to the reviewed seam inventory. Capacity work is counted
inside C0-C3; existing S1-S5/feed/native work is not charged a second time as a
research integration delta. Count production integration, tests, configuration
and platform/release work separately before accepting an implementation estimate.

## Promotion rule

Accepted ADRs, exact adoption profiles and the existing readiness/qualification
process own promotion. This proposal qualifies no profile and accepts no new
contract. Central research cannot change those owners by publication. Resolve a
real semantic conflict through the owning successor process; retain independent
ordinary-runtime delivery while the separate fleet envelope is qualified.
