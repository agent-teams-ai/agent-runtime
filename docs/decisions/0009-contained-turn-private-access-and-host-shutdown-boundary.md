---
id: ADR-0009
type: adr
status: accepted
owner: architecture
summary: Defines the private scope-bound contained-turn handle, durable cancellation semantics, and Host shutdown boundary.
related:
  - ADR-0001
  - ADR-0002
  - ADR-0003
  - ADR-0004
  - ADR-0006
  - ADR-0008
  - ADR-0010
code_anchors:
  - enforcement: required
    pattern: experiments/runtime-profile-behavior/spec/runtime-operation-oracle/contained-turn-v1-contract.json
---

# ADR-0009: Contained turn private access and Host shutdown boundary

Status: accepted

Date: 2026-08-29

## Context

ADR-0008 accepts a private Embedded Runtime composition entrypoint and a
scope-bound `RuntimeAccessHandle`; it intentionally does not expose the Host or
its dependency container. ADR-0010 accepts one narrow contained agent turn
while leaving proposed ADR-0006 unchanged.
The missing authority is the composition product ordinary callers receive,
the meaning of caller abort and durable cancellation, and the semantic boundary
between operation truth and Host shutdown.

This companion decision adds that authority without rewriting ADR-0008. It
does not accept any ADR-0006 feature deferred by ADR-0010 and does not authorize production
provider, persistence, workspace, custody, SDK, or Embedded Runtime code.

## Decision

### Closed trusted composition

The composition root selects the exact provider adapter before constructing a
contained-turn product. One direct Pure DI factory receives one closed,
read-only dependency object containing only the operation store, security,
workspace, artifacts, custody, and selected provider adapter. Construction is
synchronous, effect-free, and resource-free. Dependencies cannot be discovered
through a container, service locator, global, feature registration API, module
registry, or caller-supplied provider session.

The factory returns a product-private capability used only to build the
ordinary caller's existing scope-bound `RuntimeAccessHandle`. The handle
exposes contained-turn submit, observe, and request-cancellation operations for
its trusted scope. It does not expose the product capability, Host, dependency
object, provider adapter/session, container, disposal capability, receipt
writer, state transition primitive, or authority owner. Capabilities are
detached from composition machinery after construction.

The handle is valid only for the immutable trusted scope and authority revision
bound by the composition root. It cannot widen tenant, project, workspace,
Provider Access, credential, custody, or operation authority.

### Durable cancellation meaning

A caller cancellation request is an authenticated command, not an outcome. It
becomes durable cancellation authority only after the authoritative operation
owner accepts the exact command digest and scope at the current revision and
persists the resulting fence or cutoff transition. Caller abort, lost client
connection, timeout, task cancellation, or dropping the handle provides no
such proof.

Durable cancellation means that the owner accepted a cancellation command and
the applicable operation fence is durably closed. It does not mean provider
execution is contained, the provider did not accept dispatch, the coarse
effect is resolved, output is drained, or terminal requirements are closed.
Those facts require their own receipts under ADR-0010.

Therefore neither ordinary callers nor the handle can manufacture durable
cancellation, provider containment, `known_not_accepted`, effect resolution,
or terminal truth.

### Host disposal and shutdown

Host disposal is a resource-lifecycle signal. It closes admission to new work,
requests durable cutoff for every in-scope nonterminal operation, executes the
configured containment actions, drains observations, and releases Host-owned
resources only when their custody and receipt protocols permit. Shutdown
progress is observed through the operation owners and typed receipts.

Host disposal or process exit is never itself a cancellation receipt,
containment receipt, provider-termination receipt, effect-resolution receipt,
output-drain receipt, or terminal result. Disposal may leave an operation
nonterminal with `reconcile_required`. The Host cannot report a clean shutdown
while an operation's required containment or custody work is merely abandoned;
the runtime must preserve durable truth for later reconciliation.

The private Host shutdown capability remains at the trusted composition root.
It is never included in an ordinary `RuntimeAccessHandle` and cannot be invoked
through a feature, module, or provider API.

### Identity and lifecycle separation

Contained-turn authority uses distinct namespaces for `OperationId`,
`EffectId`, `AttemptId`, command identity, receipt identity, workspace identity,
Host instance and boot identity, custody identity, and authority revision.
None may alias another by equal text, shared prefix, wrapper conversion, or
semantic reuse.

Future module identities, module-generation identities, plan digests, loaded
heads, and module lifecycle values are also disjoint. Module lifecycle can at
most describe whether module composition is available; it can never mean that
an agent operation was accepted, dispatched, cancelled, contained, reconciled,
or terminal. This V1 has no Module Kit dependency.

### Authority evidence

The existing operation-oracle authority contains a contract fixture for the
closed dependency set, detached handle surface, trusted-scope checks, identity
matrix, lifecycle matrix, cancellation meanings, and Host-shutdown negatives.
It also records Foundation PR 22 and PR 27 exact heads as non-authoritative
inputs. The fixture is architecture evidence, not a production composition
root or provider adapter.

## Consequences

- Ordinary callers receive only the trusted scope-bound
  `RuntimeAccessHandle`; all stronger capabilities remain private.
- Cancellation, containment, effect resolution, and terminal truth remain
  separate durable claims even during shutdown.
- A Host shutdown can complete resource disposal only in accordance with
  custody and receipt truth; it cannot improve operation state by assertion.
- Future module work must port the fixture's separation guards without
  importing module domain models into Agent Runtime.
