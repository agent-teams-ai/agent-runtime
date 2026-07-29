# macOS Claude MCP, tool, and hook conformance results

Status: accepted scoped evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Machine-readable summary:
`experiments/runtime-profile-behavior/fixtures/macos-claude-tools-hooks-summary.json`

Summary SHA-256:

```text
b9d3f59ed8694adab199638e7680592db0d404dff700e2ec80c20b1a38d03458
```

## Scope and provenance

The campaign ran on macOS `15.6.1` Apple Silicon in a fresh synthetic
workspace. It used the user's existing Claude CLI authorization after explicit
approval and made real first-party Claude calls. It did not open a user project
or load a real user MCP server, hook, plugin, setting, or instruction file.

The exact stable package closure was:

| Package | Version |
| --- | --- |
| `@anthropic-ai/claude-agent-sdk` | `0.3.220` |
| bundled Claude Code | `2.1.220` |
| `@anthropic-ai/sdk` | `0.115.0` |
| `@modelcontextprotocol/sdk` | `1.30.0` |
| `zod` | `4.4.3` |

The bundled native executable SHA-256 remained
`8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081`.
Credential values, account identifiers, provider session identifiers, and raw
provider messages were not retained.

## Hook authorization and correlation

A `PreToolUse` hook replaced the model's synthetic marker and allowed the
call. The handler received only the rewritten value. `PostToolUse` received
the rewritten input and result with the same tool-use ID, and
`PostToolBatch` reported that same ID.

Two matching `PreToolUse` checks then ran as one parallel set: one allowed and
one denied. The denial won even though the tool had a bare `allowedTools`
entry. The handler did not run and no effect was created. Hook implementations
therefore cannot depend on completion order; every check must be independent
and a single deny must fail closed.

The associated `PermissionDenied` hook did not fire for this
`PreToolUse` denial. Authorization audit cannot rely on that later event; the
authoritative hook decision must be durably projected at the decision point.

## `canUseTool` shadowing counterexample

A bare `allowedTools` entry auto-approved the tool before a deliberately
denying `canUseTool` callback:

- the callback was never invoked;
- the tool effect occurred;
- the SDK emitted `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`;
- the provider completed the exact business response.

`canUseTool` is a pending user-approval mechanism, not a universal security
interceptor. Runtime Security enforcement that must cover every invocation
belongs in a provider-neutral authorization port and in the separately
authorized tool host. The Claude adapter invokes that port from `PreToolUse`;
other providers use their own last safe pre-dispatch boundary.

## In-process MCP containment counterexample

An in-process SDK MCP tool marked `readOnlyHint: true` wrote a synthetic file
outside the Claude sandbox's allowed workspace and at an explicitly denied
path. The write succeeded.

This matches the documented execution model: the handler runs inside the SDK
host application, not the sandboxed Claude subprocess. MCP annotations are
hints, not enforcement. Untrusted or effectful handlers therefore cannot run
inside the control plane. They execute in a least-privilege worker or sidecar
whose process, filesystem, network, credential, and resource custody is
independent from Claude's own sandbox.

The SDK MCP instance was already disconnected after each completed query; an
additional explicit close was idempotent.

## Error, timeout, and interrupt behavior

An uncaught in-process handler exception:

- exposed its synthetic internal error text in the provider stream;
- fired `PostToolUseFailure` with the same error and a duration;
- did not end the agent loop;
- allowed Claude to return the exact requested recovery response.

Raw handler exceptions must be redacted and classified before they become tool
results, telemetry, or model context.

A one-second `PreToolUse` timeout aborted the hook signal, blocked the handler,
created no effect, and let the session continue. Interrupting while another
`PreToolUse` callback was pending also aborted its signal, prevented the tool
effect, returned an interrupt receipt, and settled within ten seconds. The
interrupted turn emitted `error_during_execution` and the iterator then failed,
so stream drain remains part of terminal evidence.

## External stdio MCP behavior

The synthetic stdio server confirmed a critical environment boundary:
`mcpServers.<name>.env` added its explicit values but did not replace the
parent Claude process environment. A synthetic parent canary was inherited by
the MCP child.

Per-server `env` is therefore an overlay, not secret isolation. AR must launch
Claude itself from a default-deny environment and place untrusted MCP
processes behind its own process-runner boundary with an exact environment
projection.

On an ordinary completed query, the stdio server exited and left no process.
Aborting a running 15-second tool settled within ten seconds, terminated the
server, and prevented its delayed completion effect. A separate one-second MCP
tool timeout:

- fired `PostToolUseFailure` with `is_interrupt=false` and a duration;
- prevented the delayed completion effect;
- terminated the stdio server when the query ended;
- still allowed the provider query to return `success`.

A tool failure or timeout is not the same as an operation failure. AR requires
a typed tool invocation receipt and an AR-owned business/effect receipt rather
than deriving success from the provider result.

## Architecture consequences

- Runtime Security produces an exact provider-neutral invocation
  authorization. The Claude adapter maps `PreToolUse` input to that contract;
  Agent Execution separately performs budget, duplicate, capacity, fence, and
  cancellation admission before dispatch.
- `allowedTools`, `canUseTool`, annotations, and model behavior are not
  authority boundaries. The approval callback remains a UI interaction port.
- Parallel hooks are pure, independent checks. Their audit projections are
  idempotent by event and tool-use ID; no hook relies on another hook's order.
- Effectful MCP handlers run only in separately provisioned workers or
  sidecars. The modular control plane never imports or executes their code.
- The outer process runner supplies a replacement environment. Per-MCP `env`
  is treated only as an overlay within that already-safe projection.
- Tool exceptions are allowlist-classified and redacted. Raw handler text and
  provider payloads do not become general telemetry.
- Tool timeout, hook timeout, interrupt, provider result, process exit, and
  verified effect are separate observations and receipts.

These rules preserve the accepted strict modular control plane plus separate
workers and strengthen the future microservice extraction boundary: Runtime
Security owns authorization, Agent Execution owns invocation state and
reconciliation, and the tool host remains an adapter behind a versioned port.

## Evidence

Retained redacted bundle:

```text
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/reports/
  macos-claude-tools-hooks-conformance-2026-07-28.tar.gz

SHA-256
eb4ea50eae75ea047019292cc4d32b56fd8cc67e100992d781d8468bd3e2e1cb
```

The bundle contains the final harness, synthetic stdio MCP server, redacted
summary, exact package manifest and lock, and inert workspace fixture. It
excludes authorization state, account data, raw provider messages, session
identifiers, raw effect files, npm cache, installed dependencies, and Git
metadata.

## Remaining gates

This closes the current SDK's scoped synthetic macOS MCP/tool/hook semantics.
It is not a production tool-host `GO`.

The later
`docs/spikes/macos-claude-mcp-failure-conformance-results.md` follow-up closes
the tested SDK's scoped retry duplication, idempotency-key behavior,
crash-after-effect ambiguity, and detached-descendant counterexample.
The later
`docs/spikes/macos-claude-subagent-parallel-results.md` follow-up records one
child `canUseTool` deny with `agent_id`, missing provider denial events, a
parallel shared in-process MCP delivery counterexample, and a late effect
after parent abort.
The later
`docs/spikes/macos-claude-subagent-stdio-results.md` follow-up records
one-process sequential and two-process same-host overlapping external-stdio
child effect delivery, assistant grouping drift, direct stdio abort, an
unexpected built-in child, repeated allowed launches, and an effective
`PreToolUse` roster denial without `canUseTool` or provider denial events.

Still required:

- the production isolated tool-host runner with non-user credentials,
  containment, egress, resource budgets, signed invocation authorization, and
  durable effect receipts;
- production command-ledger reconciliation under real worker/database crash,
  link loss, partitions, failover, and concurrent duplicate dispatch;
- malformed/flooded MCP frames, oversized inputs/results, stderr pressure,
  startup failure, reconnect, and long-duration soak;
- remote HTTP MCP TLS, OAuth, redirect, DNS, private-address, proxy, and
  streaming behavior;
- production bounded concurrency, backpressure, duplicate-launch control,
  remote cancellation, hook replay, hook-host crash, and parked-approval
  timeout policy;
- upgrade and rollback compatibility across every supported SDK, Claude Code,
  and MCP revision.

References:

- [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools);
- [Hooks](https://code.claude.com/docs/en/agent-sdk/hooks);
- [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions);
- [MCP](https://code.claude.com/docs/en/agent-sdk/mcp);
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
