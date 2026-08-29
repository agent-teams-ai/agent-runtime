---
id: runtime.docs.index
type: index
status: active
owner: architecture
summary: Canonical reading order for Agent Runtime architecture and evidence.
---

# Agent Runtime architecture

Read documents in this order:

1. `decisions/0001-runtime-profile-and-activation-boundaries.md` - canonical
   accepted profile, security, access, and activation boundaries.
   Immediately after it, read
   `decisions/0002-architecture-reconciliation-tenancy-and-operator-recovery.md`
   - the reconciliation of the parallel foundation documents, hosted-tenancy
   vocabulary, owner-local recovery model, and phased operator controls. Then
   read `decisions/0003-runtime-cutoff-barriers-and-scope-disposition.md` - the
   target-specific cutoff boundaries, orthogonal predecessor barriers, exact
   effect-identity boundary, and normalized scope-disposition rules. Then read
   `decisions/0004-pre-materialization-dispatch-prevention.md` - the durable
   negative operation-intent guard, dispatch ordering, anti-resurrection, and
   automated external-effect identity requirements. Then read
   `decisions/0005-runtime-context-package-identities.md` - the accepted private
   package identities and the rule that scaffolding accompanies a real vertical
   slice. Then read proposed
   `decisions/0006-orthogonal-runtime-operation-state-and-effect-continuity.md`
   as the broader design input, followed by accepted
   `decisions/0010-contained-agent-turn-v1-operation-authority.md`, the
   deliberately narrow Contained Agent Turn V1 authority, and its
   synthetic executable oracle at
   `../experiments/runtime-profile-behavior/spec/runtime-operation-oracle/README.md`.
   Documentation changes follow accepted
   `decisions/0007-deterministic-documentation-governance.md`, which is pinned
   in the immutable accepted-decision registry. Production application
   composition follows accepted
   `decisions/0008-private-embedded-runtime-access-entrypoint.md`, which owns
   the private scope-bound Runtime access entrypoint and its direct Pure DI
   boundary. Read companion
   `decisions/0009-contained-turn-private-access-and-host-shutdown-boundary.md`
   for the ordinary caller handle, durable cancellation, identity separation,
   and Host-shutdown truth boundary.
2. `architecture/evidence-traceability.md` - canonical mapping from scoped
   observations to the smallest promoted architecture rules.
   Immediately after it, read
   `architecture/qualification-registry.json` - the fail-closed exact target
   registry for complete provider, provider-adapter, binary-closure, platform,
   credential-route, storage-topology, transport-topology, and failure-domain
   tuples, plus evidence hashes, limitations, and readiness links. Its schema is
   `architecture/qualification-registry.schema.json`.
3. `architecture/readiness.md` - current qualification register and the single
   owner of open implementation, production, and deployment gates.
4. `spikes/stage-a-profile-foundation-results.md` - adversarial Stage A
   foundation results, remaining partials, and implementation gates.
5. `spikes/stage-b-runtime-execution-results.md` - adversarial execution,
   OpenCode bootstrap, credential lifecycle, and combined recovery evidence.
6. `spikes/stage-c-provider-profile-and-opencode-operation-results.md` -
   provider/profile roundtrip, OpenCode operation, isolation, cancellation,
   recovery, and final-campaign evidence.
7. `spikes/opencode-hosting-e2e-results.md` - real OAuth plus deterministic
   OpenCode hosting conformance, counterexamples, and adapter contracts.
8. `spikes/linux-nonroot-containment-egress-results.md` - scoped non-root
   container/cgroup custody, resource limits, internal-network behavior, and
   same-network egress counterexample.
9. `spikes/opencode-container-tls-gateway-results.md` - immutable OpenCode
   container closure, cold-start dependency counterexamples, application TLS
   gateway, byte/time/redirect policy, and pinned-IP evidence.
10. `spikes/opencode-macos-conformance-results.md` - Apple Silicon process,
   APFS, state-bootstrap, recovery, and remaining containment evidence.
11. `spikes/macos-keychain-custody-results.md` - disposable file-backed
   Keychain mode, lock, backup-generation, concurrent-update, and custody
   boundary evidence.
12. `spikes/macos-codex-claude-cli-conformance-results.md` - scoped local
   real-login Codex and Claude binary-pair, instruction-isolation, stream,
   effect-verification, concurrency, and SIGINT evidence.
13. `spikes/macos-codex-app-server-conformance-results.md` - scoped stable
   JSONL-over-stdio handshake, schema, environment, instruction-source,
   concurrency, same-thread overlap, interrupt, and resume evidence.
14. `spikes/macos-codex-app-server-effects-results.md` - scoped successful
   and failed effect lifecycle, completed-request replay, output drain,
   explicit serialization, interrupt, and crash recovery evidence.
15. `spikes/macos-claude-agent-sdk-conformance-results.md` - scoped current
   TypeScript SDK isolation, environment, stream-drain, concurrent query,
   cwd-scoped resume, macOS sandbox, interrupt-queue, and abort evidence.
16. `spikes/macos-claude-session-store-conformance-results.md` - scoped
   current-SDK restore after local deletion, opaque-entry integrity
   counterexample, append retry, mirror failure, timeout, and capability
   evidence.
17. `spikes/macos-claude-tools-hooks-conformance-results.md` - scoped
   current-SDK synthetic in-process and stdio MCP, hook authorization,
   callback shadowing, containment, error, timeout, interrupt, environment,
   and cleanup evidence.
18. `spikes/macos-claude-mcp-failure-conformance-results.md` - scoped
   current-SDK retry duplication, idempotency-key reconciliation,
   crash-after-effect ambiguity, and detached-descendant evidence.
19. `spikes/macos-claude-subagent-parallel-results.md` - scoped
   programmatic-subagent, parallel-call, child authorization, parent-abort,
   and SessionStore-tree evidence with retained negative assertions.
20. `spikes/macos-claude-subagent-stdio-results.md` - scoped one-process
   sequential and two-process same-host external-stdio child delivery,
   overlap, assistant grouping, parent-abort, built-in child,
   duplicate-launch, and `subagent_type` roster-gate evidence.
21. `spikes/postgresql-concurrency-results.md` - accepted single-host and scoped
   two-physical-host command idempotency, link-loss, dispatch fencing,
   outbox/inbox, crash, and logical-restore evidence plus the remaining
   partition and HA gates.
22. `spikes/connect-replay-results.md` - accepted local Node HTTP/1.1 and HTTP/2
   timeout, explicit cursor replay, typed cursor-error, slow-consumer, and
   GOAWAY evidence plus external transport/SDK gates.
23. `spikes/stage-f-authority-lease-custody-results.md` - scoped PostgreSQL
   concurrency, unknown-response, authority cutoff, lease, effect, child
   custody, and terminal-receipt contract evidence.
24. `spikes/stage-g-profile-environment-contracts-results.md` - randomized
   source precedence, resource/instruction algebra, environment projection,
   immutable revision, and fail-closed classifier evidence.
25. `spikes/stage-h-version-skew-migration-results.md` - consumer-first event
   evolution, poison quarantine, inbox replay, retirement, binary-lease, and
   expand/backfill/contract migration evidence.
26. `spikes/stage-i-streaming-egress-results.md` - request/response budgets,
   post-header terminal classification, cancellation, backpressure, and
   concurrent streaming evidence.
27. `spikes/stage-j-storage-failure-recovery-results.md` - scoped ext4 ENOSPC,
   state/outbox atomicity, SIGKILL recovery, checksum-corruption detection,
   verified restore, and cleanup evidence.
28. `spikes/stage-d-cross-context-reconciliation-results.md` - collector,
   hosted ingestion, binding, and preparation consistency evidence.
29. `spikes/stage-e-security-time-and-idempotency-results.md` - secret
   separation, idempotency retention, and clock/expiry evidence.
30. `spikes/stage-k-capacity-fairness-results.md` - capacity idempotency,
   finite fairness, overload, reclaim fencing, authoritative time, restart,
   cleanup, and soak evidence.
31. `spikes/stage-l-postgres-failover-results.md` - streaming replication,
   quorum loss, external fencing, promotion, authority advance, rewind, and
   reparent evidence.
32. `spikes/stage-m-egress-policy-results.md` - signed egress authorization,
   dispatch-time revalidation, transport closure, monotonic time, and complete
   digest-preimage evidence.
33. `spikes/stage-n-binary-revision-results.md` - complete binary closure,
   compatibility, activation, assignment, rollback, retention, GC, replay,
   clock, and private-state evidence.
34. `spikes/sandbox-backend-hosting-qualification-results.md` - scoped hosted
   Docker, OpenSandbox, and Kubernetes Agent Sandbox density, lifecycle,
   recovery, isolation, and adapter-gap feasibility evidence.
35. `../experiments/sandbox-backend-hosting/README.md` - the retained disposable
   hosted harness; it is not production code or a backend selection.
36. `../experiments/rust-system-boundaries/README.md` - synthetic Rust Local
   Supervisor and Execution Guardian feasibility evidence, exact fail-closed
   scope, and platform limitations. This is not production qualification.
37. `spikes/rust-system-boundaries-production-gates.md` - proposed closed-world
   production qualification gates for platform custody, generation health,
   protocol compatibility, signing, provenance, and rollback.
38. `spikes/runtime-profile-behavior.md` - provider behavior evidence and
   historical hypotheses. It is not an implementation specification.
39. `../experiments/runtime-profile-behavior/README.md` - experiment status and
   the candidate behaviors known to be superseded or falsified.
40. `architecture/foundation-adoption.md` - executable Engineering Foundation
   capabilities, deferred applicability gates, maintainability budgets, and the
   reviewed bounded-context scaffolding workflow.
41. `spikes/runtime-setup-l0-dogfooding-evidence.md` - executable evidence for
   the product-owned Runtime Setup Pure DI baseline and fail-closed gates for
   any later module layer.
42. `spikes/opencode-acp-1-18-25-contract-validation.md` - synthetic official
   SDK and Host/OpenCode policy characterization, retained normalized OpenCode
   observation boundaries, and explicit production deferrals.

Document status vocabulary:

- `accepted`: canonical architecture unless superseded by a later ADR;
- `proposed`: not approved for implementation;
- `evidence reference`: observations are retained, but architecture conclusions
  may be superseded;
- `falsified`: a hypothesis contradicted by later evidence.

Production code must not use an evidence document as its architecture source
of truth. Accepted ADR-0001 through ADR-0010, excluding proposed ADR-0006 and
the unassigned ADR identities, plus the promoted-rule column of the
traceability matrix are normative for production architecture. ADR-0007
governs deterministic documentation changes.
Supporting architecture documents are accepted only as amended by the ADRs.
Readiness status is intentionally separate and cannot change domain ownership. A spike's
`Remaining gates` section is historical as of that campaign;
`architecture/readiness.md` is the current gate register.

Qualification lookup is fail closed. A target must match every dimension in
`architecture/qualification-registry.json` as one complete scalar tuple:
provider, provider adapter, binary closure, platform, credential route, storage
topology, transport topology, and failure domain. Arrays of independent values
are forbidden because their Cartesian product would invent unobserved targets.
An omitted tuple is `unqualified`; `provider-neutral` is an explicit value, not
a wildcard. `pnpm architecture:registry` verifies all traceability rows, target
shapes, duplicate/conflicting tuples, readiness links, evidence files, and
pinned SHA-256 identities. The same command accepts `--target-json
'<eight-dimension JSON object>'` for an exact whole-tuple lookup; an unmatched
target returns `unqualified`.
