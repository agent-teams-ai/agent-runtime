---
id: qualification.interactive-session-c-first-slice
type: qualification-plan
status: accepted
owner: architecture/qualification
summary: Defines synthetic C session lifecycle acceptance, evidence limits and remaining real provider route and Host qualification gates.
related:
  - ADR-0091
  - runtime.architecture.readiness
---

# Interactive session C first slice qualification

Status: accepted prospective plan by root technical review, 2026-10-21.
This is a prospective campaign and candidate gate
list under [ADR-0091](../decisions/0091-interactive-agent-session-synthetic-vertical-slice.md),
not retained passing evidence. The mutable [readiness register](../architecture/readiness.md)
continues to own actual qualification. This document creates no registry tuple.

## Target tuple

The first C checkpoint uses a deterministic provider double, fixture authority,
new disposable workspace, one Host process and the existing PostgreSQL topology.
The real production Agent Execution session owner and PostgreSQL adapter must
be exercised; an in-memory fake store only proves policy tests. The evidence
records exact source, OS/architecture, Node, database version/topology, driver,
fixture revisions and cleanup. Until those facts are observed there is no exact
qualified eight-field tuple to register.

The separate B SDK/CLI campaign may use the actual pinned SDK/CLI against a
localhost Anthropic-compatible fixture; its SDK behavior is stronger evidence
than a mocked SDK method, but it proves no Anthropic service/authentication.
Do not manufacture an auth record or register either fixture as a real-provider
credential route. No live account is required for the synthetic checkpoint.

## Required evidence

| Boundary | Pass condition |
| --- | --- |
| Admission/store | Same scoped ID/fingerprint returns original current state; conflict has no provider call; one winning claim under concurrency; lost commit response requires readback and never a second handoff |
| Restart/handoff | Stop the owning TEST process after claim and before receipt, reconstruct from the real store, and observe `handoff_unknown/reconcile_required`; queued successor stays blocked; a known not-sent control case remains separately observable |
| Sequential session | A waits on interaction while B is admitted; reply reaches A before result; B hands off only after A terminal/control boundary closes; two sessions never share attribution |
| Control | Delayed interrupt A after result A does not interrupt B; unresolved interrupt blocks B handoff; after interrupt acknowledgement but before A terminal, newly arriving A permission/question callbacks and replies are rejected, with no grant; B gets independent authority; concurrent close seals new submit/reply and joins one shutdown |
| Interactions | Permission and question have distinct validated payloads; wrong scope/generation/expiry, conflicting replay and late/post-abort reply never grant; reply remains responsive with full prompt queue |
| Output/feed | Snapshot/complete update one message block; equal text in distinct messages stays distinct; unknown attribution stays absent; observer replay/gap is explicit; slow consumer and overflow preserve bounded memory and typed outcome |
| Checkpoint | Explicit compatible restore uses only the selected session, creates new generation, rejects missing/wrong engine/config/workspace/account state and restores no old callback authority |
| Dependencies/authority | Required missing tool/capability, revoked or expired synthetic authority refuse before dispatch; dependency loss suspends new handoffs; unknown control event cannot become success |
| Closure | Failed resource owner/drain leaves observable cleanup debt, retained owner and no clean-close receipt; normal close releases all TEST resources; target close leaves neighbouring session usable |
| Consumer/package | Runtime core has no SDK/Node/Assembly imports; packed contract/provider consumer works outside source/sibling checkout; no experiment import or legacy product writer remains in that delivered slice |

Use deterministic barriers/fault injection at the store/provider seams for race
orderings, not sleeps or a new scheduler. The same contract suite runs on the
provider fake and SDK implementation where their declared capabilities apply;
expected unsupported behavior is explicit, never an artificial successful no-op.
Tests assert observable owner state and provider-call count, not mock calls alone.
Crash recovery must actually reopen durable state, not reuse the old live map.

Retain one compact campaign result containing exact commits/versions, scenario
results, command exit codes, provider invocation counts, redacted state/events,
cleanup observations and limitations. Do not log raw prompts with secrets,
checkpoint payloads, credentials or provider exception text. Test-only input
files and provider artifacts stay under the campaign's new `TEST-*` root.

## Negative gates

For the new feature, activate and test the exact FMS scope in the same code
delivery. Keep the existing v1 pin; no nested features are needed. Include
rejecting fixtures for unknown/unowned feature, undeclared export/deep import,
source-policy root/edge drift, SDK/Node/Assembly in policy, and a removed/no-op
gate. Keep existing scopes green without adding exclusions.

Before production Host integration, finish the scoped CMS/package work recorded
in `architecture/interactive-agent-session/cms-pin-review.json`: actual entries,
profile root/slots, ownership, current standard pin/archive identities, failure/
cancellation ownership and an independent binding oracle. A successful fixture
factory does not activate that Host scope. Run applicable existing gates:

```sh
pnpm docs:check
pnpm docs:protocol:check
pnpm architecture:feature-modules:active
pnpm test:feature-modules
pnpm architecture:get-modular-adoption
pnpm test:get-modular-adoption
pnpm architecture:consumer-modules
pnpm test:consumer-modules
pnpm check:changed
pnpm check:fast
pnpm check
```

Add the exact interactive focused test paths to package test/typecheck and CI
source census during implementation; no invented command here is claimed to
exist. Existing frozen CI inventories need their finite reviewed admission,
including actual CI product census; a local `pnpm check` alone misses some of
those package inventory constraints. Passing documentation checks is not code
adoption, and passing full CI is not a real-provider qualification campaign.

## Promotion rule

Root technical review accepted ADR-0091 and this prospective plan on 2026-10-21
under the existing owner A–F direction, without asking again about the chosen
SDK/session design. The final new ADR digest is recorded through the established
accepted-decision registry and mutable indexes; frozen predecessor bytes remain
untouched. Plan acceptance is independent of evidence results: no campaign is
reported as passing by this document.

After synthetic C passes, readiness may record only the exact observed synthetic
implementation scope and its limitations. Real Claude route, launcher/custody
compatibility, actual tool authority, packed production Host and deployment
remain open until independently demonstrated. Real-provider follow-up uses an
explicit selected legal credential route and exact SDK/CLI/platform tuple; it
cannot inherit qualification from an old Codex route or fixture bearer string.

The first Host assurance is cooperative same-user owned-resource cleanup.
Hostile same-uid containment, physical descendant closure after ownership loss,
remote/multi-user deployment, subscription onboarding, release OS/ASAR/signing,
Orchestrator product tools, desktop projections and final fork removal remain
separate A–F/delivery results. Missing real credentials blocks only the real-auth
campaign; it does not block implementation and maximal fixture E2E.
