# ADR-0004: Pre-materialization dispatch prevention

Status: accepted for the architecture foundation

Date: 2026-08-02

Implementation status: no command handler, persistence schema, Published
Language, or deployment target is implementation or production qualified by
this ADR. Exact command, field, receipt, and enum names remain a follow-up
contract decision.

## Context

ADR-0003 defines operation, session, and runtime-scope cutoff and makes the
durable dispatch-claim compare-and-swap the linearization point before provider
side effects. An operation cutoff normally targets an accepted
`RuntimeOperation`.

A consumer may nevertheless need to revoke one durable operation intent before
AR has accepted the original command or returned a `RuntimeOperationId`:

```text
consumer commits original command to outbox
-> prevention reaches AR first
-> AR reports target not found
-> delayed original command reaches AR
-> provider dispatch starts after product authority was revoked
```

A scoped `not_found`, absent projection, timeout, or missing operation reference
cannot close this race. AR needs durable negative knowledge that serializes with
later acceptance of the original command.

The same boundary also constrains automated successor operations. AR does not
own business equivalence, but it must be able to enforce an exact opaque effect
identity supplied by the semantic owner when automated retry, recovery, or
reauthorization crosses RuntimeOperation identities.

## Decision

### Scoped operation-intent guard

AR supports a durable negative guard against the original operation intent.
Exact Published Language names remain open. The guard is bound to:

- AR tenant and runtime-project scope;
- logical runtime deployment and deployment incarnation;
- the original operation command identity and expected canonical request digest;
- an opaque caller target-intent correlation when supplied;
- every applicable runtime-scope and external-authority precondition;
- the prevention command identity and canonical digest.

The original operation command handler, prevention handler, and dispatch-claim
CAS serialize on this scoped intent identity in the same Agent Execution
transactional authority store. A synchronous check followed by a separate write
is insufficient.

The winning order has exact semantics:

1. If prevention wins before operation acceptance, AR persists the negative
   guard and its durable receipt. A later matching original command is rejected
   before a `RuntimeOperation` or provider side effect is created.
2. If operation acceptance wins but dispatch claim has not, prevention fences
   the accepted operation before provider dispatch and produces operation-target
   barrier evidence.
3. If dispatch claim wins first, prevention commits the normal monotonic
   operation cutoff and reports that containment and effect reconciliation may
   still be required.
4. Reuse of either command identity with a different digest is a conflict. A
   wrong-tenant, wrong-scope, wrong-incarnation, or stale-authority request fails
   closed without disclosing another target.

The negative guard is command and admission state. It is not:

- a fourth cutoff target;
- provider cancellation or containment;
- proof that an external effect did not occur after dispatch claim;
- a product Run, task, or business-authorization concept;
- a transport inbox deduplication record.

Its receipt proves pre-dispatch prevention only when the negative guard or
accepted operation fence won before dispatch claim. A scoped `not_found` result
without a committed negative guard is never terminal prevention evidence.

### Retention and anti-resurrection

The negative guard and its compact retirement proof survive the complete retry,
outbox replay, restore, and stale-writer resurrection horizon of the original
command. Garbage collection cannot make the original command executable again.

Physical command receipts may compact before the retirement proof only when the
remaining proof still rejects the original scoped identity and conflicting
digest. Removal is allowed only after retirement of the complete applicable
identity namespace and closure of every restore path that can replay the
original command.

Exact tables, lock strategy, partition key, receipt names, retention duration,
and retirement-root representation remain implementation and Published Language
decisions. They cannot weaken the anti-resurrection invariant.

### External effect identity

An effectful operation that a caller wants AR to retry, recover, or reauthorize
automatically across distinct RuntimeOperations must carry a stable opaque
external effect identity and its versioned immutable fingerprint from the first
operation intent.

AR binds them to its technical effect ledger and rejects exact identity reuse
with a conflicting fingerprint. AR does not compare prompts, payloads, commands,
or product intent to infer semantic equivalence.

If the external identity capability is absent or unqualified, an unresolved
predecessor blocks automated same-effect successor dispatch. The caller cannot
obtain safety by minting another identity. An unrelated effect may proceed only
under the predecessor barriers and product policy already defined by ADR-0003.

## Forbidden transitions and claims

The domain and conformance suite reject:

- delayed acceptance of an original operation command after its negative guard
  committed;
- treating target absence, provider `not_found`, timeout, or projection state as
  prevention evidence;
- dispatch claim implemented as check-then-act across separate stores or RPCs;
- reuse of an original or prevention command identity with a conflicting digest;
- garbage collection or restore that makes a prevented identity executable;
- automatic same-effect successor dispatch without qualified stable external
  effect identity when the predecessor outcome is unresolved;
- AR inferring business-effect equivalence between distinct external identities.

## Conformance requirements

Implementation qualification requires deterministic synthetic tests for:

- prevention arriving before the original operation command;
- prevention after operation acceptance but before dispatch claim;
- prevention after dispatch claim;
- all concurrent commit orders between original acceptance, negative guard, and
  dispatch claim;
- delayed and restored original outbox delivery against a retained guard;
- exact replay of original and prevention commands and digest conflicts;
- cross-tenant, cross-scope, wrong-incarnation, stale-authority, and audience
  substitution;
- receipt loss followed by query or feed replay;
- compaction, backup restore, stale-writer resurrection, and retirement-root
  enforcement;
- provider side-effect instrumentation proving no external call when prevention
  wins;
- effectful automated successor admission with missing, conflicting, reused, and
  qualified external-effect identity evidence.

No conformance test may use a real user project, credential, provider request, or
MCP server.

## Consequences

- Orchestrator cutoff can safely target a durable local intent before it learns
  an AR RuntimeOperation identity.
- Delayed outbox delivery cannot resurrect revoked operation authority.
- AR preserves its three cutoff targets and does not import product semantics.
- The command and admission authority store carries an additional durable guard
  and anti-resurrection retention cost.
- Automated same-effect successor behavior becomes explicit and testable rather
  than an accidental property of command IDs.

## Relationship to prior decisions

This ADR is normative with ADR-0001, ADR-0002, and ADR-0003. It refines
ADR-0003's operation dispatch linearization and command-disposition rules without
adding another cutoff target or bounded context.

The next Published Language decision may rename every provisional term. It must
retain the scoped original-command reference, expected digest, negative-guard
receipt semantics, dispatch-claim ordering, effect-identity capability, and
anti-resurrection requirements accepted here.
