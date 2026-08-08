---
id: ADR-0003
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0003: Runtime cutoff barriers and scope disposition

Status: accepted for the architecture foundation

Date: 2026-08-02

Implementation status: no cutoff, disposition, provider, or deployment target is
implementation or production qualified by this ADR. Exact Published Language
package names, message names, fields, enum values, and Protobuf numbers remain a
follow-up contract decision.

## Context

ADR-0001 and ADR-0002 establish Agent Execution ownership of runtime authority,
cutoff, canonical output, effect reconciliation, and owner-local disposition.
They do not yet distinguish all consistency boundaries needed when an external
Orchestrator suspends product authority for one Run-like subject:

- an operation cutoff concerns one durable provider-visible unit of work;
- a session cutoff concerns the shared session execution authority;
- a runtime-scope suspension closes admission for a wider technical scope;
- provider containment and uncertainty about an external effect may converge
  after the authority transaction;
- scope disposition is a separate, resumable workflow rather than a synonym
  for suspension or cancellation.

The Orchestrator owns product authorization and business meaning. It may
atomically suspend its own authority generation and issue a durable cutoff
trigger, but Agent Runtime (AR) must not import Run states, memberships, product
plans, or business authorization rules. AR owns its private runtime revisions,
fences, receipts, and enforcement state.

A single `enforcementState` would incorrectly collapse admission, canonical
output, provider containment, and effect reconciliation. A single generic
cutoff command would also imply an atomic consistency boundary across separate
aggregates. This ADR fixes the strategic state model while deliberately leaving
the wire schema open.

## Decision

### Ownership and language boundary

The decisions in this ADR stay inside the existing Agent Execution bounded
context. They do not create a fifth bounded context.

AR's Published Language is AR-owned. Orchestrator consumer ports, ACL mapping,
business authorization, and the decision that two different operations express
the same business effect remain Orchestrator-owned. Neither side imports the
other side's domain entities or wire types into its core.

External subject authority may be carried only as opaque correlation or
precondition evidence, provisionally called `externalAuthorityEvidenceRef`.
It is never an AR authority revision. A fresh external authorization does not
rotate an AR fence, clear runtime uncertainty, or reopen admission by itself.

The exact public identity names remain open, but every accepted mutation is
bound to all applicable technical identities and preconditions:

- AR tenant and runtime-project scope;
- stable runtime authority realm;
- logical runtime deployment and deployment incarnation;
- accepted AR-owned deployment authority generation;
- expected runtime-scope revision;
- target operation or session plus its expected authority revision;
- command identity and canonical request digest;
- opaque external authority evidence when supplied.

An Orchestrator-owned runtime binding generation may be correlated in opaque
evidence, but it does not become an AR authority generation. Private session,
operation, process, and deployment fences never leave AR. Cross-tenant,
cross-scope, wrong-incarnation, and stale-generation substitutions fail closed
without becoming an existence oracle.

### Separate cutoff targets

Operation, session, and scope cutoff are separate commands and consistency
boundaries. The names below describe semantics, not final wire names.

| Target | Owning consistency boundary | Atomic authority result | Asynchronous work |
| --- | --- | --- | --- |
| operation cutoff | `RuntimeOperation` command lane and its dispatch/output authority | fence new dispatch for that operation, advance its cutoff revision, reject subsequent canonical operation output, append receipt/outbox | provider stop when required, effect reconciliation, cleanup |
| session cutoff | `SessionExecutionAuthority` | close the active slot, advance session cutoff and canonical-output fence, reject output for every stale generation in the session, append receipt/outbox | child-operation fan-out, provider/process containment, effect reconciliation |
| runtime-scope suspension | Agent Execution runtime-scope admission authority | close new scope admission and dispatch claims, advance scope revision, append receipt/outbox | durable fan-out to sessions and operations, containment and reconciliation roll-up |
| scope disposition | scope disposition process manager plus owner-local commands | accept an immutable technical plan and advance its workflow revision | inventory, cutoff fan-out, deletion/retention actions, verification, receipts |

Scope suspension does not atomically fence canonical output in every child
aggregate. It becomes a complete scope cutoff only through durable fan-out and
exact child receipts. A status projection may summarize that progress, but it
cannot manufacture authority or output fencing.

Scope admission includes every provider dispatch claim that requires current
scope authority, including a not-yet-dispatched operation accepted before the
suspension. A dispatch claim that already won its CAS follows the post-dispatch
path; suspension cannot retroactively make that external side effect atomic.

There is no target-union command whose handler mutates operation, session, and
scope state in one transaction. Provider, network, filesystem, KMS, object
store, and worker calls never occur in an authority transaction.

### Dispatch linearization

The durable dispatch-claim compare-and-swap is the authority linearization
point between cutoff and a provider side effect:

- if cutoff or revocation commits first, the dispatch claim fails;
- if the dispatch claim commits first, dispatch is authority-started and later
  cutoff follows the post-dispatch containment and reconciliation path;
- adapter validation immediately before process spawn or the first network byte
  is defense in depth, not a second authority decision;
- ambiguous provider acceptance is recorded and reconciled; it is never blindly
  retried.

Operation dispatch and operation output validate the operation cutoff revision.
Session output additionally validates `SessionExecutionAuthority`, the current
execution generation, private fence, custody, and session cutoff revision.
Every new dispatch claim validates the current scope revision. Scope suspension
does not become an output fence for already active work until child cutoffs win.

Dispatch claim and canonical output append are Agent Execution transactions
that conditionally lock or compare the applicable monotonic authority guards in
stable scope, session, then operation order. They mutate only their owning
claim or feed state, but they cannot commit when any required guard is stale.
This composite guard is the deliberate strong-consistency seam between the
otherwise separate aggregate lifecycles. It is not a cross-context or provider
transaction.

The scope admission authority, session execution authority, operation dispatch
authority, and canonical output append path therefore remain in one
transactional deployment/store boundary. Splitting them across network services
requires a new ADR and a replacement protocol that preserves the same
linearization guarantees; ordinary synchronous RPC checks are insufficient.

### Orthogonal enforcement dimensions

The authoritative model has four independent dimensions. Their provisional
labels are:

1. `AdmissionFenceState`: whether the target may admit or dispatch new work;
2. `CanonicalOutputFenceState`: whether output from the fenced authority can be
   appended to canonical feeds;
3. `ProviderContainmentState`: whether separately continuing provider execution
   has been stopped, proven impossible, or remains uncertain;
4. `EffectReconciliationState`: whether possibly accepted external effects are
   resolved, durably blocked from retry, or still require reconciliation.

The exact enum values remain a Published Language decision. The domain must at
least distinguish open or fenced admission, open or fenced canonical output,
containment pending or contained or uncertain or technically not required, and
effect reconciliation pending or required or resolved or truthfully
indeterminate.

`partially_enforced` and `enforcement_uncertain` may be exposed as derived
summary classifications. They are not authoritative states and cannot be used
as transition preconditions. A consumer must inspect the typed dimensions and
receipt evidence relevant to its next action.

An accepted cutoff receipt proves only the atomic authority result for its
target. It does not by itself prove provider death, absence of an external
effect, complete scope fan-out, or successful disposition.

### Technically not-required containment

`ProviderContainmentState.not_required` is allowed only when both of the
following are pinned to the exact operation and target closure:

1. immutable, qualified operation technical capabilities for the adapter,
   provider, binary closure, platform, credential route, transport, and
   provider topology;
2. the cutoff receipt and dispatch history prove that dispatch and canonical
   output are fenced, no separately continuing execution requires containment,
   and sibling operations or a shared provider host are not silently affected.

Product policy may require stronger containment than the qualified technical
minimum. It cannot weaken the minimum or declare technically necessary
containment unnecessary. An unqualified, expired, mismatched, or incomplete
capability keeps containment pending or uncertain and therefore keeps the
applicable predecessor barrier closed.

### Command disposition and durable receipts

Every mutation carries a globally unique command ID and canonical request
digest. The same ID and digest returns the original durable receipt. The same
ID with a different digest is a hard conflict. A timeout is recovered by replay
or receipt query, not by creating a second cutoff or disposition plan.

Command disposition distinguishes at least:

- `accepted`: the target-specific authority transaction committed;
- `already_terminal`: the requested monotonic reduction was already proven;
- `stale`: an expected revision, incarnation, generation, or authority
  precondition lost;
- `not_found`: no target is disclosed within the authorized scope;
- `conflict`: an idempotency identity was reused with different canonical
  content.

Containment, output, effect, and disposition progress is returned as separate
typed barrier evidence. It is not folded into command disposition.

Receipts and no-retry tombstones survive the complete command retry, provider
replay, backup restore, and stale-worker resurrection horizon. Query by command
or receipt identity returns the same canonical result after lost
acknowledgement. Owner feeds are at-least-once and cursor-based; each scope has
an explicit replay, gap, and snapshot/reconciliation contract. There is no
single global runtime cursor.

Feeds expose public scope, target, revision, command, receipt, and redacted
status references. They never expose private fences, internal execution
generation identities, secrets, raw provider payloads, or user content.

### Predecessor barriers and successor admission

Successor admission uses typed evidence referenced by a provisional
`predecessorCutoffReceiptRef`; a merely accepted cutoff is insufficient.

Reopening a suspended runtime scope is a separate explicit AR command. It
compares the expected scope revision and verifies typed predecessor barriers;
fresh external authorization evidence alone cannot reopen the scope. Scope
admission may reopen after execution, canonical output, and required provider
containment are fenced even while unrelated effect reconciliation debt remains.
The unresolved exact effect identities stay blocked independently.

For the target whose authority is being replaced:

| Evidence | Successor rule |
| --- | --- |
| admission or execution fencing not proven | block dispatch |
| canonical output fencing not proven | block dispatch |
| provider containment required but pending or uncertain | block dispatch |
| required containment proven, or technically `not_required` is proven | containment barrier may open |
| old effect outcome unknown for the same operation/effect identity | block replay or duplicate effect; keep reconciliation debt |
| execution and output fenced, containment barrier open, unrelated effect identity | a policy-authorized unrelated operation may proceed |

AR blocks exact reuse or retry by `RuntimeOperationId`, `EffectId`, or an opaque
caller-provided `externalEffectIdentityRef` within the declared idempotency and
restore horizon. AR validates identity reuse and immutable fingerprints, but it
does not compare prompts, payloads, commands, or product intent to infer that
two different identities describe the same business effect.

The Orchestrator feature that owns the business intent decides whether distinct
commands or operations are semantically equivalent. When it decides they are,
it must reuse a stable external effect identity or withhold new dispatch until
resolution. Without that identity, AR cannot promise deduplication across two
otherwise distinct operations. Existing ADR references to a semantic
`EffectId` mean a stable technical identity registered for one intended effect,
not an AR-owned business-semantics classifier.

Unknown business outcome alone does not permanently block unrelated operations
after execution, output, and required containment are proven fenced. It does
block the same exact effect identity and any external business equivalence the
Orchestrator enforces.

### Late output and provider observations

Output appended after a winning operation or session cutoff is rejected before
canonical sequence allocation. Scope suspension obtains that guarantee for
existing work only as child operation/session cutoffs commit.

Late provider acceptance, terminal callbacks, and process observations are
retained as bounded redacted evidence and routed to the owning effect or
containment reconciliation process. They cannot:

- reopen admission or execution authority;
- enter a fenced canonical output feed;
- rewrite an immutable terminal receipt;
- retire a no-retry tombstone;
- authorize a successor by themselves.

### Technical disposition plan

Product lifecycle, legal-hold, export, and retention decisions remain external.
AR executes only a normalized `TechnicalDispositionPlan` over AR-owned data and
runtime residue.

Each plan has an immutable plan ID, declared revision, canonical digest, scope,
and opaque policy-evidence references. A plan ID names one immutable plan:

- exact replay returns the existing receipt;
- reuse of the plan ID with a different digest is a hard conflict;
- correction creates a new plan ID with an explicit supersedes reference and
  cannot undo an already completed irreversible action.

The plan uses closed typed categories covering at least:

- sessions;
- operations and effect ledgers;
- canonical output and transcripts;
- artifacts;
- process and audit-eligible logs;
- provider state;
- worker state and residue;
- keys and credential material owned by AR;
- backups, snapshots, replicas, journals, and restore paths.

Each category has exactly one normalized effective action after validation.
The action vocabulary is closed and distinguishes disposal, verified absence,
retention until a typed condition, and policy retention. `crypto_erase` is
allowed only when evidence proves that the key scope is exclusive to the exact
disposition scope and that every required encrypted copy is covered. A shared,
deduplicated, unknown, or incompletely inventoried key scope forbids that
action.

Dependencies and order are deterministic. At minimum:

1. close scope admission;
2. fan out target-specific cutoff and obtain barrier receipts;
3. freeze and version the owner inventory;
4. resolve active operations and unknown provider residue;
5. apply category actions in the plan's validated dependency order;
6. verify owner-local receipts, backup/restore barriers, and resurrection
   prevention;
7. publish the immutable disposition result.

The workflow is resumable and monotonic. It distinguishes requested, admission
suspended, cutoff fan-out, inventory reconciliation, disposing, completed,
completed with typed exceptions, and reconcile required. Exact names remain
open.

`completed_with_exceptions` is allowed only for a closed list of categories
that have positive policy-retention evidence and exact receipts. Unknown
provider residue, an unknown or missing hold decision, incomplete backup
coverage, an unproven shared key boundary, or missing evidence remains
`reconcile_required`. Provider `not_found` alone is not proof of deletion.

No universal disposition transaction or repository crosses bounded contexts.
Each owner executes an idempotent local command and returns a receipt; the scope
process manager records the required receipt set and its progress.

## Forbidden transitions and claims

The domain and conformance suite reject the following:

- a runtime-scope suspension claiming immediate child output fencing;
- an accepted cutoff claiming provider containment or effect resolution;
- product policy alone selecting technically `not_required` containment;
- successor dispatch while execution, output, or required containment evidence
  is absent or uncertain;
- automatic authority restoration from fresh external authorization;
- duplicate dispatch of the same operation, effect, or external effect identity
  while its outcome is unresolved;
- AR inferring business-effect equivalence between different identities;
- late output from a fenced authority entering a canonical feed;
- a private fence or internal generation identity entering Published Language;
- a disposition plan with conflicting content for one plan ID;
- multiple normalized effective actions for one disposition category;
- cryptographic erasure without proven exclusive key scope;
- disposition completion with unknown provider residue, hold state, backup
  coverage, or required receipt;
- stale deployment incarnation, authority generation, scope revision, or
  cross-tenant identity authorizing a mutation;
- provider or projection observations directly mutating owner truth.

## Conformance requirements

Implementation qualification requires deterministic synthetic tests for:

- exact duplicate cutoff, duplicate disposition plan, and digest conflict;
- lost acknowledgement followed by replay and receipt query;
- dispatch-claim CAS racing operation, session, and scope cutoff;
- operation cutoff preserving sibling operation authority;
- session cutoff fencing all session canonical output;
- scope suspension closing admission while child fan-out is partial;
- delayed output and callbacks before and after each target linearization point;
- AR restart after authority commit and before outbox dispatch;
- provider disconnect and ambiguous provider acceptance;
- reauthorization racing predecessor containment and reconciliation;
- same operation/effect/external-effect reuse versus an unrelated operation;
- proof that AR does not infer equivalence from equal payloads;
- capability-backed `not_required` and negatives for policy-only, stale,
  mismatched, or unqualified capabilities;
- target, tenant, scope, realm, deployment incarnation, authority generation,
  revision, audience, command, receipt, and digest substitution;
- duplicate, delayed, reordered, gapped, expired, and snapshot-rebuilt feeds;
- disposition dependency order, crash resume, duplicate owner receipts, and
  conflicting category actions;
- legal-hold retention, missing hold evidence, shared-key crypto-erasure
  rejection, and exclusive-key crypto erasure;
- provider `not_found`, unknown worker residue, backup restore, and stale worker
  attempts to resurrect disposed authority or identities.

No conformance test may use a real user project, credential, provider request,
or MCP server.

## Consequences

- Product suspension and reauthorization can integrate with AR without making
  Orchestrator authority an AR domain concept.
- Operation, session, and scope retain honest aggregate boundaries and do not
  promise impossible atomicity with provider side effects.
- Consumers can distinguish authority fencing, canonical-output fencing,
  provider containment, and effect reconciliation instead of guessing from one
  overloaded state.
- Safe unrelated work need not remain blocked solely because an earlier
  business outcome is unknown, while exact duplicate effects remain fenced.
- AR remains technically idempotent without pretending to understand product
  semantics.
- Scope disposition becomes implementable and auditable without importing
  product lifecycle or legal policy into AR.
- The authority, dispatch-claim, and canonical-output seam is an explicit
  transactional extraction boundary; other modules may split independently,
  but this seam cannot be replaced by check-then-act RPC without a new protocol.

## Relationship to prior decisions

This ADR is normative with ADR-0001 and ADR-0002. It refines:

- ADR-0001 revocation, dispatch, semantic-effect, and successor rules;
- ADR-0002 execution reconciliation, effect-ledger, and tenant-retirement
  rules;
- the supporting execution-generation model's cutoff and successor barriers.

Where older text suggests one session cutoff for every target, one combined
enforcement state, policy-selected containment, or AR inference of business
effect equivalence, this ADR controls. It does not change the four bounded
contexts, private-fence rules, owner-local reconciliation, no-blind-retry
policy, or truthful `outcome_indeterminate` requirements.

The next contract decision must define the physical Published Language
artifact, version handshake, generated clients, fixtures, compatibility
checks, and exact wire schema. It may rename provisional terms but cannot merge
the consistency boundaries or weaken the invariants accepted here.
