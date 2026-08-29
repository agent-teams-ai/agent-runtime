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
- [Provider setup delivery roadmap](provider-setup-delivery-roadmap.md): legacy
  capability disposition and delivery order for Codex, Claude Code, and
  OpenCode setup.
- [Managed agent runtime installation plan](managed-agent-runtime-installation-plan.md):
  deferred implementation plan for safe, recoverable, cross-platform runtime
  installation and updates after higher-priority MVP capabilities.
- [Legacy feature inventory](legacy-feature-inventory.json): commit-pinned,
  structured legacy/current/authority/implementation/qualification/backlog
  traceability. Its validator permits additions and uses explicit
  supersession; an authored row count is not completeness proof.

Decision status:

- `accepted`: implementation follows the decision together with every
  applicable normative ADR;
- `provisional`: direction is accepted, but a dedicated ADR must settle details.
- `deferred`: intentionally excluded from the first implementation.
- `open`: no decision has been made.

Architecture documents describe constraints and ownership. They must not become
a second implementation or duplicate public schemas.
