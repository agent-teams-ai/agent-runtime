---
id: runtime.architecture.get-modular-adoption
type: architecture
status: active
owner: architecture
summary: Tracks the passive setup adoption contract and outstanding evidence without extending runtime qualification.
---

# Get Modular adoption

## Status and authority

Status: planned adoption, authority groundwork only. Package publication,
consumer profile enforcement, production cutover, packed validation, and final
benefit evidence are not established by this document.
[ADR-0015](../decisions/0015-passive-setup-static-assembly-adoption.md) accepts the
bounded contract. ADR-0008 and its historical evidence remain immutable;
ADR-0013 continues to govern exactly its three active FMS features.

The central authority is Get Modular's
[consumer module standard](https://github.com/agent-teams-ai/get-modular/blob/e6568398d08eaebe9fe2af1bb6fcc54f4e15f704/docs/architecture/common-assembly.md#consumer-module-standard)
and a pending central consumer-standard decision. The original candidate
used ADR-0024, but that ID conflicts with merged upstream authority. It must be
replaced by the reviewed successor candidate (planned ADR-0026) before pin
activation. Retained original candidate identity, not the final activation pin:

- Repository: `agent-teams-ai/get-modular`.
- Commit: `e6568398d08eaebe9fe2af1bb6fcc54f4e15f704`.
- Path: `docs/architecture/common-assembly.md`; anchor: `consumer-module-standard`.
- Complete UTF-8 file SHA-256: `c2b48470112f2b809ab1d1b65ad6006f159acde7ef99cffd9b9495c6df62fbd7`.
- Pin activation: unresolved; the original candidate is superseded for
  integration. Replace its commit/digest with the reviewed successor after
  the central decision is merged and the
  consumer profile verifies the accepted immutable bytes. This candidate is not
  an assertion of an already merged upstream standard.

Document identity, package versions/archive integrity, Core compatibility token,
and local adoption authority are distinct. Publication and approved artifact
identities remain unresolved; a private package version or workspace build
cannot satisfy them. The future consumer profile records exact identities and
actual blocking commands, without `conformant: true` for the repository.

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
The scoped FMS gate remains independent. The consumer census must enumerate
existing direct boundaries and relationships explicitly, reject unknown/stale
entries and new edges, and leave semantic ownership to technical review.

## Evidence and executable references

Existing passive contract evidence starts with
[capability bundle tests](../../packages/apps/embedded-runtime/tests/capability-bundle-contract.test.ts),
[access boundary tests](../../packages/apps/embedded-runtime/tests/runtime-access-boundaries.e2e.test.ts),
and [Codex setup tests](../../packages/apps/embedded-runtime/tests/codex-setup.e2e.test.ts).
These are existing behavior references, not evidence that Assembly is adopted.
The integrated checkpoint must add the executable passive Assembly fixture to
the actual embedded-runtime test command and retain an independent direct oracle.
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
records the activation inputs for ADR-0015. A pending profile does not prove adoption.
