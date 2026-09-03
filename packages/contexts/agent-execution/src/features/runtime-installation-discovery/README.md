---
type: feature
status: accepted
owner: "@agent-teams/agent-execution"
owner_document: ADR-0005
---

# Runtime installation discovery

Owns passive, provider-neutral observation of authorized runtime installation
candidates. Public transport DTOs stay in `contracts`; application models and
ports remain inward-only; Node hashing and filesystem integrations stay in
outbound adapters; feature-local composition maps the public DTOs and wires the
Pure DI use cases. Discovery never executes an observed binary or reads ambient
authentication state.
