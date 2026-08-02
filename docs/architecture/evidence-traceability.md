# Architecture evidence traceability

Status: canonical companion to ADR-0001

This document is the single map from scoped spike evidence to promoted
architecture rules. Exact versions, counts, hashes, timings, negative
assertions, and cleanup evidence remain in the linked spike documents.
Exact target dimensions and pinned report/summary hashes are enforced by
`qualification-registry.json`. A target absent from that registry is
unqualified.

Only the `Promoted architecture rule` column is normative. An observation does
not qualify another provider, binary revision, platform, transport, credential
route, or failure domain.

| Evidence | Observed scope | Promoted architecture rule |
| --- | --- | --- |
| `spikes/stage-a-profile-foundation-results.md` | profile algebra, passive collection, hostile inputs, review freshness | Profile source capture is passive and authorized; `ProfileRevision` is immutable, non-secret, provider-bound, and separate from grants, credentials, routes, capacity, and execution. |
| `spikes/stage-b-runtime-execution-results.md` | activation crash points, revocation, fencing, bootstrap, credential lifecycle | Activation is a durable process manager; external effects occur after intent commit; stale generations are fenced; ambiguous acceptance enters reconciliation. |
| `spikes/stage-c-provider-profile-and-opencode-operation-results.md` | exact frozen-source provider/profile roundtrip and same-host OpenCode operation seam, including signed post-final invalidation | Provider materialization is attested and host-bound; operation identity, authorization, provider identity, receipts, barriers, and cleanup are independently verified. |
| `spikes/stage-d-cross-context-reconciliation-results.md` | collector, hosted ingestion, binding, and preparation consistency | Cross-context activation is a durable process, not a shared transaction; immutable artifacts publish only after complete validation and owner revisions are revalidated before dispatch. |
| `spikes/stage-e-security-time-and-idempotency-results.md` | secret separation, time/expiry, and idempotency | Secret values remain outside profiles and events; authority uses explicit expiry and owner revisions; command identity and semantic fingerprint fail closed on conflict. |
| `spikes/opencode-hosting-e2e-results.md` | scoped OpenCode ACP/OAuth, concurrency, cancellation, crash, resume, tools | OpenCode prompts serialize per provider session; AR authorizes every operation; provider acceptance and output drain are separate; hidden provider calls and ambient configuration are budgeted or disabled. |
| `spikes/linux-nonroot-containment-egress-results.md` | scoped Linux non-root container/cgroup and same-network counterexample | A trusted supervisor owns the complete Linux containment boundary; provider network attachment is not authorization; signed gateway policy controls egress. |
| `spikes/opencode-container-tls-gateway-results.md` | immutable OpenCode container and synthetic TLS gateway | `BinaryRevision` includes helper binaries, image, config layout, and prepared dependencies; gateway authorization binds exact route, DNS/IP, TLS, redirect, byte, and time policy. |
| `spikes/opencode-macos-conformance-results.md` | scoped Apple Silicon process, APFS, state, storage, sandbox, binary pairs | Platform containment is adapter-specific; macOS process group and App Sandbox alone are insufficient; state-family recovery and binary/helper identity are explicit. |
| `spikes/macos-keychain-custody-results.md` | disposable synthetic file-backed Keychain and signed helper probes | Key storage is a `KeyProvider` adapter; Provider Access owns credential generation and CAS; deprecated file-keychain behavior is not production custody. |
| `spikes/macos-codex-claude-cli-conformance-results.md` | scoped local CLI instruction, environment, stream, effect, SIGINT behavior | Codex and Claude use separate anti-corruption adapters; instruction inheritance and environment are explicit; provider output claims are not effect receipts. |
| `spikes/macos-codex-app-server-conformance-results.md` | scoped stable stdio, same-thread overlap, interrupt, resume, schema | Codex same-thread operations serialize; resume is reauthorized; ambient environment is default-deny; broad App Server methods stay outside the runtime operation port. |
| `spikes/macos-codex-app-server-effects-results.md` | scoped effect lifecycle, replay, drain, interrupt, crash recovery | Provider request IDs are not idempotency keys; command ledger and effect receipts are AR-owned; terminal publication waits for output drain. |
| `spikes/macos-claude-agent-sdk-conformance-results.md` | scoped SDK environment, tools, stream drain, queue, resume placement, sandbox, abort | Claude adapter replaces ambient environment explicitly, drains the full stream, distinguishes queued/current cancellation, and binds resume to authorized logical placement. |
| `spikes/macos-claude-session-store-conformance-results.md` | scoped external store restore, tamper, append retry, mirror, timeout, capabilities | Provider transcript entries require authenticated AR envelopes, idempotent append, ordering/completeness, capability negotiation, and separate local/mirror/multi-host readiness states. |
| `spikes/macos-claude-tools-hooks-conformance-results.md` | scoped hook authorization, callback shadowing, in-process and stdio tools | Runtime Security exposes provider-neutral invocation authorization; adapters map their last safe pre-dispatch hook; effectful handlers execute outside the control plane. |
| `spikes/macos-claude-mcp-failure-conformance-results.md` | scoped retry duplication, crash-after-effect, detached descendant | Every effect has an AR command identity and durable effect ledger; process/transport failure does not prove rollback or descendant stop. |
| `spikes/macos-claude-subagent-parallel-results.md` | scoped child lineage, authorization, in-process delivery counterexample, abort, store tree | Every child is an AR operation; child authorization, admission, cancellation, terminal reconciliation, and transcript subpaths are explicit. |
| `spikes/macos-claude-subagent-stdio-results.md` | scoped one-process sequential delivery, two-process same-host overlap, roster gate, direct stdio abort | Provider agent definitions and call grouping are not authority or concurrency controls; adapters normalize child type, while Security authorizes and Execution admits against budget/capacity. |
| `spikes/postgresql-concurrency-results.md` | scoped PostgreSQL concurrency, crash, restore, and two-physical-host client link loss | Context state and outbox commit atomically; inbox/command handling is idempotent; sequence allocation, fences, unknown commit outcome, and server identity are durable. |
| `spikes/connect-replay-results.md` | scoped local HTTP/1.1 and HTTP/2 timeout, cursor replay, slow consumer, cleanup | SDK replay uses durable opaque cursors and at-least-once dedupe; transport timeout grants no retry authority; application queue/byte budgets and handle cleanup are explicit. |
| `spikes/stage-f-authority-lease-custody-results.md` | single-host PostgreSQL races and client kill-after-commit across launch, admission, capacity, effect, custody, and receipt contracts | Executable launch, dispatch, renewal, effect, and custody claims require separate fenced CAS transitions; unknown response grants no duplicate authority; capacity allocation cannot create a successor generation. |
| `spikes/stage-g-profile-environment-contracts-results.md` | deterministic synthetic fuzzing of source, instruction, environment, immutable revision, and classifier contracts | Runtime Configuration owns source order; composition is typed and deterministic; target collisions and stale value identity fail closed; activation uses a resolved immutable revision. |
| `spikes/stage-h-version-skew-migration-results.md` | single-host PostgreSQL consumer-version, inbox, poison, retirement, binary-lease, and migration-claim contracts | Events evolve consumer-first and additively; unsupported versions quarantine explicitly; destructive schema contract waits for backfill, old-binary retirement, and a single durable migration claim. |
| `spikes/stage-i-streaming-egress-results.md` | synthetic loopback HTTP/1 budgets, post-header failures, cancellation, backpressure, and concurrent streams | Requests requiring no partial upstream effect are bounded before dispatch; after headers, typed receipts and drain barriers, not HTTP status, determine terminal truth; terminal decisions precede abort side effects. |
| `spikes/stage-j-storage-failure-recovery-results.md` | dedicated loopback ext4 ENOSPC, PostgreSQL SIGKILL, offline corruption, and same-host restore | Storage health gates admission; state and outbox remain atomic on storage failure; emergency reserve is recovery-only; backup qualification requires restore, semantic comparison, and integrity checks. |
| `spikes/stage-k-capacity-fairness-results.md` | hosted single-host PostgreSQL capacity, idempotency, fairness, overload, reclaim, time, restart, and soak | Capacity remains an Agent Execution port; claim/quota/output/reclaim commands are independently idempotent; quota shrink is non-preemptive; reclaim acknowledgement precedes successor fencing; caller time is not authority; fairness claims state their finite assumptions. |
| `spikes/stage-l-postgres-failover-results.md` | synthetic same-host three-node PostgreSQL streaming, quorum loss, promotion, rewind, and reparent | Replication is not authority. Promotion requires external fencing of the old writer and client route; unknown synchronous commit is reconciled by exact replay; durable authority advances before new writes; stale output remains fenced. |
| `spikes/stage-m-egress-policy-results.md` | hosted synthetic loopback signed policy, HTTP/1.1/HTTP/2 dispatch, transport closure, time, and digest-oracle campaigns | Runtime Security owns exact egress authorization; the gateway revalidates route, address, TLS, peer, redirect, generation and time at dispatch before bytes; revoked or failed-close transports cannot be reused; the gateway is an adapter, not a context. |
| `spikes/stage-n-binary-revision-results.md` | hosted deterministic complete binary closure, compatibility, activation, assignment, rollback, retention, GC, replay, clock, and encapsulation | `BinaryRevision` identifies the complete immutable executable closure; Host Custody owns mutable head/assignment/lifecycle roots; sessions pin closure IDs; terminal replay cannot resurrect authority; mutable lifecycle is not a new bounded context. |

## Non-promoted feasibility evidence

The Rust system-boundary campaign is intentionally outside the promoted-rule
table and qualification registry. Its
[`main@aa76858` evidence record](../../experiments/rust-system-boundaries/evidence/main-aa76858-evidence.json)
and [experiment report](../../experiments/rust-system-boundaries/README.md)
prove scoped technical feasibility for a Rust Local Supervisor and Execution
Guardian. They do not qualify a production target, promote a new domain owner,
or close any gate in
[`rust-system-boundaries-production-gates.md`](../spikes/rust-system-boundaries-production-gates.md).

This separation is deliberate: adding the campaign to the normative table
would require an exact qualification-registry target and would incorrectly
turn feasibility evidence into an architecture or production claim.

## Promotion discipline

- Spike status never changes a domain owner implicitly.
- Provider vocabulary stays in its anti-corruption adapter.
- A negative assertion remains visible and cannot be rewritten as a pass.
- A later campaign may narrow or supersede a promoted rule only through an ADR
  change that names the prior evidence.
- Readiness and remaining gates live only in
  `docs/architecture/readiness.md`; they are not duplicated here.
- A spike's own `Remaining gates` section is the immutable campaign-date
  snapshot. The readiness register is the current cross-campaign status.
