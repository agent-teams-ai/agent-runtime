---
id: ADR-0010
type: adr
status: accepted
owner: architecture
summary: Accepts the deliberately narrow Contained Agent Turn V1 operation contract.
related:
  - ADR-0001
  - ADR-0002
  - ADR-0003
  - ADR-0004
  - ADR-0006
  - ADR-0008
  - ADR-0009
code_anchors:
  - enforcement: required
    pattern: experiments/runtime-profile-behavior/spec/runtime-operation-oracle/**
---

# ADR-0010: Contained Agent Turn V1 operation authority

Status: accepted

Date: 2026-08-29

## Context

ADR-0001 through ADR-0004 establish the authoritative runtime, cutoff,
reconciliation, effect, output, and terminal invariants. ADR-0008 establishes
the private Embedded Runtime access entrypoint. Proposed ADR-0006 explores a
wider operation model: successor operations, fresh
retry, deployment continuity, terminal indeterminacy, and general binary
retention. Those are useful design inputs but are too broad to authorize the
first contained agent turn.

This successor decision leaves proposed ADR-0006 byte-for-byte unchanged and
accepts only the V1 subset below. The accepted decision does not authorize a provider adapter,
persistence implementation, workspace implementation, custody implementation,
SDK surface, deployment, or Embedded Runtime product code.

## Decision

### V1 is one contained turn

A V1 submission durably accepts exactly one immutable operation intent, then
executes at most one provider attempt associated with exactly one coarse
`EffectId`. The effect represents the whole provider turn; V1 does not expose
child-tool, transcript, or per-call effect identities.

The operation's dimensions remain semantically orthogonal:

```text
immutable OperationId and intent
command acceptance
dispatch claim
provider execution closure
provider containment closure
coarse effect resolution
reconciliation debt
output closure
terminal requirements and terminal result
```

These are not one mutable lifecycle enum. Operation state changes only through
durable owner records and immutable receipt references. Arbitrary strings and
generic JSON policy bags are forbidden in authoritative state.

Command acceptance and dispatch claim are separate durable transitions.
Acceptance creates the `OperationId`, freezes intent, scope, exact provider
binary and adapter revisions, the immutable `RequiredReceiptSet`, and the
single `EffectId`. A dispatch claim may occur only after acceptance and after
the ADR-0004 guard check. It binds the sole `AttemptId`, authority-vector
digest, and current fence revision. There is no V1 redispatch or blind retry.

If evidence cannot prove whether the provider accepted or produced an effect,
the operation remains nonterminal with `reconcile_required`. Timeout,
disconnect, `not_found`, missing history, caller abort, or Host disposal cannot
turn ambiguity into `known_not_accepted`, a terminal outcome, or permission to
retry. V1 has no `outcome_indeterminate` terminal result.

Provider execution is fresh for the attempt: a new provider process or
provider session is created for this accepted operation. Fallback, resumed
provider sessions, successor operations, and provider-session reuse are not V1.
The canonical project is never the provider workspace.

### Cutoff and the pre-materialization dispatch guard

The ADR-0004 dispatch-prevention seam is mandatory and ordered:

1. persist command acceptance and its immutable intent;
2. evaluate the durable scope guard immediately before dispatch
   materialization;
3. when prevention wins, persist the fenced operation and do not create a
   dispatch claim, provider session, process, or effectful provider request;
4. when a dispatch claim wins, cutoff becomes post-dispatch containment and
   reconciliation, never fictional pre-dispatch prevention.

A delayed command matching a guard that already exists is rejected before an
operation or provider materializes. A guard received after command acceptance
but before claim fences that operation. A guard that races after claim cannot
erase the claim. A mismatched command digest, scope, or authority revision is
rejected. Absence from provider history and transport failure are not negative
acceptance evidence. The executable authority packet includes these minimized
counterexamples; it extends the existing oracle rather than creating another
state machine or TCK.

### Capability manifest and resource containment

Every qualified adapter revision supplies a versioned, immutable
`AdapterCapabilityManifest`. For the V1 provider-turn path its effect class is
`contained_unmediated_effect`: the runtime cannot mediate every provider
internal effect, so it must contain and receipt the worst credible resource
scope. An unknown effect class or a manifest whose declared scope is narrower
than the worst case is fail closed.

The accepted worst-case scope is:

- a disposable, operation-scoped workspace with no canonical-project path;
- the fresh provider process/session and every descendant;
- only the exact Provider Access route through the enforced network boundary,
  with no ambient or general network route;
- only opaque operation-scoped credential bindings, with no ambient credential
  directory or inherited general-purpose secret source;
- operation-scoped output, artifact, and custody resources.

The capability manifest is evidence about an exact adapter and provider binary
revision. It is not itself deployment qualification.

### Immutable receipt closure

Command acceptance freezes an immutable `RequiredReceiptSet`. Membership can
never shrink after acceptance. Each member is satisfied by an immutable typed
receipt or by an authority-defined typed non-applicability proof. V1 requires
receipt closure for:

```text
command acceptance
dispatch claim or proved no-dispatch
provider execution closure or proved no-start
provider terminal observation or proved no-start
output drain and output-fence closure
Host custody
workspace closure
artifact-manifest sealing
coarse-effect resolution or durable reconciliation debt
containment execution
canonical-result publication
cutoff enforcement when cutoff applies
```

`ContainmentExecutionReceipt` binds the `OperationId`, `EffectId`, `AttemptId`
when one exists, immutable scope digest, exact provider `BinaryRevision`, exact
`AdapterCapabilityManifest` revision, containment-policy digest, workspace
identity, Provider Access route, credential-binding digest, Host custody and
boot identity, provider observation, output-drain cursor, artifact-manifest
seal, cutoff observation, and the terminal-execution observation. It proves
what containment action was executed and observed; it does not by itself prove
durable cancellation, provider acceptance, effect resolution, or terminal
truth.

Terminalization is a durable compare-and-swap over the current authority
revision. It requires closed admission and output fences, provider execution
closure, containment closure, no unresolved coarse effect, no reconciliation
debt, sealed artifacts, canonical result publication, and the entire frozen
receipt set. Late receipts are evidence only and cannot reopen terminal truth.

### Exact V1 revisions and evidence status

The acceptance packet freezes static contract-characterization fixtures for
these exact current candidate revisions:

- Codex `@openai/codex@0.150.1`: Linux x64 native package
  `@openai/codex-linux-x64@0.150.1`, binary SHA-256
  `abf1bb1643a79f73aa78ee627e111e02d4f8c98f25813a0cf6ce277709664386`,
  and Darwin arm64 native package `@openai/codex-darwin-arm64@0.150.1`,
  binary SHA-256
  `a14f9a907c12c8812878b70e6b7d65f81c39ed795513e46a55817d7428c0ca6b`;
- Claude Agent SDK `@anthropic-ai/claude-agent-sdk@0.3.251`, bundled Claude
  Code `2.1.251`, binary SHA-256
  `fd5f10ff0eb58daec04900466b143ea98aab50abf208a422bc008eaec13f61f7`;
- OpenCode contract pin
  `opencode@1.18.5#78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21`
  with adapter identity
  `opencode-acp-v1-adapter`.

The accompanying Linux Codex and Claude fixtures prove only exact package,
binary, generated-contract, and public SDK shape. The Darwin Codex fixture
independently binds the immutable package, native target/path, binary digest,
and initialize identity as candidate authority only. No exact-SHA local macOS
canary for that candidate is registered, and the qualification registry has no
Darwin Codex target row. No provider turn was run for these static fixtures.
They do not behavior-qualify the hosted target, authorize production execution,
or claim that every provider effect is mediated. Behavior qualification is a
separate delivery gate. The OpenCode item is contract-only and does not assert
that a production adapter exists.

### Existing-oracle disposition

The existing ADR-0006 oracle remains the sole executable semantic oracle. Its
28 requirements and 242 examples are preserved byte-for-byte. The V1 packet
enumerates every requirement and every example as `required`, `deferred`, or
`not_applicable`, and classifies the complete 48,000-state static product by
the same three dispositions. The authority loader proves exact, exclusive,
exhaustive membership and the documented category totals.

`deferred` and `not_applicable` rows are traceability, not accepted features.
In particular, retry, successor-operation effect sharing, resume and deployment
continuity, terminal `outcome_indeterminate`, child/transcript effect ledgers,
and general binary-retention or garbage-collection protocols remain outside V1.

### Composition and identity boundary

The production composition boundary and trusted handle are governed by
ADR-0009. All future module, module-generation, plan, and lifecycle identities
remain semantically disjoint from `OperationId`, `EffectId`, `AttemptId`,
workspace, custody, Host boot, receipt, and authority-revision identities. This
decision introduces no Module Kit dependency and no module lifecycle meaning.

## Foundation inputs

Foundation PR 22 at
`a01ac2b02bcb8bf46efea8e78a13a255b3988ef2` and PR 27 at
`ee976675ed48c35e92f868ede95cc68e3fb71c6f` were reviewed as non-authoritative
design inputs. Their composition, detached-capability, identity-separation,
and lifecycle guardrails are represented in the contract fixture. Agent
Runtime owns this decision; those commits neither replace the ADR nor create a
Module Kit dependency.

## Consequences

- V1 is deliberately smaller than the original proposed model and cannot grow
  by treating deferred oracle rows as implicitly accepted.
- Ambiguity costs reconciliation and blocks terminalization; it never creates
  a retry permission.
- Provider qualification must prove the exact manifest, containment, receipt,
  workspace, custody, and Provider Access claims on the target platform before
  implementation or deployment readiness can advance.
- ADR-0001 through ADR-0004 and ADR-0008 remain unchanged and normative.
