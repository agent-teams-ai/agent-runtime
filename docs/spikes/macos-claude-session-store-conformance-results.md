# macOS Claude SessionStore conformance results

Status: accepted scoped evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Machine-readable summary:
`experiments/runtime-profile-behavior/fixtures/macos-claude-session-store-summary.json`

Summary SHA-256:

```text
2a41f68f1e8efd64e83771d0e5490a31e638fb564c7a6f449baea0b71b2116c4
```

## Scope and provenance

The campaign ran on macOS `15.6.1` Apple Silicon in fresh synthetic
workspaces. It used the user's existing Claude CLI authorization after
explicit approval and made real first-party Claude calls. It did not open a
user project or execute a real MCP server, hook, or plugin.

Credential values, account identifiers, session identifiers, raw provider
messages, and opaque transcript entries were not retained. Captured in-memory
store entries and every known local synthetic session were cleared during
cleanup.

The qualified closure was:

| Closure item | Qualified value |
| --- | --- |
| SDK | `@anthropic-ai/claude-agent-sdk@0.3.220` |
| npm integrity | `sha512-glc7SdwP...QXf1oA==` |
| bundled Claude Code | `2.1.220` |
| native executable SHA-256 | `8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081` |

`SessionStore` is an alpha API in this revision. `append()` and `load()` are
required. Session listing, summaries, deletion, and subkey listing are
optional capabilities with behavior-dependent consequences.

## Restore and placement

A session was created with an external in-memory store, its local transcript
was deleted, and the same session was resumed from the external store with the
exact remembered synthetic marker. The SDK called `append()` eight times and
`load()` three times in that scenario.

The same provider session ID still failed with `session_not_found` from a
different synthetic cwd. The external store does not remove cwd placement
semantics: its `projectKey` remains derived from encoded cwd, session ID, and
an optional subpath.

The SDK loads store entries before spawning the provider process. A configured
`300 ms` load timeout failed in `302 ms`, before init and without a provider
result. `continue` without listing support also failed before provider init.

## Integrity counterexample

The test store recursively replaced the original synthetic marker in loaded
opaque entries. The SDK accepted those modified entries and Claude returned
the tampered marker rather than the original.

This is expected from the documented opaque-entry contract, but it is a
security boundary for AR: provider restore success is not proof that a store
returned the authentic, complete, ordered transcript. The AR adapter must add
tenant and placement binding, authenticated integrity, schema/version binding,
ordering and completeness checks, encryption, retention, and audit evidence.

## Append retry and mirror failure

The store first persisted an append and then threw. The SDK retried, delivered
duplicate entry UUIDs, completed the business request exactly, and emitted no
final mirror error. Append is therefore at least once under an ambiguous
outcome; the adapter must deduplicate by entry UUID.

When every append failed:

- four append batches each received exactly three attempts;
- four `mirror_error` events were observed;
- the provider business result still completed exactly;
- the local transcript survived;
- the iterator did not fail.

The tested SDK writes locally first and mirrors externally. There is no atomic
local-plus-external transcript commit. Provider success after an exhausted
mirror failure is only local durability, not proof that another worker can
resume. AR must persist a typed degraded-durability or
`reconcile_required` state and must not advertise worker-move readiness until
the mirror is reconciled.

## Invalid combinations and capabilities

The following failed before provider init:

- `persistSession: false` with a `SessionStore`;
- file checkpointing with a `SessionStore`;
- `continue` without a listing capability.

Deletion is optional and is not performed automatically by the SDK.
`listSubkeys()` is needed to restore subagent transcripts. Retention,
crypto-erasure, and orphan cleanup therefore remain responsibilities of the
production adapter.

## Architecture consequences

- The alpha provider API stays behind a revision-pinned Agent Execution
  anti-corruption adapter.
- The public store port uses opaque provider entries but wraps them in
  AR-owned authenticated envelopes bound to tenant, runtime session, logical
  cwd/project key, provider and binary revision, credential generation, and
  execution generation.
- Append is idempotent by entry UUID and safe under persist-then-error replay.
  Ordering, monotonic completeness, and compare-and-set publication are
  explicit store contracts.
- Local persistence, external mirror publication, and multi-host resume
  readiness are separate states. A `mirror_error` is durable evidence, not
  ignorable telemetry.
- Load timeout, integrity failure, unavailable required capabilities, and
  invalid option combinations fail closed before provider dispatch.
- Session listing, subkey listing, deletion, retention, and restore are
  capability-negotiated. Unsupported capabilities never silently degrade.

These rules fit the accepted strict modular control plane plus separate
workers. Provider Access owns credential generation and key custody; Agent
Execution owns transcript placement, provider-store protocol, resume
eligibility, and reconciliation; the artifact/store implementation remains a
port rather than domain infrastructure.

## Evidence

Retained redacted bundle:

```text
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/reports/
  macos-claude-session-store-conformance-2026-07-28.tar.gz

SHA-256
2acfd825e913b45f5b680db05992e5f9312a450423520b89bef6d60d63d0153d
```

The bundle contains the final synthetic harness, redacted summary, exact npm
manifest and lock, and an inert workspace fixture. It excludes authorization
state, account data, raw provider streams, opaque transcript entries, session
identifiers, npm cache, installed dependencies, Git metadata, and real project
content.

## Remaining gates

This closes the tested SDK's local external-store semantics. It is not a
production SessionStore or multi-host `GO`.

The later
`docs/spikes/macos-claude-subagent-parallel-results.md` campaign confirms that
one store-backed resume loaded the main transcript plus both listed subagent
subpaths after local deletion. It does not close the production store or
subagent-tree soak gates below.

Still required:

- the production PostgreSQL/object-store implementation with authenticated
  envelopes, encryption, key rotation, tenant isolation, CAS, ordering,
  retention, deletion, backup, restore, and audit;
- real two-worker restore, worker death during load/append, network partition,
  partial object/database publication, replay, and reconciliation;
- production load/append budgets, backpressure, compaction, large-session and
  subagent-tree soak;
- upgrade and rollback compatibility across every supported SDK and Claude
  Code revision;
- dedicated test-account credential lifecycle and production key custody.

References:

- [Session storage](https://code.claude.com/docs/en/agent-sdk/session-storage);
- [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions);
- [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript);
- [Official TypeScript repository](https://github.com/anthropics/claude-agent-sdk-typescript).
