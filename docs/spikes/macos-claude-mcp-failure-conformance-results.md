# macOS Claude MCP failure conformance results

Status: accepted scoped evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Machine-readable summary:
`experiments/runtime-profile-behavior/fixtures/macos-claude-mcp-failure-summary.json`

Summary SHA-256:

```text
a21ad5a36810b22d47bf97bda043e265614c05dd12c3710726f652150a4e1b73
```

## Scope and provenance

The campaign ran on macOS `15.6.1` Apple Silicon in a fresh synthetic
workspace. It used the user's existing Claude CLI authorization after explicit
approval and made real first-party Claude calls. It did not open a user project
or load a real user MCP server, hook, plugin, setting, or instruction file.

The exact closure remained Claude Agent SDK `0.3.220`, bundled Claude Code
`2.1.220`, Anthropic SDK `0.115.0`, MCP SDK `1.30.0`, and Zod `4.4.3`.
Credential values, account identifiers, provider session identifiers, and raw
provider messages were not retained.

## Retry and idempotency

The synthetic non-idempotent tool committed an effect and returned an MCP error
on its first call. Claude then performed the explicitly requested retry with
the same operation key:

- two tool calls had distinct provider tool-use IDs;
- both carried the same operation key;
- the first fired `PostToolUseFailure` and the second `PostToolUse`;
- the side effect was recorded twice;
- the overall provider query returned exact `success`.

The equivalent idempotent tool used the same operation key as a command-ledger
key. It observed the same two calls and one-error/one-success sequence but
recorded exactly one effect.

A provider tool-use ID is correlation evidence for one attempt, not a durable
business-command identity. AR must generate and bind a stable invocation key
before dispatch. Every retry of the same semantic operation reuses that key.

## Crash after effect, before result

Another stdio tool recorded its effect and immediately exited with code `70`
before returning an MCP result:

- the effect existed exactly once;
- `PostToolUseFailure` fired with a duration and
  `is_interrupt=false`;
- `PostToolUse` did not fire;
- the MCP server process was gone;
- Claude still returned the exact requested provider `success`.

The failure callback proves result-channel failure, not absence or rollback of
the effect. A retry is an unknown-outcome reconciliation until the sidecar's
durable command ledger reports whether the operation committed.

## Detached descendant counterexample

The stdio tool intentionally spawned one detached synthetic child and then
waited. Aborting the query:

- settled the SDK iterator within ten seconds;
- terminated the MCP server;
- left the exact identified descendant alive;
- allowed that descendant to create its delayed effect after the abort.

The descendant PID and command were verified before the harness terminated it.
No matching process remained afterward.

SDK process cleanup is not descendant containment. The worker process runner
must own an OS-level process group, session, cgroup, job, or equivalent
platform boundary and verify the complete tree after stop. A parent exit or
closed stdio pipe is insufficient evidence.

## Architecture consequences

- `RuntimeOperation` owns an AR-generated idempotency key independent from the
  provider tool-use ID. `PreToolUse` replaces any model-supplied value with the
  authorized key before the sidecar sees the input.
- The effectful tool host persists claim, semantic fingerprint, fence,
  committed effect, and result publication in a durable command ledger.
  Duplicate attempts reconcile by key and cannot repeat a committed effect.
- `PostToolUseFailure`, MCP disconnect, timeout, abort, provider result, and
  process exit are observations. None proves whether an effect committed.
- Unknown outcomes enter `reconcile_required`; they are not blindly retried
  under a new tool-use ID.
- Agent Execution owns descendant custody and a verified stop receipt. The
  Claude SDK's stdio child cleanup is only one input to that receipt.
- Tool-host outbox/inbox and effect receipts follow the same versioned,
  idempotent contracts already accepted for bounded-context extraction.

These facts reinforce the strict modular control plane plus separate workers:
the control plane records authority and orchestration state, while effectful
MCP code, its ledger, and its OS process tree remain inside an isolated worker
boundary.

## Evidence

Retained redacted bundle:

```text
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/reports/
  macos-claude-mcp-failure-conformance-2026-07-28.tar.gz

SHA-256
1d4b6f3443ef9caf1eb80ad07099d1ed108be87de7eb9da89e0c61502d3f36e9
```

The bundle contains the final harness, synthetic stdio MCP server, redacted
summary, exact package manifest and lock, and inert workspace fixture. It
excludes authorization state, account data, raw provider messages, session
identifiers, raw effect files, npm cache, installed dependencies, and Git
metadata.

## Remaining gates

This closes the current SDK's scoped synthetic retry, ambiguous-effect, crash,
and detached-descendant behavior. It is not a production tool-host `GO`.

The later
`docs/spikes/macos-claude-subagent-parallel-results.md` campaign adds scoped
programmatic-child lineage, child authorization, shared in-process parallel
delivery, parent-abort, and SessionStore-tree observations.
The later
`docs/spikes/macos-claude-subagent-stdio-results.md` campaign adds scoped
one-process sequential and two-process same-host external-stdio delivery,
background overlap, and direct-abort observations plus retained
assistant-grouping, built-in-child, duplicate-launch, and roster-gate
counterexamples.

Still required:

- production command-ledger/outbox implementation under real database and
  worker crashes, reconnects, partitions, failover, and concurrent duplicate
  dispatch;
- production macOS process-tree containment and continuous verification for
  non-detached and adversarial descendants;
- remote HTTP MCP and OAuth/TLS/egress behavior;
- malformed/flooded frames, oversized payloads, stderr pressure, startup and
  reconnect failure, production bounded concurrency and backpressure,
  duplicate-launch control, and long-duration soak;
- dedicated non-user test accounts, production key custody, and
  revision-by-revision upgrade/rollback qualification.

References:

- [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools);
- [Hooks](https://code.claude.com/docs/en/agent-sdk/hooks);
- [MCP](https://code.claude.com/docs/en/agent-sdk/mcp);
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
