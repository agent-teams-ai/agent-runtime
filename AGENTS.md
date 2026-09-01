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

Guardrails:

- Treat accepted ADRs and promoted architecture rules as normative. Evidence
  and spike documents do not independently authorize production behavior.
- Do not run live provider or agent commands on user projects. Use only
  explicitly disposable test environments for runtime experiments.
- Keep provider-specific behavior behind runtime adapters and do not import
  orchestrator domain models.
- `pnpm check` runs only synthetic, disposable tests. Provider spike commands
  are separate and require explicit scope and safety review.

Verification workflow:

- Run `pnpm check:changed` during implementation for Foundation-routed feedback
  on the current Git delta.
- Run `pnpm check:fast` before handoff.
- Run the authoritative `pnpm check` before opening or merging a pull request.
- A passing changed-file or fast check never replaces the complete gate.
