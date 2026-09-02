---
id: ADR-0014
type: adr
status: accepted
owner: architecture
summary: Accepts narrow Darwin arm64 provider candidate direction while preserving Linux authority and Contained Agent Turn V1 operation invariants.
related:
  - ADR-0009
  - ADR-0010
  - ADR-0012
code_anchors:
  - enforcement: required
    pattern: packages/contexts/agent-execution/tests/live/claude-contained-turn-live-canary.mjs
---

# ADR-0014: Darwin provider candidate platform qualification

Status: accepted

Date: 2026-09-01

## Context

Accepted ADR-0010 freezes the Contained Agent Turn V1 operation invariants and
the exact Linux candidate revisions that accompanied its acceptance. It is
immutable. Subsequent static characterization and production composition work
identified Darwin arm64 package closures for the same Codex and Claude
candidate revisions, but static evidence and synthetic tests cannot establish
target-platform behavior qualification.

Darwin process custody is also materially narrower than the strict Linux
cgroup-v2 profile. Cooperative POSIX process-group custody can observe and
close the cooperative group, but a descendant can escape by creating a new
session. That limitation prevents a truthful physical or composite containment
claim.

## Decision

Codex `@openai/codex@0.150.1` with Darwin arm64 native package
`@openai/codex-darwin-arm64@0.150.1` and binary SHA-256
`a14f9a907c12c8812878b70e6b7d65f81c39ed795513e46a55817d7428c0ca6b`
is accepted only as a Darwin arm64 candidate revision. Claude Agent SDK
`@anthropic-ai/claude-agent-sdk@0.3.251`, bundled Claude Code `2.1.251`, and
Darwin arm64 binary SHA-256
`625869b01e0050f260b2980fac248fd9cef9e462612bded4ec9d3d49ff8969a5`
is likewise accepted only as a Darwin arm64 candidate revision.

Darwin candidate execution uses a canonical operation-private workspace and
cooperative Darwin POSIX process-group custody. It cannot claim strict Linux
cgroup-v2 containment, descriptor-bound workspace authority, physical
containment closure, composite containment proof, implementation
qualification, deployment qualification, or production readiness.

No Darwin Codex or Claude qualification target is registered by this decision.
Each candidate remains unqualified until an exact-SHA canary runs locally on a
disposable macOS arm64 test root with an isolated test credential binding and
honest retained evidence is reviewed before registry promotion. Static Linux
evidence cannot support that promotion and no end-to-end evidence is inferred.

This decision is strictly additive and supersedes nothing. It adds only the
exact unqualified Darwin candidate tuples above and their narrower cooperative
process-group custody limitation. ADR-0010 remains authoritative in full,
including its exact Linux candidate pins, evidence meanings, and every
operation invariant. No ADR-0010 receipt meaning, containment requirement,
terminalization rule, retry prohibition, identity boundary, qualification
state, or other operation semantic is superseded or changed.

## Consequences

Darwin composition and synthetic platform tests may advance against the exact
candidate revisions without representing them as qualified targets. The
qualification registry must omit both Darwin candidate tuples until their
exact-final local macOS canaries produce evidence that satisfies registry
governance.

Cooperative closure is useful custody evidence but remains insufficient for a
physical or composite containment proof. Any caller requiring either proof
receives an indeterminate result rather than a stronger claim.
