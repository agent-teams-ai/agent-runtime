---
type: feature
status: accepted
owner: "@agent-teams/provider-implementations"
owner_document: ADR-0092
---

# Provider session implementation

One cohesive technical feature implements the runtime-owned interactive session
SPI. Provider-specific protocol mechanisms and adapters remain grouped under
`adapters/claude-sdk`, `adapters/codex-protocol` and
`adapters/opencode-protocol`. Fixed bounded queue/feed primitives live in
`adapters/provider-session-io`; they are not a separate graph or policy owner.

`contracts` contains the existing portable Codex event and approval wire shapes.
The public feature entry exposes only those types. SDK DTOs, native clients,
configuration and checkpoint bytes stay in adapters and the implementation-only
internal entry. Module composition and four curated package facades contain
named re-exports, without inline orchestration.

The feature has no domain or application layer because runtime session policy,
durable intent and authority belong to Agent Execution, and product tools belong
to Orchestrator. There are no empty layers or duplicated canonical contracts.
Callers provide custody, selected native transport/configuration and checkpoint
storage. The volatile provider queue, native callback fences and private bounded
checkpoint metadata are protocol mechanisms, not a second runtime authority.

Algorithms are retained from the exact qualified extraction checkpoint; the
materialization manifest distinguishes unchanged relocation from path and
assembly adaptations. Synthetic subprocess/HTTP fixtures retain targeted
interrupt, no replay after uncertainty, strict restore and late-permission
fences. They do not prove real authentication or deployment qualification.
