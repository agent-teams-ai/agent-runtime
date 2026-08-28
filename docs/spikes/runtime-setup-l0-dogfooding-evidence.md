---
id: evidence.runtime-setup-l0-dogfooding
type: evidence
status: evidence-reference
owner: architecture/qualification
summary: Records executable evidence for the product-owned Runtime Setup Pure DI baseline and measured gates for any later module layer.
---

# Runtime Setup L0 dogfooding evidence

## Scope and authority

This evidence evaluates the private Pure DI composition accepted by
[ADR-0008](../decisions/0008-private-embedded-runtime-access-entrypoint.md).
The exact product source revision and content digests are retained in
[the machine evidence](runtime-setup-l0-dogfooding-evidence.json).
The observable outcomes are detached, safe Codex and Claude Code setup
previews. They are sibling capabilities with distinct contracts, not
implementations competing for one module slot.

L0-L5 in this evidence are an experiment-local composition rubric. They do not
replace the repository readiness or qualification vocabulary and cannot
authorize implementation by themselves.

Ownership stays split:

| Owner | Responsibility in this slice |
| --- | --- |
| Embedded Runtime | Private API, trusted scope, cross-context composition, detached projection, and Host disposal |
| Runtime Security | Setup-inspection authorization |
| Agent Execution | Runtime installation observation |
| Runtime Configuration | Provider-specific configuration inspection |
| Extension Foundation | Product-neutral evaluation mechanisms only; no Agent Runtime product semantics or production bindings |

## Traces

Construction and invocation are separate traces.

    Construction
    createDefaultAgentRuntimeHost
    -> concrete owner adapters
    -> owner-local feature factories
    -> closed Codex and Claude capability dependency bundles
    -> createAgentRuntimeHost
    -> frozen, scope-bound RuntimeAccessHandle

    Invocation, once per capability
    RuntimeAccessHandle.<capability>.inspect
    -> owning product view builder
    -> Runtime Security authorization
    -> Agent Execution and Runtime Configuration use cases
    -> redacted, deeply frozen result

The machine evidence names every traced source file, symbol, and owner. Export
barrels are not represented as runtime calls.

## Executable method

**pnpm architecture:runtime-setup-l0-evidence:capture**:

- requires full Git history for every retained product change;
- runs the exact embedded-runtime package check on the capture platform;
- rejects skipped tests;
- hashes the package-check output;
- hashes the complete relevant source, test, and fixture sets; and
- writes the evidence manifest at the current product source revision.

**pnpm architecture:runtime-setup-l0-evidence** then:

- validates the closed L0-L5 verdict shape;
- verifies every traced symbol;
- parses static exports/imports, import-equals, dynamic imports, and require
  calls with the exact-pinned Oxc parser;
- fails closed on non-literal dynamic dependencies in inward-facing code;
- rejects outward-layer, container, registry, Cordis, Awilix, Module Runtime,
  and Foundation imports from application and contract code; and
- recomputes content digests and historical measurements when full history is
  available.

The general Engineering Foundation source-dependency gate remains authoritative
for package boundaries. This evidence adds only the narrower product claim and
does not create a competing architecture policy.

## Behavior acceptance

The L0 contract suite must cover:

- success and a real authorization denial;
- installation-observer and configuration reader/parser failures;
- absent or malformed setup without provider execution;
- cancellation before invocation, during authorization, and during parallel
  owner branches;
- sibling failure and branch settlement;
- concurrent caller and trusted-scope isolation;
- a non-cooperative dependency;
- repeated and concurrent disposal;
- bounded disposal timeout; and
- post-disposal rejection.

Runtime Setup is passive. A provider process failure is not an L0 scenario and
requires a separately authorized execution or provider-qualification campaign.

Every capability published by the handle must receive one complete dependency
bundle before bindAccess. Missing, partial, malformed, or unknown bindings are
composition defects and fail synchronously; they never become authorization
outcomes.

## Measurements and decision rule

Historical commits provide only diff-derived evidence:

- changed composition files and physical additions/deletions;
- changed production and test files; and
- exact-title retention for existing embedded-runtime behavior tests.

They do not prove navigation time, incorrect edits, or diagnostic quality.
Those measures require a prospectively declared task, model, source revision,
timer boundaries, expected owner/root, and scored final recommendation.

Three exact-SHA, read-only hosted benchmarks retain their complete prompts,
prompt hashes, canonical redacted result envelopes, normalized measurements,
and verdicts in the machine evidence. Prompts are hashed as UTF-8 bytes with
one terminating LF. The checker reads every retained envelope, recomputes its
canonical JSON hash, and derives the generated evidence row from those bytes.
The benchmarks cover owner/root navigation, fail-closed binding
diagnostics, and planning a prospective passive OpenCode sibling capability.
All three returned HOLD. The OpenCode probe estimated eight composition files
and about 230 glue lines, but found no duplicated neutral binding fact; it also
identified the existing AR-3 architecture freeze as a prerequisite. These are
exploratory probes, not three completed ordinary product changes, so they do
not satisfy the promotion rule.

A binding fact is the tuple:

    consumer factory
    + dependency slot
    + provider symbol
    + scope or lifetime
    + authority owner

The guides of three changed composition files, 60 composition glue lines, ten
minutes to diagnose, and 80 percent reused applicable behavior fixtures are
signals, not CI thresholds. L1 remains closed unless at least two of three
prospective ordinary product changes expose the same neutral composition
problem without violating ownership or authorization boundaries. Missing or
ambiguous evidence means HOLD, not promotion.

## Current verdict

L0 is the only admitted product shape: literal imports, closed plain dependency
objects, feature-local factories, one trusted composition root, and one
Host-owned lifetime. Capability contracts expose no module, container,
registry, repository, transport, or lifecycle framework type.

L1 remains a measurement candidate. Existing changes show legitimate
cross-context composition work but do not prove a useful declaration grammar,
duplicate authority, or a runtime provider slot.

L2-L5 remain no-go. No product outcome currently requires implementation
selection without rebuild, generic module lifecycle/recovery, process or WASM
placement, plugin distribution, or a shared Foundation runtime. Host disposal
does not prove a generic module lifecycle.

## Future adapter gate

A Module Kit adapter requires a separate product decision. It must:

- construct the same closed capability bundles;
- invoke createAgentRuntimeHost(dependencies) exactly once per Host;
- run the identical product contract suite;
- perform no direct use-case calls, persistence, shadow writes, or duplicate
  effects;
- bootstrap Module Kit itself through literal imports rather than its own
  graph; and
- keep createDefaultAgentRuntimeHost() as the direct reference path.

Fallback is allowed only before publishing a handle and before any operation
starts. Partial construction is disposed. Ambiguous outcomes or incomplete
disposal quarantine the candidate instead of running old and new graphs
concurrently.

## Limitations

- The evidence does not prove a released provider binary, Desktop integration,
  or deployment qualification.
- Historical test-title retention is a conservative proxy, not semantic
  equivalence.
- Navigation benchmarks are exploratory until their predeclared prompts,
  oracles, normalized rows, and result hashes are retained. Retention makes
  them auditable but does not turn hypothetical work into promotion evidence.
- A shared conformance kit may precede shared runtime extraction only after two
  independently owned product implementations exist. It cannot invent the
  second implementation or product semantics.
- This evidence cannot authorize a declaration grammar, graph, lifecycle,
  plugin host, public SPI, or shared runtime package.
