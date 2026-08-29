# ADR-0006 executable oracle

Status: executable ADR-0006 design oracle and architecture evidence for
accepted ADR-0009 and ADR-0010, not production runtime code or
implementation/deployment qualification.

The JSON files in this directory are the sole scenario and vocabulary
authority. `manifest.json` fixes case order, `catalog.json` owns the closed
vocabulary, `schema.json` owns Draft 2020-12 shapes, and `cross-axis.json` owns
the requirement-27 transition topology. `contained-turn-v1-disposition.json`
maps every existing requirement, example, and static-product state category to
`required`, `deferred`, or `not_applicable`.
`contained-turn-v1-contract.json` freezes the exact candidate revisions,
versioned capability manifests, worst-case scope, immutable receipt set,
containment bindings, closed composition, identity/lifecycle separation,
durable-truth boundary, and ADR-0004 negative guard examples. These two files
extend the existing authority and do not create another state machine or TCK.
The manifest references exactly 28 case files. Requirement 28 uses four ordered
example parts so every reviewable case file remains below 40 KiB.

The loader rejects comments, trailing commas, nested duplicate keys, schema
extensions, orphan files, catalog/schema drift, and case-order drift. It then
assembles and validates the virtual 28-case oracle in manifest order, proves
the V1 disposition is exhaustive and exclusive, re-evaluates all 48,000 state
categories, evaluates the minimized ADR-0004 guard cases, and verifies the
provider evidence fixture SHA-256 bindings and embedded revisions.

Generated proof artifacts are committed under
`../../fixtures/proof-artifacts/runtime-operation-oracle/`:

- schema-derived TypeScript types;
- shortest-path witnesses and a Mermaid topology artifact.

No catalog constants mirror is generated. Evaluator and state-product factories
receive the strictly loaded authority, so temporary-root validation cannot fall
back to constants from the main checkout.

The pure parallel XState v5 synthetic verifier is built in memory directly
from `cross-axis.json`; no generated machine mirror is committed. It has no
actors, services, timers, or actions. Its seven-axis
reachability result is not the independent ten-axis validity result and is not
a production runtime state machine. Requirement 28 binary-retention semantics
remain exclusively in the handwritten evaluator and JSON examples.
Transition guards require `requiredFacts`, reject JSON-declared
`forbiddenFacts`, and allow other supplemental evidence.

Run `pnpm architecture:operation-oracle:generate` to write generated files.
Normal gates run `pnpm architecture:operation-oracle`, whose freshness check
renders to a temporary directory and byte-compares without changing tracked
files.

Both TypeScript gates keep `skipLibCheck: false`. The four synthetic-toolchain
entrypoints use the transparent `tsconfig.synthetic-oracle.json` boundary with
only `exactOptionalPropertyTypes: false`, because XState 5.32.5 and
json-schema-to-typescript 15.0.4 expose incompatible optional-property
declarations under the pinned native TypeScript 7 compiler. Root sources retain
the stricter default and cannot import through the excluded boundary.

Cutover parity is fixed at 28 cases and 242 examples: 107 accept and 135
reject. The static product contains 48,000 combinations; the independent
handwritten classifier marks 1,277 valid and 46,723 invalid. Fast-check uses a
fixed seed, and every curated semantic mutant must be killed.

The V1 disposition retains all 28 requirements and 242 examples without
changing them: 22 requirements are required, five deferred, and one not
applicable; 87 examples are required, 147 deferred, and eight not applicable.
Across the 48,000-state product, 19,200 states are required, 16,800 deferred,
and 12,000 not applicable. Deferred and not-applicable rows are traceability,
not accepted product features.
