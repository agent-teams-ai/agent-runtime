# Agent Runtime architecture

Read documents in this order:

1. `decisions/0001-runtime-profile-and-activation-boundaries.md` - canonical
   accepted profile, security, access, and activation boundaries.
   Immediately after it, read
   `decisions/0002-architecture-reconciliation-tenancy-and-operator-recovery.md`
   - the reconciliation of the parallel foundation documents, hosted-tenancy
   vocabulary, owner-local recovery model, and phased operator controls.
2. `architecture/evidence-traceability.md` - canonical mapping from scoped
   observations to the smallest promoted architecture rules.
   Immediately after it, read
   `architecture/qualification-registry.json` - the fail-closed exact target
   registry for provider, binary closure, platform, credential route,
   transport, failure domain, evidence hashes, limitations, and readiness
   links. Its schema is
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
34. `spikes/runtime-profile-behavior.md` - provider behavior evidence and
   historical hypotheses. It is not an implementation specification.
35. `../experiments/runtime-profile-behavior/README.md` - experiment status and
   the candidate behaviors known to be superseded or falsified.

Document status vocabulary:

- `accepted`: canonical architecture unless superseded by a later ADR;
- `proposed`: not approved for implementation;
- `evidence reference`: observations are retained, but architecture conclusions
  may be superseded;
- `falsified`: a hypothesis contradicted by later evidence.

Production code must not use an evidence document as its architecture source
of truth. ADR-0001, ADR-0002, and the promoted-rule column of the traceability
matrix are normative. Supporting architecture documents are accepted only as
amended by the ADRs. Readiness status is intentionally separate and cannot
change domain ownership. A spike's `Remaining gates` section is historical as
of that campaign; `architecture/readiness.md` is the current gate register.

Qualification lookup is fail closed. A target must match every dimension in
`architecture/qualification-registry.json` exactly. An omitted combination is
`unqualified`; `provider-neutral` and `not-applicable` are explicit values, not
wildcards. `pnpm architecture:registry` verifies all traceability rows, target
shapes, readiness links, evidence files, and pinned SHA-256 identities. The
same command accepts `--target-json '<six-dimension JSON object>'` for an exact
lookup; an unmatched target returns `unqualified`.
