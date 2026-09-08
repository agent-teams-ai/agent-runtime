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
without `conformant: true` for the repository. Upstream main was compared with
the retained standard on 2026-09-08 and resolved to the same pinned commit;
there was no standard delta to migrate.

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
The scoped FMS gate remains independent. The live Foundation inventory records six workspace package roots, nine feature
roots, sixteen policy boundaries and exact source/target/runtime-or-type
relationships. Unknown or stale roots and relationships fail, including new
cross-feature edges inside an existing policy boundary. Fixed helpers within
one feature remain ordinary imports. The two retained Host-custodied
contained-turn composition seams are enumerated explicitly. New capabilities
hidden inside existing functions still require semantic ownership review.

## Evidence and executable references

Existing passive contract evidence starts with
[capability bundle tests](../../packages/apps/embedded-runtime/tests/capability-bundle-contract.test.ts),
[access boundary tests](../../packages/apps/embedded-runtime/tests/runtime-access-boundaries.e2e.test.ts),
and [Codex setup tests](../../packages/apps/embedded-runtime/tests/codex-setup.e2e.test.ts).
The profile maps `createDefaultAgentRuntimeHost`, its private
`default-agent-runtime-host.ts` implementation, and declarations, profile and
factories in `runtime-setup-assembly.ts`. It maps passive Assembly, type and
independent direct-reference tests without adopting the whole composition directory.
Wrong-binding mutation, typed token/slot rejection, zero-call preflight failure,
attempt isolation, failed handoff cleanup, and post-handoff startup abort must
be proved alongside packed public-root consumer validation. Use only disposable
TEST projects and passive temporary filesystem fixtures, never live providers.

## Required L0 checker transition

The current gate is `architecture:runtime-setup-l0-evidence`, backed by
`scripts/architecture/runtime-setup-l0-evidence.mjs` and its spec, inputs,
validation modules and tests. This documentation checkpoint does not edit them.
Atomic cutover must implement the following bounded transition:

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
   input closure, and zero-skips capture rules. Add rejecting fixtures for
   missing/wrong adoption authority, trace drift, altered historical evidence,
   bypassed command chain, and inward Core/Assembly imports. No unconditional
   skip of L0 validation or permissive fallback is acceptable.
5. Capture new current-source evidence on a supported disposable platform only
   after atomic package/API/caller integration. The new owner decision permits
   this static slice without asserting that historical L1 promotion passed.
   Broader L1 retains its two-of-three rule; L2-L5 remain no-go.

Delivery remains pending until focused gates, fast/full integrated-source checks,
independent review, exact artifacts, and before/after benefit measurements pass.
Negative or inconclusive benefit must be reported honestly. No readiness or
qualification claim follows from documentation acceptance.

The scoped [consumer profile](../../architecture/get-modular/consumer-profile.json)
records the activation inputs for ADR-0015. Both `check:fast` and `check` execute
`architecture:get-modular-adoption` and `test:get-modular-adoption`. The canonical
checker itself requires live Foundation source diagnostics to pass before
comparing the exact census; metadata validation alone cannot activate adoption.

## Keeping the standard current

Changes to shared module contracts or recommended composition patterns must update
the central standard and affected consumer guidance in the same delivery. Changes
to local boundaries must update the profile, ownership mapping and positive and
rejecting gate fixtures. Before implementation, compare the pinned standard with
upstream, review its delta and update the exact pin and retained bytes together.
Never silently follow moving main, rewrite accepted ADRs, or mark a pending
profile active before its real blocking checks pass. Stale documentation or
unverified adoption is unfinished work.
