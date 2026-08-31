---
type: feature
status: accepted
owner: "@agent-teams/provider-access"
owner_document: ADR-0005
---

# Contained turn access

Owns the Provider Access facts and one-time dispatch-consumption authority used
by a contained agent turn. Public transport DTOs stay in `contracts`; domain
and application policy remain inward-only; adapters validate and detach data
at runtime boundaries; feature-local composition wires the Pure DI factories.
