---
id: AR-RUNTIME-CONTEXTS
status: accepted
---

# Runtime bounded-context package authority

ADR-0002 owns the accepted four-context domain decision. This manifest gives
Foundation scaffolding one stable, machine-resolvable authority identity for
the corresponding package boundaries; it does not create another domain model.

| Target | Package path |
| --- | --- |
| Runtime Configuration | `packages/contexts/runtime-configuration` |
| Runtime Security | `packages/contexts/runtime-security` |
| Provider Access | `packages/contexts/provider-access` |
| Agent Execution | `packages/contexts/agent-execution` |

Changing this set requires an accepted ADR before updating this manifest or the
scaffold target catalog.
