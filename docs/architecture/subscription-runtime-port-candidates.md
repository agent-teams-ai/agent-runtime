---
id: runtime.architecture.subscription-runtime-port-candidates
type: architecture
status: proposed
owner: architecture
summary: Canonical contained-turn launch vs subscription-runtime encyclopedia; named anti-patterns SR-AP-1 … SR-AP-11. Host Custody profile optionality is not permission to copy SR spawn.
related:
  - ADR-0005
  - ADR-0008
  - ADR-0009
  - ADR-0010
  - ADR-0012
  - ADR-0014
blocked_by: []
code_anchors:
  - enforcement: advisory
    pattern: packages/contexts/agent-execution/src/features/contained-agent-turn/**
---

# Subscription-runtime port candidates

Status: proposed inventory, not production authority and not a qualification
claim.

Agent Runtime's current contained-turn launch model is canonical. The sibling
product [subscription-runtime](https://github.com/vioxen/subscription-runtime)
is a protocol encyclopedia, not a template. Extra SR launch modes (CLI
fallback, default SDK spawn, resume, pools, MCP) are not "how it should be
done".

Default for agents: do not copy SR. Name a gap in an existing AR adapter
first. If there is no gap, stop.

Local sibling checkout used for this inventory:
`/Users/belief/dev/projects/subscription-runtime` at `372bcfdf9`.
Agent Runtime comparison head:
`origin/fix/contained-turn-final-qualification` `72f927a3b`.

Related Agent Runtime documents:

- [Contained Agent Turn V1 delivery plan](contained-agent-turn-v1-delivery-plan.md#provider-decisions)
- [Contained agent turn feature](../../packages/contexts/agent-execution/src/features/contained-agent-turn/README.md)
- [Host Custody optional default](host-custody-optional-default.md)
- [ADR-0010](../decisions/0010-contained-agent-turn-v1-operation-authority.md)

Named anti-patterns, cite by id:

- [SR-AP-1. Provider owns the process](#sr-ap-1-provider-owns-the-process)
- [SR-AP-2. Silent second attempt](#sr-ap-2-silent-second-attempt)
- [SR-AP-3. Provider session as continuation](#sr-ap-3-provider-session-as-continuation)
- [SR-AP-4. Process reuse across operations](#sr-ap-4-process-reuse-across-operations)
- [SR-AP-5. Timeout becomes terminal](#sr-ap-5-timeout-becomes-terminal)
- [SR-AP-6. Canonical project is the provider cwd](#sr-ap-6-canonical-project-is-the-provider-cwd)
- [SR-AP-7. Privilege as the product path](#sr-ap-7-privilege-as-the-product-path)
- [SR-AP-8. Second policy plane](#sr-ap-8-second-policy-plane)
- [SR-AP-9. God worker module](#sr-ap-9-god-worker-module)
- [SR-AP-10. Filesystem job architecture](#sr-ap-10-filesystem-job-architecture)
- [SR-AP-11. Orchestrator intents in the runtime enum](#sr-ap-11-orchestrator-intents-in-the-runtime-enum)

## Decision

Keep the kernel, Host Custody, receipts, and fail-closed uncertainty. Do not
merge `worker-codex`. Do not dump SR product slices onto Contained Agent Turn
V1 because the code exists.

A slice may move only after its landing slot exists: owning bounded context,
port, and an accepted or proposed decision that names the capability. Missing
slot means an architecture amendment, not a port.

The 51k `contained-agent-turn/adapters` tree is not the domain kernel. It
implements the seven ADR-0012 ports. New product capabilities do not belong
in `host-custody`.

## Host Custody vs ordinary user-session

[Host Custody optional default](host-custody-optional-default.md) is the
current product ruling: ordinary user-session is the default; contained-turn
Host Custody is an optional profile, default off. Password or sudo on every
submit is forbidden in both profiles.

That optionality is not permission to copy subscription-runtime spawn
([SR-AP-1](#sr-ap-1-provider-owns-the-process)). Provider adapters must not
become a second process owner via Claude SDK default spawn or
`child_process`. Iterator drain is not containment proof.

When the Host Custody profile *is* selected, the ADR-0012 `custody` port
owns start, stop, and drain. Linux uses Docker + cgroup-v2. Darwin
cooperative custody is
[DarwinCooperativeProcessCustody](../../packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-cooperative-process-custody.ts)
(`cooperative-darwin-posix-process-group`), with the ADR-0014 limit that a
descendant can escape by creating a new session.

What stays off as Desktop UX is the Darwin **privileged canary**: root
launcher, `sandbox-exec` / seatbelt, sudo re-exec in
[run-darwin-codex-live-canary.mjs](../../packages/apps/embedded-runtime/tests/package/live/run-darwin-codex-live-canary.mjs).
That path is operator qualification, not the ordinary default, and not a
substitute for either user-session assembly or the Host Custody profile.

## Canonical launch (do not regress)

### Codex

Production path: Codex App Server JSONL over stdio, spawned and stopped by
Host Custody. CLI is diagnostics only. No `codex exec` fallback, no session
resume, no OpenAI-compatible HTTP, no systemd-as-domain.

AR already owns this adapter. Do not replace it with SR's App Server engine.

- AR feature: [contained-agent-turn](../../packages/contexts/agent-execution/src/features/contained-agent-turn/README.md)
- AR adapter: [codex-app-server](../../packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.ts)
- AR custody: [host-custody](../../packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-cooperative-process-custody.ts)
- Plan: [Contained Agent Turn V1 delivery plan](contained-agent-turn-v1-delivery-plan.md#codex)
- Evidence: [macos-codex-app-server-conformance-results](../spikes/macos-codex-app-server-conformance-results.md)

SR App Server path is the closest *protocol* reference, not a spawn template:

- [src/provider-codex/app-server/](https://github.com/vioxen/subscription-runtime/tree/main/src/provider-codex/app-server)
- [codex-app-server-execution-engine.ts](https://github.com/vioxen/subscription-runtime/blob/main/src/provider-codex/codex-app-server-execution-engine.ts)
- [failure-classifier.ts](https://github.com/vioxen/subscription-runtime/blob/main/src/provider-codex/failure-classifier.ts)
- GitHub: [vioxen/subscription-runtime `src/provider-codex`](https://github.com/vioxen/subscription-runtime/tree/main/src/provider-codex)

Worth *diffing* only after a named AR gap: exact model IDs (`gpt-5.6-sol`,
never infer `gpt-5.6`); usage/rate-limit as facts; structured-output schema
admission; protocol failure classes.

Do not take: process factory, systemd launcher, slot pool, managed-run
resume, App Server→CLI fallback, logical-thread slot lifecycle,
hosted-readonly mounts as provider cwd, CLI JSON/session/agent drivers,
[`openai-compatible-codex`](https://github.com/vioxen/subscription-runtime/tree/main/src/openai-compatible-codex).

### Claude Code

Production path: official `@anthropic-ai/claude-agent-sdk` `query()`, with
`spawnClaudeCodeProcess` bound to Host Custody. `persistSession` is false.
Resume/fork are forbidden. SDK iterator drain is not Host output-drain
proof. Physical start/stop/drain belong to Host Custody.

This is the intended design, not a temporary hack. The SDK type contract
exposes `spawnClaudeCodeProcess`. Spike evidence showed default SDK spawn
forwards the parent environment, and a `result` message can precede an auth
failure still on the iterator. Replacing spawn keeps protocol in the SDK and
process authority in AR. `persistSession: false` matches ADR-0010 (fresh
process, one attempt). Successor continuation is a later operation identity,
not SDK resume of the same V1 turn.

Known V1 limitation, still correct fail-closed: Claude interrupt without a
terminal result stays `ambiguous` / `reconcile_required`. Do not "fix" that
with SR cancel heuristics.

- AR adapter: [claude-agent-sdk](../../packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-contained-turn-provider.ts)
- Plan: [Contained Agent Turn V1 delivery plan](contained-agent-turn-v1-delivery-plan.md#claude-code)
- Evidence: [macos-claude-agent-sdk-conformance-results](../spikes/macos-claude-agent-sdk-conformance-results.md)

SR SDK `query()` is the closest *protocol* reference. SR default spawn is
the wrong process owner:

- [claude-agent-sdk-task-execution-engine.ts](https://github.com/vioxen/subscription-runtime/blob/main/src/provider-claude/process/claude-agent-sdk-task-execution-engine.ts)
- [failure-classifier.ts](https://github.com/vioxen/subscription-runtime/blob/main/src/provider-claude/failure-classifier.ts)
- GitHub: [vioxen/subscription-runtime `src/provider-claude`](https://github.com/vioxen/subscription-runtime/tree/main/src/provider-claude)

Worth *diffing* only after a named AR gap: message normalization, credential
redaction across chunk boundaries, failure classifier, rate-limit event
presence (not quota policy).

Do not take: default SDK spawn, [`claude -p` CLI engine](https://github.com/vioxen/subscription-runtime/blob/main/src/provider-claude/process/claude-cli-task-execution-engine.ts),
[Claude BG](https://github.com/vioxen/subscription-runtime/blob/main/src/provider-claude/claude-bg-provider-driver.ts),
`resume` / `forkSession` / `persistSession`, goal-completion MCP, `canUseTool`
as a second authority beside Host + Runtime Security.

### How an agent may take a chunk

1. Name the AR gap. If the AR adapter already implements it, stop.
2. Confirm the chunk is protocol or policy text, not process ownership.
3. Diff against the existing AR adapter. Keep Host Custody as the only
   spawner.
4. Reject session reuse, CLI fallback, and a second process authority.

## Feature map

| AR feature | Canonical code | SR encyclopedia (diff only) | Leave in SR |
| --- | --- | --- | --- |
| Contained turn kernel | [contained-agent-turn](../../packages/contexts/agent-execution/src/features/contained-agent-turn/README.md) | — | — |
| Host Custody | [host-custody](../../packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-cooperative-process-custody.ts) | hosted spawn is a different owner | systemd-run, unshare, host-jobs as domain |
| Codex provider port | [codex-app-server](../../packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.ts) | [provider-codex/app-server](https://github.com/vioxen/subscription-runtime/tree/main/src/provider-codex/app-server) | CLI exec, resume, HTTP bridge, fallback |
| Claude provider port | [claude-agent-sdk](../../packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-contained-turn-provider.ts) | [SDK task engine](https://github.com/vioxen/subscription-runtime/blob/main/src/provider-claude/process/claude-agent-sdk-task-execution-engine.ts) | default spawn, CLI print, BG, resume |
| Runtime Security admission | [contained-turn-egress](../../packages/contexts/runtime-security/src/features/contained-turn-egress/application/contained-turn-egress.ts) | [secret-detection.ts](https://github.com/vioxen/subscription-runtime/blob/main/src/worker-core/secret-detection.ts), [simple-secret-scanner.ts](https://github.com/vioxen/subscription-runtime/blob/main/src/worker-local/simple-secret-scanner.ts) | a second scanner inside host-custody |
| Access language (partial) | disposable workspace is already V1 | [access-control.ts](https://github.com/vioxen/subscription-runtime/blob/main/src/worker-core/access-control.ts), [project-access-boundaries.md](https://github.com/vioxen/subscription-runtime/blob/main/docs/project-access-boundaries.md) | `ProjectScopedControl`, CreateJob as contained-turn intents |
| Account facts (no V1 slot yet) | Provider Access later | [agent-account-observability](https://github.com/vioxen/subscription-runtime/tree/main/packages/agent-account-observability) | quota as dispatch policy |
| JSON host contract (deferred) | ADR-0008 private handle only | [agent-runtime-task](https://github.com/vioxen/subscription-runtime/tree/main/src/agent-runtime-task), [agent-runtime-task-bridge.md](https://github.com/vioxen/subscription-runtime/blob/main/docs/agent-runtime-task-bridge.md) | making the JSON DTO the domain |

## What the 51k adapters are

Kernel: domain 4.3k, application 3.9k, contracts 0.2k. Seven ports:
`operationStore`, `security`, `providerAccess`, `workspace`, `artifacts`,
`custody`, `provider`.

| Adapter folder | Prod lines | Port |
| --- | ---: | --- |
| `host-custody/` | 32,740 | `custody` (Docker 15k, egress 6.4k, Darwin/node) |
| `filesystem/` | 7,549 | `workspace` + `artifacts` |
| `codex-app-server/` | 5,394 | `provider` |
| `postgres/` | 3,441 | `operationStore` |
| `claude-agent-sdk/` | 1,768 | `provider` |

## Landing slots before any port

If the slot column is empty, do not move code.

| SR slice | V1 slot | Wrong landing |
| --- | --- | --- |
| Codex protocol extras | Yes: Codex adapter | Replacing the AR tree or importing worker lifecycle |
| Claude redaction / failure mapping | Yes: Claude adapter | Quota policy or BG long-session in the turn adapter |
| Secret scanning | Partial: untrusted output admission | Scanner inside `host-custody` |
| Access-boundary enum | Partial: workspace isolation | Whole enum including project control |
| Account observability | No | Quota in dispatch or custody |
| JSON task contract | No; public API deferred | Second API on `RuntimeAccessHandle` |
| Run-event read model | Partial: receipts | SR job/heartbeat shapes in the kernel |
| Hosted readonly inputs | Conflict: V1 forbids canonical project as provider cwd | Recreating SR hosted workers in `host-custody` |
| Dependency bootstrap | No; installer deferred | Contained-turn preparation |
| Project control / pools / MCP / threads | No; ADR-0006 still proposed | Extending contained-turn into a worker platform |

## Named subscription-runtime anti-patterns

These are remembered names. They describe SR product history that Agent
Runtime must not copy. They are not a judgment that SR is wrong for its own
worker/MCP product. They are forbidden shapes for contained-turn.

### SR-AP-1. Provider owns the process

Claude SDK default spawn (`pathToClaudeCodeExecutable` without
`spawnClaudeCodeProcess` → Host Custody). Codex `child_process` / hosted
launcher inside the provider engine. The SDK or CLI inherits parent env,
owns the process group, and treats iterator drain as containment.

Host Custody, when that profile is selected, is the only spawner. Ordinary
user-session default and turning off the Darwin sudo canary do not
authorize this anti-pattern.

### SR-AP-2. Silent second attempt

[app-server-fallback-policy.ts](https://github.com/vioxen/subscription-runtime/blob/main/src/provider-codex/app-server/application/app-server-fallback-policy.ts):
App Server fails, then `codex exec` runs. Also any automatic CLI/SDK
fallback or provider racing.

Violates ADR-0010: at most one provider attempt. Ambiguity stays
`reconcile_required`.

### SR-AP-3. Provider session as continuation

`resume`, `forkSession`, `persistSession`, Claude BG rehydrate, Codex
managed-run resume, logical thread = provider session id.

V1 is a fresh process and a fresh provider session. Later continuation is a
new operation identity (ADR-0006 still proposed), not SDK resume.

### SR-AP-4. Process reuse across operations

[App Server slot pool / prewarm](https://github.com/vioxen/subscription-runtime/blob/main/src/provider-codex/app-server/application/app-server-slot-pool.ts),
worker-pool warm processes kept for the next job.

Each V1 attempt gets a new process tree so empty custody can be proved.

### SR-AP-5. Timeout becomes terminal

Transport timeout, disconnect, `not_found`, or missing history mapped to
`failed`, `cancelled`, or retry permission.

Must remain nonterminal `reconcile_required`. Interrupt without a terminal
receipt stays ambiguous. Do not invent cancel from "process gone".

### SR-AP-6. Canonical project is the provider cwd

Hosted readonly mounts, running Codex/Claude in the real repo tree.

V1 workspace is disposable and operation-scoped. The user project is never
the provider workspace.

### SR-AP-7. Privilege as the product path

SR [host-jobs / systemd-run](https://github.com/vioxen/subscription-runtime/blob/main/docs/host-job-lifecycle.md)
and Darwin sudo/seatbelt live canary. Asking the user for root to run a
normal turn.

Operator qualification only. Desktop spawn is cooperative Host Custody
without sudo. Privilege is not a substitute for the custody port.

### SR-AP-8. Second policy plane

`canUseTool`, goal-completion MCP, extra tool guards beside Runtime Security
and Host.

Authorization stays on Runtime Security. Provider adapters translate
protocol. They do not become a parallel policy engine.

### SR-AP-9. God worker module

[`src/worker-codex/`](https://github.com/vioxen/subscription-runtime/tree/main/src/worker-codex):
MCP, project control, hosted, ledger, provider glue in one tree.

New product features are new feature modules / bounded contexts, not more
files in `host-custody` or a second worker-codex.

### SR-AP-10. Filesystem job architecture

File-backend worker pool, tmux goal runner, consumed-output-ledger as the
operation store.

Durable truth is receipts + owner records, not a job directory layout.

### SR-AP-11. Orchestrator intents in the runtime enum

`AccessBoundary.ProjectScopedControl`, `CreateJob`, start-worker as if they
were contained-turn commands.

Contained turn is one analysis/write-in-disposable-workspace operation.
Project control is a later bounded context.

### How to cite

In reviews and agent instructions write `SR-AP-1` … `SR-AP-11`. If a change
matches one of these names, reject it even when the SR file looks polished.

## High-risk SR files (index into the names above)

These look useful and are the fastest way to import a worse architecture.

| Id | SR piece | Why it is dangerous here |
| --- | --- | --- |
| SR-AP-2 | [app-server-fallback-policy.ts](https://github.com/vioxen/subscription-runtime/blob/main/src/provider-codex/app-server/application/app-server-fallback-policy.ts) | Second attempt. |
| SR-AP-1 | Claude SDK default spawn without Host Custody | SDK inherits parent env; iterator drain is not process proof. |
| SR-AP-3 | `resume` / `forkSession` / `persistSession` | Provider session as continuation transport. |
| SR-AP-3 | Claude BG / tmux goal runner | Long-lived session ownership outside receipts. |
| SR-AP-4 | [slot pool / prewarm](https://github.com/vioxen/subscription-runtime/blob/main/src/provider-codex/app-server/application/app-server-slot-pool.ts) | Reuses a process across operations. |
| SR-AP-6 | Hosted readonly mounts as provider cwd | Canonical project becomes the provider workspace. |
| SR-AP-7 | [SR host-jobs / systemd-run](https://github.com/vioxen/subscription-runtime/blob/main/docs/host-job-lifecycle.md) | Privilege as the product path. |
| SR-AP-8 | `canUseTool` / goal MCP as a second policy plane | Bypasses Runtime Security + Host. |
| SR-AP-5 | Timeout/`not_found` → `failed` or `cancelled` | Manufactures terminal truth. |
| SR-AP-9 | `worker-codex` as a tree | Orchestrator, MCP, ledger, hosted, and provider glued together. |
| SR-AP-10 | File-backend worker pool | Filesystem job architecture. |
| SR-AP-11 | AccessBoundary `ProjectScopedControl` / CreateJob | Project-control product, not a contained-turn intent. |
| SR-AP-10 | Consumed-output-ledger epochs | Different durability model than AR receipts. |

Protocol-only diffs (model IDs, usage facts, redaction, failure classes) stay
allowed after a named gap. Everything in this table is architecture, not a
helpful helper.

## Do not copy

- [`src/worker-codex/`](https://github.com/vioxen/subscription-runtime/tree/main/src/worker-codex) as a tree, MCP god files, tmux goal runner
- file-backend worker pool as architecture
- BullMQ as domain
- OpenAI-compatible Codex HTTP bridge
- GitHub Action runner / Actions secret store until a CI consumer exists
- consumed-output-ledger files as-is
- anything that turns timeout, disconnect, or missing history into success

## Guardrail

contained-turn outbound adapters are already 51k production lines, 33k in
`host-custody`. That is the same concentration failure SR has in
`worker-codex`. New product features land as new feature modules, not more
files in that folder.
