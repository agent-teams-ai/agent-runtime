# Interactive provider contract experiment

**TEST-only compatibility consumer.** `./draft-contracts` reexports the canonical
Agent Execution interactive contract types; `./claude` reexports the single
workspace provider implementation admitted by ADR-0092. The five experimental
private algorithm modules have been retired. No production root imports this
experiment. This package retains the original behavioral, SDK-process and packed
consumer assertions without owning a second driver, runtime or process supervisor.

This package is outside the accepted Embedded Runtime passive setup Assembly
scope. Fixed local helpers use static imports. The two meaningful development
boundaries are the historical contract and driver compatibility entrypoints;
the test Host owns processes, readiness and cleanup. Foundation classifies every
source root and the precise workspace package edges. The package has real build/typecheck/tests,
also called by root `check:ci:quick` and `check:fast`. Current CI-contract census
admission must pass before delivery; a local package pass is not that admission.

Exact reviewed dependency pair: Claude Agent SDK **0.3.305**, bundled Claude Code
**2.1.305**, Zod **4.6.7**. The SDK declarations use newer Zod
preprocess generics despite declaring `^4.0.0`; the experiment therefore uses
the provider library's named catalog. Existing contained-turn SDK 0.3.251 and Zod
4.4.3 remain pinned.

```sh
pnpm --filter @agent-teams/interactive-provider-contract-experiment check
```

This deterministic suite substitutes only the SDK query transport boundary. It
proves serial input handoff, independent sessions, normalized message/block
snapshots, tool observations, interaction replies independent of a full prompt
queue, interrupt/result ordering, close sealing, explicit checkpoint selection,
MCP failures, output bounds and uncertainty. A failed dependency check during an
already handed-off turn seals continuation as unknown: fresh MCP connectivity
alone cannot prove that the old turn has stopped. The runtime must reconcile
and retire that execution before recovery. It is not real-provider E2E.

`submit` receipts report `client-consumed` iterable handoff and unknown provider
acceptance. Interaction replies are awaited because the canonical contract permits
either a synchronous or asynchronous provider implementation.
The caller owns durable admission, stable input/operation IDs, idempotency and
recovery. No input is automatically retried. Only live/queued identity conflicts
are rejected locally; durable terminal identity retention belongs to runtime.
Result ends a technical turn, not product work. Background facts lack operation
attribution. Missing provider UUID correlation fails closed. Text snapshots and
complete frames replace the same message/block; equal text in distinct blocks
or messages remains distinct. Cost is cumulative, not summed across results.

`default` permission mode is explicit. Allowed tools are auto-approval rules,
separate from the exposed native tool list. The experiment denies native
team/task/agent writers. A reply carries either a permission decision or question
answers and never enters the prompt queue. Callbacks expire, abort and close
without applying late decisions. A successful `interrupt` receipt only confirms
the control request; the result is still required. Unknown interrupt completion
keeps the session unavailable. Output overflow closes the SDK query and delivers
one reserved typed terminal fact even to a slow observer.

Checkpoint data is private opaque transport state. Restore checks SDK revision,
workspace/account/config/binding compatibility and caller-owned storage
availability, then uses explicit `resume: sessionId`. It never continues the
latest session, silently starts fresh, restores callbacks or replays input.
`configRevision` must change whenever the runtime-selected endpoint, credential,
settings or policy changes. Close seals admission synchronously and joins one
shutdown promise. SDK close is not process-tree proof: the Host must confirm its
own children have exited or cleanup remains `unknown`.

## Opt-in real-provider harness

Do not invoke it using user project/config/auth state. Prepare a **new disposable
TEST root**, with separate existing `home`, `config`, `tmp` directories. The
caller supplies a mode-0600 JSON manifest inside that root:

```json
{
  "root": "/absolute/TEST-claude-driver",
  "model": "explicit-model-for-test-account",
  "environment": {
    "HOME": "/absolute/TEST-claude-driver/home",
    "CLAUDE_CONFIG_DIR": "/absolute/TEST-claude-driver/config",
    "TMPDIR": "/absolute/TEST-claude-driver/tmp",
    "PATH": "/explicit/approved/node/path:/usr/bin:/bin",
    "ANTHROPIC_API_KEY": "caller-provided-test-credential"
  }
}
```

```sh
TEST_CLAUDE_INPUT=/absolute/TEST-claude-driver/run.json \
  pnpm --filter @agent-teams/interactive-provider-contract-experiment harness
```

The harness accepts only this explicit API-key environment, starts a loopback
fixture MCP endpoint, creates two independent sessions, queues A's second input
while its first permission callback is pending, replies through the interaction
API, verifies fixture task/message effects and normalized text/tool/results,
then exercises selected-session resume and targeted interrupt. Its scenario
ledger holds test state only. It verifies replay/conflict/lost-response lookup
without any production mutation. Redacted evidence contains event kinds and
opaque references, versions and owner cleanup receipts; it omits credential,
raw checkpoint, prompts and provider error strings. No user's credentials are
read or copied. Subscription product onboarding is not qualified by this route.

Live provider/auth, exact native binary/platform provenance, cleanup, selected
session resume and packaged executable resolution must be observed before
claiming full baseline B. The localhost Anthropic fixture E2E is separate
synthetic-provider evidence using the same package, not real Anthropic proof.
`pnpm --filter @agent-teams/interactive-provider-contract-experiment test:sdk-process`
uses the real SDK/CLI with a local synthetic API and stdio MCP, a dummy key and
isolated TEST state. It proves multi-turn/context isolation, permission replies
with a queued prompt, selected-session resume and scoped cleanup.
`pnpm --filter @agent-teams/interactive-provider-contract-experiment test:packed`
builds and installs the archive in a fresh external TEST consumer, compiles the
public API and resolves the bundled executable without launching it. This
opt-in command may fetch missing registry dependencies (preferring cached bytes).
Electron packaging/signing, production runtime custody qualification and
Orchestrator/desktop integration remain outside this TEST consumer. Canonical
SPI admission and provider library ownership are recorded by their runtime ADRs;
these fixture passes do not certify native authentication or deployment.
