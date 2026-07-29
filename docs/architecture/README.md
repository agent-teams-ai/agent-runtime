# Architecture

This directory records accepted architectural decisions for Agent Runtime.

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

Decision status:

- `accepted`: implementation must follow the decision.
- `provisional`: direction is accepted, but a dedicated ADR must settle details.
- `deferred`: intentionally excluded from the first implementation.
- `open`: no decision has been made.

Architecture documents describe constraints and ownership. They must not become
a second implementation or duplicate public schemas.
