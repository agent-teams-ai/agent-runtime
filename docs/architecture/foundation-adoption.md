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

Status: active consumer policy; the Foundation 1.7.2 source upgrade remains preliminary. Installed and full qualification are pending.

Agent Runtime uses Engineering Foundation only as development tooling. Runtime
code must not import it. Installation alone never enables policy: every active
capability below has an AR-owned configuration and executes in `pnpm check`.

## Adoption matrix

| Foundation surface | AR state | Evidence or gate |
| --- | --- | --- |
| `repository.agent-workflow` | enabled | Canonical `AGENTS.md`, agent pointers, changed/fast/full checks |
| `quality.gate-runner` | enabled for advisory CI diagnostics | AR-owned `ci-diagnostics` profile containing only the existing root `lint` and no-emit `typecheck` scripts; canonical JSON is emitted after the Ubuntu product lane succeeds |
| `workspace.dependency-declarations` | enabled | Exact pnpm catalog and workspace protocol policy |
| `architecture.source-dependencies` | enabled with explicit source owners | Production, test and development roots have consumer-owned boundaries; native roots retain their existing semantic owners |
| `quality.executable-specifications` | enabled for synthetic architecture evidence | The ADR-0006 JSON oracle, ADR-0010 disposition, independent evaluator, property/mutation checks, and XState path evidence support accepted ADR-0009 and ADR-0010 authority; they do not bind or implement a production runtime or establish implementation/deployment qualification |
| `documentation.local-references` | enabled | Local links and GitHub anchors under `docs`; the root README only points into that governed tree |
| `governance.architecture-decisions` | enabled | Stable ADR frontmatter, lifecycle index, and immutable accepted baseline |
| unified documentation protocol | portable activation retained; official stable31 migration applied | Portable profile v3, strict frozen-document sidecar, executable portable Skill and byte-preservation gate; Foundation 1.7.2 / Docs 0.6.2 / managed adapter 0.3.2 are exact development pins. The public adapter applied stable31 against Central `9625c6e6a73555d747cc4b0ba99a29549a75f107`; its after-check returned current. Retained stable28 receipts remain historical. Final installed/full qualification is pending. |
| `quality.suppression-governance` | enabled | Inline suppressions require exact, expiring AR-owned waivers; security and access-control suppressions are non-waivable |
| `quality.source-coverage` and canonical type-aware lint | enabled | The public Foundation route checks exact production selection, compiler coverage, protected rules, suppression governance and native gate reachability without a baseline or weakened production override |
| execution-backed mandatory Node tests | configured for the critical CMS pin gate; 1.7.2 qualification pending | `test:consumer-modules` retains the public `agent-teams-node-test` CLI and `architecture/foundation/mandatory-node-tests.json`; `quality:adoption` binds the exact selected CMS file. Earlier public-CLI evidence does not qualify the new release. |
| TypeScript and Oxlint base presets | enabled | Existing Node correctness and consumer-owned production/test maintainability budgets remain blocking |
| deterministic scaffolding | configured and consumer-qualified | Four exact bounded-context package identities are owned by immutable ADR-0005; synthetic Plan, Apply, and generated-package checks are blocking |
| `package.public-api-compatibility` | A3 enrollment, trusted activation pending | Six private package archives and public imports are qualified against EF 1.6.0; source-bound typed observation, released history and external authority grant remain pending. The local SDK profile gate cannot authorize a release. |
| `contract.protobuf-evolution` | gated | Enable when AR accepts its first Published Language Protobuf module and released descriptor |
| `contract.json-schema-releases` | gated | The qualification registry schema is repository-internal; enable only if a JSON Schema becomes an independently supported contract |
| `repository.security-baseline` | gated | Enable when this repository publishes an npm package; do not fabricate publish evidence |

"Gated" is an applicability decision, not forgotten work. Its trigger must be
re-evaluated in the same PR that introduces the corresponding public contract or
publishing workflow.

## Node compatibility source policy evolution

The stable28 documentation cohort and its managed files keep their original
byte identities. The existing migration test also pinned the then-current
Source Dependencies policy at SHA-256
`073d904b6ed55ac5ae8d0738d2b50762cc65ef653ed647aa28e98b5d574370b0`
at revision `ab8efe2874c0600ea3930b4fe72bfc68d173543d`. That is historical
qualification evidence, not the identity of the live source policy.

Revision `98b75f694a0c72ad26d2cab19ff56713676b56a6` scoped the existing
ordinary PostgreSQL CI boundary to its two files and added an exact development
boundary for the three Node compatibility CI files. The resulting live policy
has SHA-256 `a8ab641089abd81b0bb4387ef47ecf63a193aba2051d6ed87a3b5e2c8fca1c4c`;
the [successor identity](../../architecture/foundation/source-policy-node-compatibility-evolution.json)
records both revisions. No governed root, workspace package or production
boundary was removed. The Foundation source check and disposable rejecting
fixtures must still reject an unclassified future CI file, unauthorized Node
builtins in ordinary PostgreSQL CI, and imports outside the Node compatibility
allowlist.

The correction is committed at exact revision
`8b104417d51fe95d77c7dfff623fb484ce3e759b`, policy Git blob
`9beef0450e9f3e86e2819e874faf06e0f94efe5e`, and SHA-256
`85f4235863df10f71610f21a1ea3854253f19078b0af8b502875c27ddacf6610`.
It adds `node:child_process` only to the exact three-file Node compatibility CI
boundary so its disposable pnpm engine and peer rejection test can execute.
The evolution receipt retains the predecessor and successor commit, blob and
SHA-256 identities alongside this committed amendment. The migration gate reads
each policy from its actual Git object, checks its SHA-256 and ancestry, and
proves that this amendment differs from the successor by that one allowlist
entry. Removing it restores the successor's exact policy bytes and hash. The
two-file ordinary PostgreSQL boundary, all governed roots, and the stable28
managed cohort remain unchanged.

## Advisory quality diagnostics

Agent Runtime owns `architecture/foundation/quality-gate-runner.yaml`. Its only
profile, `ci-diagnostics`, allows only the root `lint` and no-emit `typecheck`
scripts, runs them with concurrency two, and gives each a 120000 ms deadline.
Those deadlines cap the concurrent diagnostic at two minutes within the
Ubuntu product lane's 35-minute budget. This is a safety ceiling, not timing
evidence or a speed claim.

The CI invocation is diagnostic and `continue-on-error`; it runs only after
the independent product lane succeeds and neither removes nor replaces any
required gate. The profile does not authorize product, architecture,
documentation, Foundation, scaffolding, test, Rust, spike, evidence-capture,
runtime, agent, or wrapper
scripts. It does not run on macOS and provides no macOS or Windows evidence.
Rollback removes the Ubuntu diagnostic step, package script, capability
declaration, and owned profile together.

## Complete CI routing

`pnpm check` still executes the complete gate serially. CI schedules its five
groups (quick, Foundation, architecture, Docs and product) independently; product
prerequisites remain ordered inside that lane. The blocking `check` aggregate
requires all five successful results, including when a dependency failed, was
cancelled or skipped. PostgreSQL durability, macOS runtime, trusted Docs and
commit identity checks retain their separate blocking contracts.

The consumer-owned bounded package-script router and conformance gate compare
the reviewed terminal commands and ordering constraints. Missing, duplicate,
cyclic and nonblocking routes reject. Existing adoption assertions follow these
routes instead of requiring commands directly in the root script. The current
CMS tests additionally retain source-bound Node identities and statuses from
two actual executions; the unchanged installed public CLI still protects its
three selected identities without OS exceptions. These observations do not
qualify a new Foundation release or authorize product deployment.

Direct trusted ordinary package-body PRs may defer whole tooling regressions
under [the fixed policy](../../architecture/foundation/ci-pr-regressions.json).
CI selftests use synthetic product bodies; their actual helpers/tests, ER
runner/reporter anchors, workflows, policy, install and toolchain inputs belong
to the unchanged common closure. Complete immutable base/head membership,
kinds, modes and actual checkout/installation observations must close first.
PR quick routing always executes `node scripts/ci/conformance.ts`; a deferred
`node --test scripts/ci/contracts.test.ts` records zero execution and no passes.
Foundation body anchors, CMS body roots and the Docs canary retain their own
regression selections. All current-source/modularity/CMS validators, both CMS
pin processes, six product packages, root/typed/native, Darwin and PostgreSQL
stay required. Common, unknown, structural, environment or installation drift
(including inherited fixture/observation overrides) selects FULL. Main, nightly,
merge group, manual and reusable full calls retain
the original complete commands; local full/fast commands retain their meaning.

## Maintainability budgets

Production TypeScript is limited to 500 effective lines per file, 150 per
function, complexity 20, nesting depth 4, and 5 parameters. Tests, fixtures,
and experiment evidence use 800, 250, 30, 5, and 6. Generated and vendored code
is excluded. A temporary exception must be represented by a supported,
owner-bound and expiring waiver; silently weakening the shared preset is
forbidden.

## Type-aware quality activation

Agent Runtime activates the published `quality.source-coverage` capability
through `quality:coverage:scope` in the fast gate and `lint:typed` in the full
gate. The profile uses the six existing production package tsconfigs, the
consumer-owned source and feature-module authorities, and the existing native
quality terminal. The protected Foundation presets remain unchanged.

The route rejects missing production sources, compiler gaps, stale or unknown
suppressions, weakened protected rules and no-op or indirect command wiring.
A baseline cannot satisfy the route. Existing product, architecture, typecheck,
test and applicable platform gates remain independently required.

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

`pnpm docs:protocol:check` is the consumer semantic gate: it runs `docs:check`
followed by `docs:governance`. The full Docs lane, `pnpm check:ci:docs`, runs
that gate followed by `pnpm docs:qualification`, exactly once each.
`pnpm check:fast` also runs qualification immediately after the semantic gate;
`pnpm check` retains all five unconditional lanes.

Runtime qualification remains typechecking, serial adoption and migration
checks, and the five portable authoring scenarios for index, architecture,
ADR, evidence and qualification-plan documents. It retains crash/recovery
and source-immutability checks. Central SDK qualification of the profile and
trusted lock graph does not replace these consumer scenarios. The frozen CI
contract retains its historical nesting; routing conformance compares expanded
leaf commands and their multiplicity to preserve its complete inventory.

## Foundation 1.7.2 source upgrade

The exact root development dependency and regenerated frozen registry lock
select 1.7.2 after the official stable31 migration. The tooling floor
is Node 24.21.0, selected by `.node-version` and the root manifest; required
CI already consumes that file. Product package engines retain their Node 24
family. Node 26 is not activated. Historical platform and cohort receipts keep
their original toolchain and source identities.

The public execution-backed command protects three important existing Node test
identities in the existing CMS pin entry file. Its contract alone protects only selected
files; `quality:adoption` also rejects changing that exact command or dropping a
selected file. The consumer contract has no OS exceptions because these tests
use portable disposable fixtures. Disposable public-CLI fixtures admit only an exact
identity, status and proper OS subset; omission, skip, todo, failure, duplicate
identity and blanket OS exceptions reject. Existing product, native and
PostgreSQL integration runners retain their separate contracts.

All source boundaries, coverage roots, six compiler projects, maintainability
budgets and the exact unknown-assertion admissions remain enforced. Missing or
unreadable declared inputs and explicitly governed generated directories cannot
be made invisible to obtain a pass. The public typed route retains the default
unknown-assertion bridge gate; there is no blanket opt-out.

The current Consumer Module Standard pin remains document commit
`9c722ceff4ede307d06d7a4b63fdebe615f54c53`, SHA-256
`33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd`.
The reviewed upstream snapshot `a01a129d39fe6574dba39e6187bb03ef6bcf9945`
has identical bytes. The retained ac49bb33-to-9c722cef review adds only the
ADR-0029 relation and optional dynamic Host candidate guidance; it does not
expand Agent Runtime composition. Both current profiles already carry this pin.
No accepted ADR or retained standard bytes change.

SDK enrollment remains `pending-authority-qualification` with
`releaseEligible: false`. Its current `installedTooling` source record selects 1.7.2
without relabeling the retained 1.6.0 registry/package qualification or 1.5.1
typed observations. Current SDK strict extraction, histories, owner decisions
and external authority remain pending. Native and scaffolding checks retain
existing owners and disposable mechanisms; plugin/runtime platform adoption
remains outside this upgrade.

The retained preliminary 1.7.1 lock failed the Docs adapter 0.2.11 public
`observeDocsProtocolQualificationV3Lockfile` boundary with
`DOCS_CONSUMER_DUPLICATE_COHORT_RESOLUTION`. Supplied operator evidence reports
Foundation 1.7.2 and managed adapter 0.3.2 as public, with the exact five-package
registry/SRI/Sigstore audit passed; this source delta performs no independent
registry audit. The public adapter has now migrated the authentic stable28 origin
to stable31 against protected Central revision `9625c6e6a73555d747cc4b0ba99a29549a75f107`.
The after-check returned current and the regenerated lock passes frozen install.
Final consumer qualification and delivery remain pending; retained old managed
receipts and separate custody/coordinator prerequisites remain historical or pending.

Foundation #363's nested `NODE_TEST_CONTEXT` CLI defect was fixed and released
in Foundation 1.7.2 through #365. The earlier failure remains historical. This
consumer retains the public command and adds no environment scrubber or alternate
runner. Final installed public-CLI and full consumer qualification remain
pending; earlier 1.7.1 source gates are not 1.7.2 success evidence.
