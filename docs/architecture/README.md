---
id: runtime.architecture.index
type: index
status: active
owner: architecture
summary: Index of supporting Agent Runtime architecture documents.
related:
  - ADR-0001
  - ADR-0002
---

# Architecture

This directory records supporting architecture for Agent Runtime. Normative
ownership and recovery decisions are in `docs/decisions/`.

The documents in this directory and ADR-0001 were authored on parallel sibling
branches. ADR-0002 reconciles them. These documents remain accepted only as
amended by ADR-0001, ADR-0002, ADR-0003, and ADR-0004; they are not an
independent competing source of truth.

Documents:

- [Get Modular adoption](get-modular-adoption.md): planned passive setup scope,
  ADR-0015 authority, unresolved artifact/pin gates, and L0 transition contract.

- [Contained-turn Consumer Module Standard pending adoption](contained-turn-consumer-module-standard-adoption.md):
  current seven-port legacy classification and rejecting gate without extending
  the active passive setup Assembly scope.
- [Feature Module Standard v1 scoped active adoption](feature-module-standard-v1-candidate.md):
  exact immutable authority binding, scoped active modules including Embedded
  Runtime host-app activation, deterministic gates, and zero-diagnostic
  evidence. This is not repository-wide conformance.
- [Architecture foundation](architecture-foundation.md): ownership, DDD
  boundaries, dependency rules, persistence, public API, and quality gates.
- [Execution generation model](execution-generation-model.md): execution
  authority, custody, reattach, successor activation, output scope, and stale
  output rejection.
- [Communication boundaries](communication-boundaries.md): separation between
  runtime commands, provider protocols, observations, and consumer transports.
- [OpenCode integration](opencode-integration.md): ACP-first execution plus
  isolated native OpenCode management and reconciliation.
- [Contained Agent Turn V1 delivery plan](contained-agent-turn-v1-delivery-plan.md):
  staged implementation, provider, module, custody, qualification, and hosted
  worker plan for the first contained execution turn.
- [Capacity admission delivery plan](capacity-admission-delivery-plan.md):
  follow-up bounded admission, fair scheduling, control-path isolation and
  recovery acceptance; preserves the current seven-port V1 scope.
- [Subscription-runtime port candidates](subscription-runtime-port-candidates.md):
  sibling product as a protocol encyclopedia, not a spawn template. Named
  anti-patterns [`SR-AP-1`](subscription-runtime-port-candidates.md#sr-ap-1-provider-owns-the-process)
  … [`SR-AP-11`](subscription-runtime-port-candidates.md#sr-ap-11-orchestrator-intents-in-the-runtime-enum).
- [Host Custody optional default](host-custody-optional-default.md):
  ordinary user-session runtime is the product default; contained-turn Host
  Custody stays an optional profile defaulted off, with the Darwin isolate /
  privileged-helper work deferred outside current PR #69 merge.
- [Rust custody migration follow-up](rust-custody-migration-follow-up.md):
  deferred discussion, research boundary and migration TODO outside PR #69.
- [Provider setup delivery roadmap](provider-setup-delivery-roadmap.md): legacy
  capability disposition and delivery order for Codex, Claude Code, and
  OpenCode setup.
- [Managed agent runtime installation plan](managed-agent-runtime-installation-plan.md):
  deferred implementation plan for safe, recoverable, cross-platform runtime
  installation and updates after higher-priority MVP capabilities.
- [Agent Runtime Architecture Program Plan](agent-runtime-architecture-program-plan.md):
  owner decisions, target architecture, lanes, task cards and parallel waves for
  the Codex boundaries, libraries and storage program.
- [Agent Runtime Architecture Program: Execution Brief](agent-runtime-architecture-program-execution-brief.md):
  preconditions, card instructions, review checklists and stop conditions for
  implementing the remaining cards of the architecture program.
- [Legacy feature inventory](legacy-feature-inventory.json): commit-pinned,
  structured legacy/current/authority/implementation/qualification/backlog
  traceability. Its validator permits additions and uses explicit
  supersession; an authored row count is not completeness proof.
- [Test Debt 189 Plan](test-debt-189-plan.md): index of the issue 189 test debt briefs, measurements and decisions.
- [Test Debt 189 01 Derived Composition Types](test-debt-189-01-derived-composition-types.md): derive the ordinary Host factory value types from the descriptors.
- [Test Debt 189 02 Retire Failure Sweep](test-debt-189-02-retire-failure-sweep.md): retire the per-module failure sweep that smoke replaces.
- [Test Debt 189 03 Dependency Record Casts](test-debt-189-03-dependency-record-casts.md): typed module dependency records and the cast check.
- [Test Debt 189 04 Handle Guards](test-debt-189-04-handle-guards.md): handle guards that end a leak instead of hiding it.
- [Test Debt 189 05 Promise With Resolvers](test-debt-189-05-promise-with-resolvers.md): replace hand-written deferred helpers.
- [Test Debt 189 06 Fixture Copies](test-debt-189-06-fixture-copies.md): outcome record for the copied contained-turn fixtures.
- [Test Debt 189 07 Ordinary Store Contract Suite](test-debt-189-07-ordinary-store-contract-suite.md): contract suite for the ordinary operation store.
- [Get Modular Train 1 Migration](get-modular-train-1-migration.md): index of the
  migration briefs for Core and Assembly 0.3.0, resources and conformance.
- [Get Modular Train 1 Draft Branch](get-modular-train-1-draft-branch.md): the
  retired draft branch brief (superseded on 2026-10-09, not executed).
- [Get Modular Train 1 AR-1a](get-modular-train-1-ar-1a.md): Consumer Module
  Standard pin and Core and Assembly 0.3.0.
- [Get Modular Train 1 AR-1b](get-modular-train-1-ar-1b.md): module identities,
  contract descriptors and the root as a function of Assembly.
- [Get Modular Train 1 AR-1c](get-modular-train-1-ar-1c.md): resource scopes for
  ordinary owners and smoke for the composition root.
- [Get Modular Train 1 AR-2](get-modular-train-1-ar-2.md): per-grant Provider
  Access scopes.

Decision status:

- `accepted`: implementation follows the decision together with every
  applicable normative ADR;
- `provisional`: direction is accepted, but a dedicated ADR must settle details.
- `deferred`: intentionally excluded from the first implementation.
- `open`: no decision has been made.

Architecture documents describe constraints and ownership. They must not become
a second implementation or duplicate public schemas.
