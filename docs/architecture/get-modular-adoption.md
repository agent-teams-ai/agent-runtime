---
id: runtime.architecture.get-modular-adoption
type: architecture
status: active
owner: architecture
summary: Records scoped passive setup and ordinary session Assembly adoption without extending contained-turn qualification.
---

# Get Modular adoption

## Ordinary session scoped adoption

[ADR-0090](../decisions/0090-ordinary-user-session-codex-execution-profile.md)
authorizes the additive `user-session-v1` composition. The
[consumer profile](../../architecture/get-modular/consumer-profile.json)
retains ADR-0015 as its passive authority and records ADR-0090 on the ordinary
composition itself. Accepted ADR-0016 custody adoption remains pending; ordinary
execution does not establish contained-turn security or qualification.

The existing Runtime Setup Assembly remains the single construction root.
The ordinary extension declares eight owned nodes: operation store, Runtime
Security, Provider Access, workspace, artifacts, process, provider and turn.
The turn requires exactly seven dependencies; Provider Access additionally
consumes Security's operation-bound secret-registration capability. Process
requires Provider's `agent-runtime/ordinary/prepare-launch` capability. The same provider
factory returns execution and launch preparation from one adapter owner; Assembly
injects preparation into Process before the closed turn is materialized. The Host
receives the closed ordinary turn root. Every capability has a contract
descriptor with revision 1, so its token is `<capabilityId>/r1`; the tokens
are distinct from the execution profile, manifest and persistence codec
identities.

The ordinary feature's full source and exact new files in existing features
have [scoped active FMS adoption](../../architecture/feature-module-standard/ordinary-scope.json).
The checker reuses existing FMS inventory, imports, layers, ownership and
maintainability rules. A finite source/target/import-kind list covers existing
Host composition seams only; application/domain imports cannot use that list.
New source, unknown seams, stale seams and behavioral facade code are rejected.
The existing full FMS profile now includes Embedded Runtime as an active host-app
under ADR-0023. Ordinary scoped adoption remains additive on that same Host
feature.

`pnpm architecture:get-modular-adoption` executes blocking source diagnostics,
the live census, exact ordinary graph checks and scoped FMS checks.
`pnpm test:get-modular-adoption` includes ordinary authority, source census,
Node/SDK/layer, slot, capability, cardinality, token and binding mutants.
Both commands remain in fast and full gates; runtime preparation, cleanup and
public construction tests are mapped in the same profile. These architecture
gates do not substitute for the ordinary end-to-end execution evidence.

### Module identities

Module and implementation IDs lie in the `agent-runtime/` namespace, and
`owner.authority` is `agent-runtime` for all sixteen declarations. Descriptors
own capability IDs and revisions (`defineContract`); declarations reference
descriptors through `declareModule` and never spell `compatibility`. An
implementation ID names the variant, so a later store, process or provider
variant gets a new implementation ID under the same module. The passive and the
ordinary Host share one module and have two implementation IDs, because their
slots differ. No ID is stored outside code, tests, gates and docs; renamed IDs
needed no data migration.

| moduleId | implementationId | provides | slots |
| --- | --- | --- | --- |
| `agent-runtime/setup-security` | `agent-runtime/setup-security/default` | `agent-runtime/codex-authorization`, `agent-runtime/claude-authorization` | none |
| `agent-runtime/installation-discovery` | `agent-runtime/installation-discovery/default` | `agent-runtime/codex-installations`, `agent-runtime/claude-installations` | none |
| `agent-runtime/codex-configuration` | `agent-runtime/codex-configuration/default` | `agent-runtime/codex-configuration` | none |
| `agent-runtime/claude-configuration` | `agent-runtime/claude-configuration/default` | `agent-runtime/claude-configuration` | none |
| `agent-runtime/codex-planner` | `agent-runtime/codex-planner/default` | `agent-runtime/codex-planner` | none |
| `agent-runtime/claude-planner` | `agent-runtime/claude-planner/default` | `agent-runtime/claude-planner` | none |
| `agent-runtime/runtime-host` | `agent-runtime/runtime-host/passive` | none | the eight setup slots |
| `agent-runtime/runtime-host` | `agent-runtime/runtime-host/ordinary` | none | the eight setup slots and `ordinary-turn` |
| `agent-runtime/ordinary/store` | `agent-runtime/ordinary/store/postgres` | `agent-runtime/ordinary/store` | none |
| `agent-runtime/ordinary/security` | `agent-runtime/ordinary/security/postgres` | `agent-runtime/ordinary/security`, `agent-runtime/ordinary/register-secrets` | none |
| `agent-runtime/ordinary/provider-access` | `agent-runtime/ordinary/provider-access/postgres` | `agent-runtime/ordinary/provider-access` | `register-secrets` |
| `agent-runtime/ordinary/workspace` | `agent-runtime/ordinary/workspace/node` | `agent-runtime/ordinary/workspace` | none |
| `agent-runtime/ordinary/artifacts` | `agent-runtime/ordinary/artifacts/node` | `agent-runtime/ordinary/artifacts` | none |
| `agent-runtime/ordinary/process` | `agent-runtime/ordinary/process/node` | `agent-runtime/ordinary/process` | `prepare-launch` |
| `agent-runtime/ordinary/provider` | `agent-runtime/ordinary/provider/codex` | `agent-runtime/ordinary/provider`, `agent-runtime/ordinary/prepare-launch` | none |
| `agent-runtime/ordinary/turn` | `agent-runtime/ordinary/turn/default` | `agent-runtime/ordinary/turn` | `operation-store`, `security`, `provider-access`, `workspace`, `artifacts`, `process`, `provider` |

The composition root is a function of `Assembly`: `composeRuntimeSetup` binds
every factory through the api it receives. The ordinary feature exports its
declarations and unbound module factories and does not import the Host's
capability map. `pnpm architecture:get-modular-adoption` checks the literal
descriptors and declarations of the ordinary feature and the Host handoff, and
the package tests compile both profiles and compare the plan bindings and
tokens with a hand-written list.

Construction order is the Core tie-break by implementation ID, and the package test pins it as a literal list for both profiles. In the ordinary profile `agent-runtime/setup-security/default` is constructed after the eight ordinary owners. This is safe: it has no slots, the ordinary Security owner is a separate module, and no ordinary owner reads its output or relies on its side effects; if an order requirement ever appears, it must be an explicit slot, not an ID.

### Ordinary closure retention and binding evidence

An unsuccessful bounded reservation close leaves the ordinary flight owned.
Concurrent disposal calls join one attempt; rejection permits another bounded
attempt, and observed closure plus durable reconciliation releases the flight.
The Host retains its resource owners and writable observation journal until the
Host drain, including the feature's disposal, succeeds. Owners (security, Provider
Access, Codex) live in an `owners` scope under an `ordinary-host` scope that also
holds the journal; the owning modules are bound with `scoped()` and receive the
`owners` resources as the run scope. Owners release in reverse construction order
and continue past a failed owner; a failed release is a debt named by implementation
ID, retried by the next disposal without repeating successful releases. The journal
closes only after the owners report a complete close. There is no root deadline in
this train (ADR-0024). The tests pin the release order, the failed-owner retry and
the retained journal, and run `smoke` for the passive and ordinary roots and
`isolate` for the provider module.
A timeout or rejection never proves termination. Reconciliation workspaces remain
retained; retry does not publish artifacts or reclassify a reconciled turn as success.

The ordinary Host construction also receives the same closed turn owner for an
explicit disposal handoff. Successful owner disposal releases physical ownership
from the Host ledger while durable operations remain `reconcile_required`.
Only ordinary owner disposal is retryable through this handoff; contained-turn
termination rules remain unchanged. Engine retries retain each unfinished process,
credential retirement and grant settlement action until its receipt is reconciled.
Provider Access retains its writable store on disposal failure and does not repeat
successful destructive cleanup. Broker retries observe the original server close
work after a bounded timeout. Process output loss remains permanently visible
across close retries, including an unterminated fragment discarded before late EOF.
The static adoption checker rejects a missing or substituted Host owner handoff.
No Assembly slot, capability, compatibility token, provider binding or standard
byte changes accompany this Host construction contract extension.

The [second lifecycle review](../../architecture/get-modular/evidence/ordinary-lifecycle-retry-review.json)
records the five fixes and focused source checks using synthetic ports and real
Host/Provider Access owners. Supported builds, typechecks and the full adoption
checks remain pending because dependencies are unavailable in this checkout.

The materialized ordinary root test uses disposable ports and asserts that Process
receives the exact launch function exported alongside Provider execution. A wrong
provider binding fails compilation before factory calls. The active graph checker
and rejecting mutants enforce the required slot, capability and exact binding.
The engine tests cover failed closure, concurrent retry, and late evidence commit
failure without repeating an observed close. Host tests cover retained journal
writes and exact-once final disposal. No real provider is launched.

The 2026-09-14 review compared the retained complete standard against the
controller's then-current upstream measurement: both were revision `669a750d`
and SHA-256 `e6cd8d26b4317bf5f94ddd22f6e36bf25e90548f72265d94808eaf20b947e553`.
At that checkpoint there was no standard byte delta or pin migration. This applies its existing
Host ownership and required static binding rules; shared guidance needs no change.
Accepted ADRs and retained standard bytes remain unchanged. The local lifecycle
and binding evidence remains pending execution because this checkout lacks
dependencies and the pinned pnpm runtime. The dependency-free synthetic process
retry regression passes on Linux; six existing Darwin process tests are skipped.
The [delivery review](../../architecture/get-modular/evidence/ordinary-lifecycle-pairing-review.json)
records exact commands, evidence and remaining checks. Existing paired qualification evidence remains pending.

## Status and authority

Status: scoped passive setup profile active, with blocking live source census
and package archive verification. Integrated delivery, current L0 evidence,
independent review and measured benefit remain separate release gates. This
document does not certify their completion.
[ADR-0015](../decisions/0015-passive-setup-static-assembly-adoption.md) accepts the
bounded contract. ADR-0008 and its historical evidence remain immutable;
ADR-0013 continues to govern exactly its three active FMS features.

The central authority is Get Modular's accepted ADR-0026 and the exact pinned
[consumer module standard](https://github.com/agent-teams-ai/get-modular/blob/81063add7de50ffe2b91cc74bf7271b298624c21/docs/architecture/common-assembly.md#consumer-module-standard).
The [current successor review](../../architecture/get-modular/evidence/smart-ci-cms-pin-review.json)
bridges the historical `9c722` head to this reviewed document. Both the
[zero-delta review](../../architecture/get-modular/evidence/runtime-profile-cms-pin-review.json)
and parallel [creation-cleanup review](../../architecture/get-modular/evidence/creation-cleanup-cms-pin-review.json)
remain independently enforced history against retained predecessor bytes.

- Repository: `agent-teams-ai/get-modular`.
- Commit: `81063add7de50ffe2b91cc74bf7271b298624c21`.
- Path: `docs/architecture/common-assembly.md`; anchor: `consumer-module-standard`.
- Complete document SHA-256: `49d08b6d1762e94308157fb59b3aa82ac1630c91f529f6efcd4915dfffee7ba7` (47,402 bytes).
- Retained bytes are recorded by the consumer profile; they are evidence, not a second authority.

Document identity, package versions/archive integrity, Core compatibility token,
and local adoption authority are distinct. The profile retains the approved published
Core and Assembly 0.3.0 archives, verifies their SHA-256 and lock integrity,
and requires exact catalog versions. It records actual blocking commands,
without `conformant: true` for the repository. The A3 and dynamic Host migrations
remain reviewed below. The historical zero-delta review applies to retained
predecessor bytes; the current revision has the separately reviewed successor
delta linked above. No moving main is consumed.

The consumed release archives are distinct from the standard pin:

| Published root | Version | Retained archive SHA-256 |
| --- | --- | --- |
| `@get-modular/core` | `0.3.0` | `bd84c087c7d6842907d08a1a2f6dc0afd250e297f9456e0f77b87630e0f5093e` |
| `@get-modular/assembly` | `0.3.0` | `3a4312465485269971db08efb10759fb3a3d4d23266c7f5d9fe8069b4bb411c8` |

The consumer profile retains both complete published archives and exact
lockfile integrity. The historical 0.1.0 stage1 entry digest belongs to its
earlier release evidence and does not identify the current archive.
The archives are the Get Modular 0.3.0 release, commit
`bb364ac8ca461b5e8277eeb3f7867b26187f99e8`
([get-modular#150](https://github.com/agent-teams-ai/get-modular/pull/150)),
taken from the retained bundle `get-modular-0.3.0-train-r1a`, which was packed
from release PR head `9e529d69150c1738c29d56a05de7cada60547808` (the head at
packing time; the release commit has the same tree as the regenerated release
head `87cb92324f1de7a0b5fd5631ac46f1f58002fde2`, and the standard bytes are
identical at the pin, the bundle source, the release commit and get-modular main
at `c6ec622f3c206af11e3448386ffcce42b1184f17`, checked on 2026-10-10). They equal the registry tarballs byte for
byte. Pre-publication evidence is the consumer check
[modularity-host-test#16](https://github.com/agent-teams-ai/modularity-host-test/pull/16)
(merge `4501de4c0439cbb8e242c69354e29188360178ce`) and the consumer checks in
[release-intent.md](https://github.com/agent-teams-ai/get-modular/blob/c6ec622f3c206af11e3448386ffcce42b1184f17/research/releases/0.3.0-train/release-intent.md)
at `c6ec622`. The 0.1.0 and 0.2.0 archives stay retained as historical evidence.
The [packed consumer test](../../packages/apps/embedded-runtime/tests/package/assembly-packed-consumer.test.ts)
installs declared production roots and checks passive behavior and typings.
These identities do not assert whole-runtime conformance.

## Ownership and composition scope

Only default embedded passive setup is admitted. Its one async default factory
uses seven handles and eight required slots; Codex and Claude capabilities are
siblings, both closed before access binding. The internal sync leaf remains a
test reference seam and is also used by the retained Host-custodied contained-turn
owner. That existing contained-turn boundary is not adopted or qualified by this
change. Domain/application imports remain inward under strictClean; Assembly
mapping belongs only to the outer embedded composition adapter.

New independently composed capabilities, alternative implementations, and
configurable cross-module relationships require standard mapping or an exact
accepted exception. Ordinary fixed feature-local helpers keep static typed
imports. No feature-per-class rule, wildcard legacy allowance, implicit
inventory growth, string service locator, or universal manager is authorized.
The scoped FMS gate remains independent. The live Foundation inventory records six workspace package roots, thirty-five feature
roots, forty-one policy boundaries and exact source/target/runtime-or-type
relationships. Unknown or stale roots and relationships fail, including new
cross-feature edges inside an existing policy boundary. Fixed helpers within
one feature remain ordinary imports. The two retained Host-custodied
contained-turn composition seams are enumerated explicitly. New capabilities
hidden inside existing functions still require semantic ownership review.

The A3 public-export reconciliation records four additional type-only edges:
the Embedded Runtime composition entrypoint to access authority, authority
capability and current authority types, plus the contained-turn runtime access
composition to its operation-reference type. These are declaration dependencies
inside existing owners, not new runtime bindings or separately managed module
lifecycles. The exact source census rejects an absent edge or a change from
type-only to runtime; contained-turn adoption and qualification remain pending.

The same draft reconciliation records 76 more exact relationships introduced by
the curated Agent Execution, Provider Access and Runtime Security surfaces:
70 type-only declarations and six runtime exports from the Agent Execution
internal barrel. Most declarations are exported through existing feature
entrypoints; the runtime exports remain fixed helpers of the contained-turn
feature, not new independent composition handles. The complete source/target
list is retained in the profile, and its live census currently passes all 59
adoption tests. This classification remains subject to final public-surface
review and a fresh census after the A3 export patch is finalized.

### PR71 incoming composition review

The profile reconciliation at `291684ed93df4f7b6cbe1d9776e55fe4082c8c3a`
reviews the incoming `e411638c0dfb460f0a869d2bc9a7c45229873e98` source
against the earlier `be69d71` profile census. The exported `readSourceCensus`
reports 26 added relationships, no removed relationships and unchanged package,
production and feature roots. The complete upstream standard is byte-identical
to the retained pin; neither the standard pin nor its evidence needs migration.

| Boundary and added relationships | Reviewed owner classification |
| --- | --- |
| Docker custody (2) | `node-docker-route-provenance.ts` retains private one-use recipe identity, sharing Engine policy snapshots through the existing Docker Engine boundary. Its snapshot helpers remain local. This contained-turn owner is not adopted. |
| Host custody (1) | `KernelOpenAttempts` fences attempts for the existing kernel owner's lifetime. Its kernel port dependency is type-only; the helper has no separate lifecycle or handle. |
| Embedded Runtime composition (9) | Current-authority selection, Linux Codex contained-turn owner, deployment authority, deployment resources and Node recipe are meaningful direct Host composition seams, explicitly not adopted. `linux-codex-node-recipe-consumption.ts` only binds operation subjects and signer references inside that composition; its Agent Execution dependency is type-only. |
| Agent Execution production (14) | Native broker installer/deferred binding, route enforcement, Docker current-kernel/effect custody and Node deployment recipe remain direct contained-turn owners. The route-provenance composition creates one private registry shared by issuance and selection. `docker-consumption-observations.ts` only projects observations from existing owners. Exact Codex adapter and Host/Docker custody edges remain enforced. |

Review of newly added production files also covers owners whose local imports
do not add census edges. `NodeHttpEgressBoundaryIds`,
`NodeHttpEgressTrustedResolver` and `PostgresHttpEgressEvidence` implement
existing Host HTTP ports selected by Embedded Runtime and remain not adopted;
the evidence codec and transaction mechanics are local implementation helpers,
with the database pool borrowed from Host. `retainLaunchWorkspace` owns a
retained descriptor within existing workspace custody. Docker workspace capture,
Linux route privilege validation and native-start diagnostic readback remain
fixed local helpers of their existing owners, not separate composition nodes.

These classifications cover meaningful owners even when the source census folds
their local wiring into an existing policy boundary. They do not create one
Assembly handle per file or an exemption for future direct edges. The profile
retains every observed source, target and dependency mode, including dependencies
from local helpers that cross a policy or package boundary. Rejecting tests
remove each reviewed incoming relationship and change its dependency mode
against the live census; both mutations must fail.

Only passive setup remains adopted. Contained-turn claim/start fencing,
authority selection, route admission, private-root and resource custody,
cleanup and reconciliation remain with their existing Host owners. This
reconciliation changes no runtime behavior and grants no new qualification.

### PR71 bounded profile reconciliation

At exact source `81b2833af327c6c4559f92a822c83529431565c0`, the
Foundation-backed `readSourceCensus` reports 14 added relationships and no
removed relationships relative to the retained profile. Package, production
and feature roots are unchanged. The complete upstream Consumer Module Standard
bytes remain SHA-256
`ea54578ebe69fc410bf973b6112dcefc4ad7c163e563e0ee307cd7b5f8b8723d`,
so the reviewed `a05f2cb` pin remains current.

| Boundary | Added | Reviewed classification |
| --- | ---: | --- |
| Codex app-server adapter | 1 | `DarwinCodexNativeFiles` is a fixed adapter resource helper using the existing durable Host journal; not an independently composed capability. |
| Host custody adapter | 1 | Darwin durable route storage uses the existing filesystem-custody lock inside Host-owned lifecycle and remains outside passive Assembly scope. |
| Embedded Runtime composition | 6 | Darwin authority and deployment are meaningful independently composed direct Host roots. They are explicitly outside the adopted passive setup scope; their Agent Execution, Provider Access and Runtime Security edges are retained without adding graph nodes. |
| Agent Execution production | 6 | Darwin post-claim preparation and route enforcement remain direct contained-turn owners outside passive scope. Route enforcement is a fixed feature-local helper, not a separate graph node. |

Rejecting coverage removes every one of these reviewed relationships and changes
its dependency mode against the independently loaded live census. Positive
coverage preserves the mixed type-only/runtime Darwin authority classification
and the explicit outside-passive-scope ownership decision. Passive Assembly
remains the same seven-node composition. This reconciliation makes no native or
provider readiness claim and changes no runtime behavior.

## PR110 standard pin migration

Both consumer profiles now pin merged Get Modular PR110 commit
`669a750d8db451e04f075cdeb36576c6606fba6e`. Exact complete document bytes
match SHA-256 `e6cd8d26b4317bf5f94ddd22f6e36bf25e90548f72265d94808eaf20b947e553`.
The previous passive pin was `a05f2cb51553e1efc5ba89be352e4aba04675088`;
the contained-turn pin was `f1ec0152c34715395685b349844a7d1c18a2f015`.
Their retained document identity was
`ea54578ebe69fc410bf973b6112dcefc4ad7c163e563e0ee307cd7b5f8b8723d`.
The earlier PR71 observations above describe their historical checkpoints.

The complete byte delta relocates five executable example links from
`packages/assembly/tests` to `tests/assembly`, and clarifies ownership before
handoff, cleanup registration at acquisition, borrowed capability lifetimes,
async provider responsibility for allocations not handed back, one-shot Host
summaries, opaque causes, existing references and readiness/publication.
The migration packet's premerge status is superseded by the exact merged
identity; its scoped applicability remains relevant.

In passive setup, `runtime-setup-assembly.ts` captures the Host before the
completion seam. `default-agent-runtime-host.ts` retains this owner while
awaiting Assembly, awaits cleanup on failed handoff, and clears attempt
ownership only when transferring the usable Host to its caller. Passive
factories construct objects and closures; the review found no external
acquisition before Host capture requiring new cleanup machinery. Receiving a
capability does not authorize its disposal. A rejected async provider owns any
allocation it cannot return. This API transfers a live Host; the one-shot
summary rule does not change that API or dispose the Host before return.
Opaque causes remain private, and safe summaries do not certify their reference
contents. A new profile affects new construction only, without replacing
already delivered dependencies or conferring readiness or publication authority.

The independently reviewed two-test checkpoint `dbfaafe9` retains the valid
late-root-after-abort and malformed-root-plus-abort-plus-rejecting-cleanup
regressions. This pin migration preserves those tests and the independent
literal binding parity oracle. No production, API, lifecycle or boundary changes
are introduced. ADR-0015 accepted bytes, package/archive pins, PR120 feature
moves and source census, and historical evidence remain unchanged.
Contained-turn remains pending with empty active wiring and adopted boundaries;
the seven-port direct Pure DI boundary remains `not-adopted`.

The retained paired evidence predates these tracked inputs and cannot prove
this migration. Since AR-0, paired L0 capture is manual historical evidence,
separate from the required macOS package and PostgreSQL authority-join gates.
Its pending successor is not a prerequisite for those current gates. Preserve
every historical report and receipt identity; focused checker results do not
establish migration completion. See the L0 checker disposition below.

## Evidence and executable references

Existing passive contract evidence starts with
[capability bundle tests](../../packages/apps/embedded-runtime/tests/package/capability-bundle-contract.test.ts),
[access boundary tests](../../packages/apps/embedded-runtime/tests/package/runtime-access-boundaries.e2e.test.ts),
and [Codex setup tests](../../packages/apps/embedded-runtime/tests/package/codex-setup.e2e.test.ts).
The profile maps `createDefaultAgentRuntimeHost`, its private
`default-agent-runtime-host.ts` implementation, and declarations, profile and
factories in `runtime-setup-assembly.ts`. It maps passive Assembly, type and
independent direct-reference tests without adopting the whole composition directory.
Wrong-binding mutation, typed token/slot rejection, zero-call preflight failure,
attempt isolation, failed handoff cleanup, and post-handoff startup abort must
be proved alongside packed public-root consumer validation. Use only disposable
TEST projects and passive temporary filesystem fixtures, never live providers.

## Implemented L0 checker transition

Status since 2026-10-02 (owner decision, AR-0): disabled as a gate.
`architecture:runtime-setup-l0-evidence` is no longer part of `pnpm check` or
`pnpm check:fast`, the `adoption-receipt-linux` workflow runs only on manual
dispatch, and CI no longer fetches the retained evidence commits. Paired
receipts had to be recaptured on most commits to main and blocked the Get
Modular 0.3.0 migration. Two CI jobs take over what the receipts ran. The
ordinary top-level `runtime-macos` job remains the required check on main since
2026-10-02. It always joins `macos-product`, which runs eight physical macos-15
arm64 runners: three complete-file Agent Execution partitions and five whole
package suites. Every runner cleans and builds all six packages locally before
its assigned original test command; Embedded Runtime retains both Node test
processes and deliberate platform skips. The Ubuntu aggregate verifies actual
Darwin evidence, including a non-root UID, the pinned Mac Node toolcache and
locally emitted Mach-O arm64 filesystem helper. It accepts only successful
current unit artifacts from the same workflow run and exact source revision;
failed, skipped or cancelled latest helper results reject earlier passes.
Per-attempt archives retain failures. Both targets use execution receipt schema
three; Linux retains its full package, root, typed and native obligations.
The source census rejects ignored root/experiment inputs and symlink ancestry.
Each observed test stream binds its raw PID, cwd, argv, completed file universe,
registration location, ancestry and ordinal to the original package source;
Mac streams bind their captured Mac executable to the original source plan.
Embedded Runtime's existing optional capture additionally retains each original
`spawnSync` return PID, executable, cwd and actual runner PID. Indexed raw
identity sidecars bind those fields, both original argv arrays and each stream's
summary/file universe. Both streams require the same actual runner PID, and
each child PID must differ from its actual command PID. Linux procfs corroboration retains exact observed
ancestry to the actual command PID when available; every ancestor must be a
positive safe integer, unique, exclude the child PID and fit within 16 hops.
An unobserved short child, and the portable Mac path, use explicitly declared
`spawnSync-return-v1` capture identity with `osObserved=false` and null ancestry.
This scope does not attest OS executable identity or authenticate artifact
origin. Original reporter arguments and ordinary nested Node output remain
unchanged; no Embedded Runtime reporter destinations are inherited through
`NODE_OPTIONS`. These checks share schema three and independent source expansion.
Disposable evidence paths bind through `GITHUB_ENV` after the frozen install.
The moving macos-15 label requires one
coherent observed image/compiler/SDK/header tuple within each run; the retained
20260907.0337.1 observation is historical evidence, not an image pin. Root must
review the newly observed tuple on real GHA and compare the same candidate's
inputless manual `Darwin unsplit reference` (`pnpm product:check`) with the
matrix, including raw identities/statuses, native obligations and queue times,
after GitHub Actions registers that workflow. It is a future same-head control.
Source hashes and receipt metadata do not authenticate artifact origin, and
Linux simulations do not qualify Mac execution. Darwin adds no Linux root,
typed-lint or native-quality phase. The required `postgres-durability` job runs the
Linux `postgres-authority-join.test.ts` (Agent Execution, Provider Access and
Runtime Security on a disposable PostgreSQL database) and fails if that test is
skipped. The checker, its tests and all retained L0/v1/v2 reports stay unchanged
and can still be run by hand. The current default is Node `24.21.0` with pnpm
`11.18.0`. The head-only `runtime-current-adoption-capture` automatic workflow
is retired in this integration, matching main's existing disposition. Its
`v24.18.0` assertion and capture contract cannot qualify the current default;
no successor capture route is authorized here. Put the gate back if these jobs
miss a regression
that a receipt would have caught, or once receipts no longer require committing
about 4.9 MB per refresh. The rest of this section describes the gate as it was
enforced before AR-0.

The gate was `architecture:runtime-setup-l0-evidence`, backed by
`scripts/architecture/runtime-setup-l0-evidence.mjs` and its spec, inputs,
validation modules and tests. The additive implementation preserves the
following bounded transition contract:

1. Retain schema-3 direct evidence, benchmark prompts/envelopes, source revisions,
   digests, HOLD verdicts, and historical change readback unchanged. Validate
   historical traces against their exact historical source, not the new default.
2. Replace the current construction trace's assumption that both factory symbols
   live in `agent-runtime-host.ts` with authenticated current evidence covering
   the new default entry, literal Assembly declarations/profile/factories, the
   internal leaf, and the independent direct test fixture. Bind it to ADR-0015,
   accepted consumer profile, approved artifacts and exact current source.
3. Keep historical report identity `runtime-setup-l0-direct-composition`,
   `authority: ADR-0008`, and historical verdict validation separate from the
   new adoption evidence. Do not relabel the historical report or loosen its
   shape/digests to make current source pass. Current artifact equality cannot
   require changed composition bytes to equal historical capture bytes.
4. Preserve all unchanged behavior gates, source-boundary prohibitions, full
   bounded input closure, and strict capture rules. Adoption v2 requires zero skipped
   applicable tests and zero unaccounted platform skips across the required pair.
   Historical validators retain their original zero-skip rules. Add rejecting fixtures for
   missing/wrong adoption authority, trace drift, altered historical evidence,
   bypassed command chain, and inward Core/Assembly imports. No unconditional
   skip of L0 validation or permissive fallback is acceptable.
5. Capture new current-source evidence on paired disposable Linux x64 and Darwin arm64 targets only
   after atomic package/API/caller integration. The new owner decision permits
   this static slice without asserting that historical L1 promotion passed.
   Broader L1 retains its two-of-three rule; L2-L5 remain no-go.

The retained [schema-v1 adoption capture](../spikes/runtime-setup-assembly-adoption-evidence.json)
is immutable historical evidence, validated against its own exact source closure.
It is never fallback evidence for changed inputs. The original L0 and incoming
qualification-branch snapshot also remain separate, unchanged records. The original
L0 report and its specification/envelopes are read from retained commit
`15f92b38d0fec8a56fbd6d6324d02de2566cccb7`; its product digests retain the
original source closure. Current specification counts cannot redefine that record.

### Paired adoption capture v2

This section retains the historical capture contract and manual recipe. The
`adoption-receipt-linux` workflow remains manual-only; neither it nor the
retained helper is a current required gate. Historical Node `v24.18.0` receipts
retain that identity. Use their exact historical SOURCE for manual validation;
do not change the current `24.21.0` default or relabel those receipts.

The original `runtime-setup-assembly-adoption-v2-evidence.json` remains retained
byte-for-byte (SHA-256 `08fef99589d67358f020e3a0b063a44d6c4c99381370f76b2ca200b005d9bf3d`).
The duplicate-callback clock and external-effect assertions in Agent Execution's
`claude-agent-sdk-contained-turn-provider-private-execution.test.ts` changed a
protected SOURCE input after the runtime-pin captures. The runtime-pin report
authenticates exact SOURCE `1e98e380348b13c1ab9f3559b40044c741a18134` and
1,982 inputs. Its test SHA-256 is
`8f2ebe311340ff53e091fa7c0bcb57fc07bb1f2d5dde975a4492a93c4c5b8527`;
at checkpoint `55e29627be47958015427829dbe3ad675223b1a7`, that test hashes to
`b58fbd8426b6ee442d68540917035bc3ba9f3aaa7b0fdb3d1cc6fb2ad421dbc0`.
Those authentic historical receipts cannot authenticate the repaired test or
the successor selection inputs.
The retained manual checker selects
`docs/spikes/runtime-setup-assembly-adoption-v2-node26-duplicate-callback-successor-evidence.json`.
Historical capture and report-only delivery for this successor remain pending
outside the current required CI gates. The
runtime-pin predecessor remains byte-for-byte at
`docs/spikes/runtime-setup-assembly-adoption-v2-node26-runtime-pin-successor-evidence.json`
(SHA-256 `1aa6f17ae933ddfdee2b4ac37c968051d27a2777161114191433bd81a09b5c96`).
Its earlier package-pin migration, portable TypeScript fixture compilation and
historical profile resolver transition superseded the 1,978-input capture at
`0b6feb38b243378f4082d3b3ef5d4ef569941fb4`.
The held-digest successor, which followed the intentional deterministic test change
at `10e974269f622330f4e1b2ee25f8e7364d916a57`, remains byte-for-byte at
`docs/spikes/runtime-setup-assembly-adoption-v2-node26-held-digest-successor-evidence.json`
(SHA-256 `35cae9d21930fe6e31573e247cdec0c3726f5b85a7ae3cf31e5cf09db99d187c`).
The former successor report remains retained byte-for-byte at
`docs/spikes/runtime-setup-assembly-adoption-v2-node26-successor-evidence.json`
(SHA-256 `e261db9b564aa9f012417561584a048666abe2efd92facb792a9956c30b54b87`).
It binds source `b11fbb42aa6c7082e7f9bc00c758f4007218b8d9` and its 1,977
inputs; one covered test input changed at `10e9742`, so those paired receipts
cannot authenticate the new SOURCE revision.
The prior Node26-named report is retained byte-for-byte at its original path
(SHA-256 `8ba80a3da8746f8eac5c1d0ac0e8e01e8db5e242ca2f6fead8d8f3e63a021067`).
Its source revision `1202e278b1605cc6243ceb42944eb30d07270172` has
1,974 inputs, while the next historical closure had 1,975. Its authentic paired
receipts cannot be relabeled for the successor.
The successor checker pins all five older v2 reports and retained v1. It
requires both new receipts to
match its exact SOURCE revision and inventory, and rejects the former
release-age compatibility exception. Until capture and delivery, the missing
successor report fails the manual checker. V2 binds ADR-0015,
the historical records, current construction traces and a bounded tracked Runtime
Setup input closure to exactly two receipts: Linux x64 and Darwin arm64, both using
Node `v24.18.0` and pnpm `11.18.0`. The two original explicit Node test argv lists
are retained in the package-local `scripts/run-package-tests.mjs`; ordinary
package checks and capture share that launcher. It runs clean, typecheck, build
and both test processes, stopping on failure. No test subset or alternative
legacy capture path can satisfy that historical validator.

Each receipt retains job/run identity, observed target and tools, start/end times,
exit/signal, command ledger and hashed stdout/stderr artifacts. The Node reporter
records suite input, source location, full ancestry/title, duplicate disambiguator,
terminal status and skip reason. The merger recomputes counts from these events
and requires completed streams for every explicit manifest file and both processes.
A later process cannot overwrite an earlier process's summary. Failure,
cancellation, TODO, missing processes/files and unexplained inventory differences
all reject acceptance.

Portable tests must pass on both targets. Only the existing exact registration
sites in `runtime-setup-l0-evidence-platform-sites.mjs` admit platform skips; the
table records source location, predicate, required target and original skip value.
A skipped parent requires its passing peer, and only that approved restriction
can account for the peer's complete subtree. Both-skipped tests, unknown reasons
and generic infrastructure skips reject acceptance. PostgreSQL is required on
Linux x64 only: provision a fresh loopback disposable database named
`ar69_pa_test_[a-z0-9]+`, then set `AE_ACL_POSTGRES_DISPOSABLE_URL` locally. The
receipt records prerequisite presence, never the connection URL. The existing
PostgreSQL test must actually pass on Linux, including its fresh-schema checks.
Darwin skips this exact registration with the explicit Linux descriptor-custody
reason; the merger requires the successful Linux counterpart. Connection URLs
accept only `127.0.0.1` or `[::1]`, with no query or fragment.

The former automatic workflow is retained only in PR184 history at
`f7b7e098cf20be65cfb711b42ca7e05e85d9407b`. Current CI uses `runtime-macos`
and the non-skipping `postgres-durability` authority join instead of that route.
The manual workflow and capture helpers remain for historical use; this
integration neither captures new evidence nor revives L0 enforcement.

The recipe below documents the historical Node `v24.18.0`/pnpm `11.18.0`
contract. R denotes an exact historical SOURCE admitting those tools, with its
selected report absent and its predecessor reports unchanged. It does not
apply to the current checkout, whose Node floor is `24.21.0`. In disposable
`*-TEST` checkouts of that historical R on Linux x64 and Darwin arm64, the
recipe required `git status --porcelain` to be empty,
`git rev-parse HEAD` to equal R on each host, and
`node --version`/`pnpm --version` to return the pinned versions. Clear
`NODE_OPTIONS` and `NODE_TEST_CONTEXT`. With native prerequisites available,
set `SOURCE_REPOSITORY` to the local repository containing R, `SOURCE_R` to its
full 40-character SHA, and `CAPTURE_TARGET` to `linux-x64` or `darwin-arm64` as
appropriate. Run this setup separately on each host:

```sh
: "${SOURCE_REPOSITORY:?}" "${SOURCE_R:?}" "${CAPTURE_TARGET:?}"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/runtime-successor-TEST.XXXXXX")"
git clone --no-local "$SOURCE_REPOSITORY" "$TEST_ROOT/checkout-TEST"
cd "$TEST_ROOT/checkout-TEST"
git checkout --detach "$SOURCE_R"
test "$(git rev-parse HEAD)" = "$SOURCE_R"
test "$(node --version)" = 'v24.18.0'
test "$(pnpm --version)" = '11.18.0'
test -z "${NODE_OPTIONS:-}${NODE_TEST_CONTEXT:-}"
test "$(node -p 'process.platform + "-" + process.arch')" = "$CAPTURE_TARGET"
test -z "$(git status --porcelain)"
```

Historical manual validation requires the exact Git object closure for R and
its retained predecessors. The former recipe ran these commands in each
disposable historical checkout; they are not current capture instructions:

```sh
pnpm check:node-compat
pnpm install --frozen-lockfile --engine-strict --strict-peer-dependencies
pnpm install --resolution-only --lockfile-only --no-frozen-lockfile --engine-strict --strict-peer-dependencies
git diff --exit-code -- pnpm-lock.yaml
pnpm --filter '@agent-teams/embedded-runtime^...' -r run build
pnpm --filter './packages/**' -r run clean
pnpm product:build
test -z "$(git status --porcelain)"
```

Linux also requires a fresh loopback PostgreSQL
database named `ar69_pa_test_[a-z0-9]+` and a locally set
`AE_ACL_POSTGRES_DISPOSABLE_URL`. Run this command separately on each required
target, with a new absolute receipt path outside each checkout:

```sh
CAPTURE_OUTPUT="$TEST_ROOT/$CAPTURE_TARGET.json"
CAPTURE_RUN_ID="$SOURCE_R-$CAPTURE_TARGET-$(date +%s)"
node scripts/architecture/runtime-setup-l0-evidence.mjs \
  --capture-adoption-receipt --output "$CAPTURE_OUTPUT" --run-id "$CAPTURE_RUN_ID"
```

`CAPTURE_OUTPUT` must be a fresh absolute receipt path outside the checkout,
with an existing parent directory. The command itself executes
`pnpm --filter @agent-teams/embedded-runtime check`; it retains sibling
`<receipt>.artifacts/` files even when the execution is rejected. Do not reuse an
output path or artifact directory. Retain each receipt and its artifact directory
together when transferring them. After both successful captures, on the same
source checkout:

```sh
node scripts/architecture/runtime-setup-l0-evidence.mjs \
  --merge-adoption-receipts "$LINUX_RECEIPT" "$DARWIN_RECEIPT" \
  --output docs/spikes/runtime-setup-assembly-adoption-v2-node26-duplicate-callback-successor-evidence.json
node scripts/architecture/runtime-setup-l0-evidence.mjs --check
```

The merged chronology retains the PR's original v2 and four Node26 reports,
including the runtime-pin predecessor, and main's independent cleanup-custody
capture. Main's original-path v2 bytes are mechanically archived at
[cleanup-custody evidence](../spikes/runtime-setup-assembly-adoption-v2-cleanup-custody-evidence.json),
SHA-256 `5cc5ef40c1d74e5f38f76a19a1c83e1cddee7c268b5043ed558620b13f80fbee`.
Their source is main `b0bcb265d1466da3272078f9dfdb7c6784624283`, original path
`docs/spikes/runtime-setup-assembly-adoption-v2-evidence.json`. The PR original
at that pathname retains SHA-256
`08fef99589d67358f020e3a0b063a44d6c4c99381370f76b2ca200b005d9bf3d`.
The retained report contract authenticates both predecessor branches without
rewriting either. Its capture protocol required a verified owner merge before
paired SOURCE capture; a static preview is not that merge.

Under that historical protocol, delivery revision D added only the new report;
all SOURCE inputs still had to resolve to R. The checker rejects a claimed
SOURCE revision that already
contains the new successor report. Do not mutate any retained report or receipt.
The selector, predecessor pin, rejecting tests and this guidance are protected
SOURCE inputs too. Historical capture bound them to R; receipts captured at
`1e98e380348b13c1ab9f3559b40044c741a18134` cannot be relabeled for that R.
This is a report selection and evidence retention update. The pinned Consumer
Module Standard still governs the same passive composition scope; its guidance,
local adoption profile and accepted ADR bytes are unchanged. The retained
standard at `9c722ceff4ede307d06d7a4b63fdebe615f54c53` hashes to the
profile's SHA-256 `33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd`.
Its retained migration review is
`architecture/get-modular/evidence/runtime-profile-cms-pin-review.json`.
This successor does not migrate or claim to review a moving upstream revision.
This Linux x64 host cannot capture the required Darwin arm64 receipt.

The single report embeds each original receipt and every referenced artifact as
base64 bytes, retaining the original receipt SHA-256 and its artifact hashes.
Receipt paths and execution directories remain provenance metadata only: checks
decode the bundled bytes and run the existing strict receipt, stream and paired
coverage validators without reading external capture paths. Hashes authenticate
retained bytes, not independent execution. No external artifact service or
additional input exclusion is required for historical verification. The former
PR workflow used short-lived artifacts only to transfer the original captures.

The historical protocol captured both targets at the same committed SOURCE R,
then added only the report at delivery revision D. The development-only
[`runtime-setup-l0-evidence-v2-inputs.mjs`](../../scripts/architecture/runtime-setup-l0-evidence-v2-inputs.mjs)
owns policy `runtime-setup-v2-inputs/1`, shared by capture, merge and check.
It covers all six evidence package roots, including sources, tests, launcher,
reporter, assets, configuration, Agent Execution asset-copy/native recipes and
the entire Filesystem Custody native directory. It also covers root manifests,
lock/workspace/tool and TypeScript configuration; architecture evidence/checker
helpers (including platform-site and AR-2 custody); consumer profiles, schema,
retained standard/package archives; FMS/source policy, authority registry and
explicit accepted authority inputs; this adoption record (read by the checker);
qualification/readiness and retained L0/v1 reports. The capture CLI runs the
adoption checker synchronously before capture. Its live ADR governance catalog
therefore binds the `docs/decisions` root, including the decision index and
accepted decision bytes. Foundation source diagnostics bind the governed
`experiments` and tooling roots (`scripts/architecture`, `scripts/ci`,
`scripts/docs`, `scripts/foundation`, `scripts/native-helper`, and
`scripts/sdk-growth-source`). These roots also cover future files read by the
same configured source census. Package roots already cover its package sources
and scripts. Authority and configuration paths outside those roots remain
explicit files.
The former capture workflow's `check:node-compat` prerequisite bound its engine
audit implementation, both executed compatibility tests, the Node 26 workflow
asserted by the engine test, and the retained Linux containment record read by
the runtime test. These files are SOURCE inputs even though the capture receipt
records the later embedded-runtime check command.
The policy declares required roots and files explicitly. New dependencies outside
these roots require a reviewed policy update before capture.

Cleanliness, revision comparison and hashing use the same literal Git pathspecs.
NUL-delimited inventory is sorted and deduplicated by path and binds each regular
file's path, Git mode and SHA-256. Missing required inputs, symlinks, submodules,
additions, removals, renames and mode/byte changes reject evidence. Git diff
status 0 accepts equality, status 1 rejects drift; other Git errors propagate as
infrastructure failures. Receipt inventories cannot omit or add inputs, and old
or mixed policy identities cannot satisfy the historical manual validator.
The physical discovery check also walks the configured Foundation governed
source roots and selected package roots for source files and nested manifests,
the live decision catalog for Markdown, and the observed ancestor manifest
slots up to the repository root. Manifest slots bind absence, regular-file
identity and committed bytes at the selected revision. The pnpm workspace
reader traverses directories from the repository root before applying its four
bounded glob patterns. SOURCE therefore rejects unsafe entry names and portable
case or NFC directory collisions throughout that traversal, including empty
and ignored directories, and portable source-file collisions inside selected
source trees. A discovered source or observed manifest outside the
exact revision's selected inventory rejects capture or delivery even when
`.gitignore` hides it. A newly discovered workspace sibling is rejected until
a reviewed SOURCE policy and owner boundary include it. The accepted plain-list
workspace patterns and governed roots are read from the bound configuration
bytes; changed discovery syntax or patterns fail closed for policy review.
Ordinary unrelated files remain outside the inventory.

Generated `dist` and `coverage` beneath a direct child of a selected package
root are excluded only when that child has package authority. A manifest whose
sole key is valid `type` (`module` or `commonjs`) establishes a module scope,
not package authority; source files under its generated-named directories stay
in SOURCE discovery. Genuine package roots still exclude generated output.

The generated v2 report is outside the closure to avoid self-reference.
Unrelated tracked files outside the selected roots and explicit files (for
example the root README), unrelated untracked files and report-only edits/commits
do not invalidate an otherwise identical capture. The live adoption and
Foundation source checks are capture prerequisites and their repository-owned
inputs are part of SOURCE identity.
Manual historical validation still needs the report and Git object closure for
R and its predecessors; bundled receipts do not replace source readback.
The rejecting fixtures deliver a report-only commit into a fresh clone, delete
the original capture tree and validate against R. Missing or mutated bundled
bytes, mixed source receipts and changes inside the bounded closure must fail. The
existing architecture gate runs these fixtures via
`runtime-setup-l0-evidence-validation.test.mjs`.

The retained v2 and Node26 reports and their receipts remain byte-for-byte
historical evidence. Its paired successor remains pending under the manual
contract, outside current required CI. The recipes above do not authorize a
capture against the current default. This bounded-identity history does not
establish current platform evidence or adoption completion.
The bounded-policy review used the then-current retained standard pin
`669a750d8db451e04f075cdeb36576c6606fba6e`, whose complete bytes match the profile's
SHA-256 `e6cd8d26b4317bf5f94ddd22f6e36bf25e90548f72265d94808eaf20b947e553`.
On 2026-09-15, the orchestrator verified with `gh` that get-modular main at that checkpoint
is `610e595fe1f2e893d01ee44ceecd6349b5a3c8ce`, four commits ahead of the retained
pin. The only `common-assembly.md` delta is the reciprocal Agent Runtime
PR #168 ledger paragraph, which explicitly retained consumer standard revision
`669a750d` and limited accepted passive scope. That historical evidence-policy
patch required no pin migration or shared-behavior change. The historical
paired evidence obligation remains pending under the manual disposition.

Implementation review re-read the pinned Consumer Module Standard and compared
it with the locally retained upstream `03a7df64bc5e9939f7b51694a80a7f3d61453f98`
snapshot: both complete documents retain SHA-256
`ea54578ebe69fc410bf973b6112dcefc4ad7c163e563e0ee307cd7b5f8b8723d`.
That historical comparison is supplemented by the current upstream review above.
V2 changes evidence
collection only, with no new composition boundary or shared contract.

Delivery remains pending until focused gates, fast/full integrated-source checks,
independent review, exact artifacts, and before/after benefit measurements pass.
Negative or inconclusive benefit must be reported honestly. No readiness or
qualification claim follows from documentation acceptance.

The scoped [consumer profile](../../architecture/get-modular/consumer-profile.json)
records the activation inputs for ADR-0015. Both `check:fast` and `check` execute
`architecture:get-modular-adoption` and `test:get-modular-adoption`. The canonical
checker itself requires live Foundation source diagnostics to pass before
comparing the exact census; metadata validation alone cannot activate adoption.

## PR71 measured benefit and cutover checkpoint

At source `57dbc2ffe8db4643b5a8e97c7726bc6342b3239a`, the retained
matched benchmark compares baseline `ae103a68fcae70f88539e2c4400420afe7d80d49`
with `08fb1a71b75134b43af52579e8de86a44b2a3815`. Its final report has
SHA-256 `6e1c173dc7163cf453dead5ce0d6eaaf628140822a7b8875a1a3c3f26189972c`;
the retained `benchmark-final-evidence.tar.gz` has SHA-256
`d13e8b35c7758bb1d5cf600e38d892dd528150e6734b965551f516321f339c98`.
These are external delivery artifacts, separate from historical L0 evidence.
The delivery owner must retain their provenance with the release decision.

The final benchmark's 400 physical production adapter lines reconcile to 404:
203 declaration/binding lines, 95 async bootstrap lines and 106 creation-error
lines. Only the bootstrap changed, by a net four lines for best-effort
cancellation metadata during failure cleanup. The dependency owner/path and
observer-only replacement are unchanged. Historical task-wide baseline timing
is unavailable; command durations cannot reconstruct it. The benchmark proves
bounded observer and empty-scope passive/disposal behavior, not measured speed,
reduced wiring or net navigation/diagnostic/maintenance benefit. Benefit remains
**inconclusive**; `second-consumer-not-admitted`, with no shared extraction claim.

The technical recommendation is to retain the user-approved first passive
consumer, conditional on final acceptance. Its demonstrated value is typed
mapping, rejection of invalid wiring before materialization, and one Host
handoff with preserved cancellation and failure ownership. This justifies the
bounded slice as a correctness and integration mechanism, not a claim of faster
development or fewer lines. The cost remains 404 physical adapter lines, two
package dependencies and consumer metadata. Do not expand the graph into
contained-turn or introduce shared lifecycle machinery on this evidence.

Release disposition remains pending. Retention requires a reasoned owner
benefit/cost decision, reviewed external consumer/callsite and package-release
provenance, and the exact final evidence and gates. The retained v2 report
records its own exact source identity and platform receipts. The merged SOURCE
requires fresh Linux x64 and Darwin arm64 receipts for the
complete implementation and documentation checkpoint. Deliver the selected
duplicate-callback successor report separately, then validate it with
`pnpm architecture:runtime-setup-l0-evidence`. Keep every retained report byte
unchanged; prior captures cannot be relabeled as merged SOURCE evidence.
A report-only commit may
reuse the authenticated source only under the existing validator rules.
While the L0 gate is disabled (AR-0), this validation is manual and does not
block delivery.

A consumer-local rollback must be one governed release replacement. Restore one
async direct default at the existing private entrypoint, retain the internal
sync leaf and awaited callers, remove only the admitted Core/Assembly dependency
pair, and preserve all Host-owned lifetime and contained-turn boundaries. Keep
historical ADR/evidence bytes intact. Reconcile the profile/schema, exact source
census, package/layer rejecting checks, current L0 trace and accepted successor
record in the same delivery. A profile merely marked pending, or deletion of a
gate, does not make rollback releasable. An old whole-lock/barrel restoration
also reverts unrelated current work and is not this bounded rollback.

The new release constructs new Hosts through its single chosen default. Already
published Hosts finish with their original lifetime owner. Construction or
cleanup failure never triggers same-process direct fallback or automatic retry.
No release approval or full-gate success is asserted by this checkpoint.

## Keeping the standard current

Changes to shared module contracts or recommended composition patterns must update
the central standard and affected consumer guidance in the same delivery. Changes
to local boundaries must update the profile, ownership mapping and positive and
rejecting gate fixtures. Before implementation, compare the pinned standard with
upstream, review its delta and update the exact pin and retained bytes together.
Never silently follow moving main, rewrite accepted ADRs, or mark a pending
profile active before its real blocking checks pass. Stale documentation or
unverified adoption is unfinished work.

## Retained direct capture from the qualification branch

The [direct-composition capture retained from e411638](../spikes/runtime-setup-l0-direct-e411638-evidence.json) records source e615369 and remains byte-identical to the qualification branch (SHA-256 `879b333361889b250fb834c3bfb41a1006c4d0d2adcc5fd56df126de4c3eaf10`). It is a separate ADR-0008 experiment, not an Assembly capture. The original historical L0 report remains at its ADR-0015-authenticated path and digest. Neither capture establishes current Assembly acceptance or measured benefit.

## Reviewed ordinary-session documentation pin migration

On 2026-09-12, current upstream `714d6194afd24e0bb4375f4d38e2422c892ad021`
was compared with retained `a05f2cb51553e1efc5ba89be352e4aba04675088`.
The complete document SHA-256 is
`63bbf8f6e0c92a74116bce40ac96e4fc5f1c4ed3d28325be79b5c75448a23bc3`.
The only delta relocates five executable-example links from
`packages/assembly/tests` to `tests/assembly`; no normative rule changes.
At that checkpoint the active profile, pending contained-turn profile, checker
expectation and retained document used this reviewed pin. Historical ADRs and evidence remain
unchanged. The retained review is
`architecture/get-modular/evidence/ordinary-session-pin-review.json`.

[ADR-0090](../decisions/0090-ordinary-user-session-codex-execution-profile.md)
accepts a separate ordinary contract. It does not activate ADR-0016 or extend the
passive adoption claim. Ordinary activation requires concrete composition paths,
FMS ownership, typed rejecting fixtures and the actual fast/full gates before
activation; this documentation migration alone supplies none of that evidence.

## Reviewed auth-compatibility documentation pin migration

On 2026-09-13, the reviewed upstream revision was
`669a750d8db451e04f075cdeb36576c6606fba6e`, complete-document SHA-256
`e6cd8d26b4317bf5f94ddd22f6e36bf25e90548f72265d94808eaf20b947e553`.
The nine added lines clarify acquisition-time cleanup registration, responsibility
for failed async construction, inert one-shot summaries, and the distinction
between construction and readiness. The ordinary auth adapter remains the owner
of its helper and cleanup; no new capability, graph node or dependency slot is
introduced. This delivery corrects failed RPC settlement within that owner.

At that checkpoint, the mutable profiles, rejecting checker expectation and
retained current document used this revision. The prior bytes remain in
`architecture/get-modular/evidence/consumer-module-standard-714d6194.md`;
`ordinary-auth-pin-review.json` and `ordinary-auth-pin-delta.diff` in the same
evidence directory record the reviewed transition. The earlier pin review and
the ordinary execution contract remains unchanged. Its pre-merge ADR-0020 bytes
are retained by ADR-0090 following the identifier collision with main. Pin migration does not qualify a live
ordinary turn or activate the legacy pending ADR-0016 scope.

Before that delivery, upstream `a10f33a37bbf8f65134156f1e7d09cbb20b7633a`
was compared with its accepted pin. The canonical
`docs/architecture/common-assembly.md` bytes were unchanged, so no further pin
migration was required at that historical checkpoint.

## A3 SDK growth enrollment qualification

The [SDK profile](../../architecture/sdk-growth/profile.yaml) covers all six
accepted private workspace packages, their twelve typed entrypoints and Embedded
Runtime's exported test-runner module. The private root is classified separately
as non-release metadata; it is not a seventh released package. The runner is now
included in the package file list so its existing export can be imported from a
packed artifact. No runtime contract, composition node or lifecycle owner changes.

Both active and pending consumer profiles reference the same
[activation record](../../architecture/sdk-growth/activation.json).
`pnpm sdk-growth:profile` and `pnpm test:sdk-growth:profile` enforce the frozen
consumer enrollment in fast/full gates. These checks no longer reject workspace
membership or package inventory changes while the AR-S freeze is disabled (see
below). They still reject changes to the C0 contract hash, `contractRevision`,
the registry and root classification, the evidence and the command, but do not perform EF SDK comparison or grant trusted admission.
SDK authority activation remains pending. The retained qualification used the exact published EF 1.6.0 artifact: tarball SHA-256
`842f81ca68e9c3207a0da967eb599229d4d30ea32cd69a9a1686f2eb240f54eb`, npm
integrity `sha512-E6ytO+3xhZsaPTo49DRuhldQBRMFlF06EGqqERuGHrc4q11eLssTA9fsbEGCm1e4B8n/i8AsMt2ZkQklFeolWA==`,
and publication time `2026-09-24T00:19:03.115Z`. Dist metadata, provenance and
the release tag resolve to the identities in the retained qualification record. The public
`sdk-growth-authority` export imports from those published bytes, and a frozen
install succeeds in a fresh disposable project. No local dependency or
published baseline is introduced.

The package inventory and export freeze is disabled by owner decision
2026-10-02 (AR-S). `pnpm sdk-growth:profile` no longer compares the workspace
package list, package identity, `private`, `version`, `bin`, `files`, `exports`
or entrypoints against the frozen C0 inventory, and the matching rejecting tests
are commented out in the same change. The frozen C0 contract hash, the EF
registry identity, the root classification and the qualification evidence
checks still run. The reason is that the Get Modular 0.3.0 migration replaces
the frozen package inventory and the freeze would block package growth such as
new workspace packages. A new public import such as `./testing` on the six
qualified packages still requires requalification
(`SDK_PUBLIC_IMPORT_QUALIFICATION_DRIFT` stays enabled). The disabled code stays in
`scripts/architecture/check-sdk-growth-profile.mjs`; it may return only together
with the generated SDK surface report that replaces it (SDK-growth rework lane).

The [package qualification](../../architecture/sdk-growth/qualification.json)
records six real packed archives and successful imports of all thirteen public
subpaths in disposable Linux consumers. Two correct-toolchain pack runs produce
the same six archive digests. This is not a Host E2E. `pnpm sdk-growth:pack`
builds and packs the declared package files without executing package lifecycle
scripts. Packed membership fixtures also reject reordered conditions, missing
declarations, the omitted runner and source leaks. Foundation changed-file
routing includes the SDK profiles and gate scripts.

The retained EF 1.5.1 typed observation is historical. It resolved the prior
pinned-library `AbortSignal` failure, but five composition entrypoints then
reported 446 `ae-forgotten-export` diagnostics. Its source, lock and tool digests
cannot qualify EF 1.6.0. The historical audit and counts remain in the
qualification record for traceability.

The retained EF 1.6.0 package membership and public imports were qualified
against that published artifact. Accepted current main selects Foundation
1.7.2 for development tooling. The activation's `installedTooling` record
retains its exact npm integrity and source checkpoint, with typed observation,
strict extraction and external authority still pending. The retained 1.6.0
qualification bytes do not qualify the current tooling release.
Current source-bound typed observation and strict extraction are still pending
in the admission record. No source-local command may convert
that pending status into a trusted grant. The external authority is uninvoked,
and no baseline, trusted history, owner decision, grant, completion or receipt
is fabricated for these initial-unreleased packages.

The [earlier A3 standard review](../../architecture/get-modular/evidence/sdk-growth-standard-review.json)
compared the active `669a750d` pin with supplied bytes whose SHA-256 was
`ea54578ebe69fc410bf973b6112dcefc4ad7c163e563e0ee307cd7b5f8b8723d`.
Those bytes had no upstream commit identity, so the review correctly declined
to use them as moving authority. The review remains historical evidence and is
not the current authority or retained current standard.

### A3 Consumer Module Standard pin migration

The fresh [pinned review](../../architecture/get-modular/evidence/a3-cms-pin-review.json)
migrates both consumer profiles from Get Modular commit
`669a750d8db451e04f075cdeb36576c6606fba6e`, complete-document SHA-256
`e6cd8d26b4317bf5f94ddd22f6e36bf25e90548f72265d94808eaf20b947e553`,
to exact document commit `ac49bb3374946330ec820591f8195a22d2c90900`,
complete-document SHA-256
`d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f`.
Get Modular main was observed at exact source commit
`6b31f20fe3e5fb8324812aa2ee907905751cde71`; its complete document bytes are
unchanged from `ac49bb3374946330ec820591f8195a22d2c90900`. The retained standard
at that checkpoint was byte-identical to that immutable source and remains retained
as `consumer-module-standard-ac49bb33.md`. Main itself was not the pin.

The [complete byte delta](../../architecture/get-modular/evidence/a3-cms-pin-delta.diff)
is one replacement hunk: six lines describing Agent Runtime as a planned
consumer become eleven lines recording the reciprocal accepted passive setup
and ordinary-session adoption. The new text expressly keeps contained-turn and
dynamic plugin runtime scope outside that record and disclaims repository-wide
conformance. It changes no Consumer Module Standard rule, composition behavior,
capability, binding, lifecycle owner, package identity, or qualification claim.

Accordingly passive setup and ordinary-session adoption remain active,
contained-turn adoption remains pending with empty active wiring and no adopted
boundary, and SDK external authority remains `pending-authority-qualification`.
ADR-0015, ADR-0090, proposed ADR-0016, C0 retained evidence, the earlier A3
review, package/archive pins, source census, SDK profile and SDK activation are
unchanged. This migration does not expand A3 scope or activate new composition.

Initial-unreleased histories, exact initial surface decisions, packed custody,
and external trusted enrollment must be qualified before SDK activation. A
candidate-controlled workflow or passing profile fixture is not this authority.
Linux portable checks do not establish Darwin qualification; existing paired
Host evidence and its outstanding work remain separate. K1/A1/A2 and dynamic
plugins are outside this delivery.

## Reviewed optional dynamic Host standard pin migration

At exact Agent Runtime source `be0a811288da4261d26063790c9f7924991523fe`,
the [new migration review](../../architecture/get-modular/evidence/dynamic-host-cms-pin-review.json)
compares historical A3 pin `ac49bb3374946330ec820591f8195a22d2c90900`
(SHA-256 `d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f`)
with exact Get Modular main `24d6557a1b04b01a3a73c64b1d9a9afd83d89c8f`
(SHA-256 `33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd`).
The [retained delta](../../architecture/get-modular/evidence/dynamic-host-cms-pin-delta.diff)
adds ADR-0029 to related authority and an optional dynamic Host lifecycle
candidate section. The supplied accepted ADR-0029 bytes have SHA-256
`9247eb2c2eb70cbbc215426446101314b1085d1d03fee02b6dc0467a737eac00`.
The earlier [A3 review](../../architecture/get-modular/evidence/a3-cms-pin-review.json)
and its delta remain historical and are still enforced by the checker.

The new section requires whole selected graph rejection before dynamic candidate
imports, Host-owned construction and acquisition custody, and authority checks
after awaits before effects. It describes bookkeeping call and custody leases,
retirement limits, and exact evidence for an explicitly adopted dynamic scope.
Its own text says passive composition scope is unchanged and Agent Runtime
dynamic adoption is not certified. No lifecycle kernel package is added here;
Core and Assembly archive pins stay fixed. Passive setup and ordinary-session
scope remain active, contained-turn remains pending, and SDK external authority
remains pending qualification. Current profile and retained bytes use the exact
new pin. This migration alone supplies no dynamic production adoption evidence.
These migration reviews remain retained history. Since AR-0, the consumer
gate verifies the current pin step through `check-cms-pin.mjs`; the SDK gate
keeps its accepted registry, C0 and pending-observation protections. The manual
C0 checker authenticates its frozen `ac49bb33` successor separately without
changing the accepted C0 contract or verdicts.

## Historical standard and dependency pin review

The supplied current upstream document at `3c23` and the retained `9c722ce`
document are independently byte-identical: complete-document SHA-256
`33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd`.
There is no standard delta or new composition boundary in this integration,
so the exact existing `9c722ceff4ede307d06d7a4b63fdebe615f54c53` pin remains.


At exact Get Modular commit `9c722ceff4ede307d06d7a4b63fdebe615f54c53`,
the canonical full-document SHA-256 remains
`33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd`,
identical to the previous `24d6557a1b04b01a3a73c64b1d9a9afd83d89c8f` pin.
The [retained review](../../architecture/get-modular/evidence/runtime-profile-cms-pin-review.json)
records zero document delta and keeps passive and ordinary adoption active,
contained-turn adoption pending, and dynamic scope uncertified. Core and Assembly
move to exact published 0.2.0 archives. Accepted current main supplies the
stable31 generation-2 managed selection: Docs Protocol 0.6.2, Docs Protocol
Agent Teams 0.3.2 and Engineering Foundation 1.7.2. Historical reviews, C0
evidence and accepted ADR bytes remain unchanged.

### Creation failure cleanup custody

The September 30 review fixes two owner-local bugs under the existing CMS
acquisition, cleanup truth and surviving-owner requirements. It introduces no
shared lifecycle manager, new graph node, provider behavior or package change.
The ordinary graph keeps its eight nodes. The new finite composition import
uses the existing Host creation error owner; it is not another composition root.

`AgentRuntimeHostCreationError.cleanupRecovery` is present when creation retains
unfinished cleanup. Its only method, `recover()`, drives the actual pending
owner. Concurrent callers join one Promise; rejected cleanup remains reachable
for a subsequent safe attempt, while settled success is idempotent. The error
keeps its primary code, phase, cancellation, diagnostics and module ID, plus
private causes. `cleanupFailed` records historical failure even after recovery.
JSON includes only the existing metadata projection, never closures or a Host.
A failed construction never publishes a usable Host or command capability.
Every trusted Host factory, including an owner-local test substitute, must honor
`AgentRuntimeHost.dispose()` as repeatable observation: join concurrent calls,
retain successful actions and unsettled custody, and repeat physical release only
when its resource owner proves that safe. A terminal uncertain release retains
its first rejection or requires owner-specific reconciliation. A structural Host
shape does not authorize an arbitrary non-idempotent raw release as recovery.

Default construction keeps the allocated Host until observed disposal success.
If inner default disposal fails during ordinary construction, the outer catch
retains both owners and defers outer cleanup. Recovery first settles inner
Host/feature work, then releases outer PA/security/provider owners and journal.
The existing reverse cleanup ledger removes each successful action once and
stops at unresolved prerequisite debt. Borrowed database pools remain borrowed.

The journal has explicit open, observed-closed and failed-close states. A thrown
close preserves its first cause, refuses further records and closes, and never
retries a potentially reused fd. Only observed success is idempotent success.
Initialization fsync/close failures retain the primary cause with file/directory
cleanup uncertainty and a non-enumerable cleanup-only holder when needed. Public
Host creation retains that holder through `AgentRuntimeHostCreationError`, with
private causes and historical `cleanupFailed: true`, including failures before
Assembly construction begins. That holder cannot convert uncertain close into
observed physical disposal. No OS
reconciliation algorithm or live-provider qualification is claimed.

Focused synthetic evidence lives in `ordinary-host-disposal.test.ts`, its
`ordinary-creation-cleanup.fixture.ts`, and `runtime-setup-assembly.test.ts` with
`runtime-setup-creation-cleanup.fixture.ts`. Disposable files and fake database
ports exercise descriptor reuse, record refusal, initialization failures,
partial allocation before an await, concurrent recovery, failed retry, nested
dependency ordering, borrowed pools and non-repetition of successful actions.

### Historical candidate-only standard pin review

The [review](../../architecture/get-modular/evidence/creation-cleanup-cms-pin-review.json)
migrates both current consumer profiles from `ac49bb3374946330ec820591f8195a22d2c90900`
(SHA-256 `d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f`)
to `9c722ceff4ede307d06d7a4b63fdebe615f54c53`
(SHA-256 `33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd`).
The complete-document retained bytes and [two-hunk delta](../../architecture/get-modular/evidence/creation-cleanup-cms-pin-delta.diff)
add the ADR-0029 relation and 31 lines of optional dynamic Host candidate guidance.
The staged exact upstream source supplied by orchestration is the reviewed input;
no moving main is followed. Prior review and full-document evidence are retained.

ADR-0029 does not authorize Agent Runtime dynamic adoption. G1 remains on hold;
contained-turn and SDK external authority retain their pending classifications.
Existing CMS already assigns acquisition ownership and surviving cleanup custody
to the Host, so this delivery applies product-specific fd and error recovery
policy without changing GM semantics, Core, Assembly or lifecycle-kernel. Current
rejecting checks authenticate both profile identities, full bytes and reviewed
delta, reject stale pins and preserve the existing adoption states. Accepted ADRs
and frozen C0 evidence are unchanged. C0 authenticates its source oracle from
its retained base revision, not current production bytes. The current ordinary
profile permits exactly the reviewed creation-error composition dependency;
all other frozen fields remain enforced, alongside the current CMS pin review.

## Reviewed Smart CI prerequisite successor checkpoint

Root supplied exact before/after source packets; this worker verified their
hashes and byte lengths and reviewed their complete delta offline. This is not
independent live source retrieval. Runtime base is
`0ace1cce19ce8d1b5b7640b421b3b19c1ab212e2`, tree
`0dd29d5ab93b68dace14666ed400c1010caa7bae`.
The [predecessor](../../architecture/get-modular/evidence/consumer-module-standard-9c722ce.md)
retains SHA-256 `33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd`
and 24,312 bytes. The [exact Git delta](../../architecture/get-modular/evidence/smart-ci-cms-pin-delta.diff)
contains 17 hunks, +432/−31 lines, 36,534 bytes, SHA-256
`670810e035da54ae00b1b7f45c5516851232439e58673fecc12a83b129be2c99`.
The one-step current checker regenerates it in a disposable TEST directory,
checks predecessor linkage and provenance, and rejects unsupported scope claims.
Historical validators keep their fixed identities and retained documents.

The successor changes normative guidance for descriptors and capability revisions,
module resource scopes, prepared-template run inputs, namespaces and conformance
suites. Fixed passive CI helpers are feature-local development tooling under
“New composition boundaries”; they require no descriptor, resources, run-input
or lifecycle adoption. No Smart CI applicability or acceleration is activated here.
Passive and ordinary adoption remain active under their existing acceptance;
contained-turn stays pending with empty active wiring and adopted boundaries,
dynamic scope stays uncertified, and SDK external authority stays pending.

Successor-wide production conformance is **not established**. Existing
`runtime-setup-assembly.ts` declarations still use raw compatibility literals,
owner labels that differ from module namespace prefixes, and one implementation
ID with different passive/ordinary slot sets. Descriptor migration, release-wide
identity review and successor module/root conformance evidence remain with their
owners. No successor compiler or conformance CLI execution is claimed; the packet
names library conformance-kit APIs. This checkpoint changes no production wiring,
package/archive pins, accepted decisions, C0 evidence or frozen check inventory.

## Train 0.3.0 conformance status

One row per norm of the pinned standard, with the state that is true at the head
of the pull request that last edited the row. AR-1a writes `met` only for rows
closed by #201 or by itself; every other row is `pending: <closing PR>`,
`outstanding`, `not applicable` or `not adopted`, and a closing pull request
switches its row in place to the final state. The closing pull requests are
described in the briefs [AR-1b](get-modular-train-1-ar-1b.md),
[AR-1c](get-modular-train-1-ar-1c.md) and [AR-2](get-modular-train-1-ar-2.md),
all part of the [train migration](get-modular-train-1-migration.md); rows that
name issue #189 follow its [test debt plan](test-debt-189-plan.md), and brief 07 is
the [ordinary store contract suite](test-debt-189-07-ordinary-store-contract-suite.md).
This table
complements the "Reviewed Smart CI prerequisite successor checkpoint" section and
the `outstandingWork` of the review, which stay as the evidence of the pin step.

| norm | state now | final state, written by the closing PR | closedBy |
| --- | --- | --- | --- |
| Authority and identity: document pin, accepting ADR-0026, profile | met (pin `81063ad` since #201) | met | agent-runtime #201 |
| Scoped acceptance and evidence: pins, package and archive identities, blocking commands | met for Core and Assembly 0.3.0 and resources 0.1.0 (retained archive, exact catalog, one copy) | met (resources added in AR-1c) | AR-1a, AR-1c |
| New composition boundaries: descriptors own IDs and revisions; no hand-written compatibility; no `any`, `as never` or double casts in wiring | met | met | AR-1b |
| Identity and namespaces, rules 1-7 | met | met | AR-1b |
| Module packages and contracts | met for a private host-app package: descriptors and declarations live with the composition; the ordinary module factories are members of a frozen record built per Host attempt from Host constructors and bound by the root; a separate contract package is revisited in the package publication lane. Outstanding: port members of the seven ordinary contract value types (Agent Execution `ordinary-ports.ts`) are declared as methods, not function-typed properties | met for a private host-app package; the port member shape stays outstanding with the Agent Execution owner | AR-1b; port shape: Agent Execution owner |
| Module packages list Get Modular packages only as peers | not applicable | not applicable while Agent Runtime packages are private and export no Get Modular modules; revisit in the package publication lane | none |
| Dynamic instances (templates, inputs) | not applicable | not applicable: no prepared assembly serves more than one run; compile, bind and prepare run once per Host attempt | none |
| Module resource scopes, author rules 1-13 | pending: AR-2 (security and Codex owners met in AR-1c) | met for the security, Provider Access and Codex owners; rule 7 holds: the Provider Access retirement protocol (broker close, rendering, capture and guard disposal, store retire) stays inside one cleanup | AR-1c, AR-2 |
| Host rules: `scoped()`, one scope per run, close after `run()` settles, one package copy | met (the passive profile has no owning factories, so its runs need no scope) | met (the passive profile has no owning factories, so its runs need no scope) | AR-1c |
| Host rule: outer scope for a provider that cleanups need; drain before closing | met: journal in the outer scope; Host drain with the turn owner handoff before owners close | met: journal in the outer scope; Host drain with the turn owner handoff before owners close | AR-1c |
| Host rule: one deadline at the root (escalate, then abandon) | outstanding | outstanding by decision of 2026-10-04: release of the resource owners keeps today's behavior without a deadline; added when an owner's release can block without its own bound, or on owner request; prepared values grace 5000 ms, abandon 5000 ms | none yet |
| Host rule: `order: "concurrent"` only for independent peers | pending: AR-2 | met: Provider Access grants | AR-2 |
| Errors identified by code | pending: AR-2 (AR-1c compares no Get Modular error with `instanceof`) | met | AR-1c, AR-2 |
| Testing 1 and 2: named module factories, typed fakes | factories met for the ordinary feature; fakes this train touches are typed, but package test files are not type-checked yet; remaining work tracked in issue #189 | factories met for the ordinary feature; fakes this train touches are typed, but package test files are not type-checked yet; remaining work tracked in issue #189 | AR-1b, AR-1c; rest per #189 |
| Testing 3: contract suites | outstanding | outstanding; covered by issue #189 brief 07 after AR-2 (planning decision 2026-10-04): one suite for `agent-runtime/ordinary/store`, owned by the ordinary feature, run against an in-memory fake and the PostgreSQL store, moved unchanged into STORE-2-core as its compatibility suite (never copied or imported from embedded-runtime); every other contract recorded as "no second implementation" | #189 brief 07 |
| Testing 4: `isolate` | met for one scoped owner module (provider) | met for one scoped owner module | AR-1c |
| Testing 5: roots as functions of Assembly, one `smoke` per root | met for the passive and ordinary profiles | met for the passive and ordinary profiles | AR-1b, AR-1c |
| Testing 6: independent binding oracle | met: literal compiled-plan oracle | met | AR-1b |
| Testing 7 and 8: `guardHandles`, close every scope, no sleeps | 8 met for new tests; 7 not adopted in this train, tracked in issue #189 | 8 met for new tests; 7 not adopted in this train, tracked in issue #189 | AR-1c; 7 per #189 |
| Optional dynamic Host lifecycle candidate | not adopted | not adopted | none |
