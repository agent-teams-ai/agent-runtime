# Stage G profile and environment contract results

Status: accepted scoped experimental evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Stage G exercised the profile, instruction, environment, immutable-revision,
and provider-extension contracts as a deterministic synthetic model. It did
not read user configuration or credentials and did not start providers, MCP
servers, or platform collectors.

## Accepted facts

Each final campaign used a different random seed and ran:

- 5,000 randomized input permutations of the four source layers;
- all nine lower-resource-state versus remove/disable/upsert cases;
- 3,000 randomized instruction-operation permutations;
- environment value, collision, path, and secret-projection negatives;
- mutable profile-head changes between review and activation;
- every required provider-extension classifier field omitted in turn.

### Source precedence and resources

- Every randomized source order produced one semantic result with `explicit`
  as the winner.
- A caller-supplied `bindingPrecedence` field was rejected.
- Equal composite identity with different content failed closed.
- `remove` revealed the lower state, `disable` suppressed it, and a higher
  full upsert re-enabled a disabled resource.

### Instructions

- Global append, workspace replace, and explicit append always resolved to
  `[workspace, explicit]`, independent of input order.
- Workspace disable followed by explicit append resolved to `[explicit]`.
- Explicit reset exposed only the pinned provider default.
- Duplicate identity with different content, byte-budget overflow, and
  token-budget overflow all failed closed.

### Environment and target canonicalization

- A content-addressed non-secret value materialized only after digest and
  length verification.
- A synthetic ambient value with the same key was ignored.
- Secret projection retained only an opaque binding and generation.
- Windows `PATH`/`Path` and Unicode NFC many-to-one collisions failed closed.
- Digest mismatch, unknown key, Windows trailing-dot, drive-relative,
  device-name, and ADS-shaped paths failed closed in the synthetic target
  canonicalizer.

These are contract-model facts, not native Windows or macOS qualification.

### Immutable profile binding and extension classification

- Activation used reviewed `profile-r1` after the mutable definition head
  changed to `profile-r2`.
- Removing the reviewed revision caused `PROFILE_REVISION_UNAVAILABLE`; the
  model did not fall back to the newest head.
- Omitting any of eight required classifier fields failed closed.
- Unknown classifier field and schema version failed closed.

## Repeatability and audit

Calibration passed a 38-of-38 read-only verifier. Two final campaigns with
seeds 101 and 202 also passed 38 of 38. Raw evidence hashes differed, while
both final canonical fact sets had digest:

```text
1a71b523f5c03753a71d5a570d7f60f6d3a387aeb724499ef1098b804ef76e8f
```

## Architecture consequence

The campaign supports the existing ADR rules:

- Runtime Configuration, not the orchestrator, owns cross-source precedence;
- instruction composition is a typed algebra;
- environment materialization consumes immutable owned values or opaque
  secret bindings, never ambient process state;
- target canonicalization precedes collision detection;
- review and activation use resolved immutable profile revisions;
- provider extensions remain fail closed until their complete classifier
  contract is present.

No domain ownership change was required.

## Evidence identity

```text
harness
1d875af6a979db27d6e688599bf47d2255968347d68d6f1aeed5d30cdf15b711

read-only verifier
a16979c12a13f89f99927fb79811d893b6d6aba40c192e8c76156be986ebf726

calibration result / audit
75f478be993b2df3491c84cc68452370ba80ece2a7f77b068ffbf6e7914ca7f0
48457873f4d2a32d9e84a0e4d1908e3b46e9c0700e303c00253e8dfac87e1dd6

final A result / audit
9e4fb621e21100bee8f2b609d04be5527c1d070a7b866faaf33703fb6d9cba25
c69d48083f18a10b0d17607fd57472032010aa06f0c233fb3a1127e0dace2d93

final B result / audit
9bc5fdbdf92beafc3373844c9edb4348435a878bc7ed74cc96ea4040c2abb227
067ee34ce4953fc9825d9bdcced2b45aaa74b7aaff6c74cf5545cf822e1e75eb
```

The redacted machine-readable summary is
`experiments/runtime-profile-behavior/fixtures/stage-g-profile-environment-contracts-summary.json`.

## Remaining gates

- production resolver, materializer, and classifier implementation;
- provider-specific Claude, Codex, and OpenCode fixtures;
- native Windows and macOS collector/filesystem/environment behavior;
- cross-language canonicalization;
- signed manifest and immutable artifact-store integration;
- stale-review and manifest-delta product UX.
