---
type: feature
status: accepted
owner: "@agent-teams/runtime-security"
owner_document: ADR-0005
---

# Contained-turn dispatch authority

Owns dispatch-authority heads, consumption, settlement, and acceptance for a
contained turn. Public transport stays in `contracts`; domain records stay
inward-only; application use cases and outbound ports remain inward-only;
Node digesting and PostgreSQL/in-memory persistence stay in outbound adapters.
Feature-local composition wires those adapters. Package assembly reaches this
feature through curated `index.ts` / `internal.ts` entrypoints.
