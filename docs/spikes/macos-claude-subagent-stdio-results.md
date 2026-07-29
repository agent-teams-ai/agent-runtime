# macOS Claude subagent stdio and roster results

Status: accepted scoped negative evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Machine-readable summaries:

- `experiments/runtime-profile-behavior/fixtures/macos-claude-subagent-stdio-summary.json`
- `experiments/runtime-profile-behavior/fixtures/macos-claude-subagent-roster-summary.json`
- `experiments/runtime-profile-behavior/fixtures/macos-claude-subagent-dual-stdio-summary.json`

Summary SHA-256:

```text
stdio
3a58b6f963bc7fc5a2ba9d82e4e9a22d1470d276f89c3b74884d7860ed52b462

roster
f65e12d0a82ca811aa9971535ffadfef52e52fee3d0547868632df30f50cb607

two stdio processes on one host
2d12330c5af74c1bda1aad8a36381a89cab2bf15890e1eac1b7182c7dca8b16f
```

## Scope and method

Three distinct frozen campaigns ran `@anthropic-ai/claude-agent-sdk` `0.3.220`
with bundled Claude Code `2.1.220` on macOS `15.6.1` arm64. The stdio campaign
used `@modelcontextprotocol/sdk` `1.30.0`, two programmatic child definitions,
one synthetic external stdio MCP server, hooks, `canUseTool`, and
`AbortController`. The roster campaign separately configured only an `alpha`
programmatic child and gated `Agent` calls in `PreToolUse`.
The two-process same-host campaign separately assigned `alpha` and `beta` to
two synthetic stdio MCP server processes on the same Mac and retained
assistant-message grouping plus tool call overlap.

Both campaigns used the existing authorized Claude login and made real
first-party provider calls. They opened only new synthetic workspaces, loaded
no filesystem settings, and used no real MCP server or user project.
Credential values, provider messages, transcript content, and provider
session, agent, tool-use, and process IDs were not retained.

The exact closure was:

| Component | Revision |
| --- | --- |
| Agent SDK | `0.3.220` |
| bundled Claude Code | `2.1.220` |
| native package | `0.3.220` |
| MCP SDK | `1.30.0` |
| Zod | `4.4.3` |
| native binary SHA-256 | `8addc857...e081` |
| SDK type surface SHA-256 | `b415fbff...a836` |
| external server SHA-256 | `2f10aeca...5aa` |

Each campaign ran once. Negative assertions were retained and no campaign was
rerun.

## External stdio sibling observation

The parent prompt requested one `alpha` and one `beta` `Agent` call in the same
assistant turn. The retained projection does not preserve assistant-message
grouping. It observed:

- three child starts and stops with types `alpha`, `beta`, and
  `general-purpose`;
- three `Agent` tool uses and three distinct non-null
  `parent_tool_use_id` values;
- two child MCP calls, for `alpha` and `beta`;
- two child `PreToolUse`, `PostToolUse`, `PostToolBatch`, and permission
  observations with non-null child identities;
- two completed effects in one external stdio server process;
- three success result messages and the exact parent completion marker.

The two MCP calls used the same synthetic operation key. Both reached the
server and both effects were written. The SDK and stdio transport did not
deduplicate that key.

The two 1.2-second server calls did not overlap. They ran through one server
process and completed sequentially. This run therefore proves external stdio
delivery for both children, but it does not prove concurrent sibling handler
execution.

The configured programmatic definitions contained only `alpha` and `beta`,
yet a third built-in `general-purpose` child started and stopped. The
programmatic `agents` object was not an enforcement roster in this run.

## Two-process same-host overlap observation

A separate campaign allowed only `alpha` and `beta`, assigned each child its
own stdio server process, requested `run_in_background=true`, and used
four-second handlers.

The retained projection observed:

- one `alpha` and one `beta` request, start, handler call, handler completion,
  and effect;
- two distinct stdio server processes;
- two child `PreToolUse` and two `PostToolUse` observations with non-null
  child identities;
- overlapping handler windows;
- three success result messages and the exact parent completion marker;
- zero `SubagentStop` observations and no matching process leak.

Both `Agent` tool inputs carried `run_in_background=true`, but the provider
emitted them in two separate assistant messages. The maximum `Agent` count in
one assistant message was one despite the prompt explicitly requesting both
calls in one message.

The frozen `bothCallsRequestedBackground` assertion is false because its
predicate also required both calls to share one message. The retained input
projection independently shows `runInBackground: true` for each call. This
assertion-shape limitation is preserved rather than rewritten after the run.

Together with the single-host campaign, this proves that the tested revision
can overlap background child handlers across two stdio server processes while
the one-server pair in the other frozen run executed sequentially. It does not
establish a universal per-process concurrency rule.

## External stdio parent-abort observation

A separate `slow` child entered a six-second stdio handler. After its
`STARTED` effect:

- the parent iterator rejected as aborted and settled within ten seconds;
- the stdio server process stopped without harness-forced cleanup;
- the handler emitted no end record and no delayed effect appeared;
- no `SubagentStop`, `PostToolUse`, `PostToolUseFailure`, or `PostToolBatch`
  observation appeared;
- no matching scratch process remained.

For this direct stdio child process, parent abort stopped the tool host before
the delayed effect. This is narrower than process-tree containment: the
campaign did not create a detached descendant, remote host, or durable
side-effecting service.

## Roster-gate observation

The separate roster campaign configured only `alpha` and requested one
`alpha` and one `general-purpose` call. An AR-owned `PreToolUse` hook allowed
only `subagent_type=alpha`.

The run observed:

- four `Agent` requests: three allowed `alpha` requests and one denied
  `general-purpose` request;
- three `alpha` starts and three matching `alpha` stops;
- no `general-purpose` start;
- zero `canUseTool` callbacks;
- no `permission_denied` stream message and no `PermissionDenied` hook;
- one provider `success` result, but not the requested exact parent marker;
- no iterator error, timeout, or matching process leak.

This proves that the tested `PreToolUse` gate could reject the unlisted
`subagent_type` before child start. It also preserves two counterexamples:
provider prose requesting one call did not prevent three allowed child
launches, and `canUseTool` was not a universal `Agent` authorization
interceptor in this run.

## Architecture consequences

- The Claude adapter can use `PreToolUse` as its last safe pre-dispatch point
  and map `subagent_type` to the provider-neutral AR invocation-authorization
  contract. Runtime Security does not own Claude hook or input vocabulary.
  Programmatic `agents`, available tool lists, provider prose, and
  `canUseTool` do not define authority.
- Every allowed child launch consumes an AR-owned budget and durable launch
  decision. Provider compliance with a requested call count is not a
  concurrency or duplicate-launch control.
- Child type, parent operation, authorization digest, execution generation,
  budget, and cancellation fence are bound before child start. Provider
  `agent_id` and `parent_tool_use_id` remain correlation data.
- The authorization decision is written at the gate. Missing
  `PermissionDenied` notifications do not erase a denial.
- External stdio is a viable tested delivery topology for synthetic child
  effects on this revision. Two independent stdio server processes on one Mac
  delivered overlapping background child effects; one shared process
  delivered its tested pair sequentially.
- Assistant-message grouping and `SubagentStop` are not scheduling or
  terminal contracts. AR controls concurrency through admitted child
  operations, host capacity, budgets, fences, and verified effect receipts.
- An operation key carried through the SDK and stdio transport is not a
  deduplication primitive. The tool host still needs the accepted durable
  command ledger, semantic fingerprint, execution fence, and effect receipt.
- Parent abort and process stop are observations, not universal cancellation
  proof. The tested direct stdio process stopped; detached descendants,
  remote tool hosts, and committed effects retain their separate
  reconciliation gates.

These findings refine Runtime Security, Agent Execution, and tool-host
adapters without changing bounded-context ownership or requiring physical
microservices.

## Evidence

Retained redacted bundle:

```text
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/reports/
  macos-claude-subagent-stdio-roster-conformance-2026-07-28.tar.gz

SHA-256
f1ef391ea9c64a6ca031baa830eb59df3f3d9873ff12e00d05090f1183b1b8b3
```

The bundle contains all three frozen harnesses, the synthetic stdio server,
allowlisted summaries, exact npm manifest and lock, and inert workspace
seeds. It excludes auth, raw provider traffic, provider identifiers,
transcript content, runtime state, and raw effect files.

## Remaining gates

This closes scoped one-process sequential and two-process same-host
external-stdio child delivery, background overlap, direct abort, and
roster-gate campaigns. It is not a production subagent/tool-host `GO`.

Still required:

- production bounded concurrency, backpressure, duplicate-launch control,
  queue fairness, host-capacity enforcement, and terminal reconciliation;
- detached-descendant and remote tool-host cancellation, crash, partition,
  reconnect, command-ledger replay, and committed-effect reconciliation;
- malformed/flooded frames, oversized inputs/results, stderr pressure,
  startup failure, long-duration queue and stream soak;
- remote HTTP MCP TLS, OAuth, redirect, DNS, private-address, proxy, and
  streaming behavior;
- dedicated non-user credentials, production key custody, production macOS
  containment, and revision-by-revision upgrade/rollback qualification.
