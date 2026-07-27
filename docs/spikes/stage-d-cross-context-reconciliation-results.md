# Stage D cross-context reconciliation results

Status: decision-grade architecture evidence with scoped partials

Date: 2026-07-27

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

This document records two independent synthetic E2E lanes. It is not
production runtime code or a production-readiness claim.

## Safety boundary

All campaigns ran on the designated Linux hosting worker with synthetic
sources, workspaces, identities, and payloads. No real user project,
credential, provider inference, MCP server, or Desktop process was used.

## Local collector to hosted ingestion

Accepted campaigns:

```text
stage-d-reconcile-final-a-20260727124230-5c71d8
stage-d-reconcile-final-b-20260727124230-a94e26
```

Each campaign passed 39 of 39 scenarios. The independently normalized
projection digest was identical:

```text
f14ab7759e062ae5f19691aecbc74be4bfd5e6412928c1a93e75a4ff89dc2845
```

Confirmed:

- the collector, hosted ingestion process, and verifier used separate UIDs;
- hosted ingestion received bytes and provenance, never client source paths;
- direct/intermediate symlinks, hardlinks, devices, FIFOs, sockets, mount
  escapes, absolute paths, parent traversal, malformed UTF-8, duplicate JSON
  keys, oversize input, and unsupported fields failed closed;
- rename, growth/truncation, and root-replacement races produced either a
  whole valid observation or a typed unstable result;
- staged publication, command receipt, effect, and garbage-collection intent
  recovered across real SIGKILL checkpoints without duplicate publication;
- SQLite publication and command outcome were atomic for the exercised
  single-writer model;
- successful capture preserved exact opaque bytes while public metadata
  excluded the secret canary;
- campaign cgroups, processes, mounts, staging, database sidecars, and
  collector work directories were empty after cleanup.

Scoped partials:

- Linux `openat2`, namespaces, bind mounts, and ext4/overlay behavior do not
  prove macOS or Windows collector safety;
- a privileged precisely timed ABA writer requires a filesystem snapshot or
  equivalent platform primitive for stronger guarantees;
- metadata redaction does not imply universal secret discovery inside opaque
  configuration;
- local root remained the trust anchor;
- SIGKILL plus SQLite `synchronous=FULL` is not physical power loss,
  disk-full, corruption, or kernel-failure evidence.

## Profile binding and preparation consistency

Accepted execution:

```text
stage-d-v3-final-20260727124509438-03004da8
```

The two fresh campaigns, `gamma` and `delta`, each passed 592 of 592
independent assertions and converged to the same normalized semantic digest:

```text
6ece184e6cc3e3aeb3fdbabdcc13f1d1cd16c7c0effb74f9fb58262fd28d18cb
```

Confirmed:

- binding heads, profile revisions, preparation vectors, review fingerprints,
  launch references, and receipts remain tenant- and scope-bound;
- one preparation never mixes owner revisions from competing observations;
- deterministic semantic outcomes are independent from schedule and seed;
- plan, command transcript, preparation, receipt, and database evidence are
  hash-bound and independently recomputed;
- nine verifier-sensitivity mutations were detected, including plan payload,
  transcript, preparation vector, tenant, scope, receipt, missing head, and
  binding rollback tampering;
- final cleanup left no residual runtime files.

Scoped partials:

- this was Linux single-host process-crash evidence;
- SQLite used a single-writer controller;
- PostgreSQL, multi-host concurrency, Connect transport, providers, and
  platform deployment were outside the campaign;
- source/evidence was hash-bound inside the harness, without an external
  production signing trust anchor.

## Architecture consequence

The spike supports the existing ownership split:

- Runtime Configuration publishes immutable profile revisions;
- Runtime Security owns access and authorization;
- Agent Execution owns preparation, activation, and recovery;
- cross-context progress uses durable process managers and typed events;
- no transaction crosses bounded contexts;
- hosted AR never walks client filesystem paths.

The results do not authorize copying the experiment harness into production.
Production adapters still require platform, persistence, transport, and
provider conformance.
