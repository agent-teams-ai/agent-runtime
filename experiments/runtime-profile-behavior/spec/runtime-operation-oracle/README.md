# ADR-0006 executable oracle

Status: synthetic evidence for proposed ADR-0006, not production runtime code.

The JSON files in this directory are the sole scenario and vocabulary
authority. `manifest.json` fixes case order, `catalog.json` owns the closed
vocabulary, `schema.json` owns Draft 2020-12 shapes, and `cross-axis.json` owns
the requirement-27 transition topology. The manifest references exactly 28
case files. Requirement 28 uses four ordered example parts so every reviewable
file remains below 40 KiB.

The loader rejects comments, trailing commas, nested duplicate keys, schema
extensions, orphan files, catalog/schema drift, and case-order drift. It then
assembles and validates the virtual 28-case oracle in manifest order.

Generated files are committed under `generated/`:

- schema-derived TypeScript types;
- catalog-derived constants;
- the pure parallel XState v5 synthetic verifier for requirement 27;
- shortest-path witnesses and a Mermaid topology artifact.

The XState machine has no actors, services, timers, or actions. Its seven-axis
reachability result is not the independent ten-axis validity result and is not
a production runtime state machine. Requirement 28 binary-retention semantics
remain exclusively in the handwritten evaluator and JSON examples.

Run `pnpm architecture:operation-oracle:generate` to write generated files.
Normal gates run `pnpm architecture:operation-oracle`, whose freshness check
renders to a temporary directory and byte-compares without changing tracked
files.

The repository keeps own-code strict checking while `skipLibCheck` is enabled
for this dev-only toolchain: XState 5.32.5 and json-schema-to-typescript 15.0.4
currently expose declaration incompatibilities under the pinned native
TypeScript 7 compiler. This is a reviewed compatibility concession, not a
relaxation of oracle source checks.

Cutover parity is fixed at 28 cases and 242 examples: 107 accept and 135
reject. The static product contains 48,000 combinations; the independent
handwritten classifier marks 1,277 valid and 46,723 invalid. Fast-check uses a
fixed seed, and every curated semantic mutant must be killed.
