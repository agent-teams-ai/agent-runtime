---
type: feature
status: accepted
owner: "@agent-teams/embedded-runtime"
owner_document: ADR-0008
---

# Ordinary session runtime

Owns the Host's ordinary-session construction handoff, field-explicit Provider
Access and Runtime Security anti-corruption mappings, and synchronous non-secret
observations. The public async factory accepts closed trusted configuration and a
borrowed PostgreSQL pool. Authentication starts only when Agent Execution handles
an authorized submit. The Host never closes the caller's pool.

`composition/` declares the active Get Modular graph and factories. One existing
Host assembly combines passive setup with the seven Agent Execution dependencies:
operation store, security, provider access, workspace, artifacts, process and
provider. Secret registration is an additional narrow PA-to-RS construction
capability. It is not caller authority or a provider retry path.

`adapters/` projects genuine owner receipt identities without importing owner
internals, and journals bounded scalar observations with synchronous durable
writes. `contracts/` defines that non-secret observation carrier. Private
composition is curated through `internal.ts`; `index.ts` exposes only the
observation type. Existing outer composition entrypoints select the construction
handoff and return the public Host.

The Host joins the ordinary feature before disposing its owned PA/RS/provider
resources and journal. Failed construction releases resources already created;
uncertain workspace recovery inputs remain owned by their filesystem owner.
Observed ordinary metadata is additive and cannot be interpreted as custody
proof. These are cooperative same-user guarantees, not hostile same-uid
containment. No root, sudo, account fallback, resume or automatic second attempt
is introduced.

The accepted contract is
[ADR-0021](../../../../../../docs/decisions/0021-ordinary-user-session-codex-execution-profile.md).
Synthetic construction, graph rejection, observation and packed-consumer tests
establish integration evidence; they do not qualify a live provider campaign.
