# agent-runtime

Provider-neutral managed runtime for launching and controlling coding agents

## Architecture

Start with `docs/README.md` for the canonical reading order and ADR status.
The complementary architecture foundation is indexed in
[`docs/architecture/README.md`](docs/architecture/README.md), including:

- [Accepted architecture foundation](docs/architecture/architecture-foundation.md)
- [Execution generation model](docs/architecture/execution-generation-model.md)
- [Communication boundaries](docs/architecture/communication-boundaries.md)
- [OpenCode integration](docs/architecture/opencode-integration.md)

Promoted evidence links are in
`docs/architecture/evidence-traceability.md`. Exact target qualification is in
the fail-closed machine-readable
`docs/architecture/qualification-registry.json`; current open gates are in
`docs/architecture/readiness.md`. Run `pnpm architecture:registry` to verify
registry coverage and pinned evidence hashes.
Executable repository governance, maintainability limits, and the approved
bounded-context scaffolding workflow are recorded in
[`docs/architecture/foundation-adoption.md`](docs/architecture/foundation-adoption.md).
Current OpenCode platform evidence is in
`docs/spikes/opencode-hosting-e2e-results.md` and
`docs/spikes/opencode-macos-conformance-results.md`.
Current scoped Linux non-root container/cgroup and egress evidence is in
`docs/spikes/linux-nonroot-containment-egress-results.md`.
Current synthetic OpenCode immutable-container and application TLS gateway
evidence is in
`docs/spikes/opencode-container-tls-gateway-results.md`.
Current disposable macOS Keychain custody evidence is in
`docs/spikes/macos-keychain-custody-results.md`.
Current scoped local macOS Codex and Claude CLI conformance evidence is in
`docs/spikes/macos-codex-claude-cli-conformance-results.md`.
Current scoped local Codex App Server stable-stdio evidence is in
`docs/spikes/macos-codex-app-server-conformance-results.md`.
Current scoped Codex App Server effect lifecycle, replay, output-drain,
serialization, interrupt, and crash-recovery evidence is in
`docs/spikes/macos-codex-app-server-effects-results.md`.
Current scoped local Claude Agent SDK stream, queue, resume-placement, and
macOS sandbox evidence is in
`docs/spikes/macos-claude-agent-sdk-conformance-results.md`.
Current scoped Claude external SessionStore restore, integrity, retry, mirror,
and timeout evidence is in
`docs/spikes/macos-claude-session-store-conformance-results.md`.
Current scoped Claude synthetic MCP, tool, permission, hook, timeout, and
stdio-process evidence is in
`docs/spikes/macos-claude-tools-hooks-conformance-results.md`.
Current scoped Claude MCP retry, ambiguous-effect, crash, and detached
descendant evidence is in
`docs/spikes/macos-claude-mcp-failure-conformance-results.md`.
Current scoped Claude programmatic-subagent, parallel-call, child
authorization, abort, and SessionStore-tree evidence is in
`docs/spikes/macos-claude-subagent-parallel-results.md`.
Current scoped Claude one-process sequential and two-process same-host stdio
child delivery, overlap, abort, and `subagent_type` roster-gate evidence is in
`docs/spikes/macos-claude-subagent-stdio-results.md`.
Current single-host and scoped two-physical-host PostgreSQL concurrency and
link-loss evidence is in
`docs/spikes/postgresql-concurrency-results.md`.
Current local Node Connect timeout, replay, cursor, and slow-consumer evidence
is in `docs/spikes/connect-replay-results.md`.
