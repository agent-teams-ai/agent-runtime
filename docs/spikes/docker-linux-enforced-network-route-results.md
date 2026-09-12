# Docker Linux exclusive network route enforcement results

Status: accepted implementation evidence for one exact target

Date: 2026-09-07

Evidence tree: `6d5c76313f1753052d684ca13b9397cf216ae6da`

Canonical decisions:
`docs/decisions/0010-contained-agent-turn-v1-operation-authority.md`,
`docs/decisions/0012-provider-access-authority-in-contained-turn-composition.md`

This campaign is source-level implementation evidence for exactly one runtime
target: the Docker/Linux Codex contained turn whose container egress is cut to a
single Host-custodied broker endpoint by an exclusive Linux network-namespace
route. It exercised ownership, ordering, one-use admission, first-write
adjacency, projection of Provider Access facts, and typed refusals against the
real production factories. It installed no kernel route, started no provider
binary, presented no credential, and reached no provider origin.

## The exact target

Three dimensions are not a governance choice; the code fixes them and the
product gate compares them byte for byte.

| Dimension | Value | Source |
| --- | --- | --- |
| `provider` | `codex` | the accepted provider of this path; the Claude candidate has no broker seam and is not promoted here |
| `providerAdapter` | `codex-app-server-contained-turn:0.153.4+native-permission-config-v2` | `CODEX_APP_SERVER_ADAPTER_REVISION`, transported into `LinuxExclusiveRouteBinding.adapterRevision` |
| `binaryClosure` | `@openai/codex:0.153.4+linux-x64` | `CODEX_APP_SERVER_LINUX_X64_TUPLE.binaryRevision`, the only Codex value `supportedLinuxCandidate` admits |
| `platform` | `linux-x64` | `${process.platform}-${process.arch}` observed by the gate; the route is a Linux namespace effect |
| `credentialRoute` | `provider-access-endorsed-codex-chatgpt-host-materialized-credential-binding` | the endorsed `codex-chatgpt` recipe, materialized by the Host broker; no credential enters the container |
| `storageTopology` | `digest-pinned-readonly-rootfs-with-disposable-host-bound-workspace-and-private-home` | digest-pinned image, read-only rootfs, `rprivate` binds for `/workspace` and `/agent-private`, `noexec` tmpfs `/tmp` |
| `transportTopology` | `codex-native-http-over-nftables-exclusive-route-to-host-broker-then-host-tls-to-provider-origin` | container-side default-drop `inet` table with one accepted broker address and port, Host-side one-shot TLS upstream |
| `failureDomain` | `single-linux-host-container-with-host-custodied-broker` | one Linux Host owns the Engine, the operation network, the listener, the broker and the route lease |

Recombining these values with any other observed value is not evidence. In
particular the `codex-api` recipe, the Claude candidate, Darwin hosts, and any
other binary or adapter revision remain unqualified.

## Accepted facts

Ordering and ownership, from `docker-linux-post-claim-preparation.test.ts` and
`host-http-egress-v4-setup-ordering.test.ts`:

- a missing route admission owner is refused before any allocation, so a wiring
  without an installed route performs no Engine effect at all;
- the operation network is allocated from the committed dispatch proof alone and
  its name reaches `NetworkMode` before the container exists; the listener binds
  the gateway the Engine observed, never a caller-supplied address;
- the container joins the network only after the listener endpoint is published,
  the authenticated init handshake precedes provider execution, and an inbound
  exchange cannot open before the route is installed. Every pairwise swap of the
  canonical setup order is refused by the V4 ledger;
- preparation is one-use; a cut-off at any step leaves nothing prepared;
- release runs in the reverse of allocation, and anything the owner cannot prove
  released stays quarantined with its ownership retained rather than reported as
  a clean teardown.

Route admission, from `docker-linux-exclusive-route-admission.test.ts` and
`linux-exclusive-route-expiry.test.ts`:

- admission is one-use and refuses an already cut off or expired request;
- an unpinned tool refuses and keeps the opened namespace quarantined;
- a container the Engine cannot observe as running is refused without opening
  anything, and the namespace is released only after the exact container is
  proven absent;
- the lease expires autonomously: early and late timers, clock regression,
  nonfinite time, readback failure and cancellation failure quarantine instead
  of renewing authority, and no callback after release can revive it.

First-write adjacency, from `http-egress-route-first-write.test.ts`:

- a refused lease consumption emits no application byte at all; the lease is
  consumed exactly once per completed attempt; a repeated request id never
  reaches the journal; no microtask separates consumption from the emitted
  bytes; a session without a route owner keeps its established behavior.

Capability and gate, from `contained-turn-route-enforcement-capability.test.ts`,
`contained-turn-route-enforcement-gate.test.ts` and
`contained-turn-route-qualification.test.ts`:

- the enforcement capability is minted only by the production factory from a
  complete 21-field route binding and the two pinned tools; structural twins,
  spread copies and proxies carry no target and are refused without a single
  property read;
- the minted tuple is bound to the binding: `binaryClosure` and
  `providerAdapter` must equal the binding's own revisions, and an
  accessor-backed tuple is refused rather than read twice;
- the product entrypoint admits the composition only when both facts hold — an
  authentic capability and a registry row at `implementation` or `deployment`
  for the complete eight-dimension tuple. Drift in any single dimension, a
  promotion for another platform, a weakened `matchingPolicy`, an entry without
  evidence, and an unreadable registry all refuse with the same typed
  `route-enforcement-unqualified`;
- the verdict is never cached: a capability admitted against one registry is
  refused against another on the next attempt.

Provider Access projection, from `contained-turn-linux-route-binding.test.ts`,
`contained-turn-http-egress-upstream.test.ts` and
`contained-turn-http-egress-authorities.test.ts`:

- the route binding and the broker's upstream ports carry Provider Access facts
  verbatim, including the opaque credential binding digest; an endorsement
  Provider Access does not validate cannot become a route binding, and a
  provider the endorsement does not name is refused;
- every endorsed recipe projects the Host catalog route it names; an endorsement
  the catalog does not carry is refused rather than silently trimmed on the wire;
- the composed broker session record is exactly the broker's dependency set, and
  the optional route first-write port is the only member that may be absent.

## Not exercised

- No kernel route was installed. `openNodeLinuxExclusiveRoute` requires Linux
  x64, `euid == 0` and exact `sha256` digests of the pinned `nsenter` and `nft`
  binaries; the campaign machine and CI satisfy none of them. Every nftables
  transaction, namespace entry, readback and expiry above was exercised through
  the adapter's deterministic kernel seam, not against a kernel.
- No provider process was started, no container was created on a real Docker
  Engine, and no operation network was allocated by a real daemon.
- No credential was rendered and no provider origin was contacted. The Provider
  Access endorsement, the credential materialization and the TLS upstream were
  exercised against fixtures.
- No live contained turn completed. The two live canaries still refuse, because
  nobody in this checkout produces the Provider Access and Runtime Security
  authority owners they require.
- The `ids`, `resolver` and `evidence` broker session ports have no production
  owner in this repository, so no composition root can assemble an authentic
  capability together with a live broker session today.

## Retained digests

Test files of the evidence tree, with the count each contributed.

```
115 Agent Execution tests
1b335378e43fbb7e99b0e4c8f339d1622343cb4b78a6bbbba0f230773546e1f7  23  docker-linux-post-claim-preparation.test.ts
e6f310d6229668b9285b117ac5324b32891ef7b85eacac739d1c055f3270a1b0   4  docker-linux-exclusive-route-admission.test.ts
1a76b522f8f9d0ea60a11f826905fdabdd6384a968e4d75b2bd6dec1667494c3  14  host-http-egress-v4-observers.test.ts
a47bb5ccbc97ebaf4829081fdb70cd53965ee506e7c60a25d3ac2c8ad20decb9  31  host-http-egress-v4-setup-ordering.test.ts
90120105c9bf87c3d3e275b05b7c3e79bd769cdf7875a2b126d7fb1f786378ea   6  http-egress-route-first-write.test.ts
b7e34c62c56d34bea7525e1f7d32c1869f22c8466075817bb8c3e388b288039a   3  docker-host-custody-attempt-key.test.ts
65603e1d76d2d2c5dba6ab58f31ad61bd5d2e6a4aaeb3cc522043f56908e7640   5  contained-turn-route-enforcement-capability.test.ts
4456949230f7219135439be8846abcc0194626214d4e0487655f78fbe5170447  29  linux-exclusive-route-expiry.test.ts

7 Agent Execution live canary tests
ed98f127c977579d1eb78e24b750f8005492e53fb85726487a407fd73b8ebec6   7  contained-turn-live-canary-lifecycle.test.mjs

29 Embedded Runtime tests
6a215436460d986a160798b41c0ad91398c25c687255c6459749b5678eceda46   6  contained-turn-route-enforcement-gate.test.ts
0b7c1bea296bee5fdb67dbee8d7aa110f62c7c8d377eb05697398cdd589b4c83   5  contained-turn-route-qualification.test.ts
1933a2204bec60601c8843ff3c58ced348cc092fd177ad878ff5f75ba81cc5fa   5  contained-turn-linux-route-binding.test.ts
fed607992c1b608a4cdfc9d33f923fb09cc0ce19bb2d79ce27390672796feb3d   4  contained-turn-http-egress-upstream.test.ts
6a74fff8934aef51e82c078feed670220554baa66f885d45d80d0fdf9b008713   5  contained-turn-http-egress-authorities.test.ts
e1d6d56c39c62fce23ca1da1928e3a71ea3345b5fb7febc59122e66f9b55e64e   4  provider-candidate-route-gate.test.ts
```

Agent Execution paths are relative to
`packages/contexts/agent-execution/tests/features/contained-agent-turn/`;
Embedded Runtime paths are relative to `packages/apps/embedded-runtime/tests/`.

The redacted machine-readable summary is
`experiments/runtime-profile-behavior/fixtures/docker-linux-enforced-network-route-summary.json`.

## Remaining gates

- real kernel installation of the exclusive route on a Linux x64 root host with
  the exact pinned `nsenter` and `nft` digests, including readback, expiry under
  Host loss, and endpoint quarantine;
- a real Docker Engine campaign: image pull by digest, operation network
  allocation, container creation, membership observation and removal proof;
- a live Codex turn over the enforced route with a real endorsed credential, and
  a content-addressed receipt bound to the source revision that produced it;
- production owners for the `ids`, `resolver` and `evidence` broker session
  ports, without which no composition root can mint an authentic capability
  beside a live broker session;
- an honest typed `unsupported` for the Claude path before the two enforcement
  facts are consulted, and its own broker seam before any Claude promotion;
- deployment qualification: operational, security, upgrade, rollback and
  disaster-recovery gates for the exact release topology.
