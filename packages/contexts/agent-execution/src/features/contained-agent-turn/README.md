---
type: feature
status: accepted
owner: "@agent-teams/agent-execution"
owner_document: ADR-0005
---

# Contained agent turn

Owns the provider-neutral contained-turn operation contract, durable operation
authority, ordered execution kernel, and owner-side runtime adapters. Public
contracts are curated through `index.ts`; private construction and adapter
exports are curated through `internal.ts` and the package composition surface.
Test-only owner-port assembly remains outside production source.

## Provider conformance limitations

The current Codex App Server and Claude Agent SDK adapters do not establish
full parity for the delivery plan's cancellation and incremental-output cases.
These are acceptance gaps, not exceptions to ADR-0009 or ADR-0010 receipt
requirements, and this note does not qualify a provider or relax the plan.

Codex requires an exact cancellation-derived interrupt acknowledgement and a
reconciled `interrupted` terminal before mapping `cancelled`; its process/drain
checks and the kernel's Host proofs still apply. Claude maps SDK results to
`succeeded` or `failed`. An acknowledged interrupt followed by iterator exhaustion
without a result remains `ambiguous`, mapped to kernel `indeterminate`, requiring
reconciliation. An error result after interrupt remains `failed`. Neither
interrupt acknowledgement nor process disappearance can synthesize `cancelled`.

Codex assistant output is bounded whole-turn buffering: exact item lifecycles
must reconcile with the full terminal receipt before admission. Credential and
private-path checks cover concatenated text, including sensitive tokens split
across completed items. Per-item emission would bypass that policy. Validated
command, reasoning, and plan notifications remain private lifecycle evidence.
Claude incrementally emits normalized, redacted assistant text with awaited
admission. Both preserve admitted cursor order, but a capability manifest's
supported mode or required output-drain proof does not promise incremental
assistant output, passive payload exposure, or cancellation-outcome parity.

The Claude spawn process exit members are the SDK-facing compatibility surface,
retained for official query-input assignability. Physical exit and drain evidence
belongs to Host Custody, not a second SDK-adapter process authority. The current
kernel mapper discards legacy SDK receipt strings; Host Custody requires sealed
provider completion, proved process start, and closed execution evidence before
issuing execution, output-drain, and provider-terminal proofs. SDK iterator drain
alone is not a Host output-drain proof.

## Canonical launch vs subscription-runtime

This feature's adapters are the canonical contained-turn launch model.
subscription-runtime is a protocol encyclopedia, not a spawn template.

- Codex: App Server JSONL over stdio. No CLI fallback
  ([SR-AP-2](../../../../../../docs/architecture/subscription-runtime-port-candidates.md#sr-ap-2-silent-second-attempt)).
- Claude: official Agent SDK `query()` with `spawnClaudeCodeProcess` bound to
  Host Custody when that profile is selected. `persistSession` is false.
  Resume/fork are V1-forbidden
  ([SR-AP-1](../../../../../../docs/architecture/subscription-runtime-port-candidates.md#sr-ap-1-provider-owns-the-process),
  [SR-AP-3](../../../../../../docs/architecture/subscription-runtime-port-candidates.md#sr-ap-3-provider-session-as-continuation)).
- Host Custody is an optional profile, default off
  ([host-custody-optional-default.md](../../../../../../docs/architecture/host-custody-optional-default.md)).
  Optionality does not authorize SR default SDK spawn.

Named anti-patterns to refuse when porting from the sibling product:
[`SR-AP-1` … `SR-AP-11`](../../../../../../docs/architecture/subscription-runtime-port-candidates.md#named-subscription-runtime-anti-patterns).
Authority and take/leave rules:
[subscription-runtime-port-candidates.md](../../../../../../docs/architecture/subscription-runtime-port-candidates.md).
