# Runtime profile experiments

Status: evidence and falsifiable candidate models only.

Nothing under this directory is production architecture or reusable runtime
core. The canonical decision is:

`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

The cross-campaign exact target index is
`docs/architecture/qualification-registry.json`. It defaults every omitted
provider/provider-adapter/binary-closure/platform/credential-route/storage-
topology/transport-topology/failure-domain whole tuple to `unqualified`;
`pnpm architecture:registry` verifies its coverage and evidence hashes.

Current runtime-profile and execution evidence:

- `spec/runtime-operation-oracle/README.md` - synthetic executable evidence for
  proposed ADR-0006, with JSON authority, generated review artifacts, and an
  explicit validity-versus-reachability boundary;
- `docs/spikes/opencode-hosting-e2e-results.md` - human-readable accepted
  scoped results and adapter consequences;
- `fixtures/opencode-hosting-e2e-summary.json` - redacted machine-readable
  facts, invariants, binary hashes, and remaining gates.
- `docs/spikes/linux-nonroot-containment-egress-results.md` - accepted scoped
  container/cgroup custody and resource-limit evidence plus the same-network
  egress counterexample;
- `fixtures/linux-nonroot-containment-egress-summary.json` - redacted Linux
  containment facts, provenance hashes, invariants, and remaining gates.
- `docs/spikes/opencode-container-tls-gateway-results.md` - accepted synthetic
  immutable OpenCode container and application TLS gateway behavior;
- `fixtures/opencode-container-tls-gateway-summary.json` - redacted closure,
  cold-start, TLS, budget, campaign, provenance, and remaining-gate facts.
- `docs/spikes/opencode-macos-conformance-results.md` - accepted partial
  Apple Silicon platform evidence, including App Sandbox, adversarial process
  escape, SQLite recovery, and native/Rosetta compatibility;
- `fixtures/opencode-macos-e2e-summary.json` - redacted macOS facts,
  provenance hashes, adapter invariants, and remaining platform gates.
- `docs/spikes/macos-keychain-custody-results.md` - accepted disposable
  file-backed macOS Keychain mode, lock, backup-generation, concurrent-update,
  and custody boundary evidence;
- `fixtures/macos-keychain-custody-summary.json` - redacted Keychain facts,
  evidence hashes, custody invariants, and remaining production key gates.
- `docs/spikes/macos-codex-claude-cli-conformance-results.md` - scoped local
  real-login Codex and Claude binary-pair, instruction, stream, effect,
  concurrency, and local SIGINT observations;
- `fixtures/macos-codex-claude-cli-summary.json` - allowlist-projected CLI
  facts, exact binary closure, adapter invariants, and remaining gates.
- `docs/spikes/macos-codex-app-server-conformance-results.md` - scoped Codex
  stable-stdio handshake, generated-schema, environment, instruction-source,
  concurrency, overlap, interrupt, effect, and resume observations;
- `fixtures/macos-codex-app-server-summary.json` - allowlist-projected App
  Server facts, counterexamples, schema hashes, invariants, and remaining
  gates.
- `docs/spikes/macos-codex-app-server-effects-results.md` - scoped Codex
  successful/failed effect lifecycle, replay, output-drain, serialization,
  interrupt, and crash-recovery behavior;
- `fixtures/macos-codex-app-server-effects-summary.json` - allowlist-projected
  effect facts, exact binary/schema closure, assertions, and cleanup.
- `docs/spikes/macos-claude-agent-sdk-conformance-results.md` - scoped current
  TypeScript SDK isolation, environment, stream-drain, concurrency,
  cwd-scoped resume, macOS sandbox, queued-interrupt, and abort observations;
- `fixtures/macos-claude-agent-sdk-summary.json` - allowlist-projected SDK
  closure, protocol counterexamples, sandbox facts, invariants, and cleanup.
- `docs/spikes/macos-claude-session-store-conformance-results.md` - scoped
  current-SDK restore, placement, opaque-entry integrity, append retry, mirror
  failure, timeout, and capability observations;
- `fixtures/macos-claude-session-store-summary.json` - redacted SessionStore
  closure, scenario facts, assertions, and cleanup.
- `docs/spikes/macos-claude-tools-hooks-conformance-results.md` - scoped
  current-SDK synthetic MCP, hook authorization, callback shadowing,
  containment, error, timeout, interrupt, environment, and cleanup behavior;
- `fixtures/macos-claude-tools-hooks-summary.json` - redacted dependency
  closure, tool and hook scenario facts, assertions, and cleanup.
- `docs/spikes/macos-claude-mcp-failure-conformance-results.md` - scoped
  current-SDK retry duplication, idempotent reconciliation,
  crash-after-effect ambiguity, and detached-descendant behavior;
- `fixtures/macos-claude-mcp-failure-summary.json` - redacted dependency
  closure, failure scenario facts, assertions, and cleanup.
- `docs/spikes/macos-claude-subagent-parallel-results.md` - scoped
  programmatic-subagent, parallel-call, child authorization, parent-abort,
  and SessionStore-tree observations;
- `fixtures/macos-claude-subagent-parallel-summary.json` - allowlisted
  revision closure, negative assertions, lineage projections, and cleanup.
- `docs/spikes/macos-claude-subagent-stdio-results.md` - scoped one-process
  sequential and two-process same-host external-stdio child delivery, overlap,
  assistant grouping, parent abort, unexpected built-in child, duplicate
  launch, and roster-gate observations;
- `fixtures/macos-claude-subagent-stdio-summary.json` - allowlisted external
  stdio delivery, hook, effect, abort, process, and cleanup facts;
- `fixtures/macos-claude-subagent-roster-summary.json` - allowlisted
  `subagent_type` requests, gate decisions, starts/stops, missing callback and
  denial-event observations, and cleanup.
- `fixtures/macos-claude-subagent-dual-stdio-summary.json` - allowlisted
  assistant grouping, background-call, child hook, dual-process overlap,
  effect, terminal, and cleanup facts.
- `docs/spikes/postgresql-concurrency-results.md` - accepted single-host and
  scoped two-physical-host PostgreSQL command, link-loss, fencing,
  outbox/inbox, crash, and restore evidence;
- `fixtures/postgresql-concurrency-summary.json` - redacted machine-readable
  PostgreSQL facts, evidence hashes, invariants, and remaining distributed
  gates.
- `docs/spikes/connect-replay-results.md` - accepted local Node Connect
  HTTP/1.1/HTTP2 timeout, explicit replay, cursor, slow-consumer, and cleanup
  evidence;
- `fixtures/connect-replay-summary.json` - redacted Connect facts, dependency
  pins, evidence hashes, invariants, and remaining transport/SDK gates.
- `docs/spikes/stage-f-authority-lease-custody-results.md` - scoped
  PostgreSQL launch, admission, lease, effect, child-custody, unknown-response,
  and terminal-receipt contract evidence;
- `fixtures/stage-f-authority-lease-custody-summary.json` - redacted Stage F
  concurrency facts, evidence identities, audit results, and remaining gates.
- `docs/spikes/stage-g-profile-environment-contracts-results.md` - scoped
  randomized source, resource, instruction, environment, revision, and
  classifier contract evidence;
- `fixtures/stage-g-profile-environment-contracts-summary.json` - redacted
  Stage G contract facts, source identities, audit results, and remaining
  native/provider/cross-language gates.
- `docs/spikes/stage-h-version-skew-migration-results.md` - scoped PostgreSQL
  consumer-version, poison quarantine, retirement, binary-lease, migration
  claim, and expand/backfill/contract evidence;
- `fixtures/stage-h-version-skew-migration-summary.json` - redacted Stage H
  facts, frozen source identities, audit results, and remaining deployment
  and production-migration gates.
- `docs/spikes/stage-i-streaming-egress-results.md` - scoped loopback HTTP/1
  request/response budget, post-header failure, cancellation, backpressure,
  and concurrent-stream evidence;
- `fixtures/stage-i-streaming-egress-summary.json` - redacted Stage I facts,
  rejected revisions, source identities, audit results, and remaining
  external-transport/provider gates.
- `docs/spikes/stage-j-storage-failure-recovery-results.md` - scoped ext4
  ENOSPC, state/outbox atomicity, SIGKILL recovery, checksum-corruption, and
  verified-restore evidence;
- `fixtures/stage-j-storage-failure-recovery-summary.json` - redacted Stage J
  facts, source identities, audit results, cleanup, and remaining physical/DR
  gates.
- `docs/spikes/stage-k-capacity-fairness-results.md` and
  `fixtures/stage-k-capacity-fairness-summary.json` - hosted single-host
  capacity, idempotency, finite fairness, overload, reclaim, restart, cleanup,
  and soak evidence.
- `docs/spikes/stage-l-postgres-failover-results.md` and
  `fixtures/stage-l-postgres-failover-summary.json` - synthetic same-host
  PostgreSQL streaming, quorum loss, external fencing, promotion, rewind, and
  reparent evidence.
- `docs/spikes/stage-m-egress-policy-results.md` and
  `fixtures/stage-m-egress-policy-summary.json` - hosted loopback signed egress
  authorization, final pre-byte dispatch, transport closure, time, and digest
  oracle evidence.
- `docs/spikes/stage-n-binary-revision-results.md` and
  `fixtures/stage-n-binary-revision-summary.json` - deterministic complete
  binary closure, compatibility, activation, assignment, rollback, retention,
  GC, replay, clock, and encapsulation evidence.

The tests intentionally preserve some historical hypotheses so their evidence
remains reproducible. A green experiment suite does not approve those
hypotheses for production.

Known superseded or falsified candidate behavior:

- `authority-binding` may directly request
  `retire-generation-and-restart`; ADR-0001 instead requires Security to record
  revocation and Agent Execution to fence, stop, and reconcile without an
  automatic successor;
- the profile-composition candidate mixes grants and security revisions into
  one manifest identity; ADR-0001 separates `CompiledProfilePlan`,
  `ResourceAuthorization`, review, and live activation;
- the capture candidate rejects direct symlinks and source replacement but is
  not a production security boundary because later bind-mount and ancestor
  race probes escaped the intended root;
- team launch planning belongs to the orchestrator and must not move into AR.

New implementation may adapt provider observations, fixtures, and conformance
cases. It must not copy candidate domain models or helpers into production
packages.
