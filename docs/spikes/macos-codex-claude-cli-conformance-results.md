# macOS Codex and Claude CLI conformance results

Status: accepted scoped evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Machine-readable summary:
`experiments/runtime-profile-behavior/fixtures/macos-codex-claude-cli-summary.json`

Summary SHA-256:

```text
c11a29c8e4b513442f771ed0599ccfe332bf47dc50228df6b010d36fb61c1dc7
```

## Scope and authorization

This campaign ran on macOS `15.6.1` build `24G90`, Apple Silicon, in two new
synthetic Git repositories. It did not open or execute against a user project.

Unlike the synthetic-provider campaigns, these runs used the user's existing
Codex and Claude CLI authorization after explicit approval and made real
first-party provider calls. They did not use a real MCP server or allow user
hooks or customizations. Claude exposed no tools; Codex's built-in patch
attempt was sandbox-denied, and no workspace mutation succeeded. Credential
values were not printed, inspected, hashed, or retained.

Codex ran with a mode-`0600` temporary copy of its auth file in a separate
`CODEX_HOME`; the copy remained byte-identical and was deleted with the
scratch directory. Claude used its existing CLI login with `--safe-mode`,
`--strict-mcp-config`, an empty MCP set, no tools, and
`--no-session-persistence`.

This proves local CLI behavior under an explicitly authorized existing login.
It does not qualify dedicated test accounts, hosted secret custody, refresh,
revocation, or credential-generation compare-and-swap.

## Qualified binary pairs

| Provider | Installed | Tested latest | Native executable SHA-256 |
| --- | --- | --- | --- |
| Codex | `0.144.1` | `0.145.0` | installed `29915529...167a`; latest `1da3f4e0...f590` |
| Claude Code | `2.1.205` | `2.1.220` | installed `33e28624...6f9c`; latest `8addc857...e081` |

The Codex `0.145.0` closure also recorded its bundled code-mode host, ripgrep,
and zsh hashes. The exact npm integrity values and complete hashes are in the
machine-readable summary. The test installed neither latest version globally;
both were executed from an isolated npm cache.

## Codex observations

- Installed and latest one-shot `codex exec --json` runs returned exact
  markers with `thread.started`, `turn.started`, one agent message, and
  `turn.completed`. No tool item was emitted.
- Two latest ephemeral runs completed concurrently from separate synthetic
  repositories with independent exact results.
- A persisted thread created in workspace A resumed by explicit thread ID from
  workspace B and remembered the first turn. A thread ID and cwd therefore
  cannot authorize resume.
- `--ignore-user-config` excluded `config.toml`, while `--ignore-rules` only
  excluded execpolicy `.rules`. A workspace `AGENTS.md` canary was still in
  model context. Adding `-c project_doc_max_bytes=0` suppressed it.
- With a read-only sandbox, an attempted patch was denied and the target file
  remained absent. The exact rejection appeared on stderr, but JSONL contained
  only agent messages and no structured failure item.
- Latest usage added `cache_write_input_tokens` to the observed usage shape.
  Output decoders must tolerate additive fields within an accepted revision
  policy.

## Claude Code observations

- Installed and latest JSON one-shot runs returned exact results with
  `end_turn`, one turn, no permission denial, and no web request.
- Two latest no-persistence runs completed concurrently with independent
  results.
- Official `--input-format stream-json` user envelopes plus
  `--replay-user-messages` completed a deterministic arithmetic contract on
  both versions. The installed version replayed `user` after early assistant
  deltas; the latest version replayed it before `message_start`. Consumers
  cannot assume one cross-version event order beyond documented causal
  requirements.
- Exact-marker prompts were also observed returning protocol
  `subtype=success` while refusing the requested business result. Protocol
  success is not business success.
- `modelUsage` contained only Sonnet in some runs and Sonnet plus an auxiliary
  Haiku model in others, including different results across concurrent latest
  runs. Disabling prompt suggestions did not guarantee one model.
- `--safe-mode` ignored a synthetic workspace `CLAUDE.md` canary and exposed
  zero tools and zero MCP servers. Its `system:init` still enumerated counts
  and metadata for configured plugins, skills, and agents. Raw init payloads
  are therefore not safe default telemetry.
- With `--tools ''` and bypassed permission prompts, Claude returned
  `subtype=success` and textual `Write` language, but created no file. External
  effect verification is mandatory.

## Cancellation observations

Two runs per provider received `SIGINT` after `1500 ms`:

- Codex exited `1` twice, emitted only `thread.started` and `turn.started`, and
  emitted no terminal JSON event.
- Claude exited `0` twice and emitted terminal
  `result:error_during_execution`.
- Neither provider required `SIGTERM` or `SIGKILL`, and no matching local
  process remained.

This proves bounded local process-group termination for the tested cases. It
does not prove that the remote provider stopped billable work or acknowledged
cancellation.

## Architecture consequences

- Codex and Claude keep separate anti-corruption adapters behind one Agent
  Execution port. Exit codes, terminal events, stderr, usage, and cancellation
  semantics are normalized into AR-owned types.
- `RuntimeOperation` succeeds only after its expected business/effect receipt
  is verified. Provider `success`, exit zero, or model prose is insufficient.
- Workspace instruction inheritance is explicit profile policy:
  `none` or an authorized immutable snapshot with provenance and digest. It is
  never inferred from cwd, a provider session ID, or ambient files.
- Environment inheritance is default-deny and allowlisted per provider
  materializer. Secrets remain opaque Provider Access bindings; non-secret
  values included in a launch are snapshotted into the authorized activation
  and materialization evidence.
- Provider accounting uses observed request, token, and `modelUsage` records.
  One agent turn is not treated as one provider/model request.
- Stdout protocol, stderr diagnostics, and effect receipts are separate
  bounded streams. Telemetry uses allowlist projections and does not persist
  raw provider init payloads by default.
- Existing user CLI login is a local, explicit import path. Hosted workers use
  dedicated credential generations and production key custody.

These facts fit the accepted strict modular control plane plus separate
workers. Runtime Configuration owns portable profile and instruction-source
intent; Runtime Security authorizes the exact instruction and capability
closure; Provider Access owns account, credential generation, route, and usage
facts; Agent Execution owns adapter protocol, custody, output, cancellation,
and effect reconciliation. No shared mutable `RuntimeProfile` service is
introduced.

## Evidence

Retained redacted bundle:

```text
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/reports/
  macos-codex-claude-cli-conformance-2026-07-28.tar.gz

SHA-256
4b2de8673ff5c44b2094ce18c06ffc785b44f7c0917421967c7224ac6c9fec3f
```

The bundle contains the allowlist summary, cancellation projection and
harness, and synthetic canaries. It excludes copied authentication state,
account identifiers, raw provider payloads, raw `system:init`, session IDs,
and user files.

## Remaining gates

This closes only scoped local macOS CLI conformance. It is not a production
Codex or Claude adapter `GO`.

A later App Server follow-up is recorded in
`docs/spikes/macos-codex-app-server-conformance-results.md`. It closes the
scoped stable-stdio handshake, instruction-source, different-thread
concurrency, interrupt, resume, and generated-schema observations while adding
a same-thread overlap counterexample.

A later Claude Agent SDK follow-up is recorded in
`docs/spikes/macos-claude-agent-sdk-conformance-results.md`. It closes the
scoped current-SDK isolation, concurrent-query, same-cwd resume, macOS sandbox,
queued-interrupt, AbortController, and full-stream-drain observations while
adding cwd-placement and Stop-All counterexamples.

Still required:

- Codex same-thread serialization, structured tool/effect lifecycle,
  provider-side cancellation, output-drain, and restart conformance;
- Claude external SessionStore failure/replay, real MCP/tool/hook lifecycle,
  provider-side cancellation, restart, and long-duration stream/queue
  conformance;
- provider-side cancellation and billable-work reconciliation;
- dedicated non-user test accounts, refresh/revocation generation CAS, and
  production `KeyProvider` custody;
- macOS continuous descendant containment and endpoint-specific egress;
- upgrade, rollback, and schema compatibility policy beyond the two tested
  binary pairs.

References:

- [Codex non-interactive
  mode](https://learn.chatgpt.com/docs/non-interactive-mode);
- [Codex CLI command
  reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli);
- [Claude Code CLI
  reference](https://code.claude.com/docs/en/cli-reference);
- [Claude Code headless
  mode](https://code.claude.com/docs/en/headless).
