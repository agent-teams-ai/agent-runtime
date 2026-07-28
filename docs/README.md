# Agent Runtime architecture

Read documents in this order:

1. `decisions/0001-runtime-profile-and-activation-boundaries.md` - canonical
   accepted profile, security, access, and activation boundaries.
2. `spikes/stage-a-profile-foundation-results.md` - adversarial Stage A
   foundation results, remaining partials, and implementation gates.
3. `spikes/stage-b-runtime-execution-results.md` - adversarial execution,
   OpenCode bootstrap, credential lifecycle, and combined recovery evidence.
4. `spikes/stage-c-provider-profile-and-opencode-operation-results.md` -
   provider/profile roundtrip, OpenCode operation, isolation, cancellation,
   recovery, and final-campaign evidence.
5. `spikes/stage-d-cross-context-reconciliation-results.md` - collector,
   hosted ingestion, binding, and preparation consistency evidence.
6. `spikes/stage-e-security-time-and-idempotency-results.md` - secret
   separation, idempotency retention, and clock/expiry evidence.
7. `spikes/runtime-profile-behavior.md` - provider behavior evidence and
   historical hypotheses. It is not an implementation specification.
8. `../experiments/runtime-profile-behavior/README.md` - experiment status and
   the candidate behaviors known to be superseded or falsified.

Document status vocabulary:

- `accepted`: canonical architecture unless superseded by a later ADR;
- `proposed`: not approved for implementation;
- `evidence reference`: observations are retained, but architecture conclusions
  may be superseded;
- `falsified`: a hypothesis contradicted by later evidence.

Production code must not use an evidence document as its architecture source of
truth. Open decisions and required spikes remain non-final until their owning
ADR records the outcome.
