---
id: ADR-0007
type: adr
status: proposed
owner: architecture/tooling
summary: Defines deterministic documentation authority and immutable evidence adoption.
related:
  - ADR-0001
  - ADR-0005
blocked_by: []
code_anchors:
  - enforcement: required
    pattern: architecture/foundation/docs-protocol.yaml
  - enforcement: required
    pattern: architecture/foundation/document-authoring.yaml
supersedes: []
superseded_by: []
---

# ADR-0007: Deterministic documentation governance

Status: proposed

Date: 2026-08-14

## Context

Agent Runtime has normative decisions, mutable architecture guidance, retained
qualification evidence, and a fail-closed qualification plan. These documents
must be discoverable through the organization-wide documentation protocol
without weakening the repository's immutable evidence rules.

Thirty-six existing files cannot receive inline metadata safely: accepted
ADR-0001 through ADR-0005 are immutable decisions, thirty retained spike reports
are bound by SHA-256 in the qualification registry, and the superseded runtime
profile report remains frozen historical evidence. Editing those files only to
add frontmatter would invalidate the evidence they preserve.

## Decision

### Authority boundaries

Agent Runtime adopts the shared `agent-teams.docs-protocol` version 1 command
semantics. Engineering Foundation remains the only owner of catalog parsing,
strict metadata merge, Plan/Apply/Receipt publication, locking, filesystem
safety, transaction recovery, and the single mutating writer.

The repository owns only declarative authority:

- `architecture/foundation/docs-protocol.yaml` routes the shared agent and CLI
  experience;
- `architecture/foundation/document-authoring.yaml` declares catalog roots,
  metadata authority,
  authoring types, placement, templates, and reachability;
- `docs/document-metadata.schema.json` defines the closed metadata vocabulary;
- `docs/owners.yaml` defines stable maintenance owners;
- `docs/document-metadata.json` supplies complete metadata for frozen files;
- `docs/templates/` supplies inert Markdown body templates.

These files contain no commands, callbacks, imports, remote schemas,
environment interpolation, or executable consumer code.

### Strict sidecar merge

Mutable documents carry complete metadata in their inline YAML frontmatter.
Frozen documents carry no new inline bytes. Metadata that completes their
existing frontmatter, or supplies it when absent, is keyed by the exact
repository-relative path in `docs/document-metadata.yaml`.

Foundation profile v2 performs the merge. A document with complete inline
metadata needs no sidecar entry. A frozen document may have a sidecar entry that
strictly completes its existing partial frontmatter. Conflicting overlap,
unknown paths, unknown fields, incomplete merged metadata, duplicate IDs,
invalid owners, and schema violations fail closed. The sidecar never overrides
document bytes or inline values.

### Document lifecycle is not evidence qualification

The documentation `status` field describes document lifecycle only:

- `active` for maintained indexes and mutable operational architecture;
- `accepted` for accepted architecture and immutable accepted decisions;
- `proposed` for decisions and qualification plans awaiting acceptance;
- `evidence-reference` for retained reports bound to observed scope;
- `superseded` for historical material retained only as evidence.

These values never imply `scoped`, `implementation`, or `deployment`
qualification. Qualification authority remains exclusively in
`docs/architecture/qualification-registry.json` and
`docs/architecture/readiness.md`.

### Types, owners, and reachability

The supported types are `index`, `architecture`, `adr`, `evidence`, and
`qualification-plan`. Their maintenance owners are `architecture`,
`architecture/tooling`, and `architecture/qualification`.

Every type has an explicit manual index route. Publication reports the exact
index path and Markdown link, but never edits an index automatically. A new
document is incomplete until its author updates that reported index in the same
change.

Templates establish the required initial structure but do not duplicate
repository-specific policy. `docs:info` is the authoritative way for an agent
to discover types, owners, required metadata, placement, and index policy.

### Agent workflow

`AGENTS.md` routes documentation work to the thin
`.agents/skills/docs-authoring/SKILL.md`. The skill records only the protocol
identity and generic Plan/Apply/check loop; it does not restate the profile.

Preview is non-mutating and non-reserving. A write requires explicit `--apply`.
All runtime documentation checks use static files and disposable fixtures; they
must not launch agents, providers, provisioning, terminals, or runtime smoke
flows against a real project.

## Consequences

- Existing immutable decisions and pinned evidence retain identical bytes and
  digests while participating in one searchable catalog.
- Agents use the same commands as other organization repositories and discover
  Runtime-specific policy from data rather than copied instructions.
- Sidecar entries create an explicit maintenance obligation. Moving a frozen
  file requires an intentional sidecar and evidence-registry update.
- Accepting this ADR requires adding it to the immutable accepted-decision
  registry in the acceptance change; proposal alone must not register it.
- Removing the shared protocol or changing its major contract requires a new
  ADR and a coordinated migration.

## Alternatives considered

### Rewrite frozen documents with inline metadata

Rejected because it changes accepted and evidence-bound bytes for cataloging
convenience.

### Maintain a Runtime-specific writer and query engine

Rejected because it creates a second mutation authority and divergent agent
semantics.

### Treat documentation lifecycle as qualification state

Rejected because a well-maintained document does not qualify an implementation
or deployment target.
