# Agent Navigation

This repository owns provider-neutral technical runtime execution. It does not
own teams, tasks, business workflows, or other orchestrator domain semantics.

Start here:

- Repository overview: [README.md](README.md)
- Canonical architecture reading order: [docs/README.md](docs/README.md)
- Current readiness gates: [docs/architecture/readiness.md](docs/architecture/readiness.md)
- Exact qualified runtime targets:
  [docs/architecture/qualification-registry.json](docs/architecture/qualification-registry.json)
- Scoped Feature Module Standard v1 active adoption:
  [docs/architecture/feature-module-standard-v1-candidate.md](docs/architecture/feature-module-standard-v1-candidate.md)
<!-- agent-teams-docs:route/v1 begin -->
Use [.agents/skills/docs-authoring/SKILL.md](.agents/skills/docs-authoring/SKILL.md) for documentation.
<!-- agent-teams-docs:route/v1 end -->

- Planned passive Assembly adoption and outstanding gates:
  [Get Modular adoption](docs/architecture/get-modular-adoption.md)

Guardrails:

- Every new production feature, including in excluded packages or legacy files,
  must follow Feature Module Standard v1 and deliver scoped adoption and blocking
  conformance evidence. Follow the
  [new-feature requirements](docs/architecture/feature-module-standard-v1-candidate.md#new-production-features)
  before implementation; current exclusions do not exempt new capabilities.
- Treat accepted ADRs and promoted architecture rules as normative. Evidence
  and spike documents do not independently authorize production behavior.
- Do not run live provider or agent commands on user projects. Use only
  explicitly disposable test environments for runtime experiments.
- Keep provider-specific behavior behind runtime adapters and do not import
  orchestrator domain models.
- `pnpm check` runs only synthetic, disposable tests. Provider spike commands
  are separate and require explicit scope and safety review.

Foundation `architecture.source-dependencies` is schema v3: `rootPackage: true`
and `packageRoots` for every workspace package. Required CI runs
`agent-teams-foundation check` on the installed registry package. When that
gate reports a boundary violation, fix the source rather than shrinking scope
or adding a baseline:

- forbidden domain/tooling dependency -> introduce a consumer-owned port and
  adapter; do not import filesystem, environment, network SDK, or a concrete
  adapter into Agent Execution / Provider Access core;
- deep import -> use the public entrypoint listed for that boundary;
- cross-package relative import -> package export or a dynamic repo-root load
  from a development boundary, never a new production package;
- new root or package -> owner, `packageRoots`/`rootPackage`, and a
  non-overlapping boundary, never an exclusion;
- `includeRootPackage` in YAML is invalid; public v3 uses `rootPackage: true`;
- CI greening by dropping a governed root, pending a root silently, or adding
  an unbounded suppression is forbidden.

Verification workflow:

- Run `pnpm check:changed` during implementation for Foundation-routed feedback
  on the current Git delta.
- Run `pnpm check:fast` before handoff.
- Run the authoritative `pnpm check` before opening or merging a pull request.
- A passing changed-file or fast check never replaces the complete gate.

## Consumer Module Standard maintenance

Mandatory for every change to module boundaries, capability contracts, composition, lifecycle ownership, adoption profiles or their gates: read the canonical Get Modular Consumer Module Standard (`docs/architecture/common-assembly.md#consumer-module-standard` in agent-teams-ai/get-modular). Update its current guidance/examples when shared behavior changes, and update affected consumer profiles, documentation and rejecting tests in the same delivery. Do not duplicate the standard or silently replace accepted ADR bytes.

Before implementation, compare the consumer's pinned revision with the current upstream standard; review the delta and migrate the pin with its retained evidence and checks. Never silently follow a moving main revision. If migration is not yet complete, record the exact outstanding work and keep adoption pending. A task is not done with stale guidance, an unreviewed pin, or a no-op/missing enforcement command. New meaningful composition boundaries must be adopted or explicitly classified; feature-local helpers are not separate graph nodes.
