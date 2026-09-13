---
id: ARCH-COMMON-ASSEMBLY
type: architecture
status: active
owner: architecture
summary: Bounded plan and execution contract for the optional assembly component above Core.
related:
  - ADR-0023
  - ADR-0026
  - ARCH-CURRENT-CONTRACT
  - ARCH-MVP-IMPLEMENTATION-ROADMAP
---

# Common assembly

## Scope and authority

The owner approved a thin optional `@get-modular/assembly` package. Core remains
pure and unchanged. Assembly depends only on the public Core root; Host supplies
already selected and authorized factory functions and its capability types.
Construction success does not establish readiness, trust or permissions.

One construction feature owns handles, preparation and sequential execution.
No service locator, global service registry, discovery, dynamic imports,
scheduler, retry, automatic rollback, disposal, readiness, generations or hot
replacement. The internal Core emitter remains private and required-only.

## Consumer module standard

[ADR-0026](../decisions/0026-adopt-consumer-module-standard.md) accepts this
central authoring and adoption contract. It applies to new composition boundaries
inside a consumer's explicitly accepted Host scope. It does not migrate a product
or certify existing code merely because that product installs Assembly.

### Authority and identity

The organization [Feature Module Standard v1](feature-module-standard.md#adoption)
remains the sole authority for semantic ownership, layers, feature layout,
dependency mechanisms and extraction. Its immutable identity is Git blob
`d0bfff2033faf544fe65268c1dcdfd524d093015`, SHA-256
`851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa`.
The linked local profile maps Get Modular itself, not all consumers.

The [current contract](current-contract.md) and this Assembly contract own graph
compilation, exact bindings, preparation and construction handoff. Host owns
permissions, resources, readiness and lifecycle. The local accepted adoption
ADR and consumer profile own concrete roots, composition owners, package pins,
legacy boundaries, exceptions and actual verification commands. None may weaken
organization rules or infer repository-wide conformance from one adopted slice.
Foundation remains this repository's source classifier and dependency policy
engine; this standard does not introduce another import parser.

A consumer pins this document's repository, path, anchor, exact Git commit and
SHA-256 of the complete document bytes, plus its accepting ADR identity. Keep
this one current document; package SemVer, compatibility tokens, profile schema
versions and document content pins are different identities. Local copies are
non-authoritative evidence only.

### New composition boundaries

Every new production capability needs a semantic owner. A bounded context,
package, feature and Assembly handle need not map one-to-one. Inside accepted
Host scope, independently assembled capabilities, alternative implementations
and configurable inter-module relationships must use consumer-owned ports and
a single Core/Assembly composition root. A local adoption can make this optional
library mandatory for that scope.

Fixed library dependencies and private helpers inside a cohesive feature remain
static imports and typed factories. A parser, mapper, DTO, class or endpoint is
not a graph node merely because it is new. Cover real composition seams, not a
quota of handles. Each wiring relationship uses one organization dependency
mechanism. Static composition does not imply runtime plugin discovery; runtime
selection, variable dependencies or independently managed lifecycle require an
explicit demonstrated need for the runtime mechanism.

Keep declarations, profiles and handle mapping in the outer composition adapter.
Domain and application code must not import Core, Assembly, registration types,
SDK or transport DTOs, or selected concrete port implementations. Features expose
narrow typed factories and consumer-owned dependency records. Preserve owned
Published Language and anti-corruption boundaries; shared domain identities or
generic repositories are not justified by similar code alone.

There is one production composition authority: the profile selects bindings,
owner-local factories materialize capabilities, and Host receives closed roots.
Do not retain a second direct production assembly, instance fallback, string
lookup, mutable registry, global container or registration-order semantics.
Keep IDs and compatibility tokens in one local typed source. Preserve literal
inference; production wiring must not use `any`, double casts through `unknown`
or broad casts to hide capability, token or slot mismatches. A justified exact
exception needs an accepted rationale and a rejecting test; it cannot authorize
a false type claim.

Construction may be async without making domain APIs async. Preserve Host-owned
cleanup, the created journal and untransferred returned-product handoff. Do not
introduce a generic lifecycle manager for passive construction.

| Use | Reject | Evidence |
| --- | --- | --- |
| Cohesive feature with closed ports | Business policy in a giant root | Existing layer gate and ownership review |
| Exact implementation and capability | Instance fallback or second resolver | Independent mapping and zero-call negative tests |
| Local private parser or helper | Node per class or endpoint | Positive fixture and semantic review |
| Composition adapter imports | Assembly inside domain/application | Existing source policy and negative import fixture |
| Existing Host cleanup | Duplicate disposal through shared capabilities | Failure, cancellation and handoff tests |
| Independent direct test reference | Production fallback or oracle derived from profile | Binding mutant and parity test |

### Scoped acceptance and evidence

An adopting consumer must provide an accepted local decision and a profile with:

- Central document and organization authority pins; exact reviewed package and
  lock/archive identities under existing package policy.
- Declared production roots, active wiring scope, owner, materialized entrypoint,
  declaration/profile/factory paths, dependency mechanism and test mapping.
- Exact existing legacy boundaries and direct relationships, marked `not-adopted`,
  with rationale, owner and review trigger. This inventory is not an FMS
  violation baseline and must not weaken an existing activation's prohibition
  on grandfather lists.
- Exact accepted exceptions with rule, paths, owner, rationale, decision and
  review trigger. No wildcard, blanket directory exemption or automatic legacy
  inventory expansion. Reject stale entries.
- Actual blocking commands, reciprocal references and evidence for the precise
  claimed slice. Package installation or a successful library test is not
  consumer adoption evidence.

At activation, the consumer gate must discover new production boundaries through
its existing topology/source inventory. Unknown boundaries fail until explicitly
adopted or classified. New cross-module or replaceable relationships inside a
legacy boundary require current adoption or an exact accepted exception. An
ordinary fixed-dependency classification is valid only inside its owning feature.
The gate must reject drifted pins, missing paths, removed/no-op command chains and
unknown or stale exceptions. These requirements become an enforced consumer claim
only with positive and rejecting fixtures in that consumer's fast and full gates.
This documentation checkpoint does not claim that a consumer checker exists.

Evidence includes unchanged existing FMS scope, adopted wiring, allowed private
helpers and declared legacy; rejection of unknown boundaries, new direct legacy
edges, invalid exceptions, pin drift and forbidden layer imports; typed rejection
of wrong capability/token/slot and a missing await on an async Host constructor; independent
binding parity, zero factories on preparation failure, attempt isolation and
Host failure/cancellation ownership; and packed imports through public roots on
exact approved artifacts in a disposable directory. Semantic review must also
look for new capabilities hidden inside existing functions: a static inventory
does not prove all ownership or domain design rules.

### Executable examples and adoption status

The existing [synthetic Host source](../../tests/assembly/fixture.mjs)
and [runtime assertions](../../tests/assembly/runtime.test.mjs) exercise
required, optional and ordered-many bindings, sharing and Host cleanup.
[Preparation regressions](../../tests/assembly/preparation.test.mjs)
check invalid wiring before effects; [typed fixtures](../../tests/assembly/types.test.mjs)
and the [packed consumer](../../tests/assembly/packed-consumer.mjs)
cover the public carrier. These belong to the existing `pnpm assembly:test`
command, invoked by both fast and full gates, after `pnpm assembly:build`.
Consumers must additionally link their own executable slice and independent
binding oracle; copied Markdown examples do not count as evidence.

Agent Runtime is a planned consumer, not an adopted product claim here. Core
self-composition and synthetic/packed Hosts are library evidence, not independent
production consumers. No consumer ledger entry or repository-wide conformance is
created by this decision. Record reciprocal consumer evidence only after that
consumer's exact scoped acceptance gates pass. Contained-turn migration, full
legacy conversion and shared checker extraction require separate scope.

## API and metadata ownership

`assemblyFor<C>()` selects Host-owned capability value and exact compatibility
identities at type level. It stores no service registrations or instances.
`bindFactory(declaration, asyncFactory)` returns an identity-authenticated handle.
A private WeakMap holds handle metadata; copying descriptors, symbols or prototype
cannot forge a handle. This is identity checking, not code authorization.

`bindFactory` synchronously snapshots declaration metadata and captures the
function before returning. The original is neither frozen nor read again.
Preparation and execution use this same snapshot. Mutation from required to many
must never change an existing callback's injection contract. Malformed metadata
causes a stable binding error before any factory call; Core owns semantic rules.

`prepare({ composition, factories, roots })` accepts a successful Core result,
the exact selected handles, and an alias-to-root-handle mapping. Handles must be
unique and cover every selection exactly once. Each root has exactly one alias
and refers to the same supplied handle. No extra handles or alias getters.

`C` is invariant across handles. Literal declaration inference is controlled by
the declaration, not widened by the callback. Required slots yield `T`, optional
slots an own field `T | undefined`, and many slots a frozen `readonly T[]`.
Widened declarations do not confer a statically precise injection contract.

Factories receive only their closed dependency record and `{ signal }`. Each
fulfills with `{ instance, capabilities }`. Instance is for Host, including roots
without provides. Capabilities has exactly the declaration's own capability keys.
Injection selects by provider implementation ID AND capability ID, never instance
as fallback. A present capability with value `undefined` is distinct from a missing
key. Different capabilities and instance may be three different objects.

## Preparation and resource envelope

Before the first await, capture the successful result, handle list and root map.
Inspect own data descriptors, dense arrays and exact shapes without invoking
getters. Pre-count individual and aggregate sizes before proportional copying.
Reject unexpected keys before projecting the supplied plan into a profile.

The local carrier ceiling for supported Core 0.1 is: 4096 handles, selections and
order entries; 1024 roots; 65536 bindings; 1024 providers per row; 262144 provider
occurrences overall. Declarations have at most 64 provides and 128 slots each,
65536 of each overall; owner paths at most 8 segments. Every metadata identifier
has at most 128 UTF-8 bytes. Root aliases are bounded to 128 UTF-8 bytes and 1024
entries. Validate alias own-key counts too. These are structural allocation
ceilings, not another graph engine. No private Core imports. Changes to supported
Core require rechecking this table against its successful-plan envelope.

Restore a complete profile from the captured plan and invoke public
`compileComposition` on captured handle declarations. Compare the entire returned
plan and digest to the supplied snapshot, including every ordering, capability and
compatibility field. Core alone validates grammar, cardinality, graph closure and
canonical order. Use fixed-schema comparison, not user `toJSON`/serialization.
No product factory is called until every binding and root passes. Expected
preparation failures return a discriminated result, preserving Core diagnostics
separately. Unexpected pre-effect internal errors may reject preparation.

Prepared state contains only immutable instructions and function references.
Metadata is cooperative Host-owned data. Reflection on executable Proxy objects
may run code; these are not safe data. Modified intrinsics, arbitrary heap pressure
and a fixed wall-clock bound are outside the contract. No raw-byte input ceiling
is misrepresented as an enriched plan ceiling.

## Execution and Promise carrier

`prepared.run({ signal })` is async and sequential in dependencyOrder. Exactly
one invocation per selected implementation per attempt. Many injection preserves
providerImplementationIds order. Diamond consumers share capability references
within an attempt; repeats, concurrent and finite nested runs have separate maps,
ordered journals and cursors. Host factories may themselves return singletons;
assembly cannot guarantee otherwise.

Dependencies, many arrays, metadata and journals belong to assembly and are
frozen. Dependency/capability records have null prototypes and exact own keys.
Instance objects, capability values, causes, closures and signals remain opaque,
are not deeply frozen, logged or copied. Library internals never await a nested
capability, including one with a callable `then`.

The supported factory carrier is a current-realm Promise with ordinary
Promise.prototype and no own string properties, under unmodified intrinsics.
Own symbol data properties used by Node async context tracking are permitted and
ignored; symbol accessors are rejected without invocation. Inspect
its prototype/own descriptors before intrinsic Promise observation; reject a
constructor getter without invoking it. Direct thenable objects and subclasses are not
supported or assimilated. Intrinsic observation verifies the internal brand.
Observe fulfillment inside a safe ordinary wrapper, never resolving another
Promise with the raw product. Promise resolution performed by the factory itself
(for example `async () => thenable`) is factory execution and outside the library's
no-assimilation promise.

## Outcomes and ownership transfer

Outcomes are closed unions: succeeded with typed roots and created; failed with
phase, stable code, implementation ID when applicable, original cause and created;
cancelled with reason and created. A failed outcome separately records observed
cancellation. Each created entry carries module ID, implementation ID, instance
and a snapshot of its capabilities, in creation order.

Immediately after fulfillment, retain the raw current product until its journal
entry is committed. Malformed completion or an internal error in this interval
returns previous created AND the same untransferred returned product/implementation
ID. After commit it appears exactly once in created. No later factory or library
cleanup runs after failure. Memory exhaustion preventing the failure result itself
and process termination are outside this handoff guarantee.

Resources not returned by a rejected factory belong to that factory or its
Host-owned resource owner. Host defines cleanup policy. A journal entry is not a
claim of independent resource ownership: do not dispose the same shared resource
through provider, consumers and multiple capability references.
The resource owner is known before construction handoff and registers cleanup
at acquisition; receiving a capability gives no cleanup authority. An async
provider remains responsible for allocations it fails to hand back. A one-shot
Host uses roots within their protected lifetime and returns an inert summary
after cleanup, not graph references to the closed scope. Opaque failure causes
remain opaque; a summary does not certify that those causes contain no references.

A new profile does not update previously delivered references. Construction
success remains distinct from Host readiness and lifecycle publication.

An already aborted signal yields cancelled with no calls. Check before each
factory and before success commit. Await an already running factory after abort;
no Promise.race with cancellation. Valid late fulfillment is recorded in the journal then returns
cancelled; rejection, invalid fulfillment or an internal error returns failed,
with cancellation recorded separately. An uncooperative pending factory can keep
run pending; Host owns deadlines and isolation. Terminal outcomes do not change.

## Delivery phases and ownership

- A0: record ADR/package admission and this reviewed contract. Preserve accepted
  history. Integrator owns documentation, authority and repository-wide guards.
- A1: implementation worker owns packages/assembly and its private build entry.
  Include manifest, workspace dependency, tsconfigs, build/typecheck/test commands
  and source mapping alongside the first substantive preparation code. No run stub
  or unusable standalone checkpoint. Integrator connects shared root gates.
- A2: same feature owner implements execution and the synthetic vertical slice.
  A1/A2 may be one coherent review checkpoint when the public API needs both.
- A3: packed consumer, minimum/build TypeScript checks, final independent review,
  docs and full repository gate. No publication or real Agent Runtime migration
  follows merely from this assembly implementation checkpoint.

The synthetic Host has store, filters a/b sharing store, and root app with required
store, optional logger and ordered-many filters [b,a]. Prove order-dependent output,
then a second profile with logger and reversed many. Show Host-owned cleanup after
failure without duplicate resource disposal. Core's retained consumer example is
historical evidence and is not overwritten.

## Definition of done

- Full-plan tampering, missing/duplicate/extra/forged handles, incomplete roots and
  late invalid bindings refuse with zero factory calls. Digest/order/capability
  changes refuse. Explicit absent optional binding is required.
- Snapshot mutation after bind and immediately after prepare cannot change wiring;
  getter counts stay zero for supported malformed records.
- Test individual boundary/plus-one sizes and aggregate provider overflow before
  compiler calls, including actual Core acceptance at the supported upper bound.
- Required/optional/many shapes, several distinct capabilities, roots without
  provides, sharing, many order and defined-undefined values behave as specified.
- Pending factories prove sequentiality; repeated/concurrent/nested attempts stay
  isolated. No import-time product factory calls or runtime fallback.
- Throw, primitive rejection, malformed completion, controlled internal failure
  before journal commit, and every abort/settlement ordering preserve ownership.
- Reject unsupported direct thenable and own-constructor-getter Promise without
  executing either; opaque instance/capability then methods remain untouched.
- Positive typed consumer uses no wiring casts/any; negative fixtures reject wrong
  capability/compatibility, undeclared slots, mutable many, widened declarations,
  callback inference widening and incompatible mappings. Test minimum TS 5.8.3 and
  pinned build compiler, resolver modes, and a large literal declaration fixture.
- Packed-root consumer installs only supported files/dependencies and runs the
  synthetic Host. Core never imports assembly; no development tooling leaks.
- Focused assembly gates, check:changed, check:fast, one final full check and
  independent exact-source review pass. Record evidence and remaining limitations.

## Historical Core evidence and current admission

The [assembly admission checker](../../architecture/checks/assembly-admission.mjs)
authenticates ADR-0023 and the admitted manifest before separating Assembly paths
from the unchanged Core scope. Under
[ADR-0024](../decisions/0024-separate-historical-m2-lock-custody-from-current-dependencies.md),
current admission checks the exact workspace importers and Assembly-to-Core edge;
root tooling resolutions evolve under current dependency and frozen-install gates.
The separately authenticated historical M2 lock witness preserves the original
ledgers, verifier and retained test bytes. The legacy direct reader retains its
strict reconstruction without coupling current admission to the historical lock.

[Admission regressions](../../tests/assembly-admission.test.mjs) reject graph drift,
changed authority and packages outside the admitted scope. The current
[retained replay adapter](../../tests/assembly-admission-retained.test.mjs) preserves
the historical cases and explicitly proves that the old verifier still rejects
current lock bytes without the authenticated transition. This finite transition
does not itself establish current installation readiness or change historical evidence.

Public Assembly 0.1.0 admission additionally authenticates
[ADR-0025](../decisions/0025-publish-assembly-0-1-0-with-core-0-1-0.md).
Historical private admission retains its original authority. Publication follows
retained-byte and registry consumer checks; admission alone proves no release.
