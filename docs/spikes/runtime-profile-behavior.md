# Runtime profile behavior spike

> **Architecture status: superseded evidence reference**
>
> This file records provider observations and historical hypotheses. It is not
> an implementation specification. The canonical architecture is
> `docs/decisions/0001-runtime-profile-and-activation-boundaries.md`.
>
> Later adversarial and consistency spikes falsified several conclusions in
> this document:
>
> - runtime profile is a separate Runtime Configuration bounded context, not a
>   feature inside `agent-execution`;
> - ordinary Node filesystem traversal is not a security boundary: bind mounts
>   and ancestor rename/symlink races crossed the intended root;
> - provider-native inspectors may execute plugins or hooks and cannot be used
>   during passive discovery;
> - revocation does not automatically create a successor execution generation;
> - preparation, security authorization, host materialization, user review, and
>   live activation are separate lifecycles;
> - credentials, live policy, concrete routes, trust, and host identity are
>   activation preconditions, not profile revision content.
>
> Machine-readable observations remain useful. Any model or recommendation in
> this file that conflicts with ADR-0001 is superseded.
>
> The later OpenCode `1.18.5`/`1.18.8` hosting conformance matrix is recorded
> in `docs/spikes/opencode-hosting-e2e-results.md`. It is the current evidence
> source for OpenCode concurrency, cancellation, OAuth, process-tree,
> filesystem, retry, and storage behavior.

Status: evidence complete for the initial Claude, Codex, and OpenCode matrix.
This document is retained as ADR input and behavior evidence, not as a public
API, production domain model, or current architecture decision.

## Question

How can AR reuse a user's global agent setup while keeping sessions
reproducible, isolated, recoverable, and independent from provider-specific
config paths?

## Tested versions

- Node 24.16.0
- Claude Code 2.1.199
- Codex 0.142.5
- OpenCode 1.18.5 and compatibility checks with 1.17.20
- ACP TypeScript SDK 1.3.0

All execution used generated Git repositories and copied sandbox credentials.
No provider command ran against a user project.

## Confirmed boundary

```text
Orchestrator
  -> opaque RuntimeProfileRef + CredentialBindingRef + desired capability
AR application
  -> resolves and pins ResolvedProfileManifest + BinaryRevision
Provider materializer
  -> immutable provider config + isolated writable runtime state
Provider adapter
  -> ACP first, provider-native capabilities where ACP is insufficient
```

The following resources are distinct:

```text
RuntimeProfile                 user-authored intent and source selection
RuntimeProfileRevision         immutable resolved semantics
CredentialBinding              secret custody and refresh lifecycle
BinaryRevision                 executable and capability matrix
ProviderConfigRoot             immutable materialized files
ProviderRuntimeStateRoot       mutable sessions, SQLite, locks, and history
SharedCache                    disposable provider cache
```

AR owns all provider filesystem layouts. Domain and application code do not
know `HOME`, `XDG_*`, `CODEX_HOME`, OpenCode config keys, or ACP DTOs.

## Main findings

### Ambient config is not a deterministic default

Codex reread changed config in the same app-server process. OpenCode 1.18.5
kept config process-scoped, but native inspection modified writable global and
project files by adding `$schema`. An active session therefore cannot safely
pin a mutable user path.

The deterministic flow must be:

```text
capture stable source bytes
  -> parse with a real parser or provider-native inspector
  -> resolve explicit precedence and collisions
  -> canonical ResolvedProfileManifest
  -> content-addressed staging directory
  -> validate
  -> atomic read-only publication
  -> launch with separate writable runtime state
```

The evidence supports a clearer product vocabulary:

```text
follow-current  capture the user's current preferences before each new session
explicit       use a selected immutable profile revision
isolated       start from provider defaults plus explicit managed bindings
```

`follow-current` does not mean live mutation. An active RuntimeSession remains
pinned. A later session automatically captures newer preferences. The v1
recommendation is not to expose `ambient_live`; it cannot provide the same
recovery or source-mutation guarantees.

### Preference drift is not authority drift

Managed settings cannot be put into the same snapshot as user preferences.
The provider probes showed three different refresh models:

- Claude system policy suppressed user hooks, executed managed hooks, refreshed
  through `policyHelper`, failed closed at startup, and retained its last valid
  policy after a background refresh failure.
- Codex returned changed system requirements from the same app-server process
  and rejected corrupt requirements on the next read.
- OpenCode applied system managed config at highest precedence but kept the
  loaded revision for the lifetime of an ACP host. A new process was required
  to observe a change.

The target model therefore separates:

```text
RuntimeProfileRevision       immutable preferences and artifact closure
AuthorityPolicyBinding       renewable, revocable, fail-closed enforcement
CredentialBinding            secret custody and generation
WorkspaceTrustRevision       executable-resource authority
BinaryRevision               pinned provider behavior and capabilities
```

Ordinary preference drift causes no in-session banner or forced restart. The
next session captures it automatically. A settings view may show that active
sessions use an older revision. Security-policy revocation is a different UX:
Runtime Security records the decision, while Agent Execution fences, stops,
and reconciles the provider. No successor execution generation is created
automatically.

### One generic filesystem strategy is wrong

- OpenCode works with read-only config and writable data, state, and cache.
- Codex needs a writable `CODEX_HOME`; an immutable `config.toml` can be linked
  or copied into that root and hash-verified.
- Claude inspection tolerates a read-only config root but attempts lock and
  temporary writes and keeps cache elsewhere.

The application invokes one materialization capability, while each provider
adapter owns the concrete layout.

### Credentials are not profiles

Presence and provider route selection did not prove usability. The model must
track route selection, credential detection, validation, refresh generation,
and `lastVerifiedAt` separately. The legacy peer-profile auth fanout is not
migrated; it is replaced by opaque credential bindings with generation/CAS.

### Extension collisions require policy

OpenCode 1.18.5 chose different winners for the same skill ID over repeated
cold starts. The target resolver therefore rejects ambiguous IDs unless the
profile explicitly names the winning source. MCP overrides may be intentional,
but the winner and normalized provider name must be recorded in the manifest.

The desktop scanner cannot be reused as-is: its JSONC regex misses valid
config, its fingerprint includes `mtime` and host paths, and its 200-file cap
is silent.

### Composition uses generic bindings, not orchestrator scopes

Providers do not understand team, teammate, task, or session-override business
semantics. The orchestrator maps those concepts to an ordered list of opaque
profile bindings. AR consumes only their declared order and immutable revision
references:

```text
orchestrator business scopes
  -> ordered ProfileBindingRef[]
  -> AR deterministic composition
  -> ResolvedProfileManifest
```

The proposed v1 reducer distinguishes operations that a generic object merge
cannot express safely:

```text
setting:  absent = inherit, set(value), reset-to-provider-default
resource: upsert(full definition), disable, remove
```

A higher ordinary layer may replace a lower definition or re-add a removed
resource. Security prohibition is not represented by a stronger tombstone:
it is a separate, revisioned constraint. A profile may request an MCP, hook,
plugin, skill, or tool capability but cannot grant it to itself. Activation is
bounded by the intersection of capability grants, runtime policy, workspace
trust, and `BinaryRevision` support.

Provider-native config is not generically deep-merged in the core. A provider
ACL parses it into normalized operations where possible. Remaining native
extensions require a provider-owned, versioned reducer and cannot contain
credentials or bypass security capabilities.

`profile-composition-cases.json` and `profile-composition.test.ts` exercise the
candidate reducer. The exact v1 operation vocabulary remains a candidate
decision until its public authoring ergonomics are approved.

### ACP is an adapter, not the domain

OpenCode completed the tested lifecycle and a real prompt over ACP v1. Asking
for v2 cleanly negotiated v1. ACP v2 remains Draft and changes prompt lifecycle
and session update semantics, so v1 and v2 need separate ACL modules selected
by protocol negotiation and capability flags.

Runtime profile, process custody, crash recovery, durable output, credentials,
and sandbox enforcement remain AR responsibilities outside ACP.

### Extensions are executable capabilities

An OpenCode project plugin executed JavaScript during provider startup and
wrote outside the workspace while still inside the test sandbox. Claude
`SessionStart` executed a shell hook during `--init-only`, before any model
request. MCP startup also spawned external processes.

Therefore plugins, hooks, MCP servers, and executable skill assets are not
ordinary config values. Resolution has separate states:

```text
discovered -> requested -> granted -> materialized -> activated -> observed
```

Provider-native strict mode is useful but not sufficient evidence. OpenCode
`--pure` still listed the project plugin in resolved config while suppressing
its initializer. AR must enforce grants and sandboxing outside prompts and
verify activation behavior through provider conformance.

The delayed OpenCode MCP honored its 500 ms timeout and a missing server was
reported independently. AR still owns the outer deadline, process-tree
cancellation, redacted diagnostics, and policy for partial availability.
An additional cancellation probe started a deliberately non-responsive MCP
child and proved that the AR-owned outer timeout removed the full OpenCode
process group without leaving the child alive.

Project `.opencode/skills` survived workspace relocation with paths rebased to
the new workspace. Revision identity therefore keeps semantic source bases and
relative paths rather than absolute host paths.

### Config bytes are not the full dependency closure

Hooks, MCP servers, plugins, and skills can reference executables, packages,
scripts, and files that are not inside the config directory. The target
revision therefore contains both:

```text
ArtifactClosure             immutable files captured into CAS
ExternalDependencyBindings PATH/absolute executables, packages, external files
```

Relative references that escape the profile root fail capture. Bare PATH
commands and absolute paths require explicit external bindings and launch-time
revalidation. Provider shell-hook strings are non-hermetic compatibility
inputs; they require a separate grant and sandbox policy rather than being
misrepresented as reproducible artifacts.

The initial adversarial capture implementation rejected direct symlinks, hard
links, special files, source replacement after read, traversal, and
file/byte/depth limit overflow. Later probes nevertheless crossed the intended
root through a bind mount and an ancestor rename/symlink race. This capture
implementation is therefore falsified as a production security boundary.
Provider ACL tests still prove that classified credentials are replaced by
opaque bindings and unknown secret-shaped fields fail closed.

### Materialization is not the source of truth

After its config file was deleted, an existing OpenCode ACP process continued
creating sessions with the already loaded command set. Codex behaved
differently: corrupting `config.toml` caused the next config read to fail with a
parse error. Provider health therefore cannot prove profile durability.

The persistence split is:

```text
ProfileRevisionRepository
  -> manifest, lifecycle, references, leases, preparation receipts

ProfileArtifactStore
  -> immutable content-addressed files and directories

Provider materialization
  -> disposable verified projection of one revision
```

The local artifact adapter can use a filesystem CAS. Hosting can use object
storage. Blobs are uploaded idempotently before the database transaction
publishes the revision; unreferenced uploads are later collected. This avoids
a distributed transaction while keeping state and outbox publication atomic.

A runtime session creates a durable reference to its revision. Garbage
collection cannot remove referenced artifacts. Missing or corrupt materialized
files are rebuilt from the same artifacts. If those authoritative artifacts
are unavailable, AR returns `PROFILE_REVISION_UNAVAILABLE`; it never falls back
to ambient or the newest profile.

## Legacy disposition

The old manager is a useful behavior oracle, not a core donor. Its reusable
ideas are isolated HOME/XDG layouts, external disposable caches, cache repair,
native subscription bridges, and provider catalog tests. They are adapted
behind new boundaries.

The following are rewritten or removed:

- project-path-only mutable profile identity;
- silent safe-field import;
- auth fanout across managed profiles;
- in-process whole-profile lock;
- fingerprints that omit security-relevant endpoint/environment semantics;
- orchestration teammate agents, prompts, tasks, worktrees, reviews, commits,
  and pushes.

The desktop overlay remains useful only as input to an explicit ambient
compatibility mode. It is not a replacement for the AR profile subsystem.

The complete per-behavior decision table is in
`experiments/runtime-profile-behavior/fixtures/opencode-legacy-disposition.json`.

## Initial feature placement (superseded)

The earlier recommendation to place Runtime Profile inside `agent-execution`
is superseded. Runtime Configuration is a separate bounded context because
profile definitions, immutable revisions, compilation, source ingestion,
provenance, and future import/export have a lifecycle independent from agent
execution.

Interfaces use role names such as `ProfileRevisionRepository`,
`ProviderProfileMaterializer`, `CredentialBindingResolver`, and `BinaryCatalog`.
The `Port` suffix is optional; dependency direction is enforced by package
boundaries and imports, not naming alone.

## Historical first-slice proposal (superseded)

1. Define immutable profile identity, AuthorityPolicyBinding, and lifecycle
   invariants without provider DTOs.
2. Implement bounded stable source capture, ArtifactClosure, provider parsing,
   secret classification, and ExternalDependencyBindings.
3. Implement SQLite persistence for definitions, revisions, authority
   observations, and preparation receipts behind semantic repositories.
4. Implement OpenCode 1.18 materialization with read-only config, isolated
   writable state, and process-scoped policy enforcement.
5. Launch OpenCode through ACP v1 and expose provider-native capabilities only
   through a separate OpenCode ACL.
6. Add crash, concurrency, permission, credential, authority, process-tree,
   and binary compatibility conformance before orchestrator integration.

## Historical open decisions

- Whether any explicitly non-hermetic `ambient_live` compatibility mode should
  exist after v1; the v1 recommendation is to defer it.
- Exact global, project, team, agent, and session merge/tombstone semantics.
- Authority observation lease/refresh intervals for local and hosted modes.
- Whether non-hermetic shell hooks ship in v1 or remain deferred compatibility.
- Binary upgrade and rollback evidence required for pinned sessions.
- Promotion trigger from feature to bounded context.
- Claude authenticated crash/resume conformance when valid test credentials are
  available.

## Evidence

Machine-readable observations and run IDs are in
`experiments/runtime-profile-behavior/fixtures/provider-behavior-matrix.json`.
Confirmed invariants and open decisions are separated in
`experiments/runtime-profile-behavior/fixtures/confirmed-invariants.json`.
The redacted OpenCode hosting E2E matrix is in
`experiments/runtime-profile-behavior/fixtures/opencode-hosting-e2e-summary.json`.
Compact evidence promoted from the selected host runs is in
`redacted-trace-summaries.json`; `redacted-trace-selection.json` records its
inputs. The promotion step omits raw stdout, stderr, environments, and
credential-shaped fields recursively while retaining source hashes,
filesystem and syscall counts/samples, verification, and assertions.

Primary external references:

- OpenCode config precedence: https://opencode.ai/docs/config
- Claude managed settings and policyHelper: https://code.claude.com/docs/en/settings
- Codex configuration source: https://github.com/openai/codex/tree/main/codex-rs/config
- OpenCode ACP support: https://opencode.ai/docs/acp
- ACP protocol versioning: https://github.com/agentclientprotocol/agent-client-protocol
- ACP v2 prompt lifecycle Draft: https://agentclientprotocol.com/rfds/v2/prompt
