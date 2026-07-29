# OpenCode container and TLS egress gateway results

Status: accepted scoped evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Machine-readable summary:
`experiments/runtime-profile-behavior/fixtures/opencode-container-tls-gateway-summary.json`

Summary SHA-256:

```text
6dbc6ca165ca9ff26ac7bb56ff049a7af05b81521d5b82414725a0af904a2d60
```

## Scope and safety

The campaign used the designated Linux hosting worker, new synthetic Docker
networks, a new empty workspace, the official OpenCode `1.18.5` Linux binary,
and a synthetic OpenAI-compatible HTTPS provider. It did not open a user
project, import a credential, start a real MCP server, or call an external
provider.

The runtime image used:

```text
OpenCode 1.18.5
78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21

node:24.18-bookworm-slim
sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ripgrep 15.1.0
ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2
```

OpenCode source at tag `v1.18.5` declares ripgrep `15.1.0`. Ripgrep `15.2.0`
was the newer stable release observed when this evidence was captured. The
image intentionally retained the provider revision's declared compatibility
version rather than silently changing the closure. A newer helper is tested as
a new dependency closure.

## Cold-start counterexamples

The successful container followed three rejected revisions:

1. A writable XDG/config projection caused OpenCode to contact npm for
   `@opencode-ai/plugin`, even with autoupdate, model-fetch, default-plugin, and
   LSP-download flags disabled.
2. Making configuration root-owned and read-only stopped the npm path, but
   OpenCode failed when it attempted to create a missing `.gitignore`.
3. Precreating the complete immutable configuration stopped that write, but a
   cold image without `rg` attempted to download ripgrep `15.1.0` from GitHub.

The accepted image precreated the complete root-owned config tree, set its
directories to `0555` and files to `0444`, bundled the source-declared ripgrep,
and separated writable HOME/data/cache/state into bounded temporary filesystems.

The resulting real OpenCode ACP run completed:

- ACP v1 negotiation with agent `OpenCode 1.18.5`;
- `session/new`;
- one prompt through the synthetic provider;
- exact marker observation;
- terminal reason `end_turn`;
- process exit zero.

The runtime emitted one allowed provider request and no npm, GitHub, or
models.dev request. Disable flags are useful defense in depth, but only the
attested image closure proved cold-start dependency behavior.

## Accepted gateway topology

The stronger tested topology was:

```text
OpenCode container
  -> internal application route on egress gateway
  -> gateway-owned HTTPS connection
  -> authorized provider IP

generic HTTP proxy or CONNECT
  -> deny
```

OpenCode and the gateway shared one internal worker-facing network. The
synthetic provider and gateway shared a separate upstream network. A second
container deliberately used the same Docker DNS alias as the provider.

The gateway:

- accepted only the exact provider method and route;
- resolved the authorization to a pinned provider IP;
- still verified the provider TLS hostname against a synthetic CA;
- removed generic HTTP proxy and CONNECT authority;
- denied redirects;
- enforced request bytes before upstream dispatch;
- enforced response bytes and total upstream time;
- logged only sizes, digests, decisions, and campaign identity.

This is an application-layer gateway, not an unrestricted forward proxy.
Provider credentials can therefore be injected at the gateway boundary, and
the gateway can inspect and budget provider traffic without granting the agent
an opaque outbound tunnel.

## Campaign results

Each accepted campaign passed 21 of 21 cases and an independent 24-of-24
read-only audit:

| Case | Result |
| --- | --- |
| authorized TLS route | `200`, hostname authorized |
| unauthorized application route | `403` |
| generic HTTP proxy | `403` |
| generic CONNECT | `403` |
| request over byte budget | `413`, no upstream dispatch |
| response over byte budget | `502` |
| total time over budget | `504` |
| provider redirect | `502` |
| wrong TLS hostname | `502` |
| duplicate Docker alias, ten requests | all ten reached pinned provider IP |
| unauthorized alias peer | zero requests |
| real OpenCode ACP through gateway | `end_turn`, marker observed, exit zero |

The calibration and two final campaigns used frozen source pin:

```text
3d6ba1abdc369c1f0d19a0687cb249fe08e53437e9b000be7ebee0276461bb58
```

All three produced the same semantic projection:

```text
1c7fbb71692d8d0e745620d7b23c16fa1458b6c0890b715fdd6ae494e7bf2751
```

Every gateway record was bound to a fresh campaign nonce. The three raw
evidence digests were distinct:

```text
4037be788796f6dfad81cd270f4aae49a591fd37eadb3d9a10e2038eba6e8bca
8433588220d7964bda0da09e289c0dbe263d3e1b4b5c8669ca05a4c5d7d4f6ec
c370859cf8574f520ce7b4c232597130420e7eebbf2b66e44ca0f5fed51c95cb
```

An earlier comparison was rejected because three otherwise successful,
deterministic campaigns produced byte-identical evidence. Freshness became an
explicit evidence binding rather than an assumption.

## Architecture consequences

- `BinaryRevision` identifies an immutable executable closure, not only the
  primary agent binary. The closure includes exact helper binaries, config
  layout, dependency metadata, base image, and their digests.
- Runtime config is root-owned and immutable. Mutable provider state has a
  separate bounded location and lifecycle.
- Runtime package installation and helper download are preparation effects.
  They are never invisible launch behavior.
- Agent containers receive only an operation-scoped application gateway route.
  They do not receive a general CONNECT tunnel.
- Runtime Security owns the signed route authorization. The worker validates
  it and materializes a gateway policy; the provider cannot choose or widen
  that policy.
- DNS names and bridge aliases are inputs, not identities. The gateway binds a
  trusted resolution result to an authorized IP set and then validates TLS
  identity.
- The gateway owns redirect, request, response, attempt, and wall-time policy.
  OpenCode and provider-SDK retries remain inside the outer Agent Execution
  budget.
- Evidence records bind operation identity, authorization digest, route,
  resolved IP set, TLS result, byte counts, and request/response digests
  without bodies or secret material.
- A newer transitive or helper dependency creates a new closure and
  qualification result. `latest` never mutates an accepted BinaryRevision.

These findings support the accepted strict modular control plane plus separate
workers. Runtime Security owns authorization semantics, Agent Execution owns
operation and gateway policy materialization, Provider Access owns secret
injection and route/account identity, and the trusted worker owns container,
network, and process custody. No new global runtime-profile service is needed.

## Evidence

```text
accepted direct-proxy OpenCode result
40f1c44d74240c7fcd112e3dd72e6537296fd47bffacc588d3d638a4385eaecf

accepted audit results
4c94ec0a20e7082d378b58ee5ccb1573a8c3ea94c5590cdf7e6d0f362e24321a
debe8d9fad40bbe66516640e1469c040c54692bbb1f790a636228dfaf983f1c6
4448930469ec533b44548d8c001e9fb586f5219dcbff641fb0f462acc1f1cf9e

campaign comparison
dc0ce09820b999e66f18616f330c45dbabf21122462342256fe433137517e794

retained redacted bundle
297cf47d3ce479bccdf5b961def442accf2eabb4e4e76c9b8860fc966ec612c1
```

Retained bundle:

```text
/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/reports/
  opencode-container-tls-gateway-2026-07-28.tar.gz
```

The bundle excludes synthetic TLS private keys, request bodies, credentials,
and account identifiers.

## Remaining gates

This closes the scoped synthetic Linux OpenCode container E2E and
application-gateway TLS semantics. It is not a production Linux `GO`.

Still required:

- load, verify, expire, and rotate the real signed operation authorization in
  the production gateway;
- qualify public-PKI external DNS, rebinding defenses, private/reserved-address
  rejection, allowed IP rotation, external proxies, load balancers, and
  failure classification;
- qualify streaming backpressure and post-header byte-budget termination; the
  spike buffered the bounded provider response before forwarding it;
- protect the Docker daemon and worker API and authorize only typed supervisor
  operations;
- qualify custom seccomp/AppArmor, image signature and SBOM enforcement,
  init/zombie behavior, and supported platform versions;
- run isolated dedicated real-provider conformance for every supported
  OpenCode route without user projects;
- qualify physical power loss and worker replacement recovery.

References:

- [OpenCode provider
  configuration](https://opencode.ai/docs/providers/);
- [OpenCode `v1.18.5` config dependency
  preparation](https://github.com/anomalyco/opencode/blob/v1.18.5/packages/opencode/src/config/config.ts);
- [OpenCode `v1.18.5` npm
  adapter](https://github.com/anomalyco/opencode/blob/v1.18.5/packages/core/src/npm.ts);
- [OpenCode `v1.18.5` ripgrep
  bootstrap](https://github.com/anomalyco/opencode/blob/v1.18.5/packages/core/src/ripgrep/binary.ts);
- [ripgrep releases](https://github.com/BurntSushi/ripgrep/releases);
- [Docker bridge network
  driver](https://docs.docker.com/engine/network/drivers/bridge/);
- [Node.js TLS](https://nodejs.org/api/tls.html).
