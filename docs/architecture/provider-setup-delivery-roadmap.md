---
id: runtime.architecture.provider-setup-delivery
type: architecture
status: active
owner: architecture
summary: Defines legacy capability disposition and delivery order for Codex, Claude Code, and OpenCode setup.
related:
  - ADR-0001
  - ADR-0008
---

# Provider setup delivery roadmap

## Purpose

This document turns the user's existing Codex, Claude Code, and OpenCode
experience into an explicit delivery backlog for Agent Runtime. It answers two
different questions:

1. Which useful capabilities must not be lost when the legacy Desktop is
   replaced?
2. In which order can Agent Runtime implement them without overfitting one
   provider or building a provider framework before it has evidence?

This is a product and architecture inventory, not permission to copy legacy
code. Legacy behavior is evidence of a user need and a source of edge-case
fixtures. ADR-0001, later ADRs, and current provider documentation remain the
authority for the new design.

Evidence baseline:

- Agent Runtime `7cc6ed573a785c868b17e84a42a49c7bc9da0894`;
- legacy `777genius/agent-teams-ai`
  `f6afac73cced62d943a0e891ad08d7b8f88f802f`;
- official provider documentation linked under each provider below.

The legacy repository may contain newer uncommitted work in developer
workspaces. Such work is not part of this baseline and cannot establish product
or architecture truth.

## What a Legacy Feature Inventory records

Each inventory item records the following fields:

| Field | Question answered |
| --- | --- |
| user job | What can the user accomplish? |
| legacy behavior | What did the old product actually show or do? |
| evidence | Which exact source, test, or official document proves it? |
| failure cases | Which missing, stale, corrupt, incompatible, or partial states already matter? |
| disposition | `MVP`, `NEXT`, `LATER`, or `REJECT` |
| reuse mode | Reuse a fixture/algorithm, rewrite behind a new port, or do not reuse |
| owner | Which Agent Runtime bounded context owns the new meaning? |
| acceptance | What deterministic test proves the user-visible result? |
| extension seam | Which known future capability must remain possible without widening the current contract? |

The inventory deliberately separates capabilities that the old Desktop often
combined in one screen or service:

```text
discover installation
  -> inspect compatibility
  -> inspect configuration
  -> show a safe setup preview
  -> optionally create/revise a saved profile
  -> separately inspect or configure provider access
  -> separately install/update a runtime
  -> later prepare and activate an exact binary/profile/access combination
```

No arrow makes the next step automatic. Inspection never grants trust,
installation never authenticates an account, and a detected ambient setup is
not a saved profile.

## Ownership boundary

Agent Runtime remains headless. Desktop is a separate repository, product, and
delivery owner. Desktop owns presentation and interaction; it consumes the
private TypeScript capability API until a real external consumer justifies a
public SDK or transport.

| Meaning | Owner |
| --- | --- |
| portable non-secret settings, source precedence, profile drafts and revisions | Runtime Configuration |
| source/path authorization, workspace trust, security policy | Runtime Security |
| account, route, credential-generation reference, authentication capability | Provider Access |
| installation observation, exact `BinaryRevision`, host/process custody | Agent Execution |
| scope binding and cross-context setup projection | `@agent-teams/embedded-runtime` application composition |
| UI workflow, labels, progress presentation, user confirmation | Desktop consumer |

The following data must remain separate:

- a detected executable path is an observation and later an input to exact
  `BinaryRevision` selection; it is never portable profile data;
- Bedrock, Vertex AI, Foundry, direct API, OAuth, ChatGPT, and compatible
  endpoints are Provider Access routes, not profile variants;
- secret values never enter setup views, profiles, logs, diagnostics, or
  semantic digests;
- provider-native source files remain user-owned and are not modified by
  inspection;
- installation and update are a separate mutation capability with their own
  plan, progress, integrity, rollback, and recovery contracts.

## Legacy capability inventory

### Codex

| Capability | Legacy evidence | New disposition |
| --- | --- | --- |
| detect installed runtime and version | `src/features/codex-runtime-installer`, PATH and app-managed manifest probes | `MVP`: passive candidates already exist in AR-1; real version-bound compatibility is `NEXT` |
| inspect user, selected native profile, and workspace configuration | legacy settings/profile flows plus current AR-1 classifier | `MVP`: AR-1 supports `model`, `model_reasoning_effort`, and `personality` only |
| install or update with progress | `CodexRuntimeInstallerService` | `NEXT` product capability, not part of passive setup inspection |
| choose ChatGPT or API-key access and inspect login readiness | `src/features/codex-account` | `LATER`: Provider Access; AR-1 reports only that access-owned settings were deferred |
| browser/device login, logout, account and rate-limit display | `CodexLoginSessionManager` and account contracts | `LATER`: preserve the user jobs, redesign credential custody and transport |
| model catalog, fast-mode eligibility, launch readiness | `src/features/codex-model-catalog` and `src/features/codex-runtime-profile` | `LATER`: live provider facts must not become portable profile truth |

Reusable legacy evidence:

- PATH, app-managed, platform alias, and Windows shim cases;
- package size, archive traversal, checksum, staging, and executable-bit tests;
- login pending/cancelled/failed state vocabulary;
- stale model-catalog and partial-readiness cases.

Do not copy:

- renderer/IPC contracts into Agent Runtime's published language;
- a single service that mixes discovery, installation, latest-version network
  lookup, authentication, model catalog, and presentation;
- floating registry `latest` as activation authority;
- secret or account-file parsing into Runtime Configuration;
- destructive replace-before-commit installer behavior without a recoverable
  transaction.

Current provider semantics must be checked against the official
[Codex configuration reference](https://developers.openai.com/codex/config-reference)
and [Codex authentication documentation](https://developers.openai.com/codex/auth/).

### Claude Code

| Capability | Legacy evidence | New disposition |
| --- | --- | --- |
| detect runtime through interactive-shell and process PATHs | `ClaudeBinaryResolver` and `CliInstallerService` | `MVP` for the second provider slice, with passive `found_unverified` observations |
| inspect user, project, local, and managed setting sources | legacy Claude settings readers and launch environment builders | `MVP` only for an explicit version-bound allowlist; no ambient secret values |
| inspect model and reasoning/effort preferences | `src/features/anthropic-runtime-profile` and shared effort utilities | `MVP` where official Claude settings provide stable semantics; unsupported fields stay absent |
| classify direct Anthropic, Bedrock, Vertex AI, Foundry, or compatible route | connection-mode constants and runtime environment builders | `NEXT`: Provider Access owns route semantics; the passive slice emits only a typed deferred diagnostic |
| inspect login status | `claude auth status` flow in `CliInstallerService` | `NEXT`: Provider Access observation; it may execute provider code and is outside the passive slice |
| install/update native CLI with checksum and progress | GCS manifest/download plus `claude install` flow | `NEXT` installation capability with a new recoverable design |
| configure or switch access | legacy provider settings UI | `LATER`; preserve the user job, not the Electron implementation |

Reusable legacy evidence:

- macOS, Linux, Windows, architecture, libc, redirect, checksum, timeout, and
  progress cases;
- interactive-shell PATH differences and partial status rather than a hanging
  screen;
- auth-output noise, stale-lock retry, cancellation, and timeout cases as
  future Provider Access fixtures;
- route precedence and competing environment-variable cases, but only after
  secret values are replaced by opaque bindings.

Do not copy:

- `CliInstallerService` as a provider-neutral service: it has too many reasons
  to change;
- execution of `claude auth status` during passive setup inspection;
- `settings.json` environment secrets into a profile or setup result;
- one common settings DTO that pretends Claude supports Codex personality or
  Codex supports Claude routing modes.

Volatile behavior must be checked against official Claude Code
[setup](https://code.claude.com/docs/en/setup),
[settings](https://code.claude.com/docs/en/settings),
[Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock),
[Vertex AI](https://code.claude.com/docs/en/google-vertex-ai), and
[Microsoft Foundry](https://code.claude.com/docs/en/microsoft-foundry)
documentation.

### OpenCode

| Capability | Legacy evidence | New disposition |
| --- | --- | --- |
| detect PATH/app-managed runtime and supported version | `OpenCodeRuntimeInstallerService` and version policy | `NEXT` after the Claude slice proves the shared observation seam |
| inspect global/project configuration and managed overlay intent | OpenCode config and managed-overlay modules | `NEXT`, but user-owned config is never mutated by inspection |
| install/update native platform package | `OpenCodeRuntimeInstallerService` | second product capability after passive setup; not copied into setup inspection |
| list providers, connections, setup methods, and models | `src/features/runtime-provider-management` | `LATER`: primarily Provider Access and provider catalog work |
| OAuth/API-key connection and forgetting credentials | runtime-provider-management use cases | `LATER`: credential custody and ambiguous completion require dedicated contracts |
| local model endpoint configuration and proof | local-provider adapters and UI | `LATER`: useful product feature, outside the first setup/profile slice |
| team launch, prompt delivery, recovery, and inbox behavior | `src/main/services/team/opencode` and provisioning code | `REJECT` from this inventory: Orchestrator behavior, not runtime setup |

Reusable legacy evidence:

- Windows npm shim versus native executable, NVM paths, supported-version, and
  failed app-managed fallback cases;
- integrity, archive bounds, staging, manifest, progress, and concurrent install
  cases;
- global/project configuration and provider-directory fixtures;
- OAuth completion and local-provider verification failure vocabulary for later
  dedicated capabilities.

Do not copy:

- the broad runtime-provider-management API as one Agent Runtime capability;
- provider catalog, credential mutation, model testing, installation, and
  project defaults behind one facade;
- team provisioning or delivery semantics into Agent Runtime setup;
- ambient auto-update or network access during deterministic inspection.

Current behavior must be checked against official OpenCode
[configuration](https://opencode.ai/docs/config/) and
[provider](https://opencode.ai/docs/providers/) documentation.

## Delivery order

### Slice AR-1 - Codex passive setup inspection

Status: implemented, synthetic evidence present, implementation qualification
still open in `readiness.md`.

Keep the capability narrow. The next Codex work is real version-bound semantic
fixtures and trusted platform collector integration, not auth, install, or a
saved-profile database hidden inside `codexSetup.inspect`.

### Slice AR-2 - Claude Code passive setup inspection

This is the recommended next implementation slice.

The private handle adds a sibling capability:

```ts
interface RuntimeAccessHandle {
  readonly codexSetup: CodexRuntimeSetupQueries;
  readonly claudeCodeSetup: ClaudeCodeRuntimeSetupQueries;
}
```

It is independently authored through the same accepted bounded contexts:

- Agent Execution observes candidate installations without executing them;
- Runtime Security authorizes roots, paths, sources, and file identity;
- Runtime Configuration parses a declared Claude settings dialect and exposes
  only a closed non-secret allowlist;
- Runtime Configuration classifies route-owned and secret-shaped keys only far
  enough to omit their values and emit stable deferred/rejected diagnostics;
- Provider Access is not implemented as part of AR-2;
- embedded-runtime maps those owner-local results into one detached view.

V1 constraints:

- macOS only;
- passive filesystem and installation metadata observation only;
- no `claude` process execution;
- no login, logout, installation, update, network, saved profile, or launch;
- no fake native-profile selector if Claude Code does not provide Codex-like
  native profile semantics;
- typed unsupported/partial diagnostics rather than inferred support;
- cancellation and Host disposal retain the AR-1 meaning.

Expected size: approximately 1,500-2,700 production and focused test lines,
depending on how much of the existing filesystem authorization can be reused
without weakening provider-specific semantics.

### Reconciliation after AR-2

Only after both slices pass provider-specific fixtures:

1. compare installation candidate and source-observation behavior;
2. extract the exact common mechanism already implemented twice;
3. keep provider dialects, source precedence, settings keys, route semantics,
   diagnostics, and public capability DTOs provider-specific;
4. prove parity before deleting duplicate implementation;
5. keep direct Pure DI and owner-local `FeatureModuleFactory` functions; a
   module-system adapter may later supply the same dependencies.

This is the DRY point. Earlier extraction would encode Codex assumptions;
later extraction would knowingly retain proven duplicate semantics.

### Slice AR-3 - OpenCode passive setup inspection

OpenCode is third. It validates the reconciled seam while introducing a much
broader native configuration and provider directory. Only the passive setup
subset enters this slice. Provider connection, OAuth/API-key mutation, model
execution proof, and local endpoint setup remain separate future capabilities.

### Product capability 2 - runtime installation and update

After setup inspection is useful for at least Codex and Claude Code, define a
separate mutation capability for installation and update. It needs:

- provider-specific immutable package/release selection;
- compatibility and integrity policy;
- bounded download and extraction;
- progress observations;
- serialized installation ownership;
- recoverable activation/rollback;
- exact installed `BinaryRevision` evidence;
- no implicit authentication or profile mutation.

Codex, Claude Code, and OpenCode implementations may then proceed in parallel
behind the accepted capability only where their distribution mechanisms are
independent.

### Saved profile capability

The product goal includes creating, listing, selecting, and revising profiles,
but passive setup inspection does not silently create them. A later explicit
use case turns reviewed portable observations into a `ProfileDefinition` and
immutable `ProfileRevision`.

Before that code starts, a dedicated decision must choose local and hosted
persistence adapters, migration ownership, tenant/workspace scope, and the
review contract. The domain and application contract can remain storage-
agnostic; SQLite and PostgreSQL are adapters under ADR-0001.

## MVP matrix

| User capability | First MVP | Later extension |
| --- | --- | --- |
| see which supported runtimes are present | Codex plus Claude passive inspection on macOS | OpenCode, Windows, Linux, verified compatibility |
| understand portable configuration | provider-specific safe preview | plugins, MCP, skills, commands, hooks, instructions |
| understand why setup is incomplete | typed local diagnostics and next actions | provider health and repair workflows |
| create reusable profiles | explicit reviewed profile capability after passive inspection | import/export, inheritance, organization policy |
| install or update a missing runtime | separate second product capability | channels, rollback, fleet policy |
| authorize a provider account | not in first MVP | Provider Access login/import/refresh/revoke flows |
| launch agents | not part of Runtime Setup | Agent Execution operations after their own decisions and gates |

## Decisions before AR-2 code

The implementation handoff must freeze:

1. the exact Claude Code configuration dialect and supported version range;
2. the exact source list and precedence verified from official behavior;
3. the closed portable setting allowlist;
4. the route-owned and secret-shaped denylist plus stable deferred/rejected
   diagnostics;
5. trusted macOS collector inputs and display-path redaction;
6. stable diagnostic and result variants;
7. provider-specific fixtures and the required negative test matrix.

The following do not block AR-2 and remain explicit future decisions:

- public SDK, IPC, Connect, or another transport;
- dynamic module discovery;
- profile persistence adapter;
- installation/update protocol;
- route observation, authentication UX, and credential custody in Provider
  Access;
- Windows/Linux support;
- OpenCode provider directory and local model setup.

## Invariants

- Setup inspection is read-only, offline, bounded, cancellable, and
  deterministic for the same authorized observation bundle.
- Inspection never runs provider-controlled code.
- Unknown dialects, closed enum values, source forms, or secret-shaped fields
  fail closed or produce typed diagnostics.
- Provider-specific behavior stays behind provider-specific contracts; no
  universal union or service locator is introduced.
- `ProfileRevision` contains portable non-secret intent, never executable
  paths, credentials, access routes, live health, or mutable provider facts.
- Installation mutation, Provider Access mutation, saved-profile mutation, and
  runtime execution cannot hide behind an inspection query.
- Legacy code is not imported into production Agent Runtime. Reusable evidence
  is rewritten as fixtures or focused algorithms behind application-owned
  ports.
- Desktop UI and orchestration behavior remain outside Agent Runtime.
