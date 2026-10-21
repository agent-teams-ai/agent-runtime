---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Interactive session runtime

ADR-0091 admits this separate Host composition. One static current CMS group
constructs the Agent Execution session owner from scoped store, provider,
authorization, custody and context inputs. Public access contains session DTOs;
construction and bounded scheduling remain trusted composition authority.

The Host owns a fresh stable directory descriptor and uses Filesystem Custody's
existing process lock. Contention refuses a second Host for the same configured
private root. It retains that lock while logical closure, grant retirement,
output drain or process stop is uncertain. The caller owns the borrowed store,
provider configuration and independently authoritative custody implementation.
A lost owner never recreates an active provider from persisted state. Recovery
requires independent custody proof before a compatible closed checkpoint can
advance generation. Synthetic qualification does not claim hostile containment
or real provider authentication.
