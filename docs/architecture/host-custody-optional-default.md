---
id: runtime.architecture.host-custody-optional-default
type: architecture
status: active
owner: architecture
summary: Ordinary user-session runtime is the product default; contained-turn Host Custody stays an optional profile defaulted off.
related:
  - ADR-0008
  - ADR-0009
  - ADR-0010
---

# Host Custody optional default

## Purpose

Owner ruling 2026-09-12: Agent Runtime has **two profiles**, not one custody
mode for every caller.

The **ordinary default** is a user-session runtime, like an existing project,
subscription-runtime, or IDE: the agent runs as the current user, without root
and without a one-shot uid. Per-turn sudo and a password on every submit are
not product UX.

**Contained-turn Host Custody** is a separate optional profile for treating the
agent as untrusted code. Linux uses a Docker daemon so sudo is not required on
every turn. Darwin may install a privileged helper / launchd job **once**; later
turns must not prompt for a password. Optionality is the product default
**off**. It does not remove the Host Custody port from the architecture.

Sandbox remains orthogonal: file and network limits can apply without changing
uid.

This document records that default and the deferred follow-up. It does not
amend ADR-0008, ADR-0009, or ADR-0010, authorize a production deployment, or
add a PR #69 merge gate.

## Ownership boundary

Ordinary default assembly stays on the existing private `RuntimeAccessHandle`
and current-user process identity. Contained-turn Host Custody remains Agent
Execution's process-identity, containment, and cleanup owner when that profile
is selected. Provider Access, Runtime Security, workspace/artifact contracts,
and provider adapters keep their current owners.

## Invariants

- Default product assembly does not require Host Custody, root, or a leased uid.
- Selecting contained-turn Host Custody is explicit. Shipping default-off does
  not delete the port, Docker Linux custody, or Darwin helper design.
- Sandbox (seatbelt, file/network limits) is not Host Custody.
- Password or sudo on every submit is forbidden in both profiles.

## Deferred TODO

Host Custody is not a current delivery priority. Leave the ordinary default
off and finish the optional profile later:

- [ ] Wire ordinary default assembly so Host Custody is opt-in, not required,
  including Darwin user-session Codex without isolate FD 8 / privileged helper.
- [ ] Keep contained-turn Host Custody as a named profile: Linux Docker daemon;
  Darwin privileged helper installed once, then passwordless turns.
- [ ] Do not spend PR #69 merge time on Darwin isolate activation, leftover
  helper retries, or per-submit admin prompts.
- [ ] When the profile is scheduled, qualify it on disposable projects only and
  keep sandbox limits independently selectable.

## Related documentation

- [Contained Agent Turn V1 delivery plan](contained-agent-turn-v1-delivery-plan.md#phase-3-production-host-custody)
  still describes Host Custody owners; this document makes that profile optional
  and default-off for current delivery.
- [Rust custody migration follow-up](rust-custody-migration-follow-up.md)
  remains a separate deferred migration, not this optionality ruling.
- [ADR-0008](../decisions/0008-private-embedded-runtime-access-entrypoint.md)
  and [ADR-0009](../decisions/0009-contained-turn-private-access-and-host-shutdown-boundary.md)
  keep the private handle and contained-turn composition boundary.
- [ADR-0010](../decisions/0010-contained-agent-turn-v1-operation-authority.md)
  keeps the one-attempt operation contract.
- [Subscription-runtime port candidates](subscription-runtime-port-candidates.md#host-custody-vs-ordinary-user-session)
  records that Host Custody optionality is not permission to copy
  subscription-runtime spawn ([SR-AP-1](subscription-runtime-port-candidates.md#sr-ap-1-provider-owns-the-process)).
