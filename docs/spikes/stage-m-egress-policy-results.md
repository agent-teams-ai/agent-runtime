# Stage M egress policy and gateway results

Status: accepted scoped experimental evidence

Date: 2026-07-29

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Stage M exercised a synthetic signed-egress-policy and loopback HTTP/1.1 and
HTTP/2 gateway model on the hosted Linux worker. It used generated keys,
synthetic DNS/address fixtures and loopback peers only. It did not use a real
credential, provider, MCP server, public DNS, public PKI, external network,
production proxy, user project or kernel-enforced production egress policy.

## Accepted facts

- Policy, dial-plan and per-dispatch authorization envelopes were immutable,
  canonical and Ed25519-signed. Exact schema, environment, audience, tenant,
  mode, generation, expiry, key status and digest binding failed closed.
- Address classification was independent of DNS intent. Private, loopback,
  link-local, metadata, documentation, benchmark, mapped and mixed-answer
  forms were denied by the retained classifier cases.
- Authorization bound the normalized route, resolved address set, TLS
  identity, peer address, redirect hop, budgets, policy generation and
  monotonic time. Every redirect required a new authorization decision.
- The gateway performed the final synchronous authorization at actual HTTP/1.1
  dispatch, after queue wait and before any request/application byte. In the
  retained slow-first cases, rotation, revocation and expiry denied the queued
  second request with zero request/application bytes.
- Each HTTP/1.1 attempt produced exactly one terminal path: `attempted` then
  `authorized/completed`, or `attempted` then `denied`.
- HTTP/1.1 and HTTP/2 transports were bound to the observed peer IP and port.
  Policy rotation, revocation, TTL expiry and peer mismatch closed the bound
  transport. Close failure quarantined the transport for retry rather than
  returning it to the pool. All 16 retained closure pairs closed both ends.
- Control-time authority was module-private. Gateway consumers received only a
  frozen read-only view; restore/advance required a separate private
  capability. Startup without a signed high-water anchor and stale restart
  anchors failed closed.
- The final evidence oracle recomputed every digest from the normalized raw
  preimage: 84/84 catalog entries (27 authorization bodies and 57 verified
  signed envelopes). It bound 223/223 normalized SHA-256 claims with no
  unbound claim. Equality-preserving zero/substitution, removed binding,
  preimage mutation, noncanonical date/signature and nonce mutations failed.

## Architecture consequence

- Runtime Security owns the policy and authorization decision. A narrow egress
  gateway port/adapter enforces that decision at the real dispatch boundary;
  this evidence does not justify another bounded context.
- Runtime Configuration may reference a policy identity but cannot authorize
  a connection. Agent Execution cannot bypass the gateway by interpreting
  profile environment values as network authority.
- Authorization is short-lived and bound to one normalized dispatch context.
  DNS result, peer address, redirect, policy generation, key status, expiry and
  monotonic time are revalidated at the gateway boundary.
- A pooled transport is authority-bearing state. Revocation or failed closure
  removes it from reuse and moves it to closed or quarantined state.
- Caller timestamps are observations, never the source of expiry, TTL,
  revocation or transport-lifetime truth.

## Repeatability and evidence identity

Calibration and both final campaigns returned `GO` for all 183 cases. The
source audit passed 314/314 checks. Final results used different externally
supplied nonces and raw identities, while both had semantic digest:

```text
8aba7aa8d37437033d83ad445a98afdc7877ec6cccee95ff85b189accd420715
```

The 58-check comparator returned `PASS` and explicitly did not claim
cryptographic execution attestation.

The raw hosted evidence is retained on `codex-workers-eu-01` under
`/var/data/vioxen--agent-runtime/worker-jobs/profile-spikes/stage-m-egress-policy/`
(`v14`, `runs/calibration-v14-*`, `runs/final-*-v14-*`, and
`final-v14-comparison.json`). The repository retains only the redacted summary.

```text
schema / contracts / campaign / audit / comparator
fec7cb685d3489d47fe8374fd6abf8eacd41aa13e5734365549d0f01f1039993
558b8d0d46c3bd21c69f7e27917747c84b629582d2f327e5430f3bd0ce86c885
76c566b087066fbb5061827d1de53168de9c41b67654dd31b7cdf71c76c9332d
0d124d27b7ffd1175b96c8a2c729c5520f928f3cb2932ffa0c84bea81311221f
be29d284153424a94a64974edabb78465470ffbad4ffdf5471469ce9c2d48b90

source digest
ee91970aec58b2ce9c873b8ed5d90908f29553c8187c6f9666cf33f89b50fee2

calibration result / audit
aa04474aabe455f78f31bfa0c12d7f6c5929ed2306b635f7d9c6e6a2fae3d6ee
dee23d669b082889d3e08e14356f802d053ecb48c1e45d70136a689e92767984

final A result / audit
08e8065e1750724fbe99177f1c594c44be36eaf37c41895d960c4099b5a49084
dee23d669b082889d3e08e14356f802d053ecb48c1e45d70136a689e92767984

final B result / audit
a8ed58fb63e394bf363b3a688acbb654e30d4b50a7d7c6ddffa58b60c5252b69
dee23d669b082889d3e08e14356f802d053ecb48c1e45d70136a689e92767984

final comparison
1336deddbd8df20ff6d77de47e0e8946e61adb12be25e5ec0a221d71dcac3584
```

The redacted machine-readable summary is
`experiments/runtime-profile-behavior/fixtures/stage-m-egress-policy-summary.json`.

## Remaining gates

- production gateway and Runtime Security adapter implementation;
- public DNS, DNS rebinding, public PKI, certificate rotation and real TLS
  termination behavior;
- kernel/container/VM egress containment, bypass attempts and host routing;
- production proxy/load balancer behavior, HTTP/3 or other enabled protocols,
  reconnect storms and long-duration pool/backpressure soak;
- real provider allowlists without credentials in retained evidence, and KMS
  key custody/rotation/recovery;
- multi-host policy propagation, partitions, durable audit storage and
  production monotonic anchor.
