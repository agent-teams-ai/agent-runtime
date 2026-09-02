---
id: runtime.architecture.foundation-adoption
type: architecture
status: active
owner: architecture/tooling
summary: Records the exact Engineering Foundation capabilities adopted by Agent Runtime.
related:
  - ADR-0005
code_anchors:
  - enforcement: required
    pattern: architecture/foundation/**
  - enforcement: required
    pattern: package.json
---

# Engineering Foundation adoption

Status: active consumer policy backed by the current exact registry dependency.

Agent Runtime uses Engineering Foundation only as development tooling. Runtime
code must not import it. Installation alone never enables policy: every active
capability below has an AR-owned configuration and executes in `pnpm check`.

## Adoption matrix

| Foundation surface | AR state | Evidence or gate |
| --- | --- | --- |
| `repository.agent-workflow` | enabled | Canonical `AGENTS.md`, agent pointers, changed/fast/full checks |
| `quality.gate-runner` | enabled for advisory CI diagnostics | AR-owned `ci-diagnostics` profile containing only the existing root `lint` and no-emit `typecheck` scripts; canonical JSON is emitted in the Ubuntu `check` job after the independent complete gate |
| `workspace.dependency-declarations` | enabled | Exact pnpm catalog and workspace protocol policy |
| `architecture.source-dependencies` | enabled for current TypeScript evidence code | All current TypeScript experiment roots form one explicitly non-production boundary; production package boundaries are added when scaffolded |
| `quality.executable-specifications` | enabled for synthetic architecture evidence | Cataloged JSON authority, independent evaluator, property/mutation checks, and XState path evidence support review of proposed ADR-0006; they do not bind or implement a production runtime or establish implementation/deployment qualification |
| `documentation.local-references` | enabled | Local links and GitHub anchors under `docs`; the root README only points into that governed tree |
| `governance.architecture-decisions` | enabled | Stable ADR frontmatter, lifecycle index, and immutable accepted baseline |
| unified documentation protocol | adoption prepared | Foundation profile v2, strict frozen-document sidecar, shared agent route, and static byte-preservation gate; exact package versions and CLI qualification are completed in the coordinated release wave |
| `quality.suppression-governance` | enabled | Inline suppressions require exact, expiring AR-owned waivers; security and access-control suppressions are non-waivable |
| TypeScript and Oxlint presets | enabled | Node correctness plus the agreed production and test maintainability budgets |
| deterministic scaffolding | configured and consumer-qualified | Four exact bounded-context package identities are owned by immutable ADR-0005; synthetic Plan, Apply, and generated-package checks are blocking |
| `package.public-api-compatibility` | gated | Enable when an independently consumed TypeScript package has release-owned API evidence |
| `contract.protobuf-evolution` | gated | Enable when AR accepts its first Published Language Protobuf module and released descriptor |
| `contract.json-schema-releases` | gated | The qualification registry schema is repository-internal; enable only if a JSON Schema becomes an independently supported contract |
| `repository.security-baseline` | gated | Enable when this repository publishes an npm package; do not fabricate publish evidence |

"Gated" is an applicability decision, not forgotten work. Its trigger must be
re-evaluated in the same PR that introduces the corresponding public contract or
publishing workflow.

## Advisory quality diagnostics

Agent Runtime owns `architecture/foundation/quality-gate-runner.yaml`. Its only
profile, `ci-diagnostics`, allows only the root `lint` and no-emit `typecheck`
scripts, runs them with concurrency two, and gives each a 120000 ms deadline.
Those deadlines cap the concurrent diagnostic at two minutes against the
Ubuntu job's 20-minute budget, which has remained unchanged since that job was
introduced. This is a safety ceiling, not timing evidence or a speed claim.

The CI invocation is diagnostic and `continue-on-error`; it runs only after
the independent `pnpm check` succeeds and neither removes nor replaces any
required gate. The profile does not authorize product, architecture,
documentation, Foundation, scaffolding, test, Rust, spike, evidence-capture,
runtime, agent, or wrapper
scripts. It does not run on macOS and provides no macOS or Windows evidence.
Rollback removes the Ubuntu diagnostic step, package script, capability
declaration, and owned profile together.

## Maintainability budgets

Production TypeScript is limited to 500 effective lines per file, 150 per
function, complexity 20, nesting depth 4, and 5 parameters. Tests, fixtures,
and experiment evidence use 800, 250, 30, 5, and 6. Generated and vendored code
is excluded. A temporary exception must be represented by a supported,
owner-bound and expiring waiver; silently weakening the shared preset is
forbidden.

## Bounded-context scaffolding

The approved catalog contains exactly the four initial contexts from ADR-0002
with the package identities accepted by ADR-0005:
Runtime Configuration, Runtime Security, Provider Access, and Agent Execution.
The generic recipe creates only a private TypeScript package boundary. It does
not invent features, layers, dependencies, or DDD abstractions.

For a context, generate and save a Plan from its intent under
`architecture/foundation/scaffold-intents/`. Review the Plan together with the
first real feature, then Apply it explicitly. Never run an implicit Plan-and-
Apply flow. After Apply, add the new source root and its allowed edges to
`architecture/foundation/source-dependencies.yaml` in the same PR. Empty layer
folders and placeholder abstractions remain prohibited.

An interrupted Apply is resolved only with `foundation:scaffold:recover`; a
journal is never removed by hand.

## Upgrade rule

Agent Runtime pins the latest reviewed Foundation release as an exact root
development dependency. Foundation-owned contracts have one current identity,
`v1`, under
Foundation ADR-0019. Before independent production adoption, a breaking
correction updates that sole `v1` plus every known consumer in one coordinated
release and adoption wave. External tool versions, product protocol versions,
and package SemVer are separate namespaces and do not create a parallel
Foundation contract.

## Documentation protocol boundary

The shared Docs Protocol is the only documentation command UX. Engineering
Foundation owns catalog parsing and every mutation or recovery action. Agent
Runtime owns only the declarative profile, metadata schema, owner catalog,
sidecar, templates, indexes, and semantic validation IDs.

Accepted ADRs and registered evidence are never rewritten to adopt catalog
metadata. Their metadata is merged from the strict path sidecar and
`pnpm docs:governance` independently verifies all 36 retained byte digests.
Package scripts remain pinned to exact reviewed registry releases; local links
and unpublished packages are not qualification evidence.
