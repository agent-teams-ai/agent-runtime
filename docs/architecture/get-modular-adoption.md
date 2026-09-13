---
id: runtime.architecture.get-modular-adoption
type: architecture
status: active
owner: architecture
summary: Tracks the passive setup adoption contract and outstanding evidence without extending runtime qualification.
---

# Get Modular adoption

## Status and authority

Status: scoped passive setup profile active, with blocking live source census
and package archive verification. Integrated delivery, current L0 evidence,
independent review and measured benefit remain separate release gates. This
document does not certify their completion.
[ADR-0015](../decisions/0015-passive-setup-static-assembly-adoption.md) accepts the
bounded contract. ADR-0008 and its historical evidence remain immutable;
ADR-0013 continues to govern exactly its three active FMS features.

The central authority is Get Modular's accepted ADR-0026 and
[consumer module standard](https://github.com/agent-teams-ai/get-modular/blob/a05f2cb51553e1efc5ba89be352e4aba04675088/docs/architecture/common-assembly.md#consumer-module-standard).
The merged revision supersedes the earlier unmerged candidate reference:

- Repository: `agent-teams-ai/get-modular`.
- Commit: `a05f2cb51553e1efc5ba89be352e4aba04675088`.
- Path: `docs/architecture/common-assembly.md`; anchor: `consumer-module-standard`.
- Complete document SHA-256: `ea54578ebe69fc410bf973b6112dcefc4ad7c163e563e0ee307cd7b5f8b8723d`.
- Retained bytes are recorded by the consumer profile; they are evidence, not a second authority.

Document identity, package versions/archive integrity, Core compatibility token,
and local adoption authority are distinct. The profile retains the approved published
Core and Assembly 0.1.0 archives, verifies their SHA-256 and lock integrity,
and requires exact catalog versions. It records actual blocking commands,
without `conformant: true` for the repository. Upstream main was rechecked on
2026-09-09 at `03a7df64bc5e9939f7b51694a80a7f3d61453f98`. The complete
standard still has the SHA-256 recorded above, so the accepted pin remains
content-current; no normative standard delta needs migration.

The consumed release sources are distinct from the standard pin:

| Published root | Version | Release source commit | Retained archive SHA-256 |
| --- | --- | --- | --- |
| `@get-modular/core` | `0.1.0` | `bbc5053c2f2f96e7c524bd65c42288fc88cd7358` | `50803ea69e2fb4078013a897f858908b4d73d26296336ab155a6118809dfb8ba` |
| `@get-modular/assembly` | `0.1.0` | `41d72bfb266048e6893078cf39f813e08dea2550` | `e89207171e44afd5e813aa5e7a0db8abc999b42338559d38b44b4db71da228ab` |

The Core generated stage1 subject is the complete published archive above.
Its `dist/composition/generated/stage1.js` entry has SHA-256
`93438ec6c300bad642dde280070cabe1f4df2ea07d30176b368f2cee311acf54`;
this entry digest is not the digest of the complete subject. The consumer
profile retains both archives and exact lockfile integrity.
The [packed consumer test](../../packages/apps/embedded-runtime/tests/assembly-packed-consumer.test.ts)
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
The scoped FMS gate remains independent. The live Foundation inventory records six workspace package roots, thirty-four feature
roots, sixteen policy boundaries and exact source/target/runtime-or-type
relationships. Unknown or stale roots and relationships fail, including new
cross-feature edges inside an existing policy boundary. Fixed helpers within
one feature remain ordinary imports. The two retained Host-custodied
contained-turn composition seams are enumerated explicitly. New capabilities
hidden inside existing functions still require semantic ownership review.

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

The current gate is `architecture:runtime-setup-l0-evidence`, backed by
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
   input closure, and strict capture rules. Adoption v2 requires zero skipped
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

The current gate requires a new `runtime-setup-assembly-adoption-v2-evidence.json`
under `docs/spikes`. Its absence keeps current evidence pending. V2 binds ADR-0015,
the historical records, current construction traces and the full tracked source
input closure to exactly two receipts: Linux x64 and Darwin arm64, both using
Node `v24.18.0` and pnpm `11.18.0`. The two original explicit Node test argv lists
are retained in the package-local `scripts/run-package-tests.mjs`; ordinary
package checks and capture share that launcher. It runs clean, typecheck, build
and both test processes, stopping on failure. No test subset or alternative
legacy capture path can satisfy this gate.

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

In clean disposable checkouts of the same final implementation commit, install
with `pnpm install --frozen-lockfile`, then run
`pnpm --filter './packages/**' -r run clean` and `pnpm product:build` with native
prerequisites available. Run this command separately on each required target:

```sh
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
  --output docs/spikes/runtime-setup-assembly-adoption-v2-evidence.json
node scripts/architecture/runtime-setup-l0-evidence.mjs --check
```

The single report embeds each original receipt and every referenced artifact as
base64 bytes, retaining the original receipt SHA-256 and its artifact hashes.
Receipt paths and execution directories remain provenance metadata only: checks
decode the bundled bytes and run the existing strict receipt, stream and paired
coverage validators without reading external capture paths. Hashes authenticate
retained bytes, not independent execution. No external artifact service or
additional input exclusion is required.

Commit the complete implementation as source revision R before either final
capture. Capture both targets at R, then create delivery revision D by adding
only the report. The report alone is excluded from the source closure to avoid
self-reference; every other tracked path, mode and byte, including tools' source,
locks, manifests, tests and native recipes, must still match R. Clean CI needs
only the delivered report and full Git object closure for R and the required
historical revisions. Bundled receipts do not replace historical source readback.
The rejecting fixtures deliver a report-only commit into a fresh clone, delete
the original capture tree and validate against R. Missing or mutated bundled
bytes, mixed source receipts and other tracked input changes must fail. The
existing architecture gate runs these fixtures via
`runtime-setup-l0-evidence-validation.test.mjs`.

Implementation review re-read the pinned Consumer Module Standard and compared
it with the locally retained upstream `03a7df64bc5e9939f7b51694a80a7f3d61453f98`
snapshot: both complete documents retain SHA-256
`ea54578ebe69fc410bf973b6112dcefc4ad7c163e563e0ee307cd7b5f8b8723d`.
Live upstream refresh was unavailable in the implementation sandbox; delivery
must recheck it before claiming a current upstream comparison. V2 changes evidence
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
records its own exact source identity and platform receipts. Before delivery,
validate that report against the complete implementation and documentation
checkpoint with `pnpm architecture:runtime-setup-l0-evidence`. If tracked inputs
have changed, refresh the supported paired capture. A report-only commit may
reuse the authenticated source only under the existing validator rules.

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
