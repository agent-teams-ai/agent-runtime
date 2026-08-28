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

- Agent Runtime implementation in the current repository tree;
- legacy `777genius/agent-teams-ai`
  `f6afac73cced62d943a0e891ad08d7b8f88f802f`;
- official provider documentation linked under each provider below.

The bounded provider-setup catalog is
[`legacy-feature-inventory.json`](legacy-feature-inventory.json). It is pinned
to the exact legacy and Agent Runtime commits above, but it does not claim that
an authored row count proves completeness. Stable IDs are retained when useful
for traceability; additions are allowed, and merged or invariant-only IDs are
marked as superseded instead of being counted as independent user jobs.

The inventory is an implementation guide, not a product database. It keeps six
questions independent: what legacy did, what retained current-provider evidence
establishes, what architecture accepts, what this repository implements, what
has been qualified, and where an unimplemented capability sits in the backlog.
An accepted or implemented capability is not thereby qualified, and a severe
cutover loss does not automatically become `now` work.

The legacy repository may contain newer uncommitted work in developer
workspaces. Such work is not part of this baseline and cannot establish product
or architecture truth.

## What a Legacy Feature Inventory records

Each inventory item records the following field groups:

| Field | Question answered |
| --- | --- |
| `capabilityId` | Which stable inventory row is this? |
| `provider` | Which provider owns the observed legacy behavior? |
| `userJob` | What can the user accomplish? |
| `userValue` | Why is that job useful? |
| `legacyFact`, `currentProviderFact` | Which exact commit/path/line-or-symbol evidence supports each distinct factual claim? |
| `architectureAuthority` | Is the target shape accepted, proposed, or absent, and which governed anchor says so? |
| `implementationStatus`, `qualificationStatus` | Is code present, and has an exact target been qualified? |
| `lifecycleStatus`, relationships | Is this an active job, a superseded traceability ID, a dependency, or a related split? |
| `failureAndEdgeCases`, `reuseDecision` | Which cases matter and what, if anything, transfers? |
| `owners` | Which bounded context, application-composition layer, or external consumer owns each role? |
| `backlogDisposition`, `priority` | Is unimplemented work `now`, `next`, `later`, or rejected; what is the user-loss severity, prerequisite, product owner, and external consumer? |
| `acceptanceEvidence` | Which exact current test proves implementation, or which deterministic future evidence is required? |
| `futureExtensionSeam` | Which future capability must remain possible without widening the current contract? |

`now | next | later` orders only unimplemented product work. Implemented rows
use `not_applicable` on the backlog axis. User-loss severity records cutover
impact separately, dependencies record prerequisites, and no usage metric is
inferred. The current product order is fixed: passive setup/profile preview
first, installer/update second, and authentication, account access, workspace
trust mutation, and live route/account capability later unless a future
accepted decision changes it. Desktop remains the external consumer and owns
its interaction and cutover acceptance, never an Agent Runtime bounded context.

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
| passively observe installed runtime candidates and inspect portable configuration/profile intent | resolver and settings/profile flows | implemented and unqualified; backlog is not applicable |
| qualify exact version compatibility | resolver and app-server degradation behavior | `next`, prerequisite to version-authoritative activation |
| install or update with progress | `CodexRuntimeInstallerService` | `next`; separate from passive setup inspection |
| choose ChatGPT or API-key access and inspect login readiness | `src/features/codex-account` | `later`; Provider Access owns it |
| browser/device login, logout, account and rate-limit display | `CodexLoginSessionManager` and account contracts | `later`; preserve the user jobs and redesign credential custody and transport |
| inspect and decide workspace trust | workspace-trust coordinator and Codex trust settings | `later`; Runtime Security owns the decision and Agent Execution enforces it |
| model catalog, fast-mode eligibility, launch readiness | model-catalog and runtime-profile flows | `later`; live provider facts must not become portable profile truth |

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
| passively observe installation candidates | `ClaudeBinaryResolver` and doctor fallback evidence | implemented and unqualified; the current slice never uses the active doctor fallback |
| inspect portable settings sources | user-settings and explicit-settings legacy readers plus retained current documentation | implemented and unqualified for user, shared-project, and project-local slots only; managed policy and session overrides remain `unobserved` |
| inspect portable model and effort intent | anthropic runtime-profile evidence plus retained settings schema | implemented and unqualified for the frozen preview classifier; exact model IDs are not declared impossible, and live availability is separate |
| classify route-owned values without exposing them | connection-mode and runtime-environment evidence | implemented and unqualified as value-free deferred diagnostics only; retained evidence does not establish every provider topology |
| inspect installed/latest version, then install/update separately | `CliInstallerService` status, manifest, checksum, and progress flows | `next`; mutation remains outside passive inspection |
| inspect login status | `claude auth status` flow in `CliInstallerService` | `later`; it executes provider code and belongs to Provider Access plus explicit Agent Execution custody |
| inspect workspace trust and obtain separate consent | Claude workspace-trust strategy | `later`; passive source inspection grants no consent |
| inspect live model/effort/Fast eligibility | anthropic runtime-profile reconciliation | `later`; requires exact binary and route/account facts |
| configure, switch, disconnect, or log out | legacy provider settings and disconnect UI | `later`; preserve the jobs, not the Electron implementation |

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
| detect PATH/app-managed runtime and supported version | `OpenCodeRuntimeInstallerService` and version policy | `later`; no OpenCode implementation is present |
| inspect global/project configuration and managed overlay intent | OpenCode config and managed-overlay modules | `later`; user-owned config is never mutated by inspection |
| install/update native platform package | `OpenCodeRuntimeInstallerService` | `later`; separate from setup inspection |
| list providers, connections, setup methods, and models | `src/features/runtime-provider-management` | `later`; primarily Provider Access and provider catalog work |
| OAuth/API-key connection and forgetting credentials | runtime-provider-management use cases | `later`; credential custody and ambiguous completion require dedicated contracts |
| local model endpoint configuration and proof | local-provider adapters and UI | `later`; useful product behavior outside passive setup inspection |
| team launch, prompt delivery, recovery, and inbox behavior | `src/main/services/team/opencode` and provisioning code | `rejected`; Orchestrator behavior is not runtime setup |

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

Status: implementation present in the current repository tree and synthetic
macOS composition evidence present. Provider qualification, a production
collector, and deployment qualification remain open.

The machine-readable authority is the
[`claude-code-setup-freeze.json`](claude-code-setup-freeze.json) packet and its
[schema](claude-code-setup-freeze.schema.json). The packet is validated by the
deterministic `test:ar2-contract` gate, which runs exactly once through the
authoritative `pnpm check` chain. The gate requires each of the 21 frozen
fixture rows to map to exactly one declared Node test selected by its owning
package test script, and rejects fixture, title, file, or package-script drift.
Its documented settings dialect does not qualify or establish compatibility of
any executable.
Revision 3 of the linked content-addressed
[`semantic artifact`](claude-code-official-semantics.snapshot.json) binds five
compact normalized evidence records to exactly five official response bodies
retained as deterministic gzip artifacts. Every frozen fact cites a retained
section or JSON pointer. The offline contract gate reads and decompresses each
artifact, recomputes its gzip and raw-response lengths and SHA-256 values, and
re-derives every record with bounded Markdown parsing or explicit SchemaStore
JSON pointers before verifying the enclosing artifact digest recorded by the
freeze packet. Revision 1's thirteen unretained-document hashes are omitted
historical non-authority. This is official-document evidence for the named
dialect only; executable and provider qualification remain open.

The private handle adds a sibling capability:

```ts
interface RuntimeAccessHandle {
  readonly codexSetup: CodexRuntimeSetupQueries;
  readonly claudeCodeSetup: ClaudeCodeRuntimeSetupQueries;
}
```

The implemented private headless TypeScript query crosses the accepted owners:

- Agent Execution observes candidate installations without executing them;
- Runtime Security authorizes roots, paths, sources, and file identity;
- Runtime Configuration parses a declared Claude settings dialect and exposes
  only a closed non-secret allowlist;
- Runtime Configuration classifies route-owned and secret-shaped keys only far
  enough to omit their values and emit stable deferred/rejected diagnostics;
- Provider Access is not implemented as part of AR-2;
- embedded-runtime maps those owner-local results into one detached,
  deeply-frozen view and preserves Host cancellation/disposal custody.

V1 constraints:

- passive macOS synthetic preview only; other platforms return typed
  `unsupported` with the `unsupported_platform` diagnostic;
- passive filesystem and installation metadata observation only;
- no `claude` process execution;
- no login, logout, installation, update, network, saved profile, or launch;
- no fake native-profile selector if Claude Code does not provide Codex-like
  native profile semantics;
- typed unsupported/partial diagnostics rather than inferred support;
- cancellation and Host disposal retain the AR-1 meaning.

The synthetic end-to-end test proves only composition, filesystem custody,
passivity, DTO shaping, and cancellation/disposal. It does not inspect or prove
a real Claude Code installation, executable version, compatibility, login,
route, managed policy, or production Desktop collector.

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

### Prioritized remaining work

These priorities do not widen either passive inspection query:

1. `next`: exact compatibility evidence and installer/update as separate
   capabilities, including installed/latest status, transaction recovery, and
   immutable `BinaryRevision` evidence.
2. `later`: saved-profile publication, workspace trust/consent mutation,
   authentication, credentials, routes, access status, disconnect/logout, and
   live model/effort/Fast eligibility.
3. Future explicit decision: OpenCode passive setup inspection as AR-3 and a
   production collector/qualification campaign for each supported platform.

Desktop owns every UI workflow, label, progress display, confirmation, and
presentation integration for those capabilities in its separate repository.

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

## Capability authority matrix

| User capability | Current authority | Future recommendation |
| --- | --- | --- |
| see which runtimes appear present | Codex and Claude passive queries are implemented, unqualified, and report `found_unverified` | OpenCode, production collectors, and verified compatibility |
| understand portable Claude file intent | implemented and unqualified for the frozen three-source provider-specific classifier | managed/session topology, plugins, MCP, skills, commands, hooks, and instructions |
| understand why setup observation degraded | implemented typed local diagnostics and next actions; redaction is a cross-cutting invariant | provider health and repair workflows |
| create reusable profiles | not implemented by inspection | reviewed profile publication, import/export, inheritance, and organization policy |
| install or update a runtime | `next` and separate from inspection | channels, rollback, and fleet policy |
| authorize, inspect, or disconnect a provider account | `later` and not implemented by inspection | Provider Access login/import/refresh/revoke/disconnect flows |
| decide workspace trust or inspect live eligibility | `later`; passive preview supplies no consent or live proof | revisioned trust and binary/route/account-bound capability evidence |
| launch agents | outside Runtime Setup | Agent Execution operations after their own decisions and gates |

## Frozen AR-2 contract decisions

The contract-and-fixture handoff freezes:

1. the exact Claude Code configuration dialect, explicitly separate from any
   executable version or compatibility claim;
2. the three portable source paths and their documented precedence as captured
   at retained official-evidence coordinates;
3. the closed portable setting allowlist;
4. the route-owned and secret-shaped denylist plus stable deferred/rejected
   diagnostics;
5. trusted macOS collector inputs and display-path redaction;
6. stable diagnostic and result variants;
7. provider-specific fixtures and the required negative test matrix.

The TypeScript artifacts now implement provider-specific contracts,
application-owned ports, trusted-scope planning, authorization, passive
candidate observation, strict file parsing, semantic reduction, default Pure
DI composition, and the private callable. Fixed known paths and the three fixed
source paths are derived in composition; scope supplies only trusted explicit
executable paths, caller-supplied PATH entries, the exact dialect,
home/workspace roots, and the explicit workspace trust decision. Ambient
`CLAUDE_CONFIG_DIR`, process environment, process cwd, and interactive-shell
PATH are not inputs.

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
