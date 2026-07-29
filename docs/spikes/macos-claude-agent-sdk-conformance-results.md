# macOS Claude Agent SDK conformance results

Status: accepted scoped evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Machine-readable summary:
`experiments/runtime-profile-behavior/fixtures/macos-claude-agent-sdk-summary.json`

Summary SHA-256:

```text
46a1fa81e2beb659a91f0d8cd600ae4e6221effd7d93edea559e3f0f1b0ea1e6
```

## Scope and provenance

The campaign ran on macOS `15.6.1` build `24G90`, Apple Silicon, in two new
synthetic Git repositories. It did not open or execute against a user project.

It used the user's existing Claude CLI authorization after explicit approval
and made real first-party Claude calls. No real MCP server, hook, plugin, or
user workspace was used. Credential values, account identifiers, session IDs,
raw provider messages, and rate-limit values were not inspected or retained.
The one synthetic persisted session was deleted through the SDK after the
resume checks.

The npm registry `latest` tag resolved to
`@anthropic-ai/claude-agent-sdk@0.3.220`, published on
`2026-07-24T23:11:19.727Z`. The exact package was installed in an isolated
scratch directory:

| Closure item | Qualified value |
| --- | --- |
| SDK npm integrity | `sha512-glc7SdwP...QXf1oA==` |
| bundled native package | `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.220` |
| bundled Claude Code | `2.1.220` |
| native executable SHA-256 | `8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081` |
| Node requirement | `>=18.0.0` |

The current type contract exposes `query()`, `persistSession`,
`settingSources`, `strictMcpConfig`, `spawnClaudeCodeProcess`, `SessionStore`,
`AbortController`, `Query.interrupt()`, and fail-closed sandbox selection.
The experimental V2 `createSession` API is absent from this version, matching
Anthropic's removal notice.

## Isolation and launch observations

- `settingSources: []`, `tools: []`, `disallowedTools: ["*"]`,
  `permissionMode: "dontAsk"`, empty explicit MCP/plugin inputs, and
  `strictMcpConfig: true` produced zero tools, zero MCP servers, zero plugins,
  no synthetic `CLAUDE.md` canary, and the exact business result.
- `settingSources: ["project"]` made the same synthetic `CLAUDE.md` canary
  observable. Workspace instructions are therefore a real opt-in input, not
  harmless metadata.
- `skills: []` did not make `system:init.skills` empty; the tested init still
  enumerated 16 entries. The tool surface was zero, so this is metadata
  exposure rather than proof those skills could execute.
- `allowedTools: []` alone exposed 29 tools in `system:init`.
  `allowedTools` controls auto-approval, not tool visibility. A locked-down
  adapter must also set the actual `tools`/`disallowedTools` surface.
- Omitting `env` passed the complete parent environment to the custom spawn
  boundary: the synthetic ambient canary was present among 77 keys. The
  harness observed only that canary and spawned Claude with a safe allowlist;
  no ambient values were sent to the model or retained.
- On this macOS login, the explicit allowlist needed `USER` in addition to
  `HOME`, `PATH`, locale, and temp variables. Omitting `USER` yielded a
  `success` result with zero model usage and then threw `Not logged in` while
  draining the iterator.

The last counterexample is protocol-significant: a consumer that resolves on
the first `result` message can report success before the SDK reports the
authentication failure. The iterator must be drained to completion and its
exception is part of terminal evidence.

## Execution, concurrency, and effects

- Two independent strict queries in separate synthetic workspaces overlapped
  in wall-clock time and returned their exact independent markers.
- Observed successful results accounted for two models in this campaign.
  Model usage remains data, not an assumed one-model-per-turn constant.
- With all tools hidden, a request to create a file returned provider
  `success`, but did not claim the exact completion marker and created no
  file. Provider success still means the response completed, not that the
  requested effect occurred.
- The SDK emitted unsolicited rate-limit events. Only event presence was
  retained; account and limit values remain tenant-private Provider Access
  data.

## Session placement

A synthetic session with a caller-provided ID persisted and resumed from the
same `cwd`, preserving the exact remembered token. Resuming the same ID from a
different synthetic `cwd` yielded `error_during_execution` followed by
`No conversation found`.

This matches Anthropic's documented storage layout under an encoded `cwd`.
The provider session ID identifies a transcript but does not locate or
authorize it. AR must bind:

```text
tenant + RuntimeSession + workspace grant + logical cwd +
credential generation + execution generation + transcript placement
```

A worker move or host restart must either restore the transcript at the same
logical path through a qualified `SessionStore`/artifact adapter or start a
new provider session from AR-owned state. Changing `cwd` is not a supported
resume transport.

## macOS sandbox observation

With one explicitly allowed Bash tool, sandbox
`failIfUnavailable: true`, no unsandboxed fallback, an empty strict network
allowlist, a writable synthetic workspace, one denied outside path, and one
synthetic credential env variable:

- the inside command observed the credential variable as absent;
- the allowed inside file was written;
- the denied outside file was not created;
- the query completed and no matching native Claude process remained.

This is a positive scoped filesystem and env-scrubbing result for one command.
It does not prove endpoint-specific network enforcement, arbitrary descendant
containment, or a production multi-tenant boundary.

## Interrupt and abort observations

The long-lived streaming query advertised
`interrupt_receipt_v1` and `interrupt_cancel_queued_v1`.

While a Bash turn was sleeping, the harness queued a second UUID-stamped user
message and called public `Query.interrupt()`:

- the receipt returned the second message in `still_queued`;
- the current turn ended as `error_during_execution`;
- the queued second message then executed and returned its exact result.

Public `Query.interrupt()` in the tested SDK takes no `cancel_queued` argument,
even though the underlying advertised protocol has a cancel-queued
capability. Therefore `interrupt current` and `stop everything` are distinct
AR operations. A Stop-All implementation cannot assume `interrupt()` empties
the queue.

In a separate run, `AbortController.abort()` during the same kind of Bash
sleep emitted no result, rejected the iterator as aborted, settled within ten
seconds, left the post-sleep proof file absent, and left no native process.
This proves bounded local cleanup for the sample, not provider-side
cancellation or billing reconciliation.

## Architecture consequences

- The Claude Agent SDK remains a dedicated anti-corruption adapter behind the
  Agent Execution port. Its adapter state machine does not terminally accept
  an operation until the stream is fully drained or fails.
- The strict launch closure explicitly sets tool visibility, approval policy,
  MCP/plugin inputs, instruction sources, persistence mode, environment, cwd,
  credential binding, binary revision, sandbox policy, and budgets.
- Environment inheritance is default-deny. Local macOS login import may
  include the non-secret `USER` key, but hosted credentials are injected
  through Provider Access rather than inherited from a worker environment.
- `StopCurrent`, `CancelQueued`, `StopAll`, and process/host termination have
  separate commands and receipts. A queued item surviving interruption stays
  durable and visible until explicitly cancelled or executed.
- Resume authorization and transcript placement are separate checks. The same
  logical cwd is part of the provider adapter's placement key; it is not an
  authority credential.
- Provider `success`, prose, exit, sandbox completion, and local cancellation
  are observations. AR-owned business/effect and cancellation receipts remain
  authoritative.
- Init, rate-limit, and usage payloads use allowlist tenant-private
  projections. Raw provider metadata is not general telemetry.

These rules fit the accepted strict modular control plane plus separate
workers. Runtime Configuration owns requested instruction/tool policy,
Runtime Security authorizes the exact closure, Provider Access owns
credential and usage facts, and Agent Execution owns stream, queue, sandbox,
session placement, cancellation, and effect reconciliation.

## Evidence

Retained redacted bundle:

```text
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/reports/
  macos-claude-agent-sdk-conformance-2026-07-28.tar.gz

SHA-256
2d99f1ab46be283e6fadaf0d84f883df9a1e9582de6b59ad890f298577d34450
```

The bundle contains the final harness, redacted summary, exact npm manifest
and lock, and synthetic workspace fixtures. It excludes auth state, account
data, raw provider streams, session IDs/transcripts, stderr, npm cache,
`node_modules`, Git metadata, and preliminary probes.

## Remaining gates

This closes scoped local macOS Claude Agent SDK semantics for the tested
version. It is not a production Claude adapter `GO`.

The later
`docs/spikes/macos-claude-session-store-conformance-results.md` follow-up
closes the tested SDK's local external-store restore, cwd placement, opaque
entry, append-retry, exhausted-mirror, timeout, and capability semantics.
The later
`docs/spikes/macos-claude-tools-hooks-conformance-results.md` follow-up closes
the tested SDK's scoped synthetic in-process and stdio MCP, hook
authorization, callback shadowing, error, timeout, interrupt, environment,
and cleanup semantics.
The later
`docs/spikes/macos-claude-subagent-parallel-results.md` follow-up records
programmatic child lineage, a parallel shared in-process MCP delivery
counterexample, child authorization, parent-abort late effect, and
SessionStore subagent-tree restore behavior.

Still required:

- dedicated non-user test accounts, credential refresh/revocation generation
  CAS, and production `KeyProvider` custody;
- provider-side cancellation acknowledgement and billable-work
  reconciliation;
- a production authenticated `SessionStore` implementation and two-worker,
  partition, partial-publication, reconciliation, retention, and soak
  conformance;
- long-duration stream, queue, backpressure, restart, and crash soak;
- production isolated MCP/tool/hook hosting, remote transport, ambiguous
  effect, replay, malformed-frame, and soak conformance;
- macOS endpoint-specific egress and continuous descendant containment;
- upgrade, rollback, native-helper closure, and schema/type compatibility
  policy across every supported SDK and Claude Code revision.

References:

- [Claude Agent SDK TypeScript
  reference](https://code.claude.com/docs/en/agent-sdk/typescript);
- [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode);
- [Sessions and cwd
  placement](https://code.claude.com/docs/en/agent-sdk/sessions);
- [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions);
- [Hosting](https://code.claude.com/docs/en/agent-sdk/hosting);
- [Secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment);
- [Official TypeScript repository](https://github.com/anthropics/claude-agent-sdk-typescript).
