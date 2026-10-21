---
type: feature
status: accepted
owner: "@agent-teams/agent-execution"
owner_document: ADR-0005
---

# Interactive agent session

ADR-0091 admits this separate technical session owner. It persists scoped input
admission before one provider handoff, correlates output and independent replies,
fences targeted cancellation, and retains uncertainty and cleanup debt. It does
not own teams, tasks, business completion or provider authentication.

The factory in package `./composition` fixes dependencies and scope. Its session
API is separate from trusted Host scheduling controls. `pumpOutput` reads one
bounded step; the Host owns scheduling. No per-turn lock blocks interaction
replies. The PostgreSQL adapter borrows its pool; migration and verification are
explicit. Borrowed clients must provide `on('error', listener)` and matching
`removeListener` forwarding to the underlying checked-out native client; a
query/release-only wrapper is rejected before SQL. The store owns a nonthrowing
listener through query completion and release, discards interrupted clients and
retains unknown COMMIT outcomes. `release` must return only after transferring
custody to the pool's idle handler or destroying the client; a throwing release
retains its error guard because transfer remains unproved. The Host still owns
idle-pool error handling and closing its pool. The additive `interactive_session_v1` namespace never migrates frozen
contained-turn state. Unknown COMMIT/handoff/control is held for reconciliation,
not retried as an external effect. Checkpoint bytes remain with trusted Host
storage; only its selected reference enters this owner record.

Provider implementations consume the single erased, type-only
`@agent-teams/agent-execution/interactive-contracts` SPI. Provider configuration
and SDK/native identities remain outside this feature. A successful submit only
means SDK consumption, with provider acceptance unknown. Missing attribution and
usage remain absent. Output limits stop this session and reserve one diagnostic
record; history is not trimmed and the cursor remains monotonic across restore.

Deterministic feature tests are in `tests/features/interactive-agent-session`.
The explicit PostgreSQL test requires an owned `TEST-interactive-pg.*` cluster
and restarts that disposable cluster. This is synthetic durability evidence;
real provider and production Host qualifications remain separate gates.
