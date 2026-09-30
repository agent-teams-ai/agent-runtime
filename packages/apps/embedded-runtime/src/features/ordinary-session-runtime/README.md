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
resources and journal. Failed construction attempts release of resources already created;
uncertain workspace recovery inputs remain owned by their filesystem owner.
A creation error with unfinished cleanup retains `cleanupRecovery.recover()` as
cleanup-only authority. It exposes no Host or commands. Concurrent calls join;
failed attempts retain their owners, and successful actions are not repeated.
Inner Host/feature recovery must succeed before outer prerequisite owners and
the journal are released. `cleanupFailed` remains true after recovery as history;
`toJSON()` projects creation metadata without causes, closures or Host references.

The journal tracks open, observed closed, and failed-close states. After a close
throws, further close and record calls reject with the first failure. It never
retries that fd number, since the OS outcome is uncertain and the number may be
reused. Successful close is idempotent. Initialization fsync failures preserve
the primary cause and any file/directory close uncertainty; an initialization
AggregateError retains a non-enumerable cleanup-only recovery holder. Public Host
creation wraps that owner-local failure in `AgentRuntimeHostCreationError`, keeps
its raw causes private and reports historical `cleanupFailed: true`. Uncertain
close debt remains failed and needs owner-specific reconciliation outside this
bounded fix; repeated recovery does not claim physical release.
Observed ordinary metadata is additive and cannot be interpreted as custody
proof. These are cooperative same-user guarantees, not hostile same-uid
containment. No root, sudo, account fallback, resume or automatic second attempt
is introduced.

The accepted contract is
[ADR-0090](../../../../../../docs/decisions/0090-ordinary-user-session-codex-execution-profile.md).
Synthetic construction, graph rejection, observation and packed-consumer tests
establish integration evidence; they do not qualify a live provider campaign.

## Durable integration evidence

The required `postgres-durability` CI job invokes
`scripts/ci/ordinary-postgres-disposable.sh` from the repository root. It creates
one fresh socket-only PostgreSQL cluster and runs the ordinary Agent Execution,
Runtime Security and Provider Access suites through
`scripts/ci/run-ordinary-postgres.mjs`. The mandatory runner rejects missing or
non-disposable configuration, skipped/TODO tests and an incomplete required
suite. The generic package test command can still omit PostgreSQL locally.
This database evidence does not qualify a live provider or containment target.
