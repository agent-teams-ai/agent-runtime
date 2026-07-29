# macOS Claude subagent and parallel-call results

Status: accepted scoped negative evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Machine-readable summary:
`experiments/runtime-profile-behavior/fixtures/macos-claude-subagent-parallel-summary.json`

Summary SHA-256:

```text
b2d25c8ec4f0d1ae319204d1c6f5b1877504973b66e7ec3e8bcb8087c0037929
```

## Scope and method

One frozen campaign ran `@anthropic-ai/claude-agent-sdk` `0.3.220` with its
bundled Claude Code `2.1.220` on macOS `15.6.1` arm64. It used programmatic
`agents`, the `Agent` tool, an in-process synthetic SDK MCP server, hooks,
`canUseTool`, `AbortController`, and `InMemorySessionStore`.

The campaign used the existing authorized Claude login and made real
first-party provider calls. It opened only a new synthetic workspace, loaded
no filesystem settings, and used no real MCP server or user project.
Credential values, provider messages, transcript content, and provider
session, agent, and tool-use IDs were not retained.

The exact closure was:

| Component | Revision |
| --- | --- |
| Agent SDK | `0.3.220` |
| bundled Claude Code | `2.1.220` |
| native package | `0.3.220` |
| native binary SHA-256 | `8addc857...e081` |
| SDK type surface SHA-256 | `b415fbff...a836` |

The frozen campaign was not repeated after negative assertions. The findings
below describe this run only.

## Parallel sibling observation

The prompt required two `Agent` calls in one assistant turn. The retained
projection proves two calls and two child lineages, but it does not retain
assistant-message grouping. The stream showed:

- two distinct subagent starts with types `alpha` and `beta`;
- two `Agent` tool uses;
- two child MCP tool-use blocks;
- two distinct non-null `parent_tool_use_id` values;
- three `result:success` messages across the forwarded child and parent
  stream;
- the exact parent completion marker.

However, for those two sibling calls:

- the shared in-process MCP handler was invoked zero times;
- `PreToolUse`, `PostToolUse`, `PostToolBatch`, and `canUseTool` recorded zero
  child calls;
- no synthetic effect was created;
- no `SubagentStop` hook was observed.

The retained projection does not identify why the child tool-use blocks did
not reach the handler. It does not prove that every in-process MCP server or
every parallel-subagent topology fails this way.

It does reject treating forwarded tool-use blocks or a parent success marker
as proof that child effects executed.

## Child authorization observation

A separate single child attempted one synthetic effect. The run observed:

- `SubagentStart` and `SubagentStop` with the same child identity;
- both `PreToolUse` and the permission callback;
- a non-null child `agent_id` in both `PreToolUse` and `canUseTool`;
- one `canUseTool` deny decision;
- zero handler calls and no effect;
- one child `PostToolBatch`;
- a successful exact parent marker.

Neither a `permission_denied` stream message nor a `PermissionDenied` hook was
observed for this callback denial. The deny still failed closed.

An AR authorization ledger must therefore record its own decision and child
binding at the gate. Provider denial notifications are optional observations,
not the audit source of truth.

## Parent abort observation

A single child entered the synthetic in-process MCP handler and wrote a
`STARTED` marker. The parent then aborted:

- the SDK iterator rejected as aborted and settled within ten seconds;
- no provider result message was emitted;
- no `SubagentStop`, `PostToolUse`, `PostToolUseFailure`, or child
  `PostToolBatch` hook was observed;
- the already-running handler later wrote its delayed `FINISHED` effect;
- no matching native process remained after the campaign.

Parent query abort is therefore not cancellation of an already-running
in-process child handler. Effectful handlers cannot run in the modular control
plane. A worker/tool host needs its own cancellation fence, command ledger,
and effect receipt.

## SessionStore subagent-tree observation

The same parallel run mirrored:

- fourteen main-transcript append calls;
- eight subagent append calls;
- exactly two distinct `subagents/agent-{id}` subpaths.

Both subagents were listed through `listSubkeys()` and each had stored
messages. After deleting the first local transcript, resume loaded the main
key and both subagent subpaths, then completed the exact resume marker.

This confirms that `listSubkeys()` and subpath-scoped load are required for a
complete subagent-tree move. Loading only the main transcript is incomplete.

The second local delete returned an SDK error after store-backed resume. The
campaign later removed the exact synthetic project directory during cleanup;
it does not establish the reason for that delete result.

## Architecture consequences

- Every child is an AR-owned child operation with its own `ChildOperationId`,
  parent operation binding, authorization digest, budget, cancellation state,
  and terminal/effect reconciliation. Provider `agent_id` remains correlation
  data.
- A forwarded child tool-use block, `Agent` tool result, parent marker,
  `SubagentStop`, or provider result is not an effect receipt.
- Consumers drain the complete stream and route child messages by
  `parent_tool_use_id`; one query may emit multiple success result messages.
- Runtime Security records child authorization decisions independently.
  Missing provider denial events do not erase the decision.
- Parent cancellation fans out to child-operation fences and tool-host
  commands. It does not infer that an in-process handler stopped.
- Production effectful tools run in isolated workers or tool hosts, never
  inside the modular control plane.
- SessionStore publication and recovery include every authenticated subagent
  subpath. Main-only publication cannot claim multi-host resumability.
- Parallel-subagent support remains disabled for a provider/tool-host
  topology until a revision-pinned conformance test proves handler delivery,
  authorization, effects, cancellation, and terminal reconciliation for that
  exact topology.

These findings refine Agent Execution, Runtime Security, and tool-host adapter
contracts without moving bounded-context ownership or requiring physical
microservices.

## Evidence

Retained redacted bundle:

```text
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/reports/
  macos-claude-subagent-parallel-conformance-2026-07-28.tar.gz

SHA-256
2e55a3143e5ed3117d02087ac36606ea3550cb04c0534d2d74f866eee6f278f1
```

The bundle contains the frozen harness, allowlisted summary, exact npm
manifest and lock, and inert workspace seed. It excludes auth, raw provider
traffic, provider identifiers, transcript content, runtime state, and raw
effect files.

## Remaining gates

This closes one scoped local programmatic-subagent, child authorization,
parent-abort, and SessionStore-tree campaign. It is not a production
subagent/tool-host `GO`.

The later
`docs/spikes/macos-claude-subagent-stdio-results.md` campaign proves scoped
external-stdio child effect delivery, dual-process background overlap, and
direct-process abort while preserving single-host serialization, assistant
grouping, unexpected built-in child, repeated allowed launch, and roster-gate
counterexamples.

Still required:

- production bounded concurrency, backpressure, duplicate-launch control,
  authorization, effect receipts, and terminal reconciliation;
- hook-host crash/replay and parked-approval timeout behavior;
- remote HTTP MCP TLS, OAuth, redirect, DNS, private-address, proxy, and
  streaming behavior;
- production command-ledger and SessionStore behavior under worker/database
  crash, link loss, partition, failover, and concurrent duplicate dispatch;
- long-duration subagent-tree, queue, backpressure, and restart soak;
- dedicated non-user credentials, production key custody, and
  revision-by-revision upgrade/rollback qualification.
